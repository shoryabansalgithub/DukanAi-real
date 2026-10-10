# Pilot shop acceptance (roadmap 9.19)

> Status: the pre-flight is done and its defects are fixed and re-tested in
> the repository (§2, §3). The pilot itself, two weeks on staging and two
> on production in the owner's shop with the shop's own printer, scanner,
> tablet, phones and network, is run against the checklist of §5 and closed
> by the owner's sign-off (§7). Nothing in §5 or §7 can be filled in from
> here; those rows say `pending` until the shop runs them.

Roadmap row 9.19: *one real shop for two weeks on staging data, then
production: 80 mm thermal receipt printing from the browser on their
printer, a USB barcode scanner at the POS, the cashier tablet or phone
browser, the owner's phone for the dashboard, a weak mobile network
(timeouts and the idempotent retry), the AI scanner on real bills, Google
sign-in, invitations by real email, forgot-password. A checklist per
feature with pass or defect. Gate: checklist with every item passed;
defects fixed and re-tested; the pilot owner's sign-off.*

## 1. How this was prepared

A shop's hardware meets the web app in a handful of well-defined ways, and
each was emulated before the shop meets it, so the fortnight on staging is
spent on what only the shop can show (its printer's driver, its scanner's
settings, its network, its bills) rather than on defects a browser can find:

| The shop's reality | Emulated by |
|---|---|
| A USB barcode scanner (HID keyboard wedge): the code's characters a few ms apart and an Enter, wherever the focus is, on a tablet that may render slowly | `apps/web/e2e/pilot-preflight.spec.ts`: a CDP `Input.dispatchKeyEvent` burst with explicit timestamps 8 ms apart, queued at once like a scanner's (Playwright's `keyboard.type` waits for the page between keys, no scanner does); CPU throttling for a slow tablet; scans into the search box, the notes field, the open payment panel, the receipt, before the shop has loaded |
| An 80 mm thermal printer through the browser's print dialog (72 mm printable), from a device that may be in dark mode | the same suite: the receipt in `print` media, its width in mm, every element inside it, the shell hidden, text luminance after `beforeprint` in a dark-mode context; a PDF probe of Chrome's `@page` handling |
| The cashier's tablet or phone, the owner's phone | the suite's phone profile (Pixel 7, touch) on the POS and on the dashboard (the API's figures, a tap on refresh, no sideways scroll); a layout probe at 390, 768, 1024 and 1280 px recorded in §3 |
| A weak mobile network | the suite: an answer lost after the sale committed (the idempotent retry), Chrome's Slow 3G profile; the scan queued while `GET /shops/me` is 4 s late |
| Bills photographed with a phone (12 to 200 MP) | the suite: canvas JPEGs of 12 and 50 MP handed to the file inputs of the AI scanner and Smart Capture; an OCR failure that is not about configuration |
| Real email (invitations, reset links) through a real relay | `apps/api/test/integration/pilot-email.integration-spec.ts`: the API's own transport (`SMTP_URL`, nodemailer) delivers to an SMTP server in the test (`test/integration/smtp-sink.ts`); a relay that refuses the message |
| Google sign-in | unit and integration specs of `POST /auth/google` without a client id; the real-auth Playwright suite for the button |
| The production image itself | the 9.18 drill stack (production images of the commit before this work, behind the TLS edge): scans at 1x to 30x CPU, and `scripts/pilot/readiness.mjs` |

## 2. Pre-flight results

`npm run test:e2e -- e2e/pilot-preflight.spec.ts` in `apps/web` (19 tests,
about 1.5 minutes). "Before" is the web code of the commit this work
started from (its `src/` put back for the run) against this change's API,
so a web test fails on the web defect it is about; the API's own defects
have their own tests, which fail on the old API (§3). "After" is this
change. A test that needs a product in the cart before the step it is
about taps it in the grid, so it cannot fail on an earlier scan.

| Test | Before | After |
|---|---|---|
| a scan adds the product, a second scan adds one more | fail in the full run (the scan never reached the cart), pass alone 3 of 3: it depended on how busy the page was (P-01) | pass |
| a scan on a slow tablet (CPU at a sixth of the speed) still adds the product | fail: the scan never reached the cart (P-01) | pass |
| a scan while the shop is still loading on a weak network is added once it has loaded | fail: the scan was dropped without a word (P-02) | pass |
| a scan while the notes field has focus adds the product and leaves the notes as typed | fail: the scan never reached the cart (P-01) | pass |
| a scan while the payment panel is open never confirms the sale | fail: the scan's Enter confirmed the sale (P-04) | pass |
| a scan on the last sale's receipt starts the next sale with that product | fail: the scanned item was lost (P-05) | pass |
| a barcode that two products share can be resolved and sold | fail: the picker is not a dialog (P-07); on the old API it also showed ₹0.00 and 0 in stock (P-06) | pass |
| the printed receipt carries the stored CGST and SGST | fail: CGST ₹0.00 (P-08) | pass |
| a return receipt names the invoice it reverses | fail: no "Against INV-…" (P-09) | pass |
| long names and large amounts stay inside the 72 mm printable width | pass | pass |
| a device in dark mode still prints dark text on the paper | fail: the GST label and the footer in gray-200 (P-10) | pass |
| the menu starts closed, so the POS is what the cashier sees (phone) | fail: the menu open over the POS (P-12) | pass |
| the owner's phone: the dashboard shows the API's figures, a tap refreshes it, the page never scrolls sideways | fail 3 of 3: the open menu took the tap (P-12) | pass |
| an answer lost on the way back is retried with the same key and bills once | pass (the 9.18 Retry) | pass |
| a sale on a slow 3G link completes | pass | pass |
| the AI scanner sends a 50 MP photo scaled down instead of having it refused | fail: 30,014,817 bytes sent (P-14) | pass |
| a 12 MP photo goes up at a size a slow mobile uplink can carry | fail: 7,229,934 bytes sent (P-14) | pass |
| the AI scanner shows the API's own reason for a failure that is not about configuration | fail: "not a bill, try a sharper photo" for a refused request (P-13) | pass |
| Smart Capture stores a 50 MP gallery photo | fail: 413 (P-14) | pass |

The email specs (`pilot-email.integration-spec.ts`, 5 tests): the
invitation reaches the invitee through the relay with the shop's sender and
a working link; a refused invitation leaves nothing behind and the next
attempt succeeds; the reset link arrives and works once; a relay failure
on forgot-password gives the same answer as success and leaves no usable
link; Google sign-in on a server without a client id answers 503
`GOOGLE_SIGNIN_NOT_CONFIGURED`. Before this change the refused invitation
answered 500 and kept a row that refused every new invitation to the
address for 48 hours, the reset failure answered 500 for existing accounts
only, and the Google route read a client id no deployment passed.

### The scanner on the production build

The 9.18 drill stack runs production images of the commit before this
work. With the focus in the POS search box (each key re-renders the POS)
and a scanner burst arriving 8 ms apart, the old scanner hook, which timed
keys by when its handler ran:

| CPU throttling | Handler gaps | Scan |
|---|---|---|
| 1x | 3-10 ms | added |
| 4x | 0-74 ms (the 74 ms on the Enter, inside its 120 ms grace) | added |
| 6x | 0-49 ms | added |
| 10x | 31-126 ms | not added, the code left in the search box |
| 15x | 0-148 ms | not added |
| 20x | 0-239 ms | not added, the code left in the search box |
| 30x | 0-384 ms | not added |

Chrome's 10x throttling of this machine's CPU is in the range of a budget
Android tablet. The hook now times keys by `event.timeStamp`, when they
reached the browser, which a busy page does not change: the slow-tablet
test (6x on the development build) and every other scanner test pass.

### Readiness of a deployed environment

`scripts/pilot/readiness.mjs` against the drill stack's edge (images built
before this work) with a freshly registered owner read `NOT READY`, 7 pass
and 5 fail: HTTPS, both probes, the browser's API URL, the hidden metrics
and the owner's sign-in passed; it failed on the missing Google meta (the
older web image), no SMTP (forgot-password 503), the new shop's empty
profile (state, address, phone), no OCR key, and sign-ins lasting 720 h
where `.env.production` documents 12 h (defect P-16).

## 3. Defect log

Severity: **high** loses or misstates money, a sale or a document, or locks
people out; **medium** stops a feature or misleads; **low** costs time.
Every fixed defect of the product has a test that fails on the old code
and passes now, except P-11, which a PDF probe of Chrome's print output
proves (recorded in its row); P-22 and P-24 are defects of the tests.

| ID | Area | Severity | Defect (found by) | Fix | Re-test |
|---|---|---|---|---|---|
| P-01 | Scanner | high | Keys were timed by the handler, so a scan into a field that re-renders the POS was dropped whenever rendering one keystroke took longer than the 50 ms burst gap: the production build from 10x CPU throttling, the development build at 6x, and at 1x while the page was busy (the first test of the before-run) | `useBarcodeScanner` times keys by `event.timeStamp` | slow-tablet test; production-build table above |
| P-02 | Scanner, network | medium | A scan before `GET /shops/me` answered was dropped silently (the hook waits for the shop scope); on a weak network that is seconds | scans are queued, the cashier is told, and they are added once the cart is scoped | shop-loading test |
| P-03 | Scanner | medium | The scan's digits stayed in the focused field: the notes, a line quantity, the bill discount | the field's value before the burst is put back | notes test |
| P-04 | Scanner | high | With the payment panel open (where the scanner was off), the digits went into the cash tendered and the Enter confirmed the sale without the scanned item | the scanner stays on, its Enter is swallowed and the cashier is told to close the panel | payment test |
| P-05 | Scanner | medium | On the receipt, the Enter pressed the receipt's focused button and the scanned item was lost | the scan starts the next sale with that item | receipt-scan test |
| P-06 | Scanner, API | medium | A barcode shared by two products opened a picker showing ₹0.00 and 0 in stock (the candidates carried id and name only), and a stock-tracked pick was refused as out of stock | `GET /search/barcode` 409 candidates are whole lean products (`docs/POS_BILLING_CONTRACT.md` §5) | shared-barcode test; `pos-workflow` integration assertion |
| P-07 | Accessibility | low | Dialogs had no `role="dialog"` or name | the shared `Modal` is a named modal dialog | shared-barcode test |
| P-08 | Receipt | high | Every printed receipt (the POS's Print opens the receipt page) showed CGST, SGST and IGST as ₹0.00: the page read the tax split from the invoice header, which the receipt payload carries in `totals` | `mapReceiptPayload` reads `totals` | CGST/SGST test |
| P-09 | Receipt | medium | A return receipt did not name the invoice it reverses (`original` was not read) | read as `originalInvoice` | return-receipt test |
| P-10 | Receipt | medium | A device in dark mode printed the GST summary label and the footer in near-white (gray-200), which a thermal printer leaves blank | every print is in the light theme (`beforeprint` / `afterprint` in `PrintPageStyle`) | dark-mode test |
| P-11 | Receipt | low | The receipt's `@page { size: 80mm auto }` is invalid CSS, so every browser ignored it: the printer's default paper decided (a PDF probe printed US Letter). `80mm` alone cuts a long receipt into 80 mm pages | the ignored declaration is gone, the margin stays; the roll is set in the printer driver (§4) | PDF probe |
| P-12 | Phone | medium | The menu started open on every page load on a phone and its overlay covered the page: the POS for the cashier, the dashboard for the owner | closed by default (from 768 px the sidebar is always shown, unchanged) | the cashier's and the owner's phone tests |
| P-13 | AI scanner | medium | Every 502 read "the model answered with something that is not a bill, try a sharper photo", including a refused key, an exhausted quota and a timeout | the panel follows the API's code (`OCR_MODEL_ERROR`, `OCR_TIMEOUT`, ...) and shows its message | OCR failure test |
| P-14 | Photos | medium | A 50 MP gallery photo (30 MB) was refused by both the AI scanner and Smart Capture (10 MiB limits); a 12 MP photo (7 MB) needs about 140 s on Slow 3G, past the scanner's 90 s timeout | photos are re-encoded before upload: 2048 px long edge for OCR, 3072 px for stored bills (`src/lib/photo.ts`) | three photo tests |
| P-15 | AI scanner, API | medium | Three model attempts could take 93 s; the edge cuts an upstream at 60 s, so the user got the edge's 504 while the API kept calling the model | `OCR_TOTAL_TIMEOUT_MS` (50 s) bounds all attempts and backoffs | `ocr.service.spec.ts` |
| P-16 | Configuration | high | The image carries no env file, so production ran code defaults that differed from `.env.production` and from every environment the tests run in: 30-day sessions instead of 12 h (ASVS 3.3.2), an OCR match threshold of 0.4 instead of 0.85, 5 search suggestions instead of 50, a 15-minute stock reconciliation window instead of 24 h, and 11 more | every class default equals `.env.production`; `src/config/production-defaults.spec.ts` fails the build when they part, unless the deployment sets the variable (compose and Kubernetes checked) | the spec; readiness check (720 h) |
| P-17 | Google sign-in | high | No deployment could offer Google sign-in: the API read `GOOGLE_CLIENT_ID` that compose and Kubernetes never passed, and the button depended on a build flag no image set | `AuthConfig.googleClientId` (503 `GOOGLE_SIGNIN_NOT_CONFIGURED` when unset), passed by both compose files and the Kubernetes Deployment; the button follows the web's credentials at run time | unit, integration and real-auth tests |
| P-18 | Google sign-in | low | Every refused Google sign-in said "if you registered with a password, sign in with it", whatever the cause | only the API's 409 says that; a server without the client id and an unreachable API say so | real-auth test |
| P-19 | Invitations | high | An invitation whose mail the relay refused answered 500 and kept the row, which refused every new invitation to that address for 48 h | the row is removed and the answer is 502 `INVITATION_EMAIL_FAILED`; the owner can retry at once | SMTP-sink integration test |
| P-20 | Forgot password | medium | A relay failure answered 500 for an existing account only (an account oracle) and left a live reset token | the same answer as success, the token voided, the failure logged and counted | SMTP-sink integration test |
| P-21 | Email, operations | medium | A failing relay was invisible: reset links fail silently by design | `email_messages_total{purpose,outcome}` and the `DukaanAiEmailDeliveryFailing` alert (promtool test) | `alerts.test.yml` |
| P-22 | Tests | low | `pos-checkout.spec.ts` asserted the receipt number without `await` | awaited | the suite |
| P-23 | POS search, API | medium | Typing a product's full name in the POS did not find it once more than 100 products shared one of its words (every "Tata …", every "… 1kg"): the candidates were one unordered list cut at `SEARCH_FUZZY_CANDIDATE_LIMIT` before ranking, so the newest products were never ranked at all (found when the pre-flight's own products piled up in the test shop) | candidates are two ordered lists: rows holding the whole query in the name, SKU or alias first, then the broad full-text set by relevance | `search-recon-dashboard` integration test (120 products sharing three words; fails on the old code); every pre-flight test that adds a product by name |
| P-24 | Tests | low | `correctness.spec.ts` reached the forgot-password page by clicking "Forgot?" on `/login`, which under the auth bypass leaves for the dashboard as soon as it hydrates: on a warm development server the redirect won and the test waited out its two minutes (found by this change's full e2e run) | the link is read from the served login markup and the test opens the page itself | the suite (and three repeats) |

Recorded for the owner's decision. These are layout changes, which this
work does not make (the brief excludes UI, layout and styling changes);
each was measured on the development build:

| ID | Where | Observation | Proposal |
|---|---|---|---|
| L-01 | POS, every size | The Charge button is below the fold at every size measured: top at 878 px on a 1024x768 landscape tablet, 842 px on a 1280x720 laptop, about 1,660 px on a phone. The cashier scrolls to charge; F8 needs a keyboard | a Charge bar fixed to the bottom of the viewport below about 900 px of height |
| L-02 | POS, tablet | Product tiles truncate names to about ten characters at 1024 px ("Tata Sal…" for both a 1 kg and a 500 g pack) | two-line names, or fewer, wider tiles on tablets |
| L-03 | Dashboard, phone | Lakh figures are cut ("₹10,5…", "₹4,40,…") on a 390 px phone, and at every width once a figure has eight digits | a smaller figure font on narrow tiles, or the compact Indian form (₹10.5 L) |
| L-04 | Every page, phone | The fixed menu button overlaps the navbar's search field | move the button into the navbar row |
| L-05 | POS, phone and tablet portrait | The cart sits below the product grid (first line at about 1,160 px) | a cart summary bar, or tabs for products and cart |
| L-06 | POS, 1024 px landscape | The always-shown sidebar takes 256 px of the POS's width | collapse the sidebar on the POS below 1280 px |

Found walking the runbooks (roadmap 9.22, `docs/RUNBOOKS.md` §7), open for
the owner's decision because the fix needs a screen as well:

| ID | Where | Observation | Proposal |
|---|---|---|---|
| R-01 | Product photos | A photo that cannot be decoded (cut off in transit from a phone) passes the upload's signature check, fails its thumbnail job three times and stays in the product's gallery as a broken image: no route removes a media asset | `DELETE /media/:id` (MANAGER+) and a remove button in the gallery; meanwhile the shop uploads the photo again |

## 4. Setup before day 1

**Readiness.** On staging, then on production before its fortnight:
`PILOT_OWNER_EMAIL=... PILOT_OWNER_PASSWORD=... node scripts/pilot/readiness.mjs --web https://<WEB_HOST> --api https://<API_HOST> --json readiness.json`
must end `READY` (a WARN only for Google sign-in where the shop does not
use it). It sends no mail, never calls the OCR model and creates nothing.

**Shop profile.** Settings › Shop Profile: name, address, phone and the
state (the state decides CGST/SGST against IGST); the GSTIN prints on every
receipt when set. The shop's time zone is Asia/Kolkata (`ShopSettings.timezone`,
the default): the business day, invoice dates and the dashboard follow it.

**The shop's data.** Products, the counted opening stock and the customers
with their opening udhar are imported on day 0 by the procedure in
`docs/ONBOARDING.md` (each file a dry run first, the reconciliation CLEAN
afterwards), not typed in at the counter.

**Thermal printer (80 mm).** Printing goes through the browser's print
dialog, so the device that prints needs the printer's driver:

- A Windows or Linux PC at the counter with the vendor's driver prints from
  Chrome directly. In the driver: roll paper 80 mm (72 mm printable), the
  paper-saving / blank-paper reduction option on, auto-cut at the end of
  the document. In Chrome's dialog the first time: the thermal printer,
  paper size the roll, margins "Default" (the receipt sets 4 mm), scale
  100 %, "Headers and footers" off; Chrome remembers them.
- An Android tablet needs a print service that speaks to the printer (the
  vendor's app or a generic ESC/POS service); Mopria does not drive most
  thermal printers. Prove it on day 0: if no service works with the
  shop's printer, the counter PC prints and the tablet bills.
- An iPad prints only to AirPrint printers; few thermal printers are.
- Dark mode on the printing device is fine: receipts print in the light
  theme (P-10).

**USB barcode scanner.** Keyboard (HID) mode, the keyboard layout of the
device it is plugged into (US for most), suffix Enter (CR), no prefix, no
inter-character delay. On an Android tablet a USB OTG adapter; a Bluetooth
scanner in HID mode works the same. Prove it with three codes: a packaged
EAN-13, a short shop code, and a code that two products share (the picker
appears with prices).

**Devices.** The cashier: Chrome, a tablet in landscape (1024 px or wider)
or a laptop; page zoom 100 %. The owner: Chrome or Safari on the phone, the
dashboard added to the home screen. Device clocks on network time.

**Accounts.** The owner registers (or signs in with Google once both sides
are configured: `GOOGLE_CLIENT_ID` on the API and the web, the secret on
the web and the redirect URI in Google Cloud, `DEPLOYMENT_CHECKLIST.md`;
the readiness check's `google-signin` line then passes); staff are invited
by email from Employees (the mail must arrive: SMTP and a sender domain
with SPF/DKIM, `EMAIL_FROM`); the cashier's role is CASHIER. A sign-in
lasts at most 12 hours (`SESSION_ABSOLUTE_LIFETIME`), so a longer shop day
signs in again once.

**Network.** The shop's mobile network is fine for billing: a sale is one
small request, and a lost answer is retried with the same key ("retrying
will not create a duplicate bill"); the cashier presses Retry, never a
second Charge. Photos are scaled before upload (P-14).

## 5. Checklist

Run each row on staging (shop data, two weeks), then on production (two
weeks). A row passes when every expected result holds on the shop's own
hardware; anything else is a defect: give it the next `P-` number in §6,
fix it, re-test it here, and note both ids in the row. Evidence is a
photo of the paper, a screenshot or the invoice number.

| # | Feature | Steps | Expected | Staging | Production | Evidence |
|---|---|---|---|---|---|---|
| 1 | Receipt on the shop's printer | Sell 3 items (one with GST 5 %, one 18 %, one exempt) and Print from the POS receipt; reprint from Invoices › the invoice › Print | 72 mm wide, nothing cut at the right edge; shop name, address, GSTIN; invoice number and date-time in IST; every line, quantity and amount; Taxable, CGST and SGST each the invoice's figures (not ₹0.00); grand total, paid and change; one cut; the paper fed no further than the receipt | pending | pending | |
| 2 | Interstate sale | Bill a customer whose state differs from the shop's | IGST row with the full tax, no CGST/SGST | pending | pending | |
| 3 | Return receipt | Return one line of a sale and print | "SALES RETURN", "Against <the sale's number>", the refund | pending | pending | |
| 4 | Long names, large amounts | A product with a 60-character name sold at ₹98,765 × 3 | wraps inside the paper, totals intact | pending | pending | |
| 5 | Dark mode device | Print a receipt from a device in dark mode | black text, nothing missing | pending | pending | |
| 6 | Scanner, search focused | Open the POS, scan a product twice | one line, quantity 2 | pending | pending | |
| 7 | Scanner, anywhere | Scan with the focus in the notes, the customer search and a line quantity | the product is added; the field keeps what was typed in it | pending | pending | |
| 8 | Scanner, payment open | Press Charge, then scan | the sale is not confirmed; the warning says to close the panel | pending | pending | |
| 9 | Scanner, receipt shown | Complete a sale, scan the next customer's item on the receipt | the next sale starts with that item | pending | pending | |
| 10 | Scanner, unknown and shared codes | Scan a code nobody has; scan a code two products share | "No product with barcode …"; a picker with both products' prices, the chosen one sold | pending | pending | |
| 11 | Scanner, right after opening the POS | Open the POS and scan at once, on the shop's network | added (or "added as soon as the shop has loaded", then added) | pending | pending | |
| 12 | Cashier tablet or phone | Sign in, open the shift, sell, close the shift | every step reachable (L-01, L-02, L-05 are known); the menu closed on a phone | pending | pending | |
| 13 | Owner's phone | Open the dashboard during trading, pull to refresh | figures match the day's sales (L-03 is known); a failed refresh says so and keeps the figures | pending | pending | |
| 14 | Weak network, lost answer | Turn mobile data off right after pressing Charge, on again, press Retry | one invoice in Invoices, never two; the receipt shows | pending | pending | |
| 15 | Weak network, slow link | Bill on the weakest signal in the shop | the sale completes; nothing billed twice | pending | pending | |
| 16 | AI scanner, real bills | Scan ten supplier bills of different layouts with the shop's phones, on the shop's network | the lines read are the bill's; matched products are right or unmatched (record each wrong match with its confidence); a failure says why | pending | pending | |
| 17 | Smart Capture | Photograph a bill and save it (photo and PDF) to a customer | stored under the customer's Bills; opens later | pending | pending | |
| 18 | Google sign-in | Sign in with Google as the owner; try Google with a password-registered address | the dashboard; "sign in with your password" for the second | pending | pending | |
| 19 | Invitation by real email | Invite a cashier to a real address; accept from the mail on their phone | the mail arrives within a minute (check spam), the link opens registration in join mode, the cashier signs in with the CASHIER role | pending | pending | |
| 20 | Invitation to a wrong address | Invite an address the relay refuses | a clear failure; inviting again works | pending | pending | |
| 21 | Forgot password | Request a reset for the owner, follow the link, set a new password | the mail arrives; the link works once; the old password and every open session stop working | pending | pending | |
| 22 | Day end | Close the shift; the next morning check the reconciliation | the cash count matches; `GET /reconciliation/latest` (or the nightly run) is CLEAN | pending | pending | |
| 23 | Session lifetime | Leave the POS signed in through a long day | after 12 h the cashier is asked to sign in again, nothing is lost | pending | pending | |

## 6. Defects found in the shop

| ID | Row | Found on | Defect | Fix (commit) | Re-tested on |
|---|---|---|---|---|---|
| | | | | | |

## 7. Sign-off

| | Staging | Production |
|---|---|---|
| From – to | | |
| Shop | | |
| Hardware (printer, scanner, tablet, phones) | | |
| Every row of §5 passed | | |
| Every §6 defect fixed and re-tested | | |
| Readiness check `READY` (date, `readiness.json`) | | |

Pilot owner: name, date, signature: ______________________

Operator: name, date: ______________________
