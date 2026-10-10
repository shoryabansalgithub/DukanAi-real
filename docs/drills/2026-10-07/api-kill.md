### Kill the API during a checkout burst (`api-kill`): PASS

2026-10-07T17:46:47.949Z to 2026-10-07T17:49:42.013Z UTC against https://api.dukaanai.test:8443. One API replica (roadmap 9.7): the process dies, the restart policy starts a new one. DukaanAiApiDown and DukaanAiEndpointDown wait 2 minutes, so a restart inside that budget pages nobody.

**Timeline (UTC)**

| Time | Event | Detail |
| --- | --- | --- |
| 17:46:47 | baseline | 45 s of normal trading through https://api.dukaanai.test:8443 and https://app.dukaanai.test:8443 |
| 17:47:32 | burst | 8 checkouts started together; the API is killed 150 ms later |
| 17:47:33 | inject | api-kill |
| 17:47:47 | alert-pending | DukaanAiApiDown api:3002 |
| 17:47:47 | alert-pending | DukaanAiBackupNeverRecorded documents |
| 17:47:47 | alert-pending | DukaanAiBackupNeverRecorded offsite |
| 17:47:47 | alert-pending | DukaanAiBackupNeverRecorded dump |
| 17:47:47 | alert-pending | DukaanAiBackupNeverRecorded binlog |
| 17:47:47 | alert-pending | DukaanAiEndpointDown http://api:3002/api/health/ready |
| 17:47:57 | alert-resolved | DukaanAiApiDown api:3002 |
| 17:47:57 | alert-resolved | DukaanAiBackupNeverRecorded documents |
| 17:47:57 | alert-resolved | DukaanAiBackupNeverRecorded offsite |
| 17:47:57 | alert-resolved | DukaanAiBackupNeverRecorded dump |
| 17:47:57 | alert-resolved | DukaanAiBackupNeverRecorded binlog |
| 17:47:58 | recovered | every user path answers again |
| 17:48:47 | alert-resolved | DukaanAiEndpointDown http://api:3002/api/health/ready |
| 17:49:38 | stopped | users stopped; verifying |

_Driver report of run `api-kill-20261007T174647Z`, copied unchanged except that the screenshots kept in the repository are linked; the others stay in the run's evidence directory._

**What users saw**

| User | Requests | Failed | Answers while failing | Message shown | Outage (s) |
| --- | --- | --- | --- | --- | --- |
| Cashier at the POS (POST /billing/invoice, retried with the same key) | 60 | 14 | 502 x14 | 502:  | 4.1 |
| Owner on the dashboard (GET /dashboard/summary) | 23 | 0 | none |  | 0 |
| Anyone opening the web app (GET /login) | 23 | 0 | none |  | 0 |
| Smart Capture bill photo (POST /storage/bills) | 12 | 0 | none |  | 0 |
| Load balancer / uptime check (GET /api/health/ready) | 58 | 2 | 502 x2 | 502:  | 4.1 |

**What the screen showed** (a real browser: a cashier at the POS, a second cashier opening the POS once the fault is in place, the owner on the dashboard, a bill photo saved in Smart Capture)

| Time | Screen | What it said | Retry offered | Screenshot |
| --- | --- | --- | --- | --- |
| 17:46:54 | Dashboard | every card loaded |  | dashboard-1791395214688.png |
| 17:47:34 | POS opened during the fault | Loading current shift (GET /shifts/current) failed: the API at https://api.dukaanai.test:8443/api is unreachable. Is the backend running? Retry / Loading shop (GET /shops/me) failed: the API at https://api.dukaanai.test:8443/api is unreachable. Is the backend running? GST is being split as intra-state until the shop profile loads. / Unable to load products Loading products (GET /products) failed: the API at https://api.dukaanai.test:8443/api is unreachable. Is the backend running? Retry |  | [pos-opened-mid-incident-1.jpg](api-kill/pos-opened-mid-incident-1.jpg) |
| 17:47:37 | POS opened during the fault | shop, shift and products loaded 4.2 s after it was opened, no click |  | [pos-opened-mid-incident-2.jpg](api-kill/pos-opened-mid-incident-2.jpg) |

Browser sales during the drill: 25, the most attempts one needed: 1. Bill photos saved in the browser: 7.

Sales: 86 started (25 in the browser), 86 confirmed, 86 in the shop's invoice list; lost 0, unaccounted 0, duplicated 0. Outcomes: first-try 54, absent-then-created 6, complete-after-retry 1.

| Burst sale | Attempts | Outcome | Answers |
| --- | --- | --- | --- |
| 0f6ae9af | 1 | first-try | 201 |
| b65a4437 | 1 | first-try | 201 |
| 7a7ea494 | 3 | absent-then-created | 502 > 502 > 201 |
| 363a9b13 | 3 | absent-then-created | 502 > 502 > 201 |
| 20af5e69 | 3 | absent-then-created | 502 > 502 > 201 |
| 715697d0 | 3 | absent-then-created | 502 > 502 > 201 |
| dd3f29ca | 3 | complete-after-retry | 502 > 502 > 200 |
| bd41046d | 3 | absent-then-created | 502 > 502 > 201 |

Session: 0 token refresh(es), 0 forced sign-in(s).

**Time to recovery**

- First user-visible failure 17:47:33, every user path answering again 17:47:38: 4.6 s seen by users.
- 5 s after the fault was injected.

**Reconciliation afterwards**

| Date | Status | Drift | Sales | Net sales |
| --- | --- | --- | --- | --- |
| 2026-10-07 | CLEAN | 0 | 3665 | 73300.00 |

**What the alerts said**

| Alert | Severity | Target | Pending | Firing | Resolved | Routed to | Summary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DukaanAiApiDown | critical | api:3002 | 17:47:41 | – | 17:47:57 |  | API instance api:3002 is not scrapeable |
| DukaanAiBackupNeverRecorded | warning | documents | 17:47:41 | – | 17:47:57 |  | Backup job documents has never recorded a success |
| DukaanAiBackupNeverRecorded | warning | offsite | 17:47:41 | – | 17:47:57 |  | Backup job offsite has never recorded a success |
| DukaanAiBackupNeverRecorded | warning | dump | 17:47:41 | – | 17:47:57 |  | Backup job dump has never recorded a success |
| DukaanAiBackupNeverRecorded | warning | binlog | 17:47:41 | – | 17:47:57 |  | Backup job binlog has never recorded a success |
| DukaanAiEndpointDown | critical | http://api:3002/api/health/ready | 17:47:43 | – | 17:48:47 |  | http://api:3002/api/health/ready has failed its probe for 2 minutes |

Expected to fire: none.
