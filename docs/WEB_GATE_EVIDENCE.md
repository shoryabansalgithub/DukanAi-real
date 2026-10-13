# Web application gate evidence (roadmap phase 6)

The phase 6 exit gate: no page shows a success toast without a persisted
change (a Playwright suite asserts persistence after reload for every
mutating UI action); Lighthouse best-practices >= 90; security headers
present. This file records how each is proven and how to re-run it.

## 1. Persistence suite (every mutating UI action)

`apps/web/e2e` runs against the API and web servers with the auth bypass
(`npm run test:e2e`); `apps/web/e2e-auth` runs the same servers without it
(`npm run test:e2e:auth`, roadmap 6.9). Every mutating UI action in the web
application, the ones a phase 6 row repaired and the ones that were already
real, is asserted after a reload AND against the API (or the API's disk for
uploads), never through optimistic UI state:

| Page | Actions covered | Spec |
|---|---|---|
| Suppliers | add, edit, delete, record payment with tender | `fake-flows.spec.ts`, `persistence.spec.ts` |
| Employees | invite (201, code emailed only), register join mode, suspend, reinstate, remove | `fake-flows.spec.ts`, `persistence.spec.ts` |
| Smart Capture | photo and photo+PDF stored on the API's disk | `fake-flows.spec.ts` |
| AI Scanner | upload reaches `/ocr/scan-bill`; 503 shown, never a fake result | `fake-flows.spec.ts` |
| Products | add (server SKU, initial stock, inline category), edit, delete with confirmation, Update Stock adjustment, server paging and filters, tiles from the API | `products-settings.spec.ts`, `persistence.spec.ts` |
| Settings | profile fields persist; the shop state decides IGST through `/billing/calculate`; ending another session revokes it on the API | `products-settings.spec.ts`, `e2e-auth/real-auth.spec.ts` |
| Expenses | tiles are the API month summary; record, edit, mark as paid, delete | `correctness.spec.ts`, `persistence.spec.ts` |
| Customers | add, edit (a cleared email and city persist as null), record payment (outstanding balance and ledger row), delete from the list and the detail page, create from the POS picker | `correctness.spec.ts`, `persistence.spec.ts` |
| Invoices | cancel (status CANCELLED), partial return (return document, `returnedQuantity` on the sale) | `persistence.spec.ts` |
| Shifts | open and close from the banner (`/shifts/current`) | `persistence.spec.ts` |
| Notifications | mark one and all read, on the page and from the navbar bell | `persistence.spec.ts` |
| Forgot / reset password | neutral confirmation; a bad link never shows success; a real link changes the password once and ends the old sessions | `correctness.spec.ts`, `e2e-auth/real-auth.spec.ts` |
| POS | anonymous cart carried into the shop scope | `web-hardening.spec.ts` |
| Checkout, dashboard | sale persisted with stock and totals; every dashboard state | `pos-checkout.spec.ts`, `dashboard.spec.ts` |
| Real sign-in | register, bounce with callback, wrong password, sign-out, every repaired page, VIEWER gating (UI and 403) | `e2e-auth/real-auth.spec.ts` |

Cart edits on the POS page (add line, custom item, hold) are browser state
until checkout and claim nothing else; the analytics CSV export is a
download, not a change. Remaining info toasts are honest by construction:
"Record Purchase" on suppliers and the plans modal in the sidebar say the
feature does not exist; neither reports success.

Last local run (2026-10-02, MariaDB test database): 49 bypass tests and 5
real-auth tests passed. CI runs both suites on MySQL 8 (`Browser tests`
job).

## 2. Security headers

Asserted on every page by `web-hardening.spec.ts` and by the production
smoke (`next build` + `next start` against an API without the bypass):

| Header | Value |
|---|---|
| Content-Security-Policy | per request, `script-src 'self' 'nonce-…' 'strict-dynamic'`, `connect-src 'self' <API origin>`, `frame-ancestors 'none'`, `form-action 'self'`, `object-src 'none'`, `base-uri 'self'`, `upgrade-insecure-requests` in production |
| Strict-Transport-Security | `max-age=63072000; includeSubDomains` |
| X-Content-Type-Options | `nosniff` |
| X-Frame-Options | `DENY` |
| Referrer-Policy | `strict-origin-when-cross-origin` |
| Permissions-Policy | `camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()` |
| X-Powered-By | absent |

The production build refuses to start with `NEXT_PUBLIC_AUTH_DISABLED`
(`next.config.js`), and the proxy (`src/proxy.ts`, the middleware convention in Next 16) verifies the session JWT with
`getToken` on every protected route.

## 3. Lighthouse

Run on the production build (`next build`, `next start -p 3011`, API on
3004 without the bypass), Lighthouse 13.5.0, Chrome 141 headless, default
mobile emulation and throttling. The public pages are audited as a visitor;
the signed-in pages carry a real NextAuth session cookie (an owner
registered through `POST /auth/register`, signed in through the real login
form with Playwright, the cookies handed to Lighthouse with
`--extra-headers`), so every audited URL is the page itself, not a bounce
to `/login` (the `landed` URL of each run was checked).

| Route | Best practices | Accessibility | Performance | SEO |
|---|---|---|---|---|
| /login | 100 | 94 | 96 | 100 |
| /register | 100 | 94 | 97 | 100 |
| /forgot-password | 100 | 94 | 95 | 100 |
| /dashboard | 100 | 94 | 85 | 100 |
| /products | 100 | 94 | 89 | 100 |
| /billing | 100 | 92 | 84 | 100 |
| /customers | 100 | 94 | 87 | 100 |
| /invoices | 100 | 96 | 95 | 100 |
| /expenses | 100 | 94 | 87 | 100 |
| /suppliers | 100 | 94 | 85 | 100 |
| /employees | 100 | 94 | 84 | 100 |
| /settings | 100 | 96 | 88 | 100 |
| /notifications | 100 | 96 | 98 | 100 |
| /inventory | 100 | 94 | 88 | 100 |
| /analytics | 100 | 94 | 97 | 100 |
| /shifts | 100 | 96 | 98 | 100 |
| /smart-capture | 100 | 90 | 88 | 100 |
| /ai-scanner | 100 | 90 | 82 | 100 |

The signed-in rows were re-measured on the Next.js 16 build (roadmap 7.2, Turbopack); the public rows are from the Next 14 build and were not re-run.
Every best-practices audit passes on every page, the security ones included
(`csp-xss`, `has-hsts`, `is-on-https`, `deprecations`, `third-party-cookies`,
`inspector-issues`, `errors-in-console`). The first public-page run scored
96: `errors-in-console` failed on a 404 for `/favicon.ico`, which
`src/app/icon.svg` now answers. The gate asks for best-practices only; the
other three categories are recorded for reference (the POS page's 89
performance is the recharts-free but widget-heavy checkout screen under
mobile throttling).

Re-run (public page):

```bash
# API without the bypass on 3004, production web on 3011 (see the smoke in AGENTS.md 6.4)
CHROME_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
npx lighthouse http://localhost:3011/login --only-categories=best-practices \
  --chrome-flags="--headless=new --no-sandbox --disable-gpu --disable-background-networking" \
  --output=json --output-path=lh-login.json --quiet
```

Re-run (signed-in page): register an owner against the API, sign in through
the login form with Playwright and read `context.cookies()`, write
`{"Cookie":"next-auth.session-token=…; next-auth.csrf-token=…; next-auth.callback-url=…"}`
to a file and add `--extra-headers=<that file>` to the command above; check
`finalDisplayedUrl` in the JSON is the page, not `/login`.

Kill the servers by process group afterwards: a `next start` spawns a
`next-server` child that outlives its `npx` parent and keeps serving the old
build on the port (that stale server produced `NO_FCP` runs and 400s for
`/_next/static` before this was understood).
