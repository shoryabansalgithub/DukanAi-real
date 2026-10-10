# Production Deployment Checklist (v1.0.0-rc2)

This checklist enforces the exact execution order required to deploy Epic 1 safely.

## Phase 1: Environment & Secrets
- [ ] Every secret comes from the secret store into the host's `.env` (mode 600) or the Kubernetes Secret, is listed in docs/SECRETS.md with its owner, and has been rotated once on staging with the procedure there (roadmap 9.11); staging and production share no secret; the gitleaks step of CI is green on the release commit.
- [ ] Verify `DATABASE_URL` targets a live MySQL 8.x+ instance with `CREATE TRIGGER` privileges.
- [ ] Verify `REDIS_URL` points to a Redis 6.2+ instance.
- [ ] Verify `FRONTEND_URL` exactly matches production CORS origin(s), comma-separated.
- [ ] Verify `JWT_SECRET` (32+ characters, no template value), `JWT_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` and `SESSION_ABSOLUTE_LIFETIME` are set; there is no refresh secret (refresh tokens are opaque and stored hashed).
- [ ] Configure `NEXTAUTH_SECRET` and `NEXTAUTH_URL` in the web application.
- [ ] If Google OAuth is enabled, set `GOOGLE_CLIENT_ID` in both applications, `GOOGLE_CLIENT_SECRET` in the web application, and add `https://YOUR_WEB_ORIGIN/api/auth/callback/google` to Google Cloud's authorized redirect URIs.
- [ ] Verify `NODE_ENV=production` (disables Swagger and query logging; production also refuses `LOG_LEVEL=debug`, a relative `STORAGE_ROOT`, a placeholder `SENTRY_DSN` and `AUTH_DISABLED`).
- [ ] The deployment is the decided topology (docs/DEPLOYMENT.md, "Production topology", roadmap 9.7): managed MySQL 8 reached over TLS (`DATABASE_URL` carries `?sslaccept=strict`, `DB_CA_FILE` / the `dukaanai-db-ca` Secret for a private CA), managed Redis, one API replica with `STORAGE_PATH` / `UPLOADS_PATH` / `BACKUPS_PATH` on the snapshotted cloud disk, `docker-compose.prod.yml` or `deploy/k8s`; the "Provider steps" are done in order and anything that differs is recorded in docs/DATA_SAFETY.md.
- [ ] `IMAGE_TAG` names a release the release workflow pushed and that passed the staging smoke (`scripts/smoke-remote.sh`, docs/STAGING.md); nothing is built on the server (roadmap 9.9).
- [ ] The `certify` job of the release workflow is green on the tag and its evidence bundle (`certification-<tag>`, the asset of the tag's release) has been read: every step PASS in `SUMMARY.md` (including the `exploits` step, roadmap 9.13: every audit exploit refused over HTTP), the image digests equal the ones about to be pulled (roadmap 9.12; docs/DEPLOYMENT.md, "Certification of a release candidate").
- [ ] Supply chain (roadmap 9.14): the release `images` job's Trivy gate passed (no fixable HIGH/CRITICAL in any image), the CycloneDX SBOMs are attached to the release (`sbom-dukaanai-{api,web,db-ops}.cdx.json`), and the CI lint job is green on gitleaks and `npm audit --omit=dev --audit-level=high` for this commit.
- [ ] Security review (roadmap 9.15): `docs/security/ASVS_L2.md` has no Open control and every row of its §15 "Owner decisions" carries a date; the external test's tracker (`docs/security/PENTEST_SCOPE.md` §7) has no open finding for this release.
- [ ] Limits and authority (roadmap 9.16): the production `.env` carries the `RATE_LIMIT_*` / `AUTH_RATE_LIMIT_*` values of `docs/PRODUCTION_LIMITS.md` (or larger ones sized by its rule for the shop's terminal count), the limits gate passed on staging (`docs/STAGING.md` evidence row), and `BILLING_CASHIER_MAX_DISCOUNT_PERCENT` / `BILLING_CASHIER_MAX_CUSTOM_LINE_AMOUNT` are the values the owner signed in that document's §6.
- [ ] A simulated business day passed on staging (roadmap 9.17): `apps/api/load/business-day.mjs` with the production limits and this release's images, Redis restarted and the API killed mid-run, the report's gate all PASS (zero API 5xx, no lost or duplicated invoice, in-flight documents complete or absent, reconciliation CLEAN for every shop); the report is recorded in docs/BUSINESS_DAY.md and the `business-day` step of the certify bundle is PASS.
- [ ] The failure drills passed on staging (roadmap 9.18): the API killed during a checkout burst, MySQL stopped 60 s, Redis stopped 5 minutes, the documents volume filled, an expired certificate at the edge, the database restored from the off-site copy to the second before a chosen sale; for each, what users saw, what the alerts said (and the page that reached the on-call phone), the time to recovery and a CLEAN reconciliation are recorded in docs/DRILLS.md, and the `drills` step of the certify bundle is PASS.
- [ ] Pilot readiness (roadmap 9.19): `PILOT_OWNER_EMAIL=... PILOT_OWNER_PASSWORD=... node scripts/pilot/readiness.mjs --web https://<WEB_HOST> --api https://<API_HOST>` ends `READY` (a WARN only for Google sign-in where the shop does not use it): HTTPS, probes, the API URL the web gives browsers, Google configured on both sides or neither, SMTP set, metrics hidden, the shop profile complete (state for IGST), an OCR key, a session lifetime of at most 24 h. The class defaults the image runs equal `apps/api/.env.production` (`src/config/production-defaults.spec.ts` in CI); a value set in the deployment `.env` on top is deliberate and recorded.
- [ ] The edge is in front (roadmap 9.8): `WEB_HOST` / `API_HOST` resolve to it, `https://<WEB_HOST>` and `https://<API_HOST>/api/health` answer with a valid certificate and HSTS, `http://` redirects, `GET https://<API_HOST>/api/metrics` is 404 from the internet, the API and web ports are not published, and `TRUST_PROXY` equals the number of proxy hops (1 for the edge alone, 2 with a load balancer in front of it).

## Phase 2: Database Orchestration
- [ ] Halt all cron workers and BullMQ consumers in the existing environment.
- [ ] Take a backup first (`scripts/db/backup.sh --label pre-<version>`, or `docker compose --profile ops run --rm db-ops backup --label pre-<version>`) and note its path in the release record; the restore drill (`scripts/db/restore-drill.sh`, CI job "Integration tests") passed on this revision — see docs/BACKUP_RESTORE.md.
- [ ] The recovery objectives are signed (docs/DATA_SAFETY.md) and the four backup jobs are scheduled: the nightly dump, the binary-log archive every five minutes, the nightly documents archive, the nightly encrypted off-site copy with `OFFSITE_REMOTE` and `OFFSITE_CRYPT_PASSWORD` from the secret store (docs/BACKUP_RESTORE.md, roadmap 9.2 to 9.4).
- [ ] Run the release step `prisma migrate deploy` from the API image (compose: the `migrate` service; Kubernetes: a Job) before the new API starts — see docs/DEPLOYMENT.md.
  - Must create tables: `LedgerTransaction`, `OutboxEvent`, `InventoryDriftLog`
  - Must create triggers: `prevent_ledger_update`, `prevent_ledger_delete`
  - Must add columns: `stockVersion` on Product, `idempotencyKey` on Invoice
  - Must add foreign key constraints for all relations
- [ ] **No manual SQL required.** All infrastructure is created via Prisma migrations.

## Phase 3: Cluster Boot Sequence
- [ ] Execute `npm run build` — must complete with 0 errors.
- [ ] Execute `npm test --workspace=api -- --runInBand` — unit tests must pass.
- [ ] Boot the primary API HTTP nodes.
- [ ] Verify `GET /api/health/ready` answers 200 with `checks.database` and `checks.redis` = `up` (liveness is `/api/health`); wire the orchestrator's readiness probe to it.
- [ ] `GET https://<API_HOST>/api/health/ready` through the edge answers the same; `docker compose -f docker-compose.prod.yml logs edge` (or the cert-manager Certificate) shows the certificate obtained.
  - Verify `correlationId` appears in stdout logs.
- [ ] Start BullMQ worker processes.
  - `CronLockService` should log a successful Redis connection.
  - `OutboxRelayService` should begin polling MySQL every 5 seconds.

## Phase 4: Smoke Test
- [ ] Authenticate and obtain a JWT token.
- [ ] Send a POST to `/api/billing/invoice` with valid data.
  - Verify the response contains an invoice with items.
  - Verify one `LedgerPosting` header with `sourceType = 'SALE'` and the invoice id exists, and that its `LedgerTransaction` rows balance (Σ debits = Σ credits: CASH/BANK or ACCOUNTS_RECEIVABLE and COST_OF_GOODS against SALES_REVENUE, GST_PAYABLE and INVENTORY; see docs/POS_BILLING_CONTRACT.md §9).
  - Verify `OutboxEvent` was created with status `PENDING`, then processed to `DONE`.
- [ ] Fire a test POST with a `VIEWER` role token.
  - Verify HTTP 403 Forbidden is returned.

## Phase 5: Observability Validation
- [ ] `GET /api/metrics` (from the internal network: the edge hides it) carries `backup_last_success_timestamp_seconds` for the kinds the deployment runs (dump, documents, offsite from the `backup-agent`; binlog only where the self-hosted archiver runs) once the jobs have run; `DukaanAiBackupStale` and `DukaanAiBackupNeverRecorded` are loaded (roadmap 9.4).
- [ ] `POST /api/reconciliation/run` as the shop owner answers `status: CLEAN` for the day of the smoke sale, `GET /api/metrics` carries `reconciliation_last_run_timestamp_seconds`, and `DukaanAiReconciliationDrift` / `DukaanAiReconciliationStale` are loaded; the nightly `Reconciliation` cron is enabled on at least one instance (roadmap 9.5).
- [ ] Filter logs for `correlationId` to confirm tracing works: a request made with a chosen `x-correlation-id` is found in Loki through the "DukaanAI logs" dashboard (roadmap 9.10).
- [ ] Alert delivery (roadmap 9.10): `ALERT_*` set, the monitoring stack up (`--profile ops`), a synthetic critical alert posted to Alertmanager reached the on-call phone (docs/OBSERVABILITY.md, "Test the delivery"); the "DukaanAI operations" dashboard shows the smoke sale.
- [ ] Uptime (roadmap 9.10): the external checker watches `/api/health/ready` and `/login` every minute and reported the induced outage on staging; the public probe targets are in `deploy/prometheus/prometheus.yml`.
- [ ] Fire a POST with PII data in body (e.g., `{"password": "test"}`).
  - Verify stdout shows `[REDACTED]` instead of the actual value.

**APPROVAL: Go-Live requires verification of all steps above.**
