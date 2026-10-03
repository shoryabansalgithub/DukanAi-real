# Sprint 1 Production Freeze Declaration

This document certifies the completion status of Sprint 1 (Epic 1) Production Hardening.

---

## 1. Release Information 

- **Version:** `v1.0.0-rc2`
- **Status:** **READY FOR STAGING**
- **Previous RC:** `v1.0.0-rc1` (contained critical migration gaps — resolved in rc2)

---

## 2. Validation Summary

| Gate | Status | Evidence |
|------|--------|----------|
| Build | ✅ PASS | `npx nest build` completes with 0 errors |
| Tests | ✅ PASS | 3/3 tests pass (concurrency + idempotency) |
| Schema Sync | ✅ PASS | `prisma migrate deploy` applies cleanly and `prisma migrate diff` reports no drift |
| Migration SQL | ✅ PASS | All 5 migration directories contain valid SQL |

---

## 3. Database Guarantees

- **Foreign Key Enforcement:** `relationMode = "prisma"` has been **removed**. MySQL now enforces all foreign key constraints natively at the database level.
- **Ledger Immutability Triggers:** `prevent_ledger_update` and `prevent_ledger_delete` are defined in `20260929090200_ledger_immutability_triggers/migration.sql`. They are deployed via `prisma migrate deploy` — no manual SQL required.
- **Transactional Invoice Boundaries:** All 11 financial operations (stock, invoice, items, inventory logs, shift, udhar, audit, outbox, ledger DEBIT, ledger CREDIT) execute inside a single `Prisma.$transaction()` with `ReadCommitted` isolation.
- **Proper Double-Entry Accounting:** Ledger entries use typed `LedgerAccount` enum (`CASH`, `ACCOUNTS_RECEIVABLE`, `SALES_REVENUE`) with computed running `balanceAfter` values.
- **Composite Indexes:** Multi-tenant isolation indexes on `[shopId, createdAt]`, `[shopId, idempotencyKey]`, `[shopId, account]` patterns.

---

## 4. Distributed System Guarantees

- **Transactional Outbox:** `OutboxEvent` is created inside the billing transaction. Events cannot exist without a committed invoice.
- **SKIP LOCKED Relay:** `OutboxRelayService` uses `SELECT FOR UPDATE SKIP LOCKED` to prevent multi-pod double-dispatch.
- **BullMQ Deduplication:** `jobId = event.id` prevents duplicate queue entries.
- **Consumer Idempotency:** `SystemEventsProcessor` checks `AuditLog` before processing to guarantee exactly-once semantics.
- **Dead Letter Queue:** `UnrecoverableError` skips retries for permanent failures.
- **Redis Graceful Degradation:** If Redis fails, the application continues on MySQL-only path. `InventoryCacheService` returns `cache_miss` when Redis is unavailable.

---

## 5. Frontend Reliability

- **`sessionStorage` Idempotency:** `useIdempotencyKey` generates UUID v4 on mount, persists per-tab in `sessionStorage`.
- **Key Lifecycle:** Key is cleared ONLY on HTTP 200/201. Network failures, 504s, and server errors preserve the key for safe retry.
- **Server Enforcement:** `@@unique([shopId, idempotencyKey])` constraint with `P2002` race handler.

---

## 6. Observability

- **Correlation ID Lifecycle:** UUID generated or validated at middleware, propagated through `AsyncLocalStorage`, embedded in OutboxEvent payload, restored by BullMQ worker.
- **PII Redaction:** `CorrelationLogger` recursively redacts keys containing `password`, `token`, `cookie`, `secret`, `payment`, `authorization`, `creditcard` — including arrays and nested objects.
- **CORS:** `x-correlation-id` is included in `allowedHeaders` for browser-to-API tracing.

---

## 7. Security

- **RBAC on Billing:** `@Roles(ADMIN, SUPER_ADMIN, MANAGER, CASHIER)` guard on `BillingController`. `VIEWER` role is blocked.
- **WebSocket JWT Auth:** `InventoryGateway` verifies JWT tokens on connection and validates shop membership.
- **Production Logging:** Query-level SQL logging is disabled in production (`NODE_ENV=production`).

---

## 8. Known Limitations

- Test coverage is limited to billing concurrency and idempotency (3 tests). Additional unit tests for outbox relay, reconciliation, and correlation middleware are recommended for Epic 2.
- `skip`-based pagination in `InventoryReconService` may degrade at 100K+ products. Cursor-based pagination is recommended for scale.
- Drift alerts are logger-based only — no external notification channel (Slack/PagerDuty).

---

## 9. Operational Rules

- Sprint 1 architecture is frozen.
- Database schema changes require migration-only deployment.
- Transaction boundaries must not be modified without architect review.
- All future billing endpoints must include `@Roles()` guards.
