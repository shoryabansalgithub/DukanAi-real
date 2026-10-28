import type { MarketingPage } from './types';

const UPDATED = '2026-10-28';

export const gstBilling: MarketingPage = {
  path: '/features/gst-billing',
  section: 'features',
  label: 'GST billing',
  title: 'GST Billing Software for Kirana Stores | DukaanAI',
  description:
    'Bill fast at the counter with CGST and SGST worked out on every line, barcode scanning, split payments and 80 mm thermal receipts. Built for Indian kirana stores.',
  eyebrow: 'GST billing',
  h1: 'GST billing software for kirana and retail stores',
  lede:
    'DukaanAI is a point-of-sale (POS) for Indian shops: scan or search items, and every bill is a GST **tax invoice** with CGST and SGST worked out per line, a numbered series per financial year, and a receipt that prints on an 80 mm thermal printer.',
  body: `
## What a bill looks like

Every sale prints as a **TAX INVOICE** with your shop name, address and GSTIN at the top. Each line shows the product, quantity and unit, the price before GST, the GST rate and the line amount. Below the lines, the taxable value and the tax are split by rate, so a ₹100 item at 5 % and a ₹100 item at 18 % are shown on their own rows, with CGST and SGST in separate columns. When an item carries cess, a Cess row is printed too.

Invoice numbers follow the GST rule for serial numbers: one gapless series per financial year, at most 16 characters (DukaanAI uses 15, for example \`INV-2627-000001\`). A new financial year starts again at 000001 on 1 April without anyone touching a setting.

## Fast at a busy counter

- **Scan anywhere.** A USB barcode scanner works on the billing screen without clicking into a box first.
- **Search by name, SKU or barcode** with F2, then the arrow keys and Enter.
- **Hold a bill** when a customer steps away, and serve the next one.
- **Custom items** for things not in your catalogue, with the GST slab chosen per line.
- **Keyboard shortcuts** for search, customer, custom item and payment.

## Payments the way customers pay

Take cash (with change worked out), UPI, card or bank transfer, or split one bill across several. Any part of the bill can go on the customer's credit (udhar) account, which is checked against their credit limit before the sale goes through. See [udhar tracking](/features/udhar-khata).

If the network drops just as a sale is confirmed, the **Retry** button sends the same bill with the same key: the server either completes it or returns the bill it already made. A sale is never billed twice.

## Returns and cancellations that keep the books right

A return is recorded against the original bill and refunds exactly what was paid for the returned quantity, however many times the bill is returned against. Damaged or expired returns are not put back on the shelf. GST law closes the door on credit notes after **30 November** following the end of the financial year of the sale, and DukaanAI refuses a return after that date so your tax is never reduced by mistake. Read more in our guide to [returns and credit notes under GST](/blog/gst-returns-credit-notes).

## Discounts with limits

Line and bill discounts are allowed up to a limit you control: by default a cashier can give at most **10 %**, and a custom line of at most ₹500. A bigger discount needs a manager to bill it. Every bill discount carries a reason.

## Reports your accountant can use

**Reports & Analytics › Export** gives three CSV files for any dates: invoices, invoice lines, and a **GST summary** with taxable value and tax by rate. That summary is what your accountant needs to prepare the return.

## What DukaanAI does not do yet

We would rather you know before you start. Bills are made for counter sales to consumers (B2C). The customer record has no GSTIN field yet, HSN codes are not printed on the invoice, there is no composition-scheme bill of supply, and there is no e-invoicing (IRN). If you sell mainly to registered businesses or you are a composition dealer, DukaanAI is not the right fit today.
`,
  faqs: [
    {
      q: 'Does DukaanAI calculate CGST and SGST automatically?',
      a: 'Yes. Each product carries its GST slab, and every bill splits the tax into CGST and SGST per rate. A counter sale is taxed where your shop is, so it is billed CGST + SGST whatever state the customer lives in.',
    },
    {
      q: 'Can I print bills on a thermal printer?',
      a: 'Yes. The receipt is laid out for 80 mm roll paper and always prints black on white, even when the app is in dark mode. Any bill can also be opened and printed on A4.',
    },
    {
      q: 'Can I bill a customer on credit?',
      a: 'Yes. Choose **Credit (udhar)** or put part of a split payment on credit. The customer must be selected, and their credit limit is checked before the sale. See [udhar tracking](/features/udhar-khata).',
    },
  ],
  related: ['/blog/gst-bill-format-kirana-store', '/features/udhar-khata', '/features/inventory-management', '/glossary'],
  updated: UPDATED,
};

export const udharKhata: MarketingPage = {
  path: '/features/udhar-khata',
  section: 'features',
  label: 'Udhar tracking',
  title: 'Udhar Khata App for Shops: Track Customer Credit | DukaanAI',
  description:
    'Record udhar at the counter, set credit limits, take repayments in cash or UPI and see every customer’s ledger. A digital khata that is part of your billing.',
  eyebrow: 'Udhar (credit) tracking',
  h1: 'Udhar khata that is part of your billing',
  lede:
    'In DukaanAI, credit (udhar) is recorded on the bill itself: choose **Credit** at payment, and the customer’s balance, their ledger and your dashboard’s outstanding total all move at once. There is no second book to keep in step.',
  body: `
## How credit works at the counter

1. Select the customer on the bill (search by name or phone, or add them with name, phone and state).
2. At payment choose **Credit (udhar)** for the whole bill, or **Split** and tick **Put the remainder on credit**.
3. The screen shows the customer’s limit and what their balance will be after the sale. If the bill would take them past their limit, it is refused: take part in cash, or ask the manager to raise the limit.

## Credit limits that cashiers cannot change

Only a manager or the owner can set or change a customer’s credit limit, and every change is recorded with who made it. A customer added by a cashier starts with a limit of zero, so new credit always needs someone senior to agree to it first.

## Every customer has a ledger

Open **Customers (Udhar)** to see everyone with their **Outstanding**, **Credit limit** and **Available** amounts, with **Over limit** flagged. Each customer’s page shows the full ledger, every credit sale, payment and return with the balance after each, next to their invoices.

## Repayments

When a customer pays back, record it from their page with **Record payment**: cash, UPI, card or bank transfer. A cash repayment goes into the open shift’s drawer, so the cash count at closing still adds up. See [cash drawer and shifts](/features/cash-drawer-shifts).

## Returns on a credit bill

If a customer bought on udhar and returns something, the refund first reduces what they owe. Only the rest, if any, is paid back to them.

## Outstanding udhar on the dashboard

The dashboard shows the total outstanding udhar across all customers, counted only from customers who owe you money, so an advance paid by one customer never hides what another owes.

## Opening balances

Moving from a paper khata? Customers and their current udhar balances can be imported from a spreadsheet on your first day, with our help. Each opening balance is recorded once, and importing the same file again changes nothing.

For practical advice on running credit without losing money, read [how to manage udhar in a kirana store](/blog/manage-udhar-kirana-store).
`,
  faqs: [
    {
      q: 'Can a cashier give unlimited udhar?',
      a: 'No. Every credit sale is checked against the customer’s limit, only managers and owners can set limits, and a customer created by a cashier starts at a limit of zero.',
    },
    {
      q: 'Does DukaanAI send payment reminders?',
      a: 'Not today. DukaanAI keeps the ledger and the balances; reminders by SMS or WhatsApp are not built.',
    },
  ],
  related: ['/blog/manage-udhar-kirana-store', '/features/gst-billing', '/alternatives', '/glossary'],
  updated: UPDATED,
};

export const inventoryManagement: MarketingPage = {
  path: '/features/inventory-management',
  section: 'features',
  label: 'Inventory',
  title: 'Kirana Inventory Management: Stock, Expiry, Low-Stock Alerts | DukaanAI',
  description:
    'Stock goes down with every sale and up with every return. Low-stock alerts by reorder point, batches with expiry dates, stock history and restock suggestions.',
  eyebrow: 'Inventory management',
  h1: 'Inventory that updates itself with every bill',
  lede:
    'In DukaanAI there is one place stock changes: every sale, return, cancellation and adjustment moves it, and every movement is kept in the stock history. You see low stock and expiring batches before a customer asks for something you no longer have.',
  body: `
## Stock that follows your bills

A sale takes the quantity off the shelf, a return puts it back (unless it came back damaged or expired), and a cancelled bill reverses its stock completely. Stock is locked per product while a bill is saved, so two counters billing the same item at the same moment never leave the count wrong.

## Low-stock alerts by reorder point

Each product has a **reorder point**, 10 unless you set your own. When stock reaches it, the product gets a **Low Stock** badge, it appears on the dashboard’s **Low stock** card, and it is listed under **Inventory › Low Stock**. Out-of-stock items show as grey tiles on the billing screen. Not sure what number to choose? Our guide to [reorder points for kirana stores](/blog/reorder-point-kirana-store) works it out with examples.

## Batches and expiry dates

**Inventory › Batches & Expiry** lists batches with their expiry dates. Filters show only the expired ones, those expiring within 30 days, the safe ones, or the depleted ones, so the near-expiry stock can go to the front of the shelf.

## Adjustments with a reason

Goods received, damage, a recount: use **Update Stock** on the product with a positive or negative quantity and a reason (Correction, Manual count, Damage, Loss, Return, Expiry). Nothing changes stock without leaving a line in the history.

## Restock suggestions

The dashboard’s **AI insights** read your recent sales and current stock and show the day’s sales forecast, what to restock before it runs out, and your best-selling product. It refreshes by itself through the day.

## Adding products

Add a product with its cost price, selling price, MRP, GST slab and unit. Leave the SKU blank and DukaanAI numbers it for you. Type the shelf price including GST if that is easier, and the form works out the price before GST and shows what the customer will pay. A whole catalogue, with opening stock, can be imported from a spreadsheet on your first day, with our help.

## Who sees your costs

Cashiers sell and see stock levels, but never your cost prices, profit, stock value or supplier dues. Only owners and managers see those figures.
`,
  faqs: [
    {
      q: 'Does stock reduce automatically when I bill?',
      a: 'Yes. Every sale, return and cancellation moves stock in the same step as the bill, and each movement is kept in the stock history.',
    },
    {
      q: 'Can I track expiry dates?',
      a: 'Yes, by batch. **Inventory › Batches & Expiry** filters expired, expiring within 30 days, safe and depleted batches.',
    },
  ],
  related: ['/blog/reorder-point-kirana-store', '/features/bill-scanner', '/features/gst-billing', '/glossary'],
  updated: UPDATED,
};

export const billScanner: MarketingPage = {
  path: '/features/bill-scanner',
  section: 'features',
  label: 'AI bill scanner',
  title: 'Scan Supplier Bills with Your Phone: AI Bill Scanner | DukaanAI',
  description:
    'Take a photo of a supplier bill and DukaanAI reads its lines, matches them to your products with a confidence score, and exports them to CSV.',
  eyebrow: 'AI bill scanner',
  h1: 'Read a supplier bill from a photo',
  lede:
    'The **AI scanner** reads a photo of a printed supplier bill, lists each line it found, and matches it to the products you already sell with a confidence score. You check the matches instead of typing every line.',
  body: `
## How it works

1. Open **AI Scanner** and take a photo of the bill (or pick one from the phone). Large phone photos are scaled down before upload so it stays quick on a shop connection.
2. DukaanAI sends the image to an AI model that reads the items, quantities and prices.
3. Each line is matched against your products by name, and shown with how confident the match is.
4. Review the lines and export them as a CSV file.

The scanner only reads: it never changes your stock by itself. You stay in control of what goes into your records.

## Smart Capture: keep the bill itself

**Smart Bill Capture** uses the phone or tablet camera to photograph a bill and store it against a customer (or as walk-in), as a JPEG or a one-page PDF. It is useful for keeping the paper trail of a purchase or a large sale, and from there you can send the photo straight to the AI scanner.

## Honest limits

- Reading works on clear photos of printed bills; handwritten bills are hard for any model.
- Matching depends on your product names: the closer they are to what suppliers print, the better the matches.
- The AI scanner needs an AI key on the server. When it is not set, the screen says so and you can still store the bill with Smart Capture.

## Who can use it

Owners and managers. Purchase prices on supplier bills are financial information, and DukaanAI keeps those away from cashiers.
`,
  faqs: [
    {
      q: 'Does the bill scanner update my stock?',
      a: 'No. It reads the bill and matches the lines; you decide what to record. Stock moves only through recorded stock changes.',
    },
    {
      q: 'What photos work best?',
      a: 'A flat, well-lit, printed bill with the whole page in frame. Phone photos of any size are accepted and scaled down before upload.',
    },
  ],
  related: ['/features/inventory-management', '/features/gst-billing', '/blog/reorder-point-kirana-store'],
  updated: UPDATED,
};

export const cashDrawerShifts: MarketingPage = {
  path: '/features/cash-drawer-shifts',
  section: 'features',
  label: 'Cash drawer and shifts',
  title: 'Cash Drawer Tracking and Shifts for Retail Counters | DukaanAI',
  description:
    'Open a shift with the cash in the drawer, and at closing DukaanAI tells you how much cash should be there. Variances show in red, per cashier, every day.',
  eyebrow: 'Cash drawer and shifts',
  h1: 'Know how much cash should be in the drawer',
  lede:
    'Each cashier opens a **shift** with the cash in their drawer. At closing, DukaanAI shows the cash expected: opening cash, plus cash sales and cash repayments, minus cash refunds and cash paid out. The cashier counts, and any difference is recorded as the shift’s **variance**.',
  body: `
## A day at the counter

1. **Open shift**: type the opening cash in the drawer.
2. Sell as usual. Cash sales, cash refunds, udhar repayments taken in cash, and cash paid out for expenses or to suppliers are all tied to the open shift.
3. **Close shift**: count the drawer. The screen compares it with the expected amount.

## Variance you can act on

**Shifts** lists every shift with opening cash, sales, cash expected, counted, and **Variance**. A red variance means cash is missing. It stays recorded on the shift, with the cashier’s name, so a pattern is easy to spot.

## Cash refunds need an open shift

A cash refund comes out of a drawer, so the person giving it must have an open shift. This keeps every rupee that leaves the drawer on someone’s count.

## Several cashiers

Each cashier has their own sign-in and their own shift, and a cashier cannot open two shifts at once. Roles decide what each person can do: a cashier sells, takes payments, makes returns and runs their shift; a manager also handles products, credit limits, larger discounts, cancellations and suppliers; the owner sees everything.

## Expenses paid from the drawer

When an expense is paid in cash, it is recorded against the open shift, so the expected cash already accounts for it at closing.
`,
  faqs: [
    {
      q: 'Can I sell without opening a shift?',
      a: 'Yes, but the cash from those sales is not counted in any drawer, and cash refunds are not possible until a shift is open.',
    },
  ],
  related: ['/features/gst-billing', '/features/udhar-khata', '/faq'],
  updated: UPDATED,
};

export const FEATURE_PAGES: MarketingPage[] = [gstBilling, udharKhata, inventoryManagement, billScanner, cashDrawerShifts];
