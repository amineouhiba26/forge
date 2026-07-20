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

## Tests

```bash
npm test          # unit
npm run test:e2e  # end-to-end — requires docker compose up + migrations
npm run lint
```

The e2e suites boot their own service instances against the shared Redis, so
they refuse to start while another stack is running:

```bash
pkill -f "dist/apps"   # stop a manually-started stack first
```

Two subscribers on one pattern means requests are answered by whichever wins
the race, which produces misleading failures rather than obvious ones.

## Ports

Gateway `3000` · Postgres `5433` · Redis `6379` · Adminer `8080` ·
RedisInsight `5540`
