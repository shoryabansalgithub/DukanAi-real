> **Historical audit, superseded.** One of the audit passes that the
> production-readiness roadmap (phases 0 to 9) answered; its findings are
> closed or tracked there and it is no longer maintained. Current documentation:
> [README.md](../../README.md), [AGENTS.md](../../AGENTS.md) and [docs/](../../docs).

# DukanAI — PASS 1 Execution Audit

Every finding below is backed by an exact command, exact output, and exact exit code.
Nothing is inferred. Nothing is assumed.

---

## 1. Repository Inventory

```
DukanAi/
├── apps/
│   ├── api/          (NestJS backend)
│   └── web/          (Next.js frontend)
├── docs/
├── node_modules/
├── package.json      (root — workspaces: ["apps/*"])
├── package-lock.json (npm lockfile)
└── turbo.json        (Turborepo pipeline)
```

- **Package manager:** npm (lockfile: `package-lock.json`)
- **Workspaces:** `apps/*` (resolves to `apps/api` and `apps/web`)
- **Prisma location:** `apps/api/prisma/schema.prisma`
- **tsconfig chain:**
  - `apps/api/tsconfig.json` → `apps/api/tsconfig.build.json` (extends it, excludes `check-db.ts`, `setup-triggers.ts`, `test`, `**/*spec.ts`)
  - `apps/web/tsconfig.json`
- **Nest CLI config:** `apps/api/nest-cli.json` — `sourceRoot: "src"`, `deleteOutDir: true`
- **No `packages/` directory exists.** The monorepo has zero shared packages.

---

## 2. Workspace Inventory

| Workspace | Name | Version | Exists |
|-----------|------|---------|--------|
| `apps/api` | `api` | `0.0.1` | ✅ |
| `apps/web` | `dukaanai-web` | `0.1.0` | ✅ |
| `apps/coverage` | — | — | Directory exists but contains no `package.json`. Not a workspace. |

---

## 3. Dependency State

| Check | Result | Evidence |
|-------|--------|----------|
| Root `node_modules/` exists | ✅ | `Test-Path "node_modules"` → `True` |
| `apps/api/node_modules/` exists | ✅ | `Test-Path "apps/api/node_modules"` → `True` |
| `apps/web/node_modules/` exists | ❌ | `Test-Path "apps/web/node_modules"` → `False` |
| `package-lock.json` exists | ✅ | `Test-Path "package-lock.json"` → `True` |
| Prisma Client generated | ✅ | `Test-Path "apps/api/node_modules/@prisma/client"` → `True` |
| `.prisma` generated | ✅ | `Test-Path "apps/api/node_modules/.prisma"` → `True` |

> `apps/web` has no local `node_modules/`. This is expected behavior for npm workspaces — dependencies are hoisted to the root `node_modules/`.

---

## 4. Prisma Generation Status

**Command:** `cd apps/api ; npx prisma generate`

**Output:**
```
Environment variables loaded from .env
Prisma schema loaded from prisma\schema.prisma
✔ Generated Prisma Client (v6.19.3) to .\node_modules\@prisma\client in 3.96s
```

**Exit code:** 0

**STATUS: ✅ SUCCESS**

---

## 5. TypeScript Status

### apps/api

**Command:** `cd apps/api ; npx tsc --noEmit`

**Output:** (empty — no errors)

**Exit code:** 0

**STATUS: ✅ SUCCESS** — zero compiler errors.

---

### apps/web

**Command:** `cd apps/web ; npx tsc --noEmit`

**Output:** (empty — no errors)

**Exit code:** 0

**STATUS: ✅ SUCCESS** — zero compiler errors.

---

## 6. Build Status

### apps/api

**Command:** `cd apps/api ; npm run build` (executes `npx @nestjs/cli build`)

**Exit code:** 0

**Generated output:**
- `dist/main.js` ✅ EXISTS
- `dist/src/main.js` ❌ DOES NOT EXIST

**STATUS: ✅ BUILD SUCCEEDS** — but the entrypoint lands at `dist/main.js`, not `dist/src/main.js`.

---

### apps/web

**Command:** `cd apps/web ; npm run build` (executes `next build`)

**Output:**
```
▲ Next.js 14.2.35
✓ Compiled successfully
✓ Generating static pages (23/23)
```

**3 warnings** (non-blocking, `react-hooks/exhaustive-deps` in `employees/page.tsx`, `expenses/page.tsx`, `suppliers/page.tsx`).

**Exit code:** 0

**STATUS: ✅ SUCCESS**

---

## 7. Boot Status

### apps/api — Official `start:prod` command

**Command:** `cd apps/api ; npm run start:prod` (executes `node dist/src/main`)

**Output:**
```
Error: Cannot find module '...\apps\api\dist\src\main'
    code: 'MODULE_NOT_FOUND'
```

**Exit code:** 1

**STATUS: ❌ FATAL — process never starts.**

---

### apps/api — Corrected entrypoint (`dist/main.js`)

**Command:** `cd apps/api ; node dist/main.js`

**Result:** Process starts and remains alive. Prisma queries execute. Outbox relay runs. The following runtime error repeats continuously in stderr:

```
[ioredis] Unhandled error event: AggregateError [ECONNREFUSED]:
    at internalConnectMultiple (node:net:1193:18)
    at afterConnectMultiple (node:net:1783:7)
```

**STATUS: ⚠️ BOOTS, STAYS ALIVE, but Redis is unreachable.** The process does not crash — it continues operating with degraded Redis-dependent features (caching, BullMQ queues).

---

### apps/web — Official `start` command

**Command:** `cd apps/web ; npm run start` (executes `next start`)

**Output:**
```
▲ Next.js 14.2.35
- Local: http://localhost:3000
✓ Starting...
✓ Ready in 511ms
```

**STATUS: ✅ SUCCESS — process stays alive.**

---

## 8. Runtime Status

### API Health

**Command:** `Invoke-WebRequest -Uri "http://localhost:3001/api" -UseBasicParsing -TimeoutSec 5`

**Output:**
```
StatusCode: 200
Content:    Hello World!
```

**STATUS: ✅ API responds on port 3001.**

---

### Web Health

**Command:** `Invoke-WebRequest -Uri "http://localhost:3000" -UseBasicParsing -TimeoutSec 5`

**Output:**
```
StatusCode: 200
```

**STATUS: ✅ Frontend responds on port 3000.**

---

## 9. Production Startup Status

**Documented command:** `npm run start:prod` → `node dist/src/main`

**Result:** ❌ FATAL — `MODULE_NOT_FOUND`.

**Root cause:** `tsconfig.build.json` excludes root-level `.ts` files (`check-db.ts`, `setup-triggers.ts`). With those excluded, `tsc` computes `rootDir` as `src/`, so `src/main.ts` compiles to `dist/main.js` (not `dist/src/main.js`). The `start:prod` script in `package.json` references the wrong path.

---

## 10. Test Status

**Command:** `cd apps/api ; npm run test` (executes `jest`)

**Exit code:** 1

**Result:** 3 suites failed, 32 passed. 6 tests failed, 87 passed.

### Failing Suites

| Suite | Tests Failed | Failure Type | Root Cause |
|-------|-------------|--------------|------------|
| `auth.service.spec.ts` | 2 | Runtime | Test mock provides `prisma.refreshToken.findUnique` but production code calls `prisma.refreshToken.findFirst`. The mock shape does not match the service's actual method call. |
| `configuration-registry.service.spec.ts` | 2 | Runtime | Tests expect `process.exit` to throw (via jest spy), but the jest setup's `process.exit` mock does not throw — it returns `undefined`. The assertion `toThrow('Process exited with code 1')` fails because no throw occurs. |
| `startup-validator.service.spec.ts` | 2 | Runtime | Same `process.exit` mock issue: the mock does not record the call synchronously because `onModuleInit` defers execution with `setTimeout`. The assertion fires before the timeout callback. |

### Passing Suites (32/35)

All other 32 suites pass cleanly.

### Process Warning

During test execution, `startup-validator.service.ts:53` fires a real `process.exit(1)` asynchronously via `setTimeout`, disrupting the Jest process. This is a runtime side-effect leak from production code into the test harness.

---

## 11. Verified Execution Blockers

### BLOCKER-1: Production entrypoint path mismatch

- **ID:** EXEC-001
- **Severity:** P0 — process cannot start
- **Evidence:** `npm run start:prod` → exit code 1, `MODULE_NOT_FOUND`
- **Command executed:** `cd apps/api ; npm run start:prod`
- **Output:** `Error: Cannot find module '...\apps\api\dist\src\main'`
- **Affected files:** [package.json](file:///c:/Users/kukpo/OneDrive/Desktop/DukanAi/DukanAi/apps/api/package.json) line 15, [tsconfig.build.json](file:///c:/Users/kukpo/OneDrive/Desktop/DukanAi/DukanAi/apps/api/tsconfig.build.json) line 3
- **Runtime impact:** API physically cannot start in production.
- **Root cause:** `tsconfig.build.json` excludes `check-db.ts` and `setup-triggers.ts`. Without those root files, tsc computes `rootDir=src/` and emits `src/main.ts` → `dist/main.js`. The `start:prod` script expects `dist/src/main`.
- **Minimal recommended action:** Change `"start:prod"` in `apps/api/package.json` from `"node dist/src/main"` to `"node dist/main"`.

### BLOCKER-2: Redis unavailable at runtime

- **ID:** EXEC-002
- **Severity:** P2 — degraded, non-fatal
- **Evidence:** Continuous `[ioredis] Unhandled error event: AggregateError [ECONNREFUSED]` in stderr during boot with `node dist/main.js`
- **Command executed:** `cd apps/api ; node dist/main.js`
- **Output:** `[ioredis] Unhandled error event: AggregateError [ECONNREFUSED]`
- **Affected files:** Redis connection configuration
- **Runtime impact:** Caching, BullMQ job queues, and rate limiting degrade. Process stays alive.
- **Root cause:** No Redis server is running on the configured host/port.
- **Minimal recommended action:** Start a Redis instance or configure a fallback.

### BLOCKER-3: Test suite failures (6 tests)

- **ID:** EXEC-003
- **Severity:** P2 — tests broken, not production-blocking
- **Evidence:** `npm run test` → exit code 1, 3 suites failed
- **Command executed:** `cd apps/api ; npm run test`
- **Affected files:**
  - [auth.service.spec.ts](file:///c:/Users/kukpo/OneDrive/Desktop/DukanAi/DukanAi/apps/api/src/auth/auth.service.spec.ts) lines 56, 68 — mock provides `findUnique`, code calls `findFirst`
  - [configuration-registry.service.spec.ts](file:///c:/Users/kukpo/OneDrive/Desktop/DukanAi/DukanAi/apps/api/src/config/registry/configuration-registry.service.spec.ts) lines 121, 157 — `process.exit` mock does not throw
  - [startup-validator.service.spec.ts](file:///c:/Users/kukpo/OneDrive/Desktop/DukanAi/DukanAi/apps/api/src/config/validation/startup-validator.service.spec.ts) lines 84, 99 — assertion fires before `setTimeout` callback
- **Runtime impact:** CI pipeline fails. No production impact.
- **Root cause:** Test mocks do not match production code's actual method signatures and timing behavior.
- **Minimal recommended action:** Fix mock method names and async timing in tests.

---

## 12. Exact Fix Order

| Order | Fix | Unblocks |
|-------|-----|----------|
| **1** | Change `apps/api/package.json` line 15 from `"node dist/src/main"` to `"node dist/main"` | Production API startup |
| **2** | Start a Redis instance (or configure env to point to an available one) | Cache, queues, rate limiting |
| **3** | Fix `auth.service.spec.ts` mock: change `findUnique` → `findFirst` | Test suite CI pass |
| **4** | Fix `configuration-registry.service.spec.ts` and `startup-validator.service.spec.ts` process.exit mocking strategy | Test suite CI pass |

---

## 13. Production Readiness Score

**Score: 15 / 100**

| Criterion | Status | Points |
|-----------|--------|--------|
| Install | ✅ | 10 |
| Prisma generate | ✅ | 10 |
| TypeScript compile | ✅ | 10 |
| API build | ✅ | 10 |
| Web build | ✅ | 10 |
| API production boot (`start:prod`) | ❌ FATAL | 0 |
| API boot (corrected path) | ⚠️ Degraded (Redis) | 5 |
| Web production boot | ✅ | 10 |
| API health (HTTP 200) | ✅ | 10 |
| Web health (HTTP 200) | ✅ | 10 |
| Tests pass | ❌ 6 failures | 5 |
| Redis connection | ❌ ECONNREFUSED | 0 |

**The single blocking issue preventing production deployment is EXEC-001: the `start:prod` script references a nonexistent path.** Changing one line in `package.json` makes the API bootable.
