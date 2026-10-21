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
- Outages (roadmap 9.18 failure drills), on every route: `503
  DATABASE_UNAVAILABLE` with `Retry-After: 5` while the database cannot be
  reached (it used to be a 500 "Internal server error"), and `507
  STORAGE_FULL` when a document write meets a full volume (nothing partial is
  kept). The edge answers `502` with an empty body while the API restarts.
  A 5xx is retry-safe for every keyed write (sale, return, repayment): the
  POS and the return dialog offer Retry with the same `idempotencyKey`, which
  either finds the document a lost answer was about (`200`) or creates it
  once (`201`). Reads are retried by the POS itself: the shop, the current
  shift and the product grid and search try again in the background (1 s,
  2 s, 4 s, 8 s, then every 10 s) after a network failure or a 5xx, so a
  POS opened while the API restarts recovers without a reload.
- Business day and financial year are computed in the shop timezone
  (`ShopSettings.timezone`, default `Asia/Kolkata`). Financial year runs
  April to March.
- Removed surface (roadmap 4.5, 4.7): the parallel stacks that once answered
  `/invoices/generate`, `/returns/initiate`, `/payments/capture`,
  `/sales/orders`, `/sales/workflow`, `/pricing/simulate`, `/events/replay`
  and the duplicate `/events/webhooks` are detached from the application and
  answer 404, and the `sales-events` / `sales-webhooks` queues are gone.
  `/billing/*` is the only sale, return and cancellation path,
  `POST /customers/:id/payments` the only repayment path, and `/webhooks` +
  `/events` (product events) the only webhook path. `GET /sales/events` (§7)
  is the operator view of the outbox and the one route left under `/sales`.

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
  `ERR_INVALID_PRICE`, `ERR_INVALID_LINE_DISCOUNT`, `ERR_AMOUNT_TOO_LARGE`,
  `ERR_INVALID_CESS` (a cess outside 0..100, audit B13).
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
- Helpers the API and the web share (no money arithmetic anywhere else):
  `inclusiveUnitPrice(price, gstRate, cessPercent)` (one unit's price with
  GST and cess, the MRP floor, audit P1-2), `discountLimitAmounts(result,
  limitPercent)` (what a discount limit yields under the engine's rounding,
  audit B4) and `costOfGoodsSlice(unitCost, before, quantity)` (the
  cumulative cost of goods of a sale or return line, audit B16).
- The magic preview value `amountPaid = 99999999` no longer exists.

```ts
InvoiceMathEngine.calculateReturn(input: ReturnMathInput): ReturnCalculationResult
```

Proportional return math for partial returns. Each line carries the original
stored amounts and the quantity being returned; the result has per-line
amounts scaled by `quantity / originalQuantity` (2 dp, half-up) as
cumulative slices (`CALCULATION_SPEC.md`), each line's `lineSubtotal` is its
taxable amount plus its discount, and the totals settle against the sale.

## 2. Billing

Roles: `CASHIER`, `MANAGER`, `ADMIN`, `OWNER`, `SUPER_ADMIN` unless noted.

### `POST /billing/calculate`

Body: `{ items: [{ productId, quantity, discountPercent? }], customerId?,
placeOfSupply?, discountAmount?, discountPercentage?, discountType?,
discountReason? }`. The server resolves prices, GST rate and `isInterState`
(the shop's state against `placeOfSupply`, see "Place of supply" below; the
customer's state never decides). Response: the engine result (payment
`null`) plus `{ isInterState, shopState, customerState, placeOfSupply }`.
The MRP rule, the discount and custom-line authority of `POST
/billing/invoice` apply (`409 PRICE_ABOVE_MRP`, `403
DISCOUNT_REQUIRES_APPROVAL`, `403 CUSTOM_LINE_REQUIRES_APPROVAL`).

### `POST /billing/invoice`

Body

```ts
{
  idempotencyKey: string (uuid v4),
  items: [{ productId?, quantity, discountPercent?,
            custom?: { name (1..120), unitPrice (> 0), gstRate: 'ZERO'|'FIVE'|'TWELVE'|'EIGHTEEN'|'TWENTYEIGHT', unit?: ProductUnit } }],
  customerId?, notes?, shiftId?,
  placeOfSupply?: string (an Indian state or union territory; omitted = over the counter),
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
  `mrp` = one unit's price with GST. The `stock` array of the response
  excludes them.
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
  mechanism. `Product.sellingPrice` is before GST; `Product.mrp` is the
  printed, tax-inclusive MRP (Legal Metrology, audit P1-2). A catalogue line
  whose product would sell above its MRP, one unit with GST and cess
  (`inclusiveUnitPrice`: what the engine bills for one undiscounted unit,
  the higher of the CGST + SGST and the IGST split), is refused before
  anything is written (`409 PRICE_ABOVE_MRP`, details `{ productId,
  productName, mrp, inclusivePrice, sellingPrice }`); an MRP of 0 means none
  is printed and is not checked. The products API keeps new rows inside the
  rule (§5); this catches older rows and imports.
- **Place of supply** (audit P1-3; IGST Act s.10(1)(c)): goods sold over the
  counter are supplied where the shop is, so a sale is intra-state (CGST +
  SGST) whatever state the customer's profile names. Only an explicit
  `placeOfSupply` (a delivery, a registered buyer's state) that differs from
  the shop's state makes it inter-state (IGST). Any spelling
  `canonicalState` knows ("New Delhi", "Orissa", any case and spacing) is
  read as the canonical state; anything else is 400. A shop without a state
  never bills IGST. The POS sends no place of supply. Returns and
  cancellations keep the sale's own `isInterState`.
- **Discount authority**: a `CASHIER` may apply at most
  `BILLING_CASHIER_MAX_DISCOUNT_PERCENT` (default 10) percent. Percentages
  the cashier typed are compared as typed: every line discount (custom lines
  included) and an invoice `PERCENTAGE`. Amounts are compared with what the
  limit itself yields under the engine's rounding
  (`discountLimitAmounts`, audit B4): the invoice discount with the limit of
  the post-line-discount subtotal, and the combined discount (line +
  invoice) with the larger of the limit applied once to the subtotal or on
  every line, so a 10 % line discount cannot be stacked with a 10 % invoice
  discount while 10 % of ₹10.05 (₹1.01, i.e. 10.05 %) passes. Above that a
  `MANAGER`+ must bill the invoice (`403 DISCOUNT_REQUIRES_APPROVAL`, details
  `{ maxPercent, requestedPercent }`).
  A cashier's custom line is capped at `BILLING_CASHIER_MAX_CUSTOM_LINE_AMOUNT`
  rupees per line (default 500; 0 means cashiers cannot add custom lines),
  and the sum of a cashier's custom lines on one invoice at
  `BILLING_CASHIER_MAX_CUSTOM_TOTAL_AMOUNT` (default 1000, audit B5): above
  either a `MANAGER`+ must bill the invoice (`403
  CUSTOM_LINE_REQUIRES_APPROVAL`, details `{ maxAmount, lineAmount, name }`
  or `{ maxTotal, customTotal }`). The invoice stores the invoice-level
  discount as the engine applied it (audit B15): `discountType`
  `PERCENTAGE` with its `discountPercentage`, or `FIXED_AMOUNT` with
  `discountPercentage` null, both null when no invoice-level discount
  applied; `discountAmount` is the total discount (lines + invoice). Whenever any line or invoice discount is applied, the
  billing user is stamped as `approvedBy` / `approvalTimestamp` and the audit
  row records the amounts. The engine's hard limit is 100% and never more
  than the subtotal.
- Credit sales require a customer and are checked against `creditLimit`
  under a row lock. Managers and above may override the limit
  (server-side role check), but never past the largest balance the column
  holds: a balance above 99,999,999.99 is `409 OUTSTANDING_BALANCE_TOO_LARGE`
  (audit B14). Inactive customers cannot be billed or take
  payments (`409 CUSTOMER_INACTIVE`); their existing invoices can still be
  returned and cancelled.
- Everything (invoice, items, payments, stock, udhar, shift, ledger, audit,
  outbox) commits in one transaction or nothing does.
- Same key + same bill returns the existing invoice with `200`. The same
  bill is the same lines, customer, discount, place of supply, tender
  amounts and credit: `tenderedAmount` (the cash handed over) is not part of
  it (audit P1-4), so a retry after a lost answer replays even when the
  cashier typed another note. Same key + a different bill returns `422
  IDEMPOTENCY_KEY_REUSED` with details `{ invoiceId, invoiceNumber }` of the
  bill the key already saved, including when two requests race for the key;
  the POS then shows that bill instead of billing the cart again. A key
  stored before this rule (its hash included the cash tendered) still
  replays the identical request.

Response `201`: `{ invoice, stock: [{ productId, balanceAfter }], shiftId }` where
`invoice` includes `items`, `payments`, `customer`.

Error codes: `PRODUCT_NOT_FOUND` (404), `INSUFFICIENT_STOCK` (409, details
`{ productId, productName, requestedQty, availableQty }`),
`CREDIT_LIMIT_EXCEEDED` (409, details `{ creditLimit, currentBalance,
requestedAmount, projectedBalance }`), `CUSTOMER_REQUIRED` (400),
`CUSTOMER_INACTIVE` (409), `CUSTOM_ITEM_INVALID` (400),
`DISCOUNT_REQUIRES_APPROVAL` (403), `CUSTOM_LINE_REQUIRES_APPROVAL` (403),
`PRICE_ABOVE_MRP` (409), `OUTSTANDING_BALANCE_TOO_LARGE` (409),
`SHIFT_INVALID` (409), `SHIFT_FORBIDDEN` (403), `IDEMPOTENCY_KEY_REUSED`
(422, details `{ invoiceId, invoiceNumber }`), engine codes above (400,
including `ERR_INVALID_CESS` for a cess outside 0..100 and
`ERR_PAYMENT_MISMATCH` when a price changed since the client's preview: the
POS re-reads the cart's prices and says which changed),
`MAX_RETRIES_EXCEEDED` (409).

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
the remainder is refunded through `refund.tender`; without one, through the
sale's own tender when it was paid by a single tender with no credit, else
`CASH` (audit B6). A cash
refund requires an OPEN shift: the refund posts to the sale's own shift while
it is open and usable by the caller (its cashier, or a `MANAGER`+), otherwise
to the caller's own open shift.

- **Cashier authority** (audit B6): a `CASHIER` takes a return on their own
  up to `BILLING_CASHIER_MAX_REFUND_AMOUNT` (default 2000) rupees per return
  document, against a sale at most `BILLING_CASHIER_RETURN_WINDOW_DAYS`
  (default 7) business days old; beyond either it is `403
  RETURN_REQUIRES_APPROVAL` (details `{ maxRefund, refund, windowDays,
  saleAgeDays }`) and a `MANAGER`+ takes it.
- **Goods that cannot be resold** (audit B7): a return with `reason`
  `DAMAGED` or `EXPIRED` is refunded but not restocked, and its cost stays
  in cost of goods (no `INVENTORY` / `COST_OF_GOODS` reversal); every other
  reason restocks. The reconciliation (§11) expects exactly that, since it
  rebuilds cost of goods from the stock movements.
- **GST credit-note time limit** (CGST s.34(2), audit B8): no return after
  30 November following the end of the financial year of the sale, in the
  shop's time zone and on the application clock: `409
  RETURN_PAST_GST_DEADLINE` (details `{ invoiceId, invoiceNumber, deadline }`);
  the shop refunds outside the app, since the output tax can no longer be
  reduced.
- **Cost of goods** (audit B16): a sale books each line's cost rounded per
  line, and a return books the cumulative slice of its line,
  `round2(cost × (returned before + quantity)) − round2(cost × returned
  before)` (`costOfGoodsSlice`), so the returns of a line give back exactly
  what its sale booked; the reconciliation expects the same slices.

Return math is cumulative (roadmap 3.1; `CALCULATION_SPEC.md`): each line
refunds `cum(returnedQuantity + quantity) − cum(returnedQuantity)` of its
stored amounts, the document is not rounded to the rupee on its own, and its
total is settled against the sale: never more than
`invoiceTotal − Σ earlier returns`, and exactly that remainder when the
return completes the sale (that is where the sale's round-off is refunded).
A line with nothing left to refund (a free item) never keeps a sale from
completing (audit B11). Each return row adds up: its `subtotal` is its
taxable amount plus its discount (audit B10).
So the returns of a sale add up to its `totalAmount`, whatever the split.
Returns and cancellations work on soft-deleted products and customers; only
new sales are refused.

Response `201`: return invoice (type `SALES_RETURN`) with items and payments;
`200` with the stored return for the same key and request, also when two
requests race for the key (never `409 DB_P2002`).
Codes: `INVOICE_NOT_FOUND`, `INVOICE_NOT_RETURNABLE`, `RETURN_QTY_EXCEEDS`,
`SHIFT_REQUIRED`, `RETURN_REQUIRES_APPROVAL` (403),
`RETURN_PAST_GST_DEADLINE` (409), `IDEMPOTENCY_KEY_REUSED` (422, details `{
invoiceId, invoiceNumber }` of the return the key already recorded).

### `POST /billing/invoices/:id/cancel`

Roles: `MANAGER`, `ADMIN`, `OWNER`, `SUPER_ADMIN`. Body `{ reason }`. Only a
`SALE` with no returns, on the same business day, can be cancelled. Stock,
udhar, shift, ledger are reversed; the invoice becomes `CANCELLED` and keeps
its number. Codes: `INVOICE_NOT_CANCELLABLE`.

## 3. Shifts

- `POST /shifts/open { openingCash }` returns the shift; `409 SHIFT_ALREADY_OPEN`. One open shift per cashier is enforced by the database (unique key on `Shift.openToken`, roadmap 8.3), so two concurrent opens never both succeed.
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
- `creditLimit` (create or update) is accepted from `MANAGER`+ only
  (`403 CREDIT_LIMIT_REQUIRES_MANAGER`); a change writes an `AuditLog` row
  `CUSTOMER_CREDIT_LIMIT_CHANGED` in the same transaction. Without one, a
  customer a `MANAGER`+ creates gets `SALES_DEFAULT_CREDIT_LIMIT` and one a
  `CASHIER` creates gets 0 (audit B9). `creditLimit` and a payment `amount`
  are at most 99,999,999.99 (the column, audit B14; 400 above).
- `state` is an Indian state or union territory, stored in its canonical
  spelling (`canonicalState`: "orissa" → "Odisha", "New Delhi" → "Delhi");
  anything else is 400, `''` clears it (audit B3). It is part of the
  address: it never decides IGST (§2 "Place of supply").
- `phone` is unique among the shop's live customers (unique index
  `(shopId, phone, deletedToken)`; `409 CUSTOMER_PHONE_IN_USE`, also under
  concurrent creates). A soft-deleted customer frees its phone number.
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
  the balance may go negative (advance / store credit), never below
  −99,999,999.99 (`409 OUTSTANDING_BALANCE_TOO_LARGE`). Inactive customers are
  rejected (`409 CUSTOMER_INACTIVE`). Response `{ customer, transaction }`;
  the same key with the same payment replays it, a different one is `422
  IDEMPOTENCY_KEY_REUSED` with details `{ transactionId, customerId, amount,
  tender }` of what was recorded. The ledger and invoice lists are newest
  first, ties broken by id.
- `POST /customers/search { query, skip?, take? }` returns an array.
- `DELETE /customers/:id` soft-deletes; `409 CUSTOMER_HAS_BALANCE` when the
  outstanding balance is not zero.
- Opening udhar (roadmap 9.20, written by the customer import of §13 through
  `CustomersService.recordOpeningBalance`): what the customer owed
  (positive) or had paid in advance (negative) on the shop's first day. One
  `ADJUSTMENT` ledger row with `reference` "Opening balance" and
  `idempotencyKey` `OPENING:<customerId>`, `balanceBefore` 0, no invoice, no
  shift; MANAGER+. Once per customer: the same amount again is UNCHANGED,
  another is `409 OPENING_BALANCE_EXISTS`, and a customer whose udhar already
  moved (any ledger row, or a balance from before) is
  `409 OPENING_BALANCE_AFTER_ACTIVITY`: a difference is a repayment or a
  credit sale.

Roles: reads for all roles; create/update/payments for `CASHIER`+; delete for
`MANAGER`+.

## 5. Products and search

- `GET /products?q&limit&offset&categoryId&stock` (limit max 200, default 50)
  returns an array of products with `currentStock`, `reorderPoint`, `gstRate`,
  `unit`, `sellingPrice`, `mrp`, `barcode`, `type`, `isActive`, `category`,
  and describes the page in `X-Total-Count` / `X-Page-Skip` / `X-Page-Take`
  (roadmap 6.2). `stock` is `out` (no stock), `low` (at or below the
  product's reorder point) or `in`; services and digital goods are never
  `out` or `low`. A `limit`/`offset`/`stock` outside its range is 400.
- `POST /products`: `sku` is optional; without one the API numbers it
  `SKU-000001`… per shop (`NumberSequence`, entity `PRODUCT_SKU`), drawing
  past any number a live product already holds (typed, imported or edited
  in) inside the same transaction, up to 1000 draws (`409
  SKU_SEQUENCE_EXHAUSTED`), so one such product never blocks later creates
  (audit P1-6). A client never invents a SKU or a cost price.
  `wholesalePrice` defaults to the selling price.
- `sellingPrice` is before GST; `mrp` is the tax-inclusive MRP and must be at
  least one unit's price with GST and cess (`inclusiveUnitPrice`), else `400
  PRICE_ABOVE_MRP` (details `{ mrp, inclusivePrice, sellingPrice }`).
  Omitted on create (or `null` on update) it is that inclusive price. A
  `PATCH` that changes the selling price, GST slab, cess or MRP re-checks the
  pair; one that changes none of them leaves an older product as it is.
  Prices are 0..99,999,999.99 (audit P1-2).
- `categoryId`, `supplierId` and `brandId` on create and update must name a
  live row of the caller's shop (`assertOwned`, 404 otherwise; audit P1-1).
- `GET /search?q&limit` returns lean results `{ id, name, sku, barcode,
  sellingPrice, mrp, gstRate, cessRate, unit, currentStock, type, isActive,
  imageUrl, categoryName }` ranked by relevance (exact barcode/SKU first,
  then name). Products whose name, SKU or alias holds the whole query are
  ranked before any product that shares only a word with it, so a product
  typed in full is found however many others share its words (roadmap
  9.19). `q` (here, on `/search/suggestions` and on `/products`) is
  normalised and cut to 100 characters, never rejected for length; a
  repeated `q` reads as its first value. Search history is recorded up to
  `SEARCH_HISTORY_MAX_PER_MINUTE` searches per shop and minute; a search past
  that budget is answered but not recorded.
- `GET /search/barcode/:code` returns exactly one product (the lean shape
  above, plus `variantId` for a variant's barcode) or
  `404 BARCODE_NOT_FOUND`; `409 BARCODE_AMBIGUOUS` with `details.candidates`,
  one lean product per match (price and stock included, so the POS picker
  can sell the chosen one). Ambiguity comes from an alternate barcode
  (`ProductBarcode`) or a variant carrying another product's code.
- Barcodes are unique per shop: `409 BARCODE_IN_USE` on create/update.
- `POST /products` / `PATCH /products/:id` accept `cessRate` (percent, 0-100)
  and `reorderPoint` (the low-stock level in the product unit, >= 0; 10 when
  absent).
- Price changes on `PATCH /products/:id` (selling/cost/MRP/wholesale price,
  GST slab or cess) write an `AuditLog` row (`PRODUCT_PRICE_CHANGED`,
  before/after).

## 6. Dashboard and reports

- Financial figures are for `FINANCE_ROLES` (OWNER, ADMIN, SUPER_ADMIN,
  MANAGER; `apps/api/src/auth/role-sets.ts`): cost prices, profit and margin,
  stock at cost, supplier payables and purchasing, expenses. For a CASHIER or
  a VIEWER, `GET /dashboard/analytics`, `GET /dashboard/products`, the
  `/suppliers`, `/expenses`, `/purchases`, `/grn`, `/purchase-returns`,
  `/vendor-bills`, `/supplier-credit-notes`, `/purchase-analytics` and
  `/purchase-events` reads answer 403, and every other answer leaves out
  each field whose name holds `cost`, `profit`, `margin`, `payable` or `cogs`
  and the stock valuations (`inventoryValue`, `stockValue`, `valuation`):
  `FinancialFieldsInterceptor`, at any depth (product, invoice line, batch,
  revision snapshot, event payload). Selling price, MRP, taxes, discounts,
  invoice totals, udhar and drawer cash are unchanged.

- `GET /dashboard/summary` returns
  `{ businessDate, timezone, failedSections, todayGrossSales, todayReturns,
  todaySales (net), todayProfit (gross profit: taxable value minus the cost
  of goods the ledger booked, i.e. only lines whose stock moved: SERVICE,
  DIGITAL and custom lines carry none; sales minus returns), todayOrders,
  todayReturnCount, totalRevenue (net, all time), totalOrders,
  totalCustomers, totalProducts, outstandingUdhar (the sum of the positive
  customer balances: an advance never offsets another customer's due),
  customerAdvances (the sum of the negative balances, as a positive figure),
  lowStockCount, outOfStockCount, lowStockItems (at most 5),
  inventoryValue, recentInvoices: [{ id, invoiceNumber, type, status,
  totalAmount, paymentMode, createdAt, customer }] (last 10, all time,
  COMPLETED and CANCELLED), paymentModes: [{ mode, amount }] (today, sale
  tenders plus udhar minus refund tenders and credit reversed, so they add up
  to today's net sales), shift }`.
  Only `SALE` invoices count as sales; `SALES_RETURN` totals are subtracted;
  `CANCELLED` invoices are excluded.
  Each part (`today`, `todayProfit`, `allTime`, `customers`, `products`,
  `udhar`, `stock`, `inventoryValue`, `recentInvoices`, `paymentModes`,
  `shift`) loads independently: a part that fails is listed in
  `failedSections`, its figures are `null` and its lists empty, and the rest
  of the response is authoritative. Only when every part fails does the route
  answer `503 DASHBOARD_UNAVAILABLE`. `restrictedSections` lists the parts
  not computed for the caller's role: `[]` for FINANCE_ROLES,
  `['todayProfit', 'inventoryValue']` for a CASHIER or VIEWER, whose answer
  carries neither figure.
- Stock alerts (`lowStockCount`, `outOfStockCount`, `lowStockItems`,
  `GET /dashboard/low-stock`) cover active (`isActive`), non-deleted,
  stock-tracked products (not `SERVICE`/`DIGITAL`): out of stock is
  `currentStock <= 0`, low stock is `0 < currentStock <= reorderPoint`.
- `GET /dashboard/low-stock?limit` (1..500, default 100) returns
  `{ lowStockCount, outOfStockCount, items: [{ productId, name, sku, unit,
  currentStock, reorderPoint, status: OUT_OF_STOCK | LOW_STOCK }] }`, out of
  stock first, then lowest stock relative to the reorder point.
- `GET /dashboard/kpis` returns `{ businessDate, grossRevenue, netRevenue,
  totalRefunds, orders, avgOrderValue (net revenue / orders, as on the
  Reports page) }` computed live and cached for 60 s under key
  `shop:{shopId}:analytics:kpis`.
- `GET /dashboard/insights` (the dashboard's AI insights card) returns
  `{ businessDate, generatedAt, failedSections, restrictedSections, forecast: { forecastNetRevenue,
  basisDays, confidence, basisFrom, basisTo, todayNetSales, progressPct },
  restock: { basisDays: 30, coverDays: 14, items: [{ productId, name, sku,
  unit, currentStock, reorderPoint, avgDailyUnits, daysOfCover,
  suggestedQuantity, urgency: OUT_OF_STOCK | CRITICAL | LOW, reason }] },
  topProduct }`. The forecast is the 7-day moving average of net daily sales;
  restock velocity is net units sold over the last 30 business days;
  suggestions cover stock-alert products plus products with under 7 days of
  cover, and refill to reorder point plus 14 days of demand. Sections fail
  independently like the summary (`503 INSIGHTS_UNAVAILABLE` only when all
  fail). `topProduct` is ranked by gross profit, so a CASHIER or VIEWER gets
  `topProduct: null` with `restrictedSections: ['topProduct']`.
- `GET /dashboard/analytics?range` (FINANCE_ROLES) and `GET /dashboard/trends?days` keep their
  shapes with the same SALE/RETURN/CANCELLED rules and business-day ranges.
  The analytics `kpis` carry `grossProfit` (as `todayProfit`, over the
  range), `expenses` (live expenses whose `expenseDate` falls in the range,
  paid or pending), `netProfit = grossProfit − expenses` (the "Net Profit"
  tile), `udharOutstanding` and `customerAdvances` (as the summary).
- `GET /dashboard/export/invoices.csv?from&to`,
  `GET /dashboard/export/invoice-items.csv?from&to`,
  `GET /dashboard/export/gst-summary.csv?from&to` stream `text/csv`.
  `invoices.csv` lists the `SALE` and `SALES_RETURN` documents created in the
  range that are `COMPLETED` or `CANCELLED`, with `status` and `cancelledAt`
  (a cancelled sale keeps the GST serial number it used); its `COMPLETED`
  rows sum to the dashboard net revenue for the same range. Both document
  files carry `cessAmount` (an invoice's is the sum of its lines'; it is part
  of `taxAmount`). `invoice-items.csv` and the GST summary cover `COMPLETED`
  documents only. Cells a spreadsheet would run as a formula (a leading `=`,
  `+`, `-`, `@`, tab or CR, a plain number excepted) are prefixed with an
  apostrophe, the rule of the import reports. `from` / `to` must be calendar
  days (`400 INVALID_DATE` for `2026-02-30`; the invoice list's `from` / `to`
  too).

Analytics cache keys, dropped right after every committed sale, return and
cancellation (`BillingHelpers.afterStockChange`) and again by the event
processor when the invoice event is relayed:
`shop:{shopId}:analytics:dashboard`, `shop:{shopId}:analytics:kpis`,
`shop:{shopId}:analytics:summary`, `shop:{shopId}:analytics:allTime` (the
all-time totals of the summary, roadmap 5.5).

The web dashboard polls summary, KPIs and trend every 30 s while the tab is
visible (never overlapping a poll still in flight), times dashboard requests
out after 15 s, rejects payloads that do not have the documented shape, and
renders every card's loading, empty, error and stale states independently.

## 7. Outbox events (payloads)

All payloads carry `eventId`, `correlationId`, `shopId`, `userId`, `createdAt`.

- `INVOICE_CREATED`: `{ invoiceId, invoiceNumber, type: 'SALE', customerId,
  amount, paymentMode, items: [{ productId, quantity, balanceAfter }] }`
- `INVOICE_RETURNED`: `{ invoiceId, invoiceNumber, originalInvoiceId, amount,
  items: [{ productId, quantity, balanceAfter }] }`
- `INVOICE_CANCELLED`: `{ invoiceId, invoiceNumber, amount, items: [...] }`
- `CUSTOMER_PAYMENT_RECORDED`: `{ customerId, transactionId, amount, tender }`

Lifecycle (roadmap 4.7): a row is staged `PENDING` inside the business
transaction. After the commit the system-events relay claims a batch
(`CLAIMED`, one `READ COMMITTED` transaction with `FOR UPDATE SKIP LOCKED`),
enqueues it, and the `system-events` worker ends it: `DONE`, or `PENDING`
again with an exponential backoff (`EVENTS_OUTBOX_RETRY_BACKOFF_MS`, capped by
`EVENTS_OUTBOX_RETRY_BACKOFF_MAX_MS`) until `EVENTS_OUTBOX_MAX_RETRIES`
attempts are spent, then `FAILED`. A claim no worker finished within
`EVENTS_OUTBOX_STALE_CLAIM_MS` is reaped back to `PENDING`.

Operator routes: `GET /sales/events?status=` lists the shop's rows, newest
first (`SALES_RECENT_EVENTS_LIMIT`); `GET /sales/events/:id` returns one
(`404 OUTBOX_EVENT_NOT_FOUND`); `POST /sales/events/retry { eventId }`
(`MANAGER`+) resets a `FAILED` row to `PENDING` under a fresh job id, and is
`409 OUTBOX_EVENT_NOT_FAILED` for any other status.

## 8. Shop

`GET /shops/me` returns `{ id, name, address, city, state, pincode, phone,
email, logoUrl, settings: { gstin, currency, timezone } }`. `state` is the
shop's place of supply: a sale is inter-state only when an explicit
`placeOfSupply` differs from it (§2), and a shop without a state never bills
IGST.

## 9. Accounting model

Every money or stock-value movement posts through `LedgerPostingService`
(balanced double entry, row-locked `LedgerAccountBalance`, immutable
`LedgerTransaction`). Each posting writes one `LedgerPosting` header keyed by
its business source, `(shopId, sourceType, sourceId)` with a unique index:
`SALE` / `RETURN` / `CANCELLATION` (invoice id), `CUSTOMER_PAYMENT` (udhar
transaction id), `GRN`, `PURCHASE_RETURN`, `ADJUSTMENT_REQUEST`,
`STOCK_ADJUSTMENT`, `VENDOR_BILL`, `SUPPLIER_CREDIT_NOTE` (their document
ids), `SUPPLIER_PAYMENT` (SupplierPayment id), `SUPPLIER_OPENING_BALANCE`
(the Supplier id), `OPENING_BALANCE` (the opening udhar's UdharTransaction id), `EXPENSE`
(the Expense id) and `EXPENSE_ADJUSTMENT` (`<Expense id>:<n>`, each later
change of a posted expense). A replay of an already-posted
source posts nothing; a concurrent duplicate fails on the index and its
transaction rolls back. Every `LedgerTransaction` row carries the header's
`postingId`. Debit-normal accounts: `CASH`, `BANK`,
`ACCOUNTS_RECEIVABLE`, `UDHAR_RECEIVABLE`, `COST_OF_GOODS`, `INVENTORY`,
`INVENTORY_ADJUSTMENT`, `INPUT_GST` (GST paid on purchases), `EXPENSES`. Credit-normal: `SALES_REVENUE`, `GST_PAYABLE`,
`ACCOUNTS_PAYABLE`, `OPENING_BALANCE_EQUITY` (the shop's capital on its
first day: the contra of every opening balance, roadmap 9.20).

| Event | Debit | Credit |
|---|---|---|
| Sale | CASH / BANK (tenders), ACCOUNTS_RECEIVABLE (udhar), COST_OF_GOODS (stocked lines only) | SALES_REVENUE (taxable + round-off), GST_PAYABLE, INVENTORY (stocked lines only) |
| Sale under ₹0.50 (rounds to ₹0) | as above | the negative round-off exceeds the taxable amount, so revenue posts 0 and the shortfall comes off GST_PAYABLE (`splitRevenue`); both entries stay >= 0 |
| Return / cancellation | the exact reverse of the sale, cost of goods only for lines that physically came back | |
| Customer repayment | CASH / BANK | ACCOUNTS_RECEIVABLE |
| Goods receipt (GRN accepted) | INVENTORY (Σ unitPrice × acceptedQuantity; `unitPrice` is the order line's net cost: after its discount, GST excluded) | ACCOUNTS_PAYABLE |
| Vendor bill posted (source `VENDOR_BILL`) | INPUT_GST (the bill's tax); INVENTORY (bill base − receipt value of the billed lines, billed qty × receipt unit cost, when positive); EXPENSES (base of SERVICE / DIGITAL lines) | INVENTORY (that difference when negative); ACCOUNTS_PAYABLE (the net: after the bill the supplier is owed exactly the bill's total) |
| Purchase return | ACCOUNTS_PAYABLE | INVENTORY |
| Supplier credit note issued, not backed by a return (source `SUPPLIER_CREDIT_NOTE`) | ACCOUNTS_PAYABLE (the note) | INPUT_GST (its tax), INVENTORY (the rest: the credit lowers what the goods cost) |
| Supplier credit note issued for a COMPLETED purchase return | ACCOUNTS_PAYABLE (the part of the return's notes above the return's posted value: its GST) | INPUT_GST |
| Supplier opening balance (source `SUPPLIER_OPENING_BALANCE`) | OPENING_BALANCE_EQUITY | ACCOUNTS_PAYABLE |
| Supplier payment / vendor-bill payment | ACCOUNTS_PAYABLE | CASH (tender `CASH`) / BANK (other tenders) |
| Stock transfer between locations | nothing: the stock keeps its value | |
| Stock adjustment, damage, loss, expiry | delta > 0: INVENTORY / INVENTORY_ADJUSTMENT; delta < 0: INVENTORY_ADJUSTMENT / INVENTORY, at `Product.costPrice` | |
| Opening stock (adjustment reason `OPENING_BALANCE`, manual or imported) | INVENTORY | OPENING_BALANCE_EQUITY, at `Product.costPrice` (a negative opening the other way round) |
| Opening udhar (source `OPENING_BALANCE`) | ACCOUNTS_RECEIVABLE (owed) / OPENING_BALANCE_EQUITY (advance) | OPENING_BALANCE_EQUITY (owed) / ACCOUNTS_RECEIVABLE (advance) |
| Expense paid (created paid, or marked paid; source `EXPENSE`) | EXPENSES | CASH (mode Cash) / BANK (UPI, Card, Bank Transfer) |
| Expense edited or deleted (source `EXPENSE_ADJUSTMENT`) | the difference between what the expense's postings hold and what it now implies (a delete or a switch to pending reverses it all) | |

`Supplier.pendingPayables` is the per-supplier view of `ACCOUNTS_PAYABLE`,
maintained in the same transaction as each posting through
`SupplierPayablesService` (opening balance, receipt and posted bill add;
purchase return and issued credit note subtract; payment subtracts under a
guard: paying more than is owed is `409 PAYABLES_INSUFFICIENT`). A balance
below zero is an advance the supplier holds (goods returned after they were
paid for); it is kept, never floored, and the web shows it as "advance". A
supplier with a balance either way cannot be deleted (`409
SUPPLIER_HAS_BALANCE`); a deleted supplier takes no new purchase order,
receipt, return, bill or credit note (404). `POST /suppliers/:id/payments
{ amount, tender?, reference?, idempotencyKey, notes? }` (the key is
required; the web makes one per payment dialog and reuses it on a retry)
and `POST /vendor-bills/:id/pay { paymentAmount, tender?, reference?,
idempotencyKey? }` both record a `SupplierPayment` (the ledger source,
replayed per idempotency key; the same key for another payment is 409
`IDEMPOTENCY_KEY_REUSED`). A `CASH` payment by someone with an open shift
leaves that drawer (`SupplierPayment.shiftId`, `Shift.cashPayouts`, lower
`expectedCash`). Lock order of every payable writer: the document (bill,
note, return), `Shift`, `Supplier`, then `LedgerAccountBalance`; a payment
transaction is READ COMMITTED with the deadlock retry.
`GET /suppliers/summary` answers `{ totalPayables, count, activeCount }`
over every live supplier (`totalPayables` a decimal string).
`SupplierPayablesService.payablesFromLedger` rebuilds the balance from
`openingPayables` (the authority for the opening part, posted or not) and
the net ACCOUNTS_PAYABLE credit of the supplier's receipts, bills, returns,
credit notes and payments.

Procurement documents (purchase orders, goods receipts, vendor bills,
purchase returns, credit notes) change state under a row lock with a
compare-and-set on the status (`409 <DOC>_STATE_CONFLICT` for the loser). A
receipt values its lines at the order line's net cost; without a
`warehouseId` it lands in the warehouse of the POS sale location (a shop
with other warehouses must name one: `400 GRN_WAREHOUSE_REQUIRED`). A
vendor bill is three-way matched: every line names its order line and its
receipt line, which must agree with each other, the product and the bill's
supplier / order / receipt; the receipt must be ACCEPTED, COMPLETED or
CLOSED; the unit price before GST must equal the order line's net cost
within `PURCHASE_BILL_PRICE_TOLERANCE_PERCENT` (default 0, `400
VENDOR_BILL_PRICE_MISMATCH`), and the quantity billed over every live bill
of a receipt line never exceeds what it accepted. A purchase return takes
the variant and the warehouse from the receipt line it returns. A credit
note for a purchase return needs the return COMPLETED, and the live notes of
one return never exceed its value. `POST .../:id/reject` (a manager other
than the creator or submitter) and `POST .../:id/cancel` exist for
purchase returns, vendor bills and credit notes (pending decision → REJECTED;
DRAFT / SUBMITTED / PENDING_APPROVAL → CANCELLED) and for goods receipts
before acceptance (RECEIVING / PARTIALLY_RECEIVED / QUALITY_INSPECTION →
REJECTED; DRAFT … QUALITY_INSPECTION → CANCELLED). A purchase-order draft is
totalled by the server, and whoever edited it cannot approve it.

Stock moves between locations with `POST /inventory-domain/transfer
{ productId, variantId?, fromLocationId, toLocationId, quantity,
idempotencyKey }` (MANAGER+): one transaction, the product row locked, a
TRANSFER_OUT at the source (`409 INSUFFICIENT_STOCK` when it does not hold
the quantity) and a TRANSFER_IN at the destination, keyed for replay. This
is how goods received into a back warehouse reach the sale location the POS
sells from. Legacy stock (`Product.currentStock` without an inventory row)
opens only at the sale location, whichever location moves first.

`POST /inventory-domain/:id/adjust { reason, quantityChange, notes?,
correlationId?, idempotencyKey? }` (MANAGER+): `quantityChange` is non-zero,
3 decimals, at most ±999,999,999.999; a keyed request replays (the same key
for another item or quantity is 409 `IDEMPOTENCY_KEY_REUSED`); an
`OPENING_BALANCE` is positive and once per item (`409 OPENING_STOCK_EXISTS`);
a MANAGER moves at most `INVENTORY_MANAGER_MAX_ADJUST_VALUE` (default ₹5000,
|quantity| × cost price) directly, more is `403
ADJUSTMENT_REQUIRES_APPROVAL` (an owner, or a stock-count adjustment approved
by another manager). A stock count snapshots `onHand` when its session
starts (the rows read under a shared lock, `startedAt` taken after the
read); a counted item's variance is counted − (snapshot + the item's stock
movements between the snapshot and `countedAt`), recomputed when the
adjustment is approved, so a sale during the count is never subtracted
twice; a count item carries at most one live adjustment request (`409
ADJUSTMENT_ALREADY_REQUESTED`).

Every posting is reconciled against its document nightly and on demand
(§11): the entries above are the ones the reconciliation expects, and the
cost-of-goods entries are expected only for the lines whose stock moved.

`SERVICE`, `DIGITAL` and custom lines never move `INVENTORY` or
`COST_OF_GOODS`. Valuation basis: receipts and supplier returns post at the
document `unitPrice` (net of discount, GST excluded); sales, customer
returns and adjustments post at the product's current `costPrice`. Every
accepted receipt line moves `Product.costPrice` to the moving average of
what was on hand and what arrived (`(onHand × costPrice + accepted × net
unit cost) / (onHand + accepted)`, stock below zero counted as none, 2 dp),
so the cost of goods a sale takes out of `INVENTORY` is what the receipts
put in; the remaining difference is rounding, a vendor bill's price
difference (posted to `INVENTORY` without moving the cost price) and a
manual cost-price edit. The dashboard `inventoryValue` is stock at current
cost price (`InventoryItem.onHand × Product.costPrice`). There is no FIFO
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
- Document numbers are GST serial numbers (CGST Rule 46(b), Rule 53(1A)):
  `INV-<yyYY>-NNNNNN` for a sale and `RET-<yyYY>-NNNNNN` for a return
  (credit note), where `<yyYY>` is the financial year in four digits
  (`2026-27` → `2627`): 15 characters, consecutive, one series per shop,
  kind and financial year (`InvoiceNumberService`, which refuses to issue
  anything over 16 characters or outside letters, digits, `-` and `/`).
  Numbers issued before roadmap 9.24 (`INV-2026-27-000001`, 18 characters)
  keep their own series; `docs/compliance/GST_INVOICE_CHECK.md` records the
  check.
- Redis stock keys are advisory. The sale path may pre-decrement them, the
  database decides, and every rejected or failed request restores its
  decrement. Redis being down or wrong never blocks or corrupts a sale, and
  never stalls one: every Redis client on the request path fails fast while
  Redis is unreachable (the shared client has no offline queue; the cache
  store's offline queue is off since the 5-minute Redis drill of roadmap
  9.18 found each sale waiting on its post-commit cache invalidation until
  Redis returned).
- Outbox rows are staged inside the business transaction and claimed by the
  relay after the commit (§7); the `system-events` worker is idempotent per
  event id (audit marker inside its own transaction), so a duplicate
  delivery is a no-op, and a row is never marked `DONE` before the worker
  has finished it.
- Post-commit work (Redis sync, websockets, low-stock notifications) is
  best-effort and never changes money or stock.
- `BillingCheckpoints` names sixteen points inside these transactions
  (`BEFORE_INVOICE` … `BEFORE_COMMIT`). It is a no-op in production and is
  overridden by `test/integration/pos-failure-injection.integration-spec.ts`
  to prove that a failure at any point leaves the database and Redis exactly
  as they were.
- Database guards: `Invoice(shopId, idempotencyKey)`,
  `UdharTransaction(shopId, idempotencyKey)` and
  `LedgerPosting(shopId, sourceType, sourceId)` are unique;
  `InventoryItem(shopId, productId, variantKey, locationId)` is unique with
  `variantKey = variantId ?? '-'` because MySQL treats NULLs as distinct in
  unique indexes; the default warehouse/bin bootstrap of a shop runs under
  the `Shop` row lock for the same reason.

## 11. Financial reconciliation (roadmap 9.5)

The books of a business day are proven to the paisa by
`ReconciliationService` (`apps/api/src/reconciliation`), nightly for every
shop (`CRON_RECONCILIATION`, read in `CRON_TIMEZONE`, default
Asia/Kolkata, not the container's UTC; the shop's previous business day in
its own timezone, under the `cron:reconciliation` lock) and on demand. Every run,
clean or not, is a `ReconciliationRun` row (`businessDate`, `timeZone`,
`trigger` CRON / MANUAL / CLI, `status` CLEAN / DRIFT / FAILED,
`driftCount`, `checks`, `summary`, `error`). Nothing is corrected: a drift
names the check, the document or row and the two figures that disagree, for
a person to explain or fix with a recorded adjustment.

The nine checks (`reconciliation-engine.ts`, pure over a Prisma client, so
the cron, the route and the CLI run identical code). Every run reads one
database snapshot: the engine runs inside one REPEATABLE READ transaction
(`inReadSnapshot`, 120 s budget), so a sale that commits while a run reads
cannot show in one figure and not in the next (it used to report a drift
that did not exist, and page); the run row is written after the snapshot
closes:

| Check | Identity |
|---|---|
| `documents` | every sale and return of the day: `taxable + tax + round-off = total`, `Σ line totals + round-off = total`, `Σ tender rows + credit = total`, `paid = Σ tender rows`; every credit sale has its CREDIT `UdharTransaction` for the credit amount; every repayment: `balance before − amount = balance after` |
| `postings` | every sale, return, cancellation and repayment of the day has exactly the posting of §9 that its stored amounts imply: CASH / BANK by tender row, ACCOUNTS_RECEIVABLE by credit, SALES_REVENUE / GST_PAYABLE by `splitRevenue`, COST_OF_GOODS / INVENTORY from the stock movements the document caused (`StockLedgerEntry` by reference, so a service product or a custom line expects none); every expense created, edited, deleted or posted in the day: the sum of its `EXPENSE` / `EXPENSE_ADJUSTMENT` postings is what the expense now implies (§9; an expense recorded before expenses were posted and not edited since is noted, not compared); every posting created in the window balances and has a known source type, and a POS or expense posting points at a real document of its kind |
| `tenders` | the day's CASH, BANK and ACCOUNTS_RECEIVABLE movement in the matched postings equals the documents by tender |
| `dashboard` | `GET /dashboard/summary`'s figures for the day (the shared SQL of `RevenueEngine.totals`: gross sales, returns, orders, return count) equal the documents, and net sales equal the ledger's revenue + GST movement (a same-day cancellation is excluded by the dashboard and nets to zero in the ledger) |
| `shifts` | every shift open at any point of the day, rebuilt from its documents: `expectedCash = openingCash + cash sales − cash refunds (returns and cancellations, repaid credit included) + cash repayments − cash payouts`, where the payouts (`Shift.cashPayouts`, checked too) are the live paid cash expenses and the CASH supplier payments naming the shift (an expense edited after its shift closed counts as the audit log recorded it at the close: a closed drawer is never touched again), and `totalSales`, `cashSales`, `upiSales`, `cardSales`, `udharSales`, `totalReceipts` likewise |
| `stock` | every live `InventoryItem.onHand` equals its stock ledger (a `StockSnapshot`, when one exists, plus the entries after it) and every product's `currentStock` equals the sum of its items |
| `ledger` | every `LedgerAccountBalance` equals the sum of its transactions (debit-normal accounts grow with debits) and the last transaction's `balanceAfter` |
| `receivables` | every customer's `outstandingBalance` equals the sum of its udhar movements (`balanceAfter − balanceBefore`) and its newest udhar row's `balanceAfter`; the customers' balances (dues minus advances) equal the ledger's ACCOUNTS_RECEIVABLE (+ UDHAR_RECEIVABLE) balance |
| `payables` | every supplier's `pendingPayables` equals its opening balance plus the net ACCOUNTS_PAYABLE of its documents' postings (GRN, VENDOR_BILL, PURCHASE_RETURN, SUPPLIER_CREDIT_NOTE, SUPPLIER_PAYMENT, SUPPLIER_OPENING_BALANCE); Σ `pendingPayables` equals the ledger's ACCOUNTS_PAYABLE. A supplier whose `openingPayables` has no `SUPPLIER_OPENING_BALANCE` posting (created before it was posted) makes the check `INCONCLUSIVE` with a note, never a drift |

Two facts the shift check needs are stored on the documents (migration
`20261005090000_reconciliation_runs`): `Invoice.cancelledShiftId`, the drawer
a cancellation refunded (the sale's own shift while it is open, else the
actor's; NULL when no drawer was involved, e.g. a non-cash refund with no
open shift), and `UdharTransaction.shiftId`, the drawer a repayment was taken
on. Rows written before that migration carry NULL although they did move a
drawer; a shift they overlap is reported `INCONCLUSIVE` (with a note), never
as drift.

Routes (`OWNER` / `ADMIN` / `SUPER_ADMIN`; `VIEWER` and the counter roles are
403; every id is the caller's shop, a foreign one is 404):

- `GET /reconciliation/latest`: the newest run, `404 RECONCILIATION_NOT_RUN`
  before the first.
- `GET /reconciliation/runs` (paged, §5.6 headers; `checks` and `summary`
  omitted) and `GET /reconciliation/runs/:id` (the whole run).
- `POST /reconciliation/run { date? }` (201): reconciles the given business
  day, today in the shop's timezone by default; `400
  RECONCILIATION_INVALID_DATE` for a day that does not exist, `400
  RECONCILIATION_FUTURE_DATE` for one that has not started.

From the API container: `node dist/cli/reconcile --shop <id> [--date <day>]
[--json]`, or `--all-shops [--date <day>]` for every shop the nightly run
visits, each on its previous business day unless a day is named (the
catch-up after a missed night); from a checkout `npm run reconcile -- ...`
is the same command (`apps/api/src/cli/reconcile.ts`, exit 0 clean, 1
drift, 2 usage or a failed run). Each run is recorded with trigger `CLI`. Metrics and alerts:
`docs/OBSERVABILITY.md` (`reconciliation_*`, `DukaanAiReconciliationDrift`,
`DukaanAiReconciliationStale`). Evidence:
`test/integration/reconciliation.integration-spec.ts` (a mixed day with a
closed shift at zero drift, every summary figure against an independent
read, a corrupted row in each area detected and named, the sweep under the
lock, the routes, the metrics, the CLI) and
`financial-year-rollover.integration-spec.ts` (both days of the rollover
reconcile, roadmap 9.6) and `reconciliation-books.integration-spec.ts` (sales
committed between the engine's reads leave a run CLEAN; expenses and cash
supplier payments in the books and the drawer; a corrupted customer balance,
credit row, invoice line and supplier balance each detected; an unposted
supplier opening balance INCONCLUSIVE).

## 12. The application clock (roadmap 9.6)

`Clock` (`apps/api/src/common/time/clock.ts`, global) is the one source of
"now" for every instant a POS document carries: the sale, return and
cancellation transactions take one `now` from it for the document's
financial-year tag (`financialYearLabel`), its `createdAt` (set explicitly;
Prisma's `@default(now())` is the query engine's clock) and its stock
movements; shifts open and close on it; repayments stamp it; the dashboard's
business day is read from it. Production reads the system clock. The
financial-year rollover spec replaces the provider with a settable clock and
bills on 31 March 23:59 and 1 April 00:01 (Asia/Kolkata): `INV-2627-000003`
is followed by `INV-2728-000001`, the return sequence restarts the same
way, the old year's sequence rows and numbers are untouched (the unique key
is `(shopId, financialYear, invoiceNumber)`), the same-day cancellation
window flips with the business day, and the dashboard's `businessDate` and
`GET /billing/invoices?from&to` agree with the FY tags.

## 13. Onboarding imports (roadmap 9.20)

A shop's day-one data arrives as three CSV (or JSON array) files, imported in
this order: products, opening stock, customers. The procedure is
`docs/ONBOARDING.md`; the templates are `docs/onboarding/*.csv` and
`GET /imports/templates/{products|customers|opening-stock}` (the same bytes,
`import-columns.spec.ts`).

- `POST /imports/{products|customers|opening-stock}/upload` (multipart:
  `file`, `mode?` = `UPSERT` (default) | `CREATE_ONLY` | `UPDATE_ONLY`,
  `dryRun?` = `"true"` | `"false"`; MANAGER+) stores the file and queues a
  job: `201 { jobId, kind, dryRun }`. `MERGE` / `REPLACE` are 400. The
  worker runs the job as the uploading user, who must still be an active
  manager of the shop (else the job is FAILED with the reason in row 0).
  A file name over 191 characters is `400 UPLOAD_FILE_NAME_TOO_LONG` before
  anything is stored; a file past `MAX_IMPORT_ROWS` records (counted while
  streaming) or a JSON file over 2 MB is the job's file error
  (`IMPORT_TOO_MANY_ROWS` / `IMPORT_FILE_TOO_LARGE`). When the queue does
  not take the job within `BULL_ENQUEUE_TIMEOUT_MS` the answer is
  `503 QUEUE_UNAVAILABLE`, the job row is FAILED with that reason and the
  stored file removed, so a retry creates one new job, never two live ones.
- A dry run validates and plans every row against the shop's data and writes
  only the report; `POST /imports/jobs/:id/apply` (MANAGER+) runs a finished
  dry run (COMPLETED or PARTIAL_SUCCESS) for real as a new job on the same
  file (`409 IMPORT_NOT_A_DRY_RUN`, `409 IMPORT_DRY_RUN_NOT_APPLICABLE`).
- `GET /imports/jobs` (paged, newest first), `GET /imports/jobs/:id` (status
  and counters: `totalRows`, `validRows`, `errorRows`, `createdCount`,
  `updatedCount`, `unchangedCount`, `skippedCount`; never the server's file
  path), MANAGER+ only (the rows hold customers' phone numbers): `GET
  /imports/jobs/:id/rows?status=SUCCESS|ERROR|SKIPPED&skip&take` (paged, file
  order; row 0 is the file itself: unread columns, a missing required column,
  an unreadable file), `GET /imports/jobs/:id/errors`, `GET
  /imports/jobs/:id/report` (the whole report as CSV, the row's own cells
  under the template headers). A row is `{ rowNumber, status, actionTaken,
  changes, errors, rawData }`; `actionTaken` is `CREATED` / `UPDATED` /
  `UNCHANGED` / `SKIPPED`, `WOULD_CREATE` / `WOULD_UPDATE` in a dry run;
  `errors` holds every issue with its `field` and `severity` (a warning never
  refuses a row). Row numbers are spreadsheet lines (the header is line 1).
- Every row is written through the service the screens use: products through
  `ProductsService.create/update` (matched by SKU, case-insensitive),
  customers through `CustomersService.create/update` (matched by the national
  phone number) and `recordOpeningBalance` (§4), opening stock through
  `InventoryDomainService.recordOpeningStock` (§9). A blank cell never clears
  a stored value; a row that names an existing record with nothing to change
  is UNCHANGED, so the same file imported twice changes nothing. A refused
  write (409 from a concurrent change) is that row's error and the run goes
  on.
- Rules beyond the create DTOs: MRP >= the selling price plus GST and cess
  (`inclusiveUnitPrice`, the slab the row will have: its own, else 18 on a
  new product or the stored one on an update), also against the stored MRP
  when the file leaves it blank; a blank MRP on a new product is that
  inclusive price; an update row that changes none of the price, slab, cess
  or MRP of a product already above its MRP is a warning (the POS refuses
  the product until it is corrected); GST slab 0/5/12/18/28 (blank: 18
  on a new product, with a warning); unit by the POS rule (KG, GM, LTR, ML
  in decimals, the rest whole); a customer's state is an Indian state or
  union territory (`apps/api/src/common/india/states.ts`, the web picker's
  list), stored canonically (it is part of the address; a counter sale is
  taxed in the shop's state, §2); a code a spreadsheet turned into
  scientific notation (`8.90123E+12`) is refused; the same SKU, barcode,
  phone or product twice in one file is refused on the later row; opening
  stock is refused for a product that already moved or carries stock from
  before the stock ledger, for SERVICE / DIGITAL products, and when another
  quantity is already recorded; a 0 quantity is SKIPPED.
