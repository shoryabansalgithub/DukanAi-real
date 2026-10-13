'use client';

import React from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';

/*
 * The sheet's primitives. Shared decisions, stated once:
 * - Accent #8B5CF6 with hover #7C3AED: the app's (QuickActionsCard, CustomerFormModal).
 * - Radius 12px (`rounded-xl`, the app's --radius): cards, fields and buttons share one corner.
 * - Hover exists only under a fine pointer (`[@media(hover:hover)_and_(pointer:fine)]:hover:`); on a
 *   phone a tap would otherwise leave it stuck. Every pressable has an `active:` drawing instead.
 * - The focus ring is one outline for the whole sheet: 2px accent, offset 2 (fields: flush, see Field).
 * - `white` and the grays invert in dark mode through CSS variables (globals.css), so they carry no
 *   `dark:` variant; colours outside that scale (red, the accent as text) get one where contrast needs it.
 */

/* micro-spec: Button / primary
   role:      the one forward action of a step (Create bill, Save customer, Continue, Save bill)
   form:      rounded rectangle r 12, shared with the fields beside it; h 48: the 44px touch floor
              plus 4 so it lines up with the 48px field; full width because on a phone the column is
              the target; label 15/20 bold (CardTitle's size, the app's button weight)
   material:  flat accent fill #8B5CF6; label pinned to #fff, because `white` inverts in dark mode
              and the accent does not
   depth:     rank 2 of 2: contact 0 1 2 violet-700 @25% (it touches the sheet) + standoff
              0 4 12 -4 accent @40% (it sits proud of it); both carry the fill's hue, never black
   behaviour: hover fill #7C3AED, 150ms ease-out | press fill #6D28D9 (one more violet step),
              scale .98, standoff gone, 0ms in / 150ms out | focus: the system ring |
              disabled: gray-200 fill, gray-500 label, no shadow, no hover, no press, cursor default |
              loading: label hidden in the same grid cell, spinner shown, aria-busy, width held
   cursor:    pointer (Tailwind 3 preflight: the app's decision for every button)
   absent:    sheen, bevel, grain: the app's surfaces are flat paint; ambient: a button never floats
*/
const primaryClass =
  'grid h-12 w-full touch-manipulation select-none place-items-center rounded-xl bg-[#8B5CF6] px-5 text-[15px] font-bold leading-5 text-[#fff] [-webkit-tap-highlight-color:transparent] ' +
  'shadow-[0_1px_2px_rgba(109,40,217,0.25),0_4px_12px_-4px_rgba(139,92,246,0.4)] ' +
  'transition-[background-color,box-shadow,transform] duration-150 ease-out ' +
  '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-[#7C3AED] ' +
  'active:scale-[0.98] active:bg-[#6D28D9] active:shadow-[0_1px_2px_rgba(109,40,217,0.25)] active:duration-0 motion-reduce:active:scale-100 ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8B5CF6] ' +
  'disabled:bg-gray-200 disabled:text-gray-500 disabled:shadow-none disabled:active:scale-100';

/* micro-spec: Button / secondary
   role:      the other way forward beside a primary (Upload from files, Retake, Create another)
   form:      inherits primary's geometry (h 48, r 12, 15/20 bold) so a pair reads as one row
   material:  the sheet's own surface (bg-white) with a 1px gray-200 edge; label gray-700
   depth:     rank 1 of 2: the edge only; it lies on the sheet
   behaviour: hover fill gray-50 | press fill gray-100 + scale .98, 0ms in / 150ms out |
              focus: the system ring | disabled: n/a, never disabled
   cursor:    pointer
   absent:    shadow: a secondary is quiet by rank
*/
const secondaryClass =
  'flex h-12 w-full touch-manipulation select-none items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-5 text-[15px] font-bold leading-5 text-gray-700 [-webkit-tap-highlight-color:transparent] ' +
  'transition-[background-color,transform] duration-150 ease-out ' +
  '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-gray-50 ' +
  'active:scale-[0.98] active:bg-gray-100 active:duration-0 motion-reduce:active:scale-100 ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8B5CF6]';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

export function PrimaryButton({ busy = false, children, className = '', onClick, type = 'button', ...props }: ButtonProps & { busy?: boolean }) {
  return (
    <button
      {...props}
      type={type}
      aria-busy={busy || undefined}
      // Busy is not disabled: a disabled button would flash grey for the length of a request.
      onClick={(e) => {
        if (busy) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      className={`${primaryClass} ${className}`}
    >
      <span className={`col-start-1 row-start-1 ${busy ? 'invisible' : ''}`}>{children}</span>
      {busy && <Loader2 aria-hidden size={20} className="col-start-1 row-start-1 animate-spin" />}
    </button>
  );
}

export function SecondaryButton({ children, className = '', type = 'button', ...props }: ButtonProps) {
  return (
    <button {...props} type={type} className={`${secondaryClass} ${className}`}>
      {children}
    </button>
  );
}

/* micro-spec: Icon button / sheet header
   role:      Back and Close in the sheet header; always with an aria-label
   form:      circle (r = h/2), 44 x 44: the touch floor, the glyph 22 on the box centre
              (an arrow and a cross are symmetric, no optical shift)
   material:  bare at rest, glyph gray-500 | a gray-100 disc on hover, the glyph gray-800
   depth:     none: it is part of the header, not an object on it
   behaviour: hover disc gray-100, 150ms ease-out | press disc gray-200, 0ms in |
              focus: the system ring | disabled: n/a, hidden instead of disabled
   cursor:    pointer
   absent:    edge and shadow: a header control never competes with the step's primary
*/
export function IconButton({ label, children, className = '', ...props }: ButtonProps & { label: string }) {
  return (
    <button
      {...props}
      type="button"
      aria-label={label}
      title={label}
      className={
        'grid h-11 w-11 touch-manipulation place-items-center rounded-full text-gray-500 [-webkit-tap-highlight-color:transparent] ' +
        'transition-[background-color,color] duration-150 ease-out ' +
        '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-gray-100 [@media(hover:hover)_and_(pointer:fine)]:hover:text-gray-800 ' +
        'active:bg-gray-200 active:text-gray-800 active:duration-0 ' +
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8B5CF6] ' +
        className
      }
    >
      {children}
    </button>
  );
}

/* micro-spec: Choice row
   role:      one of the first step's two paths (Old customer, New customer); a button, not a link
   form:      full-width rounded rectangle r 12, padding 16; the 48px icon tile, its 24px glyph and
              its 12px corner are SummaryStatCard's, so the sheet speaks the dashboard's language;
              title 15/20 bold, hint 13/18 regular; a 20px chevron says it goes somewhere
   material:  sheet surface, 1px gray-200 edge (gray-100 vanishes against the white sheet);
              icon tile accent @10% on the accent glyph, the dashboard's tile recipe
   depth:     edge only: the two rows are options on the sheet, not cards floating over it
   behaviour: hover fill gray-50 + edge gray-300, 150ms ease-out | press fill gray-100, scale .99
              (a wide row scales less to travel the same few px), 0ms in |
              focus: the system ring | disabled: n/a
   cursor:    pointer
   absent:    shadow: rank is carried by order, not depth
*/
export function ChoiceRow({
  icon,
  title,
  hint,
  ...props
}: Omit<ButtonProps, 'children' | 'title'> & { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <button
      {...props}
      type="button"
      className={
        'flex w-full touch-manipulation items-center gap-4 rounded-xl border border-gray-200 bg-white p-4 text-start [-webkit-tap-highlight-color:transparent] ' +
        'transition-[background-color,border-color,transform] duration-150 ease-out ' +
        '[@media(hover:hover)_and_(pointer:fine)]:hover:border-gray-300 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-gray-50 ' +
        'active:scale-[0.99] active:bg-gray-100 active:duration-0 motion-reduce:active:scale-100 ' +
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8B5CF6]'
      }
    >
      <span aria-hidden className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[#8B5CF6]/10 text-[#8B5CF6]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-bold leading-5 text-gray-800">{title}</span>
        <span className="mt-0.5 block text-[13px] leading-[18px] text-gray-500">{hint}</span>
      </span>
      <ChevronRight aria-hidden size={20} className="shrink-0 text-gray-400" />
    </button>
  );
}

/* micro-spec: Field / text
   role:      every typed value in the sheet (search, name, phone, amount)
   form:      h 48 r 12, the buttons' height and corner; px 16; text 16/24 so iOS never zooms;
              the label sits above (12/16 bold uppercase gray-600, CustomerFormModal's), never
              placeholder-as-label; a placeholder is gray-500 (4.8:1) because it carries an example
   material:  a well on the sheet: bg-white (the base rule's field surface in both themes),
              1px gray-200 edge; caret in the accent, the one place it blinks
   depth:     none: a flat well; the page has no depth for it to go into
   behaviour: hover edge gray-300 (one step firmer), 150ms ease-out | focus: the edge takes the
              accent and a 2px accent outline sits on it (offset -1px), read as one 2px stroke |
              invalid (aria-invalid, only after submit or blur): edge and outline red-500, message
              below in text | disabled: n/a
   cursor:    text (UA default)
   absent:    shadow, inner occlusion: the app's fields are flat
*/
export const fieldClass =
  'h-12 w-full rounded-xl border border-gray-200 bg-white px-4 text-base leading-6 text-gray-800 caret-[#8B5CF6] placeholder:text-gray-500 ' +
  'transition-[border-color] duration-150 ease-out ' +
  '[@media(hover:hover)_and_(pointer:fine)]:hover:border-gray-300 ' +
  'focus-visible:border-[#8B5CF6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-[#8B5CF6] ' +
  'aria-[invalid=true]:border-red-500 aria-[invalid=true]:focus-visible:outline-red-500';

export const labelClass = 'mb-1.5 block text-xs font-bold uppercase tracking-wide text-gray-600';

/** Red-600 is 3.4:1 on the dark sheet, so dark mode takes red-400 (outside the inverted gray scale). */
export function FieldError({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="mt-1.5 text-[13px] font-medium leading-[18px] text-red-600 dark:text-red-400">
      {children}
    </p>
  );
}

/* micro-spec: Text button / inline link
   role:      a secondary way out inside a step's body ("Add a new customer", "Open Ramesh")
   form:      inline, 15/20 bold, min-height 44 for the finger; underline only on hover, 4px offset
   material:  accent text #7C3AED (5.7:1 on white; #8B5CF6 is 4.2:1), #A78BFA in dark mode
   depth:     none
   behaviour: hover underline | press text one violet step darker (#6D28D9 / #C4B5FD) |
              focus: the system ring, offset 2
   cursor:    pointer
   absent:    fill and edge: it must not read as a third button
*/
export const textButtonClass =
  'inline-flex min-h-11 touch-manipulation items-center gap-1.5 rounded-lg text-[15px] font-bold leading-5 text-[#7C3AED] underline-offset-4 [-webkit-tap-highlight-color:transparent] dark:text-[#A78BFA] ' +
  'transition-[color] duration-150 ease-out ' +
  '[@media(hover:hover)_and_(pointer:fine)]:hover:underline ' +
  'active:text-[#6D28D9] active:duration-0 dark:active:text-[#C4B5FD] ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8B5CF6]';

/* micro-spec: Result row
   role:      one customer in the search results; picking it advances to the photo
   form:      full-width row inside one bordered list (rows are not cards), min-h 56, px 16;
              name 15/20 bold truncating, phone 13/18 tabular so the numbers line up
   material:  the list's surface; rows divided by a 1px gray-100 hairline
   depth:     none: the list's edge carries the grouping
   behaviour: hover fill gray-50, 150ms ease-out | press fill gray-100, 0ms in |
              focus: ring drawn inside, 3px at -3px, because the rounded list clips its rows
   cursor:    pointer
   absent:    chevron (the whole row is the target and the list says so), avatar (no photo exists)
*/
export const resultRowClass =
  'flex min-h-14 w-full touch-manipulation items-center justify-between gap-3 bg-white px-4 py-2 text-start [-webkit-tap-highlight-color:transparent] ' +
  'transition-[background-color] duration-150 ease-out ' +
  '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-gray-50 ' +
  'active:bg-gray-100 active:duration-0 ' +
  'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-[-3px] focus-visible:outline-[#8B5CF6]';

/** The scrolling middle of a step, between the sheet header and the step's own footer; `end` when no footer follows. */
export function SheetBody({ children, end = false }: { children: React.ReactNode; end?: boolean }) {
  return (
    <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1 ${end ? 'pb-[max(1rem,env(safe-area-inset-bottom))]' : 'pb-4'}`}>
      {children}
    </div>
  );
}

/** A step's actions, kept above the home indicator. */
export function SheetFooter({ children }: { children: React.ReactNode }) {
  return <div className="flex shrink-0 flex-col gap-2 border-t border-gray-100 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">{children}</div>;
}

/* micro-spec: Customer chip - the chosen customer above the bill steps, so the cashier sees who the bill goes to.
   Its 36px initial mark inherits the choice row's tile recipe (accent @10%, accent glyph) as a circle:
   a person, not an action. Fill gray-50, no edge, no shadow: it is a read-only fact, not a control. */
export function CustomerChip({ name, phone }: { name: string; phone: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-gray-50 px-3 py-2.5">
      <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#8B5CF6]/10 text-sm font-bold text-[#8B5CF6]">
        {name.trim().charAt(0).toUpperCase() || '?'}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[15px] font-bold leading-5 text-gray-800">{name}</span>
        <span className="block text-[13px] leading-[18px] tabular-nums text-gray-500">{phone || 'No phone'}</span>
      </span>
    </div>
  );
}
