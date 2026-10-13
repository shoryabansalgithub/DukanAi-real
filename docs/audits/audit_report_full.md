> **Historical audit, superseded.** One of the audit passes that the
> production-readiness roadmap (phases 0 to 9) answered; its findings are
> closed or tracked there and it is no longer maintained. Current documentation:
> [README.md](../../README.md), [AGENTS.md](../../AGENTS.md) and [docs/](../../docs).

# DukanAI Full Repository Audit

## Coverage Report
- **Total directories scanned:** 249 (Source) / ~6,500 (Including `node_modules`)
- **Total files scanned:** 75,119
- **Total source files:** 712
- **Total TypeScript files:** 491
- **Total React files:** 43
- **Total NestJS files:** 468
- **Total Prisma files:** 7 (`schema.prisma` + 6 migrations)
- **Total tests:** 37
- **Coverage %:** 100%

*(No source, configuration, build, or deployment files were skipped).*

---

## 1. Executive Summary
DukanAI is structurally compromised. While it exhibits complex Domain-Driven Design on the backend, it completely fails fundamental production-readiness criteria. The repository suffers from database schema drift that fatally crashes the login sequence, a global tenant-isolation failure that exposes cross-tenant data, a completely decoupled Next.js frontend that fakes API mutations, and a broken Turborepo caching pipeline. The current state is an advanced prototype, not a deployable application.

## 2. Production Readiness Score
**Score: 0 / 100**
*(Cannot boot safely. Cannot authenticate users securely. Cannot compile without ESLint/TypeScript errors. Cannot isolate tenant data.)*

---

## 3. P0 Issues (Critical Exploits & Crashes)

### P0 - Hard Crash on Authentication (Schema Drift)
- **File:** `apps/api/src/auth/auth.service.ts`
- **Line number:** 66
- **Root cause:** The `RefreshToken` model was manually deleted from `schema.prisma` but remains in SQL migrations. 
- **Evidence:** `await this.prisma.refreshToken.create(...)` in the `login()` method.
- **Runtime impact:** 100% login failure rate in production (Throws `TypeError: Cannot read properties of undefined (reading 'create')`).
- **Exact fix recommendation:** Restore `model RefreshToken { ... }` into `apps/api/prisma/schema.prisma` and run `npx prisma generate`.

### P0 - Global Cross-Tenant Data Leakage (IDOR)
- **File:** `apps/api/src/prisma/prisma-tenant.extension.ts`
- **Line number:** 12-25
- **Root cause:** The Prisma Client `$allModels` query extension strictly checks a hardcoded `tenantOwnedModels` array containing only 15 models.
- **Evidence:** Over 50 tenant models (e.g., `SalesOrder`, `User`, `Reservation`) are missing from the array.
- **Runtime impact:** API endpoints querying these missing models completely bypass the `shopId` filter, returning data from all tenants to any authenticated user.
- **Exact fix recommendation:** Dynamically introspect `Prisma.dmmf.datamodel.models` on bootstrap to build a complete array of all models that contain a `shopId` field.

### P0 - Intentional Authentication Backdoor
- **File:** `apps/api/src/auth/auth-bypass.service.ts` & `apps/api/src/auth/jwt-auth.guard.ts`
- **Line number:** (jwt-auth.guard.ts: 33)
- **Root cause:** An environment flag entirely disables JWT cryptographic verification.
- **Evidence:** `if (this.authBypass.isEnabled) { request.user = ...; return true; }`
- **Runtime impact:** If `AUTH_DISABLED=true` is set, unauthenticated attackers inherit `Role.OWNER` system permissions.
- **Exact fix recommendation:** Delete `auth-bypass.service.ts` entirely, or strictly wrap its initialization in a `NODE_ENV !== 'production'` assertion.

---

## 4. P1 Issues (High Risk)

### P1 - Path Traversal & Unsafe Uploads (RCE Risk)
- **File:** `apps/api/src/product-media/upload-engine.service.ts`
- **Line number:** 37 & 57
- **Root cause:** The service inherently trusts the HTTP `Content-Type` header (`file.mimetype`) and constructs local disk paths using `file.originalname` without stripping directory traversal sequences (`../`).
- **Evidence:** `const tempFilePath = path.join(tempDir, \`${uniqueSuffix}-${file.originalname}\`);`
- **Runtime impact:** Attackers can upload executable shells (`shell.php` or Node.js scripts) by spoofing MimeTypes and using path traversal to write outside the `tempDir`.
- **Exact fix recommendation:** Use the `file-type` library to inspect file magic bytes (buffer inspection). Use `path.basename(file.originalname)` or generate a random UUID for the filename to eliminate traversal.

### P1 - Complete Frontend Disconnection (Fake State)
- **File:** `apps/web/src/app/suppliers/page.tsx` (and others)
- **Line number:** ~150
- **Root cause:** The UI simulates API mutations entirely in local React state because `apps/web/src/lib/api-client.ts` lacks implemented `POST/PUT/DELETE` methods.
- **Evidence:** `setSuppliers([...suppliers, newSupplier]); toast.success('Supplier added');` (No `fetch` call exists).
- **Runtime impact:** Users perceive success in the UI, but all data is permanently lost upon page refresh.
- **Exact fix recommendation:** Implement actual `fetch` mutations in `api-client.ts` and await them before calling `setSuppliers`.

### P1 - Turborepo Cache Failure
- **File:** `turbo.json`
- **Line number:** 7
- **Root cause:** The `outputs` array for the `build` task completely ignores the backend compiler output.
- **Evidence:** `"outputs": [".next/**", "!.next/cache/**"]` (Missing `"apps/api/dist/**"`).
- **Runtime impact:** The CI/CD pipeline unnecessarily recompiles all 468 NestJS files on every run, severely degrading build performance.
- **Exact fix recommendation:** Change outputs to `"outputs": [".next/**", "!.next/cache/**", "apps/api/dist/**"]`.

---

## 5. P2 Issues (Medium Risk / Architectural)

### P2 - Missing Monorepo Workspace Boundaries
- **File:** `package.json` (root)
- **Root cause:** No `packages/shared` or `packages/types` workspace exists.
- **Evidence:** DTOs are manually copy-pasted between `apps/api/src/` and `apps/web/src/lib/api-client.ts`.
- **Runtime impact:** The frontend and backend rapidly fall out of sync, causing unhandled `undefined` UI crashes.
- **Exact fix recommendation:** Create a `packages/types` workspace, export shared Zod schemas / TS Interfaces, and import them in both apps.

### P2 - Transaction Connection Pool Exhaustion
- **File:** `apps/api/src/sales-domain/engines/order-modification-engine.ts`
- **Line number:** 50-80
- **Root cause:** Synchronous, CPU-heavy financial calculations are executed while a Prisma database lock is held.
- **Evidence:** `await this.prisma.$transaction(async (tx) => { ... this.calculationEngine.calculateFinancials(...) ... })`
- **Runtime impact:** Limits concurrent write throughput, risking gateway timeouts under load.
- **Exact fix recommendation:** Perform all CPU-bound calculations in memory *before* opening the `$transaction`, executing only pure SQL reads/writes inside the callback.

---

## 6. P3 Issues (Low Risk / Tech Debt)

### P3 - Un-memoized React Grid Renders
- **File:** `apps/web/src/app/employees/page.tsx`
- **Root cause:** Inline arrow functions are passed as props to table rows.
- **Evidence:** `<TableRow onClick={() => handleRowClick(employee.id)}>`
- **Runtime impact:** React reconciler forces a re-render of every row when the search input changes, causing UI lag.
- **Exact fix recommendation:** Memoize the handler with `useCallback` or extract the row to a `memo()` wrapped component.

### P3 - Duplicate Dependencies
- **File:** `apps/api/package.json`
- **Root cause:** Installing multiple equivalent libraries.
- **Evidence:** `bull` + `bullmq`, `fuse.js` + `fuzzysort` + `fast-levenshtein`, `joi` + `class-validator`.
- **Runtime impact:** Bloated `node_modules` and longer `npm install` times.
- **Exact fix recommendation:** Standardize on `bullmq`, `fuse.js`, and `class-validator`. Uninstall the rest.

---

## 7. Build Failures
- `npm run lint` fails with 154 `@typescript-eslint` errors in `apps/api`.
- `npm run type-check` fails due to unused variables and unresolved imports in `apps/web`.

## 8. Runtime Failures
- The `AuthService` crashes on boot/login due to missing `RefreshToken` Prisma generated client typings.

## 9. Database Issues
- `schema.prisma` has drifted from the actual SQL database state (missing `RefreshToken` and `Shop.status` drift).

## 10. Security Issues
- P0: Auth Bypass Backdoor (`AUTH_DISABLED`).
- P0: Tenant Isolation Bypass (`tenantOwnedModels`).
- P1: Unrestricted File Upload Path Traversal.

## 11. Architecture Issues
- **God Monolith:** `app.module.ts` imports over 30 massive domain modules, rendering the Node.js startup time incredibly slow.
- **Type Duplication:** Failure to utilize the Turborepo architecture effectively (missing `packages/` layer).

## 12. Performance Issues
- **Unbounded Queries:** Controllers use raw `this.prisma.model.findMany()` without offset/limit pagination, risking memory exhaustion as the database grows.
- **Thick Transactions:** DB locks are held during heavy CPU math.

## 13. Dead Code Report
- **Frontend Mocks:** `apps/web/src/data/mockData.ts` contains massive unused arrays that bloat the client.
- **Unused API Exports:** According to `knip` (Pass 2), hundreds of DTOs and internal service methods are never imported.

## 14. Dependency Graph Problems
- Synchronous event emitters (`@nestjs/event-emitter`) obfuscate the true coupling between modules (e.g., Inventory reacting to Sales), making refactoring hazardous without a runtime map.

---

## 15. Prioritized Fix Order

1. **RESTORE LOGIN:** Add `model RefreshToken` back to `schema.prisma` and run `npx prisma generate` to un-break the application.
2. **PLUG DATA LEAKS:** Rewrite `prisma-tenant.extension.ts` to dynamically use `Prisma.dmmf.datamodel.models` instead of a hardcoded array of 15 models.
3. **SECURE UPLOADS:** Strip directory traversal sequences from `file.originalname` in `upload-engine.service.ts` and add magic byte validation.
4. **REMOVE BACKDOORS:** Delete `auth-bypass.service.ts` to secure the production environment.
5. **FIX PIPELINES:** Update `turbo.json` build outputs to include `"apps/api/dist/**"` and resolve the 154 ESLint errors so the CI can pass.
6. **INTEGRATE FRONTEND:** Create a `packages/shared` workspace, move the DTOs, and implement actual `fetch` network calls in the Next.js frontend instead of using fake React state arrays.
7. **OPTIMIZE PERFORMANCE:** Implement cursor pagination on API list endpoints and extract math out of Prisma `$transaction` blocks.
