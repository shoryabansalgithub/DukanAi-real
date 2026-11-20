'use client';

import { useEffect, useRef } from 'react';

export type HotkeyHandler = (event: KeyboardEvent) => void;

/**
 * Map of `KeyboardEvent.key` values (e.g. "F2", "Escape") to handlers.
 * Function keys are always intercepted (even while typing in an input) and
 * their browser default is prevented; other keys are left to the focused
 * element unless `alwaysKeys` includes them.
 */
export type HotkeyMap = Partial<Record<string, HotkeyHandler>>;

export interface HotkeysOptions {
  enabled?: boolean;
  /** Keys handled even when focus is inside an input / textarea / select. Function keys and Escape always are. */
  alwaysKeys?: string[];
}

const FUNCTION_KEY = /^F\d{1,2}$/;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Global POS hotkeys. Recommended bindings:
 *   F2 focus product search · F4 focus customer · F8 open payment ·
 *   F9 hold cart · Escape close panels.
 * Enter inside the payment panel is handled by the panel itself.
 */
export function useHotkeys(map: HotkeyMap, options: HotkeysOptions = {}): void {
  const { enabled = true, alwaysKeys = [] } = options;
  const mapRef = useRef(map);
  mapRef.current = map;
  const alwaysRef = useRef(alwaysKeys);
  alwaysRef.current = alwaysKeys;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      const handler = mapRef.current[event.key];
      if (!handler) return;

      const isFn = FUNCTION_KEY.test(event.key);
      const always = isFn || event.key === 'Escape' || alwaysRef.current.includes(event.key);
      if (!always && isEditable(event.target)) return;

      if (isFn) event.preventDefault();
      handler(event);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled]);
}
