'use client';

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { AnimatePresence, motion } from 'framer-motion';
import { IndianRupee, MoreVertical, Search, UserPlus, Users, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { SkeletonBox } from '@/components/ui/Skeleton';
import { useDebounce } from '@/hooks/useDebounce';
import { analyticsApi, customersApi, type CustomerView, type PaginatedResult } from '@/lib/api-client';
import { describeApiError, getApiErrorCode } from '@/lib/api-error';
import { CustomerFormModal } from '@/components/customers/CustomerFormModal';
import { RecordPaymentModal } from '@/components/customers/RecordPaymentModal';
import { PaginationControls } from '@/components/customers/PaginationControls';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/customers/States';
import { formatDate, formatMoney } from '@/components/customers/format';
import { canDeleteCustomers } from '@/components/customers/permissions';

const PAGE_SIZE = 25;

function availableCredit(customer: CustomerView): number {
  return customer.creditLimit - customer.outstandingBalance;
}

function isOverLimit(customer: CustomerView): boolean {
  return customer.outstandingBalance > customer.creditLimit;
}

function CustomersPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const { toast } = useToast();

  // ---- list state ----
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query.trim(), 300);
  const [skip, setSkip] = useState(0);
  const [page, setPage] = useState<PaginatedResult<CustomerView> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  // ---- outstanding udhar across all customers (server aggregate) ----
  const [outstandingUdhar, setOutstandingUdhar] = useState<number | 'error' | null>(null);

  // ---- modals ----
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<CustomerView | null>(null);
  const [paymentTarget, setPaymentTarget] = useState<CustomerView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomerView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const allowDelete = canDeleteCustomers(session?.user?.role);

  const fetchPage = useCallback(async () => {
    const seq = ++requestSeq.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await customersApi.list({ q: debouncedQuery || undefined, skip, take: PAGE_SIZE });
      if (seq !== requestSeq.current) return;
      setPage(result);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setPage(null);
      setError(describeApiError(err, 'Loading customers (GET /customers)'));
    } finally {
      if (seq === requestSeq.current) setIsLoading(false);
    }
  }, [debouncedQuery, skip]);

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  // A new search always starts on the first page.
  const handleQueryChange = (value: string) => {
    setQuery(value);
    setSkip(0);
  };

  const fetchOutstanding = useCallback(() => {
    analyticsApi
      .dashboardSummary()
      .then((summary) => setOutstandingUdhar(summary.outstandingUdhar ?? 'error'))
      .catch((err) => {
        describeApiError(err, 'Loading outstanding udhar (GET /dashboard/summary)');
        setOutstandingUdhar('error');
      });
  }, []);

  useEffect(() => {
    fetchOutstanding();
  }, [fetchOutstanding]);

  // `/customers?new=1` (dashboard quick action) opens the create modal.
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setIsAddOpen(true);
      router.replace('/customers');
    }
  }, [searchParams, router]);

  // Close the row menu on outside click.
  useEffect(() => {
    if (!openMenuId) return;
    const close = () => setOpenMenuId(null);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [openMenuId]);

  const replaceRow = (updated: CustomerView) => {
    setPage((current) =>
      current ? { ...current, items: current.items.map((c) => (c.id === updated.id ? updated : c)) } : current,
    );
  };

  const handleCreated = (created: CustomerView) => {
    setPage((current) =>
      current ? { ...current, items: [created, ...current.items].slice(0, PAGE_SIZE), total: current.total + 1 } : current,
    );
  };

  const handleDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await customersApi.remove(deleteTarget.id);
      toast(`${deleteTarget.name} deleted`, 'success');
      setDeleteTarget(null);
      void fetchPage();
      fetchOutstanding();
    } catch (err) {
      if (getApiErrorCode(err) === 'CUSTOMER_HAS_BALANCE') {
        toast(
          `${deleteTarget.name} still has a balance of ${formatMoney(deleteTarget.outstandingBalance)}. Settle it (record a payment or adjust) before deleting.`,
          'warning',
        );
      } else {
        toast(describeApiError(err, 'Deleting customer (DELETE /customers/:id)'), 'error');
      }
    } finally {
      setDeleting(false);
    }
  };

  const items = page?.items ?? [];
  const total = page?.total ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Customers (Udhar)</h1>
          <p className="mt-1 text-sm text-gray-500">Credit customers, balances and repayments.</p>
        </div>
        <button
          type="button"
          onClick={() => setIsAddOpen(true)}
          className="flex items-center gap-2 rounded-xl bg-[#8B5CF6] px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-purple-500/30 transition-all hover:bg-[#7C3AED]"
        >
          <UserPlus size={18} />
          Add customer
        </button>
      </div>

      {/* Stats (server numbers only) */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="flex items-center gap-4 p-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-orange-500/10 text-orange-500">
            <IndianRupee size={24} />
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500">Outstanding udhar (all customers)</p>
            {outstandingUdhar === null ? (
              <SkeletonBox className="mt-1 h-6 w-28" />
            ) : outstandingUdhar === 'error' ? (
              <h3 className="text-xl font-bold tracking-tight text-gray-400" title="Could not load the dashboard summary">—</h3>
            ) : (
              <h3 className="text-xl font-bold tracking-tight text-gray-800">{formatMoney(outstandingUdhar)}</h3>
            )}
          </div>
        </Card>
        <Card className="flex items-center gap-4 p-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#8B5CF6]/10 text-[#8B5CF6]">
            <Users size={24} />
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500">{debouncedQuery ? 'Matching customers' : 'Total customers'}</p>
            {isLoading && !page ? (
              <SkeletonBox className="mt-1 h-6 w-16" />
            ) : (
              <h3 className="text-xl font-bold tracking-tight text-gray-800">{total.toLocaleString('en-IN')}</h3>
            )}
          </div>
        </Card>
      </div>

      {/* Table */}
      <Card className="overflow-visible p-0">
        <div className="flex flex-col gap-4 border-b border-gray-100 bg-gray-50/50 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:w-96">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
            <input
              type="search"
              aria-label="Search customers"
              placeholder="Search by name or phone…"
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white py-2 pl-10 pr-9 text-sm transition-all focus:border-[#8B5CF6] focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20"
            />
            {query && (
              <button
                type="button"
                onClick={() => handleQueryChange('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X size={14} />
              </button>
            )}
          </div>
          {isLoading && page && <span className="text-xs font-medium text-gray-400">Refreshing…</span>}
        </div>

        <div className="min-h-[320px]">
          {isLoading && !page ? (
            <TableSkeleton rows={8} cols={7} />
          ) : error ? (
            <div className="p-6">
              <ErrorState title="Unable to load customers" message={error} onRetry={() => void fetchPage()} retrying={isLoading} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Users size={44} />}
              title={debouncedQuery ? 'No customers match your search' : 'No customers yet'}
              hint={debouncedQuery ? 'Try a different name or phone number.' : 'Add your first credit customer to start tracking udhar.'}
              action={
                !debouncedQuery && (
                  <button
                    type="button"
                    onClick={() => setIsAddOpen(true)}
                    className="rounded-xl bg-[#8B5CF6] px-4 py-2 text-xs font-bold text-white shadow-lg shadow-purple-500/30 hover:bg-[#7C3AED]"
                  >
                    Add customer
                  </button>
                )
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-gray-600">
                <thead className="border-b border-gray-100 bg-gray-50/80 text-xs font-semibold uppercase text-gray-500">
                  <tr>
                    <th className="px-6 py-4">Name</th>
                    <th className="px-6 py-4">Phone</th>
                    <th className="px-6 py-4">City</th>
                    <th className="px-6 py-4 text-right">Outstanding</th>
                    <th className="px-6 py-4 text-right">Credit limit</th>
                    <th className="px-6 py-4 text-right">Available</th>
                    <th className="px-6 py-4">Last purchase</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {items.map((customer) => {
                    const overLimit = isOverLimit(customer);
                    const available = availableCredit(customer);
                    return (
                      <tr
                        key={customer.id}
                        onClick={() => router.push(`/customers/${customer.id}`)}
                        className="group cursor-pointer transition-colors hover:bg-gray-50/50"
                      >
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-100 text-sm font-bold text-violet-700">
                              {customer.name.slice(0, 1).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <Link
                                href={`/customers/${customer.id}`}
                                onClick={(e) => e.stopPropagation()}
                                className="block truncate font-bold text-gray-800 hover:text-[#8B5CF6]"
                              >
                                {customer.name}
                              </Link>
                              <div className="mt-0.5 flex flex-wrap gap-1">
                                {overLimit && (
                                  <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-600">Over limit</span>
                                )}
                                {!customer.isActive && (
                                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-600">Inactive</span>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-6 py-4 font-medium text-gray-600">{customer.phone || '—'}</td>
                        <td className="px-6 py-4 text-gray-600">
                          {customer.city || '—'}
                          {customer.state && <span className="block text-[11px] text-gray-400">{customer.state}</span>}
                        </td>
                        <td className={`whitespace-nowrap px-6 py-4 text-right font-bold ${customer.outstandingBalance > 0 ? 'text-orange-500' : customer.outstandingBalance < 0 ? 'text-blue-600' : 'text-green-500'}`}>
                          {customer.outstandingBalance < 0
                            ? `Advance ${formatMoney(Math.abs(customer.outstandingBalance))}`
                            : formatMoney(customer.outstandingBalance)}
                        </td>
                        <td className="whitespace-nowrap px-6 py-4 text-right text-gray-700">{formatMoney(customer.creditLimit)}</td>
                        <td className={`whitespace-nowrap px-6 py-4 text-right font-semibold ${available < 0 ? 'text-red-600' : 'text-gray-800'}`}>
                          {formatMoney(available)}
                        </td>
                        <td className="whitespace-nowrap px-6 py-4 text-gray-500">{formatDate(customer.lastPurchaseAt)}</td>
                        <td className="relative px-6 py-4 text-right">
                          <button
                            type="button"
                            aria-label={`Actions for ${customer.name}`}
                            aria-haspopup="menu"
                            aria-expanded={openMenuId === customer.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenMenuId(openMenuId === customer.id ? null : customer.id);
                            }}
                            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-[#8B5CF6]/10 hover:text-[#8B5CF6]"
                          >
                            <MoreVertical size={18} />
                          </button>
                          <AnimatePresence>
                            {openMenuId === customer.id && (
                              <motion.div
                                role="menu"
                                initial={{ opacity: 0, scale: 0.95 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.95 }}
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => e.stopPropagation()}
                                className="absolute right-8 top-10 z-50 w-48 overflow-hidden rounded-xl border border-gray-100 bg-white text-left shadow-xl"
                              >
                                <button role="menuitem" type="button" onClick={() => { setOpenMenuId(null); router.push(`/customers/${customer.id}`); }} className="w-full px-4 py-2.5 text-left text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50">
                                  View details
                                </button>
                                <button role="menuitem" type="button" onClick={() => { setOpenMenuId(null); setPaymentTarget(customer); }} className="w-full px-4 py-2.5 text-left text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50">
                                  Record payment
                                </button>
                                <button role="menuitem" type="button" onClick={() => { setOpenMenuId(null); setEditTarget(customer); }} className="w-full px-4 py-2.5 text-left text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50">
                                  Edit customer
                                </button>
                                {allowDelete && (
                                  <>
                                    <div className="h-px w-full bg-gray-100" />
                                    <button role="menuitem" type="button" onClick={() => { setOpenMenuId(null); setDeleteTarget(customer); }} className="w-full px-4 py-2.5 text-left text-xs font-bold text-red-600 transition-colors hover:bg-red-50">
                                      Delete
                                    </button>
                                  </>
                                )}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {page && !error && (
          <PaginationControls skip={skip} take={PAGE_SIZE} total={total} onChange={setSkip} disabled={isLoading} itemLabel="customers" />
        )}
      </Card>

      {/* Modals */}
      <CustomerFormModal isOpen={isAddOpen} mode="create" onClose={() => setIsAddOpen(false)} onSaved={handleCreated} />

      <CustomerFormModal
        isOpen={editTarget !== null}
        mode="edit"
        customer={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={replaceRow}
      />

      <RecordPaymentModal
        isOpen={paymentTarget !== null}
        customer={paymentTarget}
        onClose={() => setPaymentTarget(null)}
        onRecorded={({ customer }) => {
          replaceRow(customer);
          fetchOutstanding();
        }}
      />

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title={deleteTarget ? `Delete ${deleteTarget.name}?` : 'Delete customer?'}
        message={
          deleteTarget && deleteTarget.outstandingBalance !== 0
            ? `This customer has a balance of ${formatMoney(deleteTarget.outstandingBalance)}. The server will refuse the delete until it is settled.`
            : 'The customer is archived and disappears from lists. Invoices and ledger history are kept.'
        }
        confirmLabel={deleting ? 'Deleting…' : 'Delete'}
        onConfirm={() => void handleDelete()}
        onCancel={() => { if (!deleting) setDeleteTarget(null); }}
      />
    </div>
  );
}

export default function CustomersPage() {
  return (
    <Suspense fallback={<div className="min-h-[320px]" />}>
      <CustomersPageContent />
    </Suspense>
  );
}
