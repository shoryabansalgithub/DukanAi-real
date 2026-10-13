### Expire the TLS certificate (`tls-expiry`): PASS

2026-10-07T18:08:07.674Z to 2026-10-07T19:15:48.238Z UTC against https://api.dukaanai.test:8443. Browsers refuse an expired certificate outright. The certificate probe (job blackbox-tls) reads it whether or not it verifies: DukaanAiCertificateExpired pages at once, naming the cause, and Alertmanager holds back the DukaanAiEndpointDown of the same address. A certificate inside 14 days of expiry warns after an hour (DukaanAiCertificateExpiring, the near-expiry stage of DRILL_TLS_WARN_SECONDS).

**Timeline (UTC)**

| Time | Event | Detail |
| --- | --- | --- |
| 18:08:07 | baseline | 45 s of normal trading through https://api.dukaanai.test:8443 and https://app.dukaanai.test:8443 |
| 18:08:52 | warn | tls near for 3720 s |
| 18:09:07 | alert-pending | DukaanAiCertificateExpiring https://app.dukaanai.test/login |
| 18:09:47 | alert-pending | DukaanAiCertificateExpiring https://api.dukaanai.test/api/health/ready |
| 19:09:08 | alert-firing | DukaanAiCertificateExpiring https://app.dukaanai.test/login (warning): The certificate of https://app.dukaanai.test/login expires in under 14 days |
| 19:09:48 | alert-firing | DukaanAiCertificateExpiring https://api.dukaanai.test/api/health/ready (warning): The certificate of https://api.dukaanai.test/api/health/ready expires in under 14 days |
| 19:10:53 | inject | tls expired |
| 19:11:08 | alert-firing | DukaanAiCertificateExpired https://app.dukaanai.test/login (critical): The certificate of https://app.dukaanai.test/login has expired |
| 19:11:08 | alert-resolved | DukaanAiCertificateExpiring https://app.dukaanai.test/login |
| 19:11:38 | alert-pending | DukaanAiEndpointDown https://api.dukaanai.test/api/health/ready |
| 19:11:38 | alert-pending | DukaanAiEndpointDown https://app.dukaanai.test/login |
| 19:11:48 | alert-firing | DukaanAiCertificateExpired https://api.dukaanai.test/api/health/ready (critical): The certificate of https://api.dukaanai.test/api/health/ready has expired |
| 19:11:48 | alert-resolved | DukaanAiCertificateExpiring https://api.dukaanai.test/api/health/ready |
| 19:13:38 | alert-firing | DukaanAiEndpointDown https://api.dukaanai.test/api/health/ready (critical): https://api.dukaanai.test/api/health/ready has failed its probe for 2 minutes |
| 19:13:38 | alert-firing | DukaanAiEndpointDown https://app.dukaanai.test/login (critical): https://app.dukaanai.test/login has failed its probe for 2 minutes |
| 19:13:53 | clear | tls valid |
| 19:14:08 | alert-resolved | DukaanAiCertificateExpired https://app.dukaanai.test/login |
| 19:14:09 | recovered | every user path answers again |
| 19:14:38 | alert-resolved | DukaanAiEndpointDown https://api.dukaanai.test/api/health/ready |
| 19:14:38 | alert-resolved | DukaanAiEndpointDown https://app.dukaanai.test/login |
| 19:14:48 | alert-resolved | DukaanAiCertificateExpired https://api.dukaanai.test/api/health/ready |
| 19:15:48 | stopped | users stopped; verifying |

_Driver report of run `tls-expiry-20261007T180807Z`, copied unchanged except that the screenshots kept in the repository are linked; the others stay in the run's evidence directory._

**What users saw**

| User | Requests | Failed | Answers while failing | Message shown | Outage (s) |
| --- | --- | --- | --- | --- | --- |
| Cashier at the POS (POST /billing/invoice, retried with the same key) | 1366 | 89 | CERT_HAS_EXPIRED x89 | CERT_HAS_EXPIRED: certificate has expired | 179.2 |
| Owner on the dashboard (GET /dashboard/summary) | 802 | 36 | CERT_HAS_EXPIRED x36 | CERT_HAS_EXPIRED: certificate has expired | 179.8 |
| Anyone opening the web app (GET /login) | 802 | 36 | CERT_HAS_EXPIRED x36 | CERT_HAS_EXPIRED: certificate has expired | 180 |
| Smart Capture bill photo (POST /storage/bills) | 402 | 18 | CERT_HAS_EXPIRED x18 | CERT_HAS_EXPIRED: certificate has expired | 180.2 |
| Load balancer / uptime check (GET /api/health/ready) | 2003 | 90 | CERT_HAS_EXPIRED x90 | CERT_HAS_EXPIRED: certificate has expired | 180 |

Sales: 1292 started, 1292 confirmed, 1292 in the shop's invoice list; lost 0, unaccounted 0, duplicated 0. Outcomes: first-try 1291, absent-then-created 1.

| Bill photo | Attempts | Outcome | Answers |
| --- | --- | --- | --- |
| DRILL1791400258029 | 19 | stored-after-retry | CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > CERT_HAS_EXPIRED > 201 |

Session: 6 token refresh(es), 0 forced sign-in(s).

**Time to recovery**

- First user-visible failure 19:10:55, every user path answering again 19:13:58: 183.1 s seen by users.
- 185.1 s after the fault was injected, 4.8 s after it was cleared.

**Reconciliation afterwards**

| Date | Status | Drift | Sales | Net sales |
| --- | --- | --- | --- | --- |
| 2026-10-07 | CLEAN | 0 | 4585 | 91700.00 |
| 2026-10-08 | CLEAN | 0 | 854 | 17080.00 |

**What the alerts said**

| Alert | Severity | Target | Pending | Firing | Resolved | Routed to | Summary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DukaanAiCertificateExpiring | warning | https://app.dukaanai.test/login | 18:08:58 | 19:09:08 | 19:11:08 | team | The certificate of https://app.dukaanai.test/login expires in under 14 days |
| DukaanAiCertificateExpiring | warning | https://api.dukaanai.test/api/health/ready | 18:09:43 | 19:09:48 | 19:11:48 | team | The certificate of https://api.dukaanai.test/api/health/ready expires in under 14 days |
| DukaanAiCertificateExpired | critical | https://app.dukaanai.test/login | 19:10:58 | 19:11:08 | 19:14:08 | oncall, team | The certificate of https://app.dukaanai.test/login has expired |
| DukaanAiEndpointDown | critical | https://api.dukaanai.test/api/health/ready | 19:11:28 | 19:13:38 | 19:14:38 | held back by DukaanAiCertificateExpired (would go to oncall, team) | https://api.dukaanai.test/api/health/ready has failed its probe for 2 minutes |
| DukaanAiEndpointDown | critical | https://app.dukaanai.test/login | 19:11:28 | 19:13:38 | 19:14:38 | oncall, team; held back part of the time by DukaanAiCertificateExpired | https://app.dukaanai.test/login has failed its probe for 2 minutes |
| DukaanAiCertificateExpired | critical | https://api.dukaanai.test/api/health/ready | 19:11:43 | 19:11:48 | 19:14:48 | oncall, team | The certificate of https://api.dukaanai.test/api/health/ready has expired |

Expected to fire: DukaanAiCertificateExpired, DukaanAiCertificateExpiring.
