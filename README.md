# Forge

Multi-tenant freelance contract & invoicing platform, built as NestJS
microservices.

Tenant isolation is enforced by the database rather than by application
filtering, invoicing is a CQRS saga with a real compensating path, and Stripe
webhooks are idempotent against replay and out-of-order delivery.

## Quick start

Requires Docker. Nothing else — Node is only needed to develop against source.

```bash
git clone https://github.com/amineouhiba26/forge.git && cd forge
cp .env.example .env
docker compose up --build
```

That starts Postgres, Redis, Mailpit, Jaeger, applies the migrations and runs
all five services. Then:

```bash
curl localhost:3000/health          # every service's own dependency checks
open  localhost:3000/docs           # the full API surface, OpenAPI + Swagger UI
./scripts/demo.sh                   # scripted proof of the four claims below
```

| What | Where |
| --- | --- |
| API + docs | http://localhost:3000/docs |
| Traces | http://localhost:16686 (Jaeger) |
| Mail the system sent | http://localhost:8025 (Mailpit) |
| Database | http://localhost:8080 (Adminer) — server `postgres`, user/pass `forge` |
| Queues | http://localhost:5540 (RedisInsight) |

## Architecture

```
                    ┌──────────────────────────────────────────┐
   HTTP ───────────▶│  gateway            :3000                │
                    │  auth · CASL · rate limiting · breakers  │
                    └───────────────┬──────────────────────────┘
                                    │  Redis transport (request/response)
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
   ┌─────────────────┐   ┌───────────────────┐   ┌────────────────────┐
   │ tenants-service │   │ contracts-service │   │  billing-service   │
   │ tenants · users │   │ clients·contracts │   │ invoices·payments  │
   │ JWT issuance    │   │ milestones        │   │ CQRS + saga·Stripe │
   └────────┬────────┘   └─────────┬─────────┘   └─────────┬──────────┘
            │                      │                       │
            └──────────────────────┼───────────────────────┤
                                   ▼                       │ BullMQ
                          ┌─────────────────┐              │ (pdf, email)
                          │    Postgres     │              ▼
                          │  row-level      │     ┌────────────────────┐
                          │  security       │     │   worker-service   │
                          └─────────────────┘     │  PDF render · mail │
                                                  │  DLQ · retries     │
                                                  └────────────────────┘
```

| Service | Owns | Responsibility |
| --- | --- | --- |
| `gateway` | nothing | The only HTTP surface. Authentication, CASL authorisation, validation, rate limiting, circuit breaking, correlation IDs. Holds no Stripe secret and queries no database. |
| `tenants-service` | `tenants`, `users`, `refresh_tokens` | Signup, JWT issuance, refresh-token rotation and revocation. |
| `contracts-service` | `clients`, `contracts`, `milestones` | Core domain CRUD, contract state machine, milestone completion. |
| `billing-service` | `invoices`, `payments`, `processed_webhooks` | Invoice CQRS commands/queries, the saga, tax resolution, Stripe intents and webhook idempotency. Produces queue jobs. |
| `worker-service` | `processed_jobs`, `dead_letter_jobs` | Consumes queues: renders PDFs, sends mail, retries with backoff, dead-letters. |

Services talk over the Redis transport and never read each other's tables — a
join would make the schema a shared dependency that neither service could change
safely. Shared message patterns, queue names and DTOs live in `libs/contracts`;
the Prisma schema and client in `libs/prisma`; logging, tracing and correlation
in `libs/observability`.

## Developing against source

The compose stack runs the built images. To iterate on code instead, start only
the infrastructure and run the services from source — otherwise the gateway
container and a local one both want `:3000`.

```bash
docker compose up -d postgres redis mailpit jaeger
npm ci
npx prisma migrate dev
npm run start:gateway    # also: start:tenants, start:contracts,
                         #       start:billing, start:worker
```

```bash
curl localhost:3000/health
curl localhost:3000/ping     # round-trips all four downstream services
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

## Security

| Control | Where |
| --- | --- |
| Tenant isolation | Postgres row-level security, forced on every tenant table |
| Authentication | JWT access tokens; refresh tokens rotated, reuse revokes the family |
| Authorisation | CASL abilities per role, checked at the gateway |
| Transport hardening | `helmet` headers on every response |
| Brute force | Rate limiting on `/auth/*` — 10 attempts per minute per IP by default |
| Input | Global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted` |
| Webhooks | Stripe signature verified against the raw body before anything else |

The services connect to Postgres as `forge_app`, an unprivileged role subject to
RLS. Postgres exempts superusers from row-level security entirely, so connecting
as the owner would silently disable every policy while queries kept succeeding —
migrations use a separate owner connection for that reason.

No user input reaches raw SQL. The only raw statements are a literal `SELECT 1`
health probe and the parameterised `set_config` that establishes tenant context;
there is no `queryRawUnsafe` anywhere in the services.

**Secrets never belong in the image.** `ConfigModule` builds its validated
configuration from the `.env` *file* and `ConfigService` consults that before
`process.env` — so a `.env` baked into an image would silently override the
environment a deployment injects, including its secrets. `.dockerignore`
excludes it and CI asserts the built image contains none.

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

## Deployment

Each service has its own multi-stage `Dockerfile` (`apps/<service>/Dockerfile`),
built from the repository root because the monorepo shares a lockfile and the
`libs/` packages:

```bash
docker build -f apps/gateway/Dockerfile -t forge-gateway .
```

Dependencies install in a cached layer keyed on the lockfile, the build stage
generates the Prisma client and compiles one service, and the runtime stage
carries only production dependencies and compiled output, running as `node`
rather than root. CI builds all five images on every push, so a broken
Dockerfile fails there rather than at deploy time.

Production dependencies are installed in their own stage rather than copied and
pruned: Docker layers are additive, so `npm prune` in a later layer deletes
files the earlier layer still carries — the devDependencies stay in the image
and merely stop being visible. Installing clean took the gateway image from
1.26 GB to ~930 MB. What remains is dominated by Prisma 7's runtime, which
`@prisma/client` pulls in (`@prisma`, the `prisma` CLI, `effect`,
`@electric-sql` — together ~260 MB) plus OpenTelemetry. Shrinking it further
means a distroless base and vendoring only the Prisma runtime actually used,
which is a worthwhile follow-up rather than something to fake.

Migrations run as a one-shot `migrate` service that every other service waits
on, so a first `docker compose up` against an empty database needs no manual
step.

### What a real deployment would need differently

- **Secrets** come from a secret manager, not compose defaults. Because the
  `.env` file wins over real environment variables, production should ship no
  `.env` at all.
- **Postgres and Redis** are managed services, not containers. Redis needs
  persistence configured deliberately — BullMQ jobs live there, and the chaos
  test's guarantee only holds with AOF enabled.
- **Rate limiting** is per-instance and in-memory. More than one gateway replica
  needs shared storage (Redis) or the effective limit multiplies by replica
  count. The gateway also needs `trust proxy` set so the real client IP is used
  rather than the load balancer's.
- **PDF storage** is a local volume, which is wrong the moment two workers run
  on different hosts. The renderer returns a path, so swapping in S3 is a change
  to one service.
- **Health probes**: `GET /health/live` is the liveness probe — it checks
  nothing external, so a failing dependency cannot get a healthy container
  restarted. `GET /health` is the readiness/diagnostic view.
- **Scaling** differs by service: the gateway and read paths scale on request
  volume; `worker-service` scales on queue depth, which is a different signal
  and usually a different autoscaler.
- **Tracing** exports to a collector endpoint rather than a bundled
  all-in-one Jaeger, which is a local-inspection convenience only.

## Trade-offs

Decisions worth defending, and what they cost:

- **Redis as the RPC transport, not RabbitMQ.** Redis was already required for
  BullMQ and health checks, so this avoids a sixth thing to operate. The cost is
  no durable queue semantics for request/response — acceptable because every
  operation that must survive a restart is a BullMQ job, not an RPC.
- **Row-level security instead of schema-per-tenant.** One schema keeps
  migrations single and joins ordinary; isolation is enforced by Postgres rather
  than by remembering a `WHERE` clause. The cost is that every connection must
  set tenant context, and a superuser connection silently bypasses everything.
- **CQRS only in billing.** Invoicing has a genuine multi-step process with a
  failure path, which is the criterion. Applying it to Sprint 2's plain CRUD
  would have been pure indirection.
- **A saga, not a transaction.** A failed PDF render must not unmake an invoice —
  it is a financial record from the moment it exists. Compensation records what
  went wrong; a rollback would pretend the billing event never happened and free
  the milestone to be invoiced twice.
- **Prisma over TypeORM.** Generated types that match the schema, and a
  migration story that produces reviewable SQL — which mattered, because the RLS
  policies are hand-written SQL appended to generated migrations.
- **Monorepo.** The shared contract between services is compile-checked rather
  than published and version-bumped. The cost is that services cannot be
  versioned or deployed independently.
- **Money as `Decimal(12,2)`, serialised as strings.** JSON numbers are IEEE 754
  doubles; returning them would reintroduce the rounding error the column type
  exists to prevent.

## Ports

Gateway `3000` · Postgres `5433` · Redis `6379` · Adminer `8080` ·
RedisInsight `5540` · Mailpit `8025` · Jaeger `16686`
