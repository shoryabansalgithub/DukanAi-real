> **Historical audit, superseded.** One of the audit passes that the
> production-readiness roadmap (phases 0 to 9) answered; its findings are
> closed or tracked there and it is no longer maintained. Current documentation:
> [README.md](../../README.md), [AGENTS.md](../../AGENTS.md) and [docs/](../../docs).

# DukanAI — PASS 1 (Execution Audit)

## 1. Repository Inventory
- **Monorepo Structure**: Turborepo architecture.
- **Package Manager**: npm (evidenced by `package-lock.json`).
- **Apps**: `apps/api` (NestJS) and `apps/web` (Next.js).
- **Packages**: Missing (No `packages/*` directories exist).
- **Prisma Location**: `apps/api/prisma/schema.prisma`.
- **Config**: Root `turbo.json`, `package.json`, and individual `tsconfig.json` & `tsconfig.build.json` files per app.

## 2. Workspace Inventory
- `apps/api` (Dependencies: `@nestjs/*`, `prisma`, `bullmq`, `redis`).
- `apps/web` (Dependencies: `next`, `react`, `lucide-react`, `recharts`).

## 3. Dependency State
- **node_modules**: Present and successfully populated.
- **Package Manager Consistency**: Consistent `npm` usage, but redundant packages (e.g., both `bull` and `bullmq`) are installed.

## 4. Prisma Generation Status
**STATUS: SUCCESS**
- **Command executed**: `cd apps/api ; npx prisma generate`
- **Output**: 
  ```
  Environment variables loaded from .env
  Prisma schema loaded from prisma\schema.prisma
  ✔ Generated Prisma Client (v6.19.3) to .\node_modules\@prisma\client in 5.75s
  ```
- **Exit Code**: 0

## 5. TypeScript Status
**STATUS: SUCCESS**
- **Command executed**: `tsc --noEmit` (in both `apps/api` and `apps/web`)
- **Output**: No compiler errors emitted.
- **Exit Code**: 0 for both apps.

## 6. Build Status
**STATUS: PARTIAL SUCCESS**
- **Web Command**: `npm run build`
  - Output: Compiled successfully, generated 23 static pages. (Exit Code: 0)
- **API Command**: `npm run build` (runs `@nestjs/cli build`)
  - Output: Compiled successfully. (Exit Code: 0)
  - **Issue**: The build artifact for `main.js` was output directly to `dist/main.js` instead of `dist/src/main.js`. This occurs because `tsconfig.build.json` excludes the root files (`check-db.ts` and `setup-triggers.ts`), shrinking the TS `rootDir` from `./` to `./src`.

## 7. Boot Status
**STATUS: BLOCKED (API)**
- The NestJS boot sequence never begins because Node fails to locate the entry point.

## 8. Runtime Status
**STATUS: BLOCKED (API)**
- No providers, database connections, or Redis connections initialize because the process fails instantly before execution.

## 9. Production Startup Status
**API STATUS: FAIL**
- **Command executed**: `npm run start:prod` (in `apps/api`)
- **Output**:
  ```
  > node dist/src/main
  Error: Cannot find module '...\apps\api\dist\src\main'
  code: 'MODULE_NOT_FOUND'
  ```
- **Root Cause**: `package.json` defines `"start:prod": "node dist/src/main"`, but the build step outputted the file to `dist/main.js`.

**WEB STATUS: SUCCESS**
- **Command executed**: `npm run start` (in `apps/web`)
- **Output**: 
  ```
  ▲ Next.js 14.2.35
  - Local: http://localhost:3000
  ✓ Ready in 402ms
  ```

## 10. Test Status
**STATUS: BLOCKED / CRASHING**
- **Command executed**: `npm run test` (in `apps/api`)
- **Output**: Most tests log `PASS`, but the test suite is violently interrupted by `process.exit(1)` called from `src/config/validation/startup-validator.service.ts` failing validation asynchronously.

## 11. Verified Execution Blockers
### Blocker 1: API Production Startup Crash
- **Severity**: P0
- **Evidence**: `MODULE_NOT_FOUND` on `npm run start:prod`.
- **Runtime impact**: The backend container completely fails to start in production.
- **Root cause**: Misalignment between `tsconfig.build.json` excluding root files (modifying `rootDir`) and `package.json` expecting the old path.
- **Minimal recommended action**: Change `apps/api/package.json` `"start:prod"` script to `"node dist/main"`.

## 12. Exact Fix Order
1. Update `package.json` in `apps/api` to use `"start:prod": "node dist/main"`.
2. Mock environment variables inside `jest-e2e.json` or test setups to prevent `startup-validator.service.ts` from calling `process.exit(1)` during test execution.

## 13. Production Readiness Score
**Score: 0 / 100**
*(The API physically cannot boot in production due to a catastrophic path mismatch in the startup script).*
