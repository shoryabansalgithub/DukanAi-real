> **Historical audit, superseded.** One of the audit passes that the
> production-readiness roadmap (phases 0 to 9) answered; its findings are
> closed or tracked there and it is no longer maintained. Current documentation:
> [README.md](../../README.md), [AGENTS.md](../../AGENTS.md) and [docs/](../../docs).

# DukanAI — Pass 5 Authentication & Security Deep Audit

## 1. Authentication Flow Summary
The application supports standard local credentials and Google OAuth. Successful authentication yields a stateless JWT (`access_token`) and an opaque `refresh_token` stored in the database. A global `JwtAuthGuard` verifies the JWT signature, and a subsequent `TenantGuard` verifies that the authenticated user possesses a valid `shopId`.

## 2. Authorization Audit
* **Severity: P0 (Critical)**
* **Root Cause**: Intentional Authentication Backdoor.
* **File**: `apps/api/src/auth/auth-bypass.service.ts`
* **Exploit Scenario**: If the `AUTH_DISABLED` environment variable is set to a truthy value, `JwtAuthGuard` immediately accepts the request, bypassing all JWT verification. It provisions a "system" user with `OWNER` role and assigns it to a mock shop. While intended for local development, deploying with this flag toggled on creates an unauthenticated, zero-click complete administrative takeover of the system.

## 3. JWT Audit
* **Severity: PASS**
* **Root Cause**: JWT validation is correctly implemented. It uses `passport-jwt` with symmetric HS256 (via `@nestjs/jwt`). The secrets and expirations are strictly enforced via the `JwtConfig` environment schema. 

## 4. Session Audit
* **Severity: P0 (Critical)**
* **Root Cause**: Missing Session Storage Model.
* **File**: `apps/api/src/auth/auth.service.ts` (Lines 66-74)
* **Exploit Scenario**: The login flow requires storing the `refresh_token` in the database: `await this.prisma.refreshToken.create(...)`. Because the `RefreshToken` model was manually deleted from `schema.prisma` (as discovered in Pass 4), this database call throws a fatal runtime exception. 
* **Business Impact**: Normal users **cannot log in**. The entire session creation and rotation flow is completely non-functional in production.

## 5. OAuth Audit
* **Severity: PASS**
* **Root Cause**: The Google Identity flow correctly uses `google-auth-library` to securely verify the ID token's signature, issuer, and audience rather than blindly trusting client-provided claims. 

## 6. Tenant Isolation Audit
* **Severity: P0 (Critical)**
* **Root Cause**: Tenant Filter Bypass.
* **File**: `apps/api/src/prisma/prisma-tenant.extension.ts`
* **Exploit Scenario**: As proven in Pass 4, the Prisma Tenant extension relies on a hardcoded list of 15 models (`tenantOwnedModels`). Over 50 tenant-owned models (e.g., `SalesOrder`, `Reservation`, `User`) are excluded from this list.
* **Business Impact**: A malicious authenticated user can easily perform Insecure Direct Object Reference (IDOR) attacks or bulk data scraping across all tenants, as queries against unprotected models completely ignore the `shopId` constraint.

## 7. API Security Audit
* **Severity: PASS (mostly)**
* **Root Cause**: Global guards (`ThrottlerGuard`, `JwtAuthGuard`, `TenantGuard`, `RolesGuard`) are correctly registered in `APP_GUARD` inside `app.module.ts`. This ensures a secure-by-default posture for all non-public endpoints.

## 8. Secret Management Audit
* **Severity: P2 (Medium)**
* **Root Cause**: The configuration relies heavily on the `AUTH_DISABLED` flag overriding standard security. The JWT Secrets and Redis keys are securely enforced via `class-validator` Environment schemas, avoiding hardcoded secrets in the repository.

## 9. Input Validation Audit
* **Severity: PASS**
* **Root Cause**: `ValidationPipe` is globally registered in `main.ts` with `whitelist: true` and `forbidNonWhitelisted: true`. This successfully protects the API layer against Mass Assignment and Prototype Pollution attacks.

## 10. File Upload Audit
* **Severity: P1 (High)**
* **Root Cause**: Unrestricted File Upload & Path Traversal.
* **File**: `apps/api/src/product-media/upload-engine.service.ts`
* **Exploit Scenario**: The `validateFile` method explicitly trusts the `file.mimetype` provided by the client (HTTP Content-Type header). Furthermore, it constructs the local path using `file.originalname` without sanitization. An attacker can upload a malicious script (e.g., `shell.php`) by spoofing the `Content-Type: image/jpeg` header and use path traversal (`../../../etc/cron.d/shell`) in the filename to achieve Remote Code Execution (RCE).

## 11. Rate Limiting Audit
* **Severity: PASS**
* **Root Cause**: `ThrottlerModule` and `ThrottlerGuard` are correctly configured globally with tiered short/medium/long buckets, effectively mitigating basic brute force and credential stuffing attacks.

## 12. Cryptography Audit
* **Severity: PASS**
* **Root Cause**: Passwords are securely hashed using `bcrypt` (in `auth.service.ts`), and refresh tokens are hashed using `sha256` before database storage, preventing raw token theft in the event of a database dump.

## 13. Security Misconfiguration Audit
* **Severity: PASS**
* **Root Cause**: `Helmet` is active, and CORS is strictly bound to `frontendUrl` rather than using a wildcard `*`.

## 14. OWASP Top 10 Coverage
* **A01:2021-Broken Access Control**: Fails (P0 Tenant Isolation Bypass, P0 Auth Bypass switch).
* **A04:2021-Insecure Design**: Fails (P1 Unsafe File Uploads).
* **A05:2021-Security Misconfiguration**: Fails (P0 Database drift breaking sessions).
* **A07:2021-Identification and Authentication Failures**: Fails (Login flow crashes completely).

## 15. Critical Exploitable Vulnerabilities (P0)
1. **Zero-Click Complete Takeover**: Activating `AUTH_DISABLED` entirely turns off identity verification.
2. **Cross-Tenant Data Leakage**: Hardcoded `tenantOwnedModels` exposes 70% of tenant data to IDOR attacks.
3. **Login Denial of Service**: The deletion of the `RefreshToken` schema permanently breaks the standard login flow.

## 16. Production Security Score
**Score: 10/100**
*(The security foundations (Helmet, bcrypt, global validation pipes) are strong, but critical implementation flaws in tenant isolation, file uploads, and session persistence render the application entirely unsafe for production use.)*

## 17. Prioritized Security Fix Order
1. **Restore RefreshToken**: Immediately fix the schema drift to allow standard logins to function.
2. **Fix Multi-Tenant Extension**: Dynamically infer tenant models instead of using the hardcoded array in `prisma-tenant.extension.ts`.
3. **Secure File Uploads**: Implement magic byte validation for uploads and sanitize `file.originalname` to remove path traversal sequences before writing to disk.
4. **Remove Auth Bypass**: Delete `auth-bypass.service.ts` or strictly lock it behind a `NODE_ENV=development` check to guarantee it can never activate in production.
