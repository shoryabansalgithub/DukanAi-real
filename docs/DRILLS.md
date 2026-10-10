# Failure drills (roadmap 9.18)

The test suites inject failures in-process. These drills inject them into a
running system: real containers stopped and killed, a real volume filled, a
real certificate expired at the edge, and a real restore from the encrypted
off-site copy. For each drill this document records what users saw, what
the alerts said, the time to recovery and the reconciliation afterwards.

**Where the recorded runs come from.** Staging does not exist yet (row 9.9
waits for the accounts), so the runs below were made on a production-shaped
stack on the development machine. It is the reference compose stack with
the images built from this commit: MySQL 8.0, Redis 7, the API and the web,
the Caddy edge serving HTTPS, and the monitoring stack (Prometheus 3.5 with
`deploy/prometheus/alerts.yml`, Alertmanager 0.34 with the repository's
routing, the blackbox exporter probing the internal targets and the public
edge names). The staging runs are the owner's (§6), with the same driver
and the staging stack's own fault commands (§5). The reports of the
recorded runs, and the screenshots §3 cites, are in
[`docs/drills/2026-10-07/`](drills/2026-10-07/).

**The result.** All six drills pass on the images built from this commit
(§3: 2026-10-07, 17:46 to 19:25 UTC). In the five drills that traded
through a fault, 1,860 sales were made, 178 of them in a real browser, and
every one is in the shop's invoice list exactly once: none lost, none
billed twice, the sale whose answer died with the API included. Every
business day the drills touched reconciles CLEAN, and so does the copy
restored from the off-site backup. Getting there took thirteen fixes (§2):
what users saw was the problem far more often than the books were.

## 1. Summary

| Drill | What users saw | What the alerts said | Time to recovery | Reconciliation | Verdict |
|---|---|---|---|---|---|
| Kill the API during a burst of 8 checkouts | the till's client: 502 for 4.1 s, then every sale answered; of the 8 checkouts of the burst, 2 completed before the kill, 5 were created once by their retry and 1 that had committed got its stored invoice back (200, no second bill); a POS opened during the restart loaded itself 4.2 s later; the dashboard, the login page and Smart Capture were untouched | nothing paged: `DukaanAiApiDown` and the readiness probe pending only, inside their 2-minute holds | 4.6 s | 86 sales, none lost or billed twice; CLEAN | PASS |
| Stop MySQL for 60 s | at the till, on the dashboard and in Smart Capture, 503 `DATABASE_UNAVAILABLE` ("Please retry in a few seconds") for 65 to 70 s, Retry keeping the same key; the dashboard kept its figures under "Refresh failed — showing last data"; a POS opened during the outage loaded itself 6 s after MySQL was back; Smart Capture could not open until then | nothing paged, by design: 64 s is inside every 2-minute hold (`DukaanAiDependencyDown`, the probes and `DukaanAiHigh5xxRate` pending only) | 74.1 s (10.8 s after MySQL was back) | 78 sales; CLEAN | PASS |
| Fill the documents volume for 3 minutes | bill photos refused with 507 `STORAGE_FULL` ("Nothing was saved"), the photo kept on screen; the same photo stored 5.2 s after space was freed; sales and the dashboard untouched | **`DukaanAiStorageFull`** paged the on-call and the team after 1 minute | 180.5 s for bill photos (5.2 s after freeing) | 163 sales; CLEAN | PASS |
| Stop Redis for 5 minutes | nothing on any path a person uses (sales, dashboard, login, photos all answered); readiness 503 by design | **`DukaanAiDependencyDown`** ("The API cannot reach redis") paged after 2 minutes; both readiness pages held back by it, no late page | no user outage | 241 sales; CLEAN | PASS |
| Expire the TLS certificate (3 minutes, after an hour near expiry) | every path: `certificate has expired` (in a browser the full-page error, and with HSTS no way past it) | **`DukaanAiCertificateExpiring`** warned the team after an hour; at expiry **`DukaanAiCertificateExpired`** paged the on-call and the team within 15 s, and the probes' pages were held back by it (through the recovery too, on the final rules) | 183.1 s (4.8 s after the valid certificate) | 1,292 sales; CLEAN on both business days the run crossed | PASS |
| Restore the database from the off-site backup to the second before a chosen sale | the restored shop holds the three earlier sales and neither the chosen sale nor the two after it; sessions opened after the dump sign in again | nothing (the live system was never down) | 26.5 s from the decision to a restored API answering sign-in | restored copy CLEAN | PASS |

## 2. What the drills found, and what changed

The first pass ran every drill against the images built from the previous
commit (§4); findings 1 to 8 come from it. The drills were then run again
on the fixed build, with the browser observer, and again after each new
finding (9 to 13), until a full pass turned up nothing new: that last
pass, on the images built from this commit, is the record of §3. Each fix has a test that fails without
it.

| # | Drill | What happened before | What changed | Proof |
|---|---|---|---|---|
| 1 | MySQL stopped 60 s | Every sale, dashboard load and bill photo answered **500 "Internal server error"** for the whole minute, and each one was reported to error tracking as a bug (P1001 / P1017 / MySQL 1053 "shutdown in progress" fell through the exception filter). | A database that cannot be reached is **503 `DATABASE_UNAVAILABLE`** with `Retry-After: 5` ("The database is unavailable at the moment. Please retry in a few seconds."), logged as a warning, never tracked as a bug (`src/common/db/database-unavailable.ts`). | `global-exception.filter.spec.ts` (the five outage shapes the drill met) |
| 2 | MySQL stopped 60 s | **`DukaanAiHigh5xxRate` paged the on-call 4.5 minutes after every user had recovered** (13:49:03, the outage ended 13:44:33): over a 5-minute ratio the outage kept the trailing rate above 1 % for exactly the alert's 5-minute hold. `DukaanAiUnhandledErrors` fired at once and stayed for 15 minutes. | The ratio is taken over 2 minutes (a 60-second outage can no longer satisfy a 5-minute hold) and the readiness route is left out (finding 6); outages are the probes' and `DukaanAiDependencyDown`'s job. | The recorded Prometheus series of that drill: the old expression is true 13:44:00 to 13:49:00 (11 samples), the new one 13:44:00 to 13:46:00 (5). `alerts.test.yml` replays it; the old rule fails the test at 10m30s. |
| 3 | Redis stopped 5 min | **Every new sale hung until the client gave up (30 s)** although it had committed (its retry answered 200 with the stored invoice in 25 ms), and **every dashboard load hung (15 s)** for the whole outage. The Keyv cache store (node-redis) queues commands while disconnected and answers them only when Redis returns; the sale's post-commit cache invalidation and the dashboard's cache read waited on it. | The cache store runs with `disableOfflineQueue`, a connect timeout and a capped reconnect: while Redis is away a cache command answers at once as a miss (`src/common/cache/cache-options.ts`). | `cache-options.spec.ts` (a Redis that goes away mid-test: the old settings hang, the new answer in under a second) |
| 4 | Redis stopped 5 min | **Monitoring went blind and paged the wrong thing.** `/api/metrics` waited for BullMQ's job counts (which wait for Redis forever), Prometheus' scrape timed out, **`DukaanAiApiDown` paged "API not scrapeable" for an API that was selling**, every series vanished (`DukaanAiBackupNeverRecorded` went pending for all four kinds) and the readiness pages were held back by the false `ApiDown`. | The scrape probes the database and Redis first (`dependency_up{dependency}`), skips the sources whose dependency is down and bounds every source to 2.5 s. **`DukaanAiDependencyDown` ("The API cannot reach redis")** pages after 2 minutes and Alertmanager holds back the readiness probe's `DukaanAiEndpointDown` while it fires: one page that names the cause. | `observability-collectors.service.spec.ts` (a hanging Redis, a source that never settles, a dead database); `alerts.test.yml`; the inhibit rule checked against the running Alertmanager |
| 5 | Redis stopped 5 min | (after 3 and 4) `DukaanAiHigh5xxRate` still paged as Redis came back, although every sale had succeeded: the 503s were the readiness probes', which answer 503 by design while a dependency is away. | `/api/health*` is left out of the 5xx ratio. | `alerts.test.yml` (six minutes of readiness 503s beside steady sales: no alert) |
| 6 | Storage volume filled | The first bill photo after the volume filled answered **500**, and every retry of it answered **409 `STORAGE_EVIDENCE_EXISTS` for good**, even after space was freed: the exclusive write had created the file, the disk had refused the bytes, and the truncated file stayed behind as "evidence". The JSON indexes were rewritten in place (a failed write could empty them), a full action log failed requests whose document was stored, and **no alert existed for a full volume**. | A full volume is **507 `STORAGE_FULL`** ("The document store is full. Nothing was saved; try again once space has been freed."). A request's files are written all or none (`writeAllEvidence`), indexes are replaced through a temporary file and a rename (`writeJsonAtomic`), the action log never fails a request, and a failed backup zip is removed. `storage_volume_free_bytes` / `storage_volume_size_bytes{volume}` feed **`DukaanAiStorageLow`** (under 10 % free, 15 min) and **`DukaanAiStorageFull`** (under 2 %, 1 min, critical). | `storage.service.spec.ts` (a write that fails half-way: nothing left, the same bill stored once space is back; an index write that fails: the previous index intact); `alerts.test.yml` |
| 7 | MySQL stopped 60 s / any 5xx | The POS offered **Retry only when no answer arrived at all**. A 5xx that did reach the page (the database outage's 500, now 503; a 502 or 503 from a load balancer that answers on the API's behalf) showed "failed (HTTP 5xx)" with neither the Retry button nor any word on whether paying again would bill twice, although resubmitting with the same key is safe. (Through this stack's edge the API is another origin and the edge's own 502 carries no CORS headers, so a browser sees a restart as "unreachable", which already offered Retry.) | The POS checkout and the return dialog treat any 5xx like a lost answer: the message, "Your cart and request key are kept, so retrying will not create a duplicate bill.", and the Retry button that resubmits with the same key (`isRetryableFailure`). Copy and button visibility only; no layout or styling change. | `apps/web/e2e/pos-checkout.spec.ts` (503 then an empty 502, Retry twice, one bill; the test fails on the previous page); the MySQL run in §3 (the screenshot) |
| 8 | (stack start) | **`DukaanAiReconciliationStale` went pending on a fresh stack**: an unlabelled prom-client gauge always exports a sample, so "never reconciled" read as "last run in 1970" (the code comment said the opposite). | The alert ignores 0. | `alerts.test.yml` (a stack that has never reconciled: no alert) |
| 9 | (first fixed pass, the browser) | **Behind the edge, the reference compose stack told browsers to call the API at `http://localhost:3002/api`**: `docker-compose.yml` never passed `API_PUBLIC_URL` to the web, so the page served the image's build-time default. It worked on the host itself and nowhere else (the production compose file and the Kubernetes manifests were right). | `docker-compose.yml` passes `API_PUBLIC_URL` to the web. | The served `<meta name="dukaanai-api-url">` before and after (§3) |
| 10 | (first fixed pass) | **`DukaanAiStorageFull` fired at baseline for the uploads volume: correctly.** It lived on the development machine's disk, which had 4.7 GB of its allowance left (1.9 % free). | Nothing in the product; the drill overlay gives uploads its own volume, so the alert speaks about the drill's volumes. The alert proved itself on a real disk before the drill did. | §3 |
| 11 | Redis stopped 5 min (fixed pass) | **The page came back as Redis did.** With fix 4, `DukaanAiDependencyDown` held the readiness probes back, but it resolved first: the blackbox probes run once a minute, so the probe through the edge was still failing 50 s after the alert that explained it had gone, and its `DukaanAiEndpointDown` fired un-held for that time. | `DukaanAiDependencyDown` keeps firing for 2 minutes after the dependency is back (`keep_firing_for: 2m`), longer than a probe interval plus its evaluation, so every probe recovers while it still holds them back. | `alerts.test.yml` (Redis back at 5m30s: still firing at 7m, gone at 8m30s; without `keep_firing_for` the test fails); the Redis run in §3 (both EndpointDowns resolved while `DukaanAiDependencyDown` still fired) |
| 12 | Expired certificate | **The warning resolved itself the moment the certificate expired, and the page two minutes later named no cause.** The probes verify the certificate; an expired one fails the handshake, so its expiry series disappeared, `DukaanAiCertificateExpiring` resolved ("fixed", as far as the team could tell) and `DukaanAiEndpointDown` paged "has failed its probe". Once the certificate alert below existed, the final pass found the race of finding 11 in it: after the renewal it resolved 30 s before the probe it held back, which fired un-held for those 30 s. | The certificate alerts read a probe that reads the certificate whether or not it verifies (module `tls_certificate`, job `blackbox-tls`, the public addresses). **`DukaanAiCertificateExpired` ("The certificate of ... has expired", critical)** pages on the first evaluation that sees it, the warning ends there because the page that names the cause starts, and Alertmanager holds back the `DukaanAiEndpointDown` of the same address; like `DukaanAiDependencyDown` it keeps firing for 2 minutes after a renewal is read, so the address's probes recover while they are still held back. | `alerts.test.yml` (a certificate that lapses 30 minutes in: no warning left, the page at once, the probe's `DukaanAiEndpointDown` behind it, the page still firing a minute after the renewal and gone two minutes after; the previous rules fail the test); the inhibit rule checked on Alertmanager 0.34 (the same address held back, the internal probe and the other address not); the certificate run in §3 |
| 13 | API killed (the browser) | **A POS page opened while the API restarted stayed broken after the API was back.** The restart takes about 5 s; a cashier who opened or reloaded the POS in that window got "the API ... is unreachable" for the shift, the shop and the product list, and 25 s after the API was back the page still said so. The shift and the products offered a Retry button and waited for it; the shop load had none, so the POS stayed unscoped (no barcode scanner, GST previewed intra-state, cart kept anonymously) until the page was reloaded. With one API replica (roadmap 9.7) every deploy is such a restart. | The shop, the shift and the product grid and search retry on their own after a network or 5xx failure: 1 s, 2 s, 4 s, 8 s, then every 10 s, the error staying on screen until an answer arrives (no flicker, no layout change); Retry and typing still start over at once (`backgroundRetryDelayMs`). | `apps/web/e2e/pos-checkout.spec.ts` (every load fails for 6 s after the page opens: the three errors show, then go without a click, and a search during a second window recovers; the test fails on the previous page, where the shop warning never goes); the API-kill run in §3 |


## 3. The drills

Every figure below comes from the driver's report of that run (linked;
the screenshots beside it) and is repeated in §1. The users are those of
§5: a cashier's client, the owner's dashboard, the login page, Smart
Capture and the readiness probe over HTTP, and a real browser with a
cashier at the POS, a second cashier who opens the POS once the fault is
in place, the owner's dashboard and Smart Capture.

### 3.1 Kill the API during a checkout burst (`api-kill`): PASS

17:46:47 to 17:49:42 UTC. Report: [api-kill.md](drills/2026-10-07/api-kill.md).

**What was done.** After 45 s of normal trading, eight checkouts were
started together at 17:47:32 and the API's process was killed 0.3 s later
(SIGKILL from the host: a crash, so Docker's restart policy brings the
container back as it would after a real one). One API replica, as
production runs (roadmap 9.7).

**What users saw.**

| User | What happened |
|---|---|
| Cashier's client (resubmits the same key every 2 s) | 502 with an empty body 14 times over 4.1 s (the edge, with no API behind it), then every sale answered |
| The eight checkouts of the burst | 2 completed before the kill. 5 were in flight and had not committed: each retry created the sale once (`502 > 502 > 201`). 1 had committed but its answer died with the process: the retry with the same key answered **200 with the stored invoice**, not a second bill (`502 > 502 > 200`) |
| Owner's dashboard, login page, Smart Capture | nothing; none of their requests fell inside the 4 s |
| Readiness probe | 502 twice over 4.1 s |
| Browser: a second cashier opening the POS 1 s after the kill | "Loading current shift (GET /shifts/current) failed: the API at https://api.dukaanai.test:8443/api is unreachable. Is the backend running?", the same for the shop and the product list, each with Retry ([screenshot](drills/2026-10-07/api-kill/pos-opened-mid-incident-1.jpg)). 4.2 s after it was opened, with no click, the page had its shop, shift and products ([screenshot](drills/2026-10-07/api-kill/pos-opened-mid-incident-2.jpg)) |
| Browser: the POS cashier, the dashboard, Smart Capture | 25 sales and 7 bill photos, the dashboard loaded throughout; none of them touched the API inside the 4 s |

The edge's own 502 carries no CORS headers, so a browser reports a
restart as "unreachable" rather than as a 502.

**What the alerts said.** Nothing paged. `DukaanAiApiDown` and
`DukaanAiBackupNeverRecorded` (all four kinds: the API's series vanish
with its process) were pending for 16 s, and the internal readiness
probe's `DukaanAiEndpointDown` for a minute: a restart inside the
2-minute holds is not a page.

**Time to recovery.** 4.6 s from the first failure a user saw to every
path answering; 5.0 s after the kill.

**Reconciliation afterwards.** 86 sales started (25 in the browser), 86
confirmed, 86 in the shop's invoice list: none lost, none duplicated, none
unaccounted. `POST /reconciliation/run` for 2026-10-07: CLEAN (3,665 sales
on that business day so far, ₹73,300.00 net).

### 3.2 Stop MySQL for 60 seconds (`mysql-stop`): PASS

17:49:48 to 17:53:40 UTC. Report: [mysql-stop.md](drills/2026-10-07/mysql-stop.md).

**What was done.** `docker compose stop mysql` at 17:50:33 (a clean
shutdown: 4.4 s, during which MySQL already refuses statements with error
1053), `start` at 17:51:37.

**What users saw.**

| User | What happened |
|---|---|
| Cashier's client | 503 `DATABASE_UNAVAILABLE` ("The database is unavailable at the moment. Please retry in a few seconds.", `Retry-After: 5`) 32 times over 64.8 s; the same key then billed once (one sale `absent-then-created`) |
| Owner's dashboard | 503 `DATABASE_UNAVAILABLE` 13 times over 65.2 s |
| Smart Capture | 503 `DATABASE_UNAVAILABLE` 7 times over 70.1 s; the same bill stored on its 8th attempt |
| Login page | nothing (the page does not need the database; signing in would have) |
| Readiness probe | 503 33 times over 66.1 s (`"checks":{"database":"down","redis":"up"}`) |
| Browser: a second cashier opening the POS at 17:50:38 | "The database is unavailable at the moment. Please retry in a few seconds." on the shift, the shop (with "GST is being split as intra-state until the shop profile loads.") and the product list, each with Retry ([screenshot](drills/2026-10-07/mysql-stop/pos-opened-mid-incident-1.jpg)); 66.2 s after it was opened, 6 s after MySQL was back and with no click, the page had its shop, shift and products. The POS cashier, whose next sale opened the POS during the outage, saw the same |
| Browser: the owner's dashboard | from 17:51:12 "Refresh failed — showing last data" in the header and on the sales trend, the KPIs and the insights, the last figures kept and the 503 message in the badge's tooltip ([screenshot](drills/2026-10-07/mysql-stop/dashboard.jpg)); every card loaded again at 17:52:03 |
| Browser: Smart Capture opened during the outage | "Unable to load customers. Could not load customers. Please try again." with Retry: the page needs its customer list before it shows the camera, and does not say why ([screenshot](drills/2026-10-07/mysql-stop/smart-capture.jpg)). Opened again after the outage, the bill was stored |

The payment panel of the POS during the same kind of outage (an earlier
run at 16:55 UTC on the same API image and the previous web image, whose
payment panel is unchanged): "The database is unavailable at the
moment. Please retry in a few seconds. Your cart and request key are kept,
so retrying will not create a duplicate bill." with `DATABASE_UNAVAILABLE`
and Retry, and the receipt after the 19th attempt
([screenshot](drills/2026-10-07/mysql-stop/pos-payment-retry.jpg)).

**What the alerts said.** Nothing paged, by design: the outage lasted 64 s
and every database alert holds for 2 minutes. `DukaanAiDependencyDown`
(`database`) was pending from 17:50:56 and resolved at 17:51:58; the
readiness probes' `DukaanAiEndpointDown` were pending (internal 17:50:43 to
17:52:48, through the edge 17:51:28 to 17:52:38); `DukaanAiHigh5xxRate` was
pending from 17:51:11 and cleared two minutes after the outage, within its
5-minute hold (the first pass paged it 4.5 minutes after recovery,
finding 2).

**Time to recovery.** 74.1 s from the first failure a user saw to every
path answering; 10.8 s after MySQL was started.

**Reconciliation afterwards.** 78 sales (24 in the browser): none lost,
duplicated or unaccounted. Reconciliation of 2026-10-07: CLEAN (3,743
sales, ₹74,860.00).

### 3.3 Fill the storage volume (`storage-full`): PASS

17:53:46 to 17:59:30 UTC. Report: [storage-full.md](drills/2026-10-07/storage-full.md).

**What was done.** At 17:54:31 `dd` filled the documents volume (64 MB,
`STORAGE_ROOT`) to its last byte from inside the API container; at 17:57:31
the filler was removed. The uploads volume was left alone.

**What users saw.**

| User | What happened |
|---|---|
| Smart Capture (one bill, resubmitted with the same bill id every 10 s) | 507 `STORAGE_FULL` ("The document store is full. Nothing was saved; try again once space has been freed.") 18 times over 180.5 s; stored on the 19th attempt, 5.2 s after the space was freed (before the fixes: 409 for good, finding 6) |
| Cashier's client, owner's dashboard, login page, readiness probe | nothing: 163 sales, every one on its first attempt |
| Browser: Smart Capture | the toast "Storing the bill (POST /storage/bills/Walk-in/…) failed (HTTP 507: The document store is full. Nothing was saved; try again once space has been freed.)." with the photo still on screen and its Save buttons ([screenshot](drills/2026-10-07/storage-full/smart-capture.jpg)); the same photo stored at 17:57:38, on its 8th press of Save |
| Browser: the POS (both cashiers) and the dashboard | unaffected; the second cashier's POS loaded in 1.0 s |

**What the alerts said.** **`DukaanAiStorageFull` ("The storage volume is
full", critical)** went pending at 17:54:41, fired at 17:55:46 and was
routed to the on-call and the team; it resolved at 17:57:46.
`DukaanAiStorageLow` was pending (its hold is 15 minutes) and
`DukaanAiHigh5xxRate` was pending from 17:55:26 to 17:59:16 on the 507s
(under its 5-minute hold).

**Time to recovery.** 180.5 s for the one user path affected; 5.2 s after
the volume was freed.

**Reconciliation afterwards.** 163 sales (52 in the browser): none lost,
duplicated or unaccounted. Reconciliation of 2026-10-07: CLEAN (3,906
sales, ₹78,120.00).

**Runbook walked.** The first look of `DukaanAiStorageFull`
(`docs/OBSERVABILITY.md`): `storage_volume_free_bytes` by `volume` named
`storage` at 0 bytes free; freeing the volume ended the 507s within one
retry and the alert within two minutes.

### 3.4 Stop Redis for 5 minutes (`redis-stop`): PASS

17:59:37 to 18:08:01 UTC. Report: [redis-stop.md](drills/2026-10-07/redis-stop.md).

**What was done.** `docker compose stop redis` at 18:00:22, `start` at
18:05:22.

**What users saw.** Nothing, on every path a person uses: 149 sale
requests, 90 dashboard loads, 90 login pages and 45 bill photos all
answered (before the fixes every sale and dashboard load hung, finding 3).
Stock keys, the cache and the rate-limit counters fell back in process;
queued work waited. Only the readiness probe answered 503 (153 times over
306.1 s, `"checks":{"database":"up","redis":"down"}`), by design. In the
browser, 77 sales and 20 bill photos went through, the dashboard loaded
throughout and the second cashier's POS loaded in 1.0 s.

**What the alerts said.** **`DukaanAiDependencyDown` ("The API cannot
reach redis", critical)** went pending at 18:00:41, fired at 18:02:47 and
was routed to the on-call and the team. The readiness probes'
`DukaanAiEndpointDown` fired too (internal 18:02:47, through the edge
18:03:37) and were **held back by `DukaanAiDependencyDown`**: one page that
names the cause instead of three. Both resolved (18:05:47, 18:06:37) while
`DukaanAiDependencyDown` still fired (`keep_firing_for`, resolved 18:07:47),
so the recovery sent no late page (finding 11). `DukaanAiOutboxLag` was
pending for 16 s after Redis returned: the outbox rows staged during the
outage were relayed within a minute.

**Time to recovery.** No user path failed. Readiness answered again 6.4 s
after Redis was started.

**Reconciliation afterwards.** 241 sales (77 in the browser), every one on
its first attempt: none lost, duplicated or unaccounted. Reconciliation of
2026-10-07: CLEAN (4,147 sales, ₹82,940.00).

**Runbook walked.** The first look of `DukaanAiDependencyDown`: `GET
/api/health/ready` answered 503 with `"redis":"down"` (the probe's
recorded answer), the page names Redis, and the readiness pages it held
back did not reach anyone.

### 3.5 Expire the TLS certificate (`tls-expiry`): PASS

18:08:07 to 19:15:48 UTC, then the expired stage once more on the final
rules (below). Report: [tls-expiry.md](drills/2026-10-07/tls-expiry.md).

**What was done.** At 18:08:52 the edge was given a certificate that
expires in three days, inside the 14-day warning, and left so for an hour
while trading went on. At 19:10:53 it was given an expired one (no issuer
hands one out, so it comes from the drill's own CA) and at 19:13:53 a valid
one again. The driver's clients and the probes verify certificates against
the drill CA, as a browser does against the public roots.

**What users saw.** During the hour near expiry, nothing. With the expired
certificate, every path a person uses failed the TLS handshake with
`certificate has expired` (`CERT_HAS_EXPIRED`): the cashier's client 89
times over 179.2 s, the dashboard 36 times, the login page 36 times, Smart
Capture 18 times (the bill stored on its 19th attempt) and the readiness
probe 90 times over 180 s. In a browser this is the full-page certificate
error (`NET::ERR_CERT_DATE_INVALID` in Chrome), and with the HSTS header the
edge sends there is no way past it; the browser observer does not run in
this drill because the drill CA is not in Chromium's store.

**What the alerts said.** **`DukaanAiCertificateExpiring`** ("The
certificate of https://app.dukaanai.test/login expires in under 14 days",
warning) fired at 19:09:08 for the app address and 19:09:48 for the API
address, after its one-hour hold, and went to the team. When the expired
certificate was read, it ended and **`DukaanAiCertificateExpired`** ("The
certificate of https://app.dukaanai.test/login has expired", critical)
fired on the same evaluation: at 19:11:08 for the app address, 15 s after
the expiry, and 19:11:48 for the API address, routed to the on-call and the
team. The verified probes' `DukaanAiEndpointDown` fired at 19:13:38 for
both addresses and Alertmanager held them back (an Alertmanager sample
every 20 s: `suppressed`, `inhibitedBy=1`). One thing was still wrong:
after the valid certificate, `DukaanAiCertificateExpired` for the app
address resolved at 19:14:08, 30 s before that address's probe recovered,
and for those 30 s its `DukaanAiEndpointDown` was **active and un-held**
(Alertmanager at 19:14:16: `active`, `inhibitedBy=0`). That is the race of
finding 11 again; `DukaanAiCertificateExpired` now keeps firing for 2
minutes too (finding 12), proven by the rerun below.

**Time to recovery.** 183.1 s from the first failure a user saw to every
path answering (the three minutes of the expired certificate); 4.8 s after
the valid certificate was installed.

**Reconciliation afterwards.** 1,292 sales over the 67 minutes (one, in
flight when the certificate expired, created by its retry): none lost,
duplicated or unaccounted. The run crossed midnight in the shop's time zone
(18:30 UTC), so both business days were reconciled: 2026-10-07 CLEAN (4,585
sales, ₹91,700.00) and 2026-10-08 CLEAN (854 sales, ₹17,080.00). The
cashier's session refreshed its access token 6 times and was never asked to
sign in again.

**Runbook walked.** The first look of `DukaanAiCertificateExpired`:
`curl -vI` against the app address at 19:11:15 answered `TLS alert,
certificate expired` and `curl: (60) SSL certificate problem: certificate
has expired`; installing a valid certificate (Caddy reload) ended the
outage within 5 s.

**The expired stage on the final rules.** 19:17:26 to 19:24:20 UTC.
Report: [tls-expiry-rerun.md](drills/2026-10-07/tls-expiry-rerun.md). The
same three minutes with an expired certificate, straight from a valid one,
after `DukaanAiCertificateExpired` gained `keep_firing_for`. Users saw the
same: `certificate has expired` on every path for 184.2 s, every path
answering 4.8 s after the valid certificate. `DukaanAiCertificateExpired`
fired 34 s after the expiry for the API address and 54 s for the app
address (the probes run once a minute), routed to the on-call and the
team. Both `DukaanAiEndpointDown` fired at 19:20:36 and resolved at
19:21:36, **held back the whole time** (every Alertmanager sample:
`suppressed`, `inhibitedBy=1`), while `DukaanAiCertificateExpired` resolved
at 19:23:46 and 19:24:06. 76 sales, none lost or billed twice;
reconciliation of the business day (2026-10-08 in the shop's time zone):
CLEAN (936 sales, ₹18,720.00).

### 3.6 Restore the database from the off-site backup to the second before a chosen sale (`offsite-restore`): PASS

19:16:00 to 19:17:02 UTC. Report: [offsite-restore.md](drills/2026-10-07/offsite-restore.md).

**What was done.** A dump was taken at 19:16:00 (the nightly backup's
command), then six sales were made. The fourth, INV-2026-27-005443 at
19:16:14.053, was chosen as the sale to undo, and the target became
19:16:14 UTC, the second it began. The binary-log archive was flushed and
everything was pushed encrypted to the off-site remote (as the 5-minute
archiver and the nightly push do). At 19:16:28, the decision: the off-site
copy was fetched onto an empty volume, `restore.sh --to` restored the dump
(232 tables, 2 triggers, 22 applied migrations in 15 s) and replayed the
archived binary log from the dump's position up to the target (0 s), and an
API was started on the restored database with its own Redis database, so
no cached figure of the abandoned timeline is served.

**What users saw.** On the restored API the invoice list holds the three
earlier sales, not the chosen one and not the two after it. A session
opened after the dump answers 401 there: anyone who signed in after the
restore point signs in again.

**What the alerts said.** Nothing: the live system was never down.

**Time to recovery.** 26.5 s from the decision to the restored API
answering sign-in (the hook took 26.3 s; 40 s from the chosen sale, with
the archive flush and the push). The first fixed pass measured 20 s on a
smaller database.

**Reconciliation afterwards.** On the restored copy, the business day of
the chosen sale (2026-10-08 in the shop's time zone): CLEAN (857 sales,
₹17,140.00).

## 4. The first pass, before the fixes

The first pass ran on 2026-10-07 between 13:41 and 14:37 UTC, against
images built from the previous commit, on the same stack, with the five
HTTP users of §5 (the browser observer was added for the second pass).
Every drill held the books: no sale was lost or duplicated, and every
reconciliation was CLEAN. What users and the on-call saw was another
matter:

| Drill | Users saw | Alerts said | Recovery | Gate |
|---|---|---|---|---|
| API killed in a burst of 8 checkouts | the cashier's client: 502 x12 over 4.3 s; 5 of the 8 burst sales were created on their third attempt (none had committed when the process died) | nothing (a 4-second restart is inside every 2-minute hold) | 4.3 s | PASS |
| MySQL stopped 60 s | the cashier, the owner and Smart Capture: **500 "Internal server error"** for 60 to 67 s | `DukaanAiUnhandledErrors` at once, still firing 7 minutes later; **`DukaanAiHigh5xxRate` paged the on-call at 13:49:03, 4.5 minutes after recovery**; the readiness probes went pending and cleared | 67 s | PASS |
| Redis stopped 5 min | **every new sale hung 30 s** (committed; the retry found it), **every dashboard load hung 15 s**, for 5 minutes | **`DukaanAiApiDown` paged for an API that was selling** (the scrape hung), `DukaanAiBackupNeverRecorded` pending for all four kinds, the readiness pages held back behind the false `ApiDown` | 282 s | PASS |
| Storage volume filled | Smart Capture: one 500, then **409 `STORAGE_EVIDENCE_EXISTS` 68 times, for good** | nothing (no alert watched the volume) | never | **FAIL** (a document refused for good) |
| Expired certificate (3 min) | every user: "certificate has expired" (`CERT_HAS_EXPIRED`) | `DukaanAiEndpointDown` for both public probes after 2 minutes, resolved within a minute of the valid certificate | 181 s | PASS |
| Off-site restore to the second before a chosen sale | the restored shop held the three earlier sales and neither the chosen sale nor the two later ones; a session opened after the dump was refused (401) | nothing | 24.2 s from the decision to a serving API | PASS |

The certificate and restore drills needed no change; their final records in
§3 are runs of the fixed build.

## 5. Running the drills

### On this machine (the production-shaped stack)

```
scripts/drills/drill-stack.sh up                 # the stack, the drill certificates, first backups
scripts/drills/drill-stack.sh run mysql-stop     # one drill; evidence in $DRILL_DIR/evidence
DRILL_TLS_WARN_SECONDS=3720 scripts/drills/drill-stack.sh all   # all six, with the hour-long near-expiry stage
scripts/drills/drill-stack.sh down               # remove the stack and its volumes
```

`DRILL_DIR` (default `/tmp/dukaanai-drill`) holds the generated secrets, the
drill CA and its three certificates (valid, expiring in 3 days, expired
yesterday), the rendered Prometheus configuration, the off-site directory
and the evidence. Nothing is written into the checkout. The overlay
`scripts/drills/compose.drill.yml` lists what differs from the reference
stack, and why: size-limited volumes for documents and uploads, the edge
serving the drill certificates under `app.dukaanai.test` /
`api.dukaanai.test` (added to `/etc/hosts`), the blackbox exporter trusting
the drill CA, and Prometheus with the public targets of `prometheus.yml`
enabled. The images must exist first (`docker compose build`, or release
images retagged `dukaanai-api`, `dukaanai-web`, `dukaanai-db-ops`). Do not
edit `drill-stack.sh` while a run is in progress: bash reads a script as
it executes it, and the running copy fails on the shifted lines.

On the development machine Debian's package mirrors are blocked and egress
goes through a proxy with its own CA. The images were therefore built with
the repository's Dockerfiles unchanged, on a local base image: the full
`node:22.22.2-bookworm`, which already carries `openssl` and
`ca-certificates`, plus the proxy CA. That base was passed as
`--build-arg NODE_VERSION=22.22.2-sandbox`. CI and the release workflow
build on the real slim base.

The release certification runs the same six drills against the release
candidate's images: the `drills` step of `scripts/certify/certify.sh`, after
the main stack is torn down. Its evidence sits under `drills/` in the
bundle.

### On staging

The driver needs only the public URLs, the monitoring URLs and one command
per fault:

```
export DRILL_API_URL=https://api.staging.example.com
export DRILL_WEB_URL=https://app.staging.example.com
export DRILL_PROMETHEUS_URL=http://<prometheus>:9090      # through the operator tunnel
export DRILL_ALERTMANAGER_URL=http://<alertmanager>:9093
export DRILL_STATE_FILE=$HOME/dukaanai-drills/account.json DRILL_EVIDENCE_DIR=$HOME/dukaanai-drills
# one command per hook (docker-compose.prod.yml on the server shown; Kubernetes in the right column)
export DRILL_HOOK_API_KILL='ssh stg docker kill -s KILL dukaanai-prod-api-1'       # kubectl -n dukaanai delete pod -l app=dukaanai-api --grace-period=0 --force
export DRILL_HOOK_MYSQL_STOP='<provider CLI: stop the instance, or block 3306 in its firewall>'
export DRILL_HOOK_MYSQL_START='<provider CLI: start the instance, or reopen 3306>'
export DRILL_HOOK_REDIS_STOP='<provider CLI / firewall>'  DRILL_HOOK_REDIS_START='<the reverse>'
export DRILL_HOOK_STORAGE_FILL='ssh stg docker exec dukaanai-prod-api-1 sh -c "dd if=/dev/zero of=\$STORAGE_ROOT/.drill-fill bs=1M"'
export DRILL_HOOK_STORAGE_FREE='ssh stg docker exec dukaanai-prod-api-1 rm -f /var/lib/dukaanai/storage/.drill-fill'
export DRILL_HOOK_TLS_EXPIRED='<install an expired certificate on the edge: EDGE_TLS_LINE="tls /etc/caddy/drill/expired.crt /etc/caddy/drill/edge.key", caddy reload>'
export DRILL_HOOK_TLS_VALID='<restore the normal EDGE_TLS_LINE, caddy reload>'
export DRILL_HOOK_RESTORE_BACKUP='ssh stg docker compose -f docker-compose.prod.yml --profile ops run --rm db-ops backup --label drill'
export DRILL_HOOK_RESTORE_PUBLISH='ssh stg "... db-ops binlog-archive --flush && ... db-ops offsite push"'
export DRILL_HOOK_RESTORE_RUN='<fetch the off-site copy on a clean machine, restore.sh --to "$DRILL_TARGET_TIME" into a new database or instance, start an API on it>'
export DRILL_RESTORED_API_URL=http://<that API>:3002
node scripts/drills/drill.mjs api-kill    # ... and the other five
```

Fill the storage volume only on staging, and keep the hold short
(`DRILL_HOLD_SECONDS`): `dd` stops at the last free byte of the volume that
holds `STORAGE_ROOT`, and the free hook removes only its own file. An
expired certificate cannot come from the ACME issuer, so the drill installs
a self-made one for three minutes. Browsers would refuse it either way; the
driver's client verifies it against the staging CA bundle
(`NODE_EXTRA_CA_CERTS`). Run the browser observer beside each drill with
`DRILL_OBSERVER_REPORT`, `DRILL_OBSERVER_STOP_FILE` and `npx playwright
test --config playwright.drill.config.ts` in `apps/web`, as `drill-stack.sh`
does.

### What a drill measures, and when it fails

| Measure | How |
|---|---|
| What users saw | Five users work through the public URLs for the whole drill. A cashier sells one item at a time; a failed sale is resubmitted with the same body and key every 2 s, which is what the POS Retry button does. The owner loads the dashboard every 5 s, someone opens the login page every 5 s, a Smart Capture bill photo is stored every 10 s and retried with the same bill id, and the readiness probe is read every 2 s. Every answer is recorded with its status, code and message. A real browser (the observer, `apps/web/e2e-drills`) works beside them through the same edge: one cash sale after another at the POS (Retry when offered, otherwise Pay again), the dashboard left open (its 30-second polling; its alerts and its "Refresh failed" status badges are read every 10 s, also while a sale is being retried), a bill photo saved in Smart Capture every 20 s through the gallery input, and a second cashier who opens the POS the moment the fault is in place (the driver signals it) and touches nothing until the page has its shop, shift and products. Each change of what a screen says is recorded with a screenshot, and every browser receipt is accounted for with the other sales. |
| What the alerts said | Prometheus `/api/v1/alerts` and Alertmanager `/api/v2/alerts` every 10 s: when each alert went pending, fired and resolved, where it was routed, and whether Alertmanager held it back (and by which alert). |
| Time to recovery | From the first failure a user saw to the moment every user path answered again, and from the clearing of the fault to that moment. |
| Reconciliation afterwards | Every sale the users were told about is in the invoice list exactly once (none lost, none duplicated, none unaccounted). Then `POST /reconciliation/run` for every business day the drill touched must answer CLEAN. |
| Verdict | FAIL on a lost or duplicated sale, a sale never confirmed, a user path that never recovers (10 minutes after the fault cleared), a document refused for good, an expected alert that never fired, or a reconciliation that is not CLEAN. |

## 6. Staging runs (owner)

| Date | Release tag | Drill | Verdict | Users saw | Alerts (and the page on the phone) | Recovery | Reconciliation | Who |
|---|---|---|---|---|---|---|---|---|
| | | api-kill | | | | | | |
| | | mysql-stop | | | | | | |
| | | redis-stop | | | | | | |
| | | storage-full | | | | | | |
| | | tls-expiry | | | | | | |
| | | offsite-restore | | | | | | |

Each runbook of row 9.22 is walked once during these runs (the first walk
of every page, on the local drill stack, is section 7 of
`docs/RUNBOOKS.md`). The on-call person follows the runbook of every alert
that fires, and the time from the page to the first correct action is the
third column of that runbook's review.

## 7. What these runs do not show

- **That a phone rang.** The drill stack's Alertmanager has no channel
  configured (no `ALERT_*` variables), so "routed to oncall, team" above is
  the route Alertmanager chose, not a delivered page. The page on a phone
  is part of every staging run (§6) and of row 9.10's gate.
- **Managed services failing.** Here MySQL and Redis are containers that
  stop cleanly. On staging they are managed: a failover, a DNS change or a
  TLS error on the connection fails differently, which is why the staging
  hooks (§5) stop the real instances or close their firewall.
- **Load.** One shop, one cashier client and one browser: the point is the
  failure, not the volume. The business day of row 9.17 ran 30 cashiers
  through an API kill and a Redis restart under load.
- **How a certificate really expires.** An issuer never hands out an
  expired certificate; the drill installs one. In production a certificate
  expires only after renewal has failed for 14 days, all of them under
  `DukaanAiCertificateExpiring`.
- **The runbooks on staging.** Every page of `docs/RUNBOOKS.md` (row 9.22)
  was walked on this stack, one fault per alert, and corrected where the
  walk found it wrong (its section 7, 2026-10-08); the staging runs above
  walk them again with the real paging channel and the managed services.
