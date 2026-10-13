> **Historical audit, superseded.** One of the audit passes that the
> production-readiness roadmap (phases 0 to 9) answered; its findings are
> closed or tracked there and it is no longer maintained. Current documentation:
> [README.md](../../README.md), [AGENTS.md](../../AGENTS.md) and [docs/](../../docs).

# DukanAI — Pass 4 Prisma & Database Deep Audit

## 1. Schema Summary
The database is modeled via Prisma ORM connecting to a MySQL instance. The `schema.prisma` file is incredibly dense, containing over 160 distinct models and enums, heavily structured around Domain-Driven Design (Inventory, Sales, Pricing, Auth). It makes extensive use of native Prisma enums and multi-field indexes.

## 2. Model Audit
* **Severity: P0 (Critical)**
* **Root Cause**: The `RefreshToken` model has been completely deleted from `schema.prisma`.
* **Runtime Impact**: `this.prisma.refreshToken.findFirst()` crashes at runtime in `auth.service.ts` with a `TypeError` because the generated PrismaClient does not contain the model.
* **Proof**: Natively throwing errors in `npm test` suites for `AuthService`. The model is absent in the `schema.prisma` file, but the code actively queries it.

## 3. Migration Audit
* **Severity: P0 (Critical)**
* **Root Cause**: Severe Schema Drift. 
* **Proof**: The migration history (specifically `20260717185000_schema_baseline/migration.sql`) clearly executes `CREATE TABLE RefreshToken`. However, `RefreshToken` was manually deleted from `schema.prisma` without generating a corresponding down-migration. The database physical state and the Prisma schema state are entirely desynchronized, proving destructive, manual tampering with the schema file outside of the migration lifecycle.

## 4. Query Audit
* **Severity: P0 (Critical)**
* **Root Cause**: Generated client staleness / incompleteness. The generated `@prisma/client` bindings are structurally invalid for the current application code because of the aforementioned schema drift.
* **Severity: P3 (Low)**
* **Root Cause**: Raw SQL. 
* **Proof**: An exhaustive grep of the backend repository confirms **zero** usages of `$queryRaw` or `$executeRaw`. The repository strictly adheres to Prisma's Query Engine, completely eliminating SQL injection vectors.

## 5. Transaction Audit
* **Severity: P2 (Medium)**
* **File**: `apps/api/src/sales-domain/engines/order-modification-engine.ts`
* **Root Cause**: Unprotected cascading deletes within transactions. `tx.salesOrderLine.deleteMany({ where: { orderId } })` executes a bulk delete without explicitly passing a `shopId`. While the `orderId` is validated upstream, failing to enforce `shopId` explicitly on the deletion boundary risks data destruction if the upstream validation is ever bypassed.

## 6. Performance Audit
* **Severity: P1 (High)**
* **Root Cause**: Connection Pool Exhaustion Risk. The backend heavily utilizes deep, long-running `$transaction` blocks (e.g. `order-modification-engine.ts` doing multi-table validations, `calculateFinancials` CPU-bound synchronous loops, and 4 sequential writes) while holding the database lock. Under high concurrent load, these thick transactions will exhaust the Prisma connection pool, causing `Timeout fetching connection from pool` crashes.

## 7. Multi-Tenant Audit
* **Severity: P0 (Critical)**
* **File**: `apps/api/src/prisma/prisma-tenant.extension.ts`
* **Root Cause**: Catastrophic Tenant Isolation Failure. The Prisma client extension enforces multi-tenancy by automatically injecting `shopId` into `where` and `create` clauses. However, it relies on a hardcoded set named `tenantOwnedModels`, which only contains 15 models (e.g., `Product`, `Category`). 
* **Runtime Impact**: Over 50 models in the schema possess a `shopId` (including `User`, `SalesOrder`, `Reservation`, `Location`), but they are missing from this set. Any API query fetching `this.prisma.salesOrder.findMany()` completely bypasses the extension, fetching Sales Orders for **ALL TENANTS** across the platform.

## 8. Referential Integrity Audit
* **Severity: PASS**
* **Proof**: Prisma native relations are heavily utilized with strict `onDelete: Cascade` and `onDelete: Restrict` rules (e.g., `Shop` to `User` relations). Orphan records are handled natively at the database level rather than application level.

## 9. Dead Database Objects
* **Severity: P2 (Medium)**
* **Root Cause**: The migration folder contains a baseline migration but the `schema.prisma` contains drifted enums (`DriftStatus`, `InventoryAlertType`) which do not appear to be utilized anywhere in the application logic outside of type assertions.

## 10. Production Readiness Score
**Score: 0/100**
*(The database layer is fundamentally compromised. The `RefreshToken` drift crashes the application on boot/auth, and the catastrophic failure of the `tenantOwnedModels` set means the system will freely leak data across distinct shops/tenants. Deploying this to production would result in immediate data breaches and downtime.)*

## 11. Prioritized Fix Order
1. **Fix Tenant Isolation (P0)**: Dynamically infer `tenantOwnedModels` via Prisma's `Prisma.dmmf` metadata to automatically protect EVERY model containing a `shopId` field, rather than using a hardcoded, outdated Set of 15 strings.
2. **Fix Schema Drift (P0)**: Restore the `RefreshToken` model to `schema.prisma` to match the baseline migration and repair the runtime `TypeError` crashing the backend.
3. **Fix Transaction Constraints (P1)**: Explicitly enforce `shopId` in all `deleteMany` and `updateMany` queries inside `$transaction` blocks, even if validated upstream.
4. **Optimize Thick Transactions (P2)**: Move synchronous calculation workloads (like `calculateFinancials`) *outside* of the `prisma.$transaction` block to minimize the duration the DB connection is held.
