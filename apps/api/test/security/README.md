# Security regression suite

Every spec here asserts the **secure** behaviour the repository audit found
missing, against the real application (MySQL + Redis, same harness as the
integration suites). The suite runs with `npm run test:integration` (so CI
never skips it) or on its own with `npm run test:security`.

## The `it.failing` convention

A finding that is still open is written with `it.failing(...)`: jest runs the
test and passes only while the assertion **fails**. The moment a later roadmap
phase fixes the behaviour the test starts to pass, jest reports
"Failing test passed even though it was supposed to fail", and the developer
flips `it.failing` to `it` in the same change. Nothing is skipped, CI stays
meaningful, and the list of `it.failing` calls is the live count of open
findings. A test written with plain `it` is a control that proves the harness
exercises the real guard (for example a VIEWER is refused on `POST /products`).

Never delete or skip a failing test to get green. Fix the behaviour and flip it.

## The exploit replay (roadmap 9.13)

`test/certification/exploit-replay.ts` is the black-box sibling of this suite:
it replays the same findings over HTTP against a running deployment (the
certify stack or a staging URL) and asserts each is refused with its
documented status and code. It is not a `.spec.ts`, so jest never runs it;
`npm run certify:exploits` (with `EXPLOIT_TARGET`) runs it on demand, and the
certify driver runs it as the `exploits` step. The in-process suite here is
the source of truth for the assertions; the replay proves they hold on the
wire.

## Against a running image

With `CERTIFY_API_URL=http://host:port` (roadmap 9.12, `scripts/certify`)
every request of these specs goes over HTTP to that API instead of the
in-process server: the booted module only creates the fixtures (shops,
users, tokens through the real `AuthService`) on the same database and with
the same `JWT_SECRET` as the target (`httpTarget` in
`test/integration/pos-fixtures.ts`). The assertions are unchanged, so the
suite certifies the release candidate image with the same findings.

## Coverage

| Spec | Audit finding | Roadmap phase |
|---|---|---|
| `authorization.security-spec.ts` | P0-1 shop profile mass assignment (role escalation, cross-shop `connect`) | 1 |
| `authorization.security-spec.ts` | P0-2 writes without a role check (stock adjustment, reservation lock) | 1 |
| `authorization.security-spec.ts` | P0-3 cross-shop batch stock, vendor bill supplier, revision compare | 1 |
| `money.security-spec.ts` | P1-1 partial returns refund more than the sale | 3.1 (fixed: cumulative return math, refunds capped at the sale) |
| `money.security-spec.ts` | P1-2 ledger running balance overflows at 10 crore | 3.2 (fixed: balanceAfter DECIMAL(18,2)) |
| `authentication.security-spec.ts` | P1-4 lockout revokes sessions already open | 2.2 (fixed) |
| `authentication.security-spec.ts` | P1-5 placeholder JWT secret accepted | 2.3 (fixed) |
| `authentication.security-spec.ts` | P1-6 auth bypass reachable without `NODE_ENV` | 2.4 (fixed) |
| `authentication.security-spec.ts` | P1-7 suspend/delete responses carried the password hash | 2.7 (fixed) |
| `authentication.security-spec.ts` | P2-10 long User-Agent breaks login | 2.7 (fixed) |
| `../integration/sessions.integration-spec.ts` | P2-13/P2-14 refresh rotation without reuse detection, no logout, access tokens outliving the session | 2.6 (fixed) |
| `../integration/invitations.integration-spec.ts` | P1-8 a MANAGER could invite an ADMIN and the token was returned to the caller | 2.8 (fixed) |
| `../integration/infrastructure.integration-spec.ts` | P2-17 the `/inventory` WebSocket namespace accepted unauthenticated connections; correlation ids were echoed raw | 2.13, 2.14 (fixed) |
| `authentication.security-spec.ts` | P1-9 uploads buffered without a size limit | 5.1 (fixed: hard multer limits, declared-type filter and magic-byte check on every upload route; media and imports stream to disk, storage and OCR keep capped memory storage) |
| `../integration/rate-limit.integration-spec.ts` | P1-3 rate limiting off (second/millisecond mix-up, no auth limits), P2-16 trust proxy | 2.1 (fixed) |
| `../integration/password-policy.integration-spec.ts`, `../integration/asvs-controls.integration-spec.ts` | ASVS L2 opens (`docs/security/ASVS_L2.md`): 8-character passwords, no common-password check, no change-password route, no change notification, refused access not logged, answers cacheable | 9.15 (fixed: 12-character policy with a denylist on every password route, `POST /auth/change-password`, email on reset/change, `RolesGuard` warning, `Cache-Control: no-store`) |
