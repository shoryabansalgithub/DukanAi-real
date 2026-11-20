# Shop-to-shop isolation: how it is enforced and how it is proven

Status: tested in depth on 2026-10-12 (cross-shop isolation audit). This page
answers one question with evidence: can a person signed in to shop A read,
change, export or be told anything about shop B's data? The answer for the
code at the commit that adds this page is no, within the limits listed at the
end. The tests below re-prove it on every CI run.

## 1. How a shop is kept to its own data

| Layer | What enforces it | Guard that keeps it so |
|---|---|---|
| Who the caller is | The shop comes from the session only: `JwtStrategy` loads the user (and its `shopId`) from the database on every request; no route takes a shop id from the client. `TenantGuard` lets only `ACTIVE` shops through. | `test/security/*`, route walker |
| Every Prisma query | The tenant extension (`src/prisma/tenant-scope.ts`) narrows every model that has a `shopId` (derived from the schema) to the caller's shop: filters, creates, updates, deletes, nested writes. A query outside a request without a context throws. | `src/prisma/tenant-scope.spec.ts`, `test/integration/tenant-isolation.integration-spec.ts` |
| The two global models | `User` and `Invitation` are read before the tenant is known, so the extension does not narrow them: every lookup of one by a request-supplied id names the shop (`users.controller.ts`, `invitations.service.ts`, `shops.service.ts`). | this suite (oracle check) |
| Ids in request bodies | A scalar foreign key is never read by the extension, so every write that stores one calls `assertOwned` / `assertOwnedMany` first (404 for a foreign row). | this suite (write-body phase) |
| Raw SQL | Not narrowed by anything: every `$queryRaw` / `$executeRaw` on a shop's tables names the shop, or is listed with the reason it may span shops (outbox relays, retention, metrics, the audit itself). | `src/prisma/raw-sql-tenancy.spec.ts` |
| Child tables without `shopId` | Reached only through a parent the shop owns (an invoice line through its invoice, a webhook delivery through its endpoint). Every such table has a shop path; a table with none is listed with its reason. | `src/prisma/cross-shop-audit.spec.ts` |
| Background jobs | Every BullMQ worker runs a job in the context of the shop it names (`jobContext`, `runInShopOf`); relays span shops as the system tenant and hand each row to its own shop's context. | `src/iam/tenant-context/processor-context.spec.ts`, this suite (jobs) |
| Files | Documents live under one root per shop (`StoragePathBuilder`, containment checked); media bytes are content-addressed and served only through the shop's own asset rows. | `storage.integration-spec.ts`, this suite (files) |
| Cache, sockets | Every cache key carries the shop; socket broadcasts go to the room `tenant:<shopId>`, joined only by the authenticated adapter (no client can ask to join a room). | this suite (cache, sockets) |

## 2. The proof

### 2.1 Two shops attack each other through every route

`apps/api/test/integration/cross-shop-isolation.integration-spec.ts`, run by
`npm run test:integration` (and alone with
`npx jest --config ./test/jest-integration.json --runInBand test/integration/cross-shop-isolation`).

- **Two full shops.** `isolation/seed-shop.ts` fills each shop through the
  routes people use: cash, credit and cancelled sales, a return, a repayment,
  an expense with its receipt, the whole purchasing chain (order, approval,
  receipt, inspection, bill, payment, purchase return, credit note,
  allocation), warehouses and bins, a transfer, batches, a reservation, a
  stock count, variants, revisions, barcodes, media, stored bills and
  invoices, an import, a webhook, an invitation, a workflow, search history,
  reconciliation; then the outbox relays, workers and nightly analytics run.
  Each shop ends with rows in more than 90 tables.
- **Every route, both directions.** The route list comes from the Nest
  metadata (239 routes; a new controller is attacked without touching the
  test). As the attacking shop's OWNER (every shop permission):
  - every GET, with each of the victim's rows of the parameter's model in each
    path parameter, then one row of every other model the victim has (a route
    reading the wrong table), and the victim's ids in every id-shaped query
    filter;
  - every write with a body that passes validation (generated from the DTO,
    `isolation/request-bodies.ts`) and the victim's row in the path;
  - every write of the attacker's own rows with the victim's id in one body
    field at a time, at any depth (`items.0.productId`, `lines.0.id`), in each
    of the bodies the route is given;
  - every shop-wide write (sweeps, read-all, reindex, backup) once.
  About 4,700 requests per direction.
- **What must hold, per direction:**
  1. a victim id in a path never answers 2xx (two documented exceptions: a
     barcode image is drawn for any code; revoking a session id acts on the
     caller's own sessions only and answers alike for any id);
  2. a write naming a victim row in its body is never accepted;
  3. every write attack reaches the ownership check: each victim id is refused
     by the lookup of the attacked field, while the same body with the
     attacker's own id there (its control, sent last) passes every lookup;
  4. a victim id is answered exactly like an id nobody has (same status, same
     code): no existence oracle;
  5. the attacker's own row answers 2xx on every single-row read (the routes
     work; the refusals are about the shop);
  6. the victim's data is unchanged: a checksum over every column of every row
     the victim owns, child tables included, before and after;
  7. the victim's stored documents and media files are unchanged (sha256 of
     each file);
  8. no answer of any status carries a victim id, name, phone or email that
     the request did not send itself;
  9. no row of either shop names a row of the other (section 2.3);
  10. no probe is answered with a 500 (an unhandled error).
- **Reports, jobs, files and channels:** the dashboard summary, exports
  (invoices, lines, GST), KPIs, analytics, insights, purchase analytics,
  supplier and expense summaries show each shop exactly its own documents and
  figures; reconciliation is CLEAN per shop; a sale in one shop moves only that
  shop's cached figures; imports carrying the other shop's SKU, barcode and
  phone create rows in the importing shop only and report nothing of the
  other; expiry sweeps of one shop leave the other's expired reservations and
  batches alone; nightly analytics for one shop touch nothing of the other;
  webhook deliveries go only to the event's shop and carry nothing of the
  other; a stock change reaches only that shop's sockets, even when the other
  socket asks to join its room; a storage backup holds only the shop's own
  files; search, suggestions and popular searches show nothing of the other
  shop.

### 2.2 The tests catch a real leak (planted bugs)

Five isolation bugs were planted one batch at a time and the suite run
against them; each was caught, then the code was restored:

| Planted bug | Caught by |
|---|---|
| `GET /customers/:id` read without the shop | checks 1, 4, 8 (the victim's name, phone and email in the answer) |
| `POST /products` stores another shop's `categoryId` | check 2 (201) and check 9 (`Product.category` → 2 rows) |
| `GET /notifications` lists every shop's notifications | check 8 |
| `DELETE /expenses/:id` through raw SQL without the shop | checks 1, 4 (200 against 404) and 6 (`Expense: contents changed`) |
| the invoices CSV appends rows read by a raw query without the shop | the exports report check |

The raw-SQL guard was likewise shown to fail on an unscoped statement, both
with a literal table and with a computed one.

### 2.3 The data itself: `tenant-audit`

`src/prisma/cross-shop-audit.ts` derives from the schema a shop path for
every table and checks every to-one relation between two tables that belong
to shops (214 relations): a row of shop A that names a customer, product,
user or document of shop B is what a missed ownership check leaves behind.
Read-only, seconds on a large database:

    node dist/cli/tenant-audit            # in the API container (exit 0 clean, 1 findings)
    node dist/cli/tenant-audit --json
    npm run tenant-audit                  # from a checkout (apps/api)

On the local test database after every suite (287 shops), it reported the
two rows a planted bug had left and, once those were cleared, CLEAN. Run it on
staging and production after each release (`RELEASE.md`, verify step).

## 3. What the audit found and fixed

| # | Finding | Effect | Fix |
|---|---|---|---|
| 1 | `POST /shops/transfer-ownership` looked the new owner up by id alone (`User` is global) and answered 400 "must belong to this shop" for another shop's user, 404 for an unknown id | an owner could learn whether an id is a user of some other shop (an existence oracle; nothing was transferred) | the lookup names the shop; both cases are 404 `USER_NOT_FOUND` |
| 2 | `POST /purchase-events/replay` stored any `aggregateId`, another shop's order included, and answered 201 | a row of the shop named another shop's document | 404 `PURCHASE_AGGREGATE_NOT_FOUND` unless the shop has an event for that document |
| 3 | `GET /warehouse-domain/warehouses/:id/locations/subtree` answered `200 []` for another shop's or an unknown warehouse | no data, but the API's rule is 404 for a foreign id | 404 through `assertOwned` |
| 4 | `PUT /purchases/:id/draft` accepted `supplierId` and silently dropped it | the field did nothing (another shop's supplier was ignored, not stored) | the supplier is checked like on a new order (the shop's own, live, active) and saved |
| 5 | The older `tenant-isolation` spec sent a stock-count type that does not exist, so its two foreign-id checks passed on validation, never reaching the ownership check | a gap in the evidence, not in the code | corrected; the new suite requires every write attack to reach its lookup |

Found on the way, not an isolation matter: the attack's shop-wide phase
uploaded a file to `POST /storage/cloud/upload` and got an unhandled 500. The
committed templates carry a placeholder bucket (`your_bucket`), which the route
took for a configured store, so it called the real object store with template
keys. It now answers 503 `CLOUD_STORAGE_NOT_CONFIGURED` without calling out,
and 502 `CLOUD_UPLOAD_FAILED` when a configured store refuses the file; the
suite fails on any 500 it meets.

Seen and left as they are, because they are uniform with an unknown id (no
oracle, no data): some lookups refuse a foreign id with 400 rather than 404
("User not found" on suspend and delete, "Parent category not found", the
product checks of inventory items and purchase orders, "Revision must be
APPROVED to publish", whose query names the shop, the product and the state at
once). Not an isolation matter but worth knowing: the purchase event replay
records a request that nothing processes yet.

## 4. Limits

- The attack runs as the attacking shop's OWNER, which holds every shop
  permission; what each role may do inside its own shop is proven by the role
  suites (route walker, `financial-visibility`, `role-gates`).
- Unknown parameters are tried with one victim row of every model, mapped ones
  with up to three rows of their model; the victim's ids are real rows, not
  guesses.
- The suite runs in-process. The certification job (`scripts/certify`) runs
  the route walker and the security suite against the release images; this
  suite is not yet one of its steps.
- Timing differences are not measured (a lookup that finds another shop's row
  and refuses it may take a different time than one that finds nothing).
- Media files with identical bytes are stored once and shared by the shops
  that uploaded them; a shop reaches them only through its own asset rows, and
  erasure keeps a file while another shop references it.
- The external penetration test (`PENTEST_SCOPE.md`) remains the owner's.
