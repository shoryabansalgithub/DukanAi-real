# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Build and run sharp edges (apps/api)

- `nest build` uses `tsconfig.build.json` (`include: ["src/**/*"]`), so the
  entrypoint compiles to `dist/main.js` and `start:prod` is `node dist/main`.
  If the root-level `check-db.ts` (or any other root-level script) ever gets
  pulled into the build, tsc widens rootDir and the output moves to `dist/src/main.js`;
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
- Nest's `ConfigModule` loads `.env.local`, `.env.<NODE_ENV>` (only when
  `NODE_ENV` is set), then `.env` (see `EnterpriseConfigModule`). `NODE_ENV` is
  required (`AppConfig` has no default; the `start*` scripts pin it, `start:prod`
  to production), so a bare process never runs as development. Committed
  `.env.production`/`.env.development`/`.env.test` are templates the owner
  deliberately tracks; the root `.gitignore` documents this ("ALWAYS COMMITTED")
  and is marked do-not-modify. A production boot that still carries a template
  placeholder (`JWT_SECRET`, `FRONTEND_URL`) refuses to start.
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
  outbox, accounting incl. purchase side, custom items, authority rules) and
  `dashboard` (EXEC-005: every dashboard figure against SQL, boundaries,
  stock alerts, insights, partial failure, tenant isolation).
  `apps/web` has `npm run test:e2e` (Playwright: checkout and dashboard
  states/polling). `npm run test:e2e` in apps/api is the boot regression.
  `test/security/*.security-spec.ts` (also matched by `test:integration`;
  alone: `npm run test:security`) asserts the secure behaviour the audit
  found missing: an open finding is `it.failing`, so it runs, is expected to
  fail, and breaks the build the moment a fix lands until it is flipped to
  `it` (see `test/security/README.md`). Never skip or delete one.
  Point either at another database with `TEST_DATABASE_URL` (integration) or
  `DATABASE_URL` + `E2E_DATABASE_URL` (Playwright); no env file edits needed.
- BullMQ's connection comes from `bullConnectionFromUrl(REDIS_URL)`
  (`src/common/redis/redis-connection.ts`: `rediss://` turns TLS on,
  credentials are percent-decoded, the path is the db, `maxRetriesPerRequest:
  null`). The db index matters: dev (db 0) and tests (db 1) share one Redis
  server, and before the db was honoured a running dev API consumed the tests'
  jobs. Every queue is BullMQ (`@nestjs/bullmq`); the legacy `@nestjs/bull`
  package is gone (`barcode-bulk` was its last processor and dialled
  localhost:6379 db 0 regardless of `REDIS_URL`). The shared `REDIS_CLIENT` is
  QUIT on application shutdown (`RedisClientLifecycle`).
- The cache (`CACHE_MANAGER`) is a Keyv Redis store (`buildCacheOptions`,
  `src/common/cache/cache-options.ts`): keys are `cache:<key>` in Redis, so
  every instance shares entries and an invalidation is seen by all. Without
  `REDIS_URL` it is an in-process Map (dev only). cache-manager 7 reads
  `stores`, not `store`: the old `cache-manager-redis-yet` wiring was ignored
  and left an unbounded per-process Map.
- Integration runs are hermetic: `test/jest-integration.global-setup.ts`
  flushes the test Redis db first (index >= 1 only), and the setup file sets
  `CRON_ENABLED=false` so no scheduler registers (the two
  `scheduler-*.integration-spec.ts` suites assert both switch positions). A
  "never fires" cron string is not an option: `CronJob.start()` throws when an
  expression has no run in the next 8 years, and `IsCronExpression` rejects
  such values at boot for the same reason. `npm run test:e2e` in apps/api is
  the boot regression only; `src/config/config-platform.spec.ts` proves
  env -> injected config through the real module.
- `app.init()` returns before BullMQ has opened its Redis connections; closing
  the app inside that window surfaces as unhandled `Connection is closed`
  errors (bullmq emits them after removing its own listeners). The shared
  `bootApp()` fixture waits for every queue/worker with `waitUntilReady()`, so
  boot-assert-close suites are deterministic; production shutdown has the same
  race (roadmap 7.3).
- Config domains read env through `hydrateFromEnv` (`src/config/hydrate-from-env.ts`):
  only `@EnvVariable` properties are copied, blank keeps the default, `0` is a
  value, garbage fails boot (`IntegerFromEnv`, `NumberFromEnv` for decimals,
  `BooleanFromEnv`, `IsCronExpression`). Every numeric/boolean domain uses it
  (`AppConfig`, `JwtConfig`, `SecurityConfig`, `CronConfig`, `CacheConfig`,
  `BullConfig`, `PrismaConfig`, `QueueConfig`, `EmailConfig`, all
  `*FeatureConfig`); never hydrate with `plainToInstance(..., {
  enableImplicitConversion: true })`, which turned the string "false" into
  true. Bounds live on the class (`BILLING_CASHIER_MAX_DISCOUNT_PERCENT` 0-100,
  `OCR_FUZZY_MATCH_THRESHOLD` 0-1, `BCRYPT_ROUNDS` 4-31, limits >= 1).
  Shared rules live in `src/config/validation/env-rules.ts`:
  `IsProductionSecret` (under `NODE_ENV=production` a secret must be 32+ chars
  and no template placeholder such as `___REPLACE_ME___`/`your_`/`CHANGE_ME`),
  `IsUrlList` (`FRONTEND_URL`: comma-separated absolute http(s) origins).
- Boot refusals throw: `StartupValidatorService` and
  `ConfigurationRegistryService` raise an Error (never `process.exit`), so the
  reason reaches `bootstrap().catch` and stderr. `test/boot-regression.e2e-spec.ts`
  spawns `node dist/main` for the matrix (no `NODE_ENV`, blank / placeholder /
  short `JWT_SECRET`, placeholder `FRONTEND_URL`, `AUTH_DISABLED` in
  production) and asserts each message.

## Money and stock correctness (roadmap phase 3)

- Returns are cumulative (`InvoiceMathEngine.calculateReturn`, spec in
  `packages/invoice-math/CALCULATION_SPEC.md`): every line carries
  `returnedQuantity`, a document refunds `cum(before + qty) − cum(before)`
  per stored amount, is never rounded to the rupee on its own, and is settled
  against the sale (`settlement`: capped at `invoiceTotal − refundedTotal`,
  exact remainder when it completes the invoice). `InvoiceReversalService`
  reads the earlier returns under the invoice lock (`priorReturns`) and the
  web preview passes the same settlement. A cancellation settles as a
  completing return, so its math lands on the stored total.
- `splitRevenue` (`billing.types.ts`) decides the SALES_REVENUE / GST_PAYABLE
  split of a sale or reversal: revenue carries the round-off and a sub-₹0.50
  document moves the shortfall onto GST, because the ledger drops negative
  entries. Use it for any new revenue posting.
- Reversals run on soft-deleted products and customers: the engine blocks a
  deleted product only for SALE/RESERVATION, `lockCustomer` takes
  `allowDeleted`. A refund posts to the sale's shift while it is still open
  and usable by the actor (`lockShiftForReversal`), else to the actor's own.
- Authority: `creditLimit` is accepted from MANAGER+ only
  (`CREDIT_LIMIT_REQUIRES_MANAGER`, AuditLog row `CUSTOMER_CREDIT_LIMIT_CHANGED`
  in the same transaction). A cashier's discount authority is the max of the
  line, invoice and combined effective percentages, and a cashier's custom
  line is capped at `BILLING_CASHIER_MAX_CUSTOM_LINE_AMOUNT` (default 500,
  `CUSTOM_LINE_REQUIRES_APPROVAL`).
- Soft-delete unique keys use `deletedToken` (`''` live, the row id once
  deleted; `src/prisma/soft-delete-token.ts`, DMMF-derived, stamped by the
  Prisma extension on `update`/`upsert` by id: a soft delete through
  `updateMany` throws). Keys are `(shopId, key, deletedToken)` on Category,
  Product (sku, barcode), ProductVariant (sku, barcode), Supplier, Customer,
  CustomerGroup/Category, PurchaseOrder, GoodsReceipt, VendorBill,
  PurchaseReturn, SupplierCreditNote, Warehouse, Location. The index is the
  guard: services pre-check for a friendly message and map P2002 with
  `rethrowUniqueViolation` (`common/db/unique-violation.ts`); the global
  filter answers 409 `DB_P2002` with `details.target` otherwise. Live rows
  that were already duplicates when the migration ran keep their id as token
  (exempt, still live); list them with `deletedToken <> '' AND isDeleted = 0`.
- Stock engine: `idempotencyKey` is per document line (`GRN:<grn>:<lineId>`,
  `PRET:<return>:<lineId>`) and callers skip the value of an `idempotent`
  result; a RESERVATION_RELEASE floors `reserved` at 0; `variantId` on the
  request addresses the variant row (adjustments, allocations, releases pass
  it); a new product-level item bootstraps `currentStock − Σ onHand` as
  OPENING_BALANCE; `InventoryReconService` writes an InventoryLog row
  (recorded under the shop owner) when it corrects `currentStock`.
- Reservations always expire (`expiresInSeconds` 30 s..7 d, mandatory);
  `POST /reservations/:id/cancel|release` free the stock once
  (`ReservationExpiryService.releaseReservation`, status-guarded). Stock-count
  adjustments are never auto-approved, take their delta from
  `StockCountItem.variance` when raised from a count item, need an approver
  other than the requester, and approve + post in one transaction with
  guarded PENDING_APPROVAL → APPROVED → POSTED transitions.
- Payables (`SupplierPayablesService`, global LedgerModule): a GRN adds to
  `Supplier.pendingPayables` and a purchase return floors it, in the same
  transaction as their postings; supplier and vendor-bill payments create a
  `SupplierPayment` row (idempotent per `(shopId, idempotencyKey)`), decrement
  the balance under a guard (`PAYABLES_INSUFFICIENT`) and post DR
  ACCOUNTS_PAYABLE / CR CASH|BANK with source `SUPPLIER_PAYMENT`.
  `payablesFromLedger` rebuilds the balance (`openingPayables` + postings).
- Migrations: an applied migration is never edited
  (`scripts/check-migrations-immutable.sh`, run in CI against the base
  branch); a fix ships as a new migration with `information_schema` guards
  (`20260929090100_foundation_convergence` is the template); the ledger
  immutability triggers are a migration (`20260929090200`), so
  `LedgerTransaction` rows cannot be updated or deleted, not even by tests.
  The boot drift message and `prisma/MIGRATIONS.md` give the
  `migrate deploy` / `migrate resolve` runbook; `prisma db push` is never used.
  `test/integration/migrations.integration-spec.ts` replays the phase 3
  migrations on a seeded scratch database (needs CREATE DATABASE rights on
  the test server).

## Scaffolding modules (roadmap phase 4)

- 4.1: the media, product-validation, product-identity, import-export,
  webhook and product-events controllers take the shop from `@CurrentShop()`
  and the user from `@CurrentUser('id')` (`src/iam/decorators`); `req.shop`
  was never set and every call answered 500. Every body is a DTO; webhooks
  are MANAGER+ for reads and writes and the HMAC secret is returned once, in
  the create response, only when the server generated it. Foreign keys in
  those routes go through `assertOwned` (media attach, barcode targets, bulk
  validation); validation state rows are read and written by shop;
  `VariantIdentity.sku` is unique per shop (`(shopId, sku)`, migration
  `20260929120000`). The former media `bulk`/`search` stubs are gone; `tag`
  and `order` are real. `test/integration/scaffolding-routes.integration-spec.ts`
  walks every route as OWNER, VIEWER and a foreign owner (no 500s, role
  gates, 404 on foreign ids) and follows an import to the worker.
- Every BullMQ processor runs its job under a tenant context
  (`src/iam/tenant-context/job-context.ts`): `jobContext(shopId, jobId)` when
  the job names its shop (`requireJobShop` refuses one that does not),
  `runInShopOf(tenant, prisma, model, id, jobId, fn)` when it names only a
  document (the owner is read as the system tenant; a missing row is a
  logged no-op, not a crash loop), `runAsSuperAdmin` for relays.
  `src/iam/tenant-context/processor-context.spec.ts` scans every
  `@Processor` source and fails a worker that touches a collaborator
  without one (a pure Redis/queue worker is allowlisted there with its reason).
  Producers put `shopId` on the job (`import-job`, `webhook-delivery`).
- 4.2 procurement (purchase, grn, purchase-return, vendor-bill,
  supplier-credit domains; kept and fixed because the phase 3 payables build
  on GRNs and bills; the web does not call these routes yet):
  - Document numbers come from `NumberSequenceService`
    (`src/common/numbering`, global; one `NumberSequence` row per
    `(shopId, entityType)` under `FOR UPDATE`): `PO-YYYYMM-00001`,
    `GRN|PR|VB|SCN-<FY>-000001`; the POS invoice/return numbers use the same
    service. Never number a document from `Date.now()`.
  - Every procurement write runs in `procurementTransaction`
    (`src/common/db/procurement-transaction.ts`: READ COMMITTED, 30 s,
    serialization retry), not Serializable, and takes the canonical locks:
    the order header (`PurchaseReceiptService.lockReceivableOrder`, raw
    `FOR UPDATE`) then `InventoryMutationEngine.lockProducts` before stock moves.
  - State machines are the `*LifecycleService` maps; a purchase-order
    transition is a compare-and-set `updateMany` on the current status (0 rows
    is 409 `PURCHASE_ORDER_STATE_CONFLICT`). Submission opens one PENDING
    approval row (`openApproval`) and puts returns, bills and credit notes in
    `PENDING_APPROVAL`; an order is decided SUBMITTED → APPROVED/REJECTED in one
    step. The creator/submitter never approves (`SEPARATION_OF_DUTIES`, 403);
    approving without a PENDING row is 400 `*_NOT_PENDING`.
  - A goods receipt is bound to its order: the order must be APPROVED,
    ORDERED or PARTIALLY_RECEIVED, the supplier must match, each line fulfils
    one `PurchaseOrderItem` (`GoodsReceiptLine.purchaseOrderItemId`, migration
    `20260929140000`), ordered quantity and unit price come from that line
    (the DTO has neither), and Σ accepted over every ACCEPTED/COMPLETED/CLOSED
    receipt of a line never exceeds what was ordered (`GRN_OVER_RECEIPT`).
    Inspection quantities are applied to the lines; acceptance stocks the
    inspected (else received) quantities, posts DR INVENTORY / CR
    ACCOUNTS_PAYABLE and moves the order to PARTIALLY_RECEIVED / RECEIVED.
  - A purchase return line names its GRN line; over-return is checked against
    accepted minus the other live returns (`COUNTED_RETURN_STATUSES`), the
    return's own rows excluded on re-validation. Vendor-bill three-way match
    is cumulative over the other live bills of the receipt line. A credit note
    is worth its lines, is issued on approval, and allocates only to a
    POSTED/PARTIALLY_PAID bill of its own supplier (the bill becomes
    PARTIALLY_PAID/PAID; the ledger payable was already reduced by the
    purchase return, so an allocation posts nothing).
  - Outbox: the purchase relay claims rows as PROCESSING and the
    `purchase-events` worker sets DONE/FAILED (marking DONE at enqueue made the
    worker skip everything). The relay's family is
    `PURCHASE_RELAY_TYPE_PREFIXES` (`src/common/outbox/outbox-routing.ts`,
    incl. `Goods*`, `Inspection*`, `Outstanding*`); `Inventory*`/`Product*`
    rows (with `Category*`/`Brand*`) belong to the product-events relay
    (`PRODUCT_RELAY_TYPE_PREFIXES`, 4.7). Listeners receive one
    envelope `{ shopId, outboxEventId, aggregateId, correlationId, payload }`;
    the order approval event is `PurchaseOrderApproved`. Analytics SQL is MySQL
    (`TIMESTAMPDIFF`), not PostgreSQL.
  - `test/integration/procurement.integration-spec.ts` walks the whole chain
    over HTTP (numbers, approvals, receipts, bill, payments, return, credit
    note, relay) and asserts stock, ledger and `Supplier.pendingPayables`.
- 4.3 warehouses/locations (`src/warehouse-domain`): MANAGER+ writes, shop
  from the tenant context, `Warehouse.code` unique per shop and
  `Location.code` per warehouse (409 `WAREHOUSE_CODE_IN_USE` /
  `LOCATION_CODE_IN_USE`, unique indexes with `deletedToken` behind the
  pre-check), `warehouseId` through `assertOwned`, a parent location must be
  in the same warehouse (404). Covered by the procurement spec above.
- 4.4 OCR (`src/ocr`, `POST /ocr/scan-bill`, MANAGER+): multer limits and
  the image-only filter come from `OcrModule`'s `MulterModule.registerAsync`
  (`OCR_MAX_IMAGE_BYTES`, one file, JPEG/PNG/WebP by declared type and
  extension); the bytes are then sniffed (`sniffImageMimeType`,
  `ocr-upload.ts`) and that mimetype, not the client's, goes to Gemini with
  the key in `x-goog-api-key` (never the URL) and `OCR_MODEL`. A placeholder
  or missing `GEMINI_API_KEY` is 503 `OCR_NOT_CONFIGURED`; an unreadable
  model answer is 502 `OCR_UNREADABLE_RESPONSE`, never an empty success.
  Matching (`OcrService.matchProducts`) is per line with up to four keywords
  as plain `contains` filters (MySQL collation is case-insensitive; Prisma's
  `mode: 'insensitive'` is PostgreSQL-only and answered 500 here), five
  candidates, four lookups in flight, and the Dice similarity against
  `OCR_FUZZY_MATCH_THRESHOLD` is the reported `confidence`. Items are capped
  at `OCR_MAX_ITEMS`. The web caller is the AI scanner page (roadmap 6.1).
  `src/ocr/ocr.service.spec.ts` and
  `test/integration/ocr.integration-spec.ts` (stubbed `fetch`) cover it.
- 4.5 / 4.6: the enterprise-invoice (`/invoices/generate`), returns-domain
  (`/returns/initiate`), payment-domain (`/payments/capture`), sales-domain
  (`/sales/orders`, `/sales/workflow`), pricing-domain (`/pricing/simulate`)
  and events-domain (`/events/replay`, its duplicate `/events/webhooks`) stacks
  are detached from `AppModule`: POS billing (`/billing/*`) is the one
  invoice / return / payment path and product-events (`/webhooks`,
  `/events`) the one webhook path. Customers and reservations no longer write
  outbox rows nobody consumed (`customer.*`, `StockReserved`); a customer's
  audit row commits in the same transaction as the create / delete. Every
  BullMQ queue must have a worker and a producer: `QueueWiringAssertion`
  (`src/common/queues`, boot) refuses a registered queue without a worker or
  a worker without a registration, and `queue-wiring.spec.ts` walks the
  import graph from `app.module.ts` (unreachable files do not count) and
  also requires an `@InjectQueue` producer per queue. The 15 consumer-only
  workers (`grn-jobs`, `purchase-returns`, `supplier-credits`, `vendor-bills`,
  `purchase-attachments`, `workflow-engine`, `customer-queue`, `barcode-bulk`
  and the seven of the detached stacks) and the producer-only
  `internal-events` / `inventory-events` queues are gone from the modules.
  A new queue needs both sides in the same change.
- 4.7 outbox: every relay goes through `OutboxClaimService`
  (`src/common/outbox/outbox-claim.service.ts`): `claim(predicate)` runs one
  READ COMMITTED transaction (`SELECT ... FOR UPDATE SKIP LOCKED` on PENDING
  rows whose `nextAttemptAt` has passed, then `status = 'CLAIMED'`,
  `claimedAt`), the relay enqueues after the commit (`release` on an enqueue
  failure) and the worker settles the row: `markDone`, or `scheduleRetry`
  (PENDING again with `nextAttemptAt` = exponential backoff from
  `EVENTS_OUTBOX_RETRY_BACKOFF_MS`, FAILED once `EVENTS_OUTBOX_MAX_RETRIES`
  attempts are spent). Job ids are `<outboxEventId>.<retryCount>`
  (`jobIdFor`; BullMQ refuses a custom id containing `:`) so a retry never
  collides with a retained job. The
  `OutboxReaper` cron (`CRON_OUTBOX_REAPER`, lock `cron:outbox-reaper`) puts
  claims older than `EVENTS_OUTBOX_STALE_CLAIM_MS` (CLAIMED, or legacy
  PROCESSING) back to PENDING with the same backoff, or FAILED. Three relays
  share the semantic: system events (`OutboxRelayService` -> `system-events`
  worker; every type no other family owns), purchase
  (`PurchaseOutboxRelayCron` -> `purchase-events`), product
  (`OutboxProcessorWorker` routes inline to `webhook-delivery`). The sales
  relay pair (`sales-events`/`sales-webhooks`) is gone: nothing stages its
  types since 4.5. `POST /sales/events/retry` (MANAGER+) resets a FAILED row
  of the shop to PENDING (409 `OUTBOX_EVENT_NOT_FAILED` otherwise);
  `GET /sales/events[?status=]` lists them. Never mark a row DONE at enqueue
  time and never poll a row's status from a relay: claim, hand over, let the
  worker end it. A test that relays product rows drains the family first
  (other suites leave PENDING rows; the relay claims the oldest batch).
- 4.8 webhooks: one delivery path, `ProductWebhookDispatcherService` over
  `WebhookHttpClient` (axios, `maxRedirects: 0`, response capped at
  `EVENTS_WEBHOOK_MAX_RESPONSE_BYTES`, only 2xx counts). `OutboundUrlGuard`
  (`src/common/net/outbound-url-guard.ts`) vets the URL at registration
  (`POST /webhooks`, MANAGER+, 400 with `WEBHOOK_URL_SCHEME|CREDENTIALS|
  PRIVATE|UNRESOLVABLE|INVALID`) and again at send time: https only unless
  `EVENTS_WEBHOOK_ALLOW_HTTP`, no credentials, no localhost/`.local`/
  `.internal` names, and every DNS answer must be public (loopback, RFC1918,
  link-local incl. 169.254.169.254, CGNAT, mapped/NAT64/6to4 IPv6 are
  blocked); the connection is then pinned to the vetted address (`lookup`
  override), so a host cannot rebind between check and connect. A blocked
  target is a WebhookDelivery FAILED row and `UnrecoverableError` (no
  retry). Signature: `x-dukanai-signature: t=<ms>,v1=<hex HMAC-SHA256(secret,
  "<ms>.<body>")>` with `x-dukanai-timestamp`, `x-dukanai-event`,
  `x-dukanai-delivery` (`signWebhookPayload`). The resolver is the
  `OUTBOUND_RESOLVER` provider (ProductEventsModule); tests override it and
  `WebhookHttpClient` (`test/integration/outbox-webhooks.integration-spec.ts`).
- 4.9 nightly analytics (`AnalyticsJobScheduler`, `CRON_ANALYTICS_JOB`, lock
  `cron:analytics-job`, every open shop through `sweepEveryShop`, which pages
  shops by id): per shop `KpiService.calculateDailyKpis` (now also
  `avgDailyUnits`), `ClassificationService.classifyInventory` (ABC by
  cumulative net pre-tax revenue 80 / 95 %, XYZ by the coefficient of
  variation of weekly net units over 13 business weeks,
  `engines/classification-engine.ts`; no sales = UNCLASSIFIED; one row per
  live product, deleted products pruned) and
  `RecommendationEngineService.generateRecommendations` (REORDER when the
  stockout risk is above 80 with `suggestedQuantity` = 14 days of demand,
  LIQUIDATE above 180 days of inventory). Recommendations are keyed by
  `(shopId, productId, forDate, type)` (migration `20260929170000`, forDate =
  business day): a re-run upserts score/reason/actionData and keeps the
  `status` a user set; rows older than 90 days and KPI rows older than 400
  days are pruned in LIMIT batches. All writes are multi-row
  `INSERT ... ON DUPLICATE KEY UPDATE` (`engines/batch-write.ts`, 500 rows);
  never write these tables one upsert per product. The forecast stub is out
  of the chain (dashboard insights compute their own forecast live).

## Denial of service and performance (roadmap phase 5)

- 5.1 uploads: every multipart route goes through `src/common/upload`:
  `buildUploadOptions(policy, tempDir)` gives multer hard `limits` (file
  size from `UploadConfig`: `UPLOAD_MAX_MEDIA_BYTES`, `UPLOAD_MAX_IMPORT_BYTES`;
  file, part and field counts), a `fileFilter` on the declared type and
  extension (400 with the route's code before a byte is stored) and disk
  storage into `UPLOAD_TEMP_DIR` under a random name; a file over the cap is
  multer `LIMIT_FILE_SIZE`, which Nest answers as 413 while the rest of the
  body is drained. The handler then calls `assertUploadContent` (media) or
  `assertImportFileContent` (imports): the magic bytes must match the
  declared type (`file-signature.ts`: JPEG, PNG, WebP, GIF, AVIF, MP4,
  QuickTime, WebM, Matroska, PDF, OLE, ZIP-based docx, glTF; CSV/JSON must
  be readable UTF-8 with no control bytes) or the file is unlinked and the
  request is 400. A temp file never outlives its request
  (`ProductMediaService.uploadMedia` unlinks in `finally`; the CDN move
  renames it away first; imports rename it into `uploads/imports`), and
  `UploadCleanupInterceptor` (`src/common/upload`, listed BEFORE the
  `FileInterceptor` on every disk-stored route) unlinks whatever is still
  there when the request ends by any other path: the global ValidationPipe
  runs after multer, so a body-validation 400 or an ownership 404 used to
  leave the file behind. A new disk-stored upload route must carry it. SVG is
  not a media type. The storage routes keep their constants
  (`storage-security.constants.ts`) and memory storage (documents are
  written to `STORAGE_ROOT` from the buffer) but now check the bytes in
  `validateUploadedFile` (`STORAGE_CONTENT_MISMATCH`) and cap parts and
  fields; OCR keeps its own limits and delegates sniffing to the shared
  sniffer. Roles: media and imports MANAGER+, storage per route, OCR
  MANAGER+. `test/integration/upload-limits.integration-spec.ts` overrides
  `UploadConfig` with small caps and asserts 413 / 400 / discarded temp
  files / roles per route.
- 5.2 variants: `GenerateVariantsDto` bounds the matrix before it is expanded
  (`attributeMatrixProblem`: at most 8 attributes, 100 values each, labels
  1-50 characters with letters or digits, no duplicate slugs, and the product
  of the value counts at most `MAX_VARIANT_COMBINATIONS` = 1000);
  `ProductVariantsService.generateVariants` re-checks it (400
  `VARIANT_MATRIX_TOO_LARGE` / `VARIANT_MATRIX_INVALID`) so a direct caller
  cannot bypass the DTO. The Cartesian product is typed and built only after
  the check.
- 5.3 search: `clampSearchQuery` (`product-search/search-term.ts`) takes any
  query value (`queryString`: a repeated `?q=a&q=b` arrives as an array and
  reads as its first string, a non-string is absent), normalises it and cuts
  it to `MAX_SEARCH_QUERY_LENGTH` (100); the controller, `SearchEngineService`
  and `GET /products?q` all apply it. `tokenizeForSynonyms` lower-cases,
  de-duplicates and caps the tokens looked up (8), while `queryTokens` keeps
  every typed token in the expansion; `SynonymEngineService.expandQuery`
  resolves them in ONE `findMany({ term: { in } })`, capping the expansion
  at 24 terms (a synonym list is at most 191 characters, the column width).
  Every `SearchHistory` insert goes through a per-shop, per-minute budget
  (`SEARCH_HISTORY_MAX_PER_MINUTE`, default 120; one Redis MULTI of `INCR`
  + `PEXPIRE NX` on `search-history:{shopId}:{minute}`, per-process counter
  when Redis is down): a search past the budget is served but not recorded.
  Never add a per-token query or an uncapped `q` consumer.
- 5.4 reconciliation: `InventoryReconService.runReconciliation(now)` pages
  products with keyset pagination (`inventory/recon-keyset.ts`: closed window
  `updatedAt` in `[now - lookback, now]`, cursor `(updatedAt, id)` over the
  `Product(updatedAt)` index), never `skip`; a product updated during the run
  (including one the run repairs, which bumps `updatedAt`) waits for the next
  run, so the loop terminates under continuous sales. It returns a summary
  (`productsChecked`, `batches`, drift counters) for tests.
- 5.5 dashboard: the all-time totals of the summary are cached under
  `shop:{shopId}:analytics:allTime` (`AnalyticsCacheService.getAllTime` /
  `setAllTime`, the KPI TTL of 60 s, not the dashboard hour: an aggregate
  that started before a sale committed can be written after that sale's
  invalidation, and the short TTL bounds the stale figure to a minute) with
  Decimals as strings and a shape check on read (`isCachedTotals`); the key
  is part of `analyticsCacheKeys`, so `BillingHelpers.afterStockChange` and
  the system-events worker drop it with the others after every committed
  sale, return and cancellation. Add any new whole-history aggregate to that
  key family rather than caching it on its own.
- 5.6 lists: every list route is a capped page. `src/common/pagination`:
  `ListQueryDto` (`skip >= 0`, `take 1..MAX_LIST_TAKE` = 200, default
  `DEFAULT_LIST_TAKE` = 100; a bad value is 400 under the global
  `forbidNonWhitelisted` pipe) and `LimitOffsetQueryDto` for the procurement
  lists that already used `limit`/`offset`; `pageArgs` / `limitOffsetArgs`
  clamp again for direct callers. A service returns `PagedResult`
  (`{ items, total, skip, take }`) and the handler carries `@PagedList()`:
  the response body stays the plain array the web renders (UI unchanged) and
  the page goes in `X-Total-Count` / `X-Page-Skip` / `X-Page-Take`. Applied
  to expenses, suppliers, batches, categories (default = cap, tree order),
  warehouses, the location subtree (`SubtreeQueryDto`, `path` required),
  inventory-domain items and alerts, notifications, `/inventory/products`,
  purchases / grn / vendor-bills / purchase-returns / supplier-credit-notes,
  the purchase-events dead letter, `/users/employees`, `/webhooks`, the
  workflow task and definition lists, media galleries, `/auth/sessions` and
  the barcode history; shifts (own `{ items, total }` envelope), customers,
  invoices, products and search had their own caps already, and nested
  includes (`subCategories`, product `images`/`attributes`, media
  thumbnails/tags, duplicate candidates) carry `take: MAX_LIST_TAKE`. CORS
  exposes the page headers. A new list route takes `@Query() query:
  ListQueryDto` and never a bare `@Query('limit')`; every paged `orderBy`
  ends in `id` so pages are stable.
  `test/integration/list-caps.integration-spec.ts` walks the named lists,
  the legacy `limit` routes, the extra lists above and the `q` routes.
- 5.7 guards: `JwtAuthGuard`, `TenantGuard` and `RolesGuard` run once as
  `APP_GUARD`s (`app.module.ts`); no controller repeats them with
  `@UseGuards` (the only local guards left are `LocalAuthGuard` on login and
  the socket guards on `InventoryGateway`). `raiseLowStockNotifications`
  (system-events worker) is three statements per sale: products `in`,
  unread LOW_STOCK notifications `in`, one `createMany`. A category move
  (`CategoriesService.update`; `parentId: null` moves to the root, an absent
  `parentId` is a plain update) runs in one transaction that reads the
  category and the new parent `FOR UPDATE` (two concurrent moves can neither
  build a cycle nor re-root from a stale prefix) and re-roots the subtree
  with one `UPDATE ... SET path = CONCAT(new, SUBSTRING(path, ...)), depth =
  depth + delta WHERE shopId = ? AND path LIKE 'old%'`
  (`updateDescendantsPath`, LIKE-escaped prefix), never one update per
  descendant. `Category.path` is VARCHAR(191): about seven levels of ids.
- 5.8 load test: `apps/api/load/` (`pos-peak.yml`, `processor.js`,
  `setup.mjs`, `summarize.mjs`, `run.sh`, `upload-gate.sh`, README) drives
  checkout, dashboard summary and login at 3x the assumed peak (15 / 30 / 3
  per second) with artillery (`npx artillery@2.0.34`, not a workspace
  dependency) against a built API on a disposable database, through public
  routes only (registration creates the shop OWNER). `summarize.mjs` is the
  one gate (artillery's expect/ensure plugins are not loaded, so a check in
  the yml would be ignored): checkout p95 < 500 ms, zero 5xx, zero
  transport errors, every response 2xx, and the load delivered (users
  created = completed, requests = responses). `upload-gate.sh` is the other
  half of the phase gate: N x 300 MB uploads answer 413 with the RSS
  sampled and the temp directory empty. The load is spread over
  `LOAD_SHOPS` shops (16): a checkout holds the shop's shift, number-sequence
  and product row locks, so one shop bills serially by design. Both scripts
  boot with `NODE_ENV=test` (so `.env.test` applies: rate limits open,
  billing timeouts wide) and `PRISMA_LOG_QUERIES=false`;
  `PrismaService.logLevelsFor` honours that flag outside production (it used
  to log every query under any non-production `NODE_ENV`; `.env.test` and
  `.env.development` still say `true`, and `test/jest-integration.setup.ts`
  forces `false`, so integration runs print no query log). The recorded
  baseline, the environment and the code version it was taken on are in
  `docs/LOAD_TEST_BASELINE.md`; re-run and update it after a change to the
  checkout transaction, the dashboard queries or the upload path.

## Web application (roadmap phase 6)

- 6.1 no fake flows: every mutating page action either calls the API or is
  gone. Employees (`/employees`) lists `GET /users/employees`, suspends /
  reinstates through `PATCH /users/:id/suspend`, removes through
  `DELETE /users/:id` (OWNER/ADMIN only, never self) and invites through
  `POST /invitations/generate` (`employeesApi` in `src/lib/api-client.ts`,
  roles from `INVITABLE_ROLES`); the code reaches the invitee by email only,
  and the register page (`/register?invite=<code>`, or the code pasted into
  the "Invitation Code" field) switches to join mode and calls
  `POST /invitations/accept` (the page posts it itself; there is no client
  wrapper). Payroll, attendance and shift columns are not
  modelled by the API and were removed, not stubbed. Suppliers edit through
  `PATCH /suppliers/:id` (MANAGER+), delete through `DELETE /suppliers/:id`
  (ADMIN+, row removed only after the API answers) and send the chosen
  payment mode as `tender`; "Record Purchase" is an honest info toast because
  the web has no purchase-order UI. Smart Capture posts the JPEG (and, for
  "Convert to PDF", a one-page PDF built client-side by `src/lib/jpeg-pdf.ts`,
  no dependency) to `POST /storage/bills/:customerId/:billId`
  (`storageApi.storeCapturedBill`, `Walk-in` when no customer is chosen);
  "Try OCR Extraction" hands the frame to the AI scanner through
  sessionStorage (`PENDING_SCAN_KEY`, `src/lib/smart-capture.ts`). The AI
  scanner calls `POST /ocr/scan-bill` (`ocrApi.scanBill`), renders the API's
  matched lines with their confidence, offers a CSV export and shows 503
  `OCR_NOT_CONFIGURED` / 502 `OCR_UNREADABLE_RESPONSE` as failures; it never
  claims to update stock (stock moves only through purchase orders / GRNs).
  The AI Assistant and Database Manager pages had no backend and are deleted
  with their sidebar entries. Role gates on these pages use the pattern in
  `src/components/customers/permissions.ts` and treat `AUTH_DISABLED` as
  OWNER. Never re-introduce a `setTimeout` "save" or a toast without a
  request behind it.
- 6.2 products page: the list is a server page (`productsApi.listPage`,
  `GET /products?q&limit&offset&categoryId&stock`, 50 per page, total from
  `X-Total-Count`); the search box is debounced and every filter is applied
  by the API (`stock` shares the dashboard's reorder-point rule, so the row
  badges use `reorderPoint` too), never by trimming the loaded page. The
  four tiles read `GET /dashboard/summary` (`totalProducts`, `lowStockCount`,
  `outOfStockCount`, `inventoryValue`) and show a failed section as
  unavailable. Add / edit send exactly the typed fields (`productPayload`):
  a blank SKU is omitted and numbered by the API (`SKU-000001`, per-shop
  `NumberSequence` under the same row lock as invoice numbers), the cost
  price is required and never derived, MRP defaults to the selling price and
  may not be below it, GST slab and unit are selects from the Prisma enums.
  Delete goes through a confirmation modal and re-reads the page. Create /
  edit are MANAGER+, delete ADMIN+/OWNER (mirrors the API's `@Roles`).
- 6.3 settings: "Shop Profile" writes every `UpdateShopProfileDto` field
  (`shopApi.update`); the state is a picker from
  `components/pos/indian-states.ts` because `BillingService.resolveInterState`
  compares `Shop.state` with `Customer.state` to decide IGST, and a shop
  without a state can never bill IGST (the save toast says so). The side
  menu holds two panels (Shop Profile, Account & Security: the caller's
  sessions from `GET /auth/sessions` with revoke and sign-out) and two links
  (Notifications, Team Management); "Billing & Plans" is gone because no plan
  model exists. `test/integration/products-settings.integration-spec.ts`
  proves the SKU sequence, the paged filters and the IGST split over HTTP;
  `apps/web/e2e/products-settings.spec.ts` proves the pages.
- 6.4 web security: `next.config.js` sets `poweredByHeader: false` and the
  static headers (HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Permissions-Policy` with `camera=(self)` for Smart
  Capture) and refuses to build or start with `NEXT_PUBLIC_AUTH_DISABLED`
  under `NODE_ENV=production`; `src/lib/auth-bypass.ts` compiles the flag to
  false in a production bundle regardless, and the proxy answers 503.
  The Content-Security-Policy is per request in `src/proxy.ts` (Next 16's
  name for the middleware convention; it runs on the Node.js runtime): a fresh
  script nonce with `'strict-dynamic'` (no `'unsafe-inline'` for scripts;
  `'unsafe-eval'` only under `NODE_ENV=development` for React Refresh),
  `connect-src` = self + the `NEXT_PUBLIC_API_URL` origin, `frame-ancestors
  'none'`, `form-action 'self'`. Next.js reads the nonce from the request's
  CSP header, which requires dynamic rendering: the root layout exports
  `dynamic = 'force-dynamic'`, so never prerender a page (a static page would
  carry un-nonced inline scripts and be blocked). The middleware verifies the
  session with `getToken` (signature, expiry, no `RefreshAccessTokenError`),
  not cookie presence, and builds `callbackUrl` from the path; the login
  page parses it with `sanitizeCallbackUrl` (`src/lib/safe-callback-url.ts`)
  against `window.location.origin`, so `//evil`, `/\evil`, absolute URLs and
  `/login` fall back to `/dashboard`. Style attributes still need
  `style-src 'unsafe-inline'` (framer-motion, inline styles). A
  `fetch('data:…')` is a connection under `connect-src` and is refused:
  decode data URLs with `dataUrlToBlob` (`src/lib/data-url.ts`), never fetch
  them.
- 6.5 web robustness: `app/error.tsx` (page segment, keeps the shell) and
  `app/global-error.tsx` (root layout, inline styles only). `src/lib/uuid.ts`
  is the one uuid v4 (falls back from `crypto.randomUUID` to
  `getRandomValues`); the POS store and `RecordPaymentModal` use it. The POS
  store starts in the per-tab anonymous scope (`dukaanai-pos:anon`) and
  `scopePosStoreToShop` moves it to `dukaanai-pos:<shopId>`, carrying an
  anonymous cart into an empty shop scope and deleting the anonymous copy;
  `usePosScope` says which shop is active and the barcode scanner is enabled
  only once it is set. Any store write before `hydratePosStore()` persists
  the empty state over the saved cart: `useIdempotencyKey` waits for
  `persist.hasHydrated()` / `onFinishHydration`, and a new hook that writes
  to the store at mount must do the same. ShiftBanner, the navbar
  notification poll and the notifications page carry stale-response guards
  (request sequence / cancelled flag): only the newest answer lands, none
  after unmount. `apiClient` has `DEFAULT_API_TIMEOUT_MS` (15 s); uploads and
  checkout set their own. Smart Capture stops the camera stream on unmount.
- 6.6: the navbar search pushes `/products?q=<term>`; the products page reads
  `q` from `useSearchParams` (initial state and on change while mounted).
  `apps/web/e2e/web-hardening.spec.ts` covers headers, the nonce, the
  production guard (loads `next.config.js` under `NODE_ENV=production`),
  callback sanitising, navbar `q` and the anonymous-cart migration; the
  production CSP with a real sign-in was smoke-tested with `next build` +
  `next start` against an API without the bypass.
- 6.7 correctness: the receipt and the invoice page show a Cess row when the
  document carries cess (summed from the lines: `Invoice` has no cess column).
  Print CSS is per page: `globals.css` hides `.print-hidden` (the shell) on
  every page, applies the 80 mm receipt rules only while the receipt portal
  is mounted (`body:has(.receipt-print-root)`), and each printable page
  mounts its own `@page` through `PrintPageStyle`
  (`src/components/print`; receipt 80 mm, invoice detail A4 under
  `.print-document`). A customer edit sends '' for a blanked optional field
  (the API stores null; `UpdateCustomerDto.email` skips `IsEmail` for '')
  and the form lengths match the DTO (name 100, city 100, address 500, notes
  1000). Expenses tiles read `GET /expenses/summary` (this month in the
  shop's timezone over every expense, pending over every unpaid one) and the
  Edit action is real (`PATCH /expenses/:id`). Batch dates go through
  `formatBatchDate` (null = "Not recorded"). The viewport allows pinch-zoom.
  Low-stock badges use each product's reorder point (6.2). The inventory page
  keeps only the tabs with a module (Batches & Expiry, Low Stock); stock
  moves are recorded from Products › Update Stock, so the transfer /
  adjustment placeholders are gone. Forgot password: `POST
  /auth/forgot-password` (public, auth-throttled) always answers the same
  message and emails `<FRONTEND_URL>/reset-password?token=…` when the address
  has a password account (never a Google-only one); the token is hashed at
  rest (`PasswordResetToken`, migration `20260930090000`), single use, one
  hour, and a new request voids the older ones; `POST /auth/reset-password`
  sets the password, bumps `tokenVersion`, revokes the refresh tokens and
  drops the sockets, so every session ends. Production without SMTP answers
  503 like invitations. Web pages `/forgot-password` and `/reset-password`
  are public in the middleware and shell-less in `RootLayout`.
  `test/integration/web-correctness.integration-spec.ts` and
  `apps/web/e2e/correctness.spec.ts` cover the row.
- 6.8 dead code: the 13 unused web dependencies are gone (radix, react-hook-form,
  react-query, next-themes, class-variance-authority, tailwind-merge, …) plus
  `@types/uuid`; `data/customers.json`, `eslint_output.txt`, the unused
  `Button`, `Input`, `StatCard`, `DataTable`, `Charts` components, the hooks
  barrel (`useTheme` now lives in `src/hooks/useTheme.ts`) and the unused
  exports in `lib/utils.ts`, `types/index.ts`, `store/index.ts`
  (sidebar state only) are removed (`lib/utils.ts` is `clsx` only). ts-prune
  does not resolve the `@/` alias, so it reports every `@/types` import as
  unused: confirm a candidate with `grep -rlw <name> src` before deleting it,
  and never add an export nobody imports. recharts is loaded
  with `next/dynamic` (`SalesTrendChart`, `components/analytics/AnalyticsCharts`),
  never imported from a page. `SkeletonBox` pulses with the CSS keyframe
  `skeleton-pulse` (globals.css, reduced-motion aware), not a JS loop.
- 6.9 gate evidence: `playwright.auth.config.ts` (`npm run test:e2e:auth`,
  CI step "Playwright (real auth)") boots the API without `AUTH_DISABLED` and
  the web with the bypass off on ports 3005 / 3012, sequentially after the
  bypass suite (both use the `.next` dev cache). `e2e-auth/real-auth.spec.ts`
  registers through the form, proves the middleware bounce and callback, a
  wrong password, sign-out, every repaired page under a real session, and a
  VIEWER (inserted with a bcrypt hash through `E2E_DATABASE_URL`) who sees no
  write buttons while the API answers 403. `docs/WEB_GATE_EVIDENCE.md` holds
  the exit-gate record (persistence suite, headers, Lighthouse).
- The shared axios instance (`src/lib/api.ts`) defaults to JSON and axios
  serialises a `FormData` body as JSON under that header (`{"file":{}}`); its
  request interceptor drops the content type for `FormData` so the browser
  sends multipart with a boundary. Post uploads through `apiClient`, never
  through a second instance. `StoragePathBuilder` resolves `STORAGE_ROOT` to
  an absolute path once (the committed relative `./data/storage` used to trip
  the traversal guard on every upload) and the guard requires the base or a
  child of it, not a string prefix.
- `apps/web/e2e/fake-flows.spec.ts` and `persistence.spec.ts` are the phase 6
  persistence suite: every mutating UI action (the repaired ones and the ones
  that were already real: invoice cancel / return, customers incl. payments
  and the POS picker, shifts, employees, expenses, notifications, suppliers,
  stock adjustments) is asserted after a reload AND against the API or the
  API's disk (`E2E_STORAGE_ROOT`, default `apps/api/data/storage`);
  `e2e-auth/real-auth.spec.ts` adds the two that need a real session (ending
  another session, the reset-password link). Chromium does not expose blob
  multipart bodies to Playwright, so upload tests assert the multipart
  header and the server-side effect, not the request body. A JPEG fixture is
  rendered in the page with a canvas (the API sniffs magic bytes).
  `products-settings.spec.ts` continues it for 6.2 / 6.3; add a test for
  every new mutating UI action. Match the products list request by exact
  pathname: `/dashboard/products` and `/inventory/products` also end in
  `/products`. Sharp edges the suite met: cancelling or refunding cash
  needs the actor's open shift (409 `SHIFT_REQUIRED`; `GET /shifts/current`
  answers an empty body when there is none), `DELETE /customers/:id` is 204,
  the cancel and shift-close routes answer 200, `POST /billing/returns`
  wraps the document in `{ invoice }`, and `POST /customers/:id/payments`
  needs an `idempotencyKey`.

## Dependencies (roadmap phase 7)

- 7.1 / 7.2: `npm audit --omit=dev` is clean (the `next` 14 advisory went
  with the Next 16 upgrade) and CI's lint job fails on any high or critical
  production advisory (`npm audit --omit=dev --audit-level=high`); re-check
  after any dependency change and keep it that way. The root `overrides`
  carry the fixes that upstream pins block, each with its reason in
  `package.json`: next-auth 4's `nodemailer` (its unused Email provider) is
  forced to 10.x, `@prisma/config`'s `deepmerge-ts` to 8.x (CJS build,
  same `deepmerge` export; `prisma generate` / `migrate` run on it),
  `@nestjs/swagger`'s `js-yaml` to 5.4.x, and `postcss` to 8.5.28 (next 16
  pins 8.5.23; the override keeps every copy on the patched line). Keep an override scoped to its consumer: a blanket
  `js-yaml` override breaks eslint 8 and the istanbul loader (they need
  3.x / 4.x). `npm audit fix` is not usable here: it tries to downgrade
  `prisma` to 6.12 and stops on the peer conflict; apply fixes as explicit
  versions instead. `prisma` and `@prisma/client` are pinned to the same
  exact version (6.19.3): bump both together, then `npx prisma generate`.
  The gate audits production dependencies only, so build-time tooling must
  live in `devDependencies`: `tailwindcss-animate` (a Tailwind plugin used
  by `tailwind.config.js`) was a production dependency and pulled Tailwind's
  chokidar / micromatch / braces chain into the gate when a `braces`
  advisory with no fix landed. Every package is declared where it is imported: `axios` in apps/api
  (`webhook-http-client.ts`) as well as apps/web, `mysql2` as a
  devDependency of both apps (only tests open a raw connection), `dotenv`
  as an apps/api devDependency (scripts and tests; the API reads env through
  `@nestjs/config`). `xlsx`, `joi`, `lodash`, `fluent-ffmpeg`, `fuse.js`,
  `bull` and `@nestjs/bull` are gone (nothing imported them; the media
  worker's video branch is a comment). The API image installs the API
  workspace alone, so a package the API imports but only reaches
  node_modules through another workspace (`uuid` via next-auth) is missing
  there and boot dies with MODULE_NOT_FOUND: `src/dependency-declarations.spec.ts`
  scans `src/` (specs excluded) and fails on any import not in the API's
  `dependencies` (`uuid`, `cache-manager`, `cron`, `express`,
  `@nestjs/mapped-types` are declared for that reason). Node 22 is the floor
  everywhere (`engines`, `.nvmrc`).

- 7.2: the web runs Next.js 16 on React 19 (`react`/`react-dom`/`@types/react`
  19, framer-motion 14, lucide-react 1.x, recharts 2.15). What the major
  changed here: `next lint` is gone, so `npm run lint` in apps/web is
  `eslint .` over `eslint.config.mjs` (ESLint 9 flat config: `eslint-config-next`
  core-web-vitals + typescript; the React Compiler rules of
  eslint-plugin-react-hooks 7, `set-state-in-effect` and `refs`, are off
  until the compiler is adopted; CommonJS `*.config.js` may `require`).
  `src/middleware.ts` is `src/proxy.ts` exporting `proxy` (same matcher,
  Node.js runtime). Request APIs are async (`await headers()` /
  `await cookies()`). `next build` and `next dev` use Turbopack, whose CSS
  parser is strict: Tailwind scans source files (comments included) and a
  bracket token with a leading hyphen such as a regex character class
  `[-:.TZ]` becomes an arbitrary-property class that fails the build; put the
  hyphen last. Next rewrote tsconfig to `jsx: react-jsx`, so an unused
  `import React` fails the build's type check: import only what is used.
  `@playwright/test` stays pinned (1.56.1); Next lists it as an optional peer.
  In `next dev` the Next 16 overlay echoes every `console.error` (the dev
  tools button's name contains "Next"), so a Playwright text locator for an
  error message must be scoped to the page's own `role=alert` and a "Next"
  button locator needs `exact: true`, or strict mode resolves two elements.
  `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` are written by `next dev`
  (they point at the bundled Next 16 docs under `node_modules/next/dist/docs`)
  and are committed because Next re-creates them on every dev start.

## Deployment (roadmap 7.3)

- Images: `apps/api/Dockerfile` and `apps/web/Dockerfile` build from the
  repository root (`.dockerignore` there) on one pinned Node
  (`NODE_VERSION`, the major of `.nvmrc`; bump together), Debian slim
  (glibc for the Prisma engines, sharp, bcrypt; `openssl` + `ca-certificates`
  via apt), non-root `node`, `HEALTHCHECK` on the liveness route, no env
  file copied in. The API image holds only the API's production
  `node_modules` (`npm ci --omit=dev -w api -w @dukaanai/invoice-math`
  + `prisma generate`), `dist`, and `prisma/` so the same image runs the
  release step `npx prisma migrate deploy`. The web image is Next's
  standalone output: `NEXT_STANDALONE=true` switches `output: 'standalone'`
  on in `next.config.js` (opt-in because `next start` refuses it) with
  `outputFileTracingRoot` at the monorepo root; `NEXT_PUBLIC_API_URL` is a
  build arg (inlined) and also runtime env (the proxy's CSP reads it);
  `API_INTERNAL_URL` (server-only, `serverConfig`) is where `auth.ts`
  reaches the API from inside the network. `docker-compose.yml` + root
  `.env.example` (two required secrets, `:?` otherwise) is the reference
  stack: mysql 8 (`--log-bin-trust-function-creators=1` for the ledger
  triggers), redis 7 AOF, `migrate` one-shot, `api` healthy on readiness,
  `web`. `docs/DEPLOYMENT.md` is the runbook (probes, env, Kubernetes sketch).
- Probes: `HealthModule` (`src/health`, `@Public()` + `@SkipThrottle()`):
  `GET /api/health` and `/health/live` are liveness (no dependency; the
  Playwright web servers and the `HEALTHCHECK`s poll the first);
  `GET /api/health/ready` is 200 only when `SELECT 1`, Redis `PING` (2 s
  probe timeout each) and `GracefulShutdownService.isDraining === false`,
  else 503 `{ status: 'draining' | 'unavailable', checks }`. The web has
  `app/api/health/route.ts` (excluded in the proxy matcher).
- Shutdown (`src/common/lifecycle`): `main.ts` calls `app.init()`, waits
  for every BullMQ queue/worker connection (`waitForQueueConnections`,
  bounded by `QUEUE_READY_TIMEOUT_MS`; the integration fixture uses the
  same helper unbounded), sets `keepAliveTimeout`
  (`HTTP_KEEP_ALIVE_TIMEOUT_MS`, above the LB idle timeout), then listens;
  `enableShutdownHooks(undefined, { useProcessExit: true })` exits 0 after a
  clean close instead of re-raising the signal (143).
  `GracefulShutdownService.beforeApplicationShutdown(signal)`: draining
  flag -> watchdog (`SHUTDOWN_TIMEOUT_MS`, exit 1, armed only on a real
  signal) -> `SHUTDOWN_DRAIN_DELAY_MS` (signal only; 0 compose, 5 s k8s) ->
  close every worker (active jobs finish) -> Nest closes the servers ->
  `onApplicationShutdown` closes queues, Redis (QUIT) and Prisma.
  `PrismaService` disconnects in `onApplicationShutdown`, never in
  `onModuleDestroy` (which runs before the server closes and failed
  in-flight requests). `test/integration/deployment.integration-spec.ts`
  covers the probes in-process and sends a real SIGTERM to `node dist/main`
  (built on demand). `scripts/compose-smoke.sh` is the phase 7 exit gate
  (CI job "Deployment (compose smoke)"): fresh clone -> `compose up` ->
  idempotent migrate -> probes -> register -> API + web sign-in -> stock,
  shift, sale -> dashboard -> `compose stop` exits 0 with the shutdown lines.

## CI hardening and storage (roadmap 7.4, 7.5)

- 7.4: every `uses:` in `.github/workflows/*.yml` is pinned to a commit SHA
  with a `# vX.Y.Z` comment (checkout v6, setup-node v6, upload-artifact v6:
  the v4 majors run on the Node 20 runtime GitHub is retiring); `.github/dependabot.yml` (github-actions,
  weekly, grouped) moves the pins. Never put a floating tag back. The
  Pullfrog agent workflow is `workflow_dispatch` only, `contents: read` +
  `id-token: write` (it acts through Pullfrog's GitHub App), checkout with
  `persist-credentials: false`, and passes only `ANTHROPIC_API_KEY` /
  `CLAUDE_CODE_OAUTH_TOKEN`; another provider is added with its own secret
  there, never the whole list. Runtime artifacts are never tracked: the
  turbo daemon logs and `apps/api/data/storage/System/*.json` were
  untracked (the ignore rules already covered them), and
  `scripts/check-tracked-artifacts.sh` (lint job) fails CI if anything under
  `.turbo/`, an `uploads/` directory, `data/storage/`, a `*.log` or
  `dump.rdb` is tracked.
- 7.5: `StoragePathBuilder` resolves `STORAGE_ROOT` once (`path.resolve`,
  logged at boot) and contains every join with `path.relative`
  (`isContained`: `..`, absolute segments and sibling prefixes such as
  `<root>2` are refused); `relativeToShop` is the only form a response may
  carry (`Customers/<id>/Profile`, `Deleted/<file>`, `Backups/Daily/<zip>`),
  never an absolute path. Production requires an absolute, non-placeholder
  `STORAGE_ROOT` (`IsProductionAbsolutePath`, boot refuses otherwise); the
  dev / test templates keep `./data/storage`, resolved against the working
  directory (the start scripts, Docker and Playwright all run from
  `apps/api`). Every storage route checks the customer with `assertOwned`
  (404 for a foreign or unknown id; `Walk-in` is the no-row customer).
  Billing evidence is written once: every target is checked, then created
  with the `wx` flag; a repeat is 409 `STORAGE_EVIDENCE_EXISTS` and nothing
  is replaced or partially written; statements get a unique file name per
  generation. `test/stubs/archiver.stub.js` is a functional fake (placeholder
  payload, real stream close) mapped in every jest config, so the backup
  flow runs in tests. `src/storage/storage.service.spec.ts` (temp root) and
  `test/integration/storage.integration-spec.ts` cover the row.

## Observability, backups and retention (roadmap 7.6, 7.7, 7.8)

- 7.6 logs: `LoggingConfig` (`LOG_LEVEL`, `src/config/domains/logging.config.ts`)
  is the most verbose level `CorrelationLogger` prints; the default is
  `debug` outside production and `log` in production, where `debug`/`verbose`
  refuse to boot (`IsNotDebugInProduction`; boot-matrix case). `main.ts`
  passes `logLevels` to the logger; `PRISMA_LOG_QUERIES` stays the separate
  query-log switch.
- 7.6 metrics: `src/common/observability/metrics.ts` is the one prom-client
  registry (`metricsRegistry`, default label `service=dukaanai-api`, process
  metrics under `dukaanai_`); metrics are module-level objects a service
  imports (no injection): `httpRequestsTotal` / `httpRequestDurationSeconds`
  (`httpMetricsMiddleware`, `app.use` in `main.ts` BEFORE the routers so
  guard rejections and 404s count; `routeLabel` collapses to the Express
  pattern or `unmatched`, never a raw path), `checkoutDurationSeconds{outcome}`
  (`BillingService.createInvoice` wraps `checkout()`), `ledgerPostingFailuresTotal{source}`
  (`LedgerPostingService.post` wraps `postEntries()`), the outbox / queue
  gauges (`ObservabilityCollectorsService.refresh` on each scrape, outbox from
  raw SQL under `runAsSuperAdmin`, queues from `queueInstances`),
  `retentionRowsPurgedTotal{table}`, `errorsTrackedTotal{kind}`. Labels stay
  low-cardinality: never an id, shop or user. `GET /api/metrics`
  (`MetricsController`, `@Public() @SkipThrottle()`, `ObservabilityModule`)
  answers `metricsRegistry.contentType`, 404 under `METRICS_ENABLED=false`,
  401 unless the bearer token equals `METRICS_TOKEN` (`crypto.timingSafeEqual`).
  Rules: `deploy/prometheus/alerts.yml` (+ `prometheus.yml`; `promtool check`
  in the CI deploy job; compose `prometheus` service under profile `ops`);
  runbook `docs/OBSERVABILITY.md`.
- 7.6 error tracking: `ErrorTracking` (`src/common/observability/error-tracking.ts`)
  is a static facade over `@sentry/node` 11, a no-op until `SENTRY_DSN` is
  set (`MonitoringConfig`: DSN must be an http(s) URL and never a placeholder,
  `IsNotPlaceholder` in `env-rules.ts`; `METRICS_TOKEN` likewise). Sentry 11
  has no `sendDefaultPii`: request data is switched off with `dataCollection`.
  `GlobalExceptionFilter` captures only what it answers as 500 (unhandled,
  deliberate 500, unmapped Prisma code) with `correlationId`, shop, user,
  route pattern, method and status as tags; expected 4xx/5xx are not errors.
  `bootstrap().catch` captures `startup` and flushes before `exit(1)`.
  Tests mock `@sentry/node` (`error-tracking.spec.ts`); integration:
  `test/integration/observability.integration-spec.ts` (installs the
  middleware through `bootApp`'s `beforeInit`).
- 7.7 backups: `scripts/db/` (`lib.sh` parses `DATABASE_URL` or `MYSQL_*`,
  password via `MYSQL_PWD`, clients via `MYSQL_BIN` / `MYSQLDUMP_BIN`):
  `backup.sh` (mysqldump `--single-transaction --routines --triggers --events
  --hex-blob --no-tablespaces`, MySQL-only flags detected from `--help`,
  DEFINER clauses stripped so the triggers restore under any user, written to
  `.partial` then renamed, trailer checked, `.sha256` sidecar, `--keep`
  pruning; default dir `/var/backups/dukaanai`, never inside the repo),
  `restore.sh` (dry run unless `--yes`; `--database` / `--create`; the dump
  drops and re-creates its tables), `restore-drill.sh` (backup -> restore into
  `<db>_drill_<stamp>` -> `migrate status` up to date -> `migrate diff`
  clean -> every table's row count equal -> ledger triggers present -> drop;
  CI runs it in the integration job after the suites, on MySQL 8). Compose:
  `db-ops` service (profile `ops`, `mysql:8.0` image, `scripts/db` mounted,
  `db-backups` volume, `db-ops.sh` entrypoint). Runbooks:
  `docs/BACKUP_RESTORE.md` (rehearsal record) and the "Rolling back a
  release" section of `prisma/MIGRATIONS.md` (additive: redeploy the old
  image; otherwise a forward migration; destructive: restore the pre-release
  backup, so destructive changes ship expand-then-contract).
  `DEPLOYMENT_CHECKLIST.md` puts the backup before `migrate deploy`.
  Finding of the first drill: Prisma applies a migration to MySQL as one
  multi-statement script, and MySQL 8 stored the bare single-statement
  body of `prevent_ledger_update` (migration `20260929090200`) WITH its
  terminator, so mysqldump wrote `...; */;;` and the restore failed on a
  syntax error. `20261003090100_ledger_triggers_portable_bodies` recreates
  both triggers with `BEGIN ... END` bodies (never `DELIMITER` in a
  migration; a compound body ends at END on MySQL 8 and MariaDB alike) and
  `backup.sh` drops such a terminator so pre-fix backups restore too. Give
  every future trigger a compound body.
- 7.8 retention: `RetentionSweepService` (`src/common/retention`, cron
  `RetentionSweep` on `CRON_RETENTION_SWEEP`, default `30 3 * * *`, lock
  `cron:retention-sweep` 15 min, `runAsSuperAdmin`) deletes with
  `DELETE ... LIMIT` batches (`RetentionConfig`: `RETENTION_*_DAYS`,
  `RETENTION_BATCH_SIZE` 100..10000, `RETENTION_MAX_BATCHES_PER_RUN`; a table
  whose budget runs out is reported in `truncated` and continues next run):
  RefreshToken by `expiresAt` (consumed tokens must outlive their idle life
  for reuse detection, so the window is past expiry), PasswordResetToken by
  `expiresAt` / `usedAt`, OutboxEvent `status = 'DONE'` by `createdAt`
  (FAILED rows stay for `POST /sales/events/retry`), SearchHistory by
  `createdAt` (`RETENTION_SEARCH_HISTORY_DAYS` >= 7: the popular-searches card
  reads seven days), ProductEventLog by `timestamp`. Migration
  `20261003090000_retention_indexes` adds `RefreshToken(expiresAt)`,
  `SearchHistory(createdAt)`, `ProductEventLog(timestamp)` (`OutboxEvent
  (status, createdAt)` existed): a purge column without an index scans the
  table on every batch. `scheduler-enabled.integration-spec.ts` lists the
  job and overrides its cron; `test/integration/retention.integration-spec.ts`
  seeds every table on both sides of each window.

## Toolchain

- Node is pinned once, in `.nvmrc` (CI reads it via `node-version-file`) and
  `engines` in every package.json. `npm run lint|type-check|test|build` at the
  root go through turbo; `apps/api` lint is clean at zero errors and must stay
  so: unused parameters that a signature must keep are `_`-prefixed, and a
  deliberately un-awaited promise is written `void fn()` only when the callee
  catches its own errors (`no-floating-promises` is on; `no-unsafe-argument`
  stays off until the `any` request bodies become DTOs).

## Dashboard (EXEC-005)

- Contract §6. `GET /dashboard/summary` loads 11 sections independently: a
  failed one is listed in `failedSections` with `null` figures (503 only when
  all fail); the web marks exactly those tiles/cards unavailable. Keep new
  summary figures inside a section.
- Stock alerts count active, non-deleted, stock-tracked products only
  (`stockAlertProductFilter`: not SERVICE/DIGITAL, which the inventory engine
  bypasses). The inventory page's `?tab=low-stock` lists them all.
- KPIs are cached 60 s; `BillingHelpers.afterStockChange` drops the cache
  right after every committed sale/return/cancel, and the outbox processor
  drops it again, so tiles and KPI strip agree on the next read.
- Web resources go through `useDashboardResource` (newest response wins, polls
  skip a request in flight), dashboard GETs time out after 15 s and payloads
  are shape-checked (`DashboardPayloadError`): never render a failure as zeros.

## Authorization policy (roadmap phase 1)

- `RolesGuard` is deny-by-default: every POST/PUT/PATCH/DELETE handler must
  carry `@Roles(...)`, `@AnyAuthenticated()` (own-data self-service) or
  `@Public()`; GET stays open to any signed-in user unless narrowed.
  `RouteAuthorizationAssertion` (AppModule) refuses to boot otherwise, and
  `src/auth/route-authorization.spec.ts` scans every controller source without
  booting. Write roles with the sets in `src/auth/role-sets.ts`
  (`ADMIN_ROLES`, `MANAGEMENT_ROLES`, `POS_ROLES`); `SUPER_ADMIN` is never
  implicit, list it.
- Every `@Body()` is a class-validator DTO (the scan spec rejects `any`,
  `unknown`, `object` and inline object types). A body that is a free-form
  JSON document goes through `@Body(JsonObjectPipe)`. Never spread a request
  body into Prisma `data`: pick the columns you mean to write (see
  `ShopsService.updateShopProfile`, `PurchaseDraftService.pickDraftFields`).
- Separation of duties: the creator/submitter of a purchase order, the
  creator of a goods receipt and the requester of a stock-count adjustment
  cannot approve it (`ForbiddenException` in the approval services).
- Shop isolation is derived from the schema (`src/prisma/tenant-scope.ts`):
  every model with a `shopId` column is tenant-owned except `GLOBAL_MODELS`
  (`User`, `Invitation`: read before the tenant is known). Under a tenant
  context the Prisma extension narrows every filter to the shop, binds creates,
  refuses `data.shopId` changes and scopes nested writes (`connect` etc. get
  `shopId`, so a foreign target answers P2025). Code that runs outside a
  request must pick a context: `runAsSuperAdmin` for work that spans shops
  (outbox relays), `runWithContext(jobContext(shopId, jobId))` for a job that
  names its shop (`src/iam/tenant-context/job-context.ts`); a tenant-model
  query with neither throws "Missing tenant context".
- A foreign key supplied in a request body is never read by the extension, so
  every write that stores one calls `assertOwned` / `assertOwnedMany`
  (`src/prisma/tenant-ownership.ts`) first, inside the same transaction
  (404 for a foreign row). `test/integration/tenant-isolation.integration-spec.ts`
  sends shop B's IDs to every such route as shop A.
- Sweeps are per shop: `POST /batches/sweep-expiry` and `POST /reservations/sweep`
  act on the caller's shop; the global sweeps are the locked crons
  `BatchExpirySweep` / `ReservationExpirySweep` (`CRON_BATCH_EXPIRY_SWEEP`,
  `CRON_RESERVATION_EXPIRY_SWEEP`), which use `sweepEveryShop`
  (`src/common/sweeps/per-shop-sweep.ts`): shop list as system tenant, each
  shop in its own context, per-shop and per-row failures logged and skipped.
  `TenantGuard` lets only `ACTIVE` shops through (SUSPENDED/LOCKED/ARCHIVED/
  DELETED and an unknown status are 403).
- Procurement line tables (`PurchaseOrderItem`, `GoodsReceiptLine`,
  `VendorBillLine`, `PurchaseReturnLine`, `SupplierCreditLine`) carry
  `shopId` (migration `20260927180000_scope_line_tables_by_shop`, backfilled
  from the parent); nested creates must set it, and `BatchStock`'s unique key
  is `(shopId, batchId, inventoryItemId)`.

## Rate limiting and proxies (roadmap 2.1)

- `SecurityConfig` windows are milliseconds (`RATE_LIMIT_*_TTL_MS`, under
  1000 fails boot); the old second-based `RATE_LIMIT_*_TTL` keys are not read.
  Counters live in Redis (`RedisThrottlerStorage`, keys `throttle:{...}`) and
  degrade to the per-process storage when Redis is down. Routes that take
  credentials carry `@AuthThrottle()` (login, register, refresh, google,
  invitation accept) and get the `AUTH_RATE_LIMIT_*` limits instead of the
  general ones (`src/common/throttling`). `.env.test` opens every window wide;
  `test/integration/rate-limit.integration-spec.ts` proves the limiter with its
  own overrides and clears `throttle:*` before and after.
- The tracker is `req.ip`, so `TRUST_PROXY` (Express `trust proxy`, applied in
  `main.ts`) decides whether `X-Forwarded-For` counts. Every sign-in and
  refresh call reaches the API from the web server, which forwards the
  browser's address (`apps/web/src/lib/auth.ts`); count it as a hop.
- Login lockout (`UsersService.incrementFailedAttempts`, atomic
  `{ increment: 1 }`): `SECURITY_MAX_LOGIN_ATTEMPTS` failures lock NEW logins
  for `SECURITY_LOCKOUT_DURATION_MS`; an expired lock is cleared on the next
  attempt (`isLockedNow`). A lock never revokes open sessions or sockets
  (`JwtStrategy`, `AuthenticatedIoAdapter` ignore `isLocked`): suspension is
  `isActive`, revocation is `tokenVersion`. The `auth-account` throttler
  (`AUTH_RATE_LIMIT_ACCOUNT_LIMIT` per medium window, keyed by the submitted
  email) caps attempts spread over many addresses.

## Invitations, Google sign-in, email (roadmap 2.8, 2.9)

- Invitations (`InvitationsService`): the invited role must rank strictly
  below the inviter's (`ROLE_RANK`/`outranks` in `src/auth/role-sets.ts`, also
  used by user suspend/delete), `Invitation.inviterId` records the issuer, and
  the token reaches the invitee only by email: the API response carries no
  token. A MANAGER revokes only their own invitations; ADMIN roles any.
- `EmailService` (`src/common/email`, global) sends through nodemailer from
  `SMTP_URL`; unset, it logs each message (`isConfigured` false). Production
  refuses to issue an invitation without SMTP (503). Integration specs
  override the provider (`bootApp(b => b.overrideProvider(EmailService)...)`)
  and read the token from the recorded message. The email links to
  `<FRONTEND_URL>/register?invite=<token>`, which the web register page reads
  into its join mode (roadmap 6.1; the code can also be pasted).
- Google sign-in: the web sends only `{ idToken: account.id_token }` to
  `POST /auth/google`, and registers the provider only with real credentials
  (`hasGoogleCredentials`, placeholder-aware). The API never links a Google
  identity to an existing account that was not created through Google (409,
  surfaced as `AccessDenied` on the login page): anyone can register a
  password account under someone else's address.

## WebSockets and correlation (roadmap 2.13, 2.14)

- `AuthenticatedIoAdapter` registers its middleware on the root socket.io
  server AND on every namespace as it is created (`new_namespace`), because
  `server.use` alone never guards `/inventory`. The middleware verifies the
  access token (HS256, live session family), the user and the shop, then joins
  `tenant:<shopId>`; `InventoryGateway` emits to that room under the tenant
  context. `test/integration/infrastructure.integration-spec.ts` connects with
  `socket.io-client`.
- A request's correlation id is settled once by `CorrelationIdMiddleware`
  (`sanitizeIdentifier` in `src/common/correlation/correlation-id.ts`: a
  well-formed client value is kept, anything else becomes a UUID) and read as
  `req.correlationId` by the tenant interceptor and `GlobalExceptionFilter`
  (so a guard's 401 carries it too); never read the raw header. The socket
  handshake header goes through the same function.
- `CorrelationLogger` prints one JSON line per entry (Nest's ConsoleLogger
  json mode) with the correlation id (`system-job` outside a request) and
  redacts sensitive keys cycle- and depth-safely (`redact`).

## Auth bypass flag

- `AUTH_DISABLED` (API) + `NEXT_PUBLIC_AUTH_DISABLED` (web, build-time) disable
  authentication for demos/dev. OFF by default and accepted only under
  `NODE_ENV=development` or `test` (`assertAuthBypassPermitted` refuses boot
  otherwise, and `AuthBypassService.isEnabled` stays false); no committed
  API template sets it (put it in an untracked `.env.local`), and the web's
  `.env.development` sets `NEXT_PUBLIC_AUTH_DISABLED=true` for local work
  only (`next build`/`next start` refuse it, roadmap 6.4). See `AuthBypassService`
  (`apps/api/src/auth/auth-bypass.service.ts`), `AuthConfig`
  (`apps/api/src/config/domains/auth.config.ts`), and `apps/web/src/lib/auth-bypass.ts`.
  When on, every request runs as a provisioned system user
  (`system@dukaanai.local`, OWNER, own shop). Real auth code stays intact - the
  flag gates access, it never accepts unverified identity from a request.
- Tokens are HS256 only (`JWT_ALGORITHM`, pinned in `JwtModule`, `JwtStrategy`
  and the socket adapter). Refresh tokens are opaque and stored hashed; there
  is no `JWT_REFRESH_SECRET`. The web enforces a real `NEXTAUTH_SECRET` on a
  running production server (`apps/web/src/config/env.ts`, skipped during
  `next build`, which cannot know the runtime secret).
- Sessions are refresh-token families (`AuthService`, roadmap 2.6): a login
  opens a family (`RefreshToken.familyId`), every refresh consumes the token
  (`rotatedAt`, conditional `updateMany`) and writes a successor in one
  transaction; a consumed token presented again is reuse and revokes the
  family AND bumps `tokenVersion` (all sessions end); `absoluteExpiresAt`
  (`SESSION_ABSOLUTE_LIFETIME`, 30d) caps a family, `JWT_REFRESH_EXPIRES_IN`
  (7d) is one token's idle life. Access tokens live 15 min (`JWT_EXPIRES_IN`)
  and carry `sid` = familyId; `JwtStrategy`/the socket adapter reject a token
  whose family has no live row, so `POST /auth/logout`, `DELETE
  /auth/sessions/:id` and reuse take effect at once. Tests must mint tokens
  through `issueTokens`/`httpAs` (`test/security/security-fixtures.ts`, async):
  a bare `jwtService.sign` token names no session and is refused. The web's
  sign-out buttons call `signOutEverywhere` (`apps/web/src/lib/sign-out.ts`),
  which hits `/auth/logout` before NextAuth `signOut`.

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
