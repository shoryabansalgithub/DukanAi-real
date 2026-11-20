# DukaanAI questions and answers

For cashiers and owners. The pilot in a real shop (`docs/PILOT.md`) has
not run yet. The answers below come from what the pre-flight tests found
on shop hardware (roadmap 9.19), the failure drills (9.18) and the
simulated business day (9.17).

Add every question the pilot shop asks to §6, then move it to its
section once support has answered it.

## 1. Billing

**I tapped Confirm and the screen showed an error with a Retry button. Did the sale go through?**
Maybe: the answer was lost on the way back. Tap **Retry**. The app sends
the same bill with the same key, so the server either completes it or
returns the one it already made. It never bills twice. Do not clear the
cart and bill again.

**The scanner beeps but nothing is added.**
- If the screen says *"No product with barcode …"*, the barcode is not on
  any product. Ask the manager to add it to the product (**Edit Product**).
- If the payment, hold or custom-item window is open, the scan is refused
  on purpose. Close the window and scan again.
- Scans typed into the search box while the page was still loading are
  lost. Wait for the product tiles to appear.

**Two products share a barcode.**
The app asks **Which product?**. Pick one, then ask the manager to fix
the barcodes.

**The customer wants a bigger discount than I can give.**
A cashier may give at most 10 % (line and bill together), and custom
items of at most ₹500. Call the manager: the same sale billed by them
goes through.

**"Credit limit exceeded".**
The customer's udhar would pass their limit. Take part of it in cash
(**Split**), or ask the manager to raise the limit.

**The receipt is cut off or too long.**
Set the printer to 80 mm roll paper with no margins, as in the hardware
section of `docs/PILOT.md`. The receipt prints in black on white even
when the app is in dark mode.

**"… is paused for maintenance. Everything else keeps working".**
Support has switched that feature off while they fix it. For credit
sales, take cash, UPI or card. For returns, note the item and return it
when the feature is back. For the AI scanner, store the bill with Smart
Capture and type the lines in. Everything else works normally.

## 2. Returns and cancellations

**Why is there no Cancel button on yesterday's bill?**
Only a bill from today with no returns can be cancelled, and only by a
manager. For older bills, use **Return**.

**"Open a shift before refunding cash".**
Cash refunds come out of your drawer, so your shift must be open. Open it
from the banner on **Billing (POS)**.

**The customer bought on udhar and is returning.**
The refund first reduces what they owe. Only the rest, if any, is paid
back.

## 3. Shifts and cash

**Can I sell without opening a shift?**
Yes, but the cash from those sales is not counted in any drawer, and you
cannot give cash refunds. Open a shift at the start of the day.

**The variance is red when I close.**
There is less cash than the app expected (opening cash + cash sales −
cash refunds). Count again, check for a sale paid by UPI but marked
Cash, and tell the owner. The amount stays recorded on the shift.

## 4. Customers and udhar

**How does a customer pay off udhar?**
Go to **Customers (Udhar)** › the customer › **Record payment**. Every
payment shows in their **Ledger**.

**I can't change a customer's credit limit.**
Only managers and above can. The change is recorded with their name.

**A customer wants to be removed from our records.**
The owner asks support (`docs/privacy/DATA_REQUESTS.md` §3). Any balance
must be settled first. Large bills keep the name and address for as long
as tax law requires.

## 5. Owner questions

**How do I give my accountant the GST figures?**
Go to **Reports & Analytics** › **Export** › **GST summary** (and
**Invoices** / **Invoice items**) for the month.

**The dashboard says "Refresh failed".**
One section could not load. It keeps showing its last figures, never
zeros, and tries again by itself. If it lasts more than a few minutes,
contact support.

**Where do I record goods I received from a supplier?**
On the product: row menu › **Update Stock**, a positive quantity, reason
Correction or Manual count. Purchase orders have no screens yet. Pay the
supplier from **Suppliers › Pay Supplier**.

**The AI scanner says "OCR is not configured on this server".**
The server has no AI key yet. Store the bill with **Smart Bill Capture**
and enter the lines by hand.

**I forgot my password.**
Tap **Forgot?** on the sign-in page. The link in the email works for one
hour and signs you out everywhere. To change a password you still know,
use **Settings › Account & Security › Change password**.

**Someone left the shop.**
Go to **Employees** › their row › **Suspend Access** or **Remove from
Shop**, the same day.

**Can I get all my data?**
Yes. Ask support: you receive the export within 7 days
(`OWNER_GUIDE.md` §7).

## 6. From the pilot

| Date | Question (as the shop asked it) | Answer | Moved to section |
|---|---|---|---|
| | | | |
