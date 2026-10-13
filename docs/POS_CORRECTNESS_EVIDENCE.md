# POS Correctness Evidence (LOW-LEVEL POS CORRECTNESS ROADMAP)

This file maps every ticket, target and global invariant of the roadmap to
the code that implements it and the test that proves it. Every test listed
runs against a real MySQL/MariaDB and Redis (`apps/api/.env.test`), boots the
full `AppModule`, and asserts database state, not API responses alone.

How to reproduce (from the repository root, MySQL and Redis running locally):

```bash
npm ci --ignore-scripts
(cd packages/invoice-math && npx tsc -p tsconfig.json && npx jest)          # engine: 27 tests
(cd apps/api && npx prisma generate && DATABASE_URL=mysql://root:password@localhost:3306/dukaanai_test npx prisma migrate deploy)
(cd apps/api && npx jest)                                                    # unit: 165 tests
(cd apps/api && npx jest -c test/jest-integration.json --runInBand)         # integration: 103 tests
# Same suite against MySQL 8 (the production engine):
# TEST_DATABASE_URL='mysql://root:password@127.0.0.1:3307/dukaanai_test' npx jest -c test/jest-integration.json --runInBand
(cd apps/api && npx nest build && npx jest -c test/jest-e2e.json)           # boot regression: 2 tests
(cd apps/web && npm run type-check && npm run build && npm run test:e2e)     # browser-level checkout
```

Legend for the "Layers" column (roadmap testing layers): 1 source, 2 unit,
3 service/integration, 4 API (HTTP), 5 database, 6 browser, 7 concurrency,
8 failure injection, 9 regression.

## Phase 1 — Billing calculation engine

| Ticket | Implementation | Evidence | Layers |
|---|---|---|---|
| POS-MATH-001 line math, precision, rounding point | `packages/invoice-math/src/invoice-math.engine.ts` (`Decimal`, `MONEY_DP=2`, `QUANTITY_DP=3`, half-up), limits in `invoice.constants.ts` (`MONEY_MAX`, `QUANTITY_MAX`) | `tests/invoice-math.engine.spec.ts` (1×, 2×, 0.5×, 2.25×, 1000 lines, zero/negative/huge quantity, huge price, golden master snapshot); `pos-concurrency` "quantity edge cases" (exact stock, stock+1, 0, −1, 1.25 kg, 1 000 000 → `ERR_AMOUNT_TOO_LARGE`, 10 000 → `INSUFFICIENT_STOCK`) | 1 2 3 5 |
| Price snapshot | `InvoiceItem` stores `productName/Sku`, `sellingPrice`, `costPrice`, `mrp`, `gstRate`, `discountAmount`, `taxableAmount`, tax components; prices are re-read inside the transaction and recomputed (`BillingService.createInvoice` step "authoritative prices") | `pos-workflow` cash sale (persisted taxable per line equals engine), `pos-resilience` cess test (server rejects a preview computed without cess) | 1 3 5 |
| Deleted / inactive / foreign product | `loadProducts` filters `isDeleted=false, isActive=true, shopId` → `PRODUCT_NOT_FOUND` | `pos-concurrency` "product edge cases" | 3 4 |
| Variant price, price override, tax-inclusive, coupons | Not features of this product: POS sells product-level stock at `Product.sellingPrice` only, exclusive tax only, no coupon entity. Documented as rules in `docs/POS_BILLING_CONTRACT.md` §2. | Contract | 1 |
| POS-MATH-002 discounts | line %, invoice fixed/percent, proportional allocation, ≤ subtotal, ≤ 100 %, reason required; **authority**: cashier cap `BILLING_CASHIER_MAX_DISCOUNT_PERCENT` (10), manager approval stamped (`BillingService.enforceDiscountAuthority`) | engine spec (0 %, 100 %, >100 %, negative, > subtotal, missing reason, uneven allocation), `pos-resilience` "discounts above the cashier limit" (15 % line → `DISCOUNT_REQUIRES_APPROVAL`, 20 % invoice by cashier rejected, by owner accepted with `approvedBy`) | 1 2 3 4 |
| POS-MATH-003 GST / cess | `tax/tax.calculator.ts` (CGST/SGST vs IGST by shop/customer state, cess on taxable, 2 dp per component), mixed slabs per line | engine spec (split, IGST, mixed slabs, cess), `pos-workflow` receipt GST summary, `pos-resilience` cess (₹120 cess persisted, total 1400) | 1 2 3 5 |
| POS-MATH-004 totals, round-off, paid/due/change | engine `grandTotal`, `roundOff` (nearest rupee), `finalTotal`, `settlePayment` (Σ tenders + udhar == final, change only on cash) | engine spec (round-off, change, split, credit, mismatch), `pos-workflow` (invoice/ledger/shift/dashboard/CSV reconcile) | 1 2 3 5 |
| Frontend = backend = persisted | one package `@dukaanai/invoice-math` on both sides; web adapter `apps/web/src/components/pos/engine.ts` now sends `cessRate`; Playwright checkout compares the on-screen total with `GET /billing/invoices/:id` | `apps/web/e2e/pos-checkout.spec.ts`, `pos-workflow` HTTP checkout | 1 4 6 |

## Phase 2 — Inventory

| Target | Implementation | Evidence | Layers |
|---|---|---|---|
| POS-INV-002 step 1 concurrency correctness | `InventoryMutationEngine.mutateStock`: `SELECT … FOR UPDATE` on the Product row (`lockProducts`, also taken by billing before line inserts), conditional `UPDATE InventoryItem SET onHand = onHand − q WHERE (onHand − reserved) ≥ q`, `balanceAfter` read back from the row, ledger `createdAt` stamped after the lock | `pos-concurrency` matrix (10/20/50/100/200 requests × stock 0/1/5/10/25/100/200 × qty 1/3; sales of a shop also queue on the gapless number lock, so the matrix proves the end-to-end checkout under load), the cross-flow test (sales, returns, receipts and adjustments of one product overlapping for 25 rounds with zero failures, which contends only on the product lock), concurrent adjustments, `assertStockInvariants` (onHand = Σ ledger, last `balanceAfter` = onHand, Σ InventoryLog = onHand) | 3 5 7 |
| step 2 negative stock protection, error semantics, rollback | conditional update + `INSUFFICIENT_STOCK` (409, `availableQty`); whole sale rolls back | matrix (exactly ⌊stock/qty⌋ succeed, never negative), `pos-failure-injection` (no partial state at 16 points) | 3 5 7 8 |
| step 3 service / non-inventory | `Product.type` SERVICE/DIGITAL bypass in the engine, `STOCKED_TYPES` in billing; custom lines never enter the engine | `pos-workflow` "service products never touch stock", `pos-resilience` service COGS test, custom item test | 3 5 |
| step 4 dual ledger | `StockLedgerEntry` (formal movement, signed qty, `balanceAfter`) + `InventoryLog` (operational, before/change/after) + `ProductEventLog`, written together; legacy `StockLedgerService.recordMovement` deleted | `assertStockInvariants`, `pos-workflow` (2 InventoryLog rows per 2-line sale) | 1 3 5 |
| step 5 destructive verification | see step 1; mixed-quantity test (5,2,7,10,1 vs 20); edge cases: missing / deleted / inactive / foreign product, wrong tenant (`TENANT_VIOLATION`), wrong location (`LOCATION_INVALID`), zero/negative/decimal/huge quantity | `pos-concurrency` | 3 5 7 |
| Single mutation authority | every stock writer calls `mutateStock` in the caller's transaction (billing, returns, cancellations, adjustments, GRN, purchase returns, stock counts, reservations); repository-wide grep for `onHand`/`currentStock` writes finds only the engine and the reconciliation CAS | `git grep` in this repository; `AGENTS.md` rule | 1 |
| `Product.currentStock` = Σ locations | engine keeps the aggregate in the same transaction; `InventoryReconService` repairs with compare-and-swap on `stockVersion` | `pos-concurrency` "two locations" (5 + 7, sells only 5 from the sale bin, projection 7), every `assertStockInvariants` | 3 5 7 |
| Inventory idempotency backed by DB uniqueness | `Invoice(shopId, idempotencyKey)` unique + `requestHash`; `UdharTransaction(shopId, idempotencyKey)`; `InventoryItem(shopId, productId, variantKey, locationId)` unique (`variantKey` because MySQL NULLs are distinct); Shop-row lock around default warehouse/bin creation | `pos-concurrency` "same idempotency key fired concurrently" (1 invoice, 1 movement), "brand-new shop" (8 concurrent first sales → 1 warehouse, 1 bin, 1 item, 1 opening entry), `pos-failure-injection` retry-after-failure | 3 5 7 |
| POS-INV-003 target 1 invoice ↔ inventory | one engine call per catalogue line with the invoice line quantity | `pos-workflow`, matrix | 3 5 |
| target 2 inventory ↔ product stock | as above | `assertStockInvariants` after sale/return/adjustment/purchase | 3 5 7 |
| target 3 inventory ↔ ledger | `balanceAfter` from the updated row | `assertStockInvariants` | 3 5 |
| target 4 inventory ↔ cache | `InventoryCacheService` (advisory, Lua decrement keeps TTL, restore never creates keys, never throws) | `pos-resilience` "Redis outage" (disconnect → sale commits, cache_miss; reconnect → resync; poisoned key repaired; rejected sale restores its decrement), `pos-failure-injection` (Redis key identical after every injected failure) | 3 5 8 |
| target 5 inventory ↔ dashboard | live SQL (`RevenueEngine`), `stockCounts`, `inventoryValue`, cache invalidated by the event processor | `pos-workflow` dashboard reconcile, `pos-resilience` accounting test (`inventoryValue` = ledger INVENTORY) | 3 5 |
| target 6 outbox | staged inside the transaction; relay `FOR UPDATE SKIP LOCKED`; processor idempotent per event id; P2028 pool timeouts retried | `pos-resilience` "outbox" (PENDING → DONE + marker, LOW_STOCK once, duplicate delivery skipped, failed sale stages nothing) | 3 5 |
| target 7 bypass audit | `StockLedgerService` removed; `InventoryDomainService.ensureInventoryItem` delegates to the engine (product lock + legacy bootstrap, so opening a legacy product on the inventory screen keeps its stock); stock-count posting direction bug fixed | unit specs for GRN / purchase return / adjustment posting; `pos-concurrency` "legacy product opened through the inventory endpoint" | 1 2 3 |

## Phase 3 — Accounting (POS-MATH-007/008/009/014/015)

| Target | Implementation | Evidence |
|---|---|---|
| A sales accounting | `saleLedgerEntries`: CASH/BANK/AR debits, SALES_REVENUE (+round-off) and GST_PAYABLE credits, COGS/INVENTORY for stocked lines only | `pos-workflow` cash sale ledger deltas, `pos-resilience` accounting |
| B payment accounting (cash, card, UPI, bank, credit, split) | `tenderBuckets` (CASH → CASH; UPI/CARD/BANK_TRANSFER → BANK), udhar → ACCOUNTS_RECEIVABLE | `pos-workflow` (cash, UPI, card, split, credit) |
| C receivable / udhar | `UdharTransaction` CREDIT/PAYMENT/ADJUSTMENT rows with before/after, customer row lock, repayment posts CASH/BANK vs AR | `pos-workflow` repayment, `pos-concurrency` "concurrent credit sales, repayments and returns" (balance = Σ ledger) |
| D returns / refunds | `InvoiceReversalService` reverses revenue, GST, tenders, credit, stock and COGS for lines that came back | `pos-workflow` partial/full return and cancel, `pos-resilience` accounting |
| E double entry | `LedgerPostingService.post` throws on Σ debits ≠ Σ credits; balances row-locked in account order; one `LedgerPosting` header per business source with a unique `(shopId, sourceType, sourceId)` index, so a source can never be posted twice | every suite's final "books balance" assertion; `pos-resilience` "ledger idempotency is enforced by the database" (same GRN accepted 5× concurrently → 1 posting; 6 raw concurrent postings of one source with no other lock → exactly 1 commits; every entry has a balanced `postingId`); `src/ledger/ledger-posting.service.spec.ts` |
| F reporting agrees | dashboards/CSV from the same `COMPLETED SALE/SALES_RETURN` population; purchase side posts INVENTORY vs ACCOUNTS_PAYABLE (GRN, purchase return) and INVENTORY vs INVENTORY_ADJUSTMENT (adjustments); INVENTORY carries stock at purchase cost, the dashboard shows stock at current cost price (contract §9 states the valuation basis and when the two coincide) | `pos-resilience` accounting (600 → 480 → 420 → 480 → 300 = onHand × cost with receipt price = cost price; dashboard `inventoryValue` 300), CSV net = dashboard net in `pos-workflow` |

## Phase 4 — Transaction integrity (POS-MATH-010/012/013)

| Target | Implementation | Evidence |
|---|---|---|
| 1 atomic sale | one `$transaction` per sale/return/cancel/repayment | `pos-failure-injection` |
| 2 failure injection at 14 points | `BillingCheckpoints` (16 named points incl. before/after invoice, payment, inventory, customer, shift, ledger, audit, event staging, before commit) | `pos-failure-injection`: 16 sale points, 14 return points, 14 cancel points, 9 repayment points; after each, a snapshot of every table these flows write (invoice rows and statuses, line `returnedQuantity`, tender count, InventoryItem quantities/versions, StockLedgerEntry / InventoryLog / ProductEventLog / LedgerTransaction / InventoryAdjustment / InventoryAlert / Notification / CustomerAudit counts, ledger balances, customer balances, shift counters, number sequences, outbox and audit counts, warehouse/location counts, Product stock and version, Redis keys) is identical to the one taken before the request |
| 3 duplicate requests | idempotency key + request hash, `P2002` race resolved as replay; web keeps the key until success | `pos-failure-injection` (retry after a failure creates exactly one invoice and one movement), `pos-concurrency` (same key ×6) |
| 4 concurrency | canonical lock order, product locks taken before line inserts, deadlock/lock-wait retry (P2034, P2028, MySQL 1213/1205) with a unit test of the classification | `pos-concurrency` (sales, returns, adjustments, repayments, mixed customer flows, cross-flow product contention) |
| 5 transaction boundaries | documented in `docs/POS_BILLING_CONTRACT.md` §10 | contract |
| 6 recovery | Redis restart proven live; DB/API restart safety follows from atomic transactions + idempotent replay (a lost response is replayed, a crash before commit leaves nothing); the outbox survives worker restarts (rows stay PENDING until enqueued, jobs idempotent) | `pos-resilience` Redis outage, `pos-failure-injection` BEFORE_COMMIT + retry, outbox test |

## Phase 5 — POS-MATH-005 custom items

`InvoiceItemDto.custom` (`name`, `unitPrice`, `gstRate`, `unit`), persisted
with `isCustom = true`, `productId = null`; priced/taxed/discounted by the
shared engine, never in inventory, no COGS, returnable (money only), shown in
history, receipts, CSV and category analytics (`LEFT JOIN Product`). Web: cart
line with its own `lineId`, custom-item form, badge in receipts and history.
Evidence: `pos-resilience` "custom items" and "HTTP: custom items", Playwright
checkout adds a custom line.

## Global invariants

| # | Invariant | Evidence |
|---|---|---|
| 1 | frontend = backend = persisted | Playwright checkout, `pos-workflow` HTTP checkout, cess parity |
| 2 | tax = Σ authoritative line tax | engine spec, receipt GST summary |
| 3 | total = paid + remaining | engine settlement, `pos-workflow` |
| 4 | stock arithmetic | matrix, mixed quantities |
| 5, 6 | ledger delta / balanceAfter | `assertStockInvariants` |
| 7 | customer outstanding = ledger | `pos-workflow`, `pos-concurrency` mixed flows, `pos-failure-injection` final check |
| 8 | Σ debits = Σ credits | every suite |
| 9, 10 | success = all committed, failure = nothing | `pos-failure-injection` |
| 11 | one logical request = one transaction | idempotency tests |
| 12 | tenant isolation | `pos-concurrency` product edge cases (foreign product, foreign location), `pos-workflow` search/HTTP scoping |

## Definition of done

Every checkbox of the roadmap's definition of done is covered above except
these two, which are stated rather than claimed:

- "Production runtime works": the build (`nest build`, `next build`) and the
  boot regression pass; no production deployment was performed from this
  repository.
- "DB restart / API restart" recovery is argued from transaction atomicity and
  idempotent replay (both proven) rather than by killing the database process
  inside the suite.

Independent second verification: a separate reviewer (not the author of the
changes) read the diff, ran two live lock experiments against MariaDB and
re-ran every suite. Its findings (FK shared locks on Product taken by the
invoice-line insert before the engine's exclusive lock; raw-query deadlocks
arriving as Prisma P2010 and not retried; the duplicate-merge migration
mis-selecting survivors on equal timestamps; ledger `createdAt` stamped
before the lock; legacy stock lost when a product was first opened through
the inventory endpoint; approval stamped only for invoice-level discounts;
inactive customers blocking returns; the valuation-basis claim) were all
fixed in this change set, with regression tests added for each behavioural
one (cross-flow product contention, legacy bootstrap through the endpoint,
line-discount approval, reversals for deactivated customers, retry
classification).
