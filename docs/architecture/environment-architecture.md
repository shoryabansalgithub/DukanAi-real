# DukanAI Enterprise Environment Architecture

> **Document ID:** ENV-1 | **Version:** 1.0 | **Status:** Active
> **Owner:** Platform Team | **Classification:** Internal
> **Last Updated:** 2026-07-13

---

## Table of Contents

1. [Environment Hierarchy](#1-environment-hierarchy)
2. [Loading Order & Precedence](#2-loading-order--precedence)
3. [Configuration Domains](#3-configuration-domains)
4. [Variable Classification Matrix](#4-variable-classification-matrix)
5. [Git Strategy](#5-git-strategy)
6. [Developer Onboarding](#6-developer-onboarding)
7. [Naming Conventions](#7-naming-conventions)
8. [Configuration Standards](#8-configuration-standards)
9. [Security Rules](#9-security-rules)
10. [ENV-2 Readiness Plan](#10-env-2-readiness-plan)

---

## 1. Environment Hierarchy

### 1.1 File Structure

```
DukanAI/
├── apps/
│   ├── api/
│   │   ├── .env.example          # ✅ Committed — onboarding contract
│   │   ├── .env.local            # 🔒 Ignored  — developer secrets
│   │   ├── .env                  # 🔒 Ignored  — base defaults (legacy)
│   │   ├── .env.development      # 🔒 Ignored  — dev-specific overrides
│   │   ├── .env.test             # 🔒 Ignored  — test-specific overrides
│   │   └── .env.production       # 🔒 Ignored  — production values
│   └── web/
│       ├── .env.example          # ✅ Committed — onboarding contract
│       ├── .env.local            # 🔒 Ignored  — developer secrets
│       └── ...                   # (same hierarchy as api)
├── .gitignore                    # Enforces ✅/🔒 rules
└── turbo.json                    # Env-aware build cache invalidation
```

### 1.2 File Responsibilities

| File | Committed | Purpose | Contains Secrets |
|------|-----------|---------|-----------------|
| `.env.example` | **Yes** | Onboarding template with safe placeholders | Never |
| `.env.local` | **No** | Developer-specific secrets and overrides | Yes |
| `.env` | **No** | Base defaults (legacy backward compatibility) | May contain |
| `.env.development` | **No** | Development-specific config | May contain |
| `.env.test` | **No** | Test suite configuration | May contain |
| `.env.staging` | **No** | Staging environment config | May contain |
| `.env.production` | **No** | Production values (prefer vault/CI secrets) | Yes |

### 1.3 Configuration Ownership

| Configuration Source | Owner | Lifecycle |
|---------------------|-------|-----------|
| `.env.example` | Platform Team | Updated with every new variable |
| `.env.local` | Individual Developer | Managed locally, never shared |
| `.env.{environment}` | DevOps / SRE Team | Managed per deployment target |
| CI/CD env vars | DevOps / SRE Team | Managed in CI platform (GitHub Actions, etc.) |
| Cloud secrets manager | Security Team | Managed in Vault/AWS Secrets Manager/GCP Secret Manager |

---

## 2. Loading Order & Precedence

### 2.1 NestJS API (apps/api)

NestJS `ConfigModule` loads files in the order specified by `envFilePath`. **First-defined wins** — if a variable exists in `.env.local`, the value from `.env` is ignored.

```
Precedence (highest → lowest):

┌─────────────────────────────────┐
│ 1. System environment variables │ ← Set by CI/CD, Docker, cloud platform
├─────────────────────────────────┤
│ 2. .env.local                   │ ← Developer-specific secrets
├─────────────────────────────────┤
│ 3. .env.{NODE_ENV}              │ ← Environment-specific overrides
├─────────────────────────────────┤
│ 4. .env                         │ ← Base defaults (backward compatible)
├─────────────────────────────────┤
│ 5. Code-level defaults          │ ← Hardcoded fallbacks in source
└─────────────────────────────────┘
```

**Implementation** (`app.module.ts`):
```typescript
ConfigModule.forRoot({
  isGlobal: true,
  envFilePath: [
    '.env.local',
    `.env.${process.env.NODE_ENV || 'development'}`,
    '.env',
  ],
  // ...
});
```

### 2.2 Next.js Web (apps/web)

Next.js has **built-in** env file loading with the same precedence:
```
.env.local > .env.{NODE_ENV}.local > .env.{NODE_ENV} > .env
```

No additional configuration needed — Next.js handles this natively.

### 2.3 Per-Environment Loading

| Environment | Variables Come From |
|-------------|-------------------|
| **Local Dev** | `.env.local` > `.env.development` > `.env` |
| **Testing** | `.env.local` > `.env.test` > `.env` |
| **CI/CD** | Shell env vars > `.env.test` > `.env` |
| **Staging** | Shell env vars > `.env.staging` > `.env` |
| **Production** | Shell env vars (vault-injected) > `.env.production` > `.env` |

### 2.4 Fail-Fast Behavior

The Joi validation schema in `app.module.ts` enforces **fail-fast startup**:
- All variables marked `.required()` must be present
- `abortEarly: false` reports **all** missing variables simultaneously
- Application refuses to start with clear error messages

```
Error: Config validation error:
  "DATABASE_URL" is required
  "JWT_SECRET" is required
  "FRONTEND_URL" is required
```

---

## 3. Configuration Domains

Every configuration variable belongs to exactly one domain:

### 3.1 Application

| Variable | App | Default | Description |
|----------|-----|---------|-------------|
| `NODE_ENV` | API | `development` | Runtime environment |
| `PORT` | API | `3002` | HTTP server port |
| `FRONTEND_URL` | API | — | CORS allowed origins |
| `NEXT_PUBLIC_API_URL` | Web | `http://localhost:3002/api` | API base URL |
| `NEXTAUTH_URL` | Web | `http://localhost:3000` | NextAuth canonical URL |

### 3.2 Database (Prisma)

| Variable | App | Default | Description |
|----------|-----|---------|-------------|
| `DATABASE_URL` | API | — | MySQL connection string |

**Dependencies:** Prisma schema `datasource db`, PrismaService, all modules.
**Requirements:** MySQL 8.0+, user with CREATE/DROP TRIGGER privileges.

### 3.3 Authentication

| Variable | App | Default | Description |
|----------|-----|---------|-------------|
| `JWT_SECRET` | API | — | Access token signing key |
| `JWT_EXPIRES_IN` | API | `1d` | Access token lifetime |
| `JWT_REFRESH_SECRET` | API | — | Refresh token signing key |
| `JWT_REFRESH_EXPIRES_IN` | API | `7d` | Refresh token lifetime |
| `NEXTAUTH_SECRET` | Web | — | NextAuth session encryption |

### 3.4 Redis / BullMQ

| Variable | App | Default | Description |
|----------|-----|---------|-------------|
| `REDIS_URL` | API | — | Redis connection URL |

**Consumers:** CacheModule, BullModule (27 queues), CronLockService, SalesRedisBroadcaster.
**Degradation:** App runs without Redis in degraded mode (in-memory cache, local locks).

### 3.5 Storage (Local)

| Variable | App | Default | Description |
|----------|-----|---------|-------------|
| `STORAGE_ROOT` | API | `{cwd}/data/storage` | Local file storage root |

### 3.6 Storage (Cloud/S3)

| Variable | App | Default | Description |
|----------|-----|---------|-------------|
| `S3_REGION` | API | `auto` | AWS region |
| `S3_ENDPOINT` | API | — | S3-compatible endpoint |
| `S3_ACCESS_KEY` | API | — | AWS access key ID |
| `S3_SECRET_KEY` | API | — | AWS secret access key |
| `S3_BUCKET` | API | — | Target bucket name |
| `S3_PUBLIC_URL` | API | — | CDN URL for assets |

### 3.7 AI / OCR

| Variable | App | Default | Description |
|----------|-----|---------|-------------|
| `GEMINI_API_KEY` | API | — | Google Gemini API key |

### 3.8 OAuth

| Variable | App | Default | Description |
|----------|-----|---------|-------------|
| `GOOGLE_CLIENT_ID` | Web | — | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Web | — | Google OAuth client secret |

### 3.9 Reserved Domains (ENV-2)

The following domains are reserved for future use. Variables must not be added without updating this document.

| Domain | Status | Planned Variables |
|--------|--------|-------------------|
| Email (SMTP) | Not started | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` |
| SMS | Not started | `SMS_PROVIDER`, `SMS_API_KEY`, `SMS_SENDER_ID` |
| WhatsApp | Not started | `WHATSAPP_API_URL`, `WHATSAPP_API_KEY` |
| Payments | Not started | `PAYMENT_PROVIDER`, `PAYMENT_API_KEY`, `PAYMENT_SECRET` |
| Monitoring | Not started | `SENTRY_DSN`, `DATADOG_API_KEY` |
| Logging | Not started | `LOG_LEVEL`, `LOG_FORMAT` |
| Feature Flags | Not started | `FEATURE_FLAGS_PROVIDER`, `FEATURE_FLAGS_KEY` |

---

## 4. Variable Classification Matrix

### 4.1 Classification Levels

| Level | Definition | Exposure Rules |
|-------|-----------|----------------|
| **Public** | Non-sensitive, can appear in client bundles | May appear in logs, browser, docs |
| **Internal** | Not secret but internal-facing | May appear in server logs, not in client bundles |
| **Sensitive** | API keys with limited blast radius | Never in logs, never in client, rotate on exposure |
| **Critical** | Signing keys, DB creds, encryption keys | Never in logs, never in client, immediate rotation on exposure, SOC 2 audit trail |

### 4.2 Complete Matrix

| Variable | Domain | Classification | Required | Default | App |
|----------|--------|---------------|----------|---------|-----|
| `NODE_ENV` | Application | Public | No | `development` | API |
| `PORT` | Application | Public | No | `3002` | API |
| `FRONTEND_URL` | Application | Public | Yes | — | API |
| `DATABASE_URL` | Database | **Critical** | Yes | — | API |
| `JWT_SECRET` | Authentication | **Critical** | Yes | — | API |
| `JWT_EXPIRES_IN` | Authentication | Internal | Yes | `1d` | API |
| `JWT_REFRESH_SECRET` | Authentication | **Critical** | Yes | — | API |
| `JWT_REFRESH_EXPIRES_IN` | Authentication | Internal | Yes | `7d` | API |
| `REDIS_URL` | Redis/BullMQ | **Sensitive** | No | — | API |
| `STORAGE_ROOT` | Storage | Internal | No | `{cwd}/data/storage` | API |
| `S3_REGION` | Storage (Cloud) | Internal | No | `auto` | API |
| `S3_ENDPOINT` | Storage (Cloud) | Internal | No | — | API |
| `S3_ACCESS_KEY` | Storage (Cloud) | **Sensitive** | No | — | API |
| `S3_SECRET_KEY` | Storage (Cloud) | **Critical** | No | — | API |
| `S3_BUCKET` | Storage (Cloud) | Internal | No | — | API |
| `S3_PUBLIC_URL` | Storage (Cloud) | Public | No | — | API |
| `GEMINI_API_KEY` | AI/OCR | **Sensitive** | No | — | API |
| `NEXT_PUBLIC_API_URL` | Application | Public | No | `http://localhost:3002/api` | Web |
| `NEXTAUTH_SECRET` | Authentication | **Critical** | Yes | — | Web |
| `NEXTAUTH_URL` | Application | Public | No | `http://localhost:3000` | Web |
| `GOOGLE_CLIENT_ID` | OAuth | **Sensitive** | No | — | Web |
| `GOOGLE_CLIENT_SECRET` | OAuth | **Critical** | No | — | Web |

---

## 5. Git Strategy

### 5.1 Commit Rules

| File Pattern | Git Status | Rationale |
|-------------|-----------|-----------|
| `.env.example` | **TRACKED** | Onboarding contract, no secrets |
| `.env` | **IGNORED** | May contain secrets |
| `.env.local` | **IGNORED** | Always contains secrets |
| `.env.*.local` | **IGNORED** | Developer-specific overrides |
| `.env.development` | **IGNORED** | May contain secrets |
| `.env.test` | **IGNORED** | May contain test credentials |
| `.env.staging` | **IGNORED** | Contains staging secrets |
| `.env.production` | **IGNORED** | Contains production secrets |

### 5.2 Gitignore Implementation

```gitignore
# Environment — secret-containing files (NEVER committed)
.env
.env.local
.env.*.local
.env.development
.env.test
.env.staging
.env.production

# Environment — onboarding templates (ALWAYS committed)
!.env.example
```

### 5.3 Pre-Commit Protection

For additional safety, teams should consider adding a pre-commit hook (future ENV-2 scope):
```bash
# Reject commits containing common secret patterns
git diff --cached --name-only | grep -E '\.env$|\.env\.local$|\.env\.(development|test|staging|production)$'
```

---

## 6. Developer Onboarding

### 6.1 Quick Start (4 Steps)

```bash
# Step 1: Clone the repository
git clone <repository-url> && cd DukanAi

# Step 2: Install dependencies
npm install

# Step 3: Create environment files from templates
cp apps/api/.env.example apps/api/.env.local
cp apps/web/.env.example apps/web/.env.local

# Step 4: Edit .env.local files — fill values marked [REQUIRED]
# Then start developing:
npm run dev
```

### 6.2 Required Variables Checklist

**API (`apps/api/.env.local`):**
- [ ] `DATABASE_URL` — Your local MySQL connection string
- [ ] `JWT_SECRET` — Run `openssl rand -hex 32`
- [ ] `JWT_REFRESH_SECRET` — Run `openssl rand -hex 32` (different from JWT_SECRET)
- [ ] `FRONTEND_URL` — Usually `http://localhost:3000`

**Web (`apps/web/.env.local`):**
- [ ] `NEXTAUTH_SECRET` — Run `openssl rand -hex 32`

### 6.3 Optional Services

| Service | Variable | Impact If Missing |
|---------|----------|-------------------|
| Redis | `REDIS_URL` | In-memory cache, no distributed locks, BullMQ queues disabled |
| S3 | `S3_*` | Cloud upload returns error, local storage still works |
| Gemini AI | `GEMINI_API_KEY` | OCR endpoints return error |
| Google OAuth | `GOOGLE_CLIENT_*` | Google sign-in disabled, email/password still works |

---

## 7. Naming Conventions

### 7.1 Variable Naming Standard

```
{DOMAIN}_{PROPERTY}[_{QUALIFIER}]
```

| Component | Description | Examples |
|-----------|-------------|----------|
| `DOMAIN` | Service or subsystem | `JWT`, `S3`, `REDIS`, `SMTP` |
| `PROPERTY` | Configuration property | `SECRET`, `URL`, `REGION`, `PORT` |
| `QUALIFIER` | Optional disambiguator | `EXPIRES_IN`, `ACCESS_KEY`, `PUBLIC_URL` |

### 7.2 Rules

1. **ALL_UPPERCASE** with underscores
2. **No hyphens** — use underscores exclusively
3. **Prefix with domain** — `JWT_SECRET` not `SECRET`
4. **Boolean values** — use `true` / `false` (lowercase)
5. **Duration values** — use `ms` library format (`1d`, `12h`, `30m`)
6. **URL values** — include protocol (`http://`, `redis://`)
7. **Next.js browser vars** — must use `NEXT_PUBLIC_` prefix
8. **No abbreviations** — `DATABASE_URL` not `DB_URL` (exception: well-known acronyms like `JWT`, `S3`, `SMTP`)

### 7.3 Anti-Patterns

| ❌ Don't | ✅ Do | Reason |
|----------|-------|--------|
| `db_url` | `DATABASE_URL` | Uppercase convention |
| `jwt-secret` | `JWT_SECRET` | No hyphens |
| `SECRET` | `JWT_SECRET` | Missing domain prefix |
| `NEXT_PUBLIC_JWT_SECRET` | `JWT_SECRET` | Never expose secrets to browser |
| `API_KEY` | `GEMINI_API_KEY` | Ambiguous without domain |

---

## 8. Configuration Standards

### 8.1 12-Factor App Compliance

| Factor | Implementation |
|--------|---------------|
| **III. Config** | All config stored in environment variables, not in code |
| **X. Dev/prod parity** | Same env var names across all environments |
| **XI. Logs** | Secrets never appear in log output |

### 8.2 Configuration Lifecycle

#### Adding a New Variable

1. Add to `.env.example` with documentation comment, security classification, and safe placeholder
2. Add Joi validation rule in `app.module.ts` (required or optional)
3. Update this document's Classification Matrix (§4.2)
4. Update the relevant Configuration Domain section (§3.x)
5. Access via `ConfigService.get()` or `ConfigService.getOrThrow()` — never `process.env`

#### Deprecating a Variable

1. Add `# [DEPRECATED] Reason. Will be removed in vX.Y` comment in `.env.example`
2. Log warning on startup if deprecated variable is still set
3. Remove after one release cycle

#### Rotating a Secret

1. Generate new value: `openssl rand -hex 32`
2. Update in deployment target (vault, CI secrets, `.env.local`)
3. For JWT secrets: all existing tokens become invalid (users must re-authenticate)
4. For database: update MySQL user password + `DATABASE_URL` simultaneously

### 8.3 Access Patterns

| Pattern | When to Use |
|---------|------------|
| `configService.getOrThrow('KEY')` | For **required** variables — fails fast |
| `configService.get('KEY')` | For **optional** variables — returns undefined |
| `configService.get('KEY', 'default')` | For optional variables with fallback |
| ~~`process.env.KEY`~~ | **AVOID** — bypasses validation, not type-safe |

---

## 9. Security Rules

### 9.1 Secret Exposure Prevention

Secrets classified as **Sensitive** or **Critical** must NEVER appear in:

| Location | Prevention Mechanism |
|----------|---------------------|
| Git history | `.gitignore` blocks all secret files |
| Application logs | `CorrelationLogger` does not log env vars |
| Exception messages | `GlobalExceptionFilter` strips internal details |
| Console output | Startup logs print port/URL only, never secrets |
| API responses | NestJS response DTOs control serialization |
| Client bundles | Only `NEXT_PUBLIC_*` vars are bundled |
| `.env.example` | Contains only `CHANGE_ME` placeholders |
| README/docs | Use `*****` or `<your-value>` for examples |
| Swagger UI | Disabled in production (`NODE_ENV=production`) |

### 9.2 Compliance Mapping

| Standard | Relevant Controls | ENV-1 Implementation |
|----------|------------------|---------------------|
| **OWASP** | A02:2021 Cryptographic Failures | Secrets never committed, minimum key length enforced |
| **SOC 2** | CC6.1 Logical Access Controls | Environment-specific secrets, rotation procedures |
| **ISO 27001** | A.9.4.3 Password Management | Placeholder values in templates, rotation guide |
| **12-Factor** | Factor III: Config | All config via env vars, not code |
| **AWS Well-Architected** | SEC02-BP02 | Secrets in env vars, not source code |

### 9.3 NEXT_PUBLIC_ Safety Rules

Next.js bundles any variable prefixed with `NEXT_PUBLIC_` into the **client-side JavaScript bundle**, making it visible to any user.

**ALLOWED as NEXT_PUBLIC_:**
- API URLs
- Feature flags
- Analytics IDs
- CDN URLs

**NEVER as NEXT_PUBLIC_:**
- Secrets (`NEXTAUTH_SECRET`)
- API keys (`GOOGLE_CLIENT_SECRET`)
- Database credentials
- JWT signing keys

---

## 10. ENV-2 Readiness Plan

ENV-1 establishes the file structure and documentation. ENV-2 will add runtime type safety.

### 10.1 Planned Architecture

```typescript
// Future: src/config/configuration.ts
export const configuration = () => ({
  app: {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT, 10) || 3002,
    frontendUrl: process.env.FRONTEND_URL,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },
  redis: {
    url: process.env.REDIS_URL,
  },
  // ... all domains
});
```

### 10.2 Planned Features

| Feature | Description | Dependency |
|---------|-------------|------------|
| Typed ConfigService | `configService.get('jwt.secret')` with TypeScript autocomplete | NestJS ConfigModule namespaces |
| Zod validation | Replace Joi with Zod for shared validation between API/Web | Zod already in web package |
| Startup health check | Verify database, Redis connectivity at boot | ConfigModule `validate` function |
| Secret masking | Auto-redact Sensitive/Critical vars in all log output | Custom Logger integration |
| Config diff tool | CLI to compare `.env.example` vs `.env.local` for missing vars | Custom script |

### 10.3 Migration Path

ENV-2 will be **additive** — it wraps the existing Joi validation without replacing it:

1. Add `src/config/configuration.ts` with typed factory
2. Add `src/config/env.validation.ts` with Zod schema
3. Register namespaced config in `ConfigModule.forRoot({ load: [configuration] })`
4. Gradually migrate `configService.get('JWT_SECRET')` → `configService.get('jwt.secret')`
5. Remove Joi dependency after full migration

---

## Appendix A: Architecture Decision Record

**Decision:** Use `.env.local` as the primary developer secret file instead of `.env`.

**Context:** The existing codebase uses `.env` which was accidentally committed with real secrets. NestJS ConfigModule and Next.js both natively support `.env.local` with higher precedence than `.env`.

**Rationale:**
1. `.env.local` is a well-established convention (Next.js, Create React App, Vite)
2. The `.gitignore` already blocked `.env.local` before this change
3. `.env` remains as a backward-compatible fallback
4. No code changes needed in the web app (Next.js handles natively)

**Status:** Accepted.

---

## Appendix B: BullMQ Queue Registry

All 27 queues depend on `REDIS_URL` via `BullModule.forRootAsync()`:

| Queue Name | Module | Purpose |
|-----------|--------|---------|
| `system-events` | OutboxModule | System event relay |
| `customer-queue` | CustomersModule | Customer async operations |
| `media-processing` | ProductMediaModule | Image/video processing |
| `search-indexing` | ProductSearchModule | Search index updates |
| `product-validation` | ProductValidationModule | Product data validation |
| `webhook-delivery` | ProductEventsModule | Webhook dispatch |
| `import-job` | ImportExportModule | CSV/Excel import |
| `analytics-aggregation-queue` | AnalyticsDomainModule | Analytics rollups |
| `analytics-export-queue` | AnalyticsDomainModule | Analytics exports |
| `sales-workflow-queue` | SalesDomainModule | Sales order workflow |
| `sales-order-bulk-queue` | SalesDomainModule | Bulk order processing |
| `pricing-scheduler-queue` | PricingDomainModule | Scheduled price changes |
| `invoice-pdf-queue` | InvoiceDomainModule | PDF generation |
| `payment-reconciliation-queue` | PaymentDomainModule | Payment reconciliation |
| `return-inspection-queue` | ReturnsDomainModule | Return quality inspection |
| `return-refund-queue` | ReturnsDomainModule | Refund processing |
| `sales-events` | SalesEventsDomainModule | Sales event routing |
| `sales-webhooks` | SalesEventsDomainModule | Sales webhook dispatch |
| `purchase-attachments` | PurchaseDomainModule | Purchase file processing |
| `grn-jobs` | GrnDomainModule | Goods receipt processing |
| `vendor-bills` | VendorBillDomainModule | Vendor bill processing |
| `purchase-returns` | PurchaseReturnDomainModule | Purchase return processing |
| `supplier-credits` | SupplierCreditDomainModule | Supplier credit notes |
| `workflow-engine` | ProcurementWorkflowDomainModule | Procurement workflows |
| `purchase-analytics` | PurchaseAnalyticsDomainModule | Purchase analytics |
| `purchase-events` | PurchaseEventsDomainModule | Purchase event routing |
