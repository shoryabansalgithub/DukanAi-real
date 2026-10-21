> **Historical audit, superseded.** One of the audit passes that the
> production-readiness roadmap (phases 0 to 9) answered; its findings are
> closed or tracked there and it is no longer maintained. Current documentation:
> [README.md](../../README.md), [AGENTS.md](../../AGENTS.md) and [docs/](../../docs).

# DukanAI — Pass 3 Frontend Deep Audit

## 1. Frontend Architecture Summary
The frontend is a Next.js 14 App Router application built primarily with React Client Components (`'use client'`). It utilizes Tailwind CSS for styling and Framer Motion for animations. Global state is minimally managed via React Context (e.g., `ToastProvider`), while most page state is held locally via `useState`. Communication with the backend is abstracted through `api-client.ts`, mapping raw Prisma API shapes into frontend DTOs.

## 2. Routing Issues
* **Severity: P2 (Medium)**
* **Missing Error Boundaries**: Core routes (`/employees`, `/expenses`, `/suppliers`) lack localized `error.tsx` boundaries. If an unhandled exception occurs (e.g., during hydration), the entire route crashes to the root error boundary, severely degrading the UX.

## 3. Component Issues
* **Severity: P1 (High)**
* **File**: `apps/web/src/components/ui/Card.tsx`
* **Root cause**: Dead exports. `CardDescription` and `CardFooter` are defined and exported but never used anywhere in the application.
* **Severity: P2 (Medium)**
* **Unnecessary Re-renders**: Heavy table grids in `employees/page.tsx` and `expenses/page.tsx` pass inline arrow functions (e.g., `onClick={(e) => { setSelectedEmployee(emp); setIsSidePanelOpen(true); }}`) directly to table rows mapping over large arrays. This defeats React's ability to memoize rows if they were to be extracted, forcing re-renders of the entire table on any state change.

## 4. Hook Issues
* **Severity: P2 (Medium)**
* **Files**: `employees/page.tsx:39`, `expenses/page.tsx:37`, `suppliers/page.tsx:24`
* **Root cause**: Stale closures / Missing dependencies in `useEffect`. The API fetch effect relies on the `toast` function from `useToast()` but does not include it in the dependency array. 
* **Evidence**: Next.js lint emits: `Warning: React Hook useEffect has a missing dependency: 'toast'`.

## 5. State Management Issues
* **Severity: P0 (Critical)**
* **Files**: `employees/page.tsx`, `suppliers/page.tsx`, `expenses/page.tsx`
* **Root cause**: Local state illusion (Fake State). When an employee or expense is created via the modals, the application calls `setEmployees([newEmp, ...employees])` locally but **never syncs this with the backend**. 
* **Runtime Impact**: Complete data loss upon page refresh. The state management creates a facade of functionality without persisting any data.

## 6. API Integration Issues
* **Severity: P0 (Critical)**
* **File**: `apps/web/src/lib/api-client.ts`
* **Root cause**: Missing API implementations. While `productsApi` and `customersApi` have `create`, `update`, and `delete` mappings, the `employeesApi`, `suppliersApi`, and `expensesApi` objects ONLY export a `list()` method.
* **Runtime Impact**: The UI cannot perform any write operations for core business domains. 
* **Severity: P1 (High)**
* **Root cause**: Missing cleanup / `AbortController`. The `useEffect` blocks that fetch data on mount do not implement cancellation. If the user navigates away before the promise resolves, it will trigger a state update on an unmounted component (memory leak).

## 7. Rendering Issues
* **Severity: P2 (Medium)**
* **File**: All major pages (e.g., `employees/page.tsx`).
* **Root cause**: Heavy reliance on `'use client'` at the very top of page routes. The application is completely bypassing Server-Side Rendering (SSR) benefits by declaring entire page routes as client components, shifting all fetching and rendering waterfalls to the user's browser.

## 8. Performance Issues
* **Severity: P2 (Medium)**
* **File**: `apps/web/src/data/mockData.ts`
* **Root cause**: Oversized dead mock arrays. Massive static arrays (`mockProducts`, `mockCustomers`, `mockTransactions`, `mockDashboardStats`) are exported but completely unused in the active UI, bloating the JavaScript parse time.

## 9. Accessibility Issues
* **Severity: P2 (Medium)**
* **Root cause**: Custom Modals and Sliding Panels (e.g., `SlidingPanel` usage in `suppliers/page.tsx`) lack Focus Traps. Keyboard users tabbing through the interface can tab out of an open modal into the obscured background UI. Furthermore, interactive table rows lack `tabIndex={0}` or `onKeyDown` equivalents for their `onClick` handlers.

## 10. Responsive Design Issues
* **Severity: P3 (Low)**
* **Root cause**: Horizontal scrolling on tables. In `expenses/page.tsx`, the table is wrapped in `overflow-x-auto min-h-[400px]`, which prevents clipping but degrades the mobile experience significantly by forcing users to pan across 6 columns.

## 11. Dead Code Report
The following frontend elements are 100% dead/unreachable and should be purged:
* **UI Components**: `CardDescription`, `CardFooter`
* **Hooks**: `useMediaQuery`, `useIsMobile`
* **Utilities**: `formatCurrency`, `formatNumber`, `formatDate`, `formatTime`, `formatDateTime`, `calculatePercentage`, `calculateTax`, `calculateDiscount`, `truncateText`, `generateInvoiceNumber`, `generateId`
* **Mock Data**: `mockDashboardStats`, `mockProducts`, `mockCustomers`, `mockProductSales`, `mockTransactions`, `mockLowStockAlerts`, `mockAIInsights`, `mockUdharOverview`
* **API Modules**: `analyticsApi`

## 12. Production Readiness Score
**Score: 35/100**
*(The frontend looks aesthetically pleasing and renders without crashing, but the complete disconnection of critical write operations (fake local state mutations) and the absence of API cancellation/error handling make it entirely unready for production use.)*

## 13. Prioritized Fix Order
1. **Fix Fake API State (P0)**: Implement `create`, `update`, and `delete` endpoints in `api-client.ts` for Employees, Suppliers, and Expenses, and wire the UI forms to actually await these calls.
2. **Implement Fetch Cleanup (P1)**: Add `AbortController` signal passing to `api-client.ts` and cancel fetches in the `useEffect` cleanup functions.
3. **Fix Dependency Arrays (P2)**: Add `toast` to all `useEffect` dependency arrays to resolve stale closure risks.
4. **Purge Dead Code (P2)**: Delete the unused `mockData.ts` arrays and unused utilities from `lib/utils.ts` to improve maintainability and bundle parsing.
5. **Add Error Boundaries (P2)**: Implement `error.tsx` at the route group levels to prevent full application crashes.
