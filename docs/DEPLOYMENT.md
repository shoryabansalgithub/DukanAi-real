# Deployment

Roadmap 7.3. Two images, one release step, probes an orchestrator can trust,
and a shutdown that finishes what it started. `docker-compose.yml` at the
repository root is the reference deployment and the phase 7 exit gate; a
Kubernetes or ECS deployment runs the same images with the same contract.

## Images

Both Dockerfiles build from the repository root (the npm workspace is the
unit of install) on one pinned Node version (`NODE_VERSION` in each
Dockerfile, the major of `.nvmrc`; bump them together), on Debian slim
(Prisma engines, sharp and bcrypt are glibc builds), as the non-root `node`
user, with the `HEALTHCHECK` on the liveness route.

| Image | Build | Contents | Serves |
|---|---|---|---|
| `dukaanai-api` | `docker build -f apps/api/Dockerfile -t dukaanai-api .` | `apps/api/dist`, production `node_modules` of the API only, Prisma schema + migrations | `node dist/main` on `PORT` (3002) |
| `dukaanai-web` | `docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=<browser-facing API URL> -t dukaanai-web .` | Next.js standalone output (`NEXT_STANDALONE=true` at build) | `node apps/web/server.js` on `PORT` (3000) |

The web image inlines `NEXT_PUBLIC_API_URL` into the browser bundle: build one
image per public API URL. Everything else is runtime environment. No `.env`
file is copied into either image; every value comes from the orchestrator.

## Release step: migrations

`prisma migrate deploy` runs once per release, before the new API starts, from
the API image:

```
docker run --rm -e DATABASE_URL=mysql://user:pass@host:3306/dukaanai dukaanai-api npx prisma migrate deploy
```

Compose models it as the `migrate` service (`api` depends on
`service_completed_successfully`); on Kubernetes it is a Job or an init
container with the same command; on ECS a one-off task. It is a no-op when
nothing is pending, so run it on every deploy. The API never migrates on its
own: a boot against a database behind the migrations refuses to start with the
drift message (see `apps/api/prisma/MIGRATIONS.md` for `migrate status` /
`migrate resolve`). The database user needs `CREATE TRIGGER` (the ledger
immutability triggers) and, with binary logging on, MySQL's
`log_bin_trust_function_creators=1` (compose sets it on the server).

## Probes

| Route | Meaning | Wire to |
|---|---|---|
| `GET /api/health`, `GET /api/health/live` (API) | the process serves HTTP; never touches a dependency | liveness probe, `HEALTHCHECK` |
| `GET /api/health/ready` (API) | 200 only when the database answers, Redis answers and no shutdown is in progress; 503 with `{ status: 'draining' \| 'unavailable', checks }` otherwise | readiness probe, load balancer target health, compose `healthcheck` |
| `GET /api/health` (web) | the Next.js server answers | liveness probe, `HEALTHCHECK` |

Both health controllers are public and exempt from rate limiting. The API
listens only after its BullMQ connections are open (`QUEUE_READY_TIMEOUT_MS`),
so a passing readiness probe means the instance both serves and consumes.

Kubernetes sketch for the API:

```yaml
livenessProbe:  { httpGet: { path: /api/health/live,  port: 3002 }, periodSeconds: 10 }
readinessProbe: { httpGet: { path: /api/health/ready, port: 3002 }, periodSeconds: 5, failureThreshold: 2 }
startupProbe:   { httpGet: { path: /api/health/live,  port: 3002 }, periodSeconds: 5, failureThreshold: 24 }
terminationGracePeriodSeconds: 45   # > SHUTDOWN_DRAIN_DELAY_MS + SHUTDOWN_TIMEOUT_MS
```

## Graceful shutdown (API)

On `SIGTERM`/`SIGINT` (`GracefulShutdownService`, `src/common/lifecycle`):

1. readiness answers 503 `draining` at once;
2. the process waits `SHUTDOWN_DRAIN_DELAY_MS` (0 under compose; 5 s behind a
   Kubernetes Service, so endpoints stop routing before the listener closes);
3. every BullMQ worker is closed: no new job is taken, active jobs finish;
4. the HTTP and socket servers close: in-flight requests complete, idle
   keep-alive connections are dropped;
5. BullMQ queues, the Redis client (`QUIT`) and Prisma (`$disconnect`) close;
6. the process exits 0. A drain still running after `SHUTDOWN_TIMEOUT_MS`
   (30 s) exits 1 instead of waiting for `SIGKILL`.

Keep the orchestrator's grace period above the sum of the two settings
(compose: `stop_grace_period: 40s`). `HTTP_KEEP_ALIVE_TIMEOUT_MS` (65 s) must
exceed the idle timeout of the proxy or load balancer in front, or it reuses
a connection the server just closed and answers 502.
`test/integration/deployment.integration-spec.ts` sends a real `SIGTERM` to
the compiled API and asserts every step; `scripts/compose-smoke.sh` does the
same through `docker compose stop`.

## Environment

API (`apps/api/.env.example` documents every key; the class defaults cover
the tuning values, so a container needs only these):

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `production` (set in the image) |
| `DATABASE_URL` | yes | MySQL 8; add `?connection_limit=` per instance |
| `REDIS_URL` | yes | `redis://` or `rediss://`, path = db index |
| `JWT_SECRET` | yes | 32+ characters, no template value (boot refuses otherwise) |
| `FRONTEND_URL` | yes | browser origin(s), comma-separated: CORS and sockets |
| `TRUST_PROXY` | recommended | hop count of proxies in front; the web server is one hop on sign-in |
| `STORAGE_ROOT`, `UPLOAD_TEMP_DIR` | `STORAGE_ROOT` required in production | an absolute path on a persistent volume (billing evidence; a relative or placeholder root refuses to boot) and a writable temp dir |
| `SMTP_URL`, `EMAIL_FROM` | for invitations / password reset | production refuses to issue an invitation without SMTP |
| `GEMINI_API_KEY`, `OCR_MODEL` | for the AI scanner | 503 `OCR_NOT_CONFIGURED` otherwise |
| `SHUTDOWN_*`, `HTTP_KEEP_ALIVE_TIMEOUT_MS`, `QUEUE_READY_TIMEOUT_MS` | optional | above |
| `LOG_LEVEL` | optional | most verbose level printed (default `log` in production, which refuses `debug`/`verbose`); JSON lines with the correlation id |
| `METRICS_ENABLED`, `METRICS_TOKEN` | optional | `GET /api/metrics` (Prometheus); the token (16+ characters) makes the scrape require a bearer token. See `docs/OBSERVABILITY.md` |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`, `APP_RELEASE` | optional | error tracking is off until the DSN is set; set `APP_RELEASE` to the image tag or commit at deploy time |
| `CRON_RETENTION_SWEEP`, `RETENTION_*` | optional | the nightly purge of expired tokens, DONE outbox rows and old history (roadmap 7.8; windows in `apps/api/.env.example`) |

Web:

| Variable | When | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | build (inlined) and runtime (CSP `connect-src`) | the API as the browser reaches it |
| `API_INTERNAL_URL` | runtime, optional | the API as the web server reaches it (sign-in, refresh); defaults to the public URL |
| `NEXTAUTH_SECRET`, `NEXTAUTH_URL` | runtime | 32+ character secret; the web's public origin |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | runtime, optional | Google sign-in is registered only with real values |

`NEXT_PUBLIC_AUTH_DISABLED` and `AUTH_DISABLED` are never set in a container:
both builds and the API refuse them under `NODE_ENV=production`.

## Compose from a fresh clone

```
cp .env.example .env
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/; s/^NEXTAUTH_SECRET=.*/NEXTAUTH_SECRET=$(openssl rand -hex 32)/" .env
docker compose up --build -d --wait
open http://localhost:3000
```

`--wait` returns once `web` is healthy, which implies `migrate` exited 0 and
the API readiness probe passed. Data lives in the `mysql-data`, `redis-data`,
`api-storage` and `api-uploads` volumes. Redeploy with
`docker compose build && docker compose run --rm migrate && docker compose up -d`.

`scripts/compose-smoke.sh` is the automated gate (CI job "Deployment (compose
smoke)"): it creates `.env` when missing, brings the stack up, proves the
release step is idempotent, both probes, registration, API and web sign-in,
stock, an open shift, a cash sale, the dashboard figure, then stops the API
with `SIGTERM` and asserts exit code 0 and the shutdown log lines, and tears
the stack down (`KEEP=1` leaves it running).

## Operations

- Logs, metrics, error tracking and the alert rules: `docs/OBSERVABILITY.md`
  (`deploy/prometheus/` holds the rules and a scrape configuration;
  `docker compose --profile ops up -d prometheus` runs them against the stack).
- Backups, restore and the rehearsed restore drill: `docs/BACKUP_RESTORE.md`
  (`scripts/db/`, `docker compose --profile ops run --rm db-ops backup`).
  Take a backup before every `migrate deploy`; the rollback paths are in
  `apps/api/prisma/MIGRATIONS.md`.
- Retention: the `RetentionSweep` cron (`CRON_RETENTION_SWEEP`, 03:30 by
  default, one instance at a time under the `cron:retention-sweep` lock)
  deletes expired refresh and password-reset tokens, DONE outbox rows, old
  `SearchHistory` and `ProductEventLog` rows in bounded batches
  (`RETENTION_*`); `retention_rows_purged_total` counts what it removed.
- `DEPLOYMENT_CHECKLIST.md` keeps the go-live order.
