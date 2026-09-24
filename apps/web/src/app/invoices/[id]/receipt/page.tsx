'use client';

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { ArrowLeft, Printer, RefreshCw } from 'lucide-react';
import { SkeletonBox } from '@/components/ui/Skeleton';
import { billingApi } from '@/lib/api-client';
import type { ReceiptPayload } from '@/types';
import { extractApiError } from '@/components/pos/api-errors';
import { ReceiptPrintPortal, ReceiptView } from '@/components/invoices/ReceiptView';

function ReceiptContent() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const searchParams = useSearchParams();
  const autoprint = searchParams.get('autoprint') === '1';

  const [receipt, setReceipt] = useState<ReceiptPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const printedRef = useRef(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      setReceipt(await billingApi.getReceipt(id));
    } catch (err) {
      setError(extractApiError(err, 'Loading receipt (GET /billing/invoices/:id/receipt)').message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!autoprint || !receipt || printedRef.current) return undefined;
    printedRef.current = true;
    // Give fonts/layout a moment to settle before the print dialog opens.
    const t = window.setTimeout(() => window.print(), 400);
    return () => window.clearTimeout(t);
  }, [autoprint, receipt]);

  return (
    <ReceiptPrintPortal>
      <div className="print-hidden sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-gray-200 bg-white/95 backdrop-blur px-4 py-3">
        <Link href={id ? `/invoices/${id}` : '/invoices'} className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-[#8B5CF6]">
          <ArrowLeft size={16} /> Back to invoice
        </Link>
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline text-xs text-gray-400">80 mm thermal layout</span>
          <button
            type="button"
            onClick={() => window.print()}
            disabled={!receipt}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] disabled:opacity-50 px-4 py-2 text-sm font-bold text-white shadow-lg shadow-purple-500/30"
          >
            <Printer size={16} /> Print
          </button>
        </div>
      </div>

      {loading ? (
        <div className="mx-auto my-6 w-[80mm] space-y-3 bg-white p-4 shadow-md">
          <SkeletonBox className="h-5 w-3/4 mx-auto" />
          <SkeletonBox className="h-3 w-1/2 mx-auto" />
          <SkeletonBox className="h-3 w-full" />
          <SkeletonBox className="h-3 w-full" />
          <SkeletonBox className="h-3 w-2/3" />
          <SkeletonBox className="h-6 w-full" />
        </div>
      ) : error || !receipt ? (
        <div role="alert" className="print-hidden mx-auto my-10 max-w-sm rounded-xl border border-red-200 bg-white p-6 text-center shadow">
          <p className="font-medium text-gray-800">Unable to load the receipt</p>
          <p className="mt-1 text-xs text-gray-500">{error ?? 'Not found'}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-[#8B5CF6] px-4 py-2 text-sm font-bold text-white hover:bg-[#7C3AED]"
          >
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      ) : (
        <ReceiptView receipt={receipt} />
      )}
    </ReceiptPrintPortal>
  );
}

export default function ReceiptPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-500">Loading receipt…</div>}>
      <ReceiptContent />
    </Suspense>
  );
}
