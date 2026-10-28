import type { MarketingPage } from './types';

/**
 * Starter posts. Every legal statement here was checked against the CGST
 * Act and Rules as summarised in docs/compliance/GST_INVOICE_CHECK.md; each
 * post tells the reader to confirm with their own tax adviser.
 */

export const gstBillFormat: MarketingPage = {
  path: '/blog/gst-bill-format-kirana-store',
  section: 'blog',
  label: 'GST bill format for kirana stores',
  title: 'GST Bill Format for Kirana Stores: What Every Bill Must Show (2026)',
  description:
    'The particulars a GST tax invoice must carry under Rule 46, explained for a kirana counter: serial numbers, CGST and SGST, the ₹50,000 rule, HSN digits and the ₹200 exception.',
  eyebrow: 'GST guide',
  h1: 'GST bill format for kirana stores: what every bill must show',
  lede:
    'A GST-registered kirana store issues a **tax invoice** for each sale. Rule 46 of the CGST Rules lists what it must carry: your name, address and GSTIN, a serial number of at most 16 characters that is unique for the financial year, the date, each item with quantity, taxable value, GST rate and tax amount, and a few details that apply only in some cases. Here is each one in plain words.',
  body: `
## The particulars, one by one

| What | What it means at a kirana counter |
|---|---|
| Your name, address and GSTIN | Printed at the top of every bill. A bill without your GSTIN is not a valid tax invoice. |
| Serial number | Consecutive, unique for the financial year, at most 16 characters, using letters, digits, hyphen or slash. |
| Date of issue | The day of the sale. |
| Customer details | For a registered buyer: their name, address and GSTIN. For an unregistered customer: only when the bill is ₹50,000 or more (see below). |
| HSN code | Depends on your turnover (see below). |
| Description, quantity and unit | "Toor dal 1 kg, 2 PCS". |
| Taxable value | The value after any discount, before tax. |
| GST rate and amount | CGST and SGST for a sale in your own state; IGST for a supply to another state. Cess when it applies. |
| Total value | What the customer pays. |
| Place of supply | Needed with the state's name when the supply is inter-state. |
| Reverse charge | Whether tax is payable on reverse charge. For counter sales, "No". |
| Signature | Of you or an authorised person (or a digital signature). |

## Serial numbers: 16 characters, one series a year

The number must be consecutive and unique for the financial year (1 April to 31 March). You may use separate series, for example one for invoices and one for returns, but within a series there must be no gaps and no repeats. A common pattern is a prefix with the year and a running number, such as \`INV-2627-000001\`: 15 characters, inside the limit. Long patterns like \`INV-2026-27-000001\` are 18 characters and break the rule.

## CGST + SGST or IGST?

Goods sold over the counter are supplied where your shop is. So a normal counter sale is **intra-state**, and you charge CGST and SGST (each half of the rate: 18 % becomes 9 % + 9 %), even if the customer lives in another state. IGST is for goods you send to a buyer in another state.

## Customers who are not registered

For most counter customers you do not need their name at all. Once a single bill to an unregistered customer reaches **₹50,000**, Rule 46 asks for their name and address, the delivery address, and the state name and code.

## HSN codes on the bill

Notification 78/2020 sets the digits by your aggregate turnover in the previous year:

- **Up to ₹5 crore**: 4-digit HSN is mandatory on invoices to registered buyers (B2C bills may leave it out).
- **Above ₹5 crore**: 6-digit HSN on every invoice.

## Bills under ₹200

When a sale is under ₹200, the customer is unregistered and does not ask for a bill, you may skip the individual tax invoice and issue one consolidated tax invoice for all such sales at the end of the day. Many shops still print every bill, because it is simpler and customers ask for one.

## When you should not issue a tax invoice

- **Composition dealers** cannot charge GST. They issue a **bill of supply** that says "composition taxable person, not eligible to collect tax on supplies".
- A sale of only exempt goods is also billed on a bill of supply.

## Keep your bills

The CGST Act asks you to keep invoices and accounts for 72 months from the due date of the annual return for that year. A billing app that stores every bill, and lets you export them, does this for you.

## How DukaanAI prints a bill

DukaanAI prints every counter sale as a tax invoice with your GSTIN, a 15-character serial number in a new series each financial year, CGST and SGST split by rate, and Cess when an item carries it. It is built for B2C counter sales: it does not yet print HSN codes or a buyer's GSTIN, and has no bill of supply for composition dealers. See [GST billing in DukaanAI](/features/gst-billing).

> This guide explains the rules in general terms. Tax rules change and your situation may differ, so confirm with your chartered accountant before you change how you bill.
`,
  faqs: [
    {
      q: 'Is a GSTIN mandatory on a kirana bill?',
      a: 'Yes, for a GST-registered shop. The tax invoice must carry the supplier’s name, address and GSTIN.',
    },
    {
      q: 'How long can a GST invoice number be?',
      a: 'At most 16 characters, using letters, digits, hyphen or slash, consecutive and unique for the financial year.',
    },
    {
      q: 'Do I need the customer’s name on a GST bill?',
      a: 'Not for an ordinary counter sale to an unregistered customer. You need it (with address and state) when a single bill is ₹50,000 or more, and always for a registered buyer.',
    },
  ],
  related: ['/features/gst-billing', '/blog/gst-returns-credit-notes', '/glossary', '/faq'],
  updated: '2026-10-28',
  published: '2026-10-28',
};

export const manageUdhar: MarketingPage = {
  path: '/blog/manage-udhar-kirana-store',
  section: 'blog',
  label: 'How to manage udhar',
  title: 'How to Manage Udhar in a Kirana Store Without Losing Money',
  description:
    'Practical rules for giving credit to regular customers: limits per customer, who may approve credit, recording every rupee at the counter, and collecting on time.',
  eyebrow: 'Running the shop',
  h1: 'How to manage udhar in a kirana store without losing money',
  lede:
    'Udhar keeps regular customers coming back, but it is also where many shops quietly lose money. The fix is not to stop giving credit; it is to give it by rules: a **limit for each customer**, one person who can raise it, every credit sale written down at the moment of sale, and a regular day to collect.',
  body: `
## 1. Give every customer a limit

Decide a limit from what the customer buys in a normal month and how reliably they have paid. A family that buys ₹6,000 a month and pays on the 5th might get ₹3,000; a new customer gets nothing until you know them. The point of a limit is that the counter can say no without an argument: "the book does not allow more".

## 2. Only one or two people may raise a limit

If anyone at the counter can extend credit, credit grows with whoever is softest. Keep the decision with the owner or a trusted manager, and write down when a limit changes and who changed it.

## 3. Write it down at the moment of sale

Most udhar losses are not customers refusing to pay. They are sales that were never written down, or written in the wrong name, or written on a loose page that went missing. A credit sale should be recorded in the same step as the bill, against the customer's name and phone number, with the balance after it.

## 4. Separate the drawer from the khata

Cash that comes back as a repayment should go into the same count as the day's cash sales, so at closing you know how much should be in the drawer. When repayments are kept in a pocket or a separate box, the drawer and the book stop agreeing and nobody can tell why.

## 5. Look at the total every week

Add up what everyone owes. If the total keeps climbing while sales stay flat, credit is becoming a loan. Look for the customers who are over their limit, or who have not paid anything for a month, and talk to them before the amount becomes awkward.

## 6. Collect on a rhythm

Pick collection days that match how your customers are paid, for example the first week of the month for salaried families or market days for traders. Show the customer their ledger (every purchase and payment with dates); a clear statement settles most disputes at once.

## 7. Returns reduce the balance first

When a customer who bought on credit returns something, reduce what they owe before you give any cash back. Otherwise you can end up paying out cash for goods that were never paid for.

## 8. Do not keep two books

A paper khata next to a billing app means every credit sale is written twice, and sooner or later the two disagree. Keep credit in the same system as your bills.

## How DukaanAI helps

In DukaanAI, credit is a way to pay on the bill itself: the customer's limit is checked before the sale, only managers and owners can change a limit, every credit sale, payment and return shows in the customer's ledger with the balance after it, and cash repayments go into the open shift's drawer count. See [udhar tracking in DukaanAI](/features/udhar-khata).
`,
  faqs: [
    {
      q: 'How do I decide a customer’s credit limit?',
      a: 'Start from what they spend in a normal month and how reliably they pay, give new customers no credit until you know them, and review limits every few months.',
    },
  ],
  related: ['/features/udhar-khata', '/features/cash-drawer-shifts', '/alternatives'],
  updated: '2026-10-28',
  published: '2026-10-28',
};

export const reorderPoint: MarketingPage = {
  path: '/blog/reorder-point-kirana-store',
  section: 'blog',
  label: 'Reorder points for kirana stores',
  title: 'Reorder Point for Kirana Stores: When to Restock, With Examples',
  description:
    'Work out when to reorder each product: daily sales × supplier lead time + safety stock. Worked examples for fast and slow items, and how to treat expiry.',
  eyebrow: 'Inventory guide',
  h1: 'Reorder point for kirana stores: when to restock, with examples',
  lede:
    'A **reorder point** is the stock level at which you place the next order, so the new stock arrives before the shelf is empty. The usual formula is: **reorder point = average daily sales × days your supplier takes to deliver + safety stock**.',
  body: `
## The three numbers you need

- **Average daily sales**: how many units you sell on a normal day. Take the last 4 weeks of sales and divide by 28.
- **Lead time**: how many days pass between placing an order and having the stock on your shelf.
- **Safety stock**: a cushion for busy days and late deliveries.

## Example 1: a fast mover

You sell about 12 packets of a popular biscuit a day. The distributor delivers 2 days after you order. On festival weekends you can sell 20 a day.

- Daily sales × lead time = 12 × 2 = **24**
- Safety stock: the extra you might sell over those 2 days on a busy weekend, (20 − 12) × 2 = **16**
- Reorder point = 24 + 16 = **40 packets**

When the shelf and storeroom together fall to 40, order.

## Example 2: a slow mover

You sell about 2 bottles of a hair oil a week, roughly 0.3 a day, and the supplier comes once a week (7 days).

- 0.3 × 7 = about **2**
- Safety stock: **2** more
- Reorder point = **4 bottles**

## How much to order

The reorder point tells you **when**. For **how much**, a simple rule is to order enough for the time until the next delivery after this one, plus the safety stock. For a fast mover delivered every 2 days, that is a few days of sales; for a weekly supplier, about 2 weeks. Ordering more than you can sell before the expiry date is not a saving.

## Products with an expiry date

For milk, bread, curd and other short-life goods, the shelf life is the real limit. Keep the safety stock small, check near-expiry batches every morning, and move them to the front of the shelf. Your reorder point should never leave you holding more than you can sell before the date.

## Not every product deserves the same care

A small share of your products usually brings most of your sales. These **A items** (rice, oil, atta, sugar, the best-selling snacks) should never run out, so review their reorder points every month. The long tail of slow items can have simple, rough points and a quarterly review.

## Signs your reorder points are wrong

- The same items keep running out: raise their safety stock.
- Stock sits for months, or expires: lower the reorder point or order smaller quantities.
- Deliveries got slower: raise the reorder point by the extra days × daily sales.

## How DukaanAI helps

Every product in DukaanAI has a reorder point (10 unless you set your own). When stock reaches it, the product is flagged as **Low Stock** on the products list, the dashboard and **Inventory › Low Stock**, and batches close to expiry are listed under **Inventory › Batches & Expiry**. The dashboard's AI insights also suggest what to restock from your recent sales. See [inventory management in DukaanAI](/features/inventory-management).
`,
  faqs: [
    {
      q: 'What is the formula for reorder point?',
      a: 'Average daily sales × supplier lead time in days + safety stock. For 12 units a day, a 2-day lead time and 16 units of safety stock, the reorder point is 40.',
    },
    {
      q: 'How much safety stock should a kirana store keep?',
      a: 'Enough to cover the extra you might sell on a busy day, or a delivery that comes a day late. Keep it small for goods that expire quickly.',
    },
  ],
  related: ['/features/inventory-management', '/features/bill-scanner', '/glossary'],
  updated: '2026-10-28',
  published: '2026-10-28',
};

export const gstReturnsCreditNotes: MarketingPage = {
  path: '/blog/gst-returns-credit-notes',
  section: 'blog',
  label: 'Returns and credit notes under GST',
  title: 'Customer Returns Under GST: Credit Notes and the 30 November Deadline',
  description:
    'How a sales return works under GST: the credit note, what it must reference, the 30 November deadline in section 34, and refunds to customers who bought on credit.',
  eyebrow: 'GST guide',
  h1: 'Customer returns under GST: credit notes and the 30 November deadline',
  lede:
    'When a customer returns goods you billed with GST, you issue a **credit note** against the original invoice. It reduces your output tax for the returned value. Section 34 of the CGST Act sets a deadline: no credit note after **30 November** following the end of the financial year of the sale, or after you file that year’s annual return if that is earlier.',
  body: `
## What the credit note does

The original invoice charged GST on the full sale. When part of it comes back, the credit note records the returned quantity, its taxable value and the GST on it. That tax is reduced in your return for the period, so you do not pay GST on goods you took back.

## What it must show

Under Rule 53 a credit note carries, among other things:

- your name, address and GSTIN;
- its own serial number (at most 16 characters, consecutive in the financial year; a separate series from invoices is common, such as \`RET-2627-000001\`);
- the date;
- the number and date of the **original invoice**;
- the taxable value, the GST rate and the tax being credited;
- a signature.

## The deadline, with an example

A sale made on 10 January 2026 falls in the financial year 2025-26, which ends on 31 March 2026. A credit note for it can be issued until **30 November 2026**, or until the annual return for 2025-26 is filed, if that is earlier. After that, you may still take the goods back and refund the customer, but your output tax is not reduced.

## Partial and repeated returns

A customer may return 2 of 5 items today and 1 more next week. Each return is its own credit note against the same invoice, and together they can never exceed what was sold. Keep the refunds exact: the total refunded over every return should land on what was paid, without rounding errors piling up.

## Damaged and expired goods

A returned item that is damaged or past its expiry should not go back into sellable stock. Record it as a return for the customer's refund, and as a loss for your stock.

## Customers who bought on credit

If the original bill was on udhar, the return should first reduce what the customer owes. Pay out cash only for any amount that was actually paid.

## Cancelling a wrong bill

When a bill is wrong and caught at once, before the customer has left and before anything was returned, cancelling it is cleaner than a return. Keep cancellations for the same day and for a manager to approve; for anything older, use a return.

## How DukaanAI handles returns

In DukaanAI a return is made from the original bill and refunds exactly what was paid for the returned quantity, however many returns follow. Returns have their own numbered series, damaged or expired items are not put back into stock, a credit customer's balance is reduced before any cash is paid out, and a return after the section 34 deadline is refused so your tax is never reduced by mistake. A same-day bill with no returns can be cancelled by a manager. See [GST billing in DukaanAI](/features/gst-billing).

> This guide explains the rules in general terms. Confirm the treatment of your own returns with your chartered accountant.
`,
  faqs: [
    {
      q: 'What is the last date to issue a GST credit note?',
      a: '30 November following the end of the financial year of the original sale, or the date you file that year’s annual return, whichever is earlier (CGST Act section 34).',
    },
    {
      q: 'Can I refund a customer after the credit note deadline?',
      a: 'You can refund the customer, but your output GST is no longer reduced for that return.',
    },
  ],
  related: ['/blog/gst-bill-format-kirana-store', '/features/gst-billing', '/glossary'],
  updated: '2026-10-28',
  published: '2026-10-28',
};

/** Newest first. */
export const BLOG_POSTS: MarketingPage[] = [gstBillFormat, gstReturnsCreditNotes, manageUdhar, reorderPoint];
