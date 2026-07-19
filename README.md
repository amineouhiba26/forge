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

## Tests

```bash
npm test        # unit
npm run lint
```

## Ports

Gateway `3000` · Postgres `5433` · Redis `6379` · Adminer `8080` ·
RedisInsight `5540`
