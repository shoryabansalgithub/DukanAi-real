# Staging

Roadmap 9.9. Staging is production with other names: the same images, the
same compose file (or manifests), a managed MySQL 8 and Redis of the
production class, the edge with real certificates, secrets from the secret
store, real SMTP, Sentry and a metrics token. Nothing is built on the
servers: a release is an image tag, built once by
`.github/workflows/release.yml`, run on staging first and on production
second (`docs/DEPLOYMENT.md`, "Images and promotion").

## Addresses

Filled in by the owner when the environment exists; until then the column
holds the naming convention. Everything else in this document is already
true of the repository.

| Item | Staging | Production |
|---|---|---|
| Web | `https://staging-app.<domain>` (`WEB_HOST`) | `https://app.<domain>` |
| API | `https://staging-api.<domain>` (`API_HOST`; the browser-facing URL is `/api` on it) | `https://api.<domain>` |
| Host | one VM, `/srv/dukaanai`, `docker-compose.prod.yml` | same |
| MySQL 8 | managed instance, own database `dukaanai`, TLS, PITR window ≥ 7 days | own instance, never shared with staging |
| Redis | managed instance, db 0 | own instance |
| Edge | Caddy, automatic certificates (`EDGE_TLS_LINE` blank) | same |
| SMTP | the production relay with a staging sender (`EMAIL_FROM`) | production sender |
| Sentry | `SENTRY_ENVIRONMENT=staging`, same project | `production` |
| Metrics | `METRICS_TOKEN` set; Grafana on the host, port 3001 behind the firewall | same |
| Alerts | `ALERT_*` set; staging alerts go to the team channel only (`ALERT_PAGERDUTY_ROUTING_KEY` blank) | critical alerts page |
| Uptime | the external checker watches both hosts (docs/OBSERVABILITY.md, "Uptime checks") | same |
| Data | throwaway: the smoke registers a fresh shop on every run; wipe by recreating the database | real |

Record here, when provisioned: the provider and region, the instance
identifiers, who holds the secrets, the DNS record owner, the date.

## What makes it identical

- **Images**: `IMAGE_REGISTRY`/`IMAGE_TAG` in `.env` name the release; the
  web image carries no environment-specific value (the API URL is
  `API_PUBLIC_URL` at run time, roadmap 9.9), so the digest staging ran is
  the digest production runs.
- **Configuration**: the same `docker-compose.prod.yml`; the differences
  are `.env` values only (hosts, URLs, credentials, sizes). Compare the two
  files with `diff <(sed 's/=.*//' staging/.env | sort) <(sed 's/=.*//' production/.env | sort)`:
  the key sets must be equal.
- **Services**: managed MySQL 8 with `require_secure_transport=ON` and
  `log_bin_trust_function_creators=1`, managed Redis, the edge, the
  monitoring stack (`--profile ops`), the backup agent.
- **Smoke**: `scripts/smoke-remote.sh` runs the same business flow against
  staging that the CI smoke runs against the compose stack.

## Promotion

1. A commit on `main` (or a `v*` tag) triggers the release workflow; it
   pushes `ghcr.io/<owner>/dukaanai-{api,web,db-ops}:sha-<commit>` (and
   `:v<version>`). The CI run of the same commit must be green. A release
   is a `v*` tag: its `certify` job (roadmap 9.12) must be green as well,
   and its evidence bundle (`certification-<tag>`, also attached to the
   tag's draft release) is read before the tag goes anywhere; a red
   certification is not promoted.
2. On the staging host: set `IMAGE_TAG=sha-<commit>` in `.env`, then

   ```
   docker compose -f docker-compose.prod.yml pull
   docker compose -f docker-compose.prod.yml --profile ops run --rm db-ops backup --label pre-<tag>
   docker compose -f docker-compose.prod.yml run --rm migrate
   docker compose -f docker-compose.prod.yml up -d --wait
   ```

3. From any machine: `bash scripts/smoke-remote.sh https://staging-app.<domain> https://staging-api.<domain>`
   (registration, API and web sign-in, stock, shift, a sale, the dashboard,
   a CLEAN reconciliation, HTTP redirected, HSTS, metrics hidden). Then the
   manual checks of the release (`DEPLOYMENT_CHECKLIST.md`, phase 4 and 5)
   on staging.
4. Production: the same three commands with the same `IMAGE_TAG`, then
   `bash scripts/smoke-remote.sh https://app.<domain> https://api.<domain> --probes-only`
   (no shop is registered on production). Record the tag, the date and the
   staging evidence in the release note.
5. Rollback is the previous tag: `IMAGE_TAG=<previous>`, `up -d --wait`
   (`apps/api/prisma/MIGRATIONS.md` for the database side). A release
   candidate with a migration rehearses that rollback on staging before it
   goes to production.

A release (a `v*` tag, roadmap 9.21) follows `RELEASE.md` end to end: the
release commit, the tag, certification, these steps with `IMAGE_TAG=v<version>`,
the rollback rehearsal, production and the checks after it.

An image that was never on staging never goes to production; a change to
`.env` on production is made on staging first.

## Evidence (gate of row 9.9)

| Check | Where | Result |
|---|---|---|
| The addresses above are real and resolve to the edge | `getent hosts`, `scripts/smoke-remote.sh` first step | pending the owner's provisioning |
| `scripts/smoke-remote.sh` passes against staging | the command's `REMOTE SMOKE PASSED` line, kept with the release note | pending |
| The same image digests run on both environments | `docker compose -f docker-compose.prod.yml images` on both hosts | pending |
| The `.env` key sets are equal | the `diff` above | pending |
| The production rate limits hold a shop's traffic on staging (roadmap 9.16) | `LOAD_TARGET=https://<API_HOST> LIMITS_SHOPS=1 LIMITS_FORWARD_FOR=0 node apps/api/load/limits-gate.mjs` from a quiet address: `PASS`, 0 x 429 for the legitimate phase, 429 in the flood; the JSON report kept with the release note (`docs/PRODUCTION_LIMITS.md` §5) | pending (proven on every CI run by the reference compose smoke) |
| A simulated business day on staging (roadmap 9.17) | `apps/api/load/business-day.mjs` with `BUSINESS_DAY_TARGETS=https://<API_HOST>` and the stack's hook commands, plus the browser sessions (`npm run test:business-day` in apps/web); the report's gate all PASS, kept with the release note (`docs/BUSINESS_DAY.md`) | pending (proven on this machine with two API instances, and shortened on every certify run) |
| The failure drills on staging (roadmap 9.18) | `scripts/drills/drill.mjs <drill>` for the six drills with `DRILL_API_URL` / `DRILL_WEB_URL` on the staging edge, `DRILL_PROMETHEUS_URL` / `DRILL_ALERTMANAGER_URL` on its monitoring stack and the `DRILL_HOOK_*` commands of `docs/DRILLS.md` §5; every drill PASS, each run's `.md` recorded in `docs/DRILLS.md` with the page each alert sent to a phone | pending (proven on a production-shaped stack on this machine, and on every certify run against the release images) |
| Pilot readiness on staging (roadmap 9.19) | `scripts/pilot/readiness.mjs --web https://<WEB_HOST> --api https://<API_HOST>` with the pilot owner's credentials ends `READY`; its `--json` report kept with `docs/PILOT.md` | pending (the drill stack, a production image of the commit before 9.19, read NOT READY: no SMTP, no OCR key, no Google meta, an incomplete shop profile, 720 h sessions) |
| The pilot's staging fortnight (roadmap 9.19) | `docs/PILOT.md` §5: every row of the checklist run in the shop on staging with its evidence, defects fixed and re-tested, then the production fortnight and the owner's sign-off (§7) | pending the owner's shop |
| External penetration test (roadmap 9.15) | `docs/security/PENTEST_SCOPE.md`: scope letter signed, test run against staging, every finding closed or accepted with a date | pending the owner's vendor |

Until staging exists, the repository proves the mechanism on every CI run:
`scripts/compose-smoke-prod.sh` brings the production compose file up with
images built from the checkout and no build-time API URL, and the flow
passes over HTTPS with the URL supplied at run time.
