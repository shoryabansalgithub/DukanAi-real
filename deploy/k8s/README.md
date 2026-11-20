# DukaanAI on Kubernetes

The Kubernetes form of the production topology in `docs/DEPLOYMENT.md`
("Production topology"): the same images as `docker-compose.prod.yml`, one
API replica with the documents on a provider disk, the database and Redis
managed outside the cluster, HTTPS at the Ingress. Rendered with kustomize
and validated with kubeconform in CI (job "Deployment (compose smoke)", both
kustomizations below).

Two kustomizations, applied in this order on every release (audit
2026-10-11, P1-16):

1. `deploy/k8s/migrate`: the release step, `prisma migrate deploy` as a Job,
   applied on its own and waited for;
2. `deploy/k8s`: the application.

Both include `common/` (a kustomize Component): the namespace, the
`dukaanai-secrets` Secret and the ONE release tag, so the Job always runs the
API image of the release the application is about to run.

| File | What |
|---|---|
| `common/kustomization.yaml` | the shared Component: namespace, the Secret generated from `common/dukaanai-secrets.env`, and `images:` (set `newTag` here, once, for all three images) |
| `common/namespace.yaml` | namespace `dukaanai` |
| `dukaanai-secrets.env.example` | template for `common/dukaanai-secrets.env` (`DATABASE_URL`, `DB_OPS_DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `NEXTAUTH_SECRET`, integrations); never committed (`.gitignore` here) |
| `migrate/kustomization.yaml` | the release step: `migrate/job-migrate.yaml` and `migrate/networkpolicy.yaml` (the Job reaches DNS and the database only) |
| `kustomization.yaml` | the application |
| `configmap.yaml` | non-secret settings: public origins, `TRUST_PROXY=1`, storage paths, shutdown timings, backup schedule, feature switches |
| `pvc.yaml` | three ReadWriteOnce claims: documents (`STORAGE_ROOT`), uploads (product images, the multipart temp directory), backups |
| `deployment-api.yaml` | the API (1 replica, Recreate, probes, 45 s grace) with the `backup-agent` sidecar (`db-ops backup-loop`) |
| `deployment-web.yaml` | the web (stateless) |
| `services.yaml` | ClusterIP services; `dukaanai-blackhole` has no endpoints and receives `/api/metrics` |
| `ingress.yaml` | ingress-nginx + cert-manager: both hosts over HTTPS, HTTP redirected, body cap 64m, timeouts 60 s; a second Ingress (regex, so case-insensitive) sends `/api/metrics` to the blackhole |
| `networkpolicy.yaml` | ingress: the API accepts the Ingress controller, the web and the monitoring namespace only; egress: DNS, the database, Redis, SMTP and HTTPS (assumptions in the file) |

## Deploy

1. Pick the release: `.github/workflows/release.yml` pushed
   `ghcr.io/<owner>/dukaanai-{api,web,db-ops}:v<version>` for a version tag
   (and `:sha-<commit>` for every main commit), after CI passed for that
   commit. Set `newTag` in `common/kustomization.yaml` to that tag; nothing
   is built for the cluster, and the same tag that passed on staging is what
   production runs (`docs/STAGING.md`; to pin the exact bits, replace
   `newTag` with `digest: sha256:...` from the release job's summary). The
   web image carries no API URL: the ConfigMap's `API_PUBLIC_URL` is read
   at run time. A private package needs an image pull secret in the
   namespace (`kubectl create secret docker-registry ghcr --docker-server=ghcr.io ...`
   and `imagePullSecrets` on the two Deployments and the Job).
2. `cp deploy/k8s/dukaanai-secrets.env.example deploy/k8s/common/dukaanai-secrets.env`
   and fill it in (`.gitignore` keeps it out of the repository). For a
   managed MySQL whose CA is not in the system trust store, add
   `&sslcert=/etc/dukaanai/db-ca.pem` to `DATABASE_URL` and
   `DB_OPS_DATABASE_URL` and create the optional CA Secret, which the
   migration Job, the API and the backup sidecar all mount at
   `/etc/dukaanai/db-ca.pem`:
   `kubectl -n dukaanai create secret generic dukaanai-db-ca --from-file=db-ca.pem=<provider-ca.pem>`.
3. Replace `app.example.com` / `api.example.com` in `configmap.yaml` and
   `ingress.yaml` (both Ingresses), and `letsencrypt` with the cluster's
   ClusterIssuer; point the DNS A/AAAA records of both hosts at the Ingress
   controller.
4. Take the backup of `RELEASE.md` §4 (the agent's own, or the provider's
   snapshot) before a release that carries a migration.

## Release (every time, in this order)

```
# 0. A Job from an earlier release must have FINISHED: never delete a running
#    migration (it would stop in the middle of its DDL and be recorded as failed,
#    apps/api/prisma/MIGRATIONS.md). Empty output or 0 means none is running.
kubectl -n dukaanai get job dukaanai-migrate -o jsonpath='{.status.active}' --ignore-not-found

# 1. The release step alone (a Job is immutable: the old one is removed first).
kubectl -n dukaanai delete job dukaanai-migrate --ignore-not-found --wait
kubectl apply -k deploy/k8s/migrate
kubectl -n dukaanai wait --for=condition=complete --timeout=600s job/dukaanai-migrate
kubectl -n dukaanai logs job/dukaanai-migrate          # each migration applied, or "No pending migrations to apply"

# 2. Only once the Job completed: the application.
kubectl apply -k deploy/k8s
kubectl -n dukaanai rollout status deployment/dukaanai-api deployment/dukaanai-web
```

If the wait in step 1 times out or the Job fails, stop: do not apply the
application. Read the Job's log, settle the migration
(`apps/api/prisma/MIGRATIONS.md`, "A migration recorded as failed") and run
step 1 again. On the very first install step 1 also creates the namespace
and the Secret (they live in `common/`).

The order is what keeps the new API off an old schema: the application
kustomization does not contain the Job, so `kubectl apply -k deploy/k8s`
never starts a migration, and the API Deployment (Recreate) replaces the
old pod as soon as it is applied. Should the order be broken anyway, the new
API refuses to boot (CrashLoopBackOff, the old pod already gone) instead of
serving requests against the old schema: at start it checks that every
migration in its image is recorded as finished in `_prisma_migrations` and
prints the drift message naming the missing ones
(`PrismaService.assertMigrationsApplied`). Run step 1; the pod then starts.

Rollback to the previous release: set `newTag` back and apply only
`deploy/k8s` (step 2). The previous image's migrations are all applied
already, and an API whose database is ahead of its image boots
(`RELEASE.md`, "Rollback").

## Monitoring

Prometheus is the cluster's own, in the `monitoring` namespace (the
NetworkPolicy's scrape rule). It scrapes `dukaanai-api.dukaanai.svc:3002`
on `/api/metrics` with `METRICS_TOKEN` as the bearer token, read from a file
mounted from a Secret, never written into its configuration:

```
kubectl -n monitoring create secret generic dukaanai-metrics-token --from-literal=token="<METRICS_TOKEN>"
```

```yaml
# a scrape job of the cluster's Prometheus (prometheus-operator mounts a
# Secret listed in spec.secrets at /etc/prometheus/secrets/<name>/)
- job_name: dukaanai-api
  metrics_path: /api/metrics
  authorization:
    type: Bearer
    credentials_file: /etc/prometheus/secrets/dukaanai-metrics-token/token
  static_configs:
    - targets: ["dukaanai-api.dukaanai.svc:3002"]
```

Load `deploy/prometheus/alerts.yml` and `deploy/prometheus/topology/production.rules.yml`
(the backup kinds this topology runs: dump, documents, off-site; no
binary-log archive) as rule files; without a topology file
`DukaanAiBackupNeverRecorded` fires as kind `no-topology-rules`. The probe
jobs of `deploy/prometheus/prometheus.yml` (blackbox-http, blackbox-login,
blackbox-tls) take the public URLs as targets.

## What the manifests encode

- **One API replica** (`replicas: 1`, `strategy: Recreate`): the documents
  claim is ReadWriteOnce and the backup sidecar reads it. Scaling the API
  needs object storage behind `StoragePathBuilder` first (roadmap 9.7).
- **Probes and shutdown** per `docs/DEPLOYMENT.md`: startup / liveness on
  `/api/health/live`, readiness on `/api/health/ready`,
  `SHUTDOWN_DRAIN_DELAY_MS=5000` so the endpoint is withdrawn before the
  listener closes, `terminationGracePeriodSeconds: 45` above
  drain + `SHUTDOWN_TIMEOUT_MS`. The web runs with `KEEP_ALIVE_TIMEOUT`
  65000, above ingress-nginx's 60 s upstream keep-alive.
- **Proxy hops**: ingress-nginx sets `X-Forwarded-For` from the connection it
  accepted and ignores a client-supplied value (its default,
  `use-forwarded-headers: false`); the web forwards that header on sign-in.
  `TRUST_PROXY=1`. A cloud load balancer that itself appends to
  `X-Forwarded-For` (proxy protocol off, HTTP mode) is a second hop: set
  `TRUST_PROXY=2` in the ConfigMap, and keep `use-forwarded-headers` on in
  the controller so it preserves the balancer's header.
- **Edge limits**: body 64m (above `UPLOAD_MAX_MEDIA_BYTES` 50 MB), read and
  send timeouts 60 s (above `BILLING_GATEWAY_TIMEOUT_MS` 30 s), HTTPS forced,
  HSTS from the web and the API themselves.
- **`/api/metrics`** does not exist from the internet, in any letter case:
  the `dukaanai-metrics-blackhole` Ingress uses `use-regex`, so ingress-nginx
  matches it as a case-insensitive regular expression (`/API/metrics` too;
  Express routes case-insensitively) and routes it to `dukaanai-blackhole`
  (no endpoints: the controller answers 503). `use-regex` applies to every
  path of the API host, which keeps `/` matching everything else.
- **Backups** (`docs/BACKUP_RESTORE.md`): the `backup-agent` sidecar runs
  `backup-loop` daily: a dump of the managed database with its binary-log
  position (`DB_OPS_DATABASE_URL`: RELOAD + REPLICATION CLIENT, or
  `BACKUP_COORDINATES=skip`; over TLS with the CA at
  `/etc/dukaanai/db-ca.pem`), the documents archive, the encrypted off-site
  copy when `OFFSITE_REMOTE` is set, each success stamped under
  `BACKUP_STATUS_DIR` for `backup_last_success_timestamp_seconds`. Point in
  time is the provider's on a managed MySQL; the dump is the independent
  copy. Snapshot the three claims on the provider's schedule as well.
- **Security context** (audit R25): non-root (uid 1000, the images' `node`
  user; the db-ops image runs as that uid too), no privilege escalation, all
  capabilities dropped, `RuntimeDefault` seccomp, `fsGroup` on the volumes,
  `automountServiceAccountToken: false` (nothing calls the Kubernetes API),
  and a read-only root file system everywhere: each container writes only
  to its volumes and an emptyDir `/tmp` (the web also to an emptyDir
  `.next/cache`; the API's multipart temp directory is on the uploads claim
  so a finished upload is renamed, not copied, into place).
- **Egress** (`networkpolicy.yaml`): DNS to kube-dns, then only the ports
  the services use (3306, 6379/6380, 443, 587/465) to any address. The
  database and Redis are assumed outside the cluster on those ports; narrow
  `0.0.0.0/0` to the providers' ranges once they are known, and add a rule
  for anything else (an http webhook needs port 80).

## Validate

```
cp deploy/k8s/dukaanai-secrets.env.example deploy/k8s/common/dukaanai-secrets.env
kubectl kustomize deploy/k8s | kubeconform -strict -summary -
kubectl kustomize deploy/k8s/migrate | kubeconform -strict -summary -
rm deploy/k8s/common/dukaanai-secrets.env
```
