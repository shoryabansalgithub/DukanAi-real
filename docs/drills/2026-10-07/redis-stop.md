### Stop Redis for 5 minutes (`redis-stop`): PASS

2026-10-07T17:59:37.173Z to 2026-10-07T18:08:01.239Z UTC against https://api.dukaanai.test:8443. Redis is advisory for sales (stock keys, cache, rate-limit counters fall back in-process, and none of them waits for Redis); readiness reports it down, and DukaanAiDependencyDown pages once, naming Redis, while the readiness probes are held back.

**Timeline (UTC)**

| Time | Event | Detail |
| --- | --- | --- |
| 17:59:37 | baseline | 45 s of normal trading through https://api.dukaanai.test:8443 and https://app.dukaanai.test:8443 |
| 18:00:22 | inject | redis-stop |
| 18:00:47 | alert-pending | DukaanAiEndpointDown http://api:3002/api/health/ready |
| 18:00:47 | alert-pending | DukaanAiDependencyDown redis |
| 18:01:37 | alert-pending | DukaanAiEndpointDown https://api.dukaanai.test/api/health/ready |
| 18:02:47 | alert-firing | DukaanAiDependencyDown redis (critical): The API cannot reach redis |
| 18:02:47 | alert-firing | DukaanAiEndpointDown http://api:3002/api/health/ready (critical): http://api:3002/api/health/ready has failed its probe for 2 minutes |
| 18:03:37 | alert-firing | DukaanAiEndpointDown https://api.dukaanai.test/api/health/ready (critical): https://api.dukaanai.test/api/health/ready has failed its probe for 2 minutes |
| 18:05:22 | clear | redis-start |
| 18:05:47 | alert-pending | DukaanAiOutboxLag  |
| 18:05:47 | alert-resolved | DukaanAiEndpointDown http://api:3002/api/health/ready |
| 18:05:47 | recovered | every user path answers again |
| 18:05:57 | alert-resolved | DukaanAiOutboxLag  |
| 18:06:37 | alert-resolved | DukaanAiEndpointDown https://api.dukaanai.test/api/health/ready |
| 18:07:47 | alert-resolved | DukaanAiDependencyDown redis |
| 18:07:57 | stopped | users stopped; verifying |

_Driver report of run `redis-stop-20261007T175936Z`, copied unchanged except that the screenshots kept in the repository are linked; the others stay in the run's evidence directory._

**What users saw**

| User | Requests | Failed | Answers while failing | Message shown | Outage (s) |
| --- | --- | --- | --- | --- | --- |
| Cashier at the POS (POST /billing/invoice, retried with the same key) | 149 | 0 | none |  | 0 |
| Owner on the dashboard (GET /dashboard/summary) | 90 | 0 | none |  | 0 |
| Anyone opening the web app (GET /login) | 90 | 0 | none |  | 0 |
| Smart Capture bill photo (POST /storage/bills) | 45 | 0 | none |  | 0 |
| Load balancer / uptime check (GET /api/health/ready) | 223 | 153 | 503 x153 | 503: {"status":"unavailable","timestamp":"2026-10-07T18:00:23.225Z","checks":{"database":"up","redis":"down"}} | 306.1 |

**What the screen showed** (a real browser: a cashier at the POS, a second cashier opening the POS once the fault is in place, the owner on the dashboard, a bill photo saved in Smart Capture)

| Time | Screen | What it said | Retry offered | Screenshot |
| --- | --- | --- | --- | --- |
| 17:59:43 | Dashboard | every card loaded |  | dashboard-1791395983355.png |
| 18:00:24 | POS opened during the fault | loaded normally 1.0 s after it was opened |  | pos-opened-mid-incident-1791396024132.png |

Browser sales during the drill: 77, the most attempts one needed: 1. Bill photos saved in the browser: 20.

Sales: 241 started (77 in the browser), 241 confirmed, 241 in the shop's invoice list; lost 0, unaccounted 0, duplicated 0. Outcomes: first-try 164.

Session: 0 token refresh(es), 0 forced sign-in(s).

**Time to recovery**

- First user-visible failure 18:00:23, every user path answering again 18:05:29: 306.1 s seen by users.
- 307.1 s after the fault was injected, 6.4 s after it was cleared.

**Reconciliation afterwards**

| Date | Status | Drift | Sales | Net sales |
| --- | --- | --- | --- | --- |
| 2026-10-07 | CLEAN | 0 | 4147 | 82940.00 |

**What the alerts said**

| Alert | Severity | Target | Pending | Firing | Resolved | Routed to | Summary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DukaanAiEndpointDown | critical | http://api:3002/api/health/ready | 18:00:43 | 18:02:47 | 18:05:47 | held back by DukaanAiDependencyDown (would go to oncall, team) | http://api:3002/api/health/ready has failed its probe for 2 minutes |
| DukaanAiDependencyDown | critical | redis | 18:00:41 | 18:02:47 | 18:07:47 | oncall, team | The API cannot reach redis |
| DukaanAiEndpointDown | critical | https://api.dukaanai.test/api/health/ready | 18:01:28 | 18:03:37 | 18:06:37 | held back by DukaanAiDependencyDown (would go to oncall, team) | https://api.dukaanai.test/api/health/ready has failed its probe for 2 minutes |
| DukaanAiOutboxLag | warning |  | 18:05:41 | – | 18:05:57 |  | Outbox rows have been waiting for more than 5 minutes |

Expected to fire: DukaanAiDependencyDown.
