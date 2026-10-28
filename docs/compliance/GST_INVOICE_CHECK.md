# GST invoice format check

Roadmap 9.24. What a DukaanAI sale receipt and return document carry,
checked field by field against the rules for a tax invoice and a credit
note. Each row cites where the code produces the field. It is a draft for
the owner's tax advisor to confirm (status at the end).

Rules checked, as published on the CBIC tax information portal (read
2026-10-11):

- CGST Rules, 2017: Rule 46 (tax invoice), Rule 53 (credit note),
  Rule 49 (bill of supply).
- Notification 12/2017-Central Tax as amended by 78/2020 (HSN digits).
- CGST Act s.36 (keeping records).

The e-invoicing (IRN) thresholds are recorded as a scope limit, not
checked against the code.

Documents checked:

- the 80 mm POS receipt (`apps/web/src/components/invoices/ReceiptView.tsx`);
- the A4 invoice page (`apps/web/src/app/(app)/invoices/[id]`);
- the data behind both: `GET /billing/invoices/:id/receipt`, built from
  `Invoice`, `InvoiceItem`, `Shop` and `ShopSettings`.

## 1. Tax invoice (Rule 46)

| Rule | Particular | Status | Where / what is missing |
|---|---|---|---|
| 46(a) | Name, address and GSTIN of the supplier | **Met** once the shop's profile is complete | Shop name, address, city, state, pincode, phone and `ShopSettings.gstin` print at the top of the receipt. A shop without a GSTIN prints none: see G7. |
| 46(b) | Consecutive serial number, at most 16 characters (letters, digits, `-`, `/`), unique for the financial year | **Fixed (9.24)** | It was `INV-2026-27-000001`, 18 characters. It is now `INV-2627-000001`, 15 characters: one series per shop and financial year, gapless (`NumberSequenceService` under a row lock), unique key `(shopId, financialYear, invoiceNumber)`. `InvoiceNumberService` refuses to issue a number over 16 characters or outside the allowed characters (`invoice-number.service.spec.ts`). Numbers already issued keep their old series. |
| 46(c) | Date of issue | **Met** | The date and time in the shop's timezone (`Clock`, `business-day.ts`). |
| 46(d) | Name, address and GSTIN of a **registered** recipient | **Gap G1** | A customer has no GSTIN field (`Customer` has none; `CustomerProfile.gstin` is unused), and the receipt prints the customer's name and phone but not their address. A B2B tax invoice to a registered buyer cannot be issued correctly. |
| 46(e) | Unregistered recipient, value ₹50,000 or more: name, address, delivery address with state name and code | **Gap G4** | The POS sells to "Walk-in" at any value, and the receipt never prints an address. |
| 46(f) | HSN code of goods / accounting code of services | **Gap G2** | `Product.hsnCode` exists, but the invoice line does not carry it (`InvoiceItem` has no HSN column) and no document prints it. For shops with aggregate turnover up to ₹5 crore, 4 digits are mandatory on B2B invoices and optional on B2C. Above ₹5 crore, 6 digits are required on every invoice (Notification 78/2020). |
| 46(g) | Description of goods or services | **Met** | `InvoiceItem.productName`, stored on the line, so a later rename does not change the invoice. |
| 46(h) | Quantity and unit | **Met** | Quantity and `unit` (`PCS`, `KG`, ...) per line. |
| 46(i) | Total value of the supply | **Met** | Line amount and document total. |
| 46(j) | Taxable value, after any discount | **Met** | "Taxable" on the document and per rate in the GST summary. Discounts are shown and subtracted (`invoice-math`). |
| 46(k) | Rate of tax (central, state, integrated, cess) | **Met** | Rate per line, and the rate-wise GST summary. |
| 46(l) | Amount of tax charged (central, state, integrated, cess) | **Met** | CGST and SGST, or IGST, per document and per rate. Cess when charged. |
| 46(m) | Place of supply, with the state's name, for an inter-state supply | **Fixed (audit P1-3)**, printing still **Gap G3** | Goods sold over the counter are supplied where the shop is (IGST Act s.10(1)(c)): a counter sale is now intra-state (CGST + SGST) whatever state the customer's profile names. Until the audit of 2026-10-11 the customer's saved state decided, which charged IGST on counter sales to out-of-state customers. IGST applies only when the request names an explicit `placeOfSupply` (a delivery, a registered buyer's state) that differs from the shop's state (`BillingService.resolveInterState`, both spellings canonicalised with `canonicalState`); the POS sends none. The receipt still does not print the place of supply. Advisor to confirm the rule. |
| 46(n) | Delivery address, when different from the place of supply | **N/A** for counter sales; Gap G4 for deliveries | |
| 46(o) | Whether tax is payable on reverse charge | **Gap G8** (minor) | Never printed. Counter sales are never under reverse charge, so the usual practice is "Reverse charge: No". |
| 46(q) | Signature or digital signature of the supplier or an authorised representative | **Gap G5** | No signatory line. Rule 46 exempts electronic invoices with an IRN, and printed POS receipts are not those. |
| Title | "Tax Invoice" | **Met** | The receipt says "TAX INVOICE". See G7 for a shop without a GSTIN. |

## 2. Credit note: a sales return (Rule 53(1A))

| Particular | Status | Where / what is missing |
|---|---|---|
| Nature of the document | **Gap G6** (minor) | Titled "SALES RETURN". "CREDIT NOTE" is the term the rules use. |
| Supplier's name, address, GSTIN | **Met** | As on the invoice. |
| Serial number of at most 16 characters, consecutive in the year | **Fixed (9.24)** | `RET-2627-000001`, its own series. |
| Date of issue | **Met** | |
| Recipient's details | as for the invoice (G1, G4) | |
| Serial number and date of the original invoice | **Met** (number) | The receipt prints "Against `<invoice number>`". The original's date is on the invoice page. |
| Taxable value, rate, tax credited | **Met** | Cumulative return math (`CALCULATION_SPEC.md`), rate-wise summary. Each return row adds up (`subtotal − discount = taxable`, audit B10), and a return reverses CGST + SGST or IGST as the sale charged them. |
| Signature | Gap G5 | |
| Time limit, CGST Act s.34(2): no credit note after 30 November following the end of the financial year of the supply | **Fixed (audit B8)** | `POST /billing/returns` refuses a return after that day, in the shop's time zone on the application clock (`409 RETURN_PAST_GST_DEADLINE`, `billing/gst-deadline.ts`): the shop refunds outside the app, and the output tax is not reduced. |

## 3. Other rules

| Rule | Status |
|---|---|
| Bill of supply (Rule 49): a composition dealer, or a supply of exempt goods only, issues a bill of supply without tax | **Gap G9**. No composition mode: every document is a tax invoice that charges the product's GST rate. Composition dealers are out of scope until this is built. |
| E-invoicing (IRN) above ₹5 crore aggregate turnover, for B2B | **Out of scope.** Pilot shops are below the threshold. A shop above it must not use DukanAI for B2B invoices until IRN integration exists. B2C invoices need no IRN. |
| Keeping records 72 months after the annual return's due date (CGST Act s.36) | **Met** while the shop is a customer. A leaving shop gets its full export before any erasure (`docs/privacy/DATA_REQUESTS.md`). The customer-erasure tool keeps name and address under a legal hold (`gstRetentionEnds`). |
| Invoice numbering restarts each financial year, no duplicates | **Met**: one series per prefix (`financial-year-rollover.integration-spec.ts`). |

## 4. Gaps and proposed fixes

G2 to G6 and G8 change what is printed on the receipt or invoice page.
G1 and G4 also add fields to the customer screens. This row was carried
out under the rule "no change to the UI", so none is built here. Each
needs the owner's decision.

| # | Gap | Who is affected | Proposed fix | Size |
|---|---|---|---|---|
| G1 | No recipient GSTIN | Every B2B sale to a registered buyer | `Customer.gstin` (validated 15 characters, state code matching `Customer.state`), a field in the customer form, carried onto the invoice (snapshot column) and printed with the customer's address | 2 days |
| G2 | No HSN on invoice lines | B2B sales (4 digits); every sale above ₹5 crore turnover (6 digits) | Snapshot `Product.hsnCode` into `InvoiceItem.hsnCode` at checkout. Print it on each line. Require it on products when the shop has B2B customers. | 1.5 days |
| G3 | Place of supply not printed | Inter-state sales | Store the request's `placeOfSupply` on the invoice and print "Place of supply: `<state>` (`<code>`)" when the sale is inter-state (needs a column) | 0.5 day |
| G4 | B2C ₹50,000 or more without name and address | Large walk-in sales | API: refuse a sale of ₹50,000 or more without a customer that has an address (`CUSTOMER_DETAILS_REQUIRED`). POS: ask for the customer. Print the address. | 1 day |
| G5 | No signatory line | Every printed document | "For `<shop name>` · Authorised signatory" at the foot | 0.25 day |
| G6 | Return titled "SALES RETURN" | Every return | Title it "CREDIT NOTE" | 0.1 day |
| G7 | A shop without a GSTIN still prints "TAX INVOICE" and charges GST | A shop that is not registered | Done in 9.24: the pilot readiness check fails without a GSTIN (`scripts/pilot/readiness.mjs`). Open: an unregistered shop would need a "bill of supply, no GST" mode (with G9). | 2 days (with G9) |
| G8 | Reverse charge not stated | Every document | Print "Reverse charge: No" | 0.1 day |
| G9 | No bill of supply / composition mode | Composition dealers | A `taxProfile` on the shop (`ShopSettings.taxProfile` exists) that issues a bill of supply without tax | 2 days |

## 5. Status

| Item | Status |
|---|---|
| Check written against the code | Done (2026-10-11) |
| Number length fixed and guarded | Done (9.24) |
| Reviewed by the owner's tax advisor | Open: owner |
| Decisions on G1 to G9 (build before go-live, or record the scope limit with the shops) | Open: owner |
