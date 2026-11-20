# DukanAI Environment Architecture

> **Document ID:** ENV-1 | **Version:** 2.0 | **Status:** Active
> **Last Updated:** 2026-10-04 (roadmap 8.6: rewritten against the code; the
> 1.0 text described a Joi schema, a refresh secret, ignored env templates and
> 27 queues that no longer exist)

This document explains how configuration reaches the two applications. It
does not repeat the variable list: `apps/api/.env.example` documents every
variable the API reads with its default, `apps/web/.env.example` the web's,
and `apps/api/src/config/env-example.spec.ts` fails when either side of that
agreement breaks.

## 1. Files and what is committed

```
apps/api/
  .env.example        committed   every variable, documented, local defaults
  .env.development    committed   template read under NODE_ENV=development
  .env.test           committed   template read under NODE_ENV=test (CI, suites)
  .env.production     committed   template: real numeric defaults, ___REPLACE_ME___ secrets
  .env.local          ignored     developer secrets and overrides (highest file precedence)
  .env                ignored     legacy fallback, lowest precedence
apps/web/             the same five names; Next.js loads them natively
.env.example          committed   docker-compose variables (root)
```

The root `.gitignore` ignores `apps/*/.env*` and then un-ignores the four
templates ("ALWAYS COMMITTED"). The committed templates carry no real secret:
production values are placeholders that the API refuses to boot with
(`IsProductionSecret`, `IsUrlList`, `IsNotPlaceholder`,
`IsProductionAbsolutePath` in `src/config/validation/env-rules.ts`).
`scripts/check-tracked-artifacts.sh` (CI lint job) keeps runtime files out of
the tree.

## 2. Loading order (API)

`EnterpriseConfigModule` (`src/config/enterprise-config.module.ts`) configures
Nest's `ConfigModule` with

```ts
envFilePath: ['.env.local', ...(process.env.NODE_ENV ? [`.env.${process.env.NODE_ENV}`] : []), '.env']
```

so the precedence is: process environment (CI, Docker, the orchestrator) >
`.env.local` > `.env.<NODE_ENV>` > `.env` > the default on the config class.
`NODE_ENV` is required (`AppConfig` has no default): the `start*` scripts pin
it (`start:prod` to `production`), and a process that does not say which
environment it is refuses to boot rather than pick up the development
template. The web reads its files through Next.js with the same shape;
`NEXT_PUBLIC_*` values are inlined at build time.

## 3. Validation and fail-fast

There is no Joi schema. Configuration is a set of typed domain classes under
`src/config/domains/` (one `@ConfigDomain` class each, properties marked
`@EnvVariable('NAME')`), hydrated by `hydrateFromEnv`
(`src/config/hydrate-from-env.ts`) and validated with class-validator at
provider construction:

- only declared variables are copied; blank keeps the default; `0` is a
  value; a non-numeric or out-of-bounds value fails boot with the property
  named (`IntegerFromEnv`, `NumberFromEnv`, `BooleanFromEnv`,
  `IsCronExpression`);
- cross-domain rules run once at startup (`RuntimeValidationModule`:
  database URL present and not localhost in production, Redis URL shape, S3
  credentials complete when a bucket is set);
- every refusal throws (`StartupValidatorService`,
  `ConfigurationRegistryService`, the DTO-style validators), so the reason
  reaches `bootstrap().catch` in `src/main.ts`, which writes it to stderr
  with `fs.writeSync` before exiting 1. `test/boot-regression.e2e-spec.ts`
  boots `node dist/main` across the refusal matrix and asserts each message.

The 27 domains: `AppConfig`, `DatabaseConfig`, `JwtConfig`, `AuthConfig`,
`RedisConfig`, `StorageConfig`, `AiConfig`, `PrismaConfig`, `BullConfig`,
`CacheConfig`, `EmailConfig`, `MonitoringConfig`, `LoggingConfig`,
`SecurityConfig`, `CronConfig`, `RetentionConfig`, `UploadConfig` and the ten
feature domains under `domains/features/` (analytics, billing, events,
import-export, inventory, OCR, purchase, sales, search, validation). Every
provided domain declares at least one variable and every variable has a
consumer; the placeholder domains of the 1.0 design (SMS, WhatsApp, payments,
feature flags, …) were deleted in roadmap 8.5. Services inject the domain
class, never `ConfigService` or `process.env` (the only direct reads are in
the config module itself and the `NODE_ENV` checks).

## 4. Secrets

| Variable | Rule |
|---|---|
| `JWT_SECRET` | 32+ characters, no placeholder under `NODE_ENV=production`; HS256 only. There is no `JWT_REFRESH_SECRET`: refresh tokens are opaque, stored hashed, rotated on use. |
| `NEXTAUTH_SECRET` | 32+ characters on a running production web server (`apps/web/src/config/env.ts`). |
| `DATABASE_URL`, `REDIS_URL`, `SMTP_URL` | carry credentials; percent-encode them. |
| `S3_SECRET_KEY`, `GEMINI_API_KEY`, `GOOGLE_CLIENT_SECRET`, `METRICS_TOKEN`, `SENTRY_DSN` | optional integrations; a placeholder value is refused where the rule exists (`SENTRY_DSN`, `METRICS_TOKEN`). |

`CorrelationLogger` redacts sensitive keys in every log line; the exception
filter never echoes configuration; only `NEXT_PUBLIC_*` variables reach the
browser bundle, so a secret must never carry that prefix. Rotating
`JWT_SECRET` ends every session; rotating the database password means
updating the MySQL user and `DATABASE_URL` together.

## 5. Adding, changing or removing a variable

1. Put the property on the owning domain class (or a new domain that has a
   consumer) with its validator and `@EnvVariable`.
2. Document it in `apps/api/.env.example` with a comment and its default;
   add the production value to `.env.production` when the default is not
   safe there.
3. Read it through the injected domain class.
4. Removing: delete the property and the line from every template. A
   variable nothing reads fails `env-example.spec.ts`, as does an
   undocumented one or an empty domain.

Naming: `DOMAIN_PROPERTY[_QUALIFIER]`, upper case, underscores; durations
carry their unit in the name (`*_MS`, `*_SECONDS`, `*_DAYS`) except the JWT
lifetimes, which use `ms`-library strings (`15m`, `7d`).

## 6. Developer onboarding

```bash
npm install                                   # Node 22 (.nvmrc)
cp apps/api/.env.example apps/api/.env.local  # DATABASE_URL, REDIS_URL, JWT_SECRET
cp apps/web/.env.example apps/web/.env.local  # NEXTAUTH_SECRET
cd apps/api && npx prisma migrate deploy && npm run start:dev   # http://localhost:3002/api
cd apps/web && npm run dev                                      # http://localhost:3010
```

The committed `.env.development` templates supply every other default;
`.env.local` only needs the values that differ on your machine. The
integration suites read `.env.test` and take `TEST_DATABASE_URL` /
`TEST_REDIS_URL` from the shell (`AGENTS.md`, "POS / billing architecture").

## Appendix: BullMQ queues

Every queue has exactly one producer and one worker in the same module;
`QueueWiringAssertion` refuses to boot otherwise and
`src/common/queues/queue-wiring.spec.ts` walks the import graph. The 1.0
registry listed 27 queues; 19 of them had no consumer or belonged to the
detached stacks and were removed in roadmap 4.5–4.7.

| Queue | Module | Work |
|---|---|---|
| `system-events` | `OutboxModule` | POS/billing outbox rows (invoice, return, cancellation, repayment events): cache invalidation, low-stock notifications, idempotent per event id |
| `webhook-delivery` | `ProductEventsModule` | signed webhook delivery for product events |
| `purchase-events` | `PurchaseEventsDomainModule` | purchase outbox rows (orders, receipts, returns, bills, credit notes) |
| `purchase-analytics` | `PurchaseAnalyticsDomainModule` | purchase analytics rollups |
| `import-job` | `ImportExportModule` | CSV / JSON product imports |
| `media-processing` | `ProductMediaModule` | image processing for product media |
| `search-indexing` | `ProductSearchModule` | search index updates |
| `product-validation` | `ProductValidationModule` | product data validation runs |

All connections come from `bullConnectionFromUrl(REDIS_URL)`; job defaults
are `BULL_*`. Every worker runs its job under a tenant context
(`src/iam/tenant-context/job-context.ts`).
