# Support

Roadmap 9.23. How shops reach DukaanAI, how fast they get an answer, what
support does with a report, and how to pause a broken feature without a
deploy.

Related documents:

- The guides shops use: `docs/guides/CASHIER_GUIDE.md`,
  `docs/guides/OWNER_GUIDE.md`, `docs/guides/FAQ.md`.
- Incidents (pages, roles, messages to shops): `docs/RUNBOOKS.md`.
- Data requests: `docs/privacy/DATA_REQUESTS.md`.

## 1. The channel

| Channel | For | Address | Staffed |
|---|---|---|---|
| Phone and WhatsApp | anything urgent: shops cannot bill, money looks wrong | `<support number>` | shop hours, 09:00–21:00 IST, every day |
| Email | everything else; data and privacy requests; complaints | `<support email>` | read every working day |
| In the app | — (the **Upgrade to Pro** window says "Contact support"; the guides point here) | | |

The addresses go here, in `docs/guides/OWNER_GUIDE.md` §8 and in the
privacy notice once the owner chooses them. Who staffs the channel each
day is in the on-call rota (`docs/RUNBOOKS.md` §1). The same person is
the communicator in an incident.

## 2. Response targets

Targets run from the shop's first message, during staffed hours. The
severities are the incident severities of `docs/RUNBOOKS.md` §2.

| Severity | Example | First answer | Updates | Resolution target |
|---|---|---|---|---|
| SEV1 | the shop cannot bill; a sale or payment is missing or wrong | 15 minutes | every 30 minutes | 4 hours, or a workaround (a pause, paper bills) within 1 hour |
| SEV2 | billing works, something else does not (photos, scanner, email, a report) | 2 hours | daily | 2 working days |
| SEV3 | a question, a how-to, a wish | 1 working day | — | answered, or noted for the roadmap |
| Data request | export, deletion, a customer's erasure | 1 working day (acknowledged) | at each step | export within 7 days; erasure on day 30 |

The owner of DukanAI reviews these targets after the pilot (`docs/PILOT.md`).

## 3. Taking a report

Ask for, and write in the ticket:

1. The shop, and who is calling. A data request needs the identity check
   of `DATA_REQUESTS.md` §0.
2. What they were doing, and on which screen.
3. The time, as close as they know.
4. The invoice number, if a bill is involved. It is on the receipt
   (`INV-2627-000123`).
5. The exact message on screen. A screenshot is best.

Then:

- Find the request in the logs: Grafana › Logs,
  `{service="api"} | json | message_userId="<user id>"` around the time.
  An error line gives the `correlationId`, which leads to the rest
  (`docs/OBSERVABILITY.md`).
- Money questions: run the reconciliation for that shop and day
  (`node dist/cli/reconcile --shop <id> --date <day>`). Its checks say
  whether the books agree.
- A defect: log it with the steps to reproduce. During the pilot it goes
  in the defect log of `docs/PILOT.md`; later, in the issue tracker. Tell
  the shop the workaround and when to expect the fix.
- A question the guides do not answer: add it to `docs/guides/FAQ.md`.

## 4. Pausing a feature

Use this when one feature is broken or dangerous: it charges wrongly,
corrupts something, or overloads the server. A pause stops that feature
for every shop until a fix is released, and leaves everything else
running.

### What a pause does

- New work of the paused feature answers HTTP 503 with code
  `FEATURE_PAUSED`. The message names the feature:
  *"Credit (udhar) sales is paused for maintenance. Everything else keeps
  working; please try again later."* Staff see it as is, in the POS
  payment panel, the return and cancel windows, and the forms' error
  messages.
- What was already recorded stays readable.
- A retry of a document committed before the pause is still answered.
  A cashier whose answer was lost gets their bill, not an error.
- Nobody learns of a pause before signing in: a request without a session
  still answers 401, and a request the role may not make still answers 403.

### The switches

| Switch | Pauses | Keeps working |
|---|---|---|
| `FEATURE_CREDIT_SALES_ENABLED` | new sales with a credit (udhar) part | cash, UPI, card and bank sales; credit repayments |
| `FEATURE_RETURNS_ENABLED` | new sales returns | cancellations; replays of returns already made |
| `FEATURE_CANCELLATIONS_ENABLED` | new invoice cancellations | returns |
| `FEATURE_OCR_ENABLED` | the AI bill scanner | Smart Capture (storing the photo), typing the lines by hand |
| `FEATURE_IMPORTS_ENABLED` | import uploads and applying a dry run | reading import jobs and their reports |
| `FEATURE_DOCUMENTS_ENABLED` | storing documents: Smart Capture bills and every other upload under `/storage` | everything else; reading stored documents |
| `FEATURE_MEDIA_ENABLED` | product photo uploads and changes | product edits without photos |
| `FEATURE_PROCUREMENT_ENABLED` | purchase orders, goods receipts, purchase returns, vendor bills, supplier credit notes (API only; the web has no screens for these) | **Update Stock**, **Pay Supplier** |
| `FEATURE_DASHBOARD_INSIGHTS_ENABLED` | the dashboard's AI insights card (its live forecast query) | every other dashboard figure |

Every switch is on (`true`) by default (`apps/api/.env.example`).
`feature-gate.spec.ts` keeps this table, the templates and the deployment
files in step.

### How to pause (no new image, one API restart)

1. Decide with the incident lead, and record the decision in the
   incident timeline.
2. Set the switch to `false` and restart the API. On a single replica,
   requests get 503 for about 30 seconds during the restart, so do it
   between rushes when possible.
   - **Compose (production):**
     - Add `FEATURE_<NAME>_ENABLED=false` to the `.env` next to `docker-compose.prod.yml`.
     - Run `docker compose -f docker-compose.prod.yml up -d api`.
     - Compose forwards the switches (`${FEATURE_<NAME>_ENABLED:-true}`).
   - **Kubernetes:**
     - Run `kubectl -n dukaanai edit configmap dukaanai-config` and set `FEATURE_<NAME>_ENABLED: "false"`.
     - Run `kubectl -n dukaanai rollout restart deployment/dukaanai-api`.
3. Check:
   - **The boot log** says `Paused features: <name> (FEATURE_<NAME>_ENABLED=false)`.
     A misspelt variable is reported as `Ignored FEATURE_...: no such feature switch`.
   - **The metrics:** `feature_enabled{feature="<name>"}` is 0 on
     `/api/metrics`, and the Grafana operations dashboard shows the
     feature red under **Paused features**.
   - **The app:** the paused action shows the message above.
4. Tell the shops. Template S2 of `docs/RUNBOOKS.md` §3, with the
   workaround from the table: *"<Feature> is switched off while we fix a
   problem. Please use <workaround>. Everything else works normally. We
   will tell you when it is back."*

### How to resume

When the fix is released, or the cause was outside the feature:

1. Remove the line, or set it to `true`.
2. Restart the API the same way.
3. Check that `feature_enabled` is 1 and the action works.
4. Tell the shops.

A pause left on by mistake stays visible: a red tile on the dashboard and
a warning in every boot log.

## 5. Status

| Item | Status |
|---|---|
| Channel addresses chosen and published to the shops | Open: owner |
| Channel staffed for the pilot (names in the rota) | Open: owner |
| Guides reviewed by the pilot shop (`docs/guides/`) | Open: pilot (`docs/PILOT.md`) |
| Pause procedure tested | Done: `feature-flags.integration-spec.ts` pauses each kind of switch on the real app (2026-10-11). On the staging stack: open (owner). |
