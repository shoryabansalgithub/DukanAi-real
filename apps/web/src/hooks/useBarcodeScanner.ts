'use client';

import { useEffect, useRef } from 'react';

export interface BarcodeScannerOptions {
  /** Disable the listener (e.g. before the POS knows its shop). */
  enabled?: boolean;
  /** Minimum number of printable characters in a burst. Default 4. */
  minLength?: number;
  /** Maximum gap between two keystrokes for them to count as one burst, in ms. Default 50. */
  maxIntervalMs?: number;
}

const DEFAULT_MIN_LENGTH = 4;
const DEFAULT_MAX_INTERVAL = 50;
/** Scanners send Enter right after the last digit; humans take much longer. */
const ENTER_GRACE_MS = 120;

type TextField = HTMLInputElement | HTMLTextAreaElement;

interface FieldSnapshot {
  field: TextField;
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

/**
 * When the key reached the browser. A scanner's keys arrive a few ms apart,
 * but each one typed into a field re-renders the page, so on a slow tablet
 * they are handled tens to hundreds of ms apart: timing them by the handler
 * (`performance.now()`) dropped scans that `event.timeStamp` keeps (roadmap
 * 9.19 pre-flight). Both share the page's time origin in current browsers;
 * only differences are ever compared.
 */
function keyTime(event: KeyboardEvent): number {
  return Number.isFinite(event.timeStamp) && event.timeStamp > 0 ? event.timeStamp : performance.now();
}

function focusedTextField(): TextField | null {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
}

function snapshot(field: TextField): FieldSnapshot {
  let selectionStart: number | null = null;
  let selectionEnd: number | null = null;
  try {
    // Number and email inputs throw on selection access.
    selectionStart = field.selectionStart;
    selectionEnd = field.selectionEnd;
  } catch {
    /* no selection on this input type */
  }
  return { field, value: field.value, selectionStart, selectionEnd };
}

/**
 * Puts a field back to its value before the burst, the way a user edit would
 * reach React: the native value setter (a React-controlled input ignores a
 * plain assignment) followed by an `input` event, so its `onChange` runs.
 */
function restore(saved: FieldSnapshot): void {
  const { field } = saved;
  if (field.value === saved.value) return;
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, saved.value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  if (saved.selectionStart !== null && saved.selectionEnd !== null) {
    try {
      field.setSelectionRange(saved.selectionStart, saved.selectionEnd);
    } catch {
      /* the field cannot take a selection */
    }
  }
}

/**
 * Detects HID (keyboard-wedge) barcode scanner input anywhere on the page.
 *
 * A scan is a burst of >= `minLength` printable characters with < `maxIntervalMs`
 * between keystrokes (by `event.timeStamp`), terminated by Enter. Ordinary
 * typing never matches the timing, so it is left alone. When the Enter proves
 * a burst was a scan, the Enter is swallowed (capture phase) so the focused
 * form never acts on it (it would confirm a payment or press the focused
 * button), the field that received the burst's characters gets its earlier
 * value back (a scan never leaves digits in the notes, a quantity or the
 * cash tendered), and `onScan(code)` is called. What a scan means in the
 * current state (add to the cart, start the next sale, nothing while a dialog
 * is open) is the caller's decision.
 */
export function useBarcodeScanner(onScan: (code: string) => void, options: BarcodeScannerOptions = {}): void {
  const { enabled = true, minLength = DEFAULT_MIN_LENGTH, maxIntervalMs = DEFAULT_MAX_INTERVAL } = options;

  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const bufferRef = useRef('');
  const lastKeyAtRef = useRef(0);
  const fieldRef = useRef<FieldSnapshot | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;

    const reset = () => {
      bufferRef.current = '';
      lastKeyAtRef.current = 0;
      fieldRef.current = null;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
        reset();
        return;
      }

      const at = keyTime(event);
      const gap = at - lastKeyAtRef.current;

      if (event.key === 'Enter') {
        const buffer = bufferRef.current;
        const fastEnough = gap <= Math.max(maxIntervalMs, ENTER_GRACE_MS);
        if (buffer.length >= minLength && fastEnough) {
          // A scanner burst: the focused input/form must not act on its Enter.
          event.preventDefault();
          event.stopPropagation();
          const saved = fieldRef.current;
          reset();
          if (saved) restore(saved);
          onScanRef.current(buffer);
          return;
        }
        reset();
        return;
      }

      // Printable characters only (single-character keys, no whitespace).
      if (event.key.length !== 1 || event.key === ' ') {
        if (event.key !== 'Shift') reset();
        return;
      }

      if (gap > maxIntervalMs || bufferRef.current.length === 0) {
        // Too slow to be part of the previous burst (or the first key): start over,
        // remembering the focused field as it was before this key reaches it.
        bufferRef.current = event.key;
        const field = focusedTextField();
        fieldRef.current = field ? snapshot(field) : null;
      } else {
        bufferRef.current += event.key;
      }
      lastKeyAtRef.current = at;
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      reset();
    };
  }, [enabled, minLength, maxIntervalMs]);
}
