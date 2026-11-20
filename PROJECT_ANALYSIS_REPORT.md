> **Historical document, superseded.** Kept for the record: it describes an
> earlier state of the project (mock data, Next.js 14, Node 18/20, features
> that were never built) and is no longer maintained. Current documentation:
> [README.md](./README.md) (what is built, how to run it, the docs map),
> [AGENTS.md](./AGENTS.md) (architecture and sharp edges) and
> [docs/](./docs) (deployment, operations, release, go-live).

# DukaanAI: Deep Full-Project Analysis & Refactoring Report

## 1. PROJECT SCAN (MANDATORY)
**Architecture Style:** Turborepo-driven Monorepo (`turbo.json`)
**Frontend (`apps/web`):**
- **Framework:** Next.js 14 (App Router)
- **UI & Styling:** React 18, Tailwind CSS, Radix UI (Headless UI components), Framer Motion, Lucide React
- **State Management:** Zustand (Global State), Local State (`useState`), React Hook Form + Zod (Form Validation)
- **Data Fetching:** React Query (though mixed with legacy `useEffect` in some components), Axios

**Backend (`apps/api`):**
- **Framework:** NestJS 11
- **Database Access:** Prisma ORM connecting to MySQL
- **Real-Time:** Socket.io (WebSockets) for stock/notification broadcasts
- **Caching & Pre-checks:** Redis (via `cache-manager-redis-yet`)
- **Other Integrations:** AWS S3 (`@aws-sdk/client-s3`) for storage, Swagger for API Docs, JWT for auth

**Database (`prisma/schema.prisma`):**
- Features robust domain modeling: `Shop`, `User`, `Category`, `Product`, `ProductBatch`, `Supplier`, `Customer`, `Shift`, `Invoice`, `InvoiceItem`, `UdharTransaction`, `InventoryLog`, `AuditLog`, `PurchaseOrder`, `StockTransfer`, `Notification`.

---

## 2. SYSTEM MAPPING

### Frontend → Backend Communication
The Next.js frontend communicates with the NestJS API via REST endpoints. React Query should ideally manage this, but there are components (e.g., `customers/[id]/page.tsx`) still manually using `fetch()` and `useEffect`. Real-time data (like low stock) is broadcasted using Socket.io gateways from the backend.

### Database Layer Structure
Prisma acts as the single source of truth. The backend uses Prisma Client to run transactions.
- **Optimistic Locking:** Implemented in `Product` via `stockVersion` to prevent race conditions during billing.
- **Layer 3 Caching:** Redis is used as a fast, atomic pre-check layer for inventory before hitting MySQL, protecting the database from high concurrency load during flash sales.

### Dependency Graph & Data Flow
User Interaction → Next.js (Zustand/React Query) → NestJS Controller → DTO Validation → NestJS Service (Business Logic) → Redis (Atomic Check) → Prisma (Transaction) → MySQL.

---

## 3. CODE QUALITY AUDIT

### 🔴 Issue 1: Massive Service Functions (God Object Anti-Pattern)
**📁 File:** `apps/api/src/billing/billing.service.ts`
- **Issue:** The `createInvoice` method is ~400 lines long. It handles product validation, Redis atomic pre-checks, optimistic locking retries, raw SQL stock deductions, complex GST math, invoice generation, customer ledger (Udhar) updates, and audit logging.
- **⚠️ Impact:** Violates Single Responsibility Principle. High cognitive load, hard to test in isolation, and prone to merge conflicts.
- **🛠 Fix:** Extract domain logic into focused services: `StockReservationService`, `TaxCalculationService`, `LedgerUpdateService`.
- **🧪 Risk Level:** Medium.
- **🔒 Safe Guarantee:** API behavior and request/response shape remain unchanged.

### 🔴 Issue 2: Direct `useEffect` Data Fetching Bypassing React Query
**📁 File:** `apps/web/src/app/customers/[id]/page.tsx`
- **Issue:** The component manually fetches data inside a `useEffect` hook and sets local state (`setCustomer`), falling back to mock data if the API fails.
- **⚠️ Impact:** Performance overhead. Missing out on caching, automatic background refetching, and stale-while-revalidate features. Triggers unnecessary UI re-renders.
- **🛠 Fix:** Replace `useEffect` and `fetch` with `@tanstack/react-query`'s `useQuery`.
- **🧪 Risk Level:** Low.
- **🔒 Safe Guarantee:** UI layout and rendering remain exactly the same.

### 🔴 Issue 3: Monolithic UI Components & Mixed Concerns
**📁 File:** `apps/web/src/app/smart-capture/page.tsx`
- **Issue:** Exceeds 340 lines. Mixes heavy business logic (MediaStream camera API handling, canvas manipulation, local storage paths) directly inside the UI rendering tree.
- **⚠️ Impact:** When state updates (e.g., camera capturing), the entire massive component re-renders. Low maintainability.
- **🛠 Fix:** Extract camera logic to a custom hook: `const { stream, capturePhoto, closeCamera } = useCameraCapture();`
- **🧪 Risk Level:** Low.
- **🔒 Safe Guarantee:** UI/UX design is completely preserved.

### 🔴 Issue 4: Raw SQL Loop inside Prisma Transaction
**📁 File:** `apps/api/src/billing/billing.service.ts` (Lines 112-124)
- **Issue:** Inside the `createInvoice` transaction, `tx.$executeRaw` is used inside a `for...of` loop to deduct stock for every single invoice item.
- **⚠️ Impact:** If an invoice has 50 items, this triggers 50 sequential SQL roundtrips to the database inside an active transaction. Holds the connection pool hostage.
- **🛠 Fix:** Use Prisma's `CASE ... WHEN` raw SQL logic to update multiple rows in a single query, or batch the updates.
- **🧪 Risk Level:** Medium/High (Database locking mechanism).
- **🔒 Safe Guarantee:** Schema remains identical; API latency dramatically reduced.

---

## 4. PERFORMANCE OPTIMIZATION

### Frontend Optimization
- **Missing Memoization:** Derived states (e.g., finding a selected customer by ID inside `smart-capture/page.tsx`) are evaluated on every render. Wrap these in `useMemo`.
- **Bundle Size:** Ensure Lucide React imports are destructured correctly or tree-shaken by the Next.js compiler to avoid shipping unused SVGs.

### API & Database Optimization
- **Connection Pooling:** Ensure Prisma's connection pool size is properly configured for the NestJS environment, especially considering the long-running transactions in billing.
- **Index Optimization:** In `schema.prisma`, there are excellent compound indices (e.g., `@@index([shopId, status])`). Ensure that search features (like searching products by name) use the `@@fulltext([name, aliases])` index correctly in the NestJS services.

---

## 5. ARCHITECTURE IMPROVEMENTS (SAFE ONLY)

### Better Separation of Concerns (Backend)
Adopt a strict **Controller-Service-Repository** or **Domain-Driven Design (DDD)** pattern.
Currently, NestJS Services (like `BillingService`) act as both Business Logic controllers and Data Access layers (making direct raw SQL calls).
- **Suggestion:** Create a `BillingRepository` to handle the Prisma transactions and raw SQL queries, keeping the `BillingService` purely for orchestration and business rules.

### Better State Management (Frontend)
- **Suggestion:** Move all API calls to `React Query` hooks located in an `apps/web/src/hooks/queries` folder (e.g., `useGetCustomer(id)`). Leave `Zustand` exclusively for UI-specific global state (like Sidebar open/close, active themes, or complex multi-step form data).

### Better Reusable Component Design
- **Suggestion:** For pages like `customers/[id]/page.tsx`, split the file into modular components: `<CustomerHeader />`, `<CustomerStats />`, `<InvoiceHistoryTable />`, and `<PaymentModal />`. This isolates re-renders and makes Tailwind classes significantly easier to read.
