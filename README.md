# Forge

Multi-tenant freelance contract & invoicing platform, built as NestJS
microservices.

## Architecture

| Service | Responsibility |
| --- | --- |
| `gateway` | Sole HTTP surface; authentication, routing, request validation |
| `tenants-service` | Tenants, users, roles |
| `contracts-service` | Clients, contracts, milestones |
| `billing-service` | Invoices, payments |
| `worker-service` | Async jobs: PDF generation, email |

Services communicate over the Redis transport. Shared message patterns and DTOs
live in `libs/contracts`; the Prisma schema and client live in `libs/prisma`.

## Local setup

Requires Node 22+ and Docker.

```bash
cp .env.example .env
npm ci
docker compose up -d
npx prisma migrate dev
npm run build
```

Start a service in watch mode:

```bash
npm run start:gateway    # also: start:tenants, start:contracts,
                         #       start:billing, start:worker
```

Verify the stack:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ping     # round-trips all four downstream services
```

## Authentication

Tenant signup creates the tenant and its owner in one step:

```bash
curl -X POST localhost:3000/auth/signup -H 'Content-Type: application/json' \
  -d '{"tenant":{"name":"Acme","country":"FR"},
       "owner":{"email":"owner@acme.test","password":"a-long-password"}}'
```

The response carries a short-lived access token and a refresh token. Protected
routes take `Authorization: Bearer <accessToken>`.

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /auth/signup` | public | Create tenant + owner |
| `POST /auth/login` | public | Exchange credentials for tokens |
| `POST /auth/refresh` | public | Rotate a refresh token |
| `POST /auth/logout` | public | Revoke a refresh token |
| `GET /users` | JWT | List users in your tenant |
| `GET /users/:id` | JWT | Read one user in your tenant |

## Domain

| Route | Role | Purpose |
| --- | --- | --- |
| `POST /clients` | admin/owner | Create a client |
| `GET /clients` | any | List — `?page&limit&search&includeArchived` |
| `GET /clients/:id` | any | Read one |
| `PATCH /clients/:id` | admin/owner | Partial update |
| `DELETE /clients/:id` | admin/owner | Archive (soft delete) |
| `POST /contracts` | admin/owner | Create with nested milestones |
| `GET /contracts` | any | List — `?page&limit&status&clientId&search` |
| `GET /contracts/:id` | any | Read one, with milestones |
| `PATCH /contracts/:id` | admin/owner | Partial update and status transitions |
| `GET /contracts/:id/milestones` | any | List milestones |
| `PATCH /contracts/:id/milestones/:mid/complete` | any | Mark complete |

Contracts move `DRAFT → ACTIVE → COMPLETED`, with `CANCELLED` reachable from
either of the first two. `COMPLETED` and `CANCELLED` are terminal. Milestones
can only be completed on an active contract.

Monetary amounts are stored as `Decimal(12,2)` and serialised as strings —
JSON numbers are IEEE 754 doubles and would reintroduce rounding error.

## Billing

| Route | Role | Purpose |
| --- | --- | --- |
| `POST /invoices` | admin/owner | Create an invoice from a completed milestone |
| `GET /invoices` | any | List — `?page&limit&status&contractId` |
| `GET /invoices/:id` | any | Read one |

Invoicing is a CQRS saga rather than a single service method. `POST /invoices`
dispatches a command that validates the milestone, resolves the tax rate from
the tenant's country and writes the invoice as `PENDING`. An
`InvoiceCreatedEvent` then drives a saga that requests PDF rendering and moves
the invoice to `ISSUED`.

If rendering fails the invoice is **not** rolled back — it is a financial record
from the moment it exists. A compensating action moves it to
`GENERATION_FAILED` with the reason recorded, and the saga retries up to three
times before parking it for inspection.

One invoice per milestone is enforced by a unique constraint rather than an
application check: two concurrent requests would both pass a check-then-act.

## Payments

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /invoices/:id/payment-intent` | admin/owner | Start collection for an issued invoice |
| `POST /webhooks/stripe` | public, signature-verified | Stripe event delivery |

Requires `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in billing-service's
environment. For local development, `stripe listen --forward-to
localhost:3000/webhooks/stripe` prints a signing secret and forwards real
test-mode events.

The webhook endpoint is public because Stripe cannot present a token — the
signature check is what authenticates it, so the raw request body is preserved
and verified before anything else happens.

Webhook handling is idempotent. Each Stripe event ID is recorded in
`processed_webhooks` under a unique constraint, in the same transaction as the
state change it authorises, so a redelivered or concurrent duplicate is a no-op.
`PAID` is terminal: a `payment_failed` arriving after a `payment_succeeded` —
which Stripe does not order — is logged and ignored rather than un-paying the
invoice.

Tenant isolation is enforced by Postgres Row-Level Security, not by application
filtering. The services connect as an unprivileged role that is subject to those
policies; migrations use a separate owner connection.

## Async processing

Invoice PDFs and client emails are BullMQ jobs, not inline work. billing-service
produces; worker-service consumes; neither imports the other.

| Queue | Job | Purpose |
| --- | --- | --- |
| `pdf` | `generate-invoice-pdf` | Renders the invoice, stores it, reports back |
| `email` | `send-invoice-email` | Emails the client with the PDF attached |

Jobs retry five times with exponential backoff. On exhaustion they are recorded
in `dead_letter_jobs` with their full payload and correlation ID, so a failure
survives a Redis flush and can be replayed by hand.

Email sending is idempotent: a reprocessed job does not send a second copy.
Exactly-once delivery is not possible across an SMTP boundary, so the send is
recorded *after* it succeeds — a visible duplicate is preferable to silent
non-delivery for an invoice.

Every request gets a correlation ID at the gateway that travels through the
command, the event, the queued job and the worker's logs:

```bash
grep <correlation-id> *.log   # gateway → billing → worker, including retries
```

Local mail is caught by Mailpit at http://localhost:8025 — nothing leaves the
machine.

## Observability

Structured logs (`nestjs-pino`) with one shape across all five services, an
OpenTelemetry trace spanning every service, and a health endpoint that
aggregates each service's own dependency checks.

```bash
npm run health        # live combined status, refreshing
npm run health:once   # one snapshot; exit 1 if anything is degraded
open http://localhost:16686   # Jaeger — traces across all five services
```

Every request gets a correlation ID at the gateway. It is bound to async
context, so every log line carries it without being passed one, and it travels
in the payload across the Redis transport and inside queued jobs.

`GET /health` reports each service's own checks — the gateway never queries
another service's database. It answers `200` even while degraded, because that
is the case it exists for. `GET /health/live` checks nothing else, so a failing
dependency cannot get the container restarted.

## Resilience

Gateway calls to downstream services go through a per-service circuit breaker
(`opossum`). When a service is unreachable the client gets a `503` naming it,
not a `500`; once the circuit opens, requests fail in milliseconds rather than
waiting out the timeout, and other services are unaffected. Recovery is
automatic via a half-open probe.

Downstream `4xx` responses never open a circuit — a service correctly rejecting
bad input is not a failing service.

## Tests

```bash
npm test                    # unit
npm run test:e2e            # end-to-end — self-contained
npm run test:cov:critical   # coverage of the saga, idempotency and RLS paths
npm run lint
```

The e2e suite needs **no running stack**. It starts its own Postgres and Redis
via Testcontainers, applies the real migrations — including the RLS policies —
runs, and destroys them. `docker compose` is for development, not for tests.

```bash
docker compose down && npm run test:e2e   # passes from nothing
```

Included are contract tests that fail when a service stops returning a field
its DTO promises, and a chaos test that restarts Redis and asserts queued jobs
survive.

## Load testing

```bash
npm run load            # read path
npm run load:invoices   # invoice creation
```

Requires the stack and services running. Baseline on one laptop: ~1470 req/s on
the paginated read path, ~150 req/s through invoice creation — the gap is the
two synchronous cross-service RPCs the CQRS command makes before writing.

## Ports

Gateway `3000` · Postgres `5433` · Redis `6379` · Adminer `8080` ·
RedisInsight `5540`
