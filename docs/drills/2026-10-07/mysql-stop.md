### Stop MySQL for 60 seconds (`mysql-stop`): PASS

2026-10-07T17:49:48.131Z to 2026-10-07T17:53:40.357Z UTC against https://api.dukaanai.test:8443. Every request answers 503 DATABASE_UNAVAILABLE while the database is away (retry-safe; the POS offers Retry); the 2-minute holds of DukaanAiDependencyDown and DukaanAiEndpointDown keep a 60-second outage below the paging threshold.

**Timeline (UTC)**

| Time | Event | Detail |
| --- | --- | --- |
| 17:49:48 | baseline | 45 s of normal trading through https://api.dukaanai.test:8443 and https://app.dukaanai.test:8443 |
| 17:50:33 | inject | mysql-stop |
| 17:50:48 | alert-pending | DukaanAiEndpointDown http://api:3002/api/health/ready |
| 17:50:58 | alert-pending | DukaanAiDependencyDown database |
| 17:51:18 | alert-pending | DukaanAiHigh5xxRate  |
| 17:51:37 | clear | mysql-start |
| 17:51:38 | alert-pending | DukaanAiEndpointDown https://api.dukaanai.test/api/health/ready |
| 17:51:58 | alert-resolved | DukaanAiDependencyDown database |
| 17:52:00 | recovered | every user path answers again |
| 17:52:38 | alert-resolved | DukaanAiEndpointDown https://api.dukaanai.test/api/health/ready |
| 17:52:48 | alert-resolved | DukaanAiEndpointDown http://api:3002/api/health/ready |
| 17:53:38 | stopped | users stopped; verifying |

_Driver report of run `mysql-stop-20261007T174947Z`, copied unchanged except that the screenshots kept in the repository are linked; the others stay in the run's evidence directory._

**What users saw**

| User | Requests | Failed | Answers while failing | Message shown | Outage (s) |
| --- | --- | --- | --- | --- | --- |
| Cashier at the POS (POST /billing/invoice, retried with the same key) | 71 | 32 | 503 DATABASE_UNAVAILABLE x32 | 503 DATABASE_UNAVAILABLE: The database is unavailable at the moment. Please retry in a few seconds. | 64.8 |
| Owner on the dashboard (GET /dashboard/summary) | 36 | 13 | 503 DATABASE_UNAVAILABLE x13 | 503 DATABASE_UNAVAILABLE: The database is unavailable at the moment. Please retry in a few seconds. | 65.2 |
| Anyone opening the web app (GET /login) | 36 | 0 | none |  | 0 |
| Smart Capture bill photo (POST /storage/bills) | 19 | 7 | 503 DATABASE_UNAVAILABLE x7 | 503 DATABASE_UNAVAILABLE: The database is unavailable at the moment. Please retry in a few seconds. | 70.1 |
| Load balancer / uptime check (GET /api/health/ready) | 88 | 33 | 503 x33 | 503: {"status":"unavailable","timestamp":"2026-10-07T17:50:34.186Z","checks":{"database":"down","redis":"up"}} | 66.1 |

**What the screen showed** (a real browser: a cashier at the POS, a second cashier opening the POS once the fault is in place, the owner on the dashboard, a bill photo saved in Smart Capture)

| Time | Screen | What it said | Retry offered | Screenshot |
| --- | --- | --- | --- | --- |
| 17:49:54 | Dashboard | every card loaded |  | dashboard-1791395394493.png |
| 17:50:38 | POS opened during the fault | The database is unavailable at the moment. Please retry in a few seconds. GST is being split as intra-state until the shop profile loads. / The database is unavailable at the moment. Please retry in a few seconds. Retry / Unable to load products The database is unavailable at the moment. Please retry in a few seconds. Retry |  | [pos-opened-mid-incident-1.jpg](mysql-stop/pos-opened-mid-incident-1.jpg) |
| 17:51:04 | POS | The database is unavailable at the moment. Please retry in a few seconds. GST is being split as intra-state until the shop profile loads. / The database is unavailable at the moment. Please retry in a few seconds. Retry / Unable to load products The database is unavailable at the moment. Please retry in a few seconds. Retry |  | pos-1791395464839.png |
| 17:51:12 | Dashboard | Refresh failed — showing last data [Loading AI insights (GET /dashboard/insights) failed (HTTP 503: The database is unavailable at the moment. Please retry in a few seconds.).] / Refresh failed — showing last data [Loading KPIs (GET /dashboard/kpis) failed (HTTP 503: The database is unavailable at the moment. Please retry in a few seconds.).] / Refresh failed — showing last data [Loading dashboard summary (GET /dashboard/summary) failed (HTTP 503: The database is unavailable at the moment. Please retry in a few seconds.).] / Refresh failed — showing last data [Loading sales trend (GET /dashboard/trends) failed (HTTP 503: The database is unavailable at the moment. Please retry in a few seconds.).] |  | [dashboard.jpg](mysql-stop/dashboard.jpg) |
| 17:51:43 | Smart Capture | locator.waitFor: Timeout 30000ms exceeded. |  | [smart-capture.jpg](mysql-stop/smart-capture.jpg) |
| 17:51:43 | POS opened during the fault | shop, shift and products loaded 66.2 s after it was opened, no click |  | [pos-opened-mid-incident-2.jpg](mysql-stop/pos-opened-mid-incident-2.jpg) |
| 17:51:50 | Smart Capture | stored after 2 attempts |  | capture-1791395510526.png |
| 17:52:03 | Dashboard | every card loaded |  |  |

Browser sales during the drill: 24, the most attempts one needed: 1. Bill photos saved in the browser: 7.

Sales: 78 started (24 in the browser), 78 confirmed, 78 in the shop's invoice list; lost 0, unaccounted 0, duplicated 0. Outcomes: first-try 53, absent-then-created 1.

| Bill photo | Attempts | Outcome | Answers |
| --- | --- | --- | --- |
| DRILL1791395438169 | 8 | stored-after-retry | 503 DATABASE_UNAVAILABLE > 503 DATABASE_UNAVAILABLE > 503 DATABASE_UNAVAILABLE > 503 DATABASE_UNAVAILABLE > 503 DATABASE_UNAVAILABLE > 503 DATABASE_UNAVAILABLE > 503 DATABASE_UNAVAILABLE > 201 |

Session: 0 token refresh(es), 0 forced sign-in(s).

**Time to recovery**

- First user-visible failure 17:50:34, every user path answering again 17:51:48: 74.1 s seen by users.
- 75.2 s after the fault was injected, 10.8 s after it was cleared.

**Reconciliation afterwards**

| Date | Status | Drift | Sales | Net sales |
| --- | --- | --- | --- | --- |
| 2026-10-07 | CLEAN | 0 | 3743 | 74860.00 |

**What the alerts said**

| Alert | Severity | Target | Pending | Firing | Resolved | Routed to | Summary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DukaanAiEndpointDown | critical | http://api:3002/api/health/ready | 17:50:43 | – | 17:52:48 |  | http://api:3002/api/health/ready has failed its probe for 2 minutes |
| DukaanAiDependencyDown | critical | database | 17:50:56 | – | 17:51:58 |  | The API cannot reach database |
| DukaanAiHigh5xxRate | critical |  | 17:51:11 | – | – |  | More than 1% of API answers are 5xx |
| DukaanAiEndpointDown | critical | https://api.dukaanai.test/api/health/ready | 17:51:28 | – | 17:52:38 |  | https://api.dukaanai.test/api/health/ready has failed its probe for 2 minutes |

Expected to fire: none.
