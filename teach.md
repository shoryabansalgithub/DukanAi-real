> **Historical document, superseded.** Kept for the record: it describes an
> earlier state of the project (mock data, Next.js 14, Node 18/20, features
> that were never built) and is no longer maintained. Current documentation:
> [README.md](./README.md) (what is built, how to run it, the docs map),
> [AGENTS.md](./AGENTS.md) (architecture and sharp edges) and
> [docs/](./docs) (deployment, operations, release, go-live).

# Wiring Frontend to Real API — A Senior Dev's Guide

This doc teaches you how we replaced hardcoded mock data with real API calls across the entire DukaanAI frontend. Read it like I'm sitting next to you, explaining every decision.

---

## 1. The Problem

Your frontend has two layers living in the same files:

```typescript
// ❌ WHAT YOU HAD
import { mockProducts } from '@/data/mockData';
const [products, setProducts] = useState(mockProducts);  // resets on every refresh
```

This means:
- Every page refresh → data resets to hardcoded JSON
- "Saving" a product only updates React state in memory
- The MySQL database exists but nobody talks to it

The backend is a fully-built NestJS API with 40+ controllers, JWT auth, tenant isolation, and Prisma ORM. It works. The frontend just never called it.

---

## 2. The Three-Layer Architecture

We don't scatter `fetch()` calls everywhere. We build three clean layers:

```
┌─────────────────────────────────┐
│  PAGE COMPONENT                 │  ← UI only. Calls hooks.
│  products/page.tsx              │
├─────────────────────────────────┤
│  API CLIENT                     │  ← Typed functions. Handles field mapping.
│  lib/api-client.ts              │
├─────────────────────────────────┤
│  HTTP CLIENT                    │  ← Axios instance. Injects JWT. Handles 401.
│  lib/api.ts                     │
└─────────────────────────────────┘
```

### Layer 1: HTTP Client (`lib/api.ts`) — ALREADY EXISTED

You already had this. It's an Axios instance that:
- Reads the JWT from NextAuth session
- Injects `Bearer <token>` on every request
- Auto-signs out on 401

```typescript
import apiClient from '@/lib/api';
// apiClient.get('/products')  → automatically authenticated
```

**Rule:** Never use raw `fetch()` when `apiClient` exists. The interceptor handles auth so you don't have to.

### Layer 2: API Client (`lib/api-client.ts`) — WE CREATED THIS

This is where the magic happens. Every domain gets a typed object:

```typescript
export const productsApi = {
  list: () => get<Product[]>('/products'),
  get: (id: string) => get<Product>(`/products/${id}`),
  create: (data) => post<Product>('/products', data),
  update: (id, data) => patch<Product>(`/products/${id}`, data),
  delete: (id) => del(`/products/${id}`),
};
```

**Why a separate layer?** Three reasons:

1. **Field mapping lives here.** The backend uses `sellingPrice`, `costPrice`, `mrp`. The frontend uses `price`, `cost`. We transform the response ONCE, in one place.

```typescript
function mapProduct(raw: any): Product {
  return {
    id: raw.id,
    name: raw.name,
    sku: raw.sku ?? '',
    price: raw.sellingPrice ?? raw.mrp ?? 0,    // ← backend → frontend mapping
    cost: raw.costPrice ?? 0,
    quantity: raw.quantity ?? raw.currentStock ?? 0,
    category: raw.category?.name ?? raw.category ?? 'General',
    description: raw.description ?? undefined,
    image: raw.images?.[0]?.url ?? raw.image ?? undefined,
  };
}
```

2. **Pages don't know about HTTP.** A page calls `productsApi.list()`. It never sees URLs, headers, or response parsing. If the API endpoint changes, you fix it in ONE file.

3. **Type safety.** Every function returns `Promise<Product>` or `Promise<Product[]>`. The IDE autocompletes. You can't typo a field name.

### Layer 3: Page Component — WE REWIRED THESE

The page only does three things now:
- Call API functions on mount
- Show loading/error states
- Render UI with the data

---

## 3. The Pattern — Before & After

Every page follows the exact same pattern. Here's the before/after for a typical product list page.

### ❌ BEFORE (mock data)

```typescript
'use client';
import { mockProducts } from '@/data/mockData';

export default function ProductsPage() {
  const [products, setProducts] = useState(mockProducts);  // ← STALE ON REFRESH

  const handleSave = (data) => {
    const newProduct = { id: Date.now().toString(), ...data };
    setProducts([newProduct, ...products]);  // ← MEMORY ONLY
    toast('Added!');
  };

  const handleDelete = (id) => {
    setProducts(products.filter(p => p.id !== id));  // ← MEMORY ONLY
    toast('Deleted!');
  };

  return (
    <div>
      {products.map(p => <ProductRow key={p.id} product={p} />)}
    </div>
  );
}
```

### ✅ AFTER (real API)

```typescript
'use client';
import { useState, useEffect, useCallback } from 'react';
import { productsApi } from '@/lib/api-client';
import type { Product } from '@/types';

export default function ProductsPage() {
  // ── State ──
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch on mount ──
  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await productsApi.list();
      setProducts(data);
    } catch (err) {
      setError('Failed to load products. Check your connection.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  // ── Mutations go through API ──
  const handleSave = async (data) => {
    try {
      const created = await productsApi.create(data);
      setProducts(prev => [created, ...prev]);  // optimistic: add to state AFTER server confirms
      toast('Product added!', 'success');
    } catch {
      toast('Failed to add product.', 'error');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await productsApi.delete(id);
      setProducts(prev => prev.filter(p => p.id !== id));
      toast('Deleted!', 'success');
    } catch {
      toast('Failed to delete.', 'error');
    }
  };

  // ── Render states ──
  if (loading) return <Skeleton />;
  if (error) return <ErrorBanner message={error} onRetry={fetchProducts} />;

  return (
    <div>
      {products.map(p => <ProductRow key={p.id} product={p} />)}
    </div>
  );
}
```

---

## 4. The Three Render States — NON-NEGOTIABLE

Every data-fetching page MUST handle these three states. No exceptions.

| State | What user sees | Code pattern |
|---|---|---|
| **Loading** | Skeleton, spinner, or "Loading..." | `if (loading) return <Spinner />` |
| **Error** | Error message + Retry button | `if (error) return <ErrorBanner message={error} onRetry={fetch} />` |
| **Success** | The actual UI | Normal render |

**Why?** Without loading state, the user sees an empty table and thinks it's broken. Without error state, a network blip shows nothing forever. These aren't nice-to-haves — they're the difference between "it works" and "it's broken."

---

## 5. The Rules

### DO

- ✅ Call the API on mount via `useEffect` + `useCallback`
- ✅ Show all three states (loading, error, success)
- ✅ Mutate local state ONLY after the API confirms success (not before)
- ✅ Use `apiClient` from `lib/api.ts` for auth injection
- ✅ Use the typed functions from `lib/api-client.ts` (never raw fetch)
- ✅ Keep field mapping in `api-client.ts`, not scattered across pages

### DON'T

- ❌ Never `useState(mockData)` — it will never persist
- ❌ Never update state before the API call succeeds (optimistic is fine for deletes, risky for creates)
- ❌ Never swallow errors silently — always show something to the user
- ❌ Never use raw `fetch()` when `apiClient` exists
- ❌ Never map backend fields to frontend fields inside a page component
- ❌ Never skip loading state because "it's fast on localhost"

---

## 6. How to Add a New API Domain

When you need to wire a new page (say, "Expenses"):

### Step 1: Add functions to `lib/api-client.ts`

```typescript
export const expensesApi = {
  list: () => get<Expense[]>('/expenses'),
  create: (data) => post<Expense>('/expenses', data),
  delete: (id) => del(`/expenses/${id}`),
};
```

### Step 2: Add field mapping if needed

```typescript
function mapExpense(raw: any): Expense {
  return {
    id: raw.id,
    amount: raw.amount,
    category: raw.category?.name ?? 'Other',
    date: raw.createdAt,
    // ... map whatever the backend shape is to whatever the frontend expects
  };
}
```

### Step 3: Wire the page

```typescript
import { expensesApi } from '@/lib/api-client';

// Use the SAME pattern from Section 3 above.
// fetch → loading → error → render
```

---

## 7. Common Pitfalls

**"It works on my machine but not in production"**
→ You hardcoded `http://localhost:3001/api`. Use `NEXT_PUBLIC_API_URL` from env, or better, use the existing `apiClient` which already reads it.

**"The data loads but shows empty"**
→ Backend field names don't match. Check your `mapX()` function. Console.log the raw response to see what the backend actually returns.

**"401 Unauthorized on every request"**
→ The JWT isn't being injected. Check that `SessionProvider` wraps your app AND that the user is actually logged in.

**"The page flickers when I navigate"**
→ You're refetching on every render. Make sure your `useEffect` dependency array is `[]` (mount only) or uses `useCallback` with stable deps.

**"I added a product but it doesn't show up"**
→ You updated state before the API confirmed. Only `setProducts` inside the `try` block AFTER `await productsApi.create()` succeeds.

---

## 8. The Files We Changed

| File | What we did |
|---|---|
| `lib/api-client.ts` | **NEW** — Typed API functions + field mapping |
| `app/products/page.tsx` | Replaced mockProducts → productsApi |
| `app/customers/page.tsx` | Replaced mockCustomers → customersApi |
| `app/dashboard/page.tsx` | Replaced mockProducts → productsApi |
| `app/billing/page.tsx` | Replaced mockProducts/mockCustomers → API |
| `app/inventory/page.tsx` | Replaced MOCK_BATCHES → inventoryApi |
| `app/analytics/page.tsx` | Replaced mock data → analyticsApi |
| `app/suppliers/page.tsx` | Replaced MOCK_SUPPLIERS → suppliersApi |
| `app/employees/page.tsx` | Replaced MOCK_EMPLOYEES → employeesApi |
| `app/expenses/page.tsx` | Replaced MOCK_EXPENSES → expensesApi |
| `app/smart-capture/page.tsx` | Replaced mockCustomers → customersApi |

Every single page follows the exact same pattern from Section 3. Once you understand one, you understand them all.

---

## 9. Quick Reference Card

```
Import:     import { productsApi } from '@/lib/api-client';
Fetch:      const data = await productsApi.list();
State:      const [items, setItems] = useState<Product[]>([]);
            const [loading, setLoading] = useState(true);
            const [error, setError] = useState<string | null>(null);
Mount:      useEffect(() => { fetchItems(); }, []);
Loading:    if (loading) return <Spinner />;
Error:      if (error) return <ErrorBanner message={error} onRetry={fetchItems} />;
Create:     const created = await productsApi.create(formData);
Delete:     await productsApi.delete(id);
Update:     const updated = await productsApi.update(id, changes);
```
