'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { ChevronDown, LoaderCircle, LogOut, Store } from 'lucide-react';
import type { Session } from 'next-auth';
import { signOutEverywhere } from '@/lib/sign-out';
import { ROLE_LABELS, shopApi } from '@/lib/api-client';

type ProfileUser = Session['user'];

/** `undefined` until the popup first opens, `null` when the shop could not be read (the row is left out). */
type ShopName = string | null | undefined;

function initialOf(user: ProfileUser): string {
  return (user.name || user.email || 'U').trim().slice(0, 1).toUpperCase();
}

/**
 * The signed-in user's control in the top bar: name and avatar open a popup
 * with who is signed in (name, email, role, shop) and Sign out as its last
 * item. It closes on a click outside, Escape, focus leaving it, or the
 * trigger again; sign-out happens only from the button inside.
 */
export function ProfileMenu({ user }: { user: ProfileUser }) {
  const [open, setOpen] = useState(false);
  const [shopName, setShopName] = useState<ShopName>(undefined);
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const shopRequested = useRef(false);
  const mounted = useRef(false);
  const panelId = useId();
  const titleId = useId();
  const reduceMotion = useReducedMotion();

  const displayName = user.name || user.email || 'Account';
  const email = user.name ? user.email : null;
  const roleLabel = user.role ? (ROLE_LABELS[user.role] ?? user.role) : null;

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The shop name is not on the session: read it once, the first time the popup opens.
  // Closing the popup mid-request keeps the answer for the next open; only an unmount drops it.
  useEffect(() => {
    if (!open || shopRequested.current) return;
    shopRequested.current = true;
    shopApi
      .me()
      .then((shop) => mounted.current && setShopName(shop.name.trim() || null))
      .catch(() => mounted.current && setShopName(null));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Focus the panel, not Sign out: a second Enter after opening must not end the session.
    panelRef.current?.focus({ preventScroll: true });

    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOutEverywhere('/login');
    } catch {
      setSigningOut(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className="relative pl-3 border-l border-gray-100"
      onBlur={(event) => {
        // Tabbing past the last item closes the popup; a click elsewhere is handled by mousedown.
        const next = event.relatedTarget as Node | null;
        if (open && next && !event.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${displayName}, account`}
        className="group flex items-center gap-2.5 rounded-xl p-1.5 sm:pl-3 transition-colors hover:bg-gray-50 aria-expanded:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <span className="hidden sm:block max-w-[12rem] truncate text-[13px] font-bold leading-tight text-gray-800">
          {displayName}
        </span>
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-violet-100 text-sm font-bold text-violet-700"
        >
          {initialOf(user)}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={2.25}
          aria-hidden="true"
          className="-ml-1 text-gray-400 transition-transform duration-200 ease-out group-hover:text-gray-600 group-aria-expanded:rotate-180 group-aria-expanded:text-gray-600 motion-reduce:transition-none"
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
            animate={{
              opacity: 1,
              scale: 1,
              y: 0,
              transition: { duration: 0.16, ease: [0.2, 0, 0, 1] },
            }}
            exit={
              reduceMotion
                ? { opacity: 0 }
                : {
                    opacity: 0,
                    scale: 0.98,
                    y: -2,
                    transition: { duration: 0.1, ease: [0.4, 0, 1, 1] },
                  }
            }
            // Grows out of the avatar it hangs from.
            className="absolute right-0 top-full z-50 mt-[1.125rem] w-[min(18rem,calc(100vw-2rem))] origin-top-right overflow-hidden rounded-xl border border-gray-100 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_16px_40px_-12px_rgba(15,23,42,0.28)] focus:outline-none"
          >
            <div className="flex items-center gap-3 px-4 pt-4 pb-3">
              <span
                aria-hidden="true"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-violet-100 text-[15px] font-bold text-violet-700"
              >
                {initialOf(user)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p
                    id={titleId}
                    className="min-w-0 truncate text-sm font-bold leading-5 text-gray-800"
                    title={displayName}
                  >
                    {displayName}
                  </p>
                  {roleLabel && (
                    <span className="shrink-0 rounded-full bg-primary/10 px-2 py-px text-[11px] font-bold leading-4 text-primary">
                      {roleLabel}
                    </span>
                  )}
                </div>
                {email && (
                  <p className="truncate text-xs leading-4 text-gray-500" title={email}>
                    {email}
                  </p>
                )}
              </div>
            </div>

            {shopName !== null && (
              <div className="mx-2 mb-2 flex items-center gap-3 rounded-xl bg-gray-50 p-2 ring-1 ring-inset ring-gray-100">
                <span
                  aria-hidden="true"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-white text-gray-500 ring-1 ring-gray-100 shadow-[0_1px_2px_rgba(15,23,42,0.08)]"
                >
                  <Store size={18} strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] leading-4 text-gray-500">Signed in to</p>
                  {shopName === undefined ? (
                    <span
                      className="skeleton-pulse mt-1 block h-3.5 w-28 rounded bg-gray-200"
                      aria-label="Loading shop"
                    />
                  ) : (
                    <p
                      className="truncate text-[13px] font-semibold leading-5 text-gray-800"
                      title={shopName}
                    >
                      {shopName}
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="border-t border-gray-100 p-1.5">
              <button
                type="button"
                onClick={() => void handleSignOut()}
                disabled={signingOut}
                aria-busy={signingOut || undefined}
                className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13px] font-semibold text-red-600 dark:text-red-400 transition-colors hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 disabled:cursor-progress disabled:opacity-70"
              >
                {/* A 40px slot: the icon sits in the avatar's column and the label in the text column above. */}
                <span aria-hidden="true" className="flex w-10 shrink-0 justify-center">
                  {signingOut ? (
                    <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" />
                  ) : (
                    <LogOut size={16} />
                  )}
                </span>
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
