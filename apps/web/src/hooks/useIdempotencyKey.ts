'use client';

import { useCallback, useEffect } from 'react';
import { usePosStore } from '@/store/pos';

interface UseIdempotencyKeyReturn {
  /** The current key. `null` only for the first client render before the effect runs. */
  key: string | null;
  /** Rotates to a brand-new key (IDEMPOTENCY_KEY_REUSED recovery). */
  rotate: () => string;
  /** Returns the current key, generating one synchronously when there is none. */
  ensure: () => string;
  /** Clears the key after a successful submit; a fresh one is generated immediately. */
  consume: () => void;
}

/**
 * Idempotency key for the POS invoice submit, derived from the POS store
 * (persisted per tab / per shop in sessionStorage).
 *
 * A fresh key is generated whenever there is none — on first use and
 * immediately after a success consumes it — so a retry after a network
 * failure reuses the same key while every new sale gets its own.
 */
export function useIdempotencyKey(): UseIdempotencyKeyReturn {
  const key = usePosStore((s) => s.idempotencyKey);
  const newIdempotencyKey = usePosStore((s) => s.newIdempotencyKey);
  const ensureIdempotencyKey = usePosStore((s) => s.ensureIdempotencyKey);
  const consumeIdempotencyKey = usePosStore((s) => s.consumeIdempotencyKey);

  // Never write before the persisted cart is read (roadmap 6.5): this effect
  // runs before the page's hydration effect, and a write into an unhydrated
  // store persists the empty state over whatever the tab had saved. Wait for
  // the hydration (and for every later scope switch) before ensuring a key.
  useEffect(() => {
    if (key) return;
    if (usePosStore.persist.hasHydrated()) {
      ensureIdempotencyKey();
      return;
    }
    return usePosStore.persist.onFinishHydration(() => {
      if (!usePosStore.getState().idempotencyKey) ensureIdempotencyKey();
    });
  }, [key, ensureIdempotencyKey]);

  const rotate = useCallback(() => newIdempotencyKey(), [newIdempotencyKey]);
  const ensure = useCallback(() => ensureIdempotencyKey(), [ensureIdempotencyKey]);
  const consume = useCallback(() => consumeIdempotencyKey(), [consumeIdempotencyKey]);

  return { key, rotate, ensure, consume };
}
