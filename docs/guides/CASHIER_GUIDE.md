# DukaanAI cashier guide

For the person at the counter. Every button name below is exactly what the
screen shows. Questions not answered here: ask the owner, or see the
FAQ (`FAQ.md`).

## Before you start the day

1. Sign in: **Email Address**, **Password**, **Sign In**. If you forgot your
   password, tap **Forgot?** and follow the email (the link works for one
   hour).
2. Open **Billing (POS)** from the menu on the left.
3. Open your shift. In the yellow banner, tap **Open shift**, type the cash
   in your drawer in **Opening cash in drawer (₹)** and confirm.
   - You can sell without a shift. But the banner then says *"No open
     shift — sales still record, but cash will not be tracked"*, and you
     cannot give cash refunds. Always open one.

## Making a sale

1. **Add items**, in whichever way is quickest:
   - **Scan** the barcode. The scanner works anywhere on the page; you do
     not need to click a box first.
   - **Search**: press **F2** or tap *"Search name, SKU or barcode…"*, type
     a few letters, then **↑ ↓** and **Enter**.
   - **Tap** a product tile. A grey tile is out of stock; an amber number
     means 5 or fewer left.
   - If a scan finds no product: *"No product with barcode …"*. If it
     finds several: pick the right one under **Which product?**.
2. **Change a quantity** with **−** / **+** or by typing it. To remove a
   line, tap its bin icon. **Clear cart** empties everything.
3. **Discounts.**
   - A line discount goes in that line's **Disc** box, in %.
   - A whole-bill discount goes in **Bill discount** (choose ₹ or %); you
     must then fill in **Reason for discount (required)**.
   - A cashier may give at most **10 %** in total. Above that, the sale
     is refused: call the manager to bill it.
4. **Something not in the catalogue?** Tap **Custom item** (F6). Fill
   Name, **Unit price (₹, before GST)**, Quantity and **GST slab**, then
   **Add to cart**. A cashier's custom line may be at most **₹500**; for
   more, call the manager.
5. **Customer (optional).** Tap *"Walk-in customer — search name or phone"*
   (F4) to find the customer. For a new customer, tap the add icon and
   fill Name, Phone and State, then **Save & select**. A customer is
   needed for credit (udhar).
6. **Take payment.** Tap **Charge ₹…** (F8) and choose one:
   - **Cash.** Type what the customer gave you in **Cash tendered** (or
     tap **Exact**, ₹100, ₹200 …). The screen shows **Change to return**.
   - **UPI / Card / Bank.** Add the transaction ID in **Reference** if you
     have it.
   - **Credit (udhar).** The whole bill goes on the customer's account.
     The screen shows their limit and their balance after the sale.
   - **Split.** Type an amount against each tender. Tick **Put the
     remainder on credit** to put the rest on the customer's account.
7. Tap **Confirm ₹…** (or press Enter). The **Sale complete** window opens:
   - **Print** prints the receipt;
   - **New sale** starts the next customer.

### If something goes wrong at payment

- A red box with **Retry**: the answer was lost (the network or the
  server). Tap **Retry**. The same bill is sent again, and **it will
  never be billed twice**; do not start the sale over. If Retry keeps
  failing, keep the customer's cart, call the owner, and write the items
  down.
- *"Credit limit exceeded …"*: put less on credit (split with cash), or
  call the manager.
- A line turns red with a stock message: there is not enough in stock. Change the
  quantity, or check the shelf and tell the manager.
- *"… is paused for maintenance. Everything else keeps working"*: the
  owner has switched that one feature off for now, for example credit
  sales. Use another way to pay. Everything else works as usual.

### Holding a bill

When a customer steps away, tap **Hold cart** (F9), give it a label (the
customer's name), then **Hold**. Find it again under **Held** and tap
resume.

## Returns

1. Open **Invoices**, find the bill (use **Invoice number** or the dates),
   then open it.
2. Tap **Return**. Under **Return now**, enter how many of each item come
   back.
3. Choose the **Reason** (Customer changed mind, Damaged / defective, Wrong
   item billed, Expired, Other) and **Refund via** (Cash, Upi, Card, Bank
   transfer).
4. Tap **Return N items · ₹…**, then print the return document.

- A **cash refund needs your open shift**.
- On a credit sale, the refund first reduces what the customer owes.
- You can return part of a bill now and more later. The screen shows
  what was already returned.

**Cancelling** a whole bill is for managers only, and only for a bill made
today with no returns. Otherwise, make a return.

## Credit (udhar) payments

When a customer pays off their udhar:

1. Go to **Customers (Udhar)**, open the customer's row menu, then
   **Record payment**.
2. Type **Amount received (₹)**, choose the **Tender**, add a reference if
   any.
3. Tap **Record payment**. The customer's **Ledger** tab shows it at once.

- A payment larger than what is owed is refused, unless you tick **Allow
  advance**: the extra becomes store credit. Ask the owner whether your
  shop does that.
- A cashier cannot change a customer's credit limit. Ask the manager.

## Closing your shift

1. Count the cash in the drawer.
2. Tap **Close shift** (in the banner, or on **Shifts**). The window shows
   **Expected in drawer**. Type **Counted cash (₹)**, and add a note if
   anything happened.
3. The result shows the **Variance**:
   - green: it matches;
   - blue: more cash than expected;
   - red: less than expected.

   Tell the owner about any red variance before you leave.

## Good habits

- Never sign in as someone else, and sign out when you leave the
  counter: tap your name at the top, then **Sign out** at the bottom of
  the box that opens.
- Cost prices, profit, stock value, suppliers, expenses and **Reports &
  Analytics** are for the owner and managers: they are not in your menu,
  and if you open one of those pages it says *"Only the owner or a manager
  can see this page"*. Selling prices, MRP, stock and invoices are all
  there for you.
- Print a receipt whenever the customer wants one. The invoice number on
  it (`INV-2627-000123`) is how the owner finds the bill later.
- Do not refresh the page in the middle of a payment. If the screen
  freezes, wait for **Retry**.
