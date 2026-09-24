'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Local text state for a numeric input bound to a store number, so typing
 * intermediate values like "10." is not clobbered by the parsed value.
 * Empty text commits 0.
 */
export function useNumericField(value: number, onCommit: (next: number) => void) {
  const [text, setText] = useState(value === 0 ? '' : String(value));

  useEffect(() => {
    setText((current) => {
      const parsed = current.trim() === '' ? 0 : Number(current);
      return parsed === value ? current : value === 0 ? '' : String(value);
    });
  }, [value]);

  const onChange = useCallback(
    (raw: string) => {
      setText(raw);
      const parsed = raw.trim() === '' ? 0 : Number(raw);
      if (Number.isFinite(parsed)) onCommit(parsed);
    },
    [onCommit],
  );

  return { text, onChange };
}
