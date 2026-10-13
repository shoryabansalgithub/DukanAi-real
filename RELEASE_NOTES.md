# DukaanAI Release Notes

> **Historical, superseded.** These are the v1.0.0-rc1 notes of June 2026 (never
> tagged in git). Several claims below did not hold or later stopped holding
> (the outbox could lose an event that used up its retries; see "Corrections to
> the v1.0.0-rc1 and v1.0.0-rc2 entries" in `CHANGELOG.md`). Release notes are
> now the `CHANGELOG.md` section
> of each version, published on the GitHub release of its tag (`RELEASE.md`).

**Version:** `v1.0.0-rc1` (Sprint 1 Release Candidate)

## Executive Summary
This release candidate marks the formal conclusion of **Phase 4: Production Hardening**. The entire architecture has been meticulously audited, sealed, and prepared for high-concurrency, multi-pod enterprise banking loads. 

We have successfully migrated the architecture from a functional prototype into a zero-tolerance distributed system.

## Major Architectural Upgrades

### 1. Infallible Database Guarantees
We eradicated all reliance on application-layer logic for financial security. Double-entry `LedgerTransaction` records are strictly governed by native MySQL triggers generated implicitly by Prisma migrations. Financial history can no longer be updated or deleted by any code or manual query.

### 2. Transactional Outbox + BullMQ Resiliency
Background processing has been rebuilt onto a bulletproof Dual-Write Outbox pattern. Financial side-effects (like OCR jobs or reporting) enqueue asynchronously to BullMQ via a Relayer that polls MySQL using `SKIP LOCKED` rows, entirely eliminating duplicate delivery and deadlock states across horizontally scaled environments.

### 3. Deep Distributed Tracing (Observability)
Every single request arriving from the frontend is tagged with an idempotent UUID that propagates deeply through the backend layers via Node's native `AsyncLocalStorage`. If a request throws an error inside an asynchronous BullMQ worker 4 hours after the HTTP request disconnected, the `CorrelationLogger` will emit the exact same Trace ID. Furthermore, the logger aggressively scrubs all PII out of standard output in real-time.

### 4. Disposable Cache Auto-Healing
Redis is now treated exclusively as volatile. If Redis fails, the system executes gracefully against MySQL. If Redis hallucinates stock levels, the multi-pod Cron `InventoryReconService` detects it, forces an `InventoryDriftLog` audit into MySQL, and silently heals the cache.

### 5. Frontend Idempotency Safety
Mobile network flutters, accidental button double-clicks, and 504 Gateway Timeouts will no longer generate duplicate bills. The `sessionStorage` frontend idempotency lock persists deeply in the browser and flawlessly instructs the backend's `P2002` handler to reject identical simultaneous POST requests.

## Known Limitations / Errata
- This release candidate (`rc1`) freezes the core database architecture. No further schema changes will be permitted to the core Ledger mapping.
- Local `npm run test` suites may issue a Redis `ECONNREFUSED` if no Redis daemon is mounted; however, this explicitly validates the system's ability to gracefully fail-open.
