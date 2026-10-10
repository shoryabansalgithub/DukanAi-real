# EXEC-005: Dashboard verification and production certification

Status: **certified** on 2026-09-25. All 12 targets met. Every item below is
held by an automated test, so the certification is re-checked by running the
suites listed at the end.

The API contract is `docs/POS_BILLING_CONTRACT.md` §6. The page is
`apps/web/src/app/dashboard/page.tsx`.

## Targets

| # | Target | How it is met | Proven by |
|---|---|---|---|
| 1 | Dashboard loads | Four independent resources (summary, KPIs, trend, insights) load in parallel with no console errors | `e2e/dashboard.spec.ts` "shows live data…" |
| 2 | KPIs correct | Gross, refunds, net, orders and avg order value (net ÷ orders, same basis as Reports) reconcile with SQL. The KPI cache is dropped right after every commit, so the KPI strip and tiles agree on the next read | `dashboard.integration-spec` "reconciles…"; e2e "updates on the next 30 s poll…" |
| 3 | Charts show real data | Today's trend point equals today's net sales. Midnight and month-start sales are bucketed on the right business day (Asia/Kolkata). Return-only days render as negative values instead of the empty state | integration "business day…" |
| 4 | Low stock cards | Low-stock card lists the most urgent products, and the tile and "View all" open the inventory Low Stock tab. Counts cover active, stock-tracked products only (services, digital and inactive products are excluded) | integration "stock alerts…"; e2e "shows live data…" |
| 5 | Today's sales | Cancelled invoices are excluded and returns subtracted; 23:59:59 yesterday is excluded and 00:00:00 today included | integration "reconciles…", "business day…" |
| 6 | Revenue | Net all-time revenue matches SQL | integration "reconciles…" |
| 7 | Recent invoices | Last 10 committed invoices of any day, newest first, with return/cancelled badges. Older days show their date, and the empty text no longer says "today" | integration "reconciles…" |
| 8 | AI cards | AI insights card: today's sales against the 7-day forecast, restock suggestions from 30-day net sales velocity (quantity to reorder, urgency, reason), and the top earner. It loads and fails on its own | integration "insights…"; e2e "shows live data…", "a failing endpoint…" |
| 9 | Loading states | Every card shows a skeleton while loading. None of them claims "no shift", "no invoices" or "no payments" before the data arrives | e2e "while loading…" |
| 10 | Empty states | An empty shop shows zeros and empty messages, never null or NaN | integration "empty shop…" |
| 11 | Error states | Each card fails on its own. A failed summary section is marked unavailable, and a summary outage shows a banner while KPIs, chart and insights stay visible. A refresh failure keeps the last data with a badge, requests time out after 15 s, and a malformed payload is an error, not zeros | integration "a failing summary part…"; e2e "a failing endpoint…", "malformed…", "section… unavailable", "polling…" |
| 12 | Auto refresh | One set of 4 requests every 30 s, paused while the tab is hidden, refreshed immediately when it becomes visible, and stopped after leaving the page. Only the newest response is applied, and a poll never overlaps a request still in flight | e2e "polling…" |

## Cross-cutting checks

- **Reconciliation matrix.** The tests reconcile against independent SQL for these cases: 0 sales, 1 sale, several sales, a line discount, 5% and 18% GST, a cancellation, a return with a cash refund, a credit sale to a second customer, several shops, and date and month boundaries.
- **Payment modes.** Payment modes are net of refunds and add up to today's net sales.
- **Tenant isolation.**
  - Every dashboard route is scoped by the token's shop.
  - A `?shopId=` query parameter or `x-shop-id` header naming another shop is ignored.
  - A request without a token gets 401.
  - Invalid `days`/`limit` parameters fall back to defaults and caps.
- **Queue isolation.** BullMQ now uses the database index from `REDIS_URL`, so environments that share a Redis server no longer process each other's outbox jobs.

## Run

```bash
# API: unit, integration (real MySQL/MariaDB + Redis), boot regression
cd apps/api && npm test && npm run test:integration
# Web: Playwright (starts API on :3003 in test mode and web on :3010)
cd apps/web && npm run test:e2e
```

Results at certification time:

| Suite | Result |
|---|---|
| API unit | 173/173 |
| API integration | 111/111 across 5 suites |
| Web Playwright | 9/9 (7 dashboard, 2 checkout) |
| Web production build | succeeded |
| Lint | clean |
