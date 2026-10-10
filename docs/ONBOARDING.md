# Onboarding a shop: the first day (roadmap 9.20)

A shop moving to DukaanAI brings its catalogue, the stock on its shelves and
the customers who owe it money (udhar) or hold an advance. This is the
procedure that loads them, in order, so that the first sale bills the right
tax, the stock screen shows what is on the shelf and every customer's
balance is what the old book said, with the books balanced from the first
minute.

The data is loaded from three spreadsheets saved as CSV. Every file is
imported twice: first as a **dry run** (nothing is written; a report says
what each row would do and what is wrong with it), then, once the report is
clean, for real. Importing the same file again changes nothing, so a
stopped or repeated import is never a problem.

Who: the shop's OWNER (or an ADMIN or MANAGER; cashiers and viewers cannot
import). How long: about half an hour of fixing spreadsheets, a few minutes
of importing (section 9 has the timings of 5,000 products and 2,000
customers).

## 0. Before you start

- The deployment is ready (`docs/PILOT.md` §4, `scripts/pilot/readiness.mjs`
  ends READY) and the owner has registered.
- Collect the shop's **GSTIN** and its **state**.
- Export or type the **product list** (SKU, name, prices, GST slab).
- **Count the shelf** on the evening before day one, after the last sale in
  the old system. The count is the opening stock; anything sold after the
  count makes it wrong.
- Close the old **udhar book** at the same moment: every customer's balance,
  what they owe (positive) or what the shop holds for them (negative).

Download the three templates, either from `docs/onboarding/` in this
repository or from the running API:

```
node scripts/onboarding/import.mjs template products      --api https://<API_HOST> --out products.csv
node scripts/onboarding/import.mjs template opening-stock --api https://<API_HOST> --out opening-stock.csv
node scripts/onboarding/import.mjs template customers     --api https://<API_HOST> --out customers.csv
```

(`GET /api/imports/templates/{products|opening-stock|customers}` with the
owner's token is the same file.) Each template has the header row and two
sample rows: replace the samples with the shop's own rows.

## 1. The shop profile

Settings › Shop Profile: name, address, city, **state**, pincode, phone,
email and the **GSTIN** (printed on every receipt). The state is not
decoration: a sale to a customer in the same state bills CGST + SGST, a
customer in another state IGST, and a shop without a state can never bill
IGST.

## 2. Categories

Nothing to do in advance: the products file has a `category` column, and
each name is created (one level, at the root) the first time a row that is
imported names it. A category that already exists is matched by name, case
and spacing ignored. Sub-categories are arranged afterwards on the web.

## 3. Products

Fill `products.csv`. The headers may be spelled the way the shop's own
export spells them ("Item Code", "Selling Price (₹)", "GST %", "HSN/SAC",
"MRP"…): the import reads the common spellings, and the report names every
column it did not read.

| Column | Required | Rule |
|---|---|---|
| `sku` | yes | the shop's code, unique; a re-run matches products by it (case ignored) |
| `name` | yes | as printed on the receipt, up to 191 characters |
| `category` | | created on first use |
| `barcode` | | unique in the shop; EAN-13 on most packs |
| `hsnCode` | | 4, 6 or 8 digits (anything else is kept, with a warning) |
| `unit` | | PCS (default), KG, GM, LTR, ML, BOX, PACK, DOZEN, BUNDLE; "kgs", "Nos", "pkt" are understood |
| `gstRate` | | 0, 5, 12, 18 or 28 ("18%", "nil" understood); a new product without one gets 18 and a warning |
| `cessRate` | | percent of the taxable value, 0 when blank |
| `costPrice` | yes | rupees; it also values the opening stock |
| `sellingPrice` | yes | rupees, before GST |
| `mrp` | | never below the selling price; the selling price when blank |
| `wholesalePrice` | | the selling price when blank |
| `reorderPoint` | | the low-stock alert level, 10 when blank |
| `type` | | SIMPLE (stocked, the default); SERVICE or DIGITAL carry no stock |
| `description` | | free text |

Run the dry run, read the report, fix the file, repeat until no row is
refused; then apply:

```
export ONBOARDING_EMAIL=owner@shop.in ONBOARDING_PASSWORD='…'
node scripts/onboarding/import.mjs products products.csv --api https://<API_HOST> --report products-report.csv
node scripts/onboarding/import.mjs products products.csv --api https://<API_HOST> --apply
```

A product that is already in the shop is updated with the columns the file
fills in; a blank cell never clears what is stored. A selling price above
the stored MRP is refused unless the file gives the MRP too.

## 4. Opening stock

Fill `opening-stock.csv` from the count: one row per product, named by its
`sku` (or by its `barcode` when the SKU is blank), and the `quantity` on the
shelf in the product's unit (decimals only for KG, GM, LTR and ML). A
product with nothing on the shelf may be left out or given 0 (reported as
skipped).

```
node scripts/onboarding/import.mjs opening-stock opening-stock.csv --api https://<API_HOST> --apply
```

Each quantity becomes the product's **first stock movement**
(`OPENING_BALANCE`) at the sale location, valued at the product's cost
price: the books gain `INVENTORY` against `OPENING_BALANCE_EQUITY`, the
shop's capital on day one (contract §9), not a gain or a stock-adjustment
expense. It is recorded once per product: the same quantity again is
unchanged, and a different quantity, or a product whose stock already moved
(a sale, a receipt), is refused. **A correction after day one is a stock
adjustment** (Products › Update Stock), never a second opening.

Import the products first: opening stock names products that must exist.

## 5. Customers and their opening udhar

Fill `customers.csv`.

| Column | Required | Rule |
|---|---|---|
| `name` | yes | up to 100 characters |
| `phone` | yes | spaces, dashes and a `+91` or `0` prefix are removed; a re-run matches customers by the number |
| `email`, `address`, `city`, `notes` | | |
| `state` | | an Indian state or union territory as the GST portal spells it ("orissa", "New Delhi", "J&K" understood); anything else is refused, because it decides CGST/SGST against IGST |
| `creditLimit` | | rupees; the shop default (`SALES_DEFAULT_CREDIT_LIMIT`) when blank |
| `openingBalance` | | what the customer owes today; negative for an advance the shop holds |

```
node scripts/onboarding/import.mjs customers customers.csv --api https://<API_HOST> --apply
```

The opening balance is recorded **once per customer** as an ADJUSTMENT row
in the customer's ledger ("Opening balance"), and in the books as
`ACCOUNTS_RECEIVABLE` against `OPENING_BALANCE_EQUITY` (the other way round
for an advance). It is refused for a customer whose udhar has already moved
(a credit sale, a repayment), and a different amount on a re-run is refused
too: **a correction is a repayment or a credit sale**, on the customer's
page. A balance above the credit limit is imported with a warning: that
customer gets no further credit until it comes down.

## 6. Check before the first sale

1. Reconciliation: Settings (or `POST /api/reconciliation/run`, ADMIN) must
   answer **CLEAN** for today. Every opening posting balances and the stock
   of every item equals its movements.
2. The dashboard's tiles: products = the rows imported, inventory value =
   Σ quantity × cost price of the count, outstanding udhar = Σ opening
   balances of the old book (advances subtract).
3. Spot-check five products in the POS (scan the barcode, check the price
   and the GST slab) and three customers (their balance).
4. Open the first shift and bill.

## 7. The report

Every import job keeps a report, one line per row of the file (row 2 is the
first line under the header, as the spreadsheet numbers it; "file" is the
file itself):

- `status`: SUCCESS (in the shop as the file says), ERROR (refused, nothing
  written for that row), SKIPPED.
- `action`: CREATED, UPDATED, UNCHANGED, SKIPPED; WOULD_CREATE and
  WOULD_UPDATE in a dry run.
- `changes`: what the row changes ("sellingPrice 599.00 → 649.00", "new
  customer Ramesh Kumar", "opening udhar 1250.00").
- `problems`: the errors (the row was refused) and warnings (imported,
  but look at it), each with its column.

`--report FILE` writes it as CSV with the row's own cells after the
problems: fix the refused rows in that file and import it again; the rows
already imported come back UNCHANGED.

## 8. Common problems

| What the report says | Why | Fix |
|---|---|---|
| "a number the spreadsheet shortened" | Excel shows a 13-digit barcode as `8.90123E+12` and saves it that way | format the column as Text before typing or pasting the codes, or edit the CSV in a text editor |
| HSN warning on "713" | the spreadsheet dropped the leading zero of `0713` | format the column as Text |
| "is not an Indian state" | a city, an abbreviation, a typo | the state's name; the picker on Settings lists them |
| "Same SKU as row N" / "Same phone number as row N" | the file names one product or customer twice | keep one row |
| "N customers in the shop share this phone number" | duplicates already in the shop | merge them on the web first |
| "already recorded as …" (opening stock or udhar) | the opening was imported before | correct by a stock adjustment or a repayment |
| "already has stock movements" / "udhar activity" | the shop started selling before the import | correct by a stock adjustment / repayment, not an opening |
| "above the product's MRP" | a price update without the MRP | give the MRP in the same row |
| row 0 "has no … column" | a required column is missing or misspelled | rename the header (the template's spelling always works) |

## 9. What it was proven on

`scripts/onboarding/scale-gate.mjs` registers a fresh shop through the
public API, sets its state, generates 5,000 products (40 categories, every
GST slab, KG and LTR in decimals, EAN-13 barcodes, 20 services), their
opening stock (every 20th product with nothing on the shelf, every third
row naming the product by barcode) and 2,000 customers (phones with +91 and
trunk-0 spellings, misspelled states, 60 % with opening udhar, 5 % with an
advance), imports each file as a dry run, applies it, imports it again, and
then requires: every row created, the re-run all UNCHANGED, the
reconciliation CLEAN, and the dashboard's product and customer counts,
inventory value and outstanding udhar equal to the generated files.

```
ONBOARDING_TARGET=http://127.0.0.1:3061 node scripts/onboarding/scale-gate.mjs
```

| Run | Database | Products: dry run / apply / re-run | Opening stock (4,731 stocked, 249 at 0) | Customers (1,288 with opening udhar or advance) | Reconciliation | Checks |
|---|---|---|---|---|---|---|
| 2026-10-08, built API (`node dist/main`, one instance) on this machine | MariaDB 10.11 | 2.1 s / 64.8 s / 2.1 s (5,000 unchanged) | 1.1 s / 249.9 s / 1.0 s (4,731 unchanged) | 1.1 s / 39.5 s / 1.0 s (2,000 unchanged) | CLEAN in 0.8 s (4,731 STOCK_ADJUSTMENT and 1,288 OPENING_BALANCE postings) | 15 / 15 PASS |
| 2026-10-08, the same build against the drill stack's database | MySQL 8.0.46 | 2.1 s / 83.2 s / 2.1 s | 1.0 s / 380.9 s / 2.1 s | 1.1 s / 49.7 s / 1.0 s | CLEAN in 0.9 s | 15 / 15 PASS |

Both runs: inventory value ₹1,068,660,910.33 and outstanding udhar
₹15,351,165.30 on the dashboard, each equal to what the files say. The
opening stock is the slow file (about 13 to 19 products a second): every
row is a full stock movement with its ledger posting, under the same
product lock as a sale, so a 5,000-product shop needs four to seven
minutes; the dry run and a re-run take a second or two.

`test/integration/onboarding-import.integration-spec.ts` covers the rules
row by row (dry run writes nothing, apply, re-run, updates, refused rows,
the ledger entries, roles, tenant isolation, a job whose user lost the
right to import).

## 10. What is not imported

Suppliers, purchase history and past invoices: the shop starts its
DukaanAI history on day one, and the old bills stay where they were
(they are not needed for GST returns of the new period). Suppliers are
added on the Suppliers page; a supplier's outstanding payable is recorded
when the first purchase is entered.
