# Secrets register and rotation

Roadmap 9.11. Every secret the platform uses, where it lives, who owns it,
what it protects, and how it is rotated. The rule: a secret lives in the
secret store (or the host's `.env`, mode 600, written from the store) and
in CI's encrypted secrets; it is never in a committed file. CI enforces the
last part with gitleaks on the tree and the whole history on every push
(`.gitleaks.toml`, job "Lint"), and
`apps/api/src/config/credential-register.spec.ts` fails the unit suite when a
secret-looking variable appears in a committed template without a row
here, or a row names a variable no template documents.

Owner roles: **platform owner** (the repository owner, holds the store),
**on-call** (may rotate in an incident, records it here). "Where" is the
production and staging location; locally the untracked `.env` / `.env.local`.

## Register

| Secret (variable) | Protects | Read by | Where it lives | Owner | Rotation effect | Procedure |
|---|---|---|---|---|---|---|
| `JWT_SECRET` | every API access token (HS256) | API (`JwtConfig`; `JwtModule`, `JwtStrategy`, the socket adapter) | store → API `.env` / `dukaanai-secrets` | platform owner | every access token refused at once; refresh tokens keep working until revoked, so the procedure revokes them: **every session ends** | [JWT secret](#jwt_secret) |
| `NEXTAUTH_SECRET` | the web session cookie (signed and encrypted JWE) | web (`serverConfig`, NextAuth) | store → web `.env` / `dukaanai-secrets` | platform owner | every browser session cookie becomes unreadable: **every web user signs in again** | [NextAuth secret](#nextauth_secret) |
| `DATABASE_URL` | the application's database credentials (user, password, host, TLS CA path) | API, `migrate`, the operator commands in the API image (`dist/cli/reconcile`, `dist/cli/revoke-all-sessions`; `npm run reconcile` / `sessions:revoke-all` from a checkout) | store → API `.env` / `dukaanai-secrets` | platform owner | none for users when done with a dual password; a restart otherwise | [Database password](#database_url) |
| `DB_OPS_DATABASE_URL` | the backup user (RELOAD, REPLICATION CLIENT, SELECT...) | `backup-agent` / `db-ops` (`scripts/db/lib.sh`) | store → host `.env` / `dukaanai-secrets` | platform owner | the next backup run uses it; no user impact | same as above, for the backup user |
| `MYSQL_ROOT_PASSWORD`, `MYSQL_PASSWORD` | the bundled MySQL of the reference stack only (never production: the production database is managed) | compose `mysql`, `db-ops` on the reference stack | local `.env` | developer | local only | recreate the volume or `ALTER USER` |
| `REDIS_URL` | the Redis password (and TLS with `rediss://`) | API (`RedisModule`, BullMQ, cache, throttler) | store → API `.env` / `dukaanai-secrets` | platform owner | queues, cache, locks and counters reconnect; nothing persistent is lost (Redis is disposable, `docs/DATA_SAFETY.md`) | [Redis password](#redis_url) |
| `SMTP_URL` | the mail relay credentials (invitations, password reset) | API (`EmailService`) | store → API `.env` / `dukaanai-secrets` | platform owner | the next mail uses it; without a value production answers invitations and reset requests 503, and a value the relay refuses makes an invitation 502 `INVITATION_EMAIL_FAILED` (nothing kept) and a reset link silently undelivered (counted, alert `DukaanAiEmailDeliveryFailing`) | [SMTP](#smtp_url) |
| `ALERT_SMTP_PASSWORD` | the relay credentials Alertmanager mails with | `alertmanager` (`deploy/alertmanager/render.sh`) | store → host `.env` | platform owner | the next notification uses it | same relay as above; restart `alertmanager` |
| `GOOGLE_CLIENT_SECRET` (with `GOOGLE_CLIENT_ID`) | Google sign-in | web (NextAuth Google provider; the button shows only with real values); the API verifies the id token against `GOOGLE_CLIENT_ID` alone (`AuthConfig`) | store → web `.env` / `dukaanai-secrets`; the client id also to the API | platform owner | Google sign-in fails until the web restarts with the new value; password sessions untouched | [Google](#google_client_secret) |
| `GEMINI_API_KEY` | the OCR model account (`POST /ocr/scan-bill`) | API (`OcrService`) | store → API `.env` / `dukaanai-secrets` | platform owner | OCR answers 503 `OCR_NOT_CONFIGURED` on a blank value, 502 on an invalid one | [Gemini](#gemini_api_key) |
| `SENTRY_DSN` | where tracked errors go (a write-only endpoint) | API (`ErrorTracking`) | store → API `.env` / `dukaanai-secrets` | platform owner | errors go to the new project key after a restart | [Sentry](#sentry_dsn) |
| `METRICS_TOKEN` | `GET /api/metrics` (bearer) | API (`MetricsController`), Prometheus (`credentials_file`) | store → API `.env` and the Prometheus credentials file | platform owner | scrapes 401 until Prometheus carries the new token | [Metrics token](#metrics_token) |
| `OFFSITE_CRYPT_PASSWORD`, `OFFSITE_CRYPT_SALT` | every off-site backup copy (rclone crypt) | `backup-agent` / `db-ops offsite` (`scripts/backup/offsite.sh`) | store → host `.env`; a sealed copy outside the account | platform owner | **a new key makes every earlier copy unreadable**: rotate by re-shipping, never by replacing | [Off-site key](#offsite_crypt_password) |
| `RCLONE_CONFIG_<NAME>_*` | the object-storage account behind the off-site remote | the same scripts | store → host `.env` | platform owner | the next push uses it | the provider's key rotation; `db-ops offsite check` after |
| `ALERT_SLACK_WEBHOOK_URL` | posting into the alert channel | `alertmanager` | store → host `.env` | on-call | the next notification uses it | regenerate the webhook in Slack; restart `alertmanager`; post a test alert |
| `ALERT_PAGERDUTY_ROUTING_KEY` | paging the on-call | `alertmanager` | store → host `.env` | on-call | the next page uses it | regenerate the integration key in PagerDuty; restart `alertmanager`; post a test alert |
| `GRAFANA_ADMIN_PASSWORD` | the Grafana admin login (dashboards are provisioned read-only) | `grafana` | store → host `.env` | platform owner | the next login | change in Grafana or in `.env` + restart (the env value wins at start) |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | the object-storage credentials of `StorageConfig` (only when `STORAGE_PROVIDER` is S3; the decided topology keeps documents on disk) | API (`StorageConfig`) | store → API `.env` | platform owner | uploads fail until the restart with the new pair | the provider's key rotation; restart the API |
| `NEXTAUTH_SECRET` of staging, `JWT_SECRET` of staging | the same, per environment | | separate values per environment, never shared | platform owner | | staging and production never share a secret |
| Webhook endpoint secrets (per shop, `WebhookEndpoint.secret`) | the HMAC signature of outbound webhooks (`x-dukanai-signature`) | API (`ProductWebhookDispatcherService`) | the database, per endpoint; shown once at creation | the shop's MANAGER+ | the receiver must take the new value | re-create the endpoint (`POST /webhooks`), update the receiver, delete the old one |
| Password-reset and invitation tokens | one account / one invitation | API | hashed in the database, single use, time-boxed | nobody rotates them | | not secrets to rotate: a new request voids the old token |
| TLS private keys of the edge | HTTPS for `WEB_HOST` / `API_HOST` | Caddy (`caddy-data` volume) / cert-manager | the edge's own storage | platform owner | re-issued on demand | `docker compose ... exec edge caddy reload` after deleting the certificate from `/data/caddy/certificates`, or delete the cert-manager `Certificate` secret |
| GHCR pull token (`docker login ghcr.io` on a host) | pulling release images | the hosts' Docker | the host's Docker credential store | platform owner | pulls fail until re-login | a new fine-grained token with `read:packages`; `docker login` again |
| `GITHUB_TOKEN` | the release workflow's push to ghcr.io | `.github/workflows/release.yml` | issued by GitHub per run | GitHub | automatic | nothing to do |
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` | the agent workflow (`.github/workflows/pullfrog.yml`, dispatch only) | that workflow | GitHub Actions secrets | platform owner | the next dispatch | rotate at the provider; update the repository secret |

The committed templates (`.env.example` at the root, `apps/api/.env.example`,
`apps/api/.env.{development,test,production}`, `apps/web/.env.example`,
`apps/web/.env.{development,production}`, `deploy/k8s/dukaanai-secrets.env.example`)
hold blanks or placeholders only. The API refuses to boot in production on a
placeholder or a short secret (`IsProductionSecret`, `IsNotPlaceholder`), the
web refuses a placeholder `NEXTAUTH_SECRET` on a running production server,
and `.gitignore` keeps every real `.env`, `secrets*` and key file out.

## Procedures

Every rotation: generate the new value, put it in the store, deploy it to
staging, run the staging checks, then production the same way, then the
row of the log below. Generate 32+ character secrets with
`openssl rand -hex 32`.

### `JWT_SECRET`

1. New value in the store and the API `.env` (or the Kubernetes Secret).
2. Restart the API (`docker compose -f docker-compose.prod.yml up -d api`,
   or `kubectl rollout restart deployment/dukaanai-api`). Every access
   token signed with the old secret is now refused (401) and open sockets
   drop; browsers hold refresh tokens, which are opaque and would mint new
   access tokens under the new secret.
3. End the refresh tokens too, in the running API container (the image
   carries the command and the container's `DATABASE_URL`): `docker compose
   -f docker-compose.prod.yml exec api node dist/cli/revoke-all-sessions
   --yes`, or `kubectl -n dukaanai exec deploy/dukaanai-api -- node
   dist/cli/revoke-all-sessions --yes`; from a checkout with `DATABASE_URL`
   set, `npm run sessions:revoke-all -- --yes` runs the same command (the
   image has no `npm run` form: no `scripts/`, no ts-node; found walking the
   runbooks, roadmap 9.22). It revokes every live refresh token and bumps
   every user's `tokenVersion` in one transaction
   (`src/auth/session-revocation.ts`); a dry run without `--yes` only counts. Every user signs in again. One user
   only: `--user <id|email>` (the incident lever).
4. Check: `GET /api/auth/profile` with an old token is 401; a fresh login
   works; `test/integration/credential-rotation.integration-spec.ts` is the
   same sequence against the real database on every CI run.

### `NEXTAUTH_SECRET`

1. New value in the store and the web `.env` / Secret.
2. Restart the web. Every session cookie becomes unreadable: every web user
   lands on `/login`. The API sessions behind them stay valid until they
   expire (`JWT_REFRESH_EXPIRES_IN`, 7 days idle; `SESSION_ABSOLUTE_LIFETIME`,
   12 hours in production); run `revoke-all-sessions` (step 3 of
   `JWT_SECRET`) as well when the rotation is for a suspected leak.
3. Check: the login page loads, a sign-in works, the previous cookie is
   refused.

### `DATABASE_URL`

MySQL 8 keeps two passwords for a user, so the application never sees a
failed connection:

1. `ALTER USER 'dukaanai'@'%' IDENTIFIED BY '<new>' RETAIN CURRENT PASSWORD;`
2. New `DATABASE_URL` in the store and the API `.env` / Secret; restart the
   API (and the `backup-agent` if `DB_OPS_DATABASE_URL` shares the user).
   Both passwords work during the restart.
3. `ALTER USER 'dukaanai'@'%' DISCARD OLD PASSWORD;`
4. Check: `GET /api/health/ready` is 200 (`checks.database: up`), a sale
   completes, `db-ops backup` succeeds with the backup user.

The same steps rotate the backup user (`DB_OPS_DATABASE_URL`). A managed
provider that rotates through its console does the same two-phase change
behind the button; keep the TLS CA path (`DB_CA_FILE`) as it was.

### `REDIS_URL`

1. On a managed Redis: rotate through the provider (most keep the old
   password for a grace period); on the compose stack change
   `requirepass`.
2. New `REDIS_URL` in the store and the API `.env`; restart the API.
3. Check: readiness 200 (`checks.redis: up`), a login (rate-limit counters)
   and a sale (outbox relay) work. Nothing persistent lives in Redis.

### `SMTP_URL`

1. New credentials at the relay (keep the old ones valid until step 3).
2. New `SMTP_URL` (and `ALERT_SMTP_PASSWORD`) in the store and the `.env`s;
   restart the API and `alertmanager`.
3. Check: an invitation mail arrives (`POST /invitations/generate` answers
   201, not 502 `INVITATION_EMAIL_FAILED`), a test alert mail arrives, and
   `email_messages_total{outcome="failed"}` stays flat; then revoke the old
   credentials.

### `GOOGLE_CLIENT_SECRET`

1. In Google Cloud, add a second client secret to the OAuth client (both
   stay valid), copy it.
2. New `GOOGLE_CLIENT_SECRET` in the store and the web `.env`; restart the
   web.
3. Check: a Google sign-in completes; then delete the old secret in Google
   Cloud.

### `GEMINI_API_KEY`

1. Create a new key in Google AI Studio; new value in the store and the API
   `.env`; restart the API.
2. Check: `POST /ocr/scan-bill` with a sample bill answers 201 (not 503 /
   502); then delete the old key.

### `SENTRY_DSN`

1. In Sentry, create a new client key for the project (DSN), keep the old
   one active.
2. New `SENTRY_DSN` in the store and the API `.env`; restart the API.
3. Check: `errors_tracked_total` grows on a provoked 500 in staging and the
   event appears in Sentry; then deactivate the old key.

### `METRICS_TOKEN`

1. New value in the store, the API `.env` and the Prometheus credentials
   file (`deploy/prometheus/prometheus.yml`, `credentials_file`).
2. Restart the API and Prometheus (`up -d api prometheus`).
3. Check: the `dukaanai-api` target is UP in Prometheus (`/targets`); a
   scrape with the old token is 401.

### `OFFSITE_CRYPT_PASSWORD`

The key encrypts every copy in the bucket; a replaced key loses them all.

1. New key and salt in the store (and the sealed copy outside the account).
2. Point a NEW remote directory at the bucket (`OFFSITE_REMOTE=<backend>:<bucket>/dukaanai-v2`)
   with the new key; `db-ops offsite push` ships the current set under it;
   `db-ops offsite check` verifies it.
3. Keep the old key until the old directory has aged past the retention
   window (`OFFSITE_KEEP_DAYS`), then delete the old directory and retire
   the old key. `docs/BACKUP_RESTORE.md` has the drill.

### Any secret, on a suspected leak

1. Rotate it first, with the procedure above, production before staging.
2. End every session (`node dist/cli/revoke-all-sessions --yes` in the API
   container, step 3 of `JWT_SECRET`) when the secret could mint or read
   sessions (`JWT_SECRET`, `NEXTAUTH_SECRET`, the database).
3. Search the history: `gitleaks git . --config .gitleaks.toml` and the
   provider's audit log for the key's use.
4. Record it in the log below with the cause.

## Rotation log

Row 9.11 is complete when every secret of the register has been rotated
once on staging with the procedure above and the row below is filled in.

| Date | Environment | Secret | By | Checked with | Notes |
|---|---|---|---|---|---|
| 2026-10-06 | CI (MariaDB / MySQL 8) | `JWT_SECRET` mechanics | repository | `test/integration/credential-rotation.integration-spec.ts`: an old-secret access token is 401, a refresh survives until `sessions:revoke-all`, which ends every session and lets a new login through | the staging rotation itself is pending the environment (`docs/STAGING.md`) |
| | staging | `JWT_SECRET` | | | |
| | staging | `NEXTAUTH_SECRET` | | | |
| | staging | `DATABASE_URL` (application user) | | | |
| | staging | `DB_OPS_DATABASE_URL` (backup user) | | | |
| | staging | `REDIS_URL` | | | |
| | staging | `SMTP_URL` / `ALERT_SMTP_PASSWORD` | | | |
| | staging | `GOOGLE_CLIENT_SECRET` | | | |
| | staging | `GEMINI_API_KEY` | | | |
| | staging | `SENTRY_DSN` | | | |
| | staging | `METRICS_TOKEN` | | | |
| | staging | `OFFSITE_CRYPT_PASSWORD` / salt | | | |
| | staging | `ALERT_SLACK_WEBHOOK_URL` / `ALERT_PAGERDUTY_ROUTING_KEY` | | | |
| | staging | `GRAFANA_ADMIN_PASSWORD` | | | |
