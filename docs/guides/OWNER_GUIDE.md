# DukaanAI owner guide

For the shop's owner and managers. Everything in the cashier guide
(`CASHIER_GUIDE.md`) applies to you too. This guide covers what only you
do: setting up the shop, staff, stock, credit, cancellations, reports and
getting help. Button names are exactly what the screen shows.

## 1. Setting up the shop

1. **Settings › Shop Profile.** Fill **Shop Name**, **GSTIN**, **Shop
   Address**, **City**, **State**, **PIN Code**, **Phone** and **Email**,
   then **Save Changes**.
   - **GSTIN is required.** Every receipt is printed as a TAX INVOICE and
     charges GST. That is lawful only with your registration number on
     it.
   - **State** is where your counter sales are taxed: every sale at the
     counter is billed CGST + SGST, whatever state the customer lives in
     (the place of supply is your shop). IGST is for goods you supply to
     another state, which the POS does not bill.
2. **First-day data.** Bring in your products, customers (with their
   udhar balances) and opening stock from spreadsheets. Support runs this
   with you, following `docs/ONBOARDING.md`. Check every number on the
   dry-run report before it is applied.
3. **Staff.** Go to **Employees › Invite Employee**, enter the **Email
   Address** and a **Role**, then **Send Invitation**. The person gets an
   email with a link and joins with their own password.

   | Role | Can |
   |---|---|
   | Cashier | sell, take payments, make returns, open and close their shift |
   | Stock Clerk | look at products, stock, customers and invoices, but not change anything |
   | Manager | everything a cashier does, plus: products, stock, customers' credit limits, larger discounts and custom items, cancellations, suppliers, invitations below Manager |
   | Admin | everything a manager does, plus: deleting products and suppliers, suspending and removing staff |
   | Owner | everything |

   - You can only invite roles below your own.
   - Cashiers and stock clerks never see what you paid for a product, your
     profit, the value of your stock, what you owe suppliers, your expenses
     or **Reports & Analytics**: those menu items and dashboard tiles are not
     shown to them, and the pages say "Only the owner or a manager can see
     this page". Managers and admins see everything you see.
   - When someone leaves, use **Suspend Access** or **Remove from Shop**
     on their row the same day.

## 2. Stock

- **Adding a product:** **Products / Stock › Add Product**. The cost price
  is required. **Initial Stock** becomes the opening balance. Leave SKU
  blank and the app numbers it for you. The selling price is before GST
  unless you tick **The selling price I type includes GST**: then type the
  shelf price and the app works out the price before GST. Either way the
  form shows **Customer pays ₹… incl. GST**; check it against the price on
  the pack. The MRP can never be below what the customer pays.
- **Goods received, damage, a recount:** use the product's row menu ›
  **Update Stock**. A positive quantity adds stock and a negative one
  removes it. Pick the **Reason** (Correction, Manual count, Damage, Loss,
  Return, Expiry) and **Save adjustment**. Every change is kept in the
  stock history.
- **Purchase orders and goods-receipt notes** exist in the system but have
  no screens yet. **Record Purchase** on the Suppliers page only says so.
  Until those screens exist, record received goods with **Update Stock**,
  and supplier payments with **Pay Supplier**.
- **Low stock:** the dashboard's **Low stock** card, the products' **Low
  Stock** badge (at or below the reorder point, 10 unless set), and
  **Inventory › Low Stock**. **Inventory › Batches & Expiry** lists batches
  that are expiring or expired; **Filters** shows only the expired, the
  expiring within 30 days, the safe or the depleted ones.

## 3. Customers and credit (udhar)

- **Customers (Udhar)** lists everyone with **Outstanding**, **Credit
  limit** and **Available**. **Over limit** flags those past their limit.
- **Credit limit:** only a manager or above can set it. The change is
  recorded with your name.
- A customer's page has the **Ledger** (every sale on credit, payment and
  return, with the balance after each) and their **Invoices**.
- A customer asks to be removed from your records: delete them from the
  row menu (managers), and ask support to erase their personal details
  (§7). Settle their balance first.

## 4. Cancellations and returns

- **Cancel** (managers and above) is only for a bill made **today** with
  no returns: for example a wrong bill caught at once. It reverses
  everything: stock, money and credit.
- Anything older, or partial: use **Return** (`CASHIER_GUIDE.md`). Returns
  add up correctly however many times a bill is returned against.
- A cash refund or cancellation needs the person doing it to have an
  open shift.

## 5. Shifts and cash

- **Shifts** lists every shift: opening cash, sales, cash expected,
  counted and **Variance**. Look at the variances every day. A red one
  means cash is missing.
- The dashboard's **Shift** card shows whether a shift is open now.

## 6. Reports

- **Dashboard:** today's sales (net of returns), gross profit, orders,
  outstanding udhar, low stock, payment modes today, recent invoices and
  **AI insights**: the day's forecast, what to restock, your best
  product. It refreshes by itself. A section that could not load says so
  ("Refresh failed") and keeps its last figures; it never shows zero
  instead.
- **Reports & Analytics:** revenue trend, payment methods, top categories,
  top customers. **Export** gives three CSV files for the chosen dates:
  **Invoices**, **Invoice items** and **GST summary** (taxable value and
  tax by rate). The GST summary is what your accountant needs for the
  return.
- **Invoices:** filter by dates, type (sales or returns), status, or
  invoice number. Open a bill to print it on A4.
- **Checking the books:** the system checks every day's sales, payments,
  credit, stock and ledger against each other overnight. If it finds a
  difference, support sees it the next morning and contacts you.

## 7. Your data

- **A copy of everything:** ask support. Within 7 days you receive one
  archive with all your records (JSON and CSV for a spreadsheet), your
  stored documents and photos (`docs/privacy/DATA_REQUESTS.md`).
- **Leaving DukanAI:**
  1. Ask support to close your account.
  2. Your shop is paused at once and you get the copy.
  3. Your shop's personal data is deleted 30 days later. You can change
     your mind until then.
- **Keep your copy.** GST law asks you to keep invoices and accounts
  for about six years after the year's annual return. DukaanAI keeps
  them while you are a customer; once you leave, your copy is your
  record.
- How DukaanAI handles your and your customers' data:
  `docs/privacy/PRIVACY_NOTICE.md`.

## 8. When something is wrong

- Contact support (`docs/SUPPORT.md`): phone or WhatsApp during shop
  hours, email any time. Say what you were doing, the time, and the
  invoice number if there is one.
- A message *"… is paused for maintenance. Everything else keeps
  working"* means support has switched one feature off while they fix it.
  Use the other ways to do the same thing (`FAQ.md`). Support tells you
  when it is back.
- If the app does not load at all, write bills on paper with the time,
  and enter them when it is back. Each bill gets its own invoice number
  then.

## 9. Security

- Everyone signs in with their own account. Never share passwords.
- **Settings › Account & Security** lists your signed-in devices. **End
  session** signs one out; **Sign out** signs you out everywhere.
- To change your password: **Settings › Account & Security › Change
  password** (current password, then the new one twice). Every device is
  signed out and you sign in again with the new one. Forgotten it? Use
  **Forgot?** on the sign-in page; a reset also signs out every device.
