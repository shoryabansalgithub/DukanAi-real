'use client';

import { useEffect, useRef } from 'react';

/**
 * Runs `callback` every `intervalMs` while the document is visible. Polling
 * stops when the tab is hidden and resumes (with an immediate refresh) when it
 * becomes visible again, so background tabs do not hammer the API.
 */
export function useVisibilityPolling(callback: () => void, intervalMs: number, enabled = true): void {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;

    let timer: number | null = null;

    const start = () => {
      if (timer !== null) return;
      timer = window.setInterval(() => {
        if (!document.hidden) callbackRef.current();
      }, intervalMs);
    };
    const stop = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        callbackRef.current();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs, enabled]);
}
