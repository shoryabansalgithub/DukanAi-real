'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { X } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { shiftsApi, type DashboardSummary } from '@/lib/api-client';
import { businessDateIn } from '@/lib/business-date';
import { SkeletonBox } from '@/components/ui/Skeleton';
import { formatBusinessDate, formatCount, formatDateTime, formatMoney, formatTime } from '@/components/customers/format';
import { isManagement } from '@/components/customers/permissions';
import { describeApiError } from '@/lib/api-error';
import type { Shift } from '@/types';

/**
 * The detail behind the dashboard's "Today's sales (net)" tile: today's figures and one row per shift
 * that was open at some moment of the shop's business day (`GET /shifts?businessDate`, so a shift left
 * running since an earlier day is listed too). Rows lead with the time range, not the cashier. A native
 * <dialog> opened with showModal(): the page is inert, Escape and a backdrop click close it, and focus
 * returns to the tile.
 */
interface TodaySalesDialogProps {
  open: boolean;
  onClose: () => void;
  summary: DashboardSummary | null;
}

type ShiftsState = { loading: boolean; error: string | null; items: Shift[] | null };

function tenderSplit(shift: Shift): string {
  const parts: Array<[string, number]> = [
    ['Cash', shift.cashSales],
    ['UPI', shift.upiSales],
    ['Card', shift.cardSales],
    ['Udhar', shift.udharSales],
  ];
  return parts
    .filter(([, value]) => Math.abs(value) >= 0.005)
    .map(([label, value]) => `${label} ${formatMoney(value)}`)
    .join(' · ');
}

const MONEY_EPSILON = 0.005;
/** The API's page cap for shifts; a day with more is read page by page. */
const SHIFT_PAGE = 100;

export function TodaySalesDialog({ open, onClose, summary }: TodaySalesDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const reduceMotion = useReducedMotion();
  const { data: session } = useSession();
  const ownShiftsOnly = !!session?.user?.role && !isManagement(session.user.role);
  const [shifts, setShifts] = useState<ShiftsState>({ loading: false, error: null, items: null });
  const request = useRef(0);

  const businessDate = summary?.businessDate;
  const load = useCallback(async () => {
    if (!businessDate) return;
    const seq = ++request.current;
    setShifts((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const items: Shift[] = [];
      for (;;) {
        const page = await shiftsApi.list({ businessDate, skip: items.length, take: SHIFT_PAGE });
        items.push(...page.items);
        if (page.items.length === 0 || items.length >= page.total) break;
      }
      if (seq === request.current) setShifts({ loading: false, error: null, items });
    } catch (error) {
      if (seq === request.current) setShifts((prev) => ({ ...prev, loading: false, error: describeApiError(error, 'Loading shifts (GET /shifts)') }));
    }
  }, [businessDate]);

  // The dialog is the source of truth for being open: showModal puts it in the top layer,
  // makes the page inert, closes on Escape and gives focus back to the tile on close.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      void load();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, load]);

  // A modal dialog does not stop the page behind it from scrolling.
  useEffect(() => {
    if (!open) return;
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = previous;
    };
  }, [open]);

  // Ignore answers that land after the dialog closed.
  useEffect(() => {
    if (!open) request.current++;
  }, [open]);

  const s = summary;
  const rows = s ? shifts.items : null;
  const shiftTotal = rows?.reduce((sum, shift) => sum + shift.totalSales, 0) ?? 0;
  const gap = s && s.todaySales !== null && rows && rows.length > 0 ? s.todaySales - shiftTotal : 0;

  return (
    <dialog
      ref={ref}
      aria-labelledby="today-sales-title"
      onClose={onClose}
      // A click on the dialog box itself (not the panel inside it) is a click on the backdrop.
      // `!m-auto`: the dashboard renders this inside `space-y-6`, whose sibling margin outranks
      // `m-auto` and pinned the dialog to the top of the viewport.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="!m-auto w-[calc(100%-2rem)] max-w-md overflow-visible bg-transparent p-0 text-left backdrop:bg-black/50 backdrop:backdrop-blur-[2px]"
    >
      {open && (
        <motion.div
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-[0_1px_2px_rgba(6,24,44,0.08),0_24px_48px_-12px_rgba(6,24,44,0.28)]"
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div className="min-w-0">
              <h2 id="today-sales-title" className="text-sm font-medium text-gray-500">
                Today&apos;s sales (net)
              </h2>
              <p className="text-xs text-gray-500">{s ? formatBusinessDate(s.businessDate) : '—'}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="group -mr-2 -mt-2 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center text-gray-500 outline-none [@media(pointer:coarse)]:-mr-3 [@media(pointer:coarse)]:-mt-3 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
            >
              {/* The button is the hit area (44px on touch); the circle and its focus ring are this span. */}
              <span className="flex h-9 w-9 items-center justify-center rounded-full transition-[background-color,color] duration-150 ease-out group-hover:bg-gray-100 group-hover:text-gray-800 group-focus-visible:outline group-focus-visible:outline-[3px] group-focus-visible:outline-offset-1 group-focus-visible:outline-[#8B5CF6] group-active:bg-gray-200 group-active:duration-0">
                <X size={18} aria-hidden="true" />
              </span>
            </button>
          </div>

          <div className="px-5 pb-4 pt-2">
            <p className="text-3xl font-bold tracking-tight text-gray-900 tabular-nums">
              {s && s.todaySales !== null ? formatMoney(s.todaySales) : '—'}
            </p>
            {s && s.todayGrossSales !== null && (
              <p className="mt-1 text-xs text-gray-500 tabular-nums">
                Gross {formatMoney(s.todayGrossSales)} · Returns {formatMoney(s.todayReturns ?? 0)}
                {s.todayOrders !== null && <> · {formatCount(s.todayOrders)} order{s.todayOrders === 1 ? '' : 's'}</>}
              </p>
            )}
          </div>

          <div className="flex items-baseline justify-between border-t border-gray-100 px-5 pb-2 pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              {ownShiftsOnly ? 'Your shifts today' : 'By shift'}
            </h3>
            {rows && rows.length > 0 && (
              <span className="text-xs text-gray-500">
                {rows.length} shift{rows.length === 1 ? '' : 's'}
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5" aria-busy={shifts.loading}>
            {shifts.loading && !rows ? (
              <ul aria-label="Loading shifts" className="divide-y divide-gray-100">
                {[0, 1].map((i) => (
                  <li key={i} className="flex items-center justify-between py-3">
                    <div className="space-y-1.5">
                      <SkeletonBox className="h-4 w-28" />
                      <SkeletonBox className="h-3 w-40" />
                    </div>
                    <SkeletonBox className="h-4 w-16" />
                  </li>
                ))}
              </ul>
            ) : shifts.error && !rows ? (
              <div role="alert" className="py-4 text-sm">
                <p className="font-medium text-gray-800">Shifts could not be loaded</p>
                <p className="mt-0.5 text-xs text-gray-500">{shifts.error}</p>
                <button
                  type="button"
                  onClick={() => void load()}
                  className="mt-3 cursor-pointer rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-700 transition-[background-color] duration-150 ease-out hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8B5CF6] active:bg-gray-100 active:duration-0"
                >
                  Retry
                </button>
              </div>
            ) : rows && rows.length === 0 ? (
              <div className="py-6 text-center">
                <p className="text-sm font-medium text-gray-800">No shift was open today</p>
                <p className="mx-auto mt-1 max-w-[30ch] text-xs text-gray-500">
                  Open a shift from the POS to see each shift&apos;s sales here.
                </p>
              </div>
            ) : rows ? (
              <ul className="divide-y divide-gray-100">
                {rows.map((shift) => {
                  const running = shift.status === 'OPEN';
                  // The date is shown only on an end that falls on another day than today.
                  const stamp = (iso: string | null) =>
                    s && iso && businessDateIn(s.timezone, new Date(iso)) !== s.businessDate ? formatDateTime(iso) : formatTime(iso);
                  const tenders = tenderSplit(shift);
                  return (
                    <li key={shift.id} className="py-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm font-semibold text-gray-800 tabular-nums">
                          <span>
                            {stamp(shift.openedAt)}
                            {' – '}
                            {running ? 'now' : stamp(shift.closedAt)}
                          </span>
                          {running && (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-700">
                              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-green-500" />
                              Running
                            </span>
                          )}
                        </p>
                        <p className="shrink-0 text-sm font-semibold text-gray-800 tabular-nums">{formatMoney(shift.totalSales)}</p>
                      </div>
                      {tenders && <p className="mt-0.5 text-xs text-gray-500 tabular-nums">{tenders}</p>}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>

          <div className="space-y-2 border-t border-gray-100 px-5 py-4">
            {rows && rows.length > 0 && (
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-gray-500">Shift total</span>
                <span className="font-semibold text-gray-800 tabular-nums">{formatMoney(shiftTotal)}</span>
              </div>
            )}
            {Math.abs(gap) >= MONEY_EPSILON && (
              <p className="text-xs text-gray-500">
                {ownShiftsOnly
                  ? 'Only your own shifts are listed; the figure above is the whole shop.'
                  : `Differs from today's net by ${formatMoney(gap, { signed: true })}. A sale billed while no shift was open is in no shift, a shift counts its whole run even when it began before today, and a refund counts in the shift that paid it out.`}
              </p>
            )}
            <Link
              href="/shifts"
              className="-mx-1 inline-flex min-h-6 items-center [@media(pointer:coarse)]:min-h-11 rounded px-1 text-xs font-semibold text-[#7C3AED] underline decoration-transparent underline-offset-2 transition-[text-decoration-color,color] duration-150 ease-out hover:decoration-current focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8B5CF6] active:text-[#5B21B6] active:duration-0 dark:text-[#A78BFA] dark:active:text-[#C4B5FD]"
            >
              All shifts
            </Link>
          </div>
        </motion.div>
      )}
    </dialog>
  );
}
