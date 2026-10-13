# Production Deployment Checklist

The go-live order for one release on the production topology
(`docs/DEPLOYMENT.md`, "Production topology": `docker-compose.prod.yml` on
one host, or `deploy/k8s`). The release procedure itself is `RELEASE.md`;
phase 2 below is its §4 on the production host, and every command names
`-f docker-compose.prod.yml` (without it, compose runs the reference stack
in the same directory and backs up its empty bundled database). Nothing is
built or tested on a server: the images were built once by the release
workflow after CI passed, certified, and run on staging first.

Run every phase on staging first (`docs/STAGING.md`), then on production
with the same `IMAGE_TAG`.

## Phase 1: Environment and secrets

- [ ] Every secret comes from the secret store into the host's `.env` (mode 600) or the Kubernetes Secret (`deploy/k8s/common/dukaanai-secrets.env`), is listed in `docs/SECRETS.md` with its owner, and has been rotated once on staging with the procedure there (roadmap 9.11); staging and production share no secret; the gitleaks step and its control are green in CI on the release commit.
- [ ] Docker Compose 2.24.4 or newer on the host (`docker compose version`; `docs/DEPLOYMENT.md`, "Requirements").
- [ ] `DATABASE_URL` targets the managed MySQL 8 (8.0 or 8.4) over TLS (`?sslaccept=strict`; `DB_CA_FILE` / the `dukaanai-db-ca` Secret for a private CA) with a user holding `ALL ON dukaanai.*` (the migrations create triggers) and the server parameter `log_bin_trust_function_creators=1`; `DB_OPS_DATABASE_URL` names the backup user with the same TLS options.
- [ ] `REDIS_URL` points to a managed Redis 7 with `maxmemory-policy noeviction` (`docs/DEPLOYMENT.md`, "Provider steps" 2).
- [ ] `WEB_ORIGIN` (the API's `FRONTEND_URL`) is exactly the production browser origin; `API_PUBLIC_URL` is `https://<API_HOST>/api` (read by the web at run time; `NEXT_PUBLIC_API_URL` is not a run-time setting).
- [ ] `JWT_SECRET` and `NEXTAUTH_SECRET` (32+ characters, no template value), `GRAFANA_ADMIN_PASSWORD` (the production file refuses to start without it, Grafana refuses `admin` or the placeholder), `METRICS_TOKEN` (16+ characters; Prometheus sends it), `SMTP_URL` (invitations and password reset answer 503 without it), `OFFSITE_REMOTE` + `OFFSITE_CRYPT_PASSWORD` + the backend's `RCLONE_CONFIG_<NAME>_*`.
- [ ] If Google sign-in is used: `GOOGLE_CLIENT_ID` for both applications, `GOOGLE_CLIENT_SECRET` for the web, and `https://<WEB_HOST>/api/auth/callback/google` in Google Cloud's authorized redirect URIs.
- [ ] The deployment is the decided topology (roadmap 9.7): one API replica with `STORAGE_PATH` / `UPLOADS_PATH` / `BACKUPS_PATH` on the snapshotted cloud disk (owned by uid 1000), the "Provider steps" of `docs/DEPLOYMENT.md` done in order, anything that differs recorded in `docs/DATA_SAFETY.md`.
- [ ] `IMAGE_TAG` is a release tag (`v<version>`) the release workflow pushed after CI passed, that passed the staging smoke (`scripts/smoke-remote.sh`, `docs/STAGING.md`) and whose digests staging runs (`docs/STAGING.md`, "Deploying by digest").
- [ ] The `certify` job is green on the tag and its evidence bundle (`certification-<tag>`, an asset of the tag's draft release) has been read: every step PASS in `SUMMARY.md`, nothing listed as "not run", the `exploits` step included (roadmap 9.12, 9.13).
- [ ] Supply chain (roadmap 9.14): the release `images` job's Trivy gate passed, the CycloneDX SBOMs are on the release, the CI lint job is green on gitleaks and `npm audit --omit=dev --audit-level=high` for the commit.
- [ ] Security review (roadmap 9.15): `docs/security/ASVS_L2.md` has no Open control and every row of its §15 "Owner decisions" carries a date; the external test's tracker (`docs/security/PENTEST_SCOPE.md` §7) has no open finding for this release.
- [ ] Limits and authority (roadmap 9.16): the rate limits of `docs/PRODUCTION_LIMITS.md` (the image's defaults, or larger values sized by its rule), the limits gate passed on staging, and `BILLING_CASHIER_MAX_DISCOUNT_PERCENT` / `BILLING_CASHIER_MAX_CUSTOM_LINE_AMOUNT` as the owner signed them (§6).
- [ ] A simulated business day and the failure drills passed on staging (roadmap 9.17, 9.18), recorded in `docs/BUSINESS_DAY.md` and `docs/DRILLS.md`.
- [ ] Pilot readiness (roadmap 9.19): `PILOT_OWNER_EMAIL=... PILOT_OWNER_PASSWORD=... node scripts/pilot/readiness.mjs --web https://<WEB_HOST> --api https://<API_HOST>` ends `READY`.
- [ ] The edge is in front (roadmap 9.8): `WEB_HOST` / `API_HOST` resolve to it, both answer over HTTPS with a valid certificate and HSTS, `http://` redirects, `GET https://<API_HOST>/api/metrics` is 404 from the internet (and `/API/metrics` too), only 80/443 are published, `TRUST_PROXY` equals the proxy hops (1 for the edge alone).
- [ ] The monitoring ports (9090, 9093, 9115, 3100, 3001) are published on 127.0.0.1 only and reached through an SSH tunnel (`docs/DEPLOYMENT.md`, "Monitoring access"): `ss -ltn` on the host shows none on `0.0.0.0`.

## Phase 2: Release (`RELEASE.md` §4, on the production host)

In the directory holding `docker-compose.prod.yml` and its `.env`, outside
shop hours:

```
grep '^IMAGE_TAG=' .env                     # the release running now: write it down, it is the rollback target
docker compose -f docker-compose.prod.yml --profile ops run --rm db-ops backup --label pre-vX.Y.Z
docker compose -f docker-compose.prod.yml --profile ops run --rm db-ops documents-backup
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=vX.Y.Z/' .env
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml run --rm migrate
docker compose -f docker-compose.prod.yml up -d --wait
```

- [ ] Both backups ended with their checksum line; `docker compose -f docker-compose.prod.yml --profile ops run --rm db-ops status` lists them (the dump with its binary-log position, unless the agent runs with `BACKUP_COORDINATES=skip`); their paths are in the release record. The provider's point-in-time recovery is on (the production topology has no binary-log archiver of its own).
- [ ] `migrate` printed each migration it applied, or `No pending migrations to apply`, and exited 0. A failed migration stops the release here: `apps/api/prisma/MIGRATIONS.md`, "A migration recorded as failed"; the new release is not started.
- [ ] `up -d --wait` returned: the API is healthy on its readiness probe (it refuses to boot when a migration of its image is not applied), the web and the edge are healthy.
- [ ] Kubernetes instead: `deploy/k8s/README.md`, "Release": the migration Job applied alone and complete, then the application.
- [ ] The backup agent runs (`docker compose -f docker-compose.prod.yml ps backup-agent`): the nightly dump, documents archive and off-site copy happen inside it; no host cron is needed.

## Phase 3: Probes

- [ ] `curl -fsS https://<API_HOST>/api/health` answers `"release":"vX.Y.Z"`; so does `https://<WEB_HOST>/api/health`.
- [ ] `curl -fsS https://<API_HOST>/api/health/ready` answers 200 with `checks.database` and `checks.redis` `up`.
- [ ] `bash scripts/smoke-remote.sh https://<WEB_HOST> https://<API_HOST> --probes-only` ends `REMOTE SMOKE PASSED` (no shop is registered on production).
- [ ] `docker compose -f docker-compose.prod.yml logs edge` (or the cert-manager Certificate) shows the certificates obtained; the API's JSON log lines carry a `correlationId`.

## Phase 4: Smoke (staging; on production only with the owner's own shop)

- [ ] Sign in, open a shift, make a sale through the POS: the receipt prints, the invoice is listed.
  - The sale has one `LedgerPosting` with `sourceType = 'SALE'` whose `LedgerTransaction` rows balance (`docs/POS_BILLING_CONTRACT.md` §9).
  - Its `OutboxEvent` went from `PENDING` to `DONE`.
- [ ] A write as a `VIEWER` answers 403.
- [ ] `POST /api/reconciliation/run` as the shop owner answers `status: CLEAN` for the day of the sale.

## Phase 5: Observability

- [ ] The monitoring stack is up (`docker compose -f docker-compose.prod.yml --profile ops up -d prometheus alertmanager blackbox loki alloy grafana`): Prometheus › Status › Targets shows `dukaanai-api` up (scraped with `METRICS_TOKEN`) and the public probes of `blackbox-http`, `blackbox-login`, `blackbox-tls` up.
- [ ] `backup_last_success_timestamp_seconds` exists for dump, documents and offsite once the agent has run (no binlog kind in production); `DukaanAiBackupNeverRecorded` is quiet (the production topology is loaded: `dukaanai:backup_expected` lists those three kinds).
- [ ] A request made with a chosen `x-correlation-id` is found in Loki through the "DukaanAI logs" dashboard (roadmap 9.10).
- [ ] Alert delivery: a synthetic critical alert posted to Alertmanager reached the on-call phone (`docs/OBSERVABILITY.md`, "Test the delivery").
- [ ] The external uptime checker watches `/api/health/ready` and `/login` every minute (`docs/OBSERVABILITY.md`, "Uptime checks").
- [ ] A request body with a secret (`{"password": "test"}`) shows `[REDACTED]` in the log.
- [ ] For the first hour no alert fires and the 5xx and checkout panels look as before; the next morning the nightly reconciliation is CLEAN (`RELEASE.md` §8).

**APPROVAL: Go-live requires every step above, and the owner's decision
(`docs/GO_LIVE.md`).**
