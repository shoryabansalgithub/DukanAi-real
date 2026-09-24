'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  ArrowLeft, Banknote, CalendarDays, CreditCard, FileText, History, MapPin,
  Pencil, Phone, Receipt, ShoppingCart, Trash2, Wallet,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SkeletonBox } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import {
  customersApi,
  type CustomerDetail,
  type CustomerInvoiceSummary,
  type CustomerLedgerEntry,
  type CustomerView,
  type PaginatedResult,
} from '@/lib/api-client';
import { describeApiError, getApiErrorCode } from '@/lib/api-error';
import { CustomerFormModal } from '@/components/customers/CustomerFormModal';
import { RecordPaymentModal } from '@/components/customers/RecordPaymentModal';
import { LedgerTable } from '@/components/customers/LedgerTable';
import { CustomerInvoicesTable } from '@/components/customers/CustomerInvoicesTable';
import { PaginationControls } from '@/components/customers/PaginationControls';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/customers/States';
import { formatDate, formatMoney } from '@/components/customers/format';
import { canDeleteCustomers } from '@/components/customers/permissions';

const TAB_PAGE_SIZE = 20;

type Tab = 'ledger' | 'invoices';

interface TabState<T> {
  skip: number;
  page: PaginatedResult<T> | null;
  loading: boolean;
  error: string | null;
}

const initialTab = <T,>(): TabState<T> => ({ skip: 0, page: null, loading: true, error: null });

/**
 * Generic paginated fetcher for the ledger / invoices tabs. `version` bumps
 * force a refetch after a mutation (e.g. a recorded payment).
 */
function usePaginatedTab<T>(
  enabled: boolean,
  loader: (skip: number) => Promise<PaginatedResult<T>>,
  version: number,
) {
  const [state, setState] = useState<TabState<T>>(initialTab<T>());
  const seq = useRef(0);
  const [skip, setSkip] = useState(0);

  const load = useCallback(async () => {
    if (!enabled) return;
    const mySeq = ++seq.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const page = await loader(skip);
      if (mySeq !== seq.current) return;
      setState({ skip, page, loading: false, error: null });
    } catch (err) {
      if (mySeq !== seq.current) return;
      setState((current) => ({ ...current, skip, loading: false, error: describeApiError(err, 'Loading customer history') }));
    }
  }, [enabled, loader, skip]);

  useEffect(() => {
    void load();
  }, [load, version]);

  return { ...state, skip, setSkip, reload: load };
}

function StatTile({ icon, label, value, hint, tone = 'default' }: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'default' | 'orange' | 'green' | 'red' | 'blue';
}) {
  const tones: Record<string, string> = {
    default: 'bg-purple-50 text-[#8B5CF6]',
    orange: 'bg-orange-100 text-orange-500',
    green: 'bg-green-50 text-green-500',
    red: 'bg-red-50 text-red-500',
    blue: 'bg-blue-50 text-blue-500',
  };
  return (
    <Card className="flex flex-col justify-between border border-gray-100 p-4 shadow-sm">
      <div className={`mb-2 flex h-8 w-8 items-center justify-center rounded-lg ${tones[tone]}`}>{icon}</div>
      <div>
        <p className="text-xs font-medium text-gray-500">{label}</p>
        <h3 className="text-lg font-bold text-gray-800">{value}</h3>
        {hint && <p className="mt-1 text-[10px] text-gray-400">{hint}</p>}
      </div>
    </Card>
  );
}

function HeaderSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <SkeletonBox className="h-5 w-40" />
      <div className="rounded-2xl border border-gray-100 bg-white p-6">
        <div className="flex gap-6">
          <SkeletonBox className="h-20 w-20 rounded-full" />
          <div className="flex-1 space-y-3">
            <SkeletonBox className="h-6 w-1/3" />
            <SkeletonBox className="h-4 w-1/2" />
            <SkeletonBox className="h-4 w-2/5" />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonBox key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export default function CustomerDetailsPage() {
  const params = useParams();
  const router = useRouter();
  const { data: session } = useSession();
  const { toast } = useToast();
  const customerId = Array.isArray(params.id) ? params.id[0] : (params.id as string | undefined);

  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('ledger');
  const [historyVersion, setHistoryVersion] = useState(0);

  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const allowDelete = canDeleteCustomers(session?.user?.role);

  const fetchCustomer = useCallback(async () => {
    if (!customerId) return;
    setLoading(true);
    setLoadError(null);
    try {
      setCustomer(await customersApi.getDetail(customerId));
    } catch (err) {
      setCustomer(null);
      setLoadError(describeApiError(err, 'Loading customer (GET /customers/:id)'));
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    void fetchCustomer();
  }, [fetchCustomer]);

  const ledgerLoader = useCallback(
    (skip: number) => customersApi.ledger(customerId ?? '', { skip, take: TAB_PAGE_SIZE }),
    [customerId],
  );
  const invoicesLoader = useCallback(
    (skip: number) => customersApi.invoices(customerId ?? '', { skip, take: TAB_PAGE_SIZE }),
    [customerId],
  );
  const ledger = usePaginatedTab<CustomerLedgerEntry>(!!customerId && !!customer, ledgerLoader, historyVersion);
  const invoices = usePaginatedTab<CustomerInvoiceSummary>(!!customerId && !!customer && tab === 'invoices', invoicesLoader, historyVersion);

  const applyCustomer = (updated: CustomerView) => {
    setCustomer((current) => (current ? { ...current, ...updated } : current));
  };

  const handlePaymentRecorded = ({ customer: updated }: { customer: CustomerView }) => {
    applyCustomer(updated);
    setHistoryVersion((v) => v + 1);
  };

  const handleDelete = async () => {
    if (!customer || deleting) return;
    setDeleting(true);
    try {
      await customersApi.remove(customer.id);
      toast(`${customer.name} deleted`, 'success');
      router.push('/customers');
    } catch (err) {
      if (getApiErrorCode(err) === 'CUSTOMER_HAS_BALANCE') {
        toast(
          `${customer.name} still has a balance of ${formatMoney(customer.outstandingBalance)}. Settle it before deleting.`,
          'warning',
        );
      } else {
        toast(describeApiError(err, 'Deleting customer (DELETE /customers/:id)'), 'error');
      }
      setIsDeleteOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  if (loading && !customer) return <HeaderSkeleton />;

  if (loadError || !customer) {
    return (
      <div className="space-y-6">
        <Link href="/customers" className="flex items-center gap-2 text-sm font-bold text-gray-800 transition-colors hover:text-[#8B5CF6]">
          <ArrowLeft size={16} /> Back to customers
        </Link>
        <ErrorState title="Unable to load this customer" message={loadError ?? 'Customer not found.'} onRetry={() => void fetchCustomer()} retrying={loading} />
      </div>
    );
  }

  const outstanding = customer.outstandingBalance;
  const available = customer.creditLimit - outstanding;
  const overLimit = outstanding > customer.creditLimit;

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 pb-10">
      <Link href="/customers" className="flex items-center gap-2 text-sm font-bold text-gray-800 transition-colors hover:text-[#8B5CF6]">
        <ArrowLeft size={16} /> Back to customers
      </Link>

      {/* Header */}
      <div className="flex flex-col items-start justify-between gap-6 rounded-2xl border border-gray-100 bg-white p-6 shadow-sm xl:flex-row">
        <div className="flex items-start gap-6">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-violet-100 text-3xl font-bold text-violet-700">
            {customer.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-800">{customer.name}</h1>
              {!customer.isActive && (
                <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-600">Inactive</span>
              )}
              {overLimit && (
                <span className="rounded-full border border-red-100 bg-red-50 px-3 py-1 text-xs font-bold text-red-600">Over limit</span>
              )}
              {outstanding < 0 && (
                <span className="rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-xs font-bold text-blue-600">Has advance</span>
              )}
            </div>
            <div className="mt-2 grid grid-cols-1 gap-x-8 gap-y-2 text-sm text-gray-500 sm:grid-cols-2">
              <div className="flex items-center gap-2"><Phone size={14} className="text-gray-400" />{customer.phone || 'No phone recorded'}</div>
              <div className="flex items-center gap-2"><CalendarDays size={14} className="text-gray-400" />Customer since {formatDate(customer.createdAt)}</div>
              <div className="flex items-center gap-2 sm:col-span-2">
                <MapPin size={14} className="shrink-0 text-gray-400" />
                <span>
                  {[customer.address, customer.city, customer.state].filter(Boolean).join(', ') || 'No address recorded'}
                </span>
              </div>
              {customer.email && <div className="flex items-center gap-2 sm:col-span-2"><FileText size={14} className="text-gray-400" />{customer.email}</div>}
            </div>
          </div>
        </div>

        <div className="flex w-full flex-wrap items-center gap-3 xl:w-auto">
          <button
            type="button"
            onClick={() => setIsPaymentOpen(true)}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-green-500 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-green-500/30 transition-colors hover:bg-green-600 xl:flex-none"
          >
            <CreditCard size={16} /> Record payment
          </button>
          <button
            type="button"
            onClick={() => setIsEditOpen(true)}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-purple-200 bg-purple-50 px-4 py-2.5 text-sm font-bold text-[#8B5CF6] transition-colors hover:bg-purple-100 xl:flex-none"
          >
            <Pencil size={16} /> Edit
          </button>
          {allowDelete && (
            <button
              type="button"
              onClick={() => setIsDeleteOpen(true)}
              aria-label="Delete customer"
              className="flex items-center justify-center gap-2 rounded-xl border border-gray-200 px-3 py-2.5 text-sm font-bold text-gray-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Balances */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatTile
          icon={<History size={16} />}
          label="Outstanding"
          value={outstanding < 0 ? `Advance ${formatMoney(Math.abs(outstanding))}` : formatMoney(outstanding)}
          hint={outstanding < 0 ? 'Store credit held' : 'Current udhar'}
          tone={outstanding > 0 ? 'orange' : outstanding < 0 ? 'blue' : 'green'}
        />
        <StatTile icon={<CreditCard size={16} />} label="Credit limit" value={formatMoney(customer.creditLimit)} hint="Allowed udhar" tone="red" />
        <StatTile
          icon={<Wallet size={16} />}
          label="Available credit"
          value={formatMoney(available)}
          hint={available < 0 ? 'Limit exceeded' : 'Limit minus outstanding'}
          tone={available < 0 ? 'red' : 'green'}
        />
        <StatTile icon={<ShoppingCart size={16} />} label="Total purchases" value={formatMoney(customer.totalPurchases)} hint={`Last: ${formatDate(customer.lastPurchaseAt)}`} />
        <StatTile icon={<Banknote size={16} />} label="Total paid" value={formatMoney(customer.totalPaid)} hint={`Last: ${formatDate(customer.lastPaymentAt)}`} tone="green" />
        <StatTile icon={<Receipt size={16} />} label="Recent invoices" value={customer.invoices.length.toLocaleString('en-IN')} hint="Embedded in profile (last 10)" tone="blue" />
      </div>

      {customer.notes && (
        <div className="rounded-2xl border border-yellow-200 bg-[#FFFDF0] p-5 shadow-sm">
          <h2 className="mb-2 flex items-center gap-2 font-bold text-gray-800"><FileText size={16} className="text-yellow-600" /> Notes</h2>
          <p className="whitespace-pre-line text-sm text-gray-700">{customer.notes}</p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-8 border-b border-gray-200" role="tablist">
        {([
          { id: 'ledger', label: 'Ledger' },
          { id: 'invoices', label: 'Invoices' },
        ] as Array<{ id: Tab; label: string }>).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`pb-3 text-sm font-bold transition-colors ${tab === t.id ? 'border-b-2 border-[#8B5CF6] text-[#8B5CF6]' : 'text-gray-500 hover:text-gray-800'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'ledger' && (
        <Card className="overflow-hidden border border-gray-100 p-0 shadow-sm">
          <div className="border-b border-gray-100 p-5">
            <h2 className="font-bold text-gray-800">Ledger</h2>
            <p className="mt-0.5 text-xs text-gray-500">Every credit, payment and adjustment with the running balance.</p>
          </div>
          {ledger.loading && !ledger.page ? (
            <TableSkeleton rows={6} cols={8} />
          ) : ledger.error ? (
            <div className="p-6"><ErrorState title="Unable to load the ledger" message={ledger.error} onRetry={() => void ledger.reload()} retrying={ledger.loading} /></div>
          ) : !ledger.page || ledger.page.items.length === 0 ? (
            <EmptyState icon={<History size={40} />} title="No ledger entries yet" hint="Credit sales and payments will appear here." />
          ) : (
            <>
              <LedgerTable entries={ledger.page.items} />
              <PaginationControls skip={ledger.skip} take={TAB_PAGE_SIZE} total={ledger.page.total} onChange={ledger.setSkip} disabled={ledger.loading} itemLabel="entries" />
            </>
          )}
        </Card>
      )}

      {tab === 'invoices' && (
        <Card className="overflow-hidden border border-gray-100 p-0 shadow-sm">
          <div className="border-b border-gray-100 p-5">
            <h2 className="font-bold text-gray-800">Invoices</h2>
            <p className="mt-0.5 text-xs text-gray-500">Sales and returns billed to this customer.</p>
          </div>
          {invoices.loading && !invoices.page ? (
            <TableSkeleton rows={6} cols={7} />
          ) : invoices.error ? (
            <div className="p-6"><ErrorState title="Unable to load invoices" message={invoices.error} onRetry={() => void invoices.reload()} retrying={invoices.loading} /></div>
          ) : !invoices.page || invoices.page.items.length === 0 ? (
            <EmptyState icon={<Receipt size={40} />} title="No invoices yet" hint="Bills raised for this customer will appear here." />
          ) : (
            <>
              <CustomerInvoicesTable invoices={invoices.page.items} />
              <PaginationControls skip={invoices.skip} take={TAB_PAGE_SIZE} total={invoices.page.total} onChange={invoices.setSkip} disabled={invoices.loading} itemLabel="invoices" />
            </>
          )}
        </Card>
      )}

      {/* Modals */}
      <RecordPaymentModal isOpen={isPaymentOpen} customer={customer} onClose={() => setIsPaymentOpen(false)} onRecorded={handlePaymentRecorded} />

      <CustomerFormModal isOpen={isEditOpen} mode="edit" customer={customer} onClose={() => setIsEditOpen(false)} onSaved={applyCustomer} />

      <ConfirmDialog
        isOpen={isDeleteOpen}
        title={`Delete ${customer.name}?`}
        message={
          outstanding !== 0
            ? `This customer has a balance of ${formatMoney(outstanding)}. The server will refuse the delete until it is settled.`
            : 'The customer is archived and disappears from lists. Invoices and ledger history are kept.'
        }
        confirmLabel={deleting ? 'Deleting…' : 'Delete'}
        onConfirm={() => void handleDelete()}
        onCancel={() => { if (!deleting) setIsDeleteOpen(false); }}
      />
    </div>
  );
}
