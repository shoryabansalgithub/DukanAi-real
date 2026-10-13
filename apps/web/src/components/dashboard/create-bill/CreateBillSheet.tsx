'use client';

import { useEffect, useReducer, useRef } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { STEP_TITLES, currentStep, flowReducer, initialFlow } from './flow';
import { IconButton } from './ui';
import { ChooseStep } from './ChooseStep';
import { SearchStep } from './SearchStep';
import { NewCustomerStep } from './NewCustomerStep';
import { PhotoStep } from './PhotoStep';
import { AmountStep } from './AmountStep';
import { SavedStep } from './SavedStep';

/* micro-spec: Sheet / bottom
   role:      the Create bill flow over the dashboard, on a phone; a native modal <dialog>
              (inert page, focus kept inside, Escape, focus back to the opener on close)
   form:      full width up to 512 (a landscape phone keeps a readable column), anchored to the
              bottom, top corners r 16 (one step above the 12px controls inside: the container
              is the larger shape); at most 90dvh so the dashboard still shows above it;
              header 56 = the 44px icon buttons + 6px each side; title 16/24 bold, centred
   material:  the app's card surface (bg-white, which inverts in dark mode); a 1px gray-100
              hairline under the header, and over each step's footer, where the body scrolls
   depth:     the top layer; the backdrop (black @50%) does the separating
   behaviour: enter: slide up 100% + fade, 280ms cubic-bezier(.32,.72,0,1) (the iOS sheet curve,
              shortened because this opens many times a day); reduced motion: fade only |
              exit: instant (the user has moved on) | backdrop fades in with the sheet |
              tap on the backdrop, Close or Escape closes, except while a save is in flight
   cursor:    n/a
   absent:    grabber (there is no drag gesture to promise); cast shadow (invisible on the
              backdrop, fails the subtraction test)
*/
export function CreateBillSheet({ open, onClosed }: { open: boolean; onClosed: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const stepRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const [flow, dispatch] = useReducer(flowReducer, initialFlow);
  const step = currentStep(flow);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const target = stepRef.current?.querySelector<HTMLElement>('[data-autofocus]') ?? titleRef.current;
    target?.focus();
  }, [open, step]);

  const close = () => {
    if (!busy.current) dialogRef.current?.close();
  };

  const canGoBack = flow.stack.length > 1 && step !== 'saved';

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="create-bill-title"
      onCancel={(e) => {
        if (busy.current) e.preventDefault();
      }}
      onClose={() => {
        dispatch({ type: 'reset' });
        onClosed();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className={
        'fixed inset-x-0 bottom-0 top-auto mx-auto my-0 max-h-[90dvh] w-full max-w-lg flex-col overflow-clip rounded-t-2xl border-0 bg-white p-0 text-gray-800 open:flex ' +
        'animate-in fade-in slide-in-from-bottom duration-[280ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:slide-in-from-bottom-0 ' +
        'backdrop:bg-black/50 backdrop:animate-in backdrop:fade-in backdrop:duration-[280ms]'
      }
    >
      <header className="grid h-14 shrink-0 grid-cols-[44px_1fr_44px] items-center gap-2 border-b border-gray-100 px-1.5">
        {canGoBack ? (
          <IconButton label="Back" onClick={() => dispatch({ type: 'back' })}>
            <ArrowLeft aria-hidden size={22} />
          </IconButton>
        ) : (
          <span aria-hidden />
        )}
        {/* tailwindboss-ignore focus-removed: the title is focused only to anchor screen readers on the new step; it is not a control, and a ring around it read as one */}
        <h2 id="create-bill-title" ref={titleRef} tabIndex={-1} className="truncate text-center text-base font-bold leading-6 text-gray-800 outline-none">
          {STEP_TITLES[step]}
        </h2>
        <IconButton label="Close" onClick={close}>
          <X aria-hidden size={22} />
        </IconButton>
      </header>

      <div ref={stepRef} className="flex min-h-0 flex-1 flex-col pt-3">
        {step === 'choose' && <ChooseStep dispatch={dispatch} />}
        {step === 'search' && <SearchStep query={flow.query} dispatch={dispatch} />}
        {step === 'new' && <NewCustomerStep draft={flow.draft} dispatch={dispatch} />}
        {step === 'photo' && flow.customer && <PhotoStep customer={flow.customer} photo={flow.photo} dispatch={dispatch} />}
        {step === 'amount' && flow.customer && flow.photo && (
          <AmountStep
            customer={flow.customer}
            photo={flow.photo}
            amount={flow.amount}
            dispatch={dispatch}
            onBusy={(value) => {
              busy.current = value;
            }}
          />
        )}
        {step === 'saved' && flow.customer && flow.photo && flow.savedPaise !== null && (
          <SavedStep
            customer={flow.customer}
            photo={flow.photo}
            paise={flow.savedPaise}
            onDone={close}
            onAnother={() => dispatch({ type: 'reset' })}
          />
        )}
      </div>
    </dialog>
  );
}
