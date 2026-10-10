# DukaanAI on Kubernetes

The Kubernetes form of the production topology in `docs/DEPLOYMENT.md`
("Production topology"): the same images as `docker-compose.prod.yml`, one
API replica with the documents on a provider disk, the database and Redis
managed outside the cluster, HTTPS at the Ingress. Rendered with kustomize
and validated with kubeconform in CI (job "Deployment (compose smoke)").

| File | What |
|---|---|
| `namespace.yaml` | namespace `dukaanai` |
| `configmap.yaml` | non-secret settings: public origins, `TRUST_PROXY=1`, storage paths, shutdown timings, backup schedule |
| `dukaanai-secrets.env.example` | template for `dukaanai-secrets.env` (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `NEXTAUTH_SECRET`, integrations); the kustomization generates the `dukaanai-secrets` Secret from it |
| `pvc.yaml` | three ReadWriteOnce claims: documents (`STORAGE_ROOT`), uploads (product images, temp), backups |
| `job-migrate.yaml` | the release step `prisma migrate deploy` |
| `deployment-api.yaml` | the API (1 replica, Recreate, probes, 45 s grace) with the `backup-agent` sidecar (`db-ops backup-loop`) |
| `deployment-web.yaml` | the web (stateless) |
| `services.yaml` | ClusterIP services; `dukaanai-blackhole` has no endpoints and receives `/api/metrics` |
| `ingress.yaml` | ingress-nginx + cert-manager: both hosts over HTTPS, HTTP redirected, body cap 64m, timeouts 60 s |
| `networkpolicy.yaml` | the API accepts the Ingress controller, the web and the monitoring namespace only |
| `kustomization.yaml` | ties it together; the `images:` block points at the registry |

## Deploy

1. Pick the release: the workflow `.github/workflows/release.yml` pushed
   `ghcr.io/<owner>/dukaanai-{api,web,db-ops}:sha-<commit>` (and `:v<version>`
   for a tag) for every commit on main. Set `newTag` in `kustomization.yaml`
   to that tag; nothing is built for the cluster, and the same tag that
   passed on staging is what production runs (`docs/STAGING.md`). The web
   image carries no API URL: the ConfigMap's `API_PUBLIC_URL` is read at
   run time. A private package needs an image pull secret in the
   namespace (`kubectl create secret docker-registry ghcr --docker-server=ghcr.io ...`
   and `imagePullSecrets` on the two Deployments and the Job).
2. `cp dukaanai-secrets.env.example dukaanai-secrets.env` and fill it in (`.gitignore` keeps it
   out of the repository). For a managed MySQL whose CA is not in the system
   trust store, add `&sslcert=/etc/dukaanai/db-ca.pem` to `DATABASE_URL` and
   create the optional CA Secret:
   `kubectl -n dukaanai create secret generic dukaanai-db-ca --from-file=db-ca.pem=<provider-ca.pem>`.
3. Replace `app.example.com` / `api.example.com` in `configmap.yaml` and
   `ingress.yaml`, and `letsencrypt` with the cluster's ClusterIssuer; point
   the DNS A/AAAA records of both hosts at the Ingress controller.
4. Release (every time; the Job is immutable, so it is re-created):

   ```
   kubectl apply -k deploy/k8s
   kubectl -n dukaanai delete job dukaanai-migrate --ignore-not-found
   kubectl apply -k deploy/k8s
   kubectl -n dukaanai wait --for=condition=complete --timeout=300s job/dukaanai-migrate
   kubectl -n dukaanai rollout status deployment/dukaanai-api deployment/dukaanai-web
   ```

   The first `apply` creates the namespace, the claims and the Secret; the
   second applies the fresh Job. The API pod starts only after the Job
   completed when the two are applied in that order; an API started against a
   database behind the migrations refuses to boot with the drift message
   (`apps/api/prisma/MIGRATIONS.md`).

## What the manifests encode

- **One API replica** (`replicas: 1`, `strategy: Recreate`): the documents
  claim is ReadWriteOnce and the backup sidecar reads it. Scaling the API
  needs object storage behind `StoragePathBuilder` first (roadmap 9.7).
- **Probes and shutdown** per `docs/DEPLOYMENT.md`: startup / liveness on
  `/api/health/live`, readiness on `/api/health/ready`,
  `SHUTDOWN_DRAIN_DELAY_MS=5000` so the endpoint is withdrawn before the
  listener closes, `terminationGracePeriodSeconds: 45` above
  drain + `SHUTDOWN_TIMEOUT_MS`.
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
- **`/api/metrics`** is routed to `dukaanai-blackhole` (no endpoints: the
  controller answers 503) so the scrape endpoint does not exist from the
  internet; Prometheus in the `monitoring` namespace scrapes
  `dukaanai-api.dukaanai.svc:3002` directly (NetworkPolicy rule) with
  `METRICS_TOKEN` as the bearer token (`deploy/prometheus/prometheus.yml`).
- **Backups** (`docs/BACKUP_RESTORE.md`): the `backup-agent` sidecar runs
  `backup-loop` daily: a dump of the managed database with its binary-log
  position (`DB_OPS_DATABASE_URL`: RELOAD + REPLICATION CLIENT, or
  `BACKUP_COORDINATES=skip`), the documents archive, the encrypted off-site
  copy when `OFFSITE_REMOTE` is set, each success stamped under
  `BACKUP_STATUS_DIR` for `backup_last_success_timestamp_seconds`. Point in
  time is the provider's on a managed MySQL; the dump is the independent
  copy. Snapshot the three claims on the provider's schedule as well.
- **Security context**: non-root (uid 1000, the images' `node` user; the
  db-ops image runs as that uid too), no privilege escalation, all
  capabilities dropped, `RuntimeDefault` seccomp, `fsGroup` on the volumes.

## Validate

```
cp deploy/k8s/dukaanai-secrets.env.example deploy/k8s/dukaanai-secrets.env
kubectl kustomize deploy/k8s | kubeconform -strict -summary -
```
