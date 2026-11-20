> **Historical audit, superseded.** One of the audit passes that the
> production-readiness roadmap (phases 0 to 9) answered; its findings are
> closed or tracked there and it is no longer maintained. Current documentation:
> [README.md](../../README.md), [AGENTS.md](../../AGENTS.md) and [docs/](../../docs).

# DukanAI — Pass 1 Engineering Audit

## 1. Executive Summary
The repository successfully builds via `turbo run build` and boots in development mode (with bypasses). However, the repository **cannot boot in production and is not executable** as-is. Production startup is immediately blocked by invalid environment variables and an incorrect entrypoint path in `package.json`. Furthermore, a severe Prisma schema drift causes runtime crashes in the authentication flow because the `RefreshToken` model is referenced by the code but missing from the database schema.

## 2. Repository Statistics
* **Directories**: 8,986 (recursive, including `node_modules`), but tracked source structure is organized.
* **Total Tracked Files**: 619
* **TypeScript (TS)**: 491
* **React (TSX)**: 43
* **JavaScript (JS)**: 5
* **Prisma**: 1
* **JSON**: 17
* **Docker**: 0
* **CI**: 0
* **Tests**: 37

## 3. Build Status
**Status: PASS**
* `npm run build` executed successfully.
* `api` package built successfully via `npx @nestjs/cli build`.
* `dukaanai-web` package built successfully via `next build` (Generated 23/23 static pages).
* **Duration**: 1m 35s
* **Exit Code**: 0

## 4. Runtime Status
**Status: PASS (Development)**
* `npm run dev` successfully boots the Next.js frontend and NestJS API.
* Dependency injection, provider initialization, and global configuration registry load successfully in DEV mode.
* Connection to Redis and MySQL establishes successfully when using local development environment configurations.

## 5. Dependency Problems
**Status: FAIL (Moderate)**
* `check-db.ts` and `setup-triggers.ts` are excluded from the `nest build` output, resulting in a flattened `dist/main.js` structure instead of the intended `dist/src/main.js`. 
* No circular imports were detected causing fatal startup crashes in NestJS DI.

## 6. Environment Problems
**Status: FATAL (Blocker)**
* `apps/api/.env.production` is entirely populated with the string `___REPLACE_ME_IN_PRODUCTION___`.
* **Impact**: Critical configuration values (e.g., `PORT`, `PRISMA_SLOW_QUERY_THRESHOLD`, `JWT_EXPIRES_IN`) are injected as un-parseable strings, causing the strict `class-validator` rules in `EnterpriseConfigModule` to crash the app instantly.

## 7. Prisma Problems
**Status: FATAL (Blocker)**
* **Schema Drift**: The `schema.prisma` file is missing the `RefreshToken` model. 
* **Runtime Crash**: `auth.service.ts` attempts to call `this.prisma.refreshToken.findFirst()`, which throws `TypeError: this.prisma.refreshToken.findFirst is not a function` at runtime and in tests.
* Migrations are out of sync with the schema (e.g., missing `status` column on `Shop`).

## 8. TypeScript Problems
**Status: PASS**
* `npm run type-check` (running `tsc --noEmit`) completed with **0 errors**. 
* *Note: The missing `RefreshToken` Prisma model was not caught by the TS compiler, likely due to a loose Proxy type on the `PrismaService` which swallows the missing property error at compile time.*

## 9. Startup Problems
**Status: FATAL (Blocker)**
* **Command Failed**: `npm run start:prod`
* **Root Cause**: The API's `package.json` defines `start:prod` as `node dist/src/main`. However, the NestJS compiler outputs the entrypoint to `dist/main.js`. 
* **Exit Code**: 1 (`MODULE_NOT_FOUND`)

## 10. Production Problems
**Status: FATAL (Blocker)**
* **Command Failed**: `NODE_ENV=production node dist/main.js`
* **Root Cause**: Configuration validation fails immediately upon boot.
* **Error Output**: 
  `Fatal error during application startup: Error: Configuration validation failed for PrismaConfig: slowQueryThreshold must be a number conforming to the specified constraints`
* **Exit Code**: 1

## 11. Test Status
**Status: FAIL**
* **Suites**: 3 failed, 32 passed, 35 total
* **Tests**: 6 failed, 87 passed, 93 total
* **Failures**:
  1. `AuthService refresh-token rotation` crashes due to the missing `RefreshToken` Prisma model (`TypeError`).
  2. `ConfigurationRegistryService` and `StartupValidatorService` tests crash because they assert `process.exit(1)`, which forcefully exits the Jest test runner instead of being properly mocked/caught.

## 12. Prioritized Fix Order
1. **Fix Startup Path (P0)**: Update `start:prod` in `apps/api/package.json` to execute `node dist/main.js`.
2. **Fix Production Environment (P0)**: Replace `___REPLACE_ME_IN_PRODUCTION___` in `.env.production` with valid types (numbers, booleans, empty strings) so the application passes `EnterpriseConfigModule` validation.
3. **Fix Prisma Schema Drift (P1)**: Add the `RefreshToken` model to `schema.prisma` and generate migrations to prevent runtime `TypeError` in `AuthService`.
4. **Fix Test Mocks (P2)**: Properly mock `process.exit` in `startup-validator.service.spec.ts` and `configuration-registry.service.spec.ts` so they do not crash the Jest test suite.

## 13. Estimated Number Of Required Code Changes
**~15 files**
* 1 file (`package.json` script update)
* 1 file (`.env.production` values update)
* 1 file (`schema.prisma` model addition)
* 1-2 files (Prisma migration generation)
* ~10 files (Fixing `process.exit` test mocks)

## 14. Overall Production Readiness Score
**25/100**
*(The codebase compiles successfully and runs in local development, but critical misconfigurations and schema drifts completely block production deployment.)*
