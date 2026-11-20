# Environment Requirements

What the hosting infrastructure must provide to run the API and the web app.
The variable-by-variable reference is `apps/api/.env.example` (every variable
the API reads, with its default; `src/config/env-example.spec.ts` keeps it
complete) and `apps/web/.env.example`; the deployment runbook is
`docs/DEPLOYMENT.md`.

## 1. Relational Database
**Engine:** MySQL 8 (production; CI runs every suite on 8.0 and 8.4 LTS,
8.0 being end of life since April 2026: `docs/DEPLOYMENT.md`, "MySQL
versions"). Development may run MariaDB 10.11, but the two differ
(`AGENTS.md`, "Build and run sharp edges"): test raw SQL on MySQL 8.
- **Privileges:** the `DATABASE_URL` user needs `CREATE TRIGGER` / `DROP
  TRIGGER` (the ledger immutability triggers ship as migrations) and, for the
  migration replay test, `CREATE DATABASE` on the test server.
- **Connection limits:** set `?connection_limit=` in `DATABASE_URL` per API
  instance so the relays and the request pool cannot starve each other.
- **Isolation:** the API sets `READ COMMITTED` on its own transactions; the
  server default may stay `REPEATABLE READ`.
- **Migrations:** `prisma migrate deploy` is the release step (compose
  `migrate` service, or the `deploy/k8s/migrate` Job applied on its own) and
  runs before the new API starts; the API refuses to boot while a migration
  of its image is not applied. Never `prisma db push`.

## 2. Redis
**Engine:** Redis 6.2+ (7 in the reference compose stack, AOF on) with
`maxmemory-policy noeviction`: the queues and their locks, the cron locks,
the throttler counters and the cache share one instance, and an evicted
lock or job is lost work (`docs/DEPLOYMENT.md`, "Provider steps").
- `REDIS_URL` is required in every environment (`redis://` or `rediss://`;
  the path is the database index). It carries BullMQ, the shared cache, the
  cron locks, the throttler counters and the advisory stock hints.
- **Degradation:** the cache, throttler and stock hints fall back to
  per-process state when Redis is unreachable and recover when it returns;
  queued work waits. Redis never decides money or stock.
- **Persistence:** optional. Every cached or queued value is rebuilt from
  MySQL (`InventoryReconService`, the outbox relays).

## 3. Node.js Runtime
**Engine:** Node.js 22 (`.nvmrc`; `engines` floor 22.12 in every
`package.json`; the Docker images pin the same major).
- `AsyncLocalStorage` carries the tenant context and the correlation id.
- Set `--max-old-space-size` to the container's capacity; every API instance
  also runs every BullMQ worker.

## 4. Required variables (production)
| Variable | App | Rule |
| :--- | :--- | :--- |
| `NODE_ENV` | API, web | Required; `production` (the start scripts pin it, a bare process refuses to boot). Disables Swagger and query logging; refuses `LOG_LEVEL=debug`, a relative `STORAGE_ROOT`, placeholder secrets and `AUTH_DISABLED`. |
| `DATABASE_URL` | API | MySQL 8 connection string with `connection_limit`. |
| `REDIS_URL` | API | See §2. |
| `JWT_SECRET` | API | 32+ characters, no template value (boot refuses otherwise). HS256. There is no refresh secret: refresh tokens are opaque and stored hashed (`JWT_REFRESH_EXPIRES_IN` and `SESSION_ABSOLUTE_LIFETIME` bound them). |
| `FRONTEND_URL` | API | Comma-separated absolute browser origins (CORS and sockets). |
| `STORAGE_ROOT` | API | Absolute path on a persistent volume (billing evidence). |
| `PORT` | API | Defaults to `3002`. |
| `NEXTAUTH_SECRET`, `NEXTAUTH_URL` | web | 32+ character secret; the web's public origin. |
| `API_PUBLIC_URL` | web | The API as the browser reaches it (`https://<API_HOST>/api`), read at run time (the page's `<meta>` and the CSP); required behind an edge. One web image serves every environment. |
| `NEXT_PUBLIC_API_URL` | web (build only) | Inlined at build time; a run-time value changes nothing. Only the fallback of a container without `API_PUBLIC_URL` and the `next dev` default. |
| `KEEP_ALIVE_TIMEOUT` | web | Recommended `65000` (the compose files and Kubernetes set it): above the edge's idle keep-alive. |
| `SMTP_URL` | API | Required for invitations and password reset in production (503 otherwise). |

Optional integrations (`GEMINI_API_KEY`, `S3_*`, Google OAuth, `SENTRY_DSN`,
`METRICS_TOKEN`) are off until set; `.env.example` documents each. The
deployment itself (compose files, monitoring, backups) reads the root
`.env.example`; Docker Compose 2.24.4 or newer.
