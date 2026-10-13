'use client';

import { useEffect, useId, useReducer, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import Link from 'next/link';
import { ArrowRight, Clock, Loader2, Lock, Unlock } from 'lucide-react';
import { useSession } from 'next-auth/react';
import { Card } from '@/components/ui/Card';
import { shiftsApi, type DashboardShift } from '@/lib/api-client';
import type { Shift } from '@/types';
import { DRAWER_AMOUNT_BLANK_MESSAGE, MAX_DRAWER_AMOUNT, parseDrawerAmount, type DrawerAmountRefusal } from '@/lib/drawer-amount';
import { formatMoney, formatTime } from '@/components/customers/format';
import { canUsePos } from '@/components/customers/permissions';
import { extractApiError, type ApiErrorInfo } from '@/components/pos/api-errors';
import { CardSkeletonRows, CardUnavailable } from './CardStates';

interface ShiftCardProps {
  shift: DashboardShift | null;
  loading?: boolean;
  unavailable?: boolean;
  onRetry?: () => void;
  className?: string;
}

type ShiftAction = 'open' | 'close';

type Panel =
  | { kind: 'idle'; notice: string | null }
  | { kind: 'form'; action: ShiftAction; amount: string; error: FormError | null; submitting: boolean }
  | { kind: 'result'; closed: Shift };

// An amount the card refused marks the field; a failed request leaves the typed amount standing.
type FormError = { source: 'amount' | 'request'; message: string };

type PanelEvent =
  | { type: 'start'; action: ShiftAction }
  | { type: 'edit'; amount: string }
  | { type: 'cancel' }
  | { type: 'submit' }
  | { type: 'error'; error: FormError }
  | { type: 'settled'; notice: string | null }
  | { type: 'closed'; shift: Shift };

const IDLE: Panel = { kind: 'idle', notice: null };

function panelReducer(panel: Panel, event: PanelEvent): Panel {
  const busy = panel.kind === 'form' && panel.submitting;
  switch (event.type) {
    case 'start':
      return busy ? panel : { kind: 'form', action: event.action, amount: '', error: null, submitting: false };
    case 'edit':
      return panel.kind === 'form' && !busy ? { ...panel, amount: event.amount, error: null } : panel;
    case 'cancel':
      return busy ? panel : IDLE;
    case 'submit':
      return panel.kind === 'form' ? { ...panel, error: null, submitting: true } : panel;
    case 'error':
      return panel.kind === 'form' ? { ...panel, error: event.error, submitting: false } : panel;
    case 'settled':
      return { kind: 'idle', notice: event.notice };
    case 'closed':
      return { kind: 'result', closed: event.shift };
  }
}

const REFUSAL_MESSAGE: Record<Exclude<DrawerAmountRefusal, 'blank'>, string> = {
  'not-a-number': 'Enter the amount in digits, for example 500 or 1250.50.',
  negative: 'The amount cannot be negative.',
  'too-precise': 'Use at most 2 decimal places.',
  'too-large': `That is more than ${formatMoney(MAX_DRAWER_AMOUNT)}. Check the amount.`,
};

function refusalMessage(action: ShiftAction, reason: DrawerAmountRefusal): string {
  return reason === 'blank' ? DRAWER_AMOUNT_BLANK_MESSAGE[action] : REFUSAL_MESSAGE[reason];
}

const FORM_COPY: Record<ShiftAction, { label: string; submit: string; busy: string }> = {
  open: { label: 'Opening cash in drawer', submit: 'Open shift', busy: 'Opening…' },
  close: { label: 'Cash counted in drawer', submit: 'Close shift', busy: 'Closing…' },
};

const ALREADY_OPEN_NOTICE = 'A shift was already open for you, so no new one was started.';
const ALREADY_CLOSED_NOTICE = 'This shift was already closed on another screen. Nothing was changed.';

// The shared extractor names the route and the API's address: right for a developer, noise for a cashier.
function requestFailureMessage(info: ApiErrorInfo): string {
  if (info.isTimeout) return 'The server did not answer in time. Try again: if it went through, the card will say so.';
  if (info.isNetwork) return 'Could not reach the server. Check the connection and try again.';
  return info.message;
}

type FocusTarget = 'field' | 'trigger' | 'done';

/* micro-spec: Button / primary
   role:      the action the card exists for: the Open shift trigger and both form submits (Open shift,
              Close shift), one material for the pair because opening and closing are mirror actions.
   form:      h-10 (40px) on fine pointers, h-11 (44px) on coarse; radius 8px (0.2h: reads as a rectangle
              beside the 12px card, matches the app's inputs); full width (the column is the target); in a form it
              stacks above Cancel at every width, so reading order, tab order and the visual order agree
              (two side by side do not fit the lg card's ~166px inside);
              14px bold label, 14px lucide icon, gap 6px.
   material:  flat accent fill #7C3AED, label literal #fff: white on the brand #8B5CF6 measures 4.23:1 (under AA
              for 14px), on #7C3AED it clears 4.5:1; text-white is a variable that turns #111827 in dark mode, #fff
              holds in both themes. No bevel (the app's surfaces are flat).
   depth:     flat: it sits on the card. A lone shadow-sm line was tried and failed the subtraction test.
   behaviour: hover (real hover only) fill #6D28D9; press fill #5B21B6 + scale 0.98 in 0ms, release 150ms
              ease-out on background-color and transform (the scale is opt-in motion-safe: reduced motion keeps the fill only); busy: spinner + busy label stacked in the same grid
              cell as the label so the width holds, aria-busy, disabled: rest fill, no hover, no press;
              focus-visible: 2px #8B5CF6 outline at 2px offset.
   cursor:    system default (a button, not a link); default while disabled.
   absent:    border (the fill is the edge); gradient (one flat accent across the app).
*/
const PRIMARY_BUTTON =
  'grid w-full h-10 place-items-center rounded-[8px] px-4 text-sm font-bold transition-[background-color] motion-safe:transition-[background-color,transform] duration-150 ease-out motion-safe:enabled:active:scale-[0.98] enabled:active:duration-0 disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8B5CF6] dark:focus-visible:outline-[#A78BFA] [@media(pointer:coarse)]:h-11';
const ACCENT_FILL = 'bg-[#7C3AED] text-[#fff] [@media(hover:hover)]:enabled:hover:bg-[#6D28D9] enabled:active:!bg-[#5B21B6]';

/* Press fills are !important: Tailwind 3 emits the [@media(hover:hover)] hover rule after active:, so
   without it a pressed button under a mouse kept its hover fill. */
/* micro-spec: Button / secondary
   role:      the way back or the second action: Cancel, Done, and the Close shift trigger (the open card's
              figures are its content, so its one action sits a rank below the closed card's Open shift).
   form:      same ladder as primary (h-10 / coarse h-11, radius 8px, 14px bold label, 14px icon, gap 6px).
   material:  the ground's own surface (white) and a 1px gray-200 edge; gray-700 label.
   depth:     flat, one rank below primary: no shadow.
   behaviour: hover (real hover only) fill gray-100; press fill gray-200 + scale 0.98 in 0ms, release 150ms
              (gray-50 moved 6/255 off white, too faint to read as a state)
              ease-out; disabled (Cancel while submitting): label gray-400, no hover, no press, so it reads as
              unavailable; focus-visible: 2px #8B5CF6 outline, 2px offset.
   cursor:    system default; default while disabled.
   absent:    shadow (it must not compete with the primary); accent colour (reserved for the primary).
*/
const SECONDARY_BUTTON =
  'inline-flex w-full h-10 items-center justify-center gap-1.5 rounded-[8px] border px-4 text-sm font-bold transition-[background-color] motion-safe:transition-[background-color,transform] duration-150 ease-out motion-safe:enabled:active:scale-[0.98] enabled:active:duration-0 disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8B5CF6] dark:focus-visible:outline-[#A78BFA] [@media(pointer:coarse)]:h-11';
const NEUTRAL_FILL =
  'border-gray-200 bg-white text-gray-700 [@media(hover:hover)]:enabled:hover:bg-gray-100 enabled:active:!bg-gray-200 disabled:text-gray-400';

/* micro-spec: Field / amount
   role:      the cash figure the cashier types: opening float or the counted drawer.
   form:      h-10 / coarse h-11, the buttons' height; radius 8px; ₹ inside at 12px from the start edge,
              value from 28px; bold tabular figures, 16px on coarse pointers (iOS zooms a focused field under
              16px) and 14px on fine ones (the buttons' size; 16 sat 1px off the 15px heading);
              type text + inputMode decimal so "1,25,000" is accepted.
   material:  a well: white surface, 1px gray-200 edge, gray-800 value, gray-400 placeholder "0.00",
              accent caret.
   depth:     flat, level with the card.
   behaviour: hover edge gray-300 (refused: red-500 to red-600), 150ms ease-out; focus edge #8B5CF6 and a 2px #8B5CF6 outline at offset 0 so edge and ring
              read as one stroke; refused: edge and ring red-500, the message under the field (role=alert,
              aria-describedby, aria-invalid); a failed request leaves the field neutral.
   cursor:    text (the browser's).
   absent:    inner occlusion shadow (the app's fields are flat); help text (the label says it all).
*/
const FIELD_BASE =
  'block w-full h-10 rounded-[8px] border bg-white transition-[border-color] duration-150 ease-out pe-3 ps-7 text-base font-bold tabular-nums [@media(pointer:fine)]:text-sm text-gray-800 caret-[#8B5CF6] placeholder:text-gray-400 focus:outline focus:outline-2 focus:outline-offset-0 [@media(pointer:coarse)]:h-11';
const FIELD_STATE = {
  valid: 'border-gray-200 hover:border-gray-300 focus:border-[#8B5CF6] focus:outline-[#8B5CF6] dark:focus:border-[#A78BFA] dark:focus:outline-[#A78BFA]',
  refused: 'border-red-500 hover:border-red-600 focus:outline-red-500',
} as const;

/* micro-spec: Link / card footer
   role:      navigation out of the card (Billing, the shifts page); never an action on the shift.
   form:      12px label, 4px of side padding and the vertical padding cancelled by negative margins so the
              footer line does not move: 24px tall on fine pointers (WCAG 2.5.8), 44px on coarse; 4px radius for the focus outline.
   material:  text only. Billing in #7C3AED: the dashboard's #8B5CF6 measures 4.23:1 on white at 12px; dark
              mode #A78BFA (#8B5CF6 measured 4.19:1 on the dark card).
   depth:     none.
   behaviour: hover (real hover only) one step darker; press two steps darker (important: Tailwind 3 emits the
              media-wrapped hover after active) plus a tint behind the label, because a colour step alone on 12px
              glyphs did not read as pressed; colour and tint 150ms ease-out, press in 0ms. Dark mode: the gray
              link rests at #9CA3AF (gray-500 inverts to near-white and outweighed the violet link beside it);
              focus-visible: the system 2px #8B5CF6 outline at 2px offset.
   cursor:    pointer (a link).
   absent:    underline (the arrow and colour already say link), a resting background.
*/
const FOOTER_LINK =
  'flex items-center gap-1 -mx-1 -my-1 rounded-[4px] px-1 py-1 [@media(pointer:coarse)]:-my-3.5 [@media(pointer:coarse)]:py-3.5 text-xs transition-[color,background-color] duration-150 ease-out active:duration-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8B5CF6] dark:focus-visible:outline-[#A78BFA]';

/* micro-spec: List / closed shift result
   role:      what the close settled: expected against counted, the variance, the day's sales.
   form:      the card's dl grammar: 12px rows 6px apart, label left, figure right; the variance row sits
              under a 1px gray-100 rule with 6px above the text.
   material:  text only: gray-500 labels, semibold gray-800 figures in the open card's money format;
              variance green-600 balanced, blue-600 over, red-600 short, said once: the word carries the
              sign ("Short ₹20"), so colour is not the only signal.
   depth:     none, it is read on the card.
   behaviour: static.
   cursor:    none.
   absent:    background, borders around rows, motion.
*/
const VARIANCE = {
  balanced: { word: 'Balanced', tone: 'text-green-600 dark:text-green-400' },
  over: { word: 'Over', tone: 'text-blue-600 dark:text-blue-400' },
  short: { word: 'Short', tone: 'text-red-600 dark:text-red-400' },
} as const;

function varianceOf(value: number | null) {
  const variance = value ?? 0;
  const kind = variance === 0 ? VARIANCE.balanced : variance > 0 ? VARIANCE.over : VARIANCE.short;
  return { ...kind, amount: variance === 0 ? null : formatMoney(Math.abs(variance)) };
}

/** The caller's OPEN shift from `GET /dashboard/summary`, opened and closed in place. */
export function ShiftCard({ shift, loading = false, unavailable = false, onRetry, className = '' }: ShiftCardProps) {
  const { data: session, status: sessionStatus } = useSession();
  const canAct = sessionStatus === 'loading' || canUsePos(session?.user?.role);

  const [panel, dispatch] = useReducer(panelReducer, IDLE);
  const [announcement, setAnnouncement] = useState('');

  // A mutation's own answer shows at once; it gives way as soon as the summary (refreshed through onRetry)
  // names the same shift, so a later change from another screen shows through again.
  const [local, setLocal] = useState<{ shift: DashboardShift | null } | null>(null);
  const overriding = local !== null && (shift?.id ?? null) !== (local.shift?.id ?? null);
  const displayed = overriding ? local.shift : shift;
  useEffect(() => {
    if (local !== null && !overriding) setLocal(null);
  }, [local, overriding]);

  const fieldRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<FocusTarget | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    const refs: Record<FocusTarget, RefObject<HTMLElement | null>> = { field: fieldRef, trigger: triggerRef, done: doneRef };
    refs[target].current?.focus();
  });

  const send = (event: PanelEvent, focus: FocusTarget | null = null) => {
    focusNext.current = focus;
    dispatch(event);
  };

  const start = (action: ShiftAction) => {
    setAnnouncement('');
    send({ type: 'start', action }, 'field');
  };

  const fail = (info: ApiErrorInfo) => send({ type: 'error', error: { source: 'request', message: requestFailureMessage(info) } }, 'field');

  const settle = (shown: DashboardShift | null, event: PanelEvent, focus: FocusTarget) => {
    setLocal({ shift: shown });
    send(event, focus);
    onRetry?.();
  };

  const openShift = async (openingCash: number) => {
    try {
      settle(await shiftsApi.open(openingCash), { type: 'settled', notice: null }, 'trigger');
      setAnnouncement('Shift opened.');
    } catch (err) {
      const info = extractApiError(err, 'Opening shift (POST /shifts/open)');
      if (info.code !== 'SHIFT_ALREADY_OPEN') return fail(info);
      try {
        const current = await shiftsApi.current();
        settle(current, { type: 'settled', notice: current ? ALREADY_OPEN_NOTICE : null }, 'trigger');
      } catch (currentErr) {
        fail(extractApiError(currentErr, 'Loading current shift (GET /shifts/current)'));
      }
    }
  };

  const closeShift = async (closingCash: number) => {
    try {
      const closed = await shiftsApi.close({ closingCash });
      settle(null, { type: 'closed', shift: closed }, 'done');
      setAnnouncement('Shift closed.');
    } catch (err) {
      const info = extractApiError(err, 'Closing shift (POST /shifts/current/close)');
      if (info.code !== 'SHIFT_NOT_FOUND') return fail(info);
      settle(null, { type: 'settled', notice: ALREADY_CLOSED_NOTICE }, 'trigger');
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (panel.kind !== 'form' || panel.submitting) return;
    const parsed = parseDrawerAmount(panel.amount);
    if (!parsed.ok) {
      send({ type: 'error', error: { source: 'amount', message: refusalMessage(panel.action, parsed.reason) } }, 'field');
      return;
    }
    send({ type: 'submit' });
    void (panel.action === 'open' ? openShift(parsed.value) : closeShift(parsed.value));
  };

  if (loading || unavailable) {
    return (
      <Card className={`flex flex-col justify-between p-5 ${className}`}>
        <div>
          <h3 className="mb-3 flex items-center gap-2 text-[15px] font-bold text-gray-800">
            <Clock size={16} className="text-gray-400" /> Shift
          </h3>
          {loading ? (
            <CardSkeletonRows rows={4} />
          ) : (
            <CardUnavailable message="Your shift status could not be loaded." onRetry={onRetry} />
          )}
        </div>
      </Card>
    );
  }

  const form = (action: ShiftAction) =>
    panel.kind === 'form' && panel.action === action ? (
      <AmountForm
        panel={panel}
        fieldRef={fieldRef}
        onEdit={(amount) => send({ type: 'edit', amount })}
        onCancel={() => send({ type: 'cancel' }, 'trigger')}
        onSubmit={submit}
      />
    ) : null;

  const isOpen = panel.kind !== 'result' && displayed !== null;
  const notice = panel.kind === 'idle' && panel.notice && (
    <p role="status" className="mt-3 rounded-[8px] border border-gray-200 bg-gray-50 px-3 py-2 text-xs font-medium text-gray-700">
      {panel.notice}
    </p>
  );
  let body: ReactNode;

  if (panel.kind === 'result') {
    const { closed } = panel;
    const variance = varianceOf(closed.variance);
    body = (
      <>
        <h3 className="flex items-center gap-2 text-[15px] font-bold text-gray-800">
          <Lock size={16} className="text-gray-400" /> Shift closed
        </h3>
        <dl className="mt-4 space-y-1.5 text-xs">
          <div className="flex items-center justify-between">
            <dt className="text-gray-500">Expected cash</dt>
            <dd className="font-semibold text-gray-800">{formatMoney(closed.expectedCash)}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-gray-500">Counted cash</dt>
            <dd className="font-semibold text-gray-800">{formatMoney(closed.closingCash ?? 0)}</dd>
          </div>
          <div className="flex items-center justify-between border-t border-gray-100 pt-1.5">
            <dt className="text-gray-500">Variance</dt>
            <dd className={`flex items-center gap-1.5 font-semibold ${variance.tone}`}>
              <span>{variance.word}</span>
              {variance.amount && <span>{variance.amount}</span>}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-gray-500">Total sales</dt>
            <dd className="font-semibold text-gray-800">{formatMoney(closed.totalSales)}</dd>
          </div>
        </dl>
        <button
          ref={doneRef}
          type="button"
          onClick={() => send({ type: 'settled', notice: null }, 'trigger')}
          className={`mt-4 ${SECONDARY_BUTTON} ${NEUTRAL_FILL}`}
        >
          Done
        </button>
      </>
    );
  } else if (displayed === null) {
    body = (
      <>
        <h3 className="flex items-center gap-2 text-[15px] font-bold text-gray-800">
          <Clock size={16} className="text-gray-400" /> Shift
        </h3>
        {form('open') ?? (
          <>
            {notice}
            <p className="mt-3 text-sm text-gray-600">No shift is open for you right now.</p>
            {canAct && (
              <>
                <p className="mt-1 text-xs text-gray-500">Open one here before taking cash so the drawer can be reconciled.</p>
                <button
                  ref={triggerRef}
                  type="button"
                  onClick={() => start('open')}
                  className={`mt-4 ${PRIMARY_BUTTON} ${ACCENT_FILL}`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Unlock size={14} /> Open shift
                  </span>
                </button>
              </>
            )}
          </>
        )}
      </>
    );
  } else {
    const tenders = [
      { label: 'Cash', amount: displayed.cashSales },
      { label: 'UPI', amount: displayed.upiSales },
      { label: 'Card', amount: displayed.cardSales },
      { label: 'Udhar', amount: displayed.udharSales },
    ];
    const closeForm = form('close');
    body = (
      <>
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-[15px] font-bold text-gray-800">
            <Clock size={16} className="text-green-500" /> Open shift
          </h3>
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700 dark:bg-green-900/30 dark:text-green-400">{displayed.status}</span>
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          Opened {formatTime(displayed.openedAt)}{displayed.openedBy ? ` by ${displayed.openedBy.name}` : ''}
        </p>
        {notice}

        <div className="mt-4">
          <p className="text-xs font-medium text-gray-500">Expected cash in drawer</p>
          <p className="text-2xl font-bold tracking-tight text-gray-800">{formatMoney(displayed.expectedCash)}</p>
          <p className="text-[10px] text-gray-500">Opening {formatMoney(displayed.openingCash)} · Receipts {formatMoney(displayed.totalReceipts)}</p>
        </div>

        {closeForm ?? (
          <>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              {tenders.map((tender) => (
                <div key={tender.label} className="flex items-center justify-between">
                  <dt className="text-gray-500">{tender.label}</dt>
                  <dd className="font-semibold text-gray-800">{formatMoney(tender.amount)}</dd>
                </div>
              ))}
              <div className="col-span-2 mt-1 flex items-center justify-between border-t border-green-100 pt-1.5 dark:border-green-800/40">
                <dt className="font-medium text-gray-600">Total sales</dt>
                <dd className="font-bold text-gray-800">{formatMoney(displayed.totalSales)}</dd>
              </div>
            </dl>
            {canAct && (
              <button
                ref={triggerRef}
                type="button"
                onClick={() => start('close')}
                className={`mt-4 ${SECONDARY_BUTTON} ${NEUTRAL_FILL}`}
              >
                <Lock size={14} /> Close shift
              </button>
            )}
          </>
        )}
      </>
    );
  }

  return (
    <Card
      className={`flex flex-col justify-between p-5 ${isOpen ? 'border-green-100 bg-gradient-to-br from-green-50/60 to-white dark:border-green-800/40 dark:from-green-900/20' : ''} ${className}`}
    >
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <div>{body}</div>
      <div className={`mt-4 flex items-center justify-between border-t pt-3 ${isOpen ? 'border-green-100 dark:border-green-800/40' : 'border-gray-100'}`}>
        <Link href="/billing" className={`${FOOTER_LINK} font-bold text-[#7C3AED] [@media(hover:hover)]:hover:text-[#6D28D9] active:!text-[#5B21B6] active:bg-[#7C3AED]/10 dark:text-[#A78BFA] dark:[@media(hover:hover)]:hover:text-[#C4B5FD] dark:active:!text-[#DDD6FE] dark:active:bg-[#A78BFA]/15`}>
          Go to Billing <ArrowRight size={12} />
        </Link>
        <Link href="/shifts" className={`${FOOTER_LINK} font-semibold text-gray-500 [@media(hover:hover)]:hover:text-gray-800 active:!text-gray-900 active:bg-gray-100 dark:text-[#9CA3AF] dark:[@media(hover:hover)]:hover:text-[#F3F4F6] dark:active:!text-[#FFFFFF]`}>
          {isOpen ? 'Manage shift' : 'Shift history'}
        </Link>
      </div>
    </Card>
  );
}

type FormPanel = Extract<Panel, { kind: 'form' }>;

interface AmountFormProps {
  panel: FormPanel;
  fieldRef: RefObject<HTMLInputElement | null>;
  onEdit: (amount: string) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function AmountForm({ panel, fieldRef, onEdit, onCancel, onSubmit }: AmountFormProps) {
  const fieldId = useId();
  const errorId = useId();
  const copy = FORM_COPY[panel.action];
  const Icon = panel.action === 'open' ? Unlock : Lock;

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Escape' || panel.submitting) return;
    event.preventDefault();
    onCancel();
  };

  return (
    <form noValidate onSubmit={onSubmit} onKeyDown={onKeyDown} className="mt-4">
      <label htmlFor={fieldId} className="mb-1.5 block text-xs font-medium text-gray-600">
        {copy.label}
      </label>
      <div className="relative">
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-base font-bold text-gray-500 [@media(pointer:fine)]:text-sm">
          ₹
        </span>
        <input
          ref={fieldRef}
          id={fieldId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="done"
          placeholder="0.00"
          value={panel.amount}
          onChange={(event) => onEdit(event.target.value)}
          readOnly={panel.submitting}
          aria-invalid={panel.error?.source === 'amount' ? true : undefined}
          aria-describedby={panel.error ? errorId : undefined}
          className={`${FIELD_BASE} ${panel.error?.source === 'amount' ? FIELD_STATE.refused : FIELD_STATE.valid}`}
        />
      </div>
      {panel.error && (
        <p id={errorId} role="alert" className="mt-1.5 text-xs font-medium text-red-600 dark:text-red-400">
          {panel.error.message}
        </p>
      )}
      <div className="mt-3 grid gap-2">
        <button
          type="submit"
          disabled={panel.submitting}
          aria-busy={panel.submitting}
          className={`${PRIMARY_BUTTON} ${ACCENT_FILL}`}
        >
          <span className={`inline-flex items-center gap-1.5 [grid-area:1/1] ${panel.submitting ? 'invisible' : ''}`}>
            <Icon size={14} /> {copy.submit}
          </span>
          <span className={`inline-flex items-center gap-1.5 [grid-area:1/1] ${panel.submitting ? '' : 'invisible'}`}>
            <Loader2 size={14} className={panel.submitting ? 'animate-spin motion-reduce:animate-none' : ''} /> {copy.busy}
          </span>
        </button>
        <button type="button" onClick={onCancel} disabled={panel.submitting} className={`${SECONDARY_BUTTON} ${NEUTRAL_FILL}`}>
          Cancel
        </button>
      </div>
    </form>
  );
}
