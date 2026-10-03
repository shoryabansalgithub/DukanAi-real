# Migrations runbook

The database schema changes only through `prisma/migrations`, applied with
`npx prisma migrate deploy`. Never `prisma db push` (it bypasses the history;
the ledger triggers and the data fixes exist only as migrations) and never
edit a migration that has been applied anywhere: CI compares every migration
file with the base branch (`scripts/check-migrations-immutable.sh`) and fails
on a change. A fix is a new migration; when it must work on databases in
different states, guard each statement with `information_schema` (see
`20260929090100_foundation_convergence/migration.sql`).

## Everyday

```bash
cd apps/api
npx prisma migrate status      # what is pending, failed or unknown
npx prisma migrate deploy      # apply pending migrations
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
```

The last command must print "No difference detected": the migrations produce
exactly `schema.prisma`. The API refuses to boot on a missing table or
column (`SCHEMA DRIFT DETECTED`) and prints these commands.

## A migration recorded as failed

`migrate deploy` stops at a failed migration. MySQL auto-commits DDL, so part
of it may have run. Decide from `migrate status` and the file:

- Nothing of it should stay: undo the statements that ran, then
  `npx prisma migrate resolve --rolled-back <name>` and `migrate deploy` again.
- Its effect is already there (or a later guarded migration converges it):
  `npx prisma migrate resolve --applied <name>` and `migrate deploy` again.

`20260919090000_pos_correctness_foundation` is the known case: its first
version failed on MySQL 8 at the duplicate merge. Resolve it as applied and
let `20260929090100_foundation_convergence` complete the structure; the
convergence migration is a no-op on a database that already has it.

## A migration edited after it was applied

`migrate deploy` does not verify checksums, so an edited migration applies
nowhere and breaks nothing at deploy time, but `migrate dev` and the CI check
reject it. Restore the original file from git and put the change into a new
migration.

## Rolling back a release

Prisma migrations have no "down" step and an applied migration is never
edited, so a rollback is one of three things. Decide before the deploy, not
after: take a backup (`scripts/db/backup.sh --label pre-<version>`; the
checklist in `DEPLOYMENT_CHECKLIST.md` has it as the step before
`migrate deploy`) and keep the previous API image tag at hand.

| The release's migrations are | Rollback |
|---|---|
| additive (new tables, columns with defaults, indexes; the usual case here) | redeploy the previous API image and leave the schema: the old code ignores what it does not know, and the boot drift check only refuses a *missing* table or column. Nothing to undo in the database. |
| a data fix or a tightened constraint that the old code cannot live with | write a new forward migration that reverses it (guarded with `information_schema` like `20260929090100_foundation_convergence`), `migrate deploy` it, then redeploy the previous image. The applied migration stays in the history. |
| destructive (a dropped or renamed column or table) and the data must come back | restore the pre-release backup into a fresh database (`scripts/db/restore.sh <file> --database <name> --create --yes`), verify it (`migrate status`, `migrate diff`, the row counts: `scripts/db/restore-drill.sh` does exactly this on every CI run), point `DATABASE_URL` at it and redeploy the previous image. Writes made after the backup are lost: this is the path of last resort, and the reason destructive changes ship as expand (new column, backfill, both written) then contract (old column dropped a release later), never in one migration. |

A migration that *failed* part-way is the case above ("A migration recorded
as failed"): `migrate resolve --rolled-back` after undoing the statements
that ran, or `--applied` when its effect is in place. `migrate resolve` only
edits the history table; it never changes the schema.

Rehearse: `docs/BACKUP_RESTORE.md` records the drill, and
`scripts/db/restore-drill.sh` runs it against any MySQL 8 (CI does, after
the integration suites).

## Triggers in a migration

Prisma sends a migration to MySQL as one multi-statement script, so a
migration never uses `DELIMITER` (a client-side command). Give a trigger a
`BEGIN ... END` body even when it is one statement: on MySQL 8 a bare
single-statement body followed by more script was stored with its
terminator (`SIGNAL ... ;`), mysqldump then wrote `... ; */;;` and the mysql
client refused the restore. `20261003090100_ledger_triggers_portable_bodies`
recreated the ledger triggers that way (`scripts/db/backup.sh` also drops
such a terminator, so backups taken before it restore too), and the restore
drill in CI would catch a repeat.

## New database

`npx prisma migrate deploy` from an empty schema builds everything, triggers
included. The integration test database is built the same way in CI.
