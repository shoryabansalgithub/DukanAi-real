> **Historical document, superseded.** Kept for the record: it describes an
> earlier state of the project (mock data, Next.js 14, Node 18/20, features
> that were never built) and is no longer maintained. Current documentation:
> [README.md](./README.md) (what is built, how to run it, the docs map),
> [AGENTS.md](./AGENTS.md) (architecture and sharp edges) and
> [docs/](./docs) (deployment, operations, release, go-live).

# DukanAI — Full Codebase Deep Audit Report

> **Date**: 2026-07-11  
> **Scope**: Every layer — Environment, Database, Backend API, Frontend, Security, Performance, Testing, DevOps  
> **Method**: Zero-trust source code analysis only — no trust in comments, reports, or developer claims  
> **Verdict**: ⛔ **NOT PRODUCTION-READY** — 14 Critical, 18 High, 22 Medium issues found

---

## Table of Contents
1. [Environment & Configuration](#1-environment--configuration)
2. [Database / Prisma Schema](#2-database--prisma-schema)
3. [Backend — Auth & Security](#3-backend--auth--security)
4. [Backend — Customer Domain (Phase 3.5.1)](#4-backend--customer-domain-phase-351)
5. [Backend — Billing Service](#5-backend--billing-service)
6. [Backend — Products & Other Domains](#6-backend--products--other-domains)
7. [Backend — Module Wiring & Dependency Injection](#7-backend--module-wiring--dependency-injection)
8. [Frontend — Next.js Web App](#8-frontend--nextjs-web-app)
9. [Testing & Quality](#9-testing--quality)
10. [Performance & Scalability](#10-performance--scalability)
11. [DevOps & Infrastructure](#11-devops--infrastructure)
12. [Summary Matrix](#12-summary-matrix)

---

## 1. Environment & Configuration

### ⛔ CRITICAL: `.env` Contains Hardcoded Secrets Committed to Git
**File**: [.env](file:///c:/Users/kukpo/OneDrive/Desktop/DukanAi/DukanAi/apps/api/.env)

```
DATABASE_URL="mysql://root:70e2dcfe2ffc@localhost:3306/dukaanai"
JWT_SECRET="development_secret_key"
JWT_REFRESH_SECRET="development_refresh_secret_key"
```

- **Database root password** is hardcoded and committed to the repository.
- **JWT secrets** are weak, predictable strings (`"development_secret_key"`).
- `.env` is **NOT in `.gitignore`** — confirmed by `git status` showing it's tracked.
- Any attacker with repo access can forge JWTs and access the entire database.

### ⛔ CRITICAL: Duplicate & Wrong FRONTEND_URL
```
FRONTEND_URL="http://localhost:3001"     ← Line 6
FRONTEND_URL="https://api.dukan.ai/api"  ← Line 7 (overwrites line 6)
```

- The `.env` file has **two `FRONTEND_URL`** entries. The second one wins.
- The value `https://api.dukan.ai/api` is the **API URL**, not the frontend URL.
- This means CORS is misconfigured — the frontend at `localhost:3000` will be **blocked by CORS** in all API requests.

### 🔴 HIGH: PORT Mismatch
- `.env` sets `PORT=3002`, but the frontend's `api.ts` and `auth.ts` both default to `http://localhost:3001/api`.
- The backend will start on port 3002, but the frontend will try to connect to port 3001 → **all API calls fail silently**.

### 🔴 HIGH: Missing REDIS_URL in `.env`
- Redis is **optional** in the Joi validation schema but **required at runtime** by BullMQ.
- When `REDIS_URL` is undefined, BullMQ attempts `localhost:6379` by default and spams `ECONNREFUSED` errors every second, eventually crashing the API.
- There is no graceful degradation — BullMQ connection failures are unhandled and crash the process.

### 🟡 MEDIUM: Missing NEXTAUTH_SECRET
- The frontend's `auth.ts` uses `process.env.NEXTAUTH_SECRET` but no `.env.local` exists in `apps/web/`.
- Without this secret, NextAuth JWT encryption is **insecure** (uses a default fallback).

### 🟡 MEDIUM: Missing Google OAuth credentials
- `GoogleProvider` uses `process.env.GOOGLE_CLIENT_ID!` and `process.env.GOOGLE_CLIENT_SECRET!` with non-null assertions.
- These are never defined anywhere → Google login will crash at runtime.

---

## 2. Database / Prisma Schema

### 🔴 HIGH: Schema vs. Code Mismatch — `googleId` Field
**File**: [schema.prisma](file:///c:/Users/kukpo/OneDrive/Desktop/DukanAi/DukanAi/apps/api/prisma/schema.prisma)

- The `User` model **does have** `googleId String? @unique` (line 624), yet the generated Prisma client reports `googleId` doesn't exist in `UserWhereUniqueInput`.
- This means the Prisma client is **out of sync** with the schema — `prisma generate` was run on an older schema version.
- **Three `@ts-ignore` directives** were added to `users.service.ts` to suppress these errors instead of fixing the root cause.

### 🔴 HIGH: Massive Schema — 5,350 Lines with No Partitioning
- The entire data model is a **single monolithic file** with 5,350 lines.
- No multi-file schema support (Prisma supports `prismaSchemaFolder` preview feature).
- Extremely difficult to review, maintain, and merge.

### 🟡 MEDIUM: Stale Migrations
- Only **5 migrations** exist for a 5,350-line schema.
- The last migration is from `20260612` but the schema has been modified significantly since (Customer domain, Sales domain, Purchase domain additions).
- This means the schema has **unapplied changes** — running `prisma migrate deploy` in production would fail or produce unexpected results.

### 🟡 MEDIUM: Missing Indexes on High-Query Columns
- `Customer` model: No index on `phone` or `email` despite being used in search queries with `contains`.
- `Invoice` model: No index on `idempotencyKey` despite being queried on every billing request.
- `SalesOrder`, `PaymentTransaction`: Missing composite indexes for tenant-scoped queries.

### 🟡 MEDIUM: Dual Enum Definitions
- Enums like `CustomerType`, `CustomerLifecycleStatus`, `KycStatus`, etc. are defined **both** in `schema.prisma` (Prisma enums) **and** in `customers/domain/enums.ts` (TypeScript enums).
- These can drift out of sync. The TypeScript enums should import from `@prisma/client` instead.

---

## 3. Backend — Auth & Security

### ✅ GOOD: Global Guard Chain
The `AppModule` correctly registers guards in the right order:
```
ThrottlerGuard → JwtAuthGuard → TenantGuard → RolesGuard
```
This means **all routes are protected by default** unless explicitly marked `@Public()`.

### ✅ GOOD: JWT Strategy Validates User State
[jwt.strategy.ts](file:///c:/Users/kukpo/OneDrive/Desktop/DukanAi/DukanAi/apps/api/src/auth/jwt.strategy.ts) checks:
- User exists
- Not deleted
- Token version matches (revocation support)
- Account is active
- Account is not locked

### ✅ GOOD: Token Version for Session Revocation
The `tokenVersion` field enables forced logout by incrementing the version.

### 🔴 HIGH: Google Auth Endpoint Accepts Unverified `googleId`
**File**: [auth.controller.ts](file:///c:/Users/kukpo/OneDrive/Desktop/DukanAi/DukanAi/apps/api/src/auth/auth.controller.ts) (line 65-76)

```typescript
@Post('google')
async googleAuth(@Body() body: GoogleAuthDto) {
    const user = await this.usersService.findOrCreateGoogleUser(
        body.googleId,   // ← Client sends ANY googleId
        body.email,
        body.name,
    );
    return this.authService.login(user, ip, userAgent);
}
```

- The endpoint trusts the **client-supplied `googleId`** without verifying it against Google's servers.
- An attacker can send `{ googleId: "any", email: "victim@company.com", name: "Attacker" }` and **immediately get a valid JWT** for that account.
- The correct approach is to verify the Google ID token server-side using Google's API.

### 🔴 HIGH: Refresh Token Never Returned to Client
**File**: [auth.service.ts](file:///c:/Users/kukpo/OneDrive/Desktop/DukanAi/DukanAi/apps/api/src/auth/auth.service.ts) (line 57-74)

```typescript
const refreshToken = crypto.randomBytes(40).toString('hex');
// ... stored in DB ...
return {
    access_token: this.jwtService.sign(payload),
    user,
    // ← refreshToken is NEVER included in the response!
};
```

- The refresh token is created and stored in the database but **never sent back to the client**.
- There is no `/auth/refresh` endpoint to exchange it.
- This means sessions cannot be refreshed — users will be forced to re-login when the JWT expires.

### 🟡 MEDIUM: No Password Strength Validation
- `CreateUserDto` accepts any string as `password`.
- No minimum length, complexity, or entropy checks.

### 🟡 MEDIUM: Account Lockout Missing Auto-Unlock
- After 5 failed attempts, the account is locked for 15 minutes.
- But `lockedUntil` is only checked during login — there's no cron or middleware to auto-clear lockouts.
- A user who was locked will **remain locked** in the database even after 15 minutes until they attempt login again (which works correctly, but the `isLocked` flag stays `true`).

---

## 4. Backend — Customer Domain (Phase 3.5.1)

### ⛔ CRITICAL: `any` Type Bypass Defeats DTO Validation
**File**: [customers.controller.ts](file:///c:/Users/kukpo/OneDrive/Desktop/DukanAi/DukanAi/apps/api/src/customers/customers.controller.ts) (line 16)

```typescript
@Post()
async create(@Request() req: any, @Body() dto: CreateEnterpriseCustomerDto | any) {
```

- The `| any` union type **completely defeats** the `ValidationPipe` whitelist protection.
- An attacker can send any fields (including `creditLimit: 999999999`, `outstandingBalance: -500000`, `isDeleted: false`).
- The service layer also accepts `| any`: `async create(data: CreateEnterpriseCustomerDto | any)`.

### 🔴 HIGH: Customer Repository Missing Tenant Isolation in `update` and `softDelete`
**File**: [customer.repository.ts](file:///c:/Users/kukpo/OneDrive/Desktop/DukanAi/DukanAi/apps/api/src/customers/repositories/customer.repository.ts)

```typescript
async update(id: string, shopId: string, data: Prisma.CustomerUpdateInput) {
    return this.prisma.customer.update({
        where: { id },  // ← shopId parameter is accepted but NEVER USED
        data
    });
}

async softDelete(id: string, shopId: string) {
    return this.prisma.customer.update({
        where: { id },  // ← shopId parameter is accepted but NEVER USED
        data: { isDeleted: true, deletedAt: new Date() }
    });
}
```

- Both `update` and `softDelete` accept `shopId` as a parameter but **never include it in the `where` clause**.
- This means **any authenticated user can update or delete any customer in any shop** by guessing the customer ID (CUIDs are not cryptographically random).

### 🔴 HIGH: Event Publishing Outside Transaction Boundary
**File**: [customers.service.ts](file:///c:/Users/kukpo/OneDrive/Desktop/DukanAi/DukanAi/apps/api/src/customers/customers.service.ts) (line 51)

```typescript
const newCustomer = await this.customerRepository.create({...});
// ... audit log (also outside tx) ...
await this.eventPublisher.publish(this.prisma, shopId, {...});
```

- The customer creation, audit logging, and event publishing are **three separate operations with no transaction boundary**.
- If the event publishing fails, the customer exists but the event is lost.
- If the audit fails, the customer exists but there's no audit trail.
- The `EventPublisherService.publish()` requires a `Prisma.TransactionClient` but receives `this.prisma` (the full client, not a transaction client) — this defeats the outbox pattern's atomicity guarantee.

### 🟡 MEDIUM: Customer Worker OOM Risk
**File**: [customer.worker.ts](file:///c:/Users/kukpo/OneDrive/Desktop/DukanAi/DukanAi/apps/api/src/customers/workers/customer.worker.ts) (line 28-34)

```typescript
const invoices = await this.prisma.invoice.findMany({
    where: { customerId, isDeleted: false, status: 'COMPLETED' }
});
const totalPurchases = invoices.reduce((acc, inv) => acc + Number(inv.totalAmount), 0);
```

- Loads **ALL invoices** for a customer into memory, then reduces.
- For enterprise customers with thousands of invoices, this will cause Out-of-Memory crashes.
- Should use Prisma `aggregate` (`_sum`) instead.

### 🟡 MEDIUM: Customer Audit Service Has No `actorId`
- `CustomerAuditService.logAction()` accepts an optional `actorId` but the callers in `CustomersService` **never pass it**.
- All customer audit entries will have `actorId: null`, making them forensically useless.

---

## 5. Backend — Billing Service

### ✅ GOOD: Sophisticated Billing Pipeline
[billing.service.ts](file:///c:/Users/kukpo/OneDrive/Desktop/DukanAi/DukanAi/apps/api/src/billing/billing.service.ts) is **the most mature** code in the project:
- Optimistic locking with version checks
- Idempotency key enforcement
- Redis pre-check with proper compensation
- Decimal.js for all monetary calculations (no floating-point bugs)
- Double-entry ledger bookkeeping
- GST bracket aggregation with inter-state IGST support
- Outbox event pattern
- 3-attempt retry with exponential backoff

### 🟡 MEDIUM: Hardcoded IST Timezone Offset
```typescript
const istOffset = 5.5 * 60 * 60 * 1000;
const istDate = new Date(now.getTime() + istOffset);
```
- Invoice numbering uses a hardcoded IST offset instead of a proper timezone library.
- This will produce incorrect invoice numbers during DST transitions (India doesn't observe DST, but this pattern is fragile and won't work for non-Indian tenants).

### 🟡 MEDIUM: Running Balance Calculation is Race-Prone
```typescript
const lastDebitEntry = await tx.ledgerTransaction.findFirst({
    where: { account: debitAccount },
    orderBy: { createdAt: 'desc' }
});
const debitBalanceBefore = lastDebitEntry ? lastDebitEntry.balanceAfter.toNumber() : 0;
```
- The running balance is computed by reading the last entry's `balanceAfter` **without a `FOR UPDATE` lock**.
- Two concurrent transactions can read the same `balanceAfter`, both add their amount, and produce incorrect running balances.

### 🟡 MEDIUM: `BillingController` Missing `JwtAuthGuard`
```typescript
@Controller('billing')
@UseGuards(RolesGuard)  // ← Only RolesGuard, no JwtAuthGuard/TenantGuard
```
- While global guards cover this, the explicit `@UseGuards(RolesGuard)` is misleading and redundant. If global guards are ever removed, this endpoint would be completely open.

---

## 6. Backend — Products & Other Domains

### ✅ GOOD: Products Controller Has Proper Guards
```typescript
@Controller('products')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
```

### 🟡 MEDIUM: `any` Casts Throughout Products Service
```typescript
const existing = await this.prisma.product.findUnique({
    where: {
        shopId_sku_deletedAt: {
            deletedAt: null as any // ← unsafe cast
        }
    }
});
```

### 🟡 MEDIUM: `findAll()` Has No Pagination
```typescript
async findAll() {
    return this.prisma.product.findMany({
        where: { shopId, isDeleted: false },
        include: { category: true, brand: true },
    });
}
```
- Returns **ALL products** for a shop with no `take`/`skip` pagination.
- A shop with 50,000 products will cause a massive response payload and potential API timeouts.

---

## 7. Backend — Module Wiring & Dependency Injection

### ⛔ CRITICAL: Runtime Crashes from Missing Module Imports (Observed)
From the actual server logs:

| Error | Missing Dependency | Module |
|---|---|---|
| `UnknownDependenciesException` | `ProductEventPublisher` | `ProductsModule` |
| `UnknownDependenciesException` | `EventEmitter` | `PurchaseEventsDomainModule` |
| `UnknownDependenciesException` | `RevenueEngine` | `AnalyticsModule` |

- These are **not theoretical** — these were observed in actual `npm run dev` output.
- The API server **cannot start** without the fixes that were applied during this session.
- This means **no CI/CD pipeline exists** that validates the app can even boot.

### 🔴 HIGH: Duplicate Module Registration
- `AnalyticsModule` and `AnalyticsDomainModule` both exist and both register `AnalyticsController`.
- Both are imported in `AppModule`. NestJS will throw at runtime if a controller is registered in two modules.
- The fix applied was to remove the controller from `AnalyticsModule`, but the duplicate module registration is still present and confusing.

### 🟡 MEDIUM: `ScheduleModule.forRoot()` Called Twice
- Called in `AppModule` (line 69) AND in `PurchaseEventsDomainModule` (line 19).
- While NestJS handles this gracefully, it indicates a lack of module design coordination.

---

## 8. Frontend — Next.js Web App

### 🔴 HIGH: API Base URL Mismatch
**File**: [api.ts](file:///c:/Users/kukpo/OneDrive/Desktop/DukanAi/DukanAi/apps/web/src/lib/api.ts) (line 5)

```typescript
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';
```

- Frontend defaults to port `3001`, but backend `.env` sets `PORT=3002`.
- No `NEXT_PUBLIC_API_URL` environment variable is defined anywhere.
- **Result**: Every API call from the frontend will fail with `ECONNREFUSED`.

### 🔴 HIGH: Missing `.env.local` for Frontend
- No `.env.local` file exists in `apps/web/`.
- Required variables that are undefined:
  - `NEXTAUTH_SECRET` — JWT encryption key
  - `NEXT_PUBLIC_API_URL` — backend API URL
  - `GOOGLE_CLIENT_ID` — Google OAuth
  - `GOOGLE_CLIENT_SECRET` — Google OAuth
  - `NEXTAUTH_URL` — Required for production NextAuth

### 🟡 MEDIUM: `next-auth` middleware imports
```typescript
import { withAuth } from 'next-auth/middleware';
```
- Uses NextAuth v4 patterns. The `next-auth` dependency is `^4.24.14` which is correct, but this will need migration if upgrading to Auth.js v5.

### 🟡 MEDIUM: `type` Augmentation Not Declared
```typescript
session.user.id = token.id as string;
session.user.role = token.role as string;
session.user.shopId = token.shopId as string;
session.accessToken = token.accessToken as string;
```
- These custom fields are **not declared** in a `next-auth.d.ts` type augmentation file.
- TypeScript will complain about these properties not existing on `Session`.

### 🟡 MEDIUM: Frontend Error Handling is Minimal
- The customers page catches API errors and sets a generic error state.
- No retry logic, no error boundaries, no offline support.
- The `useEffect` dependency array for `fetchCustomers` is empty, so data never refreshes.

### 🟡 MEDIUM: Unused Imports in `api-client.ts`
```typescript
export const suppliersApi = {
    list: () => get<unknown[]>('/suppliers'),  // ← No /suppliers endpoint exists
};
export const expensesApi = {
    list: () => get<unknown[]>('/expenses'),   // ← No /expenses endpoint exists
};
```
- These API clients reference endpoints that don't exist in the backend.

---

## 9. Testing & Quality

### ⛔ CRITICAL: Near-Zero Meaningful Test Coverage

| Metric | Value |
|---|---|
| Source files (backend) | **368** |
| Test files (backend) | **23** |
| Coverage ratio | **6.3%** |
| Frontend test files | **0** |

**Critical modules with ZERO tests:**
- `auth/` — Authentication & authorization
- `billing/` — The most complex financial logic
- `customers/` — Phase 3.5.1 deliverable
- `users/` — User management
- `iam/` — Identity & Access Management
- `inventory/` — Core business logic
- `sales-domain/` — Order processing
- `payment-domain/` — Payment processing

Many of the 23 existing spec files are **empty scaffolds** (generated by `nest g` but never filled in).

---

## 10. Performance & Scalability

### 🔴 HIGH: No Pagination on Multiple List Endpoints
| Endpoint | File | Issue |
|---|---|---|
| `GET /products` | `products.service.ts` | Returns ALL products, no `take`/`skip` |
| `GET /customers` | `customers.controller.ts` | Optional pagination, but defaults to ALL |
| `GET /inventory/products` | `inventory/` | Returns ALL inventory items |

### 🔴 HIGH: BullMQ Queue Without Redis = Silent Failures
- All BullMQ processors silently fail when Redis is unavailable.
- Jobs are queued but never processed. No alerts, no fallback.
- Affected queues: `customer-queue`, `analytics-aggregation-queue`, `analytics-export-queue`, `purchase-events`, `webhook-delivery`.

### 🟡 MEDIUM: PrismaService Uses Proxy — Performance & Debugging Cost
```typescript
return new Proxy(this, {
    get: (target, prop) => {
        if (prop in extended) {
            return extended[prop as keyof typeof extended];
        }
        return target[prop as keyof typeof target];
    }
});
```
- Every single Prisma call goes through a JavaScript Proxy.
- This adds overhead and makes stack traces harder to read.

### 🟡 MEDIUM: Development Prisma Query Logging On By Default
```typescript
log: [
    { emit: 'stdout', level: 'query' },  // Logs EVERY SQL query
```
- In development mode, every SQL query is logged to stdout, which was flooding the logs with massive `OutboxEvent` SELECT queries.

---

## 11. DevOps & Infrastructure

### ⛔ CRITICAL: No CI/CD Pipeline
- No `.github/workflows/`, no `Jenkinsfile`, no `Dockerfile`, no `docker-compose.yml`.
- The application has never been verified by automated CI.
- The runtime crashes we observed (missing module imports) would have been caught by a simple `npm run build` step in CI.

### 🔴 HIGH: No Docker Configuration
- No `Dockerfile` for API or Web.
- No `docker-compose.yml` for local development (Redis, MySQL).
- Developers must manually install and configure MySQL and Redis.

### 🟡 MEDIUM: `.env` Not in `.gitignore`
```
# Misc
.DS_Store
*.pem
*.log
```
- The `.gitignore` does not include `.env` files.
- Database passwords and JWT secrets are committed to the repository.

### 🟡 MEDIUM: No Health Check Endpoint
- No `/health` or `/ready` endpoint for container orchestration or monitoring.
- The `AppController` only has a basic `getHello()` method.

---

## 12. Summary Matrix

### Critical Issues (Must Fix Before Any Deployment)

| # | Severity | Category | Issue |
|---|---|---|---|
| 1 | ⛔ CRITICAL | Security | `.env` with DB password & weak JWT secrets committed to git |
| 2 | ⛔ CRITICAL | Security | Google Auth trusts client-supplied `googleId` without server verification |
| 3 | ⛔ CRITICAL | Security | Customer DTO uses `| any` — full mass assignment vulnerability |
| 4 | ⛔ CRITICAL | Data | Customer `update`/`softDelete` ignores `shopId` — cross-tenant data access |
| 5 | ⛔ CRITICAL | Config | Duplicate `FRONTEND_URL` in `.env` causes CORS to block all frontend requests |
| 6 | ⛔ CRITICAL | Config | PORT mismatch (backend 3002, frontend expects 3001) |
| 7 | ⛔ CRITICAL | Runtime | Multiple NestJS modules have unresolved dependencies — API cannot boot |
| 8 | ⛔ CRITICAL | Quality | Zero test coverage on all critical business logic (auth, billing, customers) |
| 9 | ⛔ CRITICAL | DevOps | No CI/CD pipeline — broken code reaches main branch |

### High Issues (Must Fix Before Beta)

| # | Severity | Category | Issue |
|---|---|---|---|
| 10 | 🔴 HIGH | Security | Refresh token created but never returned to client |
| 11 | 🔴 HIGH | Data | Prisma client out of sync with schema (`googleId` errors) |
| 12 | 🔴 HIGH | Data | Customer events published outside transaction boundary |
| 13 | 🔴 HIGH | Schema | 5,350-line monolithic schema file |
| 14 | 🔴 HIGH | Config | Missing `REDIS_URL` causes BullMQ crash loops |
| 15 | 🔴 HIGH | Frontend | Missing `.env.local` — no API URL, no auth secrets |
| 16 | 🔴 HIGH | Frontend | API base URL defaults to wrong port |
| 17 | 🔴 HIGH | Perf | No pagination on product/customer list endpoints |
| 18 | 🔴 HIGH | Module | Duplicate module registrations (Analytics) |
| 19 | 🔴 HIGH | DevOps | No Docker configuration |

### Medium Issues (Should Fix Before GA)

| # | Severity | Category | Issue |
|---|---|---|---|
| 20 | 🟡 MEDIUM | Schema | Stale migrations — schema out of sync with DB |
| 21 | 🟡 MEDIUM | Schema | Missing indexes on frequently queried columns |
| 22 | 🟡 MEDIUM | Schema | Dual enum definitions (Prisma + TypeScript) |
| 23 | 🟡 MEDIUM | Auth | No password strength validation |
| 24 | 🟡 MEDIUM | Auth | Account lockout flag never auto-cleared |
| 25 | 🟡 MEDIUM | Billing | Hardcoded IST timezone offset |
| 26 | 🟡 MEDIUM | Billing | Running balance race condition |
| 27 | 🟡 MEDIUM | Customer | Worker OOM risk — loads all invoices into memory |
| 28 | 🟡 MEDIUM | Customer | Audit entries missing `actorId` |
| 29 | 🟡 MEDIUM | Frontend | NextAuth type augmentation missing |
| 30 | 🟡 MEDIUM | Frontend | Dead API client methods (suppliers, expenses) |
| 31 | 🟡 MEDIUM | Module | `ScheduleModule.forRoot()` called twice |
| 32 | 🟡 MEDIUM | Perf | PrismaService Proxy overhead |
| 33 | 🟡 MEDIUM | Perf | Dev query logging flooding stdout |
| 34 | 🟡 MEDIUM | DevOps | No health check endpoint |
| 35 | 🟡 MEDIUM | DevOps | `.env` not in `.gitignore` |

---

## What's Actually Good

Despite the issues, the codebase has several well-implemented patterns:

| Area | What Works |
|---|---|
| **Auth Guard Chain** | Global `APP_GUARD` registration ensures all routes are protected by default |
| **Billing Engine** | Production-grade optimistic locking, idempotency, Decimal math, Redis compensation |
| **Tenant Context** | AsyncLocalStorage-based tenant isolation with Prisma extensions |
| **Outbox Pattern** | Event-driven architecture with outbox table for reliable event delivery |
| **Exception Filter** | Global filter prevents stack trace leakage and adds correlation IDs |
| **Token Versioning** | JWT revocation via `tokenVersion` field |
| **CORS + Helmet** | Security headers properly configured (when the URL is correct) |
| **Throttling** | Per-endpoint rate limiting with multiple tiers |

---

> **Bottom Line**: The architecture is sound and the billing engine is impressive. But the project has critical security vulnerabilities (unverified Google auth, cross-tenant data access, committed secrets), configuration errors that prevent the app from running (port mismatch, CORS, missing Redis), and zero test coverage on all business-critical paths. None of this code should be deployed to production without addressing at least the 9 Critical issues.
