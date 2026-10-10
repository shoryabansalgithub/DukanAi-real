# Releasing DukaanAI

A release is a semantic version tag on a commit of `main`, such as `v1.0.0-rc3`
or `v1.2.0`. The same images go first to staging and then to production under
that tag. They are never rebuilt for production. This file is the procedure,
from the backup to the rollback (roadmap 9.21).

It builds on these documents:
- [`docs/STAGING.md`](docs/STAGING.md): the environments and promotion.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md): images, probes and topology.
- [`apps/api/prisma/MIGRATIONS.md`](apps/api/prisma/MIGRATIONS.md): the
  database side of a rollback.
- [`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md): backups and restores.
- [`docs/RUNBOOKS.md`](docs/RUNBOOKS.md): incidents.

The record of each release goes in [`CHANGELOG.md`](CHANGELOG.md).

## Roles

| Role | Who | Does |
|---|---|---|
| Release manager | named by the owner for each release | prepares the release commit, watches the workflow, reads the certification, deploys staging, runs the smoke and the rollback rehearsal, deploys production |
| Owner | the repository owner | pushes the tag, approves promotion to production after reading the evidence, publishes the GitHub release |

One person may hold both roles. The tag push and the production approval are
always the owner's decision.

## Versions

- `vMAJOR.MINOR.PATCH`, semver 2.0.0, no build metadata.
  - PATCH: fixes only, with no data-changing migration.
  - MINOR: new features, with additive migrations only.
  - MAJOR: a change an operator must act on, such as a destructive migration,
    a removed route or a removed environment variable.
- Candidates for a version are `-rc1` to `-rc9`, as in `v1.0.0-rc3`. Pre-release
  identifiers compare as text, so `rc10` would sort before `rc2`. After a ninth
  candidate, release the version or move to the next one.
- The root, `apps/api` and `apps/web` `package.json` carry the version, without
  the `v`. `packages/invoice-math` is a library with its own version.
- The release workflow refuses the following:
  - a tag that is not a semantic version;
  - a version that does not match `package.json`;
  - a version without a dated `CHANGELOG.md` section;
  - a version not above every earlier release tag;
  - a commit that is not on `main`.

  The checker is `scripts/release/release.mjs`.
- A version is published once. The workflow refuses to rebuild or re-push a
  version the registry already holds. A fix is the next version.

## 1. Prepare the release commit

On a branch, as a pull request to `main`, once every change of the release is
on `main` with CI green:

1. In `CHANGELOG.md`:
   - Rename `## [Unreleased]` to `## [vX.Y.Z] - YYYY-MM-DD` (today, UTC).
   - Put a new empty `## [Unreleased]` above it.
   - Update the two link definitions at the foot of the file.
   - Make sure the section opens with its upgrade notes: new or removed
     variables, the migrations, and anything an operator must do.
2. Bump the version:

   ```
   npm version X.Y.Z --no-git-tag-version --include-workspace-root -w api -w dukaanai-web
   ```

   This changes the three `package.json` files and `package-lock.json`, nothing
   else.
3. Run `node scripts/release/release.mjs lint`. CI runs it too: the newest
   section must be the `package.json` version.
4. Merge. CI on `main` must be green. The release workflow then builds
   `sha-<commit>` images of that commit; they are not the release yet.

## 2. Check, then tag (owner)

```
git fetch origin --tags
git checkout --detach origin/main
node scripts/release/release.mjs check vX.Y.Z
git tag -a vX.Y.Z -m "DukaanAI vX.Y.Z"
git push origin vX.Y.Z
```

`check` must end with `vX.Y.Z: semantic version, package.json X.Y.Z, CHANGELOG
section dated ..., above N earlier release tag(s), on main`. It lists every problem
otherwise.

Pushing the tag starts `.github/workflows/release.yml`. Its `images` job:
1. Runs `check` again; nothing is built for a tag that fails it.
2. Refuses a version the registry already has.
3. Builds the API, web and db-ops images with `APP_RELEASE=vX.Y.Z` and
   `APP_REVISION=<commit>`. These become the OCI `version` / `revision`
   labels, the `release` field of `GET /api/health` and `build_info{release}`.
4. Runs the Trivy gate.
5. Pushes `:vX.Y.Z` and `:sha-<7>`.
6. Writes the SBOMs.
7. Opens a draft GitHub release. Its notes are the CHANGELOG section
   (`release.mjs notes`); it is a pre-release for an `-rc`.

## 3. Certify

The `certify` job runs `scripts/certify/certify.sh` against the images just
pushed (roadmap 9.12). It attaches the evidence bundle
`certification-vX.Y.Z.tar.gz` to the draft release and keeps it as a workflow
artefact.

Read `SUMMARY.md`. Every step must PASS, including `release`, which checks
that the three images and the running API and web all say `vX.Y.Z` and the
commit.

The `load` step's p95 depends on the runner. Judge a FAIL there against
`docs/LOAD_TEST_BASELINE.md`, not as a verdict on the image.

When certification fails:
- A product failure means fix it on `main` and cut the next candidate. A tag
  is never moved or re-pushed.
- An infrastructure failure (runner lost, registry unreachable) means using
  "Re-run failed jobs" on the same run. That re-runs certify against the same
  pushed images. Do not dispatch the workflow on an existing version tag: the
  never-rebuilt guard refuses it.

## 4. Deploy to staging

On the staging host, in the directory holding `docker-compose.prod.yml` and its
`.env`:

```
grep '^IMAGE_TAG=' .env                     # the release running now: write it down, it is the rollback target
docker compose -f docker-compose.prod.yml --profile ops run --rm db-ops backup --label pre-vX.Y.Z
docker compose -f docker-compose.prod.yml --profile ops run --rm db-ops documents-backup
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=vX.Y.Z/' .env
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml run --rm migrate
docker compose -f docker-compose.prod.yml up -d --wait
```

- Both backups must end with their checksum line. `db-ops status` shows them.
  The dump records its binary-log position, so a restore can roll forward
  (`docs/BACKUP_RESTORE.md`).
- `migrate` prints each migration it applies, or `No pending migrations to
  apply`. A failed migration stops here: see "A migration recorded as failed"
  in `apps/api/prisma/MIGRATIONS.md`, and do not start the new release.

## 5. Smoke on staging

```
bash scripts/smoke-remote.sh https://<staging WEB_HOST> https://<staging API_HOST>
curl -fsS https://<staging API_HOST>/api/health        # "release":"vX.Y.Z"
curl -fsS https://<staging WEB_HOST>/api/health        # "release":"vX.Y.Z"
curl -fsS https://<staging API_HOST>/api/health/ready  # 200, every check up
```

The smoke must end `REMOTE SMOKE PASSED`. It covers:
- registration, API and web sign-in;
- stock, a shift and a sale;
- the dashboard and a CLEAN reconciliation;
- HTTP redirected, HSTS set, metrics hidden.

Then:
- Run the checks the CHANGELOG section's upgrade notes call for.
- Run phases 4 and 5 of `DEPLOYMENT_CHECKLIST.md`.
- Look at the staging Grafana operations dashboard. Alertmanager must show
  nothing firing that was not firing before the deploy.

## 6. Rehearse the rollback on staging

Every release candidate that carries a migration rehearses one rollback on
staging before it goes to production. The result goes in the release notes.

1. Run "Rollback" below to the release written down in step 4.
2. Run the smoke of step 5. `/api/health` must answer the previous release
   (an image older than 9.21 has no `release` field; its tag is the evidence).
3. Deploy `vX.Y.Z` again with step 4, without the backups.
4. Run the smoke of step 5 again.

## 7. Deploy to production

Only the tag certified and smoked on staging goes to production, with the same
`.env` keys (`docs/STAGING.md`, "What makes it identical"). Run the commands of
step 4 on the production host, then:

```
bash scripts/smoke-remote.sh https://<WEB_HOST> https://<API_HOST> --probes-only   # no shop is registered on production
curl -fsS https://<API_HOST>/api/health                                         # "release":"vX.Y.Z"
```

Schedule it outside shop hours. Run the backups of step 4 right before the
migration; they are the restore point if everything else fails.

## 8. Verify

For the first hour:
- No alert fires (`docs/RUNBOOKS.md` has the page of each).
- The 5xx ratio and checkout latency panels look as they did before.
- Error tracking shows nothing new under the release (Sentry groups by
  `APP_RELEASE`).

The next morning the nightly reconciliation must be CLEAN for every shop
(`DukaanAiReconciliationDrift` stays quiet).

Then the owner edits the draft release. They add:
- where the evidence is: the certification bundle, the staging smoke line, the
  rollback rehearsal and the production smoke;
- the date it reached production.

They then publish it. A candidate stays a pre-release.

## Rollback

Prisma has no down migrations and an applied migration is never edited. A
rollback therefore means deploying the previous image over the newer schema,
or restoring the database.

Choose by the release's migrations: the table in
`apps/api/prisma/MIGRATIONS.md`, "Rolling back a release". Before choosing,
check one more case. A release that adds an enum value is additive for the
schema but not for the previous build. Prisma refuses a value its client does
not know, so once a row holds the new value, every read of that row by the
previous image fails with `Value '...' not found in enum`.

### Previous image (additive migrations, the usual case)

```
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=<previous>/' .env
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d --wait
```

- The previous image's `migrate` service still runs first (compose makes the
  API wait for it). Against the newer database it answers `No pending
  migrations to apply` and exits 0. Prisma does not refuse migrations it does
  not know.
- The boot drift check refuses only a missing table or column, so the
  previous API starts.
- Nothing is undone in the database. Rolling forward later is step 4 again.

### Restore (destructive migrations, or rows the previous build cannot read)

Restore the pre-release dump into a new database and verify it. The commands
are in `docs/BACKUP_RESTORE.md`: `db-ops restore ... --database <new>
--create --yes`, then `migrate status`, `migrate diff` and the row counts, as
the restore drill does. Then:
1. Point `DATABASE_URL` at the new database.
2. Restore the documents archive if documents changed.
3. Deploy the previous image as above.

Everything written after the backup is lost unless the dump is rolled forward
with `--to`. That replay also brings back the rows the previous build cannot
read. So when the release must go back with the data, the way is a forward
fix (the next version), not a restore.

### v1.0.0-rc3

Its only migration after the 9.19 commit is
`20261008090000_onboarding_imports`. It is additive (columns on the import
tables and the `OPENING_BALANCE_EQUITY` ledger account), so the previous
image runs on it.

That holds until rc3 writes the new account. It does so the first time a shop
records opening stock or opening udhar, and that happens on a shop's first
day:
- a product created with stock on the Products page;
- `POST /inventory-domain/:id/adjust` with `OPENING_BALANCE`;
- an opening stock or customer import.

Each posts against `OPENING_BALANCE_EQUITY`. From then on the previous build
fails on that shop's ledger:
- `POST /reconciliation/run` answers 500 and records a FAILED run, which also
  pages `DukaanAiReconciliationDrift`;
- the logs read `Value 'OPENING_BALANCE_EQUITY' not found in enum
  'LedgerAccount'`;
- sales, invoices and the dashboard keep working.

Check before rolling back:

```sql
SELECT COUNT(*) FROM LedgerTransaction WHERE account = 'OPENING_BALANCE_EQUITY';
```

- At 0, roll back by image.
- Above 0, fix forward: deploy rc3 again or the next candidate. A database
  restore would lose the openings and every sale since.

No production database predates rc3, so this binds staging only. Later
releases ship a new enum value one release before the code that writes it
(`apps/api/prisma/MIGRATIONS.md`), which keeps the previous release readable.

## Rehearsal record

v1.0.0-rc3 was rehearsed on 2026-10-08, from the backup to the rollback and
back. Staging does not exist yet, so the stand-in was the production-shaped
drill stack of `docs/DRILLS.md` on the development machine: MySQL 8.0.46,
Redis 7, the TLS edge, Prometheus, Alertmanager and the blackbox exporter.

**Images.** They were built as `.github/workflows/release.yml` builds them,
on the sandbox Node base (`docs/DRILLS.md` §5):
- the candidate, from a clone whose `main` is the release commit `a1adc11`,
  tagged `v1.0.0-rc3` there only (never pushed);
- the previous release `sha-905425a`, the 9.19 commit.

**Release check.** `release.mjs check v1.0.0-rc3` refused the branch before
it is merged ("not on main"). It passed once `main` held the commit.

**Image selection.** An overlay selected the images by `IMAGE_TAG`, the way
`docker-compose.prod.yml` does.

| Step | What ran | Result |
|---|---|---|
| Production before the release | `IMAGE_TAG=sha-905425a`: stack up, first backups of every kind, `smoke-remote.sh` | REMOTE SMOKE PASSED; reconciliation CLEAN |
| 4. Backups | `db-ops backup --label pre-v1.0.0-rc3`, `documents-backup` | dump with its binary-log position (`binlog.000004:44051`); documents archive written |
| 4. Deploy | `IMAGE_TAG=v1.0.0-rc3`, `run --rm migrate`, `up -d --wait` | applied `20261008090000_onboarding_imports`; API and web healthy |
| 5. Smoke | `smoke-remote.sh … --http-port 8080`; `/api/health` on both hosts; readiness; Prometheus `build_info` | PASSED; `release` = `v1.0.0-rc3` on the API, the web and `build_info`; database and Redis up |
| 3. Certify (subset) | `certify.sh --release v1.0.0-rc3` from the tagged clone: images, boot matrix, migrations on MySQL 8 and MariaDB 10.11, `release` | 4 / 4 PASS; the same run with `--release v1.0.0-rc4` FAILS the `release` step (5 mismatches) |
| 6. Rollback | `IMAGE_TAG=sha-905425a`, `up -d --wait` | up in 25 s; its `migrate` answered "No pending migrations to apply" (exit 0); smoke PASSED |
| The enum caveat | on the previous release, the shop whose opening stock the rc3 smoke had recorded | `POST /reconciliation/run` 500 and a FAILED run; dashboard and invoices 200 |
| Roll forward | `IMAGE_TAG=v1.0.0-rc3`, `up -d --wait` | up in 25 s; smoke PASSED; that shop's reconciliation CLEAN |

**Remaining owner-side gate.** The same steps on the real staging environment
with the pushed tag, then the owner's approval.

**Found by the rehearsal.**
- `docker manifest inspect` reports a manifest it cannot read as "no such
  manifest". The never-rebuilt guard now asks the registry for the HTTP status
  instead; tested with a stub registry for 404, 200, 401, unreachable and a
  refused token.
- `smoke-remote.sh` gained `--http-port` for an edge whose plain HTTP is not
  on port 80.
- The rollback window of rc3 is a shop's first opening stock, not only an
  import (above).
