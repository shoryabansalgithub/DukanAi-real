### Expire the TLS certificate (`tls-expiry`): PASS

2026-10-07T19:17:26.703Z to 2026-10-07T19:24:16.922Z UTC against https://api.dukaanai.test:8443. Browsers refuse an expired certificate outright. The certificate probe (job blackbox-tls) reads it whether or not it verifies: DukaanAiCertificateExpired pages at once, naming the cause, and Alertmanager holds back the DukaanAiEndpointDown of the same address. A certificate inside 14 days of expiry warns after an hour (DukaanAiCertificateExpiring, the near-expiry stage of DRILL_TLS_WARN_SECONDS).

**Timeline (UTC)**

| Time | Event | Detail |
| --- | --- | --- |
| 19:17:26 | baseline | 45 s of normal trading through https://api.dukaanai.test:8443 and https://app.dukaanai.test:8443 |
| 19:18:11 | inject | tls expired |
| 19:18:36 | alert-pending | DukaanAiEndpointDown https://api.dukaanai.test/api/health/ready |
| 19:18:36 | alert-pending | DukaanAiEndpointDown https://app.dukaanai.test/login |
| 19:18:46 | alert-firing | DukaanAiCertificateExpired https://api.dukaanai.test/api/health/ready (critical): The certificate of https://api.dukaanai.test/api/health/ready has expired |
| 19:19:06 | alert-firing | DukaanAiCertificateExpired https://app.dukaanai.test/login (critical): The certificate of https://app.dukaanai.test/login has expired |
| 19:20:36 | alert-firing | DukaanAiEndpointDown https://api.dukaanai.test/api/health/ready (critical): https://api.dukaanai.test/api/health/ready has failed its probe for 2 minutes |
| 19:20:36 | alert-firing | DukaanAiEndpointDown https://app.dukaanai.test/login (critical): https://app.dukaanai.test/login has failed its probe for 2 minutes |
| 19:21:12 | clear | tls valid |
| 19:21:28 | recovered | every user path answers again |
| 19:21:36 | alert-resolved | DukaanAiEndpointDown https://api.dukaanai.test/api/health/ready |
| 19:21:36 | alert-resolved | DukaanAiEndpointDown https://app.dukaanai.test/login |
| 19:23:46 | alert-resolved | DukaanAiCertificateExpired https://api.dukaanai.test/api/health/ready |
| 19:24:06 | alert-resolved | DukaanAiCertificateExpired https://app.dukaanai.test/login |
| 19:24:16 | stopped | users stopped; verifying |

_Driver report of run `tls-expiry-20261007T191726Z`, copied unchanged except that the screenshots kept in the repository are linked; the others stay in the run's evidence directory._

**What users saw**

| User | Requests | Failed | Answers while failing | Message shown | Outage (s) |
| --- | --- | --- | --- | --- | --- |
| Cashier at the POS (POST /billing/invoice, retried with the same key) | 150 | 89 | CERT_HAS_EXPIRED x89 | CERT_HAS_EXPIRED: certificate has expired | 178.9 |
| Owner on the dashboard (GET /dashboard/summary) | 72 | 36 | CERT_HAS_EXPIRED x36 | CERT_HAS_EXPIRED: certificate has expired | 180.2 |
| Anyone opening the web app (GET /login) | 72 | 36 | CERT_HAS_EXPIRED x36 | CERT_HAS_EXPIRED: certificate has expired | 180.1 |
| Smart Capture bill photo (POST /storage/bills) | 37 | 18 | CERT_HAS_EXPIRED x18 | CERT_HAS_EXPIRED: certificate has expired | 180.2 |
| Load balancer / uptime check (GET /api/health/ready) | 178 | 90 | CERT_HAS_EXPIRED x90 | CERT_HAS_EXPIRED: certificate has expired | 180.1 |

Sales: 76 started, 76 confirmed, 76 in the shop's invoice list; lost 0, unaccounted 0, duplicated 0. Outcomes: first-try 75, absent-then-created 1.

| Bill photo | Attempts | Outcome | Answers |
| --- | --- | --- | --- |
| DRILL1791400696725 | 19 | stored-after-retry | CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > 201 |

Session: 0 token refresh(es), 0 forced sign-in(s).

**Time to recovery**

- First user-visible failure 19:18:12, every user path answering again 19:21:16: 184.2 s seen by users.
- 185.2 s after the fault was injected, 4.8 s after it was cleared.

**Reconciliation afterwards**

| Date | Status | Drift | Sales | Net sales |
| --- | --- | --- | --- | --- |
| 2026-10-08 | CLEAN | 0 | 936 | 18720.00 |

**What the alerts said**

| Alert | Severity | Target | Pending | Firing | Resolved | Routed to | Summary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DukaanAiEndpointDown | critical | https://api.dukaanai.test/api/health/ready | 19:18:28 | 19:20:36 | 19:21:36 | held back by DukaanAiCertificateExpired (would go to oncall, team) | https://api.dukaanai.test/api/health/ready has failed its probe for 2 minutes |
| DukaanAiEndpointDown | critical | https://app.dukaanai.test/login | 19:18:28 | 19:20:36 | 19:21:36 | held back by DukaanAiCertificateExpired (would go to oncall, team) | https://app.dukaanai.test/login has failed its probe for 2 minutes |
| DukaanAiCertificateExpired | critical | https://api.dukaanai.test/api/health/ready | 19:18:43 | 19:18:46 | 19:23:46 | oncall, team | The certificate of https://api.dukaanai.test/api/health/ready has expired |
| DukaanAiCertificateExpired | critical | https://app.dukaanai.test/login | 19:18:58 | 19:19:06 | 19:24:06 | oncall, team | The certificate of https://app.dukaanai.test/login has expired |

Expected to fire: DukaanAiCertificateExpired.
