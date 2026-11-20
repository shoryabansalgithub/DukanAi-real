# Go-live record (phase 9 exit gate)

The go / no-go record for putting DukanAI in front of real shops. Production
opens when every item below is **Met**, with the evidence linked and the
owner's name and date in the last column; the owner's decision at the foot
is the go-live. Until then this file says what is still open and who closes
it. The release procedure (`RELEASE.md`) and the deployment checklist
(`DEPLOYMENT_CHECKLIST.md`) run for every release; this record runs once,
for the first production release, and again only if the owner reopens it.

Statuses: **Met** (the evidence exists and is linked), **Proven in CI**
(the repository proves the mechanism on every run, the environment-side
evidence is still owed), **Open** (nothing to show yet), with the owner of
the next step. Current as of 2026-10-11, taken from `docs/STAGING.md`,
`docs/PILOT.md`, `docs/security/PENTEST_SCOPE.md`, `docs/security/ASVS_L2.md`,
`docs/SUPPORT.md`, `docs/SECRETS.md` and `RELEASE.md`. No item is Met yet:
every one waits for staging, the pilot shop or an owner decision.

| # | Gate item | Status | Evidence (link it here) | Next step, owner | Signed (name, date) |
|---|---|---|---|---|---|
| 1 | The certify job is green on the release tag and its evidence bundle is attached: boot matrix, drift on both engines (MySQL 8.0 and 8.4, MariaDB), every suite over HTTP against the images, route walker, exploit replay, load and upload gates, restore drills (database point in time, documents, off-site). | Proven in CI | `.github/workflows/release.yml` job `certify`, `scripts/certify/certify.sh`; `docs/DEPLOYMENT.md`, "Certification of a release candidate". No release tag has been pushed through it yet: v1.0.0-rc3 was rehearsed locally (`RELEASE.md`, "Rehearsal record"). | push the first release tag after the audit fixes; read `SUMMARY.md` (every step PASS, nothing "not run"): release manager, owner | |
| 2 | The simulated business day and the failure drills produced zero 5xx, zero lost or duplicated invoices and zero reconciliation drift, with every alert delivered to a person. | Proven in CI | `docs/BUSINESS_DAY.md`, `docs/DRILLS.md` (local production-shaped stack; shortened business day and the drills on every certify run). Staging rows of `docs/STAGING.md` "Evidence": pending. Alerts to a phone: pending (`docs/OBSERVABILITY.md`, "Test the delivery"). | run both on staging with alerts delivered to the on-call phone: release manager | |
| 3 | ASVS L2 shows zero open controls; the external test's findings are closed or accepted in writing with an owner and a date. | Open | `docs/security/ASVS_L2.md`: no Open control, but the eight rows of §15 "Owner decisions" are undated. `docs/security/PENTEST_SCOPE.md`: scope letter, accounts, test window, report, retest all pending; tracker empty (the test has not run). | date the §15 decisions; sign the scope letter, run the test on staging, close or accept every finding: owner, tester | |
| 4 | Backups: last success within the RPO, off-site, encrypted, restore proven on a clean machine within the RTO; the stale-backup alert exists. | Proven in CI | `docs/DATA_SAFETY.md` (objectives signed 2026-10-05; measured restore), `docs/BACKUP_RESTORE.md` (drills), alerts `DukaanAiBackupStale` / `DukaanAiBackupNeverRecorded` with promtool tests per topology. Production-side: the agent's first runs against the managed database, the off-site bucket and a clean-machine restore within the RTO are pending the environment. | provision the backup user, the off-site bucket and run the drill against a restored copy of the managed instance: operator | |
| 5 | Staging matches production; TLS at the edge; secrets in the store and rotated once; the topology decision implemented. | Open | Topology decided and built (`docs/DEPLOYMENT.md`, "Production topology"; `docker-compose.prod.yml`, `deploy/k8s`). `docs/STAGING.md` "Addresses" and every "Evidence" row: pending. `docs/SECRETS.md` "Rotation log": the staging rotations are empty. | provision staging and production, run the staging evidence rows and one rotation of each secret: owner, operator | |
| 6 | The pilot shop signed off every feature on real hardware; its defects are fixed and re-tested. | Open | `docs/PILOT.md`: pre-flight done and its defects fixed and re-tested; §5 (the shop's checklist) and §7 (sign-off) pending. | the staging fortnight and the production fortnight in the pilot shop, then the sign-off: owner, pilot shop | |
| 7 | Release procedure rehearsed including a rollback; runbooks walked; support staffed; privacy notice and terms published; data export and deletion executed once. | Open | `RELEASE.md`: rc3 rehearsed with a rollback on the drill stack, not on staging. `docs/RUNBOOKS.md` §7: every page walked on the drill stack (Met for the repository). `docs/SUPPORT.md`: channel addresses and the rota open. `docs/privacy/PRIVACY_NOTICE.md`, `TERMS_FOR_SHOPS.md`: drafts for the owner's advisor, not in force. `docs/privacy/DATA_REQUESTS.md`: the export and erasure tooling is tested; the staging run and the advisor's review are pending. | rehearse a release and rollback on staging; staff the channel; publish the notice and terms; run one export and one deletion on staging: release manager, owner, advisor | |
| 8 | The production-ready definition holds: no open P0 or P1; every write route has a role; every tenant model is scoped; every supplied id is ownership-checked; every money path reconciles; every UI action persists or is absent; monitoring, alerting, backups and drills in place. | Open | The release-readiness audit of 2026-10-11 found one P0 and P1 findings (reset email, money and GST paths, import bounds, queue memory, webhooks, privacy export and erasure, CI and deployment gates); they are fixed for the next candidate and each fix carries its regression test. The standing guards: `src/auth/route-authorization.spec.ts`, `src/prisma/tenant-scope.spec.ts`, `test/integration/tenant-isolation.integration-spec.ts`, `test/integration/cross-shop-isolation.integration-spec.ts` with `src/prisma/raw-sql-tenancy.spec.ts` and `node dist/cli/tenant-audit` (`docs/security/TENANT_ISOLATION.md`), the route walker, reconciliation (`src/reconciliation`), the persistence suites of `apps/web/e2e`. | certify the candidate that carries every audit fix; re-run the exploit replay; keep procurement paused (`FEATURE_PROCUREMENT_ENABLED=false`) until its findings close: repository, owner | |

## Decision

| Decision | Name | Date | Notes |
|---|---|---|---|
| Go / no-go for production | | | |

Review this record before the decision and at any change to the gate: a
new release candidate (items 1 and 8), a staging change (item 5), the
pilot's progress (item 6). `docs/DATA_SAFETY.md` is reviewed with it.
