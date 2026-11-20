> **Historical document, superseded.** Kept for the record: it describes an
> earlier state of the project (mock data, Next.js 14, Node 18/20, features
> that were never built) and is no longer maintained. Current documentation:
> [README.md](./README.md) (what is built, how to run it, the docs map),
> [AGENTS.md](./AGENTS.md) (architecture and sharp edges) and
> [docs/](./docs) (deployment, operations, release, go-live).

# Backend Analysis Report — DukanAI `apps/api/`

## Summary

NestJS 11 monolith with Prisma (MySQL), Redis, BullMQ, Socket.IO, ~100 source files across 40+ modules.
The codebase compiles with **4 errors** (missing `@types/uuid` and missing `axios`) and has several
critical runtime bugs, architectural redundancies, and security concerns.

---

## Build & Type-Check Output

```
> tsc --noEmit --incremental false
src/common/middleware/correlation-id.middleware.ts(3,30): error TS7016: Cannot find module 'uuid'
src/import-export/file-storage.service.ts(4,30): error TS7016: Cannot find module 'uuid'
src/product-events/services/product-event-publisher.service.ts(3,30): error TS7016: Cannot find module 'uuid'
src/product-events/services/webhook-dispatcher.service.ts(4,19): error TS2307: Cannot find module 'axios'
```

**Fix:** `npm install --save-dev @types/uuid && npm install axios`

---

## Prioritized Issues

### P0 — Must Fix (break compilation or cause runtime crashes)

| # | File:Line | Issue | Recommendation |
|---|-----------|-------|----------------|
| 1 | `apps/api/src/users/users.service.ts:33` | `findUnique` called with non-unique field `isDeleted`. Prisma throws at runtime because `isDeleted` is not part of any `@@unique` on `User`. | Use `findFirst({ where: { id, isDeleted: false } })` instead. |
| 2 | `apps/api/src/common/middleware/correlation-id.middleware.ts:3`, `src/import-export/file-storage.service.ts:4`, `src/product-events/services/product-event-publisher.service.ts:3` | `uuid` imported but `@types/uuid` not installed. **Blocks compilation.** | `npm install --save-dev @types/uuid` |
| 3 | `apps/api/src/product-events/services/webhook-dispatcher.service.ts:4` | `axios` imported but never installed as a dependency. **Blocks compilation.** | `npm install axios` |
| 4 | `apps/api/src/prisma/prisma.service.ts:26-36` | Constructor returns `new Proxy(this, ...)` after calling `this.$extends(...)`. The `extended` client is a *different PrismaClient instance* from `this`. `onModuleInit` calls `this.$connect()` on the original, but NestJS holds the Proxy — methods route to `extended` while lifecycle hooks route to `target`. DI injection through the Proxy means `PrismaService` injected elsewhere gets the Proxy wrapper, but hook invocation by NestJS goes to `this` (original). This creates a split-brain: the extended client (used for queries) and the original (used for lifecycle) are separate instances. The `$extends()` call also happens in the constructor before `onModuleInit` — the returned extended client may not have `$connect()` called on it. | Refactor: create the extended client once in `onModuleInit` after `$connect()`, or use a factory provider that returns the extended client. Avoid returning a Proxy from a NestJS provider constructor. |
| 5 | `apps/api/src/app.module.ts:67`, `src/common/outbox/outbox.module.ts:9`, `src/product-events/product-events.module.ts:17` | `ScheduleModule.forRoot()` registered **3 times**. NestJS 11 may throw `Multiple instances of SchedulerModule detected`. | Remove from `OutboxModule` and `ProductEventsModule`; keep only in `AppModule`. |
| 6 | `apps/api/src/events-domain/workers/outbox-relay.worker.ts` vs `src/common/outbox/outbox-relay.service.ts` | **Two competing outbox relay systems.** Both poll `OutboxEvent` table for `PENDING` events and try to process them. They use different mechanisms (`@Cron` vs manual loop) and different dispatch targets (BullMQ `system-events` queue vs `EventBusService`). At high throughput they will race, producing duplicate dispatches. | Consolidate into a single relay. Decide whether BullMQ is the transport layer (discard `events-domain/`) or the EventBus is (discard `common/outbox/`). |

### P1 — Should Fix (architectural, security, performance)

| # | File:Line | Issue | Recommendation |
|---|-----------|-------|----------------|
| 7 | `apps/api/prisma/schema.prisma:575` | `User.shopId` has `onDelete: NoAction, onUpdate: NoAction`. If a shop is deleted, users remain orphaned. Many other models also use `NoAction/NoAction`. | Audit all `onDelete` directives. Use `Restrict` or `Cascade` appropriate to the business domain. |
| 8 | `apps/api/prisma/schema.prisma:794-796` | `Product` has `@@fulltext([name, aliases, searchKeywords])` — fulltext index on MySQL. This requires a MySQL fulltext index, which only works with MyISAM or InnoDB with proper config. If the DB uses InnoDB without fulltext support, this will fail. | Verify MySQL version (5.6+ for InnoDB fulltext). Add `@@index([name])` as fallback. |
| 9 | `apps/api/src/common/middleware/correlation-id.middleware.ts` | Uses `uuid` but AsyncLocalStorage-based correlation is handled in `TenantContextInterceptor`. The middleware + interceptor create two-layer correlation tracking, potentially overwriting each other. | Merge the correlation middleware into the `TenantContextInterceptor` or ensure they don't conflict. |
| 10 | `apps/api/src/iam/tenant-context/tenant-context.interceptor.ts:41-45` | The interceptor wraps `next.handle()` in a custom `Observable` subscriber that may not properly handle errors or completion signals (no `complete` or `error` forwarding for the inner subscriber). | Use `tap()` or `map()` RxJS operators instead of raw subscriber creation. |
| 11 | `apps/api/src/auth/jwt-auth.guard.ts` | Global JWT guard rejects unauthenticated requests. Combined with the global `ValidationPipe` and `ThrottlerGuard`, the execution order on `OPTIONS` preflight requests may cause issues. `helmet` is applied but CORS preflight handling is before it. | Verify CORS preflight (`OPTIONS`) passes through without hitting guards. |
| 12 | `apps/api/src/billing/billing.service.ts:136-148` | Raw SQL `UPDATE Product SET currentStock = currentStock - ...` bypasses Prisma type safety and the tenant extension. If the tenant extension would inject `shopId` filtering, this raw query manually handles it — but any future schema change to the shopId column name would silently break this. | Use Prisma `updateMany` with tenant filter, or extract raw SQL into a documented repository method. |
| 13 | `apps/api/src/users/users.service.ts:48` | `UserService.create()` generates `crypto.randomUUID()` for both `userId` and `shopId`. If the transaction fails after `shop.create()` but before `user.create()` due to a non-unique-constraint error, the transaction rolls back, but the UUIDs are still "consumed" conceptually. | Use Prisma's `@default(cuid())` instead of application-generated UUIDs. |
| 14 | `apps/api/src/products/products.service.ts:22-25` | `findUnique` with compound unique `shopId_sku_deletedAt` passing `deletedAt: null as any`. The `as any` cast suppresses type safety. MySQL allows multiple NULLs in unique indexes, so this may return multiple results silently. | Use `findFirst` with explicit non-unique `where` clause. |
| 15 | `apps/api/src/events-domain/services/event-publisher.service.ts` vs `src/product-events/services/product-event-publisher.service.ts` | **Two event publisher services** with near-identical interfaces. `EventPublisherService` writes only to `OutboxEvent`, while `ProductEventPublisher` writes to both `OutboxEvent` and `ProductEventLog`. | Merge into one unified outbox publisher that handles both tables. |
| 16 | `apps/api/src/app.module.ts:157,163` | Both `AnalyticsModule` and `AnalyticsDomainModule` are imported. These may be duplicate modules with overlapping concerns. | Audit both modules; consolidate or remove the unused one. |
| 17 | `apps/api/src/inventory/inventory.module.ts:15-21` | `InventoryModule` registers `JwtModule` just for the WebSocket gateway, coupling inventory to JWT concerns. Gateways can use `@nestjs/passport` token extraction differently. | Move JWT registration to a shared `WebSocketModule` or use `AuthenticatedIoAdapter`. |
| 18 | `apps/api/src/main.ts:31` | `app.use(helmet())` uses defaults. Helmet default CSP may conflict with Swagger UI loading CDN resources. Also no HSTS or other security headers explicitly configured. | Configure helmet with appropriate CSP, HSTS, and referrer-policy for production. |

### P2 — Nice to Fix (quality, maintainability, observability)

| # | File:Line | Issue | Recommendation |
|---|-----------|-------|----------------|
| 19 | `apps/api/prisma/schema.prisma` | 120+ models, ~3,500+ lines. Soft-delete pattern on nearly every model creates wide tables with `isDeleted` + `deletedAt` but no composite index on those columns. Many models have `onDelete: NoAction, onUpdate: NoAction` but no compensating business logic. | Add `@@index([isDeleted, deletedAt])` on all soft-delete models. Consider partitioning or archiving old soft-deleted records. |
| 20 | `apps/api/src/iam/tenant-context/tenant-context.interface.ts` | `TenantContext` has `readonly` properties, but `runAsSuperAdmin` in `tenant-context.service.ts:64-66` spreads the context into a new object, losing readonly enforcement at runtime. | Use a mapped type or `ReadonlyDeep` to maintain compile-time readonly through spread operations. |
| 21 | `apps/api/src/auth/auth.service.ts:42` | `findByEmailWithPassword` returns `UserWithPasswordRecord` containing password hash. The password comparison log doesn't `await` properly in the validate flow — if `bcrypt.compare` throws, the `catch` is in the controller or guard. | Add explicit error handling for the bcrypt operation. |
| 22 | `apps/api/src/billing/billing.service.ts` | 655-line method doing atomic billing with optimistic locking, Redis pre-check, retry loop, and manual raw SQL. Extremely complex. The raw SQL bypasses Prisma's type safety and tenant extension. | Extract into smaller services: `StockReservationService`, `InvoiceCreationService`, `LedgerService`. |
| 23 | `apps/api/src/prisma/prisma-tenant.extension.ts` | `tenantOwnedModels` is a hardcoded `Set<string>` — must be kept in sync with the schema whenever new tenant-scoped models are added. | Derive the list from the Prisma schema via `dmmf` or a convention (e.g., all models with `shopId` field). |
| 24 | `apps/api/src/iam/websockets/authenticated-io.adapter.ts` | Socket.IO auth adapter is referenced in `main.ts` but the adapter file is in `iam/websockets/` — no cross-check was done for whether the adapter properly handles JWT extraction for Socket.IO handshake. | Verify the adapter handles token expiry and tokenVersion revocation. |
| 25 | `apps/api/src/users/user.mapper.ts:5-16` | `safeUserSelect` does not include the `shop` relation, but `UserMapper.toSafeUserDto` conditionally accesses `user.shop.status`. The conditional handles this gracefully, but it means `findSafeById` returns users without `shopStatus`. | Add `shop: { select: { status: true } }` to `safeUserSelect` so the mapper always has the data. |

---

## Architectural Observations

### Redundant Event Systems
There are **three** event/outbox systems with overlapping responsibilities:
1. **`common/outbox/`** — `OutboxRelayService` (cron → BullMQ `system-events`) + `SystemEventsProcessor`
2. **`product-events/`** — `ProductEventPublisher` + `OutboxProcessorWorker` + BullMQ `internal-events` queue
3. **`events-domain/`** — `EventPublisherService` + `OutboxRelayWorker` (manual poll) + `EventBusService`

Each writes to `OutboxEvent` and/or `ProductEventLog` tables. When multiple services poll the same `OutboxEvent` table, they will conflict. **Consolidation is critical.**

### Module Coupling
- `BillingModule` → `InventoryModule` (for gateway + cache + drift alerts) → `PrismaModule`
- `ProductsModule` → `ProductEventsModule` (for event publishing) → BullMQ queues + `ScheduleModule`
- `InventoryDomainModule` → `ProductEventsModule` → creates dependency from inventory domain to product events

### PrismaService Proxy Pattern Risk
The Proxy in `PrismaService` constructor: `return new Proxy(this, { get: ... })` is an anti-pattern in NestJS:
- Constructor returns a *different object* than `this`
- Lifecycle hooks (`onModuleInit`, `onModuleDestroy`) are bound to the original class instance, but NestJS stores the Proxy as the provider instance
- `$extends()` creates a new client — the extended client and the original `this` are separate instances
- If lifecycle hooks call `this.$connect()`, it connects the original client, while actual queries use `extended` via the Proxy — the extended client may never be connected

### `ScheduleModule.forRoot()` Triple Registration
NestJS `@nestjs/schedule` throws if `forRoot()` is called more than once. It's registered in:
- `AppModule` (line 67)
- `OutboxModule` (line 9)
- `ProductEventsModule` (line 17)

This will cause a runtime startup failure in NestJS v11.

---

## Conclusion

The backend has a solid architecture foundation (global guards, tenant isolation via AsyncLocalStorage, transactional outbox, optimistic locking) but suffers from:

1. **4 build-blocking errors** (missing deps)
2. **At least 1 guaranteed runtime crash** (`findUnique` with non-unique field)
3. **Triple-registered `ScheduleModule`** that will throw on startup
4. **Split-brain PrismaService Proxy** that may silently connect the wrong client instance
5. **Three redundant event/outbox systems** that will race and conflict
6. **40+ modules** with unclear boundaries and some duplicates

**Estimated fix effort:**
- P0 fixes: ~2-4 hours (deps, findUnique refactor, ScheduleModule dedup, PrismaService refactor)
- P1 fixes: ~8-16 hours (outbox consolidation, schema audit, security hardening, module reorganization)
- P2 fixes: ~4-8 hours (indexes, extractions, type cleanup)
