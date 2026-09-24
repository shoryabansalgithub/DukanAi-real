'use client';

import { useEffect, useRef } from 'react';

export interface BarcodeScannerOptions {
  /** Disable the listener (e.g. while a modal that must not react to scans is open). */
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

/**
 * Detects HID (keyboard-wedge) barcode scanner input anywhere on the page.
 *
 * A scan is a burst of >= `minLength` printable characters with < `maxIntervalMs`
 * between keystrokes, terminated by Enter. Ordinary typing into inputs never
 * matches the timing heuristic, so it is left alone; when a burst is detected
 * the terminating Enter is swallowed (capture phase) so the focused form does
 * not also react to it, and `onScan(code)` is called.
 */
export function useBarcodeScanner(onScan: (code: string) => void, options: BarcodeScannerOptions = {}): void {
  const { enabled = true, minLength = DEFAULT_MIN_LENGTH, maxIntervalMs = DEFAULT_MAX_INTERVAL } = options;

  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const bufferRef = useRef('');
  const lastKeyAtRef = useRef(0);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;

    const reset = () => {
      bufferRef.current = '';
      lastKeyAtRef.current = 0;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
        reset();
        return;
      }

      const now = performance.now();
      const gap = now - lastKeyAtRef.current;

      if (event.key === 'Enter') {
        const buffer = bufferRef.current;
        const fastEnough = gap <= Math.max(maxIntervalMs, ENTER_GRACE_MS);
        if (buffer.length >= minLength && fastEnough) {
          // A scanner burst: swallow the Enter so the focused input/form does not act on it.
          event.preventDefault();
          event.stopPropagation();
          reset();
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
        // Too slow to be part of the previous burst (or the first key): start over.
        // Typing in inputs/textareas is therefore ignored unless it matches the burst timing.
        bufferRef.current = event.key;
      } else {
        bufferRef.current += event.key;
      }
      lastKeyAtRef.current = now;
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      reset();
    };
  }, [enabled, minLength, maxIntervalMs]);
}
