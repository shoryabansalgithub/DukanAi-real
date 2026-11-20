# Canonical Calculation Specification (engine 2.0.0)

`@dukaanai/invoice-math` is the only place where invoice money is computed.
The web POS runs it for previews, the API runs it for the persisted invoice,
and receipts, dashboards and reports read the persisted result. Every step
below is deterministic and uses `Decimal.js` (precision 20, ROUND_HALF_UP).

## `InvoiceMathEngine.calculate`

1. **Validate and freeze the input.** At least one line, no duplicate
   `productId`, quantity > 0 (3 dp), unit price >= 0, line discount 0-100,
   known GST slab (`ZERO`, `FIVE`, `TWELVE`, `EIGHTEEN`, `TWENTYEIGHT`) or an
   explicit numeric `gstRate`, cess 0-100 (`ERR_INVALID_CESS`). Unknown slabs
   and out-of-range cess are rejected, never defaulted.
2. **Line subtotal** = `unitPrice × quantity` (2 dp).
3. **Item discount** = `lineSubtotal × discountPercent / 100` (2 dp).
   `netSubtotal = lineSubtotal − itemDiscount`.
4. **Invoice discount.** `FIXED_AMOUNT` uses `discountAmount`; `PERCENTAGE`
   uses `Σ netSubtotal × discountPercentage / 100` (2 dp). It must be
   non-negative, not exceed `Σ netSubtotal`, and carry a `discountReason`.
5. **Allocation.** The invoice discount is spread over lines in proportion to
   `netSubtotal` (2 dp per line); the last line takes the remainder; no line
   share may exceed its `netSubtotal`, any overflow is moved to lines with
   room. `Σ invoiceDiscountShare == invoiceDiscount` always.
6. **Taxable amount** = `lineSubtotal − itemDiscount − invoiceDiscountShare` (2 dp).
7. **Tax per line** on the taxable amount, exclusive pricing: intra-state
   `CGST = SGST = taxable × rate / 2 / 100` (each 2 dp); inter-state
   `IGST = taxable × rate / 100` (2 dp); `CESS = taxable × cessRate / 100` (2 dp).
   `lineTotal = taxable + CGST + SGST + IGST + CESS`.
8. **Aggregate.** Invoice totals are sums of line values, never recomputed
   from percentages.
9. **Round-off.** `grandTotal = taxableTotal + totalTax`;
   `finalTotal = round(grandTotal)` to the nearest rupee (half-up);
   `roundOff = finalTotal − grandTotal` (2 dp, may be negative).
10. **Payment (optional).** When `payment` is provided:
    `Σ tenders.amount + udharAmount == finalTotal` exactly; only `CASH`
    tenders may carry `tenderedAmount > amount` and the difference is
    `changeAmount`; `paymentMode` is derived (`CASH`/`UPI`/`CARD` for a single
    tender with no credit, `UDHAR` for credit only, otherwise `SPLIT`;
    `BANK_TRANSFER` maps to `CARD` on the invoice). Without `payment` the
    engine returns `payment: null` (preview).

Core invariant, always true for the result:

```
subtotal − totalDiscount + totalTax + roundOff == finalTotal
Σ lineTotal + roundOff == finalTotal
```

## `InvoiceMathEngine.calculateReturn`

Returns are cumulative (roadmap 3.1). For a stored line amount `A` (each of
`discountAmount`, `taxableAmount`, `cgst`, `sgst`, `igst`, `cess`) and the
original quantity `Q`, the amount refunded once `q` units have gone back is
`cum(q) = round2(A × q / Q)`, with `cum(0) = 0` and `cum(Q) = A` exactly. A
document that returns `quantity` after `returnedQuantity` units were already
returned refunds `cum(returnedQuantity + quantity) − cum(returnedQuantity)`:
whatever the split, the returns of a line add up to `A`, and the return that
completes the line takes its exact remainder. `returnedQuantity + quantity`
may not exceed `Q` (`ERR_RETURN_QTY_EXCEEDS`).

A return line's `lineSubtotal` is its `taxableAmount + discountAmount` (both
cumulative slices), not `unitPrice × quantity`: the two can differ by a
paisa, and only the sum keeps `subtotal − discount = taxable` on the return
document's own rows (8 × 169.72 with a 9 % line discount, 3 returned: 509.17
− 45.83 = 463.34, where 3 × 169.72 = 509.16 did not add up).

Totals are sums of the line values. A return document is **never rounded to
the rupee on its own** (that is how four returns of a ₹0.50 unit refunded ₹4
on a ₹2 sale). With a `settlement` the document total is settled against the
sale: `finalTotal = min(grandTotal, invoiceTotal − refundedTotal)`, and when
`completesInvoice` is true (every line of the sale is fully returned after
this document) `finalTotal = invoiceTotal − refundedTotal` exactly. So
Σ refunds of a sale == its `finalTotal`, the sale's round-off is refunded
once, by the last return, and a sale that was already over-refunded (legacy
data) refunds nothing more. `roundOff = finalTotal − grandTotal`.

## Prices, MRP and discount limits

The selling price is **before GST** (exclusive pricing). The MRP a product
carries is tax-inclusive (Legal Metrology), so the API never sells a unit
above it:

- `inclusiveUnitPrice(price, gstRate, cessPercent = 0)` is what `calculate`
  bills for ONE undiscounted unit at `price`: `price + CGST + SGST + CESS`
  intra-state and `price + IGST + CESS` inter-state, each tax component
  rounded half-up to the paisa, and the higher of the two (the same product
  can be billed either way; e.g. 10.05 at 18 % is 11.85 intra-state and
  11.86 inter-state, 0.50 at 18 % is 0.60 and 0.59). `gstRate` is a slab
  name or a percent. The products API refuses an MRP below it and stores it
  for a blank MRP; the checkout refuses a line whose product's MRP (when
  above 0) is below it (`PRICE_ABOVE_MRP`). It is a per-unit rule at paise
  precision: a line of many units of a sub-paisa-rounded price can carry a
  fraction of a paisa per unit more than `quantity × MRP`, as any rounded
  per-line tax does.
- `exclusiveUnitPrice(inclusivePrice, gstRate, cessPercent = 0)` is the
  inverse the product form uses when the owner types a GST-inclusive shelf
  price: the largest price in paise whose `inclusiveUnitPrice` is at most
  `inclusivePrice`, so one unit never bills above the typed price (₹10 at
  18 % stores ₹8.47, which bills ₹9.99; ₹118 stores ₹100.00 exactly), and
  `inclusiveUnitPrice(exclusiveUnitPrice(x)) ≤ x` for every price and slab.
- `discountLimitAmounts(result, limitPercent)` is what a percentage limit
  yields on a calculated invoice under the engine's own rounding: `invoice`
  = `round2((subtotal − totalItemDiscount) × limit / 100)` (an invoice
  PERCENTAGE discount at the limit) and `effective` = the larger of
  `round2(subtotal × limit / 100)` and `Σ round2(lineSubtotal × limit /
  100)` (the limit applied once, or on every line). The API's cashier
  discount authority compares amounts with these, never a re-derived
  percentage (10 % of 10.05 is 1.01, which is 10.05 % of the line).

## Cost of goods

`costOfGoodsSlice(unitCost, before, quantity)` =
`round2(unitCost × (before + quantity)) − round2(unitCost × before)`. A sale
books every stocked line at `costOfGoodsSlice(cost, 0, quantity)` (rounded per
line), a return at `costOfGoodsSlice(cost, returnedBefore, quantity)`: the
returns of a line add up to exactly what its sale booked, whatever the split
(rounding each return on its own drifted: 33.33 × 2.345 kg = 78.16 sold,
0.001 + 0.001 + 2.343 kg returned = 0.03 + 0.03 + 78.09 = 78.15).

## Allocation notes

`allocateProportionally(total, weights)` (used for the invoice discount)
returns 2 dp shares with `Σ shares == total` and `0 <= share_i <= weight_i`:
half-up rounding can over- or undershoot by a few paise, and the difference
is settled on the last lines with room, never by a negative share.

A sale whose grand total is under ₹0.50 rounds to ₹0 (negative round-off);
with no tender and no credit its payment mode is `CASH`, not `UDHAR`.

## Limits (storage-backed)

Money columns are `Decimal(10,2)` and quantities `Decimal(10,3)`, so the
engine rejects, before any database write:

- quantity `> 9999999.999` → `ERR_INVALID_QUANTITY`
- unit price `> 99999999.99` → `ERR_INVALID_PRICE`
- any line subtotal, the invoice subtotal or the final total `> 99999999.99` →
  `ERR_AMOUNT_TOO_LARGE`
- any tender amount `> 99999999.99` → `ERR_INVALID_PAYMENT`

`MONEY_MAX` / `QUANTITY_MAX` are exported constants.

## Custom (ad-hoc) lines

A custom line is an ordinary engine line whose `productId` is a caller-chosen
unique key (the API uses `custom:<n>`, the web POS `custom:<lineId>`). It is
priced from the supplied `unitPrice`, taxed by the supplied GST slab, carries
no cess, and follows every discount and rounding rule above. Uniqueness of the
key is enforced (`ERR_DUPLICATE_LINE`).
