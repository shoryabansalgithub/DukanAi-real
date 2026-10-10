### Fill the storage volume (`storage-full`): PASS

2026-10-07T17:53:46.265Z to 2026-10-07T17:59:30.846Z UTC against https://api.dukaanai.test:8443. Sales live in MySQL and continue; documents cannot be written and must be refused cleanly, then accepted again once space is freed.

**Timeline (UTC)**

| Time | Event | Detail |
| --- | --- | --- |
| 17:53:46 | baseline | 45 s of normal trading through https://api.dukaanai.test:8443 and https://app.dukaanai.test:8443 |
| 17:54:31 | inject | storage-fill |
| 17:54:46 | alert-pending | DukaanAiStorageLow storage |
| 17:54:46 | alert-pending | DukaanAiStorageFull storage |
| 17:55:36 | alert-pending | DukaanAiHigh5xxRate  |
| 17:55:46 | alert-firing | DukaanAiStorageFull storage (critical): The storage volume is full |
| 17:57:31 | clear | storage-free |
| 17:57:46 | alert-resolved | DukaanAiStorageLow storage |
| 17:57:46 | alert-resolved | DukaanAiStorageFull storage |
| 17:57:47 | recovered | every user path answers again |
| 17:59:16 | alert-resolved | DukaanAiHigh5xxRate  |
| 17:59:26 | stopped | users stopped; verifying |

_Driver report of run `storage-full-20261007T175345Z`, copied unchanged except that the screenshots kept in the repository are linked; the others stay in the run's evidence directory._

**What users saw**

| User | Requests | Failed | Answers while failing | Message shown | Outage (s) |
| --- | --- | --- | --- | --- | --- |
| Cashier at the POS (POST /billing/invoice, retried with the same key) | 96 | 0 | none |  | 0 |
| Owner on the dashboard (GET /dashboard/summary) | 58 | 0 | none |  | 0 |
| Anyone opening the web app (GET /login) | 58 | 0 | none |  | 0 |
| Smart Capture bill photo (POST /storage/bills) | 30 | 18 | 507 STORAGE_FULL x18 | 507 STORAGE_FULL: The document store is full. Nothing was saved; try again once space has been freed. | 180.5 |
| Load balancer / uptime check (GET /api/health/ready) | 143 | 0 | none |  | 0 |

**What the screen showed** (a real browser: a cashier at the POS, a second cashier opening the POS once the fault is in place, the owner on the dashboard, a bill photo saved in Smart Capture)

| Time | Screen | What it said | Retry offered | Screenshot |
| --- | --- | --- | --- | --- |
| 17:53:52 | Dashboard | every card loaded |  | dashboard-1791395632588.png |
| 17:54:32 | POS opened during the fault | loaded normally 1.0 s after it was opened |  | pos-opened-mid-incident-1791395672867.png |
| 17:54:40 | Smart Capture | Storing the bill (POST /storage/bills/Walk-in/…) failed (HTTP 507: The document store is full. Nothing was saved; try again once space has been freed.). |  | [smart-capture.jpg](storage-full/smart-capture.jpg) |
| 17:57:38 | Smart Capture | stored after 8 attempts |  | capture-1791395858922.png |

Browser sales during the drill: 52, the most attempts one needed: 1. Bill photos saved in the browser: 7.

Sales: 163 started (52 in the browser), 163 confirmed, 163 in the shop's invoice list; lost 0, unaccounted 0, duplicated 0. Outcomes: first-try 111.

| Bill photo | Attempts | Outcome | Answers |
| --- | --- | --- | --- |
| DRILL1791395676283 | 19 | stored-after-retry | 507 STORAGE_FULL > 507 STORAGE_FULL > 507 STORAGE_FULL > 507 STORAGE_FULL > 507 STORAGE_FULL > 507 STORAGE_FULL > 507 STORAGE_FULL > 507 STORAGE_FULL > 507 STORAGE_FULL > 507 STORAGE_FULL > 507 STORAGE_FULL > 507 STORAGE_FULL > 507 STORAGE_FULL > 507 STORAGE_FULL > 507 STORAGE_FULL > 507 STORAGE_FULL > 507 STORAGE_FULL > 507 STORAGE_FULL > 201 |

Session: 0 token refresh(es), 0 forced sign-in(s).

**Time to recovery**

- First user-visible failure 17:54:36, every user path answering again 17:57:36: 180.5 s seen by users.
- 185.5 s after the fault was injected, 5.2 s after it was cleared.

**Reconciliation afterwards**

| Date | Status | Drift | Sales | Net sales |
| --- | --- | --- | --- | --- |
| 2026-10-07 | CLEAN | 0 | 3906 | 78120.00 |

**What the alerts said**

| Alert | Severity | Target | Pending | Firing | Resolved | Routed to | Summary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DukaanAiStorageLow | warning | storage | 17:54:41 | – | 17:57:46 |  | The storage volume has less than 10% free |
| DukaanAiStorageFull | critical | storage | 17:54:41 | 17:55:46 | 17:57:46 | oncall, team | The storage volume is full |
| DukaanAiHigh5xxRate | critical |  | 17:55:26 | – | 17:59:16 |  | More than 1% of API answers are 5xx |

Expected to fire: DukaanAiStorageFull.
