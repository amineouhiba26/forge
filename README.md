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

Tenant isolation is enforced by Postgres Row-Level Security, not by application
filtering. The services connect as an unprivileged role that is subject to those
policies; migrations use a separate owner connection.

## Tests

```bash
npm test          # unit
npm run test:e2e  # end-to-end — requires docker compose up + migrations
npm run lint
```

## Ports

Gateway `3000` · Postgres `5433` · Redis `6379` · Adminer `8080` ·
RedisInsight `5540`
