'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { ArrowLeft, Ban, Printer, RefreshCw, Undo2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { SkeletonBox, SkeletonTable } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { billingApi } from '@/lib/api-client';
import { AUTH_DISABLED } from '@/lib/auth-bypass';
import type { InvoiceDetail } from '@/types';
import { extractApiError } from '@/components/pos/api-errors';
import { dateTime, gstLabel, money, percent, qty, signedMoney, tenderLabel } from '@/components/pos/format';
import { openReceiptWindow } from '@/components/pos/ReceiptModal';
import { CustomItemBadge, InvoiceStatusBadge, InvoiceTypeBadge, PaymentModeBadge } from '@/components/invoices/InvoiceBadges';
import { ReturnDialog, returnableQuantity } from '@/components/invoices/ReturnDialog';
import { CancelDialog } from '@/components/invoices/CancelDialog';

const MANAGER_ROLES = ['MANAGER', 'ADMIN', 'OWNER', 'SUPER_ADMIN'];

export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const router = useRouter();
  const { toast } = useToast();
  const { data: session } = useSession();

  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      setInvoice(await billingApi.getInvoice(id));
    } catch (err) {
      setError(extractApiError(err, 'Loading invoice (GET /billing/invoices/:id)').message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const isManager = AUTH_DISABLED || MANAGER_ROLES.includes(String(session?.user?.role ?? '').toUpperCase());
  const returnable = useMemo(() => (invoice ? invoice.items.some((item) => returnableQuantity(item) > 0) : false), [invoice]);
  const canReturn = Boolean(invoice && invoice.type === 'SALE' && invoice.status === 'COMPLETED' && returnable);
  const canCancel = Boolean(invoice && invoice.type === 'SALE' && invoice.status === 'COMPLETED' && invoice.returns.length === 0 && isManager);

  if (loading) {
    return (
      <div className="space-y-6">
        <SkeletonBox className="h-8 w-64" />
        <Card>
          <SkeletonTable rows={4} cols={6} />
        </Card>
      </div>
    );
  }

  if (error || !invoice) {
    return (
      <Card className="p-6">
        <div role="alert" className="text-center">
          <p className="font-medium text-gray-800">Unable to load this invoice</p>
          <p className="mt-1 text-xs text-gray-500">{error ?? 'Not found'}</p>
          <div className="mt-4 flex justify-center gap-2">
            <Link href="/invoices" className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-700 hover:bg-gray-50">
              Back to invoices
            </Link>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#8B5CF6] px-4 py-2 text-sm font-bold text-white hover:bg-[#7C3AED]"
            >
              <RefreshCw size={14} /> Retry
            </button>
          </div>
        </div>
      </Card>
    );
  }

  const isReturn = invoice.type === 'SALES_RETURN';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <Link href="/invoices" className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-[#8B5CF6]">
            <ArrowLeft size={14} /> Invoices
          </Link>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <h1 className="text-2xl font-bold text-gray-800 font-mono">{invoice.invoiceNumber}</h1>
            <InvoiceTypeBadge type={invoice.type} />
            <InvoiceStatusBadge status={invoice.status} />
            <PaymentModeBadge mode={invoice.paymentMode} />
          </div>
          <p className="text-sm text-gray-500 mt-1">
            {dateTime(invoice.createdAt)}
            {invoice.cashier?.name ? ` · by ${invoice.cashier.name}` : ''}
            {invoice.shift ? ` · shift ${invoice.shift.status.toLowerCase()}` : ' · no shift'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => openReceiptWindow(invoice.id)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-bold text-gray-700 hover:bg-gray-50"
          >
            <Printer size={16} /> Print
          </button>
          {canReturn && (
            <button
              type="button"
              onClick={() => setReturnOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 px-4 py-2 text-sm font-bold text-white"
            >
              <Undo2 size={16} /> Return
            </button>
          )}
          {canCancel && (
            <button
              type="button"
              onClick={() => setCancelOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-red-600 hover:bg-red-700 px-4 py-2 text-sm font-bold text-white"
            >
              <Ban size={16} /> Cancel
            </button>
          )}
        </div>
      </div>

      {invoice.status === 'CANCELLED' && (
        <div role="status" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          Cancelled {invoice.cancelledAt ? `on ${dateTime(invoice.cancelledAt)}` : ''}
          {invoice.cancelReason ? ` — ${invoice.cancelReason}` : ''}
        </div>
      )}

      {isReturn && invoice.originalInvoice && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Returned against{' '}
          <Link href={`/invoices/${invoice.originalInvoice.id}`} className="font-mono font-bold underline">
            {invoice.originalInvoice.invoiceNumber}
          </Link>
        </div>
      )}

      {!isReturn && invoice.returns.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Returns against this sale:{' '}
          {invoice.returns.map((r, i) => (
            <span key={r.id}>
              {i > 0 ? ', ' : ''}
              <Link href={`/invoices/${r.id}`} className="font-mono font-bold underline">
                {r.invoiceNumber}
              </Link>{' '}
              ({money(r.totalAmount)})
            </span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Items */}
        <Card className="lg:col-span-2 p-0 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 text-sm font-bold text-gray-800">Items</div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-gray-600">
              <thead className="bg-gray-50/80 text-gray-500 text-[11px] uppercase font-semibold border-b border-gray-100">
                <tr>
                  <th className="px-4 py-2">Item</th>
                  <th className="px-4 py-2 text-right">Qty</th>
                  <th className="px-4 py-2 text-right">Price</th>
                  <th className="px-4 py-2 text-right">Discount</th>
                  <th className="px-4 py-2 text-right">Taxable</th>
                  <th className="px-4 py-2 text-right">Tax</th>
                  <th className="px-4 py-2 text-right">Total</th>
                  {!isReturn && <th className="px-4 py-2 text-right">Returned</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {invoice.items.map((item) => (
                  <tr key={item.id} data-testid="invoice-item" data-custom={item.isCustom ? 'true' : 'false'}>
                    <td className="px-4 py-2.5">
                      <p className="font-bold text-gray-800 truncate max-w-[260px] flex items-center gap-1.5" title={item.productName}>
                        <span className="truncate">{item.productName}</span>
                        {item.isCustom && <CustomItemBadge className="shrink-0" />}
                      </p>
                      <p className="text-[11px] text-gray-400">
                        {item.isCustom ? 'Custom item' : item.productSku} · GST {gstLabel(item.gstRate)}
                      </p>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">{qty(item.quantity, item.unit)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{money(item.sellingPrice)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {item.discountAmount > 0 ? (
                        <>
                          {money(item.discountAmount)}
                          {item.discountPercent > 0 && <span className="block text-[11px] text-gray-400">{percent(item.discountPercent)}</span>}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{money(item.taxableAmount)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{money(item.taxAmount)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-bold text-gray-800">{money(item.totalAmount)}</td>
                    {!isReturn && (
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {item.returnedQuantity > 0 ? <span className="text-amber-700 font-medium">{qty(item.returnedQuantity)}</span> : '—'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Side: totals, payments, people */}
        <div className="space-y-6">
          <Card>
            <h3 className="text-sm font-bold text-gray-800 mb-3">Totals</h3>
            <dl className="space-y-1.5 text-sm">
              <Row label="Subtotal" value={money(invoice.subtotal)} />
              {invoice.discountAmount > 0 && (
                <Row
                  label={`Discount${invoice.discountPercentage ? ` (${percent(invoice.discountPercentage)})` : ''}`}
                  value={`− ${money(invoice.discountAmount)}`}
                />
              )}
              <Row label="Taxable" value={money(invoice.taxableAmount)} />
              {invoice.isInterState ? (
                <Row label="IGST" value={money(invoice.igstAmount)} muted />
              ) : (
                <>
                  <Row label="CGST" value={money(invoice.cgstAmount)} muted />
                  <Row label="SGST" value={money(invoice.sgstAmount)} muted />
                </>
              )}
              <Row label="Total tax" value={money(invoice.taxAmount)} />
              <Row label="Round-off" value={signedMoney(invoice.roundOffAmount)} muted />
              <div className="flex justify-between border-t border-gray-200 pt-2 mt-1">
                <dt className="font-bold text-gray-800">{isReturn ? 'Refund' : 'Grand total'}</dt>
                <dd className="text-xl font-extrabold text-gray-900 tabular-nums">{money(invoice.totalAmount)}</dd>
              </div>
            </dl>
            {invoice.discountReason && <p className="mt-2 text-[11px] text-gray-500">Discount reason: {invoice.discountReason}</p>}
            {invoice.notes && <p className="mt-1 text-[11px] text-gray-500">Notes: {invoice.notes}</p>}
          </Card>

          <Card>
            <h3 className="text-sm font-bold text-gray-800 mb-3">Payments</h3>
            {invoice.payments.length === 0 && invoice.udharAmount === 0 ? (
              <p className="text-xs text-gray-400">No payments recorded.</p>
            ) : (
              <dl className="space-y-1.5 text-sm">
                {invoice.payments.map((p, i) => (
                  <div key={p.id || `${p.tender}-${i}`} className="flex justify-between">
                    <dt className="text-gray-600">
                      {tenderLabel(p.tender)}
                      {p.reference ? <span className="block text-[11px] text-gray-400">{p.reference}</span> : null}
                      {p.tenderedAmount !== null && p.tenderedAmount > p.amount && (
                        <span className="block text-[11px] text-gray-400">
                          tendered {money(p.tenderedAmount)} · change {money(p.changeAmount)}
                        </span>
                      )}
                    </dt>
                    <dd className="tabular-nums font-medium text-gray-800">{money(p.amount)}</dd>
                  </div>
                ))}
                {invoice.udharAmount > 0 && <Row label={isReturn ? 'Credit reversed' : 'On credit (udhar)'} value={money(invoice.udharAmount)} danger />}
                <div className="flex justify-between border-t border-gray-200 pt-2 mt-1">
                  <dt className="text-gray-600">Paid</dt>
                  <dd className="tabular-nums font-bold text-gray-800">{money(invoice.paidAmount)}</dd>
                </div>
                {invoice.changeAmount > 0 && <Row label="Change" value={money(invoice.changeAmount)} />}
              </dl>
            )}
          </Card>

          <Card>
            <h3 className="text-sm font-bold text-gray-800 mb-3">Customer</h3>
            {invoice.customer ? (
              <div className="text-sm">
                <Link href={`/customers/${invoice.customer.id}`} className="font-bold text-[#8B5CF6] hover:underline">
                  {invoice.customer.name}
                </Link>
                <p className="text-xs text-gray-500">
                  {invoice.customer.phone ?? ''}
                  {invoice.customer.state ? ` · ${invoice.customer.state}` : ''}
                </p>
              </div>
            ) : (
              <p className="text-sm text-gray-500">Walk-in customer</p>
            )}
            <dl className="mt-3 space-y-1 text-xs text-gray-500">
              <div className="flex justify-between">
                <dt>Cashier</dt>
                <dd className="text-gray-800 font-medium">{invoice.cashier?.name ?? '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Shift</dt>
                <dd className="text-gray-800 font-medium">
                  {invoice.shift ? (
                    <Link href="/shifts" className="hover:underline">
                      {invoice.shift.status === 'OPEN' ? 'Open' : 'Closed'} · {dateTime(invoice.shift.openedAt)}
                    </Link>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt>Supply</dt>
                <dd className="text-gray-800 font-medium">{invoice.isInterState ? 'Inter-state (IGST)' : 'Intra-state (CGST+SGST)'}</dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>

      <ReturnDialog
        isOpen={returnOpen}
        invoice={invoice}
        onClose={() => setReturnOpen(false)}
        onReturned={(ret) => {
          setReturnOpen(false);
          toast(`Return ${ret.invoiceNumber} created for ${money(ret.totalAmount)}`, 'success');
          router.push(`/invoices/${ret.id}`);
        }}
      />

      <CancelDialog
        isOpen={cancelOpen}
        invoice={invoice}
        onClose={() => setCancelOpen(false)}
        onCancelled={(updated) => {
          setCancelOpen(false);
          setInvoice(updated);
          toast(`Invoice ${updated.invoiceNumber} cancelled`, 'success');
        }}
      />
    </div>
  );
}

function Row({ label, value, muted = false, danger = false }: { label: string; value: string; muted?: boolean; danger?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className={muted ? 'text-gray-500' : 'text-gray-600'}>{label}</dt>
      <dd className={`tabular-nums ${danger ? 'text-red-600 font-medium' : muted ? 'text-gray-600' : 'text-gray-800 font-medium'}`}>{value}</dd>
    </div>
  );
}
