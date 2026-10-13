# Personal data inventory

Roadmap 9.24. What personal data DukaanAI stores, where, why, for how
long, and how it is exported or erased. It is a draft for the owner's
advisor to review (status at the end).

The same inventory is also code: `apps/api/src/privacy/personal-data.ts`
classifies every text and JSON column of every table, and
`personal-data.spec.ts` fails when a column that could hold personal data
has no class. The export and erasure tools use those classes, so this
document, the tools and the schema all describe the same columns.

## 1. Roles

| Whose data | Example | DukanAI's role | The shop's role |
|---|---|---|---|
| The shop's owner and staff (accounts) | name, email, phone, role, sign-in history | Data fiduciary: DukanAI decides why and how account data is used (to sign people in and keep the service secure) | Provides the staff list |
| The shop's customers | name, phone, address, purchases, credit (udhar) balance | Data processor: DukanAI acts only on the shop's instructions | Data fiduciary: the shop decides to keep a customer's details and owes the customer the notice, the consent and the answers to their requests |
| The shop's suppliers' contact people | contact name, phone, email, GSTIN of a sole proprietor | Processor | Fiduciary |
| People visiting the web app without an account | IP address in the edge and API logs | Fiduciary (security logging) | — |

The roles above are those of India's Digital Personal Data Protection Act,
2023 and the DPDP Rules, 2025. The Rules' core obligations (notice,
erasure, breach reporting, log retention) apply from about 13 May 2027.
That date comes from secondary sources and must be confirmed against the
gazette text before it is relied on.

## 2. Stores

### 2.1 The database (MySQL 8)

Each shop's rows carry its `shopId`, or belong to a row that does: the
child tables (an invoice's lines, a customer's audit trail and addresses,
an import's report rows, a photo's metadata, a webhook's delivery log, a
revision's reviews, a stock transfer's items) have no shop column and are
reached through their parent (`childModels` in `personal-data.ts`, derived
from the schema). Export and erasure cover them the same way; a table that
is neither a shop's, nor a child of one, nor listed with a reason
(`NOT_SHOP_DATA`: session and reset tokens, event bookkeeping) fails
`personal-data.spec.ts`. Requests are kept apart by the tenant extension
(`src/prisma/tenant-scope.ts`), and the operator tools work on one shop at
a time.

| Table(s) | Personal data | Purpose | Retention | Erasure |
|---|---|---|---|---|
| `Shop`, `ShopSettings` | trading name, address, city, pincode, phone, email, logo, GSTIN | identifies the shop on its invoices (GST Rule 46) and to support | while the shop is a customer | `shop-data erase`: anonymised, status DELETED |
| `User` | name, email, phone, role, password hash, Google id, last sign-in time and IP | sign-in, roles, audit trail | while the account exists; closed on the shop's request | anonymised (`erased-<id>@erased.invalid`), password removed, deactivated |
| `RefreshToken` | IP, user agent, token hash (no token itself) | sessions and the sessions list | 7 days after expiry (retention sweep) | deleted |
| `PasswordResetToken`, `Invitation` | email, token hash | password reset, joining a shop | reset: 7 days after use or expiry; invitation: until accepted, revoked or expired (48 h) | deleted |
| `LoginAttempt` | email, IP, user agent | brute-force defence, investigating account abuse | until the account is closed | deleted with the account |
| `Customer` (and the enterprise tables `CustomerProfile`, `CustomerAddress`, `CustomerContact`, `CustomerDocument`, unused by the web) | name, phone, email, address, city, state, notes, tags, credit limit and balance | billing, credit (udhar) and statements, on the shop's instruction | as long as the shop keeps the customer; GST invoice details for the retention period (§3) | `shop-data erase-customer` (one customer) or `shop-data erase` (the shop) |
| `CustomerAudit` | written on every create, update and delete of a customer (the web, the API and onboarding imports): the whole customer row as created, the changed fields with their old and new values, the actor and the client IP | the customer's change history | as long as the shop keeps the customer | payloads and IP erased with the customer (`erase-customer`) or the shop (`erase`); the action, time and actor stay |
| `Invoice`, `InvoiceItem`, `InvoicePayment`, `UdharTransaction` | the customer (by id), what they bought, amounts, tender, free-text notes, discount and cancellation reasons | the sale, its tax, the shop's books | GST retention period (§3) | free text erased; amounts stay (non-personal once the customer row is anonymised) |
| `LedgerTransaction`, `LedgerPosting` | none: document references only, since migration `20261011090000` | the books | immutable (database triggers) | not needed |
| `Supplier`, `Manufacturer`, `Warehouse` | contact person, phone, email, address, GSTIN (a sole proprietor's is a person's) | purchasing | while the shop keeps the supplier | anonymised |
| `Expense`, `Shift`, `InventoryLog`, procurement documents | free text (descriptions, notes, remarks, reasons, comments, signatures); an expense's receipt path (`Expense.receiptPath`, the file is in §2.2) | the shop's records | the shop's records | free text and receipt paths erased |
| `AuditLog` | who did what (user id), the row before and after (may contain a customer's details), IP, user agent | accountability, investigating disputes | while the shop is a customer | snapshots, IP and user agent erased; the action, time and user id stay |
| `Notification` | messages that may name a product or customer | in-app notices | until the shop deletes them | deleted |
| `SearchHistory`, `SearchAnalytics`, `SearchClick`, `SavedSearch` | what staff typed into search boxes | the popular-searches card | `SearchHistory` 90 days (retention sweep); the others while the shop is a customer | deleted (`SearchHistory`) or query text erased |
| `ImportJob`, `ImportJobRow` | the uploaded file's name and every raw row (customer lists hold names and phones), the planned changes and the problems of each row (they quote the cells) | onboarding imports and their reports (`GET /imports/jobs/:id/rows`, `/report`: management only) | while the shop is a customer | `erase`: raw rows, changes, problems and file names erased, the files deleted; `erase-customer`: the report rows of a customer import that carry the customer's phone or email are emptied and every uploaded import file that holds them is deleted |
| `MediaAsset` and the media tables | the original file name of an uploaded photo, EXIF data (may include a location) | product photos | while the product exists | file names and EXIF erased; files deleted unless another shop uses the same file |
| `OutboxEvent`, `ProductEventLog`, `WebhookDelivery`, `DeadLetterEvent` | event payloads (a sale's payload names its customer id and amounts); a delivery's error message | delivering events | DONE outbox rows 14 days, `ProductEventLog` 180 days, `WebhookDelivery` 30 days (retention sweep) | payloads and error messages erased |
| `RevisionApproval` | a reviewer's comments and signature on a catalogue change | catalogue change review | while the product exists | free text erased |
| `WebhookEndpoint` | the shop's webhook URL and its signing secret | integrations the shop configured | while configured | URL erased |
| `ReconciliationRun` | none (figures and document ids) | checking the books | while the shop is a customer | not needed |

The scaffolding tables of the detached enterprise stacks (sales orders,
enterprise invoices, workflow, pricing) receive no writes from the web
app. They are still classified, and are still covered by export and
erasure.

### 2.2 Files

| Store | Personal data | Retention | Erasure |
|---|---|---|---|
| `STORAGE_ROOT/<shopId>/` (documents volume) | customer folders: invoices, Smart Capture bill photos, statements, payment slips, profile documents; `Expenses/<id>/` receipt photos and PDFs (a replaced one moves to `Deleted/`) | while the shop is a customer; invoices for the GST retention period | `erase` removes the shop's folder; `erase-customer` removes the customer's folder (except `Invoices/` under a legal hold) |
| `uploads/media/` | product photos and their thumbnails (content-addressed, shared between shops when identical) | while the product exists | removed unless another shop references the same file |
| `uploads/imports/<shopId>-*` | the original import files (customer lists, opening balances) | while the shop is a customer | removed |
| `uploads/tmp/` | uploads in flight | deleted when the request ends (`UploadCleanupInterceptor`) | — |

### 2.3 Operations

| Store | Personal data | Retention |
|---|---|---|
| API and edge logs (Loki) | one access line per request: path (no query string), status, user id, client IP, correlation id; sign-in lines carry the email tried and the IP | 31 days (`deploy/loki/loki.yml`, `retention_period: 744h`) |
| Metrics (Prometheus) | none: labels never carry an id, shop or user (`metrics.ts`) | Prometheus default (15 days) |
| Error tracking (Sentry, when `SENTRY_DSN` is set) | user id, shop id, route; request data, cookies, headers and query strings are switched off (`error-tracking.ts`) | the Sentry project's retention (set it to 30 days or less) |
| Redis | cache entries (60 s to 1 h); rate-limit counters keyed by IP address and by the email being tried (`throttle:{...}`, at most an hour) | expires on its own; disposable |
| Database dumps | everything in §2.1 | nightly kept 14, hourly kept 48 (`scripts/db/backup.sh --keep`) |
| Binary-log archive | every change, for point-in-time recovery | 7 days (`BINLOG_ARCHIVE_KEEP_DAYS`); the server keeps 7 days |
| Documents archives | everything in §2.2 | 14 (`scripts/storage/backup.sh`) |
| Off-site copies (rclone crypt, encrypted) | the dumps and archives above | 30 days (`OFFSITE_KEEP_DAYS`) |

### 2.4 The browser

| Where | What | Retention |
|---|---|---|
| NextAuth session cookie (HTTP-only, signed) | the signed-in user's id, role, shop and API tokens | until sign-out or the session's absolute lifetime (12 h) |
| `localStorage` `dukaanai-pos:<shopId>` | the POS cart in progress (products, quantities, the selected customer's id) | until the sale completes or the cart is cleared |
| `sessionStorage` (Smart Capture hand-off) | one captured bill image on its way to the AI scanner | the browser tab |

## 3. Retention the law requires

- **GST.** Accounts and records, including tax invoices and credit notes,
  are kept until 72 months after the due date of the annual return for the
  year (CGST Act s.36). The annual return of financial year `YYYY-YY` is
  due on 31 December after the year ends, so its records are kept until
  31 December of `YYYY + 7` (`gstRetentionEnds` in `personal-data.ts`).
  The obligation falls on the shop, the taxpayer. Before its data is
  erased, a shop receives its complete export (`shop-data export`) so it
  can meet that obligation.
- **DPDP Rules, 2025.** Processing logs are kept for at least one year for
  investigations. The 31-day log retention above is shorter: this is open
  item P-1 in `RETENTION_POLICY.md`, for the advisor.

## 4. Processors and transfers

| Service | Data sent | When |
|---|---|---|
| Google Gemini (`OCR_MODEL`) | the image of a bill a manager scans with the AI scanner | each scan; nothing else is sent |
| The SMTP relay (`SMTP_URL`) | invitation, password-reset and change-notice emails: the recipient's address, a link | each email |
| Google sign-in | the ID token the browser obtained | each Google sign-in |
| Sentry (`SENTRY_DSN`, optional) | unexpected errors with user id, shop id, route | each 500 |
| The hosting and managed-database provider | everything, encrypted in transit (TLS) and at rest per the provider | always |
| The off-site bucket | encrypted backups (the provider sees only ciphertext and scrambled names) | daily |

The countries these services process data in are recorded by the owner
once the providers are chosen (`docs/STAGING.md` lists the accounts).

## 5. Requests

Export, shop deletion, a customer's erasure and a customer's access request
follow `DATA_REQUESTS.md`. The tool is `node dist/cli/shop-data` in the API
container.

## 6. Status

| Item | Status |
|---|---|
| Inventory complete against the schema (spec) | Done (2026-10-11) |
| Reviewed by the owner's advisor | Open: owner |
| Processor locations recorded | Open: owner, when providers are contracted |
