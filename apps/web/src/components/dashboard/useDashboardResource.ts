'use client';

import { useCallback, useRef, useState } from 'react';
import { describeApiError } from '@/lib/api-error';

export interface DashboardResource<T> {
  data: T | null;
  loading: boolean;
  /** Last failure; kept alongside `data` when a refresh fails after a good load. */
  error: string | null;
}

export interface LoadOptions {
  /** Start a new request even if one is in flight (user action, changed input). */
  force?: boolean;
  /** Drop the current data first (the input changed, old data no longer applies). */
  reset?: boolean;
}

/**
 * One dashboard resource with two guarantees:
 * - only the newest request may write state (an older, slower response is ignored);
 * - a non-forced load (the poll) is skipped while a request is still in flight,
 *   so a slow API never accumulates overlapping requests.
 */
export function useDashboardResource<T>(fetcher: () => Promise<T>, operation: string) {
  const [state, setState] = useState<DashboardResource<T>>({ data: null, loading: true, error: null });
  const seq = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(
    async (options: LoadOptions = {}): Promise<boolean> => {
      if (inFlight.current && !options.force) return false;
      const id = ++seq.current;
      inFlight.current = true;
      setState((current) => ({ data: options.reset ? null : current.data, loading: true, error: options.reset ? null : current.error }));
      try {
        const data = await fetcher();
        if (id !== seq.current) return false;
        setState({ data, loading: false, error: null });
        return true;
      } catch (err) {
        if (id !== seq.current) return false;
        setState((current) => ({ ...current, loading: false, error: describeApiError(err, operation) }));
        return false;
      } finally {
        if (id === seq.current) inFlight.current = false;
      }
    },
    [fetcher, operation],
  );

  return [state, load] as const;
}
