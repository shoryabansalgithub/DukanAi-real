# POS / Billing API Contract (EXEC-006C)

This document is the single source of truth for the POS workflow surface. The
web app, the API and the shared math package are all built against it.

Conventions

- Base path `/api`. Every route requires a Bearer JWT unless marked public.
- Prisma `Decimal` fields serialize as strings (`"12.50"`); clients coerce with
  `Number()` for display only. Money math never happens in the browser outside
  the shared `@dukaanai/invoice-math` engine.
- Errors use the global envelope
  `{ statusCode, message, error, code?, details?, correlationId, timestamp }`.
  `code` is a stable machine string (see per-route lists). Clients branch on
  `code`, never on `message`.
- Business day and financial year are computed in the shop timezone
  (`ShopSettings.timezone`, default `Asia/Kolkata`). Financial year runs
  April to March.

## 1. Shared math engine (`@dukaanai/invoice-math`)

```ts
InvoiceMathEngine.calculate(input: InvoiceMathInput): InvoiceCalculationResultV1
```

Input

```ts
{
  items: [{ productId, quantity, unitPrice, discountPercent?, gstRateStr?, cessRate?, isInterState }],
  discountAmount?, discountPercentage?, discountType?: 'FIXED_AMOUNT' | 'PERCENTAGE', discountReason?,
  payment?: {
    tenders: [{ type: 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER', amount, tenderedAmount?, reference? }],
    udharAmount?
  }
}
```

Result

```ts
{
  schemaVersion, engineVersion, calculationHash,
  lines: [{ productId, quantity, unitPrice, lineSubtotal, discountAmount, taxableAmount,
            cgstAmount, sgstAmount, igstAmount, cessAmount, taxAmount, lineTotal }],
  subtotal, totalDiscount, taxableTotal, totalCgst, totalSgst, totalIgst, totalCess, totalTax,
  grandTotal, roundOff, finalTotal,
  payment: null | { paidAmount, udharAmount, changeAmount,
                    paymentMode: 'CASH' | 'UPI' | 'CARD' | 'UDHAR' | 'SPLIT',
                    tenders: [{ type, amount, tenderedAmount, changeAmount, reference }] }
}
```

Rules

- `payment` omitted: preview mode, `payment` is `null`, no payment validation.
- `payment` present: `sum(tenders.amount) + udharAmount == finalTotal` exactly.
  Only `CASH` may carry `tenderedAmount > amount`; `changeAmount` is the
  difference. Non-cash tenders must have `tenderedAmount == amount` (or omit it).
- `paymentMode` is derived: one tender and no udhar gives that tender's mode
  (`BANK_TRANSFER` maps to `CARD` for the invoice enum), udhar only gives
  `UDHAR`, anything else gives `SPLIT`.
- Errors throw `InvoiceMathError` with `code` in:
  `ERR_NEGATIVE_DISCOUNT`, `ERR_DISCOUNT_EXCEEDS_SUBTOTAL`,
  `ERR_MISSING_DISCOUNT_REASON`, `ERR_DISCOUNT_LIMIT`,
  `ERR_ZERO_SUBTOTAL_DISCOUNT`, `ERR_INVALID_QUANTITY`, `ERR_INVALID_PAYMENT`,
  `ERR_NEGATIVE_PAYMENT`, `ERR_NEGATIVE_UDHAR`, `ERR_PAYMENT_MISMATCH`,
  `ERR_CHANGE_NOT_ALLOWED`, `ERR_UNKNOWN_TENDER`, `ERR_DUPLICATE_LINE`,
  `ERR_INVALID_PRICE`, `ERR_INVALID_LINE_DISCOUNT`, `ERR_AMOUNT_TOO_LARGE`.
- Limits mirror the invoice columns (`Decimal(10,2)` money, `Decimal(10,3)`
  quantity): quantity `<= 9999999.999`, unit price, every line subtotal, the
  subtotal, the final total and every tender `<= 99999999.99`
  (`MONEY_MAX` / `QUANTITY_MAX` exports). Anything larger is rejected by the
  engine before any database write.
- `productId` is only a unique line key to the engine. Custom lines use
  `custom:<n>` (API) / `custom:<lineId>` (web); a repeated key is
  `ERR_DUPLICATE_LINE`.
- Cess: `cessRate` (percent, from `Product.cessRate`) is part of every line's
  tax. Search results carry it so the web preview equals the server.
- The magic preview value `amountPaid = 99999999` no longer exists.

```ts
InvoiceMathEngine.calculateReturn(input: ReturnMathInput): ReturnCalculationResult
```

Proportional return math for partial returns. Each line carries the original
stored amounts and the quantity being returned; the result has per-line
amounts scaled by `quantity / originalQuantity` (2 dp, half-up) and invoice
totals with a fresh round-off.

## 2. Billing

Roles: `CASHIER`, `MANAGER`, `ADMIN`, `OWNER`, `SUPER_ADMIN` unless noted.

### `POST /billing/calculate`

Body: `{ items: [{ productId, quantity, discountPercent? }], customerId?,
discountAmount?, discountPercentage?, discountType?, discountReason? }`.
The server resolves prices, GST rate and `isInterState` (shop state vs
customer state). Response: the engine result (payment `null`) plus
`{ isInterState, shopState, customerState }`.

### `POST /billing/invoice`

Body

```ts
{
  idempotencyKey: string (uuid v4),
  items: [{ productId?, quantity, discountPercent?,
            custom?: { name (1..120), unitPrice (> 0), gstRate: 'ZERO'|'FIVE'|'TWELVE'|'EIGHTEEN'|'TWENTYEIGHT', unit?: ProductUnit } }],
  customerId?, notes?, shiftId?,
  discountAmount?, discountPercentage?, discountType?, discountReason?,
  payments: [{ tender: 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER', amount, tenderedAmount?, reference? }],
  udharAmount?
}
```

Legacy `paymentMode` + `amountPaid` are still accepted and mapped to
`payments`/`udharAmount`.

Behaviour

- Each line is either a catalogue product (`productId`) or a **custom item**
  (`custom`), never both (`400 CUSTOM_ITEM_INVALID`). Custom lines are priced
  from `custom.unitPrice`, taxed by `custom.gstRate`, carry no cess, are never
  merged, never touch inventory, post no cost of goods and are persisted with
  `isCustom: true`, `productId: null`, `productSku: 'CUSTOM'`, `costPrice: 0`,
  `mrp = unitPrice`. The `stock` array of the response excludes them.
- Duplicate `productId` lines with the same `discountPercent` are merged;
  different discounts on the same product are rejected (`ERR_DUPLICATE_LINE`).
- Validation (engine limits, discounts, settlement, discount authority) runs
  before any stock check or lock, so an invalid request is rejected the same
  way whatever the stock position.
- If `shiftId` is omitted the cashier's OPEN shift (if any) is attached. An
  explicit `shiftId` must be an OPEN shift of the shop opened by the caller;
  `MANAGER`+ may bill on any open shift of the shop (`403 SHIFT_FORBIDDEN`).
- Stock is deducted at the shop's sale location through the inventory engine.
  The POS sells product-level stock only (no variant pricing or variant stock,
  no price override: the server always re-reads `Product.sellingPrice`).
- Pricing is tax-exclusive only; there is no tax-inclusive mode and no coupon
  mechanism.
- **Discount authority**: a `CASHIER` may apply at most
  `BILLING_CASHIER_MAX_DISCOUNT_PERCENT` (default 10) percent, per line and
  as the effective invoice-level percentage of the post-line-discount subtotal
  (the two limits are checked independently, so a cashier may combine a 10 %
  line discount with a 10 % invoice discount). Above that a `MANAGER`+ must
  bill the invoice (`403 DISCOUNT_REQUIRES_APPROVAL`, details `{ maxPercent,
  requestedPercent }`). Whenever any line or invoice discount is applied, the
  billing user is stamped as `approvedBy` / `approvalTimestamp` and the audit
  row records the amounts. The engine's hard limit is 100% and never more
  than the subtotal.
- Credit sales require a customer and are checked against `creditLimit`
  under a row lock. Managers and above may override the limit
  (server-side role check). Inactive customers cannot be billed or take
  payments (`409 CUSTOMER_INACTIVE`); their existing invoices can still be
  returned and cancelled.
- Everything (invoice, items, payments, stock, udhar, shift, ledger, audit,
  outbox) commits in one transaction or nothing does.
- Same key + same payload returns the existing invoice with `200`. Same key +
  different payload returns `422 IDEMPOTENCY_KEY_REUSED`.

Response `201`: `{ invoice, stock: [{ productId, balanceAfter }], shiftId }` where
`invoice` includes `items`, `payments`, `customer`.

Error codes: `PRODUCT_NOT_FOUND` (404), `INSUFFICIENT_STOCK` (409, details
`{ productId, productName, requestedQty, availableQty }`),
`CREDIT_LIMIT_EXCEEDED` (409, details `{ creditLimit, currentBalance,
requestedAmount, projectedBalance }`), `CUSTOMER_REQUIRED` (400),
`CUSTOMER_INACTIVE` (409), `CUSTOM_ITEM_INVALID` (400),
`DISCOUNT_REQUIRES_APPROVAL` (403), `SHIFT_INVALID` (409),
`SHIFT_FORBIDDEN` (403), `IDEMPOTENCY_KEY_REUSED` (422), engine codes above
(400), `MAX_RETRIES_EXCEEDED` (409).

### `GET /billing/invoices`

Query: `from`, `to` (ISO dates, business-day inclusive), `status`, `type`
(`SALE` | `SALES_RETURN`), `customerId`, `paymentMode`, `q` (invoice number
contains), `skip`, `take` (max 100). Response `{ items, total }`; each item:
`{ id, invoiceNumber, type, status, totalAmount, paidAmount, udharAmount,
changeAmount, paymentMode, createdAt, customer: { id, name } | null,
cashier: { id, name }, itemCount, originalId, returnedAmount }`.

### `GET /billing/invoices/:id`

Full invoice: items (with `returnedQuantity`, `discountAmount`,
`taxableAmount`), payments, customer, cashier, shift, `returns[]` (summaries of
return invoices), `originalInvoice` summary for returns.

### `GET /billing/invoices/:id/receipt`

`{ shop: { name, address, city, state, pincode, phone, email, gstin },
invoice, items, payments, gstSummary: [{ rate, taxableAmount, cgst, sgst, igst,
cess }], totals: { subtotal, discount, taxable, tax, roundOff, grandTotal,
paid, change, udhar } }` for printing.

### `POST /billing/returns`

Body: `{ idempotencyKey, invoiceId, items?: [{ invoiceItemId, quantity }],
reason?, notes?, refund?: { tender?: 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER',
reference? } }`. Omitting `items` returns everything still returnable.
Custom lines can be returned (money only; no stock is restored).
Refund order: the original credit portion is reversed on the customer first,
the remainder is refunded through `refund.tender` (default `CASH`). A cash
refund requires the cashier's OPEN shift.

Response `201`: return invoice (type `SALES_RETURN`) with items and payments.
Codes: `INVOICE_NOT_FOUND`, `INVOICE_NOT_RETURNABLE`, `RETURN_QTY_EXCEEDS`,
`SHIFT_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`.

### `POST /billing/invoices/:id/cancel`

Roles: `MANAGER`, `ADMIN`, `OWNER`, `SUPER_ADMIN`. Body `{ reason }`. Only a
`SALE` with no returns, on the same business day, can be cancelled. Stock,
udhar, shift, ledger are reversed; the invoice becomes `CANCELLED` and keeps
its number. Codes: `INVOICE_NOT_CANCELLABLE`.

## 3. Shifts

- `POST /shifts/open { openingCash }` returns the shift; `409 SHIFT_ALREADY_OPEN`.
- `GET /shifts/current` returns the caller's OPEN shift or `null`.
- `POST /shifts/current/close { closingCash, notes? }` closes it; response
  includes `expectedCash`, `closingCash`, `variance`.
- `GET /shifts?skip&take` lists the shop's shifts (`MANAGER`+ see all, cashiers
  see their own).

Shift shape: `{ id, status, openedAt, closedAt, openingCash, expectedCash,
closingCash, variance, totalSales, cashSales, upiSales, cardSales, udharSales,
totalReceipts, openedBy: { id, name }, closedBy }`.

`expectedCash = openingCash + cash sales - cash refunds + cash receipts`.

## 4. Customers

- `GET /customers?q&skip&take` returns `{ items, total }`.
- `POST /customers { name, phone, email?, address?, city?, state?, creditLimit?, notes? }`.
- `PATCH /customers/:id { name?, phone?, email?, address?, city?, state?, creditLimit?, notes?, isActive? }`.
- `GET /customers/:id` returns the customer with `state`, `creditLimit`,
  `outstandingBalance`, `totalPurchases`, `totalPaid`, last 10 invoices and
  last 10 ledger rows.
- `GET /customers/:id/ledger?skip&take` returns `{ items, total }` of
  `UdharTransaction` rows `{ id, type, amount, balanceBefore, balanceAfter,
  tender, reference, notes, invoice: { id, invoiceNumber } | null, recordedBy:
  { name }, createdAt }`.
- `GET /customers/:id/invoices?skip&take` returns `{ items, total }`.
- `POST /customers/:id/payments { idempotencyKey, amount, tender, reference?,
  notes?, allowAdvance? }` records a repayment. Without `allowAdvance`,
  `amount > outstandingBalance` is `409 PAYMENT_EXCEEDS_OUTSTANDING`. With it,
  the balance may go negative (advance / store credit). Inactive customers are
  rejected (`409 CUSTOMER_INACTIVE`). Response `{ customer, transaction }`.
- `POST /customers/search { query, skip?, take? }` returns an array.
- `DELETE /customers/:id` soft-deletes; `409 CUSTOMER_HAS_BALANCE` when the
  outstanding balance is not zero.

Roles: reads for all roles; create/update/payments for `CASHIER`+; delete for
`MANAGER`+.

## 5. Products and search

- `GET /products?q&limit&offset` (limit max 200) returns an array of products
  with `currentStock`, `gstRate`, `unit`, `sellingPrice`, `mrp`, `barcode`,
  `type`, `isActive`, `category`.
- `GET /search?q&limit` returns lean results `{ id, name, sku, barcode,
  sellingPrice, mrp, gstRate, cessRate, unit, currentStock, type, isActive,
  imageUrl, categoryName }` ranked by relevance (exact barcode/SKU first,
  then name).
- `GET /search/barcode/:code` returns exactly one product or
  `404 BARCODE_NOT_FOUND`; `409 BARCODE_AMBIGUOUS` with `details.candidates`.
- Barcodes are unique per shop: `409 BARCODE_IN_USE` on create/update.
- `POST /products` / `PATCH /products/:id` accept `cessRate` (percent, 0-100).
- Price changes on `PATCH /products/:id` (selling/cost/MRP/wholesale price,
  GST slab or cess) write an `AuditLog` row (`PRODUCT_PRICE_CHANGED`,
  before/after).

## 6. Dashboard and reports

- `GET /dashboard/summary` returns
  `{ businessDate, timezone, todayGrossSales, todayReturns, todaySales (net),
  todayProfit, todayOrders, todayReturnCount, totalRevenue (net, all time),
  totalOrders, totalCustomers, totalProducts, outstandingUdhar, lowStockCount,
  outOfStockCount, inventoryValue, recentInvoices: [{ id, invoiceNumber, type,
  status, totalAmount, paymentMode, createdAt, customer }], paymentModes:
  [{ mode, amount }] (today, from tenders plus udhar), shift }`.
  Only `SALE` invoices count as sales; `SALES_RETURN` totals are subtracted;
  `CANCELLED` invoices are excluded.
- `GET /dashboard/kpis` returns `{ businessDate, grossRevenue, netRevenue,
  totalRefunds, orders, avgOrderValue }` computed live and cached for 60 s
  under key `shop:{shopId}:analytics:kpis`.
- `GET /dashboard/analytics?range` and `GET /dashboard/trends?days` keep their
  shapes with the same SALE/RETURN/CANCELLED rules and business-day ranges.
- `GET /dashboard/export/invoices.csv?from&to`,
  `GET /dashboard/export/invoice-items.csv?from&to`,
  `GET /dashboard/export/gst-summary.csv?from&to` stream `text/csv`. The
  exports carry the same population as the dashboards: `COMPLETED` `SALE` and
  `SALES_RETURN` invoices only, so a total summed from a file equals the
  dashboard net revenue for the same range.

Cache keys the event processor invalidates after any invoice mutation:
`shop:{shopId}:analytics:dashboard`, `shop:{shopId}:analytics:kpis`,
`shop:{shopId}:analytics:summary`.

## 7. Outbox events (payloads)

All payloads carry `eventId`, `correlationId`, `shopId`, `userId`, `createdAt`.

- `INVOICE_CREATED`: `{ invoiceId, invoiceNumber, type: 'SALE', customerId,
  amount, paymentMode, items: [{ productId, quantity, balanceAfter }] }`
- `INVOICE_RETURNED`: `{ invoiceId, invoiceNumber, originalInvoiceId, amount,
  items: [{ productId, quantity, balanceAfter }] }`
- `INVOICE_CANCELLED`: `{ invoiceId, invoiceNumber, amount, items: [...] }`
- `CUSTOMER_PAYMENT_RECORDED`: `{ customerId, transactionId, amount, tender }`

## 8. Shop

`GET /shops/me` returns `{ id, name, address, city, state, pincode, phone,
email, logoUrl, settings: { gstin, currency, timezone } }`. The POS uses
`state` to decide inter-state GST for a selected customer.

## 9. Accounting model

Every money or stock-value movement posts through `LedgerPostingService`
(balanced double entry, row-locked `LedgerAccountBalance`, immutable
`LedgerTransaction`). Debit-normal accounts: `CASH`, `BANK`,
`ACCOUNTS_RECEIVABLE`, `UDHAR_RECEIVABLE`, `COST_OF_GOODS`, `INVENTORY`,
`INVENTORY_ADJUSTMENT`. Credit-normal: `SALES_REVENUE`, `GST_PAYABLE`,
`ACCOUNTS_PAYABLE`.

| Event | Debit | Credit |
|---|---|---|
| Sale | CASH / BANK (tenders), ACCOUNTS_RECEIVABLE (udhar), COST_OF_GOODS (stocked lines only) | SALES_REVENUE (taxable + round-off), GST_PAYABLE, INVENTORY (stocked lines only) |
| Return / cancellation | the exact reverse of the sale, cost of goods only for lines that physically came back | |
| Customer repayment | CASH / BANK | ACCOUNTS_RECEIVABLE |
| Goods receipt (GRN accepted) | INVENTORY (Σ unitPrice × acceptedQuantity) | ACCOUNTS_PAYABLE |
| Purchase return | ACCOUNTS_PAYABLE | INVENTORY |
| Stock adjustment, damage, loss, expiry, opening balance | delta > 0: INVENTORY / INVENTORY_ADJUSTMENT; delta < 0: INVENTORY_ADJUSTMENT / INVENTORY, at `Product.costPrice` | |

`SERVICE`, `DIGITAL` and custom lines never move `INVENTORY` or
`COST_OF_GOODS`. Valuation basis: receipts and supplier returns post at the
document `unitPrice`; sales, customer returns and adjustments post at the
product's current `costPrice`. `INVENTORY` therefore carries stock at
purchase cost, while the dashboard `inventoryValue` is stock at current cost
price (`InventoryItem.onHand × Product.costPrice`); the two coincide when
receipt prices equal the cost price. There is no weighted-average or FIFO
costing layer.

## 10. Consistency model

- One database transaction per sale, return, cancellation and repayment
  (`READ COMMITTED`). Inside it, rows are locked in one canonical order:
  original `Invoice` (returns/cancellations) → `Shift` → `Customer` →
  `NumberSequence` → `Product` rows in ascending `productId`, exclusive, and
  taken **before** any invoice or return line referencing a product is
  inserted (a child-row insert takes a shared lock on the product; upgrading
  it later would deadlock) → `LedgerAccountBalance` in ascending account.
  The inventory engine re-takes the same product lock (a no-op when already
  held) and serialises the lazy creation of `InventoryItem` rows under it. A
  deadlock or lock-wait rollback (Prisma `P2034`, `P2028`, or MySQL 1213/1205
  surfaced as `P2010`) is retried up to three times with jitter
  (`common/db/serialization-retry.ts`); nothing partial is ever committed.
  Sales of one shop queue on the gapless number lock, so the transaction
  budget (`BILLING_GATEWAY_TIMEOUT_MS`, default 30 s) covers bursts of
  several hundred checkouts.
- Redis stock keys are advisory. The sale path may pre-decrement them, the
  database decides, and every rejected or failed request restores its
  decrement. Redis being down or wrong never blocks or corrupts a sale.
- Outbox rows are staged inside the business transaction and relayed to
  BullMQ afterwards; the processor is idempotent per event id (audit marker
  inside its own transaction), so a duplicate delivery is a no-op.
- Post-commit work (Redis sync, websockets, low-stock notifications) is
  best-effort and never changes money or stock.
- `BillingCheckpoints` names sixteen points inside these transactions
  (`BEFORE_INVOICE` … `BEFORE_COMMIT`). It is a no-op in production and is
  overridden by `test/integration/pos-failure-injection.integration-spec.ts`
  to prove that a failure at any point leaves the database and Redis exactly
  as they were.
- Database guards: `Invoice(shopId, idempotencyKey)` and
  `UdharTransaction(shopId, idempotencyKey)` are unique;
  `InventoryItem(shopId, productId, variantKey, locationId)` is unique with
  `variantKey = variantId ?? '-'` because MySQL treats NULLs as distinct in
  unique indexes; the default warehouse/bin bootstrap of a shop runs under
  the `Shop` row lock for the same reason.

