# OWASP ASVS 4.0.3 Level 2 review (roadmap 9.15)

Scope: the DukaanAI API (`apps/api`, NestJS), the web application
(`apps/web`, Next.js), the deployment forms (`docker-compose.yml`,
`docker-compose.prod.yml`, `deploy/k8s`, the Caddy edge) and the operating
procedures in `docs/`. Reviewed against the code on the branch of this
document on 2026-10-06; staging is reviewed with the same table once the
owner provisions it (`docs/STAGING.md`) and the external test (§16) runs
there.

Status values: **Met** (control in place, evidence named), **N/A** (not
applicable, reason given), **Fixed** (open at the start of the review,
closed by the change that carries this document), **Owner** (a decision or
an action only the owner can take; listed in §15 with the recommendation).
There are no Open controls. Level 1 requirements are included because Level
2 contains them; Level 3-only requirements are not listed.

Conventions: `CLAUDE.md` is the index of mechanisms; `test/security`
(`npm run test:security`) and `test/certification/exploit-replay.ts`
(roadmap 9.13) are the regression suites that keep the audit findings
closed; `test/integration/route-walker.integration-spec.ts` walks every
route as four identities.

## V1 Architecture, design and threat modelling

| Req | Requirement | Status | Evidence |
|---|---|---|---|
| 1.1.1 | Secure development lifecycle | Met | Roadmap phases with an exit gate each; CI gates (lint, unit, integration, security suite, compose smoke, gitleaks, npm audit, Trivy); `test/security/README.md` convention. |
| 1.1.2 | Threat modelling for design changes | Met | `docs/audits/*` (six audit passes), `docs/DATA_SAFETY.md`, this review; `docs/POS_BILLING_CONTRACT.md` records trust decisions per route. |
| 1.1.3 | Functional security constraints in user stories | Met | Contract §2 (authority), §4 (cancellation window), separation of duties (`CLAUDE.md`, Authorization policy). |
| 1.1.4 | Trust boundaries documented | Met | `docs/architecture/environment-architecture.md`, `docs/DEPLOYMENT.md` "Production topology" (edge, API, web, managed DB/Redis). |
| 1.1.5 | High-level architecture and remote services | Met | Same documents; the only outbound calls are SMTP, Gemini (OCR) and customer webhooks (SSRF-guarded). |
| 1.1.6 | Centralised, simple, vetted security controls | Met | `APP_GUARD`s (`JwtAuthGuard`, `TenantGuard`, `RolesGuard`), global `ValidationPipe`, the Prisma tenant extension, `assertOwned`, `OutboundUrlGuard`, `StoragePathBuilder`. |
| 1.1.7 | Secure coding checklist available | Met | `CLAUDE.md` / `AGENTS.md` sharp-edge rules (every `@Body()` a DTO, never spread a body into Prisma, every FK through `assertOwned`, one stock writer, one money engine). |
| 1.2.1 | Low-privilege OS/DB accounts | Met | Images run as `node`; compose/prod use a dedicated DB user; ledger triggers refuse UPDATE/DELETE even to that user (`20260929090200`, `20261003090100`). |
| 1.2.2 | Inter-component authentication | Met | Web -> API with the user's bearer token; `API_INTERNAL_URL` inside the network; metrics behind `METRICS_TOKEN`; DB over TLS with `sslaccept=strict`. |
| 1.2.3 | Single vetted authentication mechanism | Met | `AuthService` (password or Google id-token), one `JwtStrategy`, same tokens for sockets (`AuthenticatedIoAdapter`). |
| 1.2.4 | Consistent authentication pathways | Met | Every route behind the global guards unless `@Public()`; `RouteAuthorizationAssertion` refuses to boot otherwise. |
| 1.4.1 | Trusted enforcement points | Met | Guards and the tenant extension run server-side; the web's role gates are convenience only (`components/customers/permissions.ts`). |
| 1.4.4 | Single access-control mechanism | Met | `RolesGuard` + `@Roles` sets (`src/auth/role-sets.ts`); tenant scope derived from the schema (`src/prisma/tenant-scope.ts`). |
| 1.4.5 | Attribute/feature-based access control | Met | Role + shop + ownership (`assertOwned`) + document state machines. |
| 1.5.1 | Input and output requirements defined | Met | DTO per body (`route-authorization.spec.ts` rejects `any`), contract per route. |
| 1.5.2 | Serialization not sent to untrusted clients | Met | JSON only; `SafeUserDto`; no serialized objects. |
| 1.5.3 | Input validation on a trusted service layer | Met | Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`). |
| 1.5.4 | Output encoding near the interpreter | Met | React escapes; SQL through Prisma; `$queryRaw` tagged templates (the two `$executeRawUnsafe` calls are constant strings, `auth-bypass.service.ts`). |
| 1.6.1 | Key management policy | Met | `docs/SECRETS.md` (register, owners, rotation procedures and log). |
| 1.6.2 | Key holders protected | Met | Secrets from the environment / Kubernetes Secret only; `credential-register.spec.ts` keeps the register complete. |
| 1.6.3 | Keys replaceable | Met | Rotation procedures incl. `sessions:revoke-all` (proven by `credential-rotation.integration-spec.ts`). |
| 1.6.4 | Client-side secrets avoided | Met | No secret in the web bundle (`NEXT_PUBLIC_*` are URLs and flags); Google client secret server-side only. |
| 1.7.1 | Common logging format | Met | One JSON line per entry (`CorrelationLogger`), access line per answer. |
| 1.7.2 | Logs securely transmitted | Met | Alloy -> Loki on the internal network; filesystem retention 31 d. |
| 1.8.1 | Sensitive data identified and classified | Met | `docs/DATA_SAFETY.md` data inventory. |
| 1.8.2 | Protection levels per classification | Met | Same document (encryption at rest by the provider, off-site copies encrypted, retention sweep). |
| 1.9.1 | Encrypted connections between components | Met | DB `sslaccept=strict`, `rediss://` supported, SMTP by URL scheme, HTTPS at the edge. |
| 1.9.2 | Component authentication | Met | DB credentials + CA, Redis password in URL, metrics token. |
| 1.10.1 | Source control with change tracking | Met | GitHub, protected main through PRs, SHA-pinned actions. |
| 1.11.1 | Application components documented | Met | `docs/architecture/*`, `TECH_STACK_ARCHITECTURE.md`. |
| 1.11.2 | No unsynchronised state in sensitive flows | Met | Checkout, returns, shifts, payables, sequences all in one transaction under canonical row locks; idempotency keys. |
| 1.12.2 | Uploaded files not served from the same origin as executable content | Met | Media is served through the API's own route after magic-byte checks, never as HTML; SVG refused; `X-Content-Type-Options: nosniff`. |
| 1.14.1 | Segregation of components (network) | Met | Compose internal network; `deploy/k8s` NetworkPolicies; the edge is the only published port. |
| 1.14.2 | Binary signatures / integrity of deployments | Met | Images by tag from the registry, SBOM and Trivy gate (9.14), `IMAGE_TAG` promotion (9.9). |
| 1.14.3 | Build pipeline warns on outdated or insecure components | Met | Dependabot (actions + npm), `npm audit --audit-level=high` in CI, Trivy control. |
| 1.14.4 | Deployment pipeline automated and repeatable | Met | `release.yml` builds, scans and certifies; `certify.sh` bundle. |
| 1.14.5 | Sandboxing of untrusted components | Met | Uploads sniffed and size-capped; no plugin or script execution; OCR input is an image sent to an external model. |
| 1.14.6 | No unsupported client-side technologies | Met | React only. |

## V2 Authentication

| Req | Requirement | Status | Evidence |
|---|---|---|---|
| 2.1.1 | Passwords at least 12 characters | **Fixed** | `MIN_PASSWORD_LENGTH = 12` (`src/auth/password-policy.ts`), `@IsAcceptablePassword()` on registration, invitation accept, reset and change; web forms updated to match. Was 8. |
| 2.1.2 | At least 64 characters allowed | Met | Up to 72 (bcrypt's input bound; longer input would be silently truncated, so it is refused instead). |
| 2.1.3 | No silent truncation | Met | Same bound, refused with a reason. |
| 2.1.4 | Any printable Unicode accepted | Met | No character rule; runs of spaces collapse before the length check only. |
| 2.1.5 | Users can change their password | **Fixed** | `POST /auth/change-password` (`ChangePasswordDto`, `PasswordResetService.change`): proves the current password, applies the policy, bumps `tokenVersion`, revokes refresh tokens, disconnects sockets, emails the account. `password-policy.integration-spec.ts`. Was missing. |
| 2.1.6 | Change requires the current password | Met | Same route (`PASSWORD_CURRENT_INVALID`). |
| 2.1.7 | Breached / common passwords refused | **Fixed** | Local denylist of common passwords that survive the 12-character floor plus the shapes the public lists are made of (keyboard walks, digit runs, a base word padded); `password-policy.spec.ts`. |
| 2.1.8 | Password strength meter | Owner | Not in the UI (an input-only form; the API returns the policy reason). See §15. |
| 2.1.9 | No composition rules | Met | None. |
| 2.1.10 | No periodic rotation / history | Met | None; rotation on compromise (`docs/SECRETS.md`). |
| 2.1.11 | Paste and password managers allowed | Met | Plain `<input type="password">`, no paste blocking. |
| 2.1.12 | User can view the password temporarily | Owner | The login, register, reset and change forms are plain `type="password"` inputs with no show/hide toggle; adding one is a UI change the owner approves (§15). Browser password managers and the confirm field on reset mitigate mistyping. |
| 2.2.1 | Anti-automation on credential routes | Met | `@AuthThrottle()` limits (5 / 10 s, 20 / min, 100 / h per address; 10 / min per account) and the account lock (`SECURITY_MAX_LOGIN_ATTEMPTS`); `docs/PRODUCTION_LIMITS.md`; `rate-limit.integration-spec.ts`; exploit replay `brute-force-login`. |
| 2.2.2 | Weak authenticators restricted | N/A | Password or Google id-token only; no SMS/email OTP. |
| 2.2.3 | Notification on credential change | **Fixed** | `PasswordResetService.notifyPasswordChanged` emails the account after a reset and after a change (reset was silent). |
| 2.2.4 | Impersonation resistance (L3) | — | not in scope. |
| 2.2.5 | Mutually authenticated TLS to the CSP (L3) | — | not in scope. |
| 2.3.1 | Initial passwords random / changed | Met | No initial passwords: an invitee sets their own under the policy (`AcceptInvitationDto`); registration is self-set. |
| 2.3.2 | Enrolment of user-provided authenticators | N/A | No second factor. |
| 2.3.3 | Renewal instructions (L2) | N/A | No expiring authenticators. |
| 2.4.1 | Approved password hashing | Met | bcrypt (`BCRYPT_ROUNDS` 10 in production; bounded 4..31). |
| 2.4.2 | Salt at least 32 bits | Met | bcrypt's 128-bit salt. |
| 2.4.3 | PBKDF2 parameters | N/A | bcrypt. |
| 2.4.4 | bcrypt work factor | **Fixed** | Invitations hashed with the library default instead of `BCRYPT_ROUNDS`; now `InvitationsService` reads `SecurityConfig.bcryptRounds` like registration and reset. |
| 2.4.5 | Additional secret (pepper) | N/A | Not used; L2 marks it as optional hardening. |
| 2.5.1 | Recovery secrets not sent in clear | Met | Reset token is random, hashed at rest (`PasswordResetToken`), sent once in the email link, single use, one hour. |
| 2.5.2 | No password hints or knowledge-based answers | Met | None. |
| 2.5.3 | Recovery does not reveal the password | Met | A new one is set. |
| 2.5.4 | No shared or default accounts | Met | `AUTH_DISABLED`'s system user exists only under `NODE_ENV=development|test`; production boot refuses the flag. |
| 2.5.5 | Notification on authenticator change | **Fixed** | See 2.2.3. |
| 2.5.6 | Forgotten-password uses a secure recovery mechanism | Met | Time-bound, single-use, hashed token; the same message for known and unknown addresses; Google-only accounts never receive a link. |
| 2.5.7 | Recovery for lost OTP/hardware factors | N/A | No second factor. |
| 2.6.x | Look-up secrets | N/A | None. |
| 2.7.x | Out-of-band verifiers | N/A | None. |
| 2.8.x | One-time verifiers | N/A | None. |
| 2.9.x | Cryptographic verifiers | N/A | None. |
| 2.10.1 | Service accounts without default credentials | Met | DB/Redis/SMTP credentials from the environment; boot refuses placeholders (`IsProductionSecret`). |
| 2.10.2 | Service passwords generated, long | Met | `openssl rand` per `docs/SECRETS.md`; compose `:?` refuses unset secrets. |
| 2.10.3 | Passwords not in source | Met | gitleaks over the tree and the history in CI; templates hold placeholders only. |
| 2.10.4 | Secrets from a secret store / env | Met | Env / Kubernetes Secret; never a config file in the image. |

## V3 Session management

| Req | Requirement | Status | Evidence |
|---|---|---|---|
| 3.1.1 | No session token in URL | Met | Bearer header (API), `httpOnly` cookie (web); the reset token is a one-time credential, not a session. |
| 3.2.1 | New session token on authentication | Met | Each login opens a refresh-token family with a fresh id (`sid` in the access token). |
| 3.2.2 | Tokens at least 64 bits of entropy | Met | Refresh token 32 random bytes; family id UUID v4; JWT HS256 over a 32+ character secret. |
| 3.2.3 | Tokens stored securely in the browser | Met | NextAuth `httpOnly`, `Secure` (production), `SameSite=Lax` cookie; the API tokens live in the server-side session JWT, never in `localStorage`. |
| 3.2.4 | Tokens generated with approved algorithms | Met | `crypto.randomBytes` / `randomUUID`. |
| 3.3.1 | Logout invalidates the session | Met | `POST /auth/logout` revokes the family; access tokens carry `sid` and are refused once the family is gone (`sessions.integration-spec.ts`). The web's sign-out calls it first (`signOutEverywhere`). |
| 3.3.2 | Re-authentication after 12 h / 30 min idle (L2) | **Fixed** | `SESSION_ABSOLUTE_LIFETIME=12h` in `.env.production` (was 30 d); the web's session fails to refresh past it and the middleware bounces to login. Idle: a refresh token lives `JWT_REFRESH_EXPIRES_IN` (7 d) but can never outlive the 12-hour family. |
| 3.3.3 | Terminate all sessions on password change | Met | `tokenVersion` bump + family revocation + socket disconnect on reset and change. |
| 3.3.4 | Users can view and log out other sessions | Met | `GET /auth/sessions`, `DELETE /auth/sessions/:id` and the Settings "Account & Security" panel. |
| 3.4.1 | `Secure` cookie attribute | Met | NextAuth sets it on HTTPS origins (`__Secure-` prefix). |
| 3.4.2 | `HttpOnly` | Met | NextAuth default. |
| 3.4.3 | `SameSite` | Met | `Lax` (NextAuth default). |
| 3.4.4 | `__Host-` prefix | Met | NextAuth's CSRF cookie is `__Host-next-auth.csrf-token` in production; the session cookie uses `__Secure-` (the Next.js cookie path is `/`, the host is the web origin). |
| 3.4.5 | Cookie path | Met | `/` on the web origin only. |
| 3.5.1 | Users can revoke OAuth tokens | N/A | The Google id-token is verified once at sign-in and not stored. |
| 3.5.2 | Stateless tokens replaced where revocation is needed | Met | Access tokens are short (15 min) and checked against the live family on every request, so revocation is immediate. |
| 3.5.3 | Stateless tokens signed with a vetted algorithm | Met | HS256 pinned in `JwtModule`, `JwtStrategy` and the socket adapter; `alg: none` refused (exploit replay `forged-jwt`). |
| 3.7.1 | Full, valid login session for sensitive operations | Met | Change-password proves the current password; session end-points need the live family. |

## V4 Access control

| Req | Requirement | Status | Evidence |
|---|---|---|---|
| 4.1.1 | Access control enforced on a trusted layer | Met | Guards + tenant extension server-side. |
| 4.1.2 | Attributes not manipulable by users | Met | Role and shop come from the user row, never from the request; `data.shopId` changes refused by the extension. |
| 4.1.3 | Least privilege | Met | `@Roles` sets per route, deny-by-default writes, reads narrowed where needed. |
| 4.1.5 | Fail securely | Met | Exceptions answer 401/403/404; a missing tenant context throws. |
| 4.2.1 | No IDOR | Met | Every tenant query is narrowed to the shop; body foreign keys through `assertOwned`; `tenant-isolation.integration-spec.ts`, route walker (no 2xx for a foreign id). |
| 4.2.2 | CSRF protection | Met | API: bearer token, no cookie auth, JSON bodies, CORS allow-list. Web: NextAuth CSRF token on sign-in/sign-out, `SameSite=Lax`, `form-action 'self'`. |
| 4.3.1 | Admin interfaces behind MFA | Owner | No separate admin interface exists; `SUPER_ADMIN` routes are `@Roles(SUPER_ADMIN)` on the same API; Swagger is off in production. MFA is not implemented (§15). |
| 4.3.2 | Directory browsing disabled | Met | No static file serving from the API; the web serves Next's own assets only. |
| 4.3.3 | Additional authorization for lower-value apps (L2) | Met | Step-up by role: discount / custom-line / credit-limit / cancellation / approvals need MANAGER+ (contract §2, §4; separation of duties). |

## V5 Validation, sanitisation and encoding

| Req | Requirement | Status | Evidence |
|---|---|---|---|
| 5.1.1 | HTTP parameter pollution | Met | `clampSearchQuery` reads an array as its first string; DTOs reject unknown fields. |
| 5.1.2 | Mass assignment | Met | `whitelist` + `forbidNonWhitelisted`; services pick the columns they write (`UpdateShopProfileDto`, `pickDraftFields`). |
| 5.1.3 | Positive validation | Met | class-validator DTOs on every body; enums from Prisma; bounds on money (`ledger-overflow` exploit). |
| 5.1.4 | Structured data validated | Met | Same; procurement line validation; variant matrix bounds. |
| 5.1.5 | URL redirects to an allow-list | Met | `sanitizeCallbackUrl` (web), `WEBHOOK_URL_*` guard (API); exploit replay `open-redirect`. |
| 5.2.1 | HTML sanitisation | N/A | No rich-text input is rendered as HTML; React escapes text. |
| 5.2.2 | Unstructured data length limits | Met | `MaxLength` on every text field (name 100, notes 1000, ...), `OutboxEvent.error` capped, search query 100. |
| 5.2.3 | Mail injection | Met | Fixed templates; recipient from the user row; subject not user-controlled. |
| 5.2.4 | No eval / dynamic code | Met | None (`'unsafe-eval'` only in the dev CSP for React Refresh). |
| 5.2.5 | Template injection | Met | No server-side templates with user input. |
| 5.2.6 | SSRF | Met | `OutboundUrlGuard`: scheme, credentials, private/loopback/link-local/CGNAT/mapped ranges, DNS pinned at connect time; exploit replay `ssrf-webhook`. |
| 5.2.7 | SVG sanitised or refused | Met | SVG is not an accepted media type. |
| 5.2.8 | Markdown / templating input | N/A | None. |
| 5.3.1 | Context-aware output encoding | Met | React; JSON responses with the correct content type. |
| 5.3.2 | Character set | Met | UTF-8 everywhere; CSV/JSON imports must be valid UTF-8 without control bytes. |
| 5.3.3 | Context-aware escaping (XSS) | Met | React + CSP with a per-request nonce and `'strict-dynamic'`. |
| 5.3.4 | Parameterised queries | Met | Prisma; raw SQL through tagged `$queryRaw` with parameters (`sql-clock.spec.ts` scans raw SQL). |
| 5.3.5 | No string concatenation into queries | Met | Same; the LIKE prefix in the category move is escaped. |
| 5.3.6 | JSON injection / eval | Met | `JSON.parse` only. |
| 5.3.7 | LDAP injection | N/A | No LDAP. |
| 5.3.8 | OS command injection | Met | No shell execution from request data. |
| 5.3.9 | Local/remote file inclusion | Met | `StoragePathBuilder.isContained`; no include of user paths. |
| 5.3.10 | XPath / XML injection | N/A | No XML. |
| 5.4.x | Memory safety | N/A | Managed runtime (Node). |
| 5.5.1 | No insecure deserialization | Met | JSON only. |
| 5.5.2 | XML parsers hardened | N/A | No XML. |
| 5.5.3 | Deserialization of untrusted data | Met | JSON into validated DTOs; job payloads are the API's own. |
| 5.5.4 | JSON parsing safe | Met | `JSON.parse`; body size limit 100 kB (Express default); uploads through multer with hard limits. |

## V6 Stored cryptography

| Req | Requirement | Status | Evidence |
|---|---|---|---|
| 6.1.1 | PII encrypted at rest | Met | Provider disk encryption (`docs/DATA_SAFETY.md`, provider steps), off-site copies under rclone crypt. |
| 6.1.2 | Health data | N/A | None. |
| 6.1.3 | Financial data | Met | Same as 6.1.1; ledger rows immutable. |
| 6.2.1 | Crypto modules fail securely | Met | A JWT or HMAC failure is a refusal, never a bypass. |
| 6.2.2 | Approved algorithms only | Met | bcrypt, SHA-256 (token hashes), HMAC-SHA256 (webhooks), HS256 (JWT), TLS by the platform. |
| 6.2.3 | Approved modes and padding | N/A | No symmetric encryption in the application (rclone crypt: XSalsa20-Poly1305, vetted). |
| 6.2.4 | Algorithms configurable | Met | Rounds via `BCRYPT_ROUNDS`; the JWT algorithm is pinned on purpose (algorithm confusion). |
| 6.2.5 | Insecure modes not used | Met | None of ECB/MD5/SHA-1/RC4 in the application. |
| 6.2.6 | Nonces / IVs not reused | Met | Webhook signatures carry a timestamp; per-delivery ids. |
| 6.3.1 | CSPRNG | Met | `crypto.randomBytes`, `randomUUID`; `src/lib/uuid.ts` on the web. |
| 6.3.2 | GUIDs from a CSPRNG (v4) | Met | Same. |
| 6.4.1 | Secrets management solution | Met | Environment / Kubernetes Secret, register in `docs/SECRETS.md`. |
| 6.4.2 | Key material not exposed to the application unnecessarily | Met | DB CA file read-only; secrets never logged (redaction). |

## V7 Error handling and logging

| Req | Requirement | Status | Evidence |
|---|---|---|---|
| 7.1.1 | No credentials or payment details in logs | Met | `CorrelationLogger.redact` (password, token, secret, authorization, ...), `correlation.logger.spec.ts`. |
| 7.1.2 | No other sensitive data in logs | Met | Access line = method, route, status, ip, user id, correlation id; Sentry with request data collection off. |
| 7.1.3 | Security-relevant events logged | **Fixed** | Login outcomes (`AuthService.validateUser`), refused role checks (`RolesGuard`), tenant refusals, password change/reset, session revocation, unhandled errors, every 401/403/429 in the access log. |
| 7.1.4 | Logs carry what is needed for investigation | **Fixed** | Correlation id on every line; the access line now carries the signed-in user id. |
| 7.2.1 | Authentication decisions logged | **Fixed** | `validateUser` logs success and each refusal reason (unknown account, no password, deleted, suspended, locked, wrong password) without the password. |
| 7.2.2 | Access-control decisions logged | **Fixed** | `RolesGuard` warns with user, role, handler and the required roles; `roles.guard.spec.ts`, `asvs-controls.integration-spec.ts`. |
| 7.3.1 | Log injection prevented | Met | JSON lines: values are encoded, never concatenated into the format. |
| 7.3.3 | Logs protected from unauthorised access | Met | Loki on the internal network; Grafana behind its login, dashboards read-only. |
| 7.3.4 | Synchronised time source | Met | Application clock in UTC (`Clock`, roadmap 9.6); hosts on NTP (provider). |
| 7.4.1 | Generic error messages | Met | `GlobalExceptionFilter` answers `code` + message, never a stack; Prisma errors mapped to `DB_P2xxx`. |
| 7.4.2 | Exception handling everywhere | Met | Global filter; `bootstrap().catch`; `app/error.tsx`, `global-error.tsx`. |
| 7.4.3 | Last-resort handler | Met | Same; unhandled errors tracked (`errors_tracked_total`, `DukaanAiUnhandledErrors`). |

## V8 Data protection

| Req | Requirement | Status | Evidence |
|---|---|---|---|
| 8.1.1 | No sensitive data cached in server components | Met | Redis caches dashboard aggregates per shop (no credentials); throttle counters; nothing personal beyond ids. |
| 8.1.2 | Temporary files removed | Met | `UploadCleanupInterceptor` and `finally` unlinks (roadmap 5.1). |
| 8.1.3 | Minimal parameters in requests | Met | DTOs; `forbidNonWhitelisted`. |
| 8.1.4 | Abnormal numbers of requests detected | **Fixed** | Rate limits per address and account; `DukaanAiCredentialFlood` alert on sustained 429s on the credential routes (promtool-tested); `DukaanAiHigh5xxRate`. |
| 8.1.5 | Backups encrypted and tested (L2) | Met | Off-site copies encrypted, restore drills in CI and recorded (`docs/BACKUP_RESTORE.md`). |
| 8.1.6 | Backups stored securely (L2) | Met | Dedicated volume + off-site bucket; retention per `docs/DATA_SAFETY.md`. |
| 8.2.1 | Anti-caching headers | **Fixed** | `NoStoreMiddleware`: `Cache-Control: no-store` on every API answer (`asvs-controls.integration-spec.ts`); the web's pages are dynamic (`force-dynamic`) and served with the Next defaults for dynamic content. |
| 8.2.2 | Browser storage holds no sensitive data | Met | `localStorage`: the POS cart (products, quantities, the chosen customer's name) and the sidebar state; no tokens, no card data. `sessionStorage`: a captured bill image handed from Smart Capture to the AI scanner, removed as soon as the scanner reads it (`ai-scanner/page.tsx`), tab-scoped. |
| 8.2.3 | Authenticated data cleared on logout | Met | The session cookie is removed and the API family revoked; the held cart stays by design (it is the shop's working cart, scoped per shop id, see 8.2.2). |
| 8.3.1 | Sensitive data in body/headers, not query strings | Met | Credentials and tokens are posted in JSON bodies. The reset link carries its one-time token in the page URL by necessity (an email link); the page posts it in the body, the token is single use and hashed at rest, `Referrer-Policy: strict-origin-when-cross-origin`. |
| 8.3.2 | Users can export or remove their data | Owner | Shop data: products/customers exports (`import-export`), customers and employees deletable by the shop's admins; an owner's account and shop are removed by the operator on request (no self-service route). See §15. |
| 8.3.3 | Clear privacy language | Owner | The product is used by a shop's own staff under the owner; no public terms page exists. See §15. |
| 8.3.4 | Sensitive data identified and protected | Met | `docs/DATA_SAFETY.md`; this table. |
| 8.3.5 | Access to sensitive data audited (L2) | Met | Access log line per request with user id, route and correlation id; AuditLog rows for credit-limit changes; ledger immutability. |
| 8.3.6 | Sensitive data purged from memory (L2) | N/A | Managed runtime. |
| 8.3.7 | Sensitive data encrypted at rest (L2) | Met | See 6.1.1. |
| 8.3.8 | Retention policy (L2) | Met | `RetentionSweepService` (tokens, DONE outbox rows, search history, event logs), `docs/DATA_SAFETY.md`. |

## V9 Communication

| Req | Requirement | Status | Evidence |
|---|---|---|---|
| 9.1.1 | TLS for all client connectivity | Met | Caddy edge / Ingress with HSTS, HTTP -> HTTPS 308. |
| 9.1.2 | Strong TLS configuration | Met | Caddy defaults (TLS 1.2+, modern ciphers), tested by the blackbox probe and `DukaanAiCertificateExpiring`. |
| 9.1.3 | Latest TLS versions preferred | Met | Same. |
| 9.2.1 | Server-to-server TLS (L2) | Met | DB `sslaccept=strict` (+ CA), Redis `rediss://` where the provider offers it, SMTP by URL scheme, Gemini over HTTPS. |
| 9.2.2 | Encrypted internal connections (L2) | Met | External services over TLS; same-host compose traffic stays on the private bridge; Kubernetes NetworkPolicies limit who may talk to the API. |
| 9.2.3 | Backend TLS verified (L2) | Met | `sslaccept=strict`; boot fails if the certificate does not verify. |
| 9.2.4 | Revocation checking (L2) | Met | Caddy performs OCSP stapling for served certificates; backend certificates are the provider's (short-lived, rotated by the provider). |
| 9.2.5 | Backend TLS failures logged (L2) | Met | Boot refusal written to stderr; readiness 503 with the failing check. |

## V10 Malicious code

| Req | Requirement | Status | Evidence |
|---|---|---|---|
| 10.1.1 | Code analysis tool in use (L2) | Met | ESLint (typed rules), Trivy (images + `trivy fs`), gitleaks, `npm audit`, Dependabot. |
| 10.2.1 | No unauthorised data collection | Met | Sentry with request data off; no analytics beacons; blackbox probes are the operator's. |
| 10.2.2 | No excessive permissions | Met | `Permissions-Policy` limits the web to the camera (Smart Capture). |
| 10.3.1 | Auto-update integrity | Met | No auto-update in the application; images are promoted by tag after certification. |
| 10.3.2 | Subresource integrity | Met | No third-party scripts: CSP `script-src` is the nonce + `'strict-dynamic'`; fonts and styles from self. |
| 10.3.3 | Subdomain takeover | Owner | DNS is the owner's; keep no dangling records (§15, operations). |

## V11 Business logic

| Req | Requirement | Status | Evidence |
|---|---|---|---|
| 11.1.1 | Steps processed in order | Met | Purchase/receipt/bill/return state machines (`*LifecycleService`), stock-count approvals, shift open/close token. |
| 11.1.2 | Realistic human timing | N/A | A POS terminal is operated by staff; rate limits bound automation. |
| 11.1.3 | Limits per user/action | Met | Discount and custom-line authority, credit limits, over-receipt / over-return / over-refund refusals (`RETURN_QTY_EXCEEDS`), reservation expiry. |
| 11.1.4 | Anti-automation | Met | Rate limits (`docs/PRODUCTION_LIMITS.md`), search-history budget, upload caps. |
| 11.1.5 | Business logic limits | Met | Contract §2-§5; money bounds; one open shift per cashier (`openToken`). |
| 11.1.6 | TOCTOU / race conditions | Met | Canonical lock order, serialization retry, idempotency keys, compare-and-set transitions, `pos-concurrency` suite. |
| 11.1.7 | Monitoring for unusual events (L2) | Met | Reconciliation drift alert, 5xx and unhandled-error alerts, queue/outbox alerts. |
| 11.1.8 | Alerting on automated attacks (L2) | **Fixed** | `DukaanAiCredentialFlood` (sustained 429s on the credential routes). |

## V12 Files and resources

| Req | Requirement | Status | Evidence |
|---|---|---|---|
| 12.1.1 | Large files refused | Met | multer hard limits from `UploadConfig`; 413 before the body is stored; `upload-limits.integration-spec.ts`, `upload-gate.sh`. |
| 12.1.2 | Compressed files checked (L2) | N/A | No archive upload is extracted; backups are produced, never ingested. |
| 12.1.3 | Per-user file quota (L2) | Owner | Per-file caps, rate limits and disk alerts bound the fill rate; no per-shop quota. See §15. |
| 12.2.1 | File type by content | Met | Magic bytes (`file-signature.ts`), CSV/JSON must be valid UTF-8. |
| 12.3.1 | Path traversal in file names | Met | Random temp names; `StoragePathBuilder.isContained`. |
| 12.3.2 | Direct file retrieval guarded | Met | Routes read by id within the shop (`assertOwned`), never by path. |
| 12.3.3 | No LFI/RFI | Met | See 5.3.9. |
| 12.3.4 | No RFI/SSRF through file names | Met | See 5.2.6. |
| 12.3.5 | OS command injection via file names | Met | No shell. |
| 12.3.6 | Untrusted sources not included | Met | No remote includes. |
| 12.4.1 | Files outside the web root, limited permissions | Met | `STORAGE_ROOT` on a data volume, served through routes only; image runs as `node`. |
| 12.4.2 | Malware scanning of uploads | Owner | Not performed; uploads are images, CSV/JSON and PDFs that the application never executes or renders inline as HTML. See §15. |
| 12.5.1 | Only approved extensions served | Met | Media routes answer the stored, sniffed type. |
| 12.5.2 | Uploads not executed | Met | Same; `nosniff`. |
| 12.6.1 | SSRF allow-list | Met | See 5.2.6 (deny-list of private ranges plus https-only, DNS pinning). |

## V13 API and web services

| Req | Requirement | Status | Evidence |
|---|---|---|---|
| 13.1.1 | Same encoding/parsers across components | Met | One Express/Nest parser; the edge forwards bytes untouched. |
| 13.1.3 | API URLs do not expose sensitive data | Met | Ids only; no keys in URLs (Gemini key in a header). |
| 13.1.4 | Authorization at URI and resource level | Met | Guards + tenant scope. |
| 13.1.5 | Unexpected content types rejected (L2) | Met | JSON bodies validated; multipart only on the upload routes with declared-type and magic-byte checks. |
| 13.2.1 | REST verb semantics | Met | Contract; route walker. |
| 13.2.2 | JSON schema validation | Met | DTOs. |
| 13.2.3 | CSRF on cookie-based REST | N/A | The API uses bearer tokens; see 4.2.2 for the web. |
| 13.2.5 | Content-Type of responses | Met | JSON; `nosniff`. |
| 13.2.6 | CORS strict allow-list (L2) | Met | `FRONTEND_URL` origins only, fixed headers and methods. |
| 13.3.x | SOAP | N/A | None. |
| 13.4.x | GraphQL | N/A | None. |

## V14 Configuration

| Req | Requirement | Status | Evidence |
|---|---|---|---|
| 14.1.1 | Build and deploy automated | Met | CI + release workflows; compose and Kubernetes forms. |
| 14.1.2 | Compiler flags / hardening | N/A | TypeScript strict; no native builds beyond vetted dependencies. |
| 14.1.3 | Server configuration hardened | Met | Non-root images, `poweredByHeader: false`, helmet, Caddy `-Server`. |
| 14.1.4 | Deployment and configuration repeatable | Met | Images by tag, `.env.example` complete (`env-example.spec.ts`), kustomize validated. |
| 14.1.5 | Build pipeline integrity (L2) | Met | SHA-pinned actions, `persist-credentials: false`, Trivy gate and control, SBOM. |
| 14.2.1 | Components up to date | Met | Dependabot weekly; `npm audit` gate; Node 22. |
| 14.2.2 | Unneeded features removed | Met | Phases 4.5/4.6 and 6.8 removed dead stacks, workers and dependencies; Swagger off in production. |
| 14.2.3 | Third-party assets verified (SRI) | Met | None loaded from third parties. |
| 14.2.4 | Components from trusted repositories (L2) | Met | npm registry with lockfile; images from the project's registry. |
| 14.2.5 | SBOM maintained (L2) | Met | CycloneDX per image, attached to releases. |
| 14.2.6 | Attack surface reduced (sandboxing) (L2) | Met | Single API process per container; no plugin system. |
| 14.3.2 | Debug modes disabled | Met | Production refuses `LOG_LEVEL=debug`, `AUTH_DISABLED`, `NEXT_PUBLIC_AUTH_DISABLED`; Swagger off; query logging off. |
| 14.3.3 | No version/stack in headers | Met | `poweredByHeader: false`, helmet, Caddy `-Server`; error bodies carry no stack. |
| 14.4.1 | Content-Type with charset | Met | `application/json; charset=utf-8` (Express). |
| 14.4.2 | Content-Disposition for downloads | Met | The analytics export answers `Content-Disposition: attachment` with a fixed file name; media and documents are served with their sniffed type under `nosniff` and never as HTML. |
| 14.4.3 | CSP | Met | Per-request nonce, `'strict-dynamic'`, `frame-ancestors 'none'`, `form-action 'self'`, `connect-src` self + API origin. |
| 14.4.4 | `X-Content-Type-Options: nosniff` | Met | Web (`next.config.js`) and API (helmet). |
| 14.4.5 | HSTS | Met | Web header, edge header, `includeSubDomains`. |
| 14.4.6 | Referrer-Policy | Met | `strict-origin-when-cross-origin` (web), helmet `no-referrer` (API). |
| 14.4.7 | Clickjacking | Met | `X-Frame-Options: DENY` + `frame-ancestors 'none'`. |
| 14.5.1 | Only needed HTTP methods | Met | CORS method list; unknown routes 404. |
| 14.5.2 | Origin header not used for authentication | Met | Never read for that. |
| 14.5.3 | CORS strict allow-list | Met | See 13.2.6. |
| 14.5.4 | Proxy headers from trusted proxies only (L2) | Met | `TRUST_PROXY` hop count; the edge discards the client's `X-Forwarded-For` (proven by the production smoke's two-address check). |

## 15. Owner decisions

Each item below is a control the repository cannot close on its own. The
owner accepts the current state or schedules the work, and dates the row;
the table is the record the external tester reads first.

| Req | Item | Recommendation | Owner decision (date, name) |
|---|---|---|---|
| 2.1.8 | Password strength meter in the register / reset / change forms | Optional at L2 ("such as"); the API already answers the policy reason. Accept. | pending |
| 2.1.12 | Show/hide toggle on the password fields | A small UI change (an eye button on four forms); schedule it with the next web change, or accept: password managers and the confirm field on reset cover the mistyping risk. | pending |
| 4.3.1 | MFA for administrative accounts | No separate admin console exists; `SUPER_ADMIN` is a role on the same API. Accept until an MFA roadmap item exists; keep `SUPER_ADMIN` accounts to the operator. | pending |
| 8.3.2 | Self-service export / deletion of an owner's own account | Shop-level data is exportable and deletable by the shop's admins; an owner's account is removed by the operator on request. Accept and record the request procedure in `docs/DATA_SAFETY.md`. | pending |
| 8.3.3 | Privacy terms shown to users | Internal staff application; the shop owner is the data controller. Accept, or add a one-page notice to the login page. | pending |
| 10.3.3 | Subdomain takeover | Operational: no dangling DNS records for staging/production hosts. | pending |
| 12.1.3 | Per-shop upload quota | Per-file caps, rate limits and the disk alert bound the fill rate. Accept, or schedule a per-shop asset count/size cap in `UploadConfig`. | pending |
| 12.4.2 | Malware scanning of uploads | Uploads are never executed or rendered as HTML. Accept, or add a ClamAV sidecar on the media and storage routes. | pending |

## 16. External penetration test

The scope letter and the findings tracker are `docs/security/PENTEST_SCOPE.md`.
The test runs against staging (`docs/STAGING.md`) with the production
limits and images; every finding is closed by a change in this repository
(with a regression test in `test/security` or the exploit replay) or
accepted by the owner with a date in that tracker. The roadmap row is
complete when the tracker has no undated row.

## Maintaining this review

A change that adds a route, a parser, a stored secret or a new kind of
data re-reads the chapter it touches (V4, V5, V6, V8 most often) and
updates the row's evidence; a new "Owner" row is added to §15 rather than
left implicit. The exploit replay and the security suite are the regression
side of this document.
