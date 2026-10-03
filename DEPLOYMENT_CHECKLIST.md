# Production Deployment Checklist (v1.0.0-rc2)

This checklist enforces the exact execution order required to deploy Epic 1 safely.

## Phase 1: Environment & Secrets
- [ ] Verify `DATABASE_URL` targets a live MySQL 8.x+ instance with `CREATE TRIGGER` privileges.
- [ ] Verify `REDIS_URL` points to a Redis 6.2+ instance.
- [ ] Verify `FRONTEND_URL` exactly matches production CORS origin(s), comma-separated.
- [ ] Verify `JWT_SECRET` (32+ characters, no template value), `JWT_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` and `SESSION_ABSOLUTE_LIFETIME` are set; there is no refresh secret (refresh tokens are opaque and stored hashed).
- [ ] Configure `NEXTAUTH_SECRET` and `NEXTAUTH_URL` in the web application.
- [ ] If Google OAuth is enabled, set `GOOGLE_CLIENT_ID` in both applications, `GOOGLE_CLIENT_SECRET` in the web application, and add `https://YOUR_WEB_ORIGIN/api/auth/callback/google` to Google Cloud's authorized redirect URIs.
- [ ] Verify `NODE_ENV=production` to disable Swagger and SQL query logging.

## Phase 2: Database Orchestration
- [ ] Halt all cron workers and BullMQ consumers in the existing environment.
- [ ] Take a backup first (`scripts/db/backup.sh --label pre-<version>`, or `docker compose --profile ops run --rm db-ops backup --label pre-<version>`) and note its path in the release record; the restore drill (`scripts/db/restore-drill.sh`, CI job "Integration tests") passed on this revision — see docs/BACKUP_RESTORE.md.
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
  - Verify `correlationId` appears in stdout logs.
- [ ] Start BullMQ worker processes.
  - `CronLockService` should log a successful Redis connection.
  - `OutboxRelayService` should begin polling MySQL every 5 seconds.

## Phase 4: Smoke Test
- [ ] Authenticate and obtain a JWT token.
- [ ] Send a POST to `/api/billing/invoice` with valid data.
  - Verify the response contains an invoice with items.
  - Verify `LedgerTransaction` table has exactly 2 entries (DEBIT + CREDIT) for this invoice.
  - Verify `OutboxEvent` was created with status `PENDING`, then processed to `DONE`.
- [ ] Fire a test POST with a `VIEWER` role token.
  - Verify HTTP 403 Forbidden is returned.

## Phase 5: Observability Validation
- [ ] Filter logs for `correlationId` to confirm tracing works.
- [ ] Fire a POST with PII data in body (e.g., `{"password": "test"}`).
  - Verify stdout shows `[REDACTED]` instead of the actual value.

**APPROVAL: Go-Live requires verification of all steps above.**
