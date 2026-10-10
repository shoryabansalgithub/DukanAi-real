# Canonical Calculation Specification (engine 2.0.0)

`@dukaanai/invoice-math` is the only place where invoice money is computed.
The web POS runs it for previews, the API runs it for the persisted invoice,
and receipts, dashboards and reports read the persisted result. Every step
below is deterministic and uses `Decimal.js` (precision 20, ROUND_HALF_UP).

## `InvoiceMathEngine.calculate`

1. **Validate and freeze the input.** At least one line, no duplicate
   `productId`, quantity > 0 (3 dp), unit price >= 0, line discount 0-100,
   known GST slab (`ZERO`, `FIVE`, `TWELVE`, `EIGHTEEN`, `TWENTYEIGHT`) or an
   explicit numeric `gstRate`. Unknown slabs are rejected, never defaulted.
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

Totals are sums of the line values. A return document is **never rounded to
the rupee on its own** (that is how four returns of a ₹0.50 unit refunded ₹4
on a ₹2 sale). With a `settlement` the document total is settled against the
sale: `finalTotal = min(grandTotal, invoiceTotal − refundedTotal)`, and when
`completesInvoice` is true (every line of the sale is fully returned after
this document) `finalTotal = invoiceTotal − refundedTotal` exactly. So
Σ refunds of a sale == its `finalTotal`, the sale's round-off is refunded
once, by the last return, and a sale that was already over-refunded (legacy
data) refunds nothing more. `roundOff = finalTotal − grandTotal`.

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
