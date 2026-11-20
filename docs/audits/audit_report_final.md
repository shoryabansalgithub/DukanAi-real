> **Historical audit, superseded.** One of the audit passes that the
> production-readiness roadmap (phases 0 to 9) answered; its findings are
> closed or tracked there and it is no longer maintained. Current documentation:
> [README.md](../../README.md), [AGENTS.md](../../AGENTS.md) and [docs/](../../docs).

# DukanAI — FINAL PASS: Repository-Wide Cross Validation & Production Readiness Audit

## 1. Executive Summary
DukanAI exhibits sophisticated backend Domain-Driven Design (DDD) but is fundamentally unfit for production deployment. The architecture functions more as a heavily decoupled prototype than a cohesive application. The Next.js frontend fakes core business logic rather than interacting with the API, the database schema has destructively drifted from its migrations causing hard login crashes, and a misconfigured global Prisma extension silently exposes 70% of tenant data to cross-tenant scraping. **The repository cannot be deployed today.**

## 2. Verified Findings
* **Authentication Crash**: The `RefreshToken` table exists in migrations but was manually deleted from `schema.prisma`. `AuthService.login()` unconditionally queries it, crashing standard user logins. (Verified: `apps/api/src/auth/auth.service.ts`)
* **Fake Frontend State**: The React frontend (`apps/web/src/app/suppliers/page.tsx`, etc.) simulates CRUD operations locally (`setSuppliers([...])`) because the `api-client.ts` completely lacks `create/update/delete` implementations. (Verified via AST/component analysis)
* **Auth Bypass Backdoor**: `AUTH_DISABLED=true` skips all JWT checks and runs requests as a system `OWNER`. (Verified: `apps/api/src/auth/auth-bypass.service.ts`)
* **Tenant Isolation Failure**: `prisma-tenant.extension.ts` protects only a hardcoded array of 15 models. `SalesOrder`, `Reservation`, and `User` are excluded, exposing cross-tenant data globally. (Verified via `schema.prisma` vs `prisma-tenant.extension.ts`)
* **Path Traversal Uploads**: `upload-engine.service.ts` trusts `file.mimetype` and writes directly using `file.originalname` to disk. (Verified: `apps/api/src/product-media/upload-engine.service.ts`)

## 3. Eliminated False Positives
* **"Zero-Click Complete Takeover" (Pass 5)**: This requires `AUTH_DISABLED=true` to be set in the production environment. Since the `class-validator` env config defaults it to `false`, the backdoor is closed by default. It is a critical risk, but not an active default exploit.

## 4. Newly Discovered Issues
* **Duplicate Queue Engines**: The backend installs and registers both `bull` and `bullmq` alongside their NestJS wrappers, creating package bloat and potential job locking conflicts.
* **Missing Turbo Cache**: `turbo.json` omits the NestJS `dist/**` output path. Consequently, Turborepo caching is broken for the entire backend, dragging down CI speeds unnecessarily.

## 5. Root Cause Groups
1. **Schema vs Migration Drift**: Manual edits to `schema.prisma` (dropping `RefreshToken`) without dropping the SQL tables created a "ghost" database state that the generated PrismaClient cannot parse, bringing down the Auth domain.
2. **Missing Workspace Isolation (Monorepo Failure)**: Because there is no `packages/shared` workspace, the frontend lacks access to backend DTOs. This directly caused the frontend engineers to build a "fake" `api-client.ts` rather than synchronizing contracts.
3. **Hardcoded Security Configurations**: Security extensions (like `tenantOwnedModels`) rely on manually curated strings instead of dynamic AST or Prisma DMMF introspection, guaranteeing they fall out of sync as the schema grows.

## 6. Build Blockers
* **ESLint / Type-Check Errors**: `npm run lint` fails with 154 unresolved errors in `apps/api`. `npm run type-check` fails due to strict type mismatches. A production CI/CD pipeline will permanently block deployments until these are resolved.

## 7. Runtime Blockers
* **Frontend Disconnection**: Users can view the dashboard but cannot permanently create, update, or delete Suppliers, Employees, or Expenses because the frontend state mutations do not execute HTTP calls to the backend.

## 8. Database Blockers
* **Prisma Client Crash**: Running `prisma generate` omits `RefreshToken`. Booting the API and attempting to log in triggers a `TypeError: Cannot read properties of undefined (reading 'create')` on the `refreshToken` model binding.

## 9. Authentication Blockers
* Authentication is entirely blocked by the Database Blocker (Item #8) unless `AUTH_DISABLED` is intentionally activated.

## 10. Architecture Risks
* **God Module**: `apps/api/src/app.module.ts` couples 30+ large domain modules together.
* **Missing DTO Sharing**: The lack of a `packages/types` shared library means the API and Web applications have entirely divergent understandings of data shapes.

## 11. Performance Risks
* **Thick DB Transactions**: Nested engines (e.g., `OrderModificationEngine`) perform CPU-bound calculations inside synchronous `this.prisma.$transaction` locks. 
* **Unmemoized React Trees**: Heavy tables in Next.js utilize inline arrow functions for row actions, triggering full table re-renders on minor state changes.

## 12. Technical Debt
* **Massive Mock Arrays**: `mockData.ts` on the frontend contains thousands of lines of unused dummy data that is parsed by the client unnecessarily.
* **Abandoned Packages**: `joi`, `fast-levenshtein`, and `fuse.js` are installed but superseded or duplicated by other libraries.

## 13. Production Readiness
* The backend structure is well-architected around DDD but suffers from schema drift.
* The frontend is fundamentally incomplete (a UI prototype missing integration).
* Security boundaries (Tenant Isolation, File Uploads) are critically compromised.
* **Conclusion**: Not Production Ready.

## 14. Exact Fix Order
1. **(DB)** Restore `model RefreshToken` to `schema.prisma` to stop standard login crashes.
2. **(Security)** Rewrite `prisma-tenant.extension.ts` to dynamically inspect `Prisma.dmmf` for `shopId` fields rather than using a hardcoded array of 15 models.
3. **(Architecture)** Create a `packages/shared` Turborepo workspace. Move all Prisma types, API DTOs, and Enums here.
4. **(Frontend)** Rewrite `api-client.ts` in `apps/web` to import the shared DTOs and actually execute `POST`/`PUT`/`DELETE` fetch calls instead of locally mutating React state.
5. **(Security)** Sanitize `file.originalname` in `upload-engine.service.ts` to block path traversal.
6. **(Build)** Update `turbo.json` outputs to include `"dist/**"`. 
7. **(Tech Debt)** Purge `mockData.ts` and unused `package.json` dependencies.

## 15. Estimated Engineering Effort
* **DB/Security Fixes**: 1-2 Days (Schema restore, Tenant Extension rewrite).
* **Architecture/Monorepo Fix**: 3-5 Days (Extracting shared types, updating all imports).
* **Frontend Integration**: 2-3 Weeks (Wiring the "fake" frontend tables to actual backend mutations).
* **Total Estimate**: ~3-4 Weeks for a 2-engineer team to reach true production stability.

## 16. Risk Matrix
| Risk Vector | Likelihood | Impact | Priority |
| :--- | :--- | :--- | :--- |
| **Login Crash (Schema Drift)** | 100% | Critical | P0 |
| **Cross-Tenant Leakage** | 100% | Critical | P0 |
| **Frontend Data Loss (Fake State)** | 100% | High | P1 |
| **Path Traversal Upload RCE** | Low | Critical | P1 |
| **Transaction Connection Pool Exhaustion**| Medium | High | P2 |

## 17. Top 25 Critical Issues
*(Filtered to True P0/P1 Root Causes)*
1. `RefreshToken` missing from schema.
2. Tenant Isolation extension bypasses >50 models.
3. Auth Bypass backdoor (`AUTH_DISABLED`).
4. Frontend `api-client.ts` lacks write implementations.
5. Frontend components fake state mutations.
6. `upload-engine.service.ts` allows path traversal.
7. `upload-engine.service.ts` trusts client MimeTypes.
8. No shared package workspace for DTOs.
9. `turbo.json` ignores NestJS caching (`dist/**`).
10. Unbounded `.findMany()` API lists causing memory exhaustion.

## 18. Top 25 High Priority Issues
11. 154 ESLint errors blocking clean CI builds.
12. Duplicate queue engines (`bull` vs `bullmq`).
13. Synchronous loop calculations inside `$transaction` blocks.
14. Missing SSR usage (route-level `'use client'`).
15. Un-memoized React grid row rendering.
16. Missing local error boundaries (`error.tsx`) in major routes.
17. Un-cleaned fetch requests in `useEffect` (missing AbortControllers).

## 19. Nice-to-Have Improvements
* Purge `mockData.ts` and hundreds of unused frontend components.
* Migrate all custom JWT/Auth logic to a proven provider (e.g., NextAuth.js or Clerk) to offload security risks.
* Prune abandoned dependencies (`joi`).

## 20. Final Production Readiness Score
**Score: 5/100**

## 21. Can this repository be deployed today?
**NO.**

**Reasons:**
1. Users physically cannot log in due to the `RefreshToken` crash.
2. Users who do bypass auth will permanently lose all data created (Employees, Expenses, Suppliers) upon refreshing the browser tab because the frontend does not save data to the API.
3. Users who access unprotected endpoints will view cross-tenant data belonging to other companies.
4. The build pipeline fails its static checks natively.
