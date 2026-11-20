### Restore the database from the off-site backup to the point before a chosen sale (`offsite-restore`): PASS

2026-10-07T19:16:00.157Z to 2026-10-07T19:17:02.576Z UTC against https://api.dukaanai.test:8443. The nightly dump plus the 5-minute binary-log archive, shipped encrypted off-site, fetched onto an empty volume and rolled forward to one second before the chosen sale.

**Timeline (UTC)**

| Time | Event | Detail |
| --- | --- | --- |
| 19:16:00 | backup | the dump the restore starts from |
| 19:16:22 | chosen-sale | INV-2026-27-005443 at 2026-10-07T19:16:14.053Z; the restore target is 2026-10-07 19:16:14 UTC (the second it began) |
| 19:16:22 | publish | binary-log archive and off-site push |
| 19:16:28 | restore | fetch the off-site copy onto an empty volume, restore to the target, start an API on it |
| 19:16:54 | restored-serving | the restored API answers sign-in 26.5 s after the decision |
| 19:16:55 | verify | restored copy: 3/3 earlier sales, chosen sale absent, 0/2 later sales |

_Driver report of run `offsite-restore-20261007T191559Z`, copied unchanged except that the screenshots kept in the repository are linked; the others stay in the run's evidence directory._

**What users saw**

- Before the restore the shop had the three earlier sales (INV-2026-27-005440, INV-2026-27-005441, INV-2026-27-005442), the chosen sale INV-2026-27-005443 and two later ones (INV-2026-27-005444, INV-2026-27-005445).
- On the restored database the invoice list shows 3/3 earlier sales, the chosen sale absent, 0/2 later sales.
- A session opened after the dump answered 401 on the restored API: users who signed in after the restore point sign in again.

**Time to recovery**

- Decision to restore until the restored API answered sign-in: 26.5 s (fetch from off-site, restore, roll-forward, API start; the hook took 26.3 s).

```
 Container dukaanai-drill-db-ops-run-b8f14c212f05 Creating 
 Container dukaanai-drill-db-ops-run-b8f14c212f05 Created 
==> Restored 232 tables, 2 triggers, 22 applied migrations into dukaanai_restored in 15s

==> Replaying 1 binary log(s) from binlog.000061:502294 up to 2026-10-07 19:16:14 UTC into dukaanai_restored

==> Replayed to 2026-10-07 19:16:14 UTC in 0s: dukaanai_restored is dukaanai as of that second
Next: from apps/api, with DATABASE_URL on dukaanai_restored, run `npx prisma migrate status` and the migrate diff (see the header of this script).
19:16:48 starting an API on the restored database (port 3012, its own Redis db so no cached figure of the abandoned timeline is served)
 Container dukaanai-drill-api-restored Creating 
 Container dukaanai-drill-api-restored Created 
19:16:54 restored API ready
```

**Reconciliation afterwards (on the restored copy)**

| Date | Status | Drift | Sales | Net sales |
| --- | --- | --- | --- | --- |
| 2026-10-08 | CLEAN | 0 | 857 | 17140.00 |

**What the alerts said**

No alert went pending or fired.

Expected to fire: none.
