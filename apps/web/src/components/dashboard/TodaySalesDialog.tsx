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

/* micro-spec: TodaySalesDialog / panel
   role:      read-only detail of the "Today's sales (net)" tile; one level above the page
   form:      native <dialog> (showModal: top layer, inert page, Escape, focus return to the tile);
              w = min(100% - 2rem, 28rem) because a shift row is two short lines, not a table;
              r 16 = the app's Modal radius, so every dialog in the app shares one corner
   material:  the app's surface (bg-white, which the dark theme inverts); edge: gray-100 ring,
              the same edge the dashboard cards carry
   depth:     rank 3 of 3 (page < card < dialog): contact line + wide ambient with negative spread,
              both in the cards' blue-grey shadow hue, never black
   behaviour: enter: opacity 0 -> 1, y 8 -> 0, 180ms ease-out (opened once per look, so short);
              reduced motion: opacity only | exit: instant, the tile already has focus back
   absent:    sheen, grain, gradient - a read-out has no reason to be an object; header rule -
              the figure's size already separates it from the list */

/* micro-spec: TodaySalesDialog / close button
   role:      the one control in the panel besides the shifts link
   form:      pill (r = h/2), h 36: a circle must be 34+ to hold a 24px target square at its corners;
              pulled out by 8 so the glyph still lines up with the panel's 20px inset; icon 18 at stroke 2;
              on a coarse pointer the square hit area grows to 44 (pulled out by 12) around the same 36 circle;
              the hit area is the square button, the circle a span inside it (a round box loses its corners)
   material:  none at rest (the panel's own surface); hover gray-100, press gray-200
   depth:     rank 0: it sits in the panel, it never floats
   behaviour: hover 150ms ease-out (the scale step nearest 120) on background-color and color | press instant | focus: 3px #8B5CF6 outline,
              offset 1, on the circle (a 2px ring on a 36px circle is under the WCAG 2.4.13 area) | cursor: pointer
   absent:    border, shadow - a quiet secondary by rank */

/* micro-spec: "All shifts" link
   form:      text link, 12/16 semibold; min-h 24 with 4px side padding (pulled back by -mx-1) so the
              hit area is a 24px target while the text stays on the panel's inset; 44 tall on a coarse pointer
   behaviour: underline fades in on hover (150ms) | press: one violet step darker, instant |
              focus: the panel's 2px #8B5CF6 outline | dark: #A78BFA, since #7C3AED is 2.9:1 on gray-900 */

/* micro-spec: shift row
   inherits:  text only; rows are separated by a gray-100 rule, the dashboard lists' divider.
   lead:      the time range, not the cashier (the owner asked for when, not who); the date is added
              only to an end that is not today, so a normal day reads as times alone.
   running:   a 6px green dot + "Running" in gray-700, so the label keeps its contrast in both themes */

interface TodaySalesDialogProps {
  open: boolean;
  onClose: () => void;
  summary: DashboardSummary | null;
}

type ShiftsState = { loading: boolean; error: string | null; items: Shift[] | null };

/** Shifts the shop's business day touched: opened on or before it, and not closed before it. */
function shiftsOnBusinessDate(items: Shift[], businessDate: string, timeZone: string): Shift[] {
  return items.filter((shift) => {
    const opened = businessDateIn(timeZone, new Date(shift.openedAt));
    if (opened > businessDate) return false;
    if (!shift.closedAt || shift.status === 'OPEN') return true;
    return businessDateIn(timeZone, new Date(shift.closedAt)) >= businessDate;
  });
}

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
/** Newest shifts first; a business day's shifts sit at the top of the first page. */
const SHIFT_PAGE = 50;

export function TodaySalesDialog({ open, onClose, summary }: TodaySalesDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const reduceMotion = useReducedMotion();
  const { data: session } = useSession();
  const ownShiftsOnly = !!session?.user?.role && !isManagement(session.user.role);
  const [shifts, setShifts] = useState<ShiftsState>({ loading: false, error: null, items: null });
  const request = useRef(0);

  const load = useCallback(async () => {
    const seq = ++request.current;
    setShifts((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const page = await shiftsApi.list({ take: SHIFT_PAGE });
      if (seq === request.current) setShifts({ loading: false, error: null, items: page.items });
    } catch (error) {
      if (seq === request.current) setShifts((prev) => ({ ...prev, loading: false, error: describeApiError(error, 'Loading shifts (GET /shifts)') }));
    }
  }, []);

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
  const rows = s && shifts.items ? shiftsOnBusinessDate(shifts.items, s.businessDate, s.timezone) : null;
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
      className="!m-auto w-[calc(100%-2rem)] max-w-md overflow-visible bg-transparent p-0 text-left backdrop:bg-gray-900/50 backdrop:backdrop-blur-[2px]"
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
              /* tailwindboss-ignore focus-removed: the span inside draws the focus ring (group-focus-visible) */
              className="group -mr-2 -mt-2 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center text-gray-500 outline-none [@media(pointer:coarse)]:-mr-3 [@media(pointer:coarse)]:-mt-3 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
            >
              {/* The button is the square hit area; the circle the eye sees, and its 3px focus ring, is this span. */}
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
                  : `Differs from today's net by ${formatMoney(gap, { signed: true })}: a shift covers its whole run, which can start before today, and a refund counts in the shift that paid it out.`}
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
