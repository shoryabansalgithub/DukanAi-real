# Data requests: export, shop deletion, a customer's erasure

Roadmap 9.24. The procedures support follows when a shop asks for its
data, asks to leave and be deleted, or passes on a request from one of its
customers. The tool is `shop-data`, an operator command in the API image:

```
dc exec api node dist/cli/shop-data --help
```

From a checkout, `npm run shop-data -- ...` runs the same command in
`apps/api`, with `.env.local` / `.env` loaded. `dc` is the compose
command of `docs/RUNBOOKS.md` §0.

Every command that changes data is a dry run without `--yes`, and prints
what it would do. `--json` prints the result as JSON: keep that output in
the support ticket as the receipt. It holds ids and counts, never a name.

## 0. Before any request: who is asking

1. The request comes from the shop's **owner**, by email from the owner's
   registered address or from the support channel (`docs/SUPPORT.md`).
   Nobody else may ask for a shop's data or its deletion.
2. Confirm on a call to the shop's registered phone number. Ask the owner
   for two facts only the shop knows, such as its last invoice number and
   the day's sales total.
3. Write down the shop id (`SELECT id, name FROM Shop WHERE ...`) and
   open a ticket. Every step below is logged in it.

## 1. Export (the shop wants a copy of its data)

```
dc exec api node dist/cli/shop-data export --shop <shopId> --out /var/lib/dukaanai/backups/exports --json
```

- This writes `dukaanai-export-<shopId>-<UTC stamp>.tar.gz` with a
  `.sha256` sidecar. The archive holds:
  - every row of the shop as JSON lines (`data/<Model>.jsonl`), the child
    tables without a shop column included (`InvoiceItem`, `CustomerAudit`,
    `ImportJobRow` ...: through their parent row);
  - the books as CSV (`csv/invoices.csv`, `invoice-items`, `invoice-payments`, `customers`, `credit-transactions`, `products`, `expenses`, `suppliers`);
  - the stored documents, product photos and import files;
  - `manifest.json` (counts, schema version, release) and `SHA256SUMS`.

  Credentials are never written: password hashes, token hashes and webhook secrets.
- The output directory is on the backups volume. Check that it has room
  for about twice the shop's documents.
- Deliver the archive by a link that expires in 7 days, never as an email
  attachment. Send the password-protected link to the owner's registered
  address and the password by SMS to the registered phone.
- Delete the archive from the server once the owner confirms receipt, or
  after 7 days.
- Target: within 7 days of the request (`RETENTION_POLICY.md` P-2).

## 2. A shop leaves and asks to be deleted

| Day | Step | Command |
|---|---|---|
| 0 | Confirm the request (§0). Tell the owner what happens and when (template below). | — |
| 0 | Suspend the shop. Every request now answers 403 and everyone is signed out. Nothing is erased; this is reversible. | `shop-data suspend --shop <id> --yes` |
| 0–7 | Export (§1) and deliver it. | `shop-data export --shop <id> --out <dir>` |
| 30 | The notice period ends. If the owner withdrew, reactivate: `UPDATE Shop SET status='ACTIVE' WHERE id=?`, then record it in the ticket. | — |
| 30 | Check the plan, then erase. The command needs the export archive of the same shop, with its sidecar. | `shop-data erase --shop <id> --export <dir>/dukaanai-export-<id>-<stamp>.tar.gz` (dry run), then add `--yes` |
| 30 | Paste the JSON receipt into the ticket and add a row to the erasure register (§5). | — |
| 30–60 | The erased data leaves the backups as they age out (`RETENTION_POLICY.md` §3). | — |

What `erase` does:

- Every personal column of every row of the shop is rewritten by its
  class (`apps/api/src/privacy/personal-data.ts`), including the child
  tables reached through their parent (customer audit trails, import report
  rows, photo metadata, webhook delivery logs, revision reviews).
- The owner's and staff accounts are anonymised and closed.
- Sessions, reset tokens, login attempts, invitations, notifications and
  search history are deleted.
- The shop's documents folder and import files are removed. Product
  photos are removed too, unless another shop uses the same file.
- An `AuditLog` row `SHOP_ERASED` records the counts.

The anonymised financial history stays: amounts, dates, document numbers,
product names. The ledger cannot be changed by design, and since migration
`20261011090000` it holds no names.

`erase` refuses an ACTIVE shop, and refuses an export archive whose bytes
do not match its `.sha256` sidecar or whose `manifest.json` names another
shop (the file name alone is not trusted).

## 3. A customer of a shop asks to be forgotten

The shop is the customer's data fiduciary, so the request reaches support
through the shop's owner. If a customer writes to support directly, ask
them to contact the shop, and tell the owner.

1. The owner settles the customer's credit (udhar) first. The command
   refuses while the balance is not zero: a repayment, or an owner's
   write-off recorded as a payment with a note.
2. Dry run, then execute:

   ```
   dc exec api node dist/cli/shop-data erase-customer --shop <shopId> --customer <customerId>
   dc exec api node dist/cli/shop-data erase-customer --shop <shopId> --customer <customerId> --yes --json
   ```

3. What happens:
   - **Erased:** phone, email, notes and tags on the customer row; the
     notes on their invoices and credit entries; the snapshots and IP in
     their audit rows (`AuditLog` and `CustomerAudit`); the report rows of
     customer imports that carry their phone or email; their documents
     folder; every uploaded import file that holds their phone or email
     (the whole file is deleted).
   - **The row:** marked deleted, so the customer can be registered again
     as new.
   - **Kept: invoices.** Invoices stay, attached to the anonymised
     customer.
   - **Kept under a legal hold.** If the customer has a sale of ₹50,000
     or more still in its GST retention period (Rule 46(e) proviso and
     CGST Act s.36), their name, address and city stay, along with the
     `Invoices/` folder. The receipt lists each held invoice and its
     end date. Run the command again after that date to erase the rest.
4. Tell the owner what was erased and what is held, and why. The owner
   answers the customer.

## 4. A customer asks what the shop holds about them

The owner can answer this from the app:

- the customer's page: details, credit history and statement;
- the invoice list filtered by the customer.

Support helps only when the owner asks for a machine-readable copy:

1. Export the shop (§1).
2. Extract the customer's rows, for example:

   ```
   grep '"customerId":"<id>"' data/Invoice.jsonl data/UdharTransaction.jsonl > customer.jsonl
   grep '"id":"<id>"' data/Customer.jsonl >> customer.jsonl
   ```

3. Send only `customer.jsonl` to the owner, then delete the export.

## 5. The erasure register and restores

An erasure cannot reach the backups taken before it. Restoring one of
those backups (`docs/BACKUP_RESTORE.md`) brings the erased data back.

- The register is a table in the support system (never in this
  repository), with one row per executed erasure: date and time (UTC),
  kind, shop id, customer id, ticket.
- After any restore, run every erasure in the register with a time later
  than the restored backup's snapshot again, with the same command.
  Erasure is idempotent. `docs/BACKUP_RESTORE.md` has this as its last
  restore step.

## 6. Messages

**To the owner, on a deletion request (day 0):**
> We have received your request to close your DukaanAI account and delete
> your shop's data. Your shop is now paused: nobody can sign in, and
> nothing has been deleted. Within 7 days we will send you a complete copy
> of your data. Keep it: GST law asks you to keep your invoices and
> accounts for about six years. On <date + 30 days> we will permanently
> delete your shop's personal data. To keep your account instead, reply
> before that date.

**To the owner, after the erasure:**
> Your shop's data was deleted on <date>. Copies inside our encrypted
> backups expire by <date + 30 days>. What remains are anonymous totals
> that cannot identify you or your customers.

## 7. Evidence (roadmap 9.24 gate: an export and a deletion request executed on staging)

| Where | What ran | Result | Date | By |
|---|---|---|---|---|
| Local integration database (MariaDB 10.11), `test/integration/shop-data.integration-spec.ts` | Export (directory and archive), checksums verified. Suspend: sessions refused. Erase dry run, then erase: a marker planted in 11 personal fields found in no text column of any table afterwards; ledger totals and invoice amounts unchanged; second run idempotent. Customer erasure: refused with a balance, legal hold kept name, address and `Invoices/`, full erasure otherwise. | Pass (3 tests) | 2026-10-11 | engineering |
| Staging | Export of a test shop delivered to the owner. That shop suspended and erased with the archive. Receipt in the ticket. Register row added. | Pending: owner (needs staging) | | |

Reviewed by the owner's advisor: pending (`DATA_INVENTORY.md` §6).
