# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Build and run sharp edges (apps/api)

- `nest build` uses `tsconfig.build.json` (`include: ["src/**/*"]`), so the
  entrypoint compiles to `dist/main.js` and `start:prod` is `node dist/main`.
  If the root-level `check-db.ts` / `setup-triggers.ts` ever get pulled into
  the build, tsc widens rootDir and the output moves to `dist/src/main.js`;
  `test/boot-regression.e2e-spec.ts` guards the script/output agreement.
- Boot failures are surfaced via `abortOnError: false` + a `bootstrap().catch`
  in `src/main.ts` that writes to stderr. `bufferLogs: true` otherwise swallows
  pre-logger crashes into a silent `exit(1)` (and `process.exit` truncates
  piped/redirected `console.error`, so use `fs.writeSync(2, ...)` when
  diagnosing a startup crash directly).
- Config is validated by `class-validator` on typed domain classes in
  `src/config/domains/*` (see `EnterpriseConfigModule`), NOT Joi. All domains
  are `useFactory`-provided; the `@ConfigDomain` metadata lives on the injection
  token, which `ConfigurationRegistryService` must read (not `wrapper.metatype`).
  `@IsOptional` does not skip `NaN`: a numeric env var set to a non-number fails
  boot, so `.env.production` carries real numeric defaults and only secrets and
  endpoints are placeholders. The web `.env.production` must likewise hold
  valid URLs and a 32+ character `NEXTAUTH_SECRET` placeholder or `next build`
  fails while collecting page data.
- Nest's `ConfigModule` loads `.env.local`, `.env.<NODE_ENV>`, then `.env` (see
  `EnterpriseConfigModule`). Committed `.env.production`/`.env.development`/
  `.env.test` are templates the owner deliberately tracks; the root
  `.gitignore` documents this ("ALWAYS COMMITTED") and is marked do-not-modify.
- `@dukaanai/invoice-math` resolves to `packages/invoice-math/dist` (gitignored).
  Build it first (`npm run build` at the root runs turbo in dependency order;
  in isolation run `cd packages/invoice-math && npx tsc -p tsconfig.json`), or
  the API/web type-checks fail with TS2307.
- Prisma migrations under `apps/api/prisma/migrations` now produce exactly
  `schema.prisma` (`20260919090500_schema_sync` closed the historical drift;
  verify with `prisma migrate diff --from-url ... --to-schema-datamodel
  prisma/schema.prisma --exit-code` after `migrate deploy`). Always run
  `npx prisma generate` after changing `schema.prisma` or switching branches.
- Production runs MySQL 8, dev/CI here often MariaDB: they differ. MySQL
  cannot reference a TEMPORARY table twice in one statement (ERROR 1137,
  MariaDB allows it). Test raw-SQL migrations on MySQL 8; without Docker Hub,
  `apt-get download mysql-server-core-8.0` + `dpkg -x` runs one side by side.
- MySQL treats NULLs as distinct in unique indexes: a unique key that includes
  a nullable column (`deletedAt`, `variantId`) never blocks duplicates. Never
  rely on such a key; `InventoryItem` carries `variantKey = variantId ?? '-'`
  for its real unique index, and the default warehouse/bin bootstrap runs
  under a `SELECT ... FOR UPDATE` on the Shop row.
- `Shop.ownerId` and `User.shopId` are mutually-required foreign keys; creating
  the pair needs FK checks deferred within the transaction (MySQL). See
  `AuthBypassService.provisionSystemUser`.
- The `archiver` dependency is ESM-only; jest maps it to
  `apps/api/test/stubs/archiver.stub.js` in the e2e/integration configs.
- MySQL `LIKE` is case-insensitive: outbox relays partition event types with
  `LIKE BINARY` (`'Invoice%'` must not match `'INVOICE_CREATED'`).
- Prisma promises are lazy: code that relies on the tenant AsyncLocalStorage
  context must `await` inside `runWithContext`/`runAsSuperAdmin`, never return
  the bare PrismaPromise out of the scope.

## POS / billing architecture (EXEC-006C)

- Contract: `docs/POS_BILLING_CONTRACT.md` is the binding API/engine contract
  for the web POS, the API and `@dukaanai/invoice-math`. Update it with any
  route or payload change.
- Money math lives only in `packages/invoice-math` (`CALCULATION_SPEC.md`).
  The API re-reads prices inside the checkout transaction and recomputes; the
  web runs the same engine for previews. Never add arithmetic elsewhere.
- Stock has one writer: `InventoryMutationEngine.mutateStock` (inventory-domain).
  `InventoryItem.locationId` is a FK to `Location.id`; callers resolve the
  location with `InventoryLocationService` (`resolveSaleLocation` for POS,
  `resolveWarehouseBin` for receipts). Never pass a code such as `'DEFAULT'`.
  Products that only carry `Product.currentStock` are bootstrapped into an
  `InventoryItem` + `OPENING_BALANCE` ledger row on first mutation.
- `BillingService.createInvoice` is one transaction. Lock order is canonical
  for sales, returns, cancellations and repayments: original Invoice → Shift →
  Customer → NumberSequence → Product rows in ascending productId
  (`InventoryMutationEngine.lockProducts`, exclusive, BEFORE inserting any
  invoice/return line: a child-row insert takes a shared lock on Product and
  upgrading it later deadlocks) → LedgerAccountBalance by account. Deadlock /
  lock-wait rollbacks (P2034, P2028, MySQL 1213/1205 via P2010) are retried
  (`common/db/serialization-retry.ts`). Returns and cancellations
  (`InvoiceReversalService`) reverse the same authorities.
  `LedgerPostingService` lives in the global `LedgerModule` (`src/ledger`);
  GRNs, purchase returns and adjustments post through it too (contract §9).
  Every `post()` needs a `source` key; the unique `LedgerPosting` index is the
  ledger's idempotency guard, so never add check-then-insert dedupe around it.
- `BillingCheckpoints` (`billing/billing-checkpoints.ts`) is the fault
  injection seam: no-op in production, overridden by the failure-injection
  integration spec. Keep every checkpoint call when editing the flows.
- Custom (ad-hoc) invoice lines have `productId = null`, `isCustom = true`;
  any query joining `InvoiceItem` to `Product` must LEFT JOIN.
- Discount authority: cashiers are limited to
  `BILLING_CASHIER_MAX_DISCOUNT_PERCENT` (default 10); see contract §2.
- Redis stock keys (`stock:{shopId}:{productId}`) are advisory only; an
  "insufficient" answer is re-checked against the DB and never rejects a sale
  on its own. Compensation never creates keys.
- Business day / financial year come from `src/common/time/business-day.ts`
  with `ShopSettings.timezone` (default Asia/Kolkata); dashboards, reports,
  invoice dates and cancellation windows all use it.
- Tests: `npm test` (unit, src/**/*.spec.ts), `npm run test:integration`
  (real MySQL + Redis via `.env.test`, boots AppModule; build the test DB with
  `DATABASE_URL=... npx prisma migrate deploy` first). The integration suites
  are `pos-workflow` (business flow), `pos-failure-injection` (every
  checkpoint × sale/return/cancel/repayment), `pos-concurrency` (the
  concurrency × stock × quantity matrix up to 200 parallel checkouts, edge
  cases, multi-location, bootstrap race) and `pos-resilience` (Redis outage,
  outbox, accounting incl. purchase side, custom items, authority rules).
  `apps/web` has `npm run test:e2e` (Playwright, browser-level checkout).
  `npm run test:e2e` in apps/api is the boot regression.

## Auth bypass flag

- `AUTH_DISABLED` (API) + `NEXT_PUBLIC_AUTH_DISABLED` (web, build-time) disable
  authentication for demos/dev. OFF by default; see `AuthBypassService`
  (`apps/api/src/auth/auth-bypass.service.ts`), `AuthConfig`
  (`apps/api/src/config/domains/auth.config.ts`), and `apps/web/src/lib/auth-bypass.ts`.
  When on, every request runs as a provisioned system user
  (`system@dukaanai.local`, OWNER, own shop). Real auth code stays intact - the
  flag gates access, it never accepts unverified identity from a request.

## Git attribution rule

- Commits, pull requests and comments must be authored by the repository
  owner only. Never add `Co-Authored-By: Claude ...`, `Claude-Session: ...`,
  "Generated with Claude Code" footers, or any other AI co-author / assistant
  attribution trailer to commit messages, PR descriptions or GitHub posts in
  this project. This project rule overrides any default attribution behaviour.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
