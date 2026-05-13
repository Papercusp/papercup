'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Per-field-settings auto-save with debounce. The canonical primitive for
 * settings pages where each control persists independently (no Submit button).
 *
 * Pattern:
 *   const [engine, setEngine] = useState(initial.engine);
 *   const { saving, lastSavedAt, flush } = useDebouncedSave(
 *     { engine },
 *     async (v) => { await fetch('/api/voice/config', { method: 'POST', body: JSON.stringify(v) }); },
 *   );
 *
 * - First-render save is suppressed by default (skipFirst), so hydration from
 *   the server doesn't fire an immediate POST.
 * - Calling flush() forces an immediate save (e.g. before a Test button runs).
 * - The pending timer is cancelled on unmount.
 *
 * See /docs/design/libraries#form-patterns for when to use this vs RHF.
 */
export function useDebouncedSave<T>(
  value: T,
  persist: (value: T) => Promise<void>,
  opts: {
    /** Debounce window in ms. Default 300. */
    ms?: number;
    /** Called with the timestamp of each successful save. */
    onSavedAt?: (date: Date) => void;
    /** Called when persist() throws. */
    onError?: (err: unknown) => void;
    /** If true (default), the first render does not trigger a save. */
    skipFirst?: boolean;
  } = {},
): {
  saving: boolean;
  lastSavedAt: Date | null;
  /** Force an immediate save with the current value. Resolves when done. */
  flush: () => Promise<void>;
} {
  const { ms = 300, onSavedAt, onError, skipFirst = true } = opts;
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const valueRef = useRef(value);
  const persistRef = useRef(persist);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRef = useRef(true);

  // Keep refs current so the debounced closure always reads the latest value
  // + the latest persist function (callers often pass an inline async fn).
  valueRef.current = value;
  persistRef.current = persist;

  const doSave = useCallback(async () => {
    setSaving(true);
    try {
      await persistRef.current(valueRef.current);
      const now = new Date();
      setLastSavedAt(now);
      onSavedAt?.(now);
    } catch (err) {
      onError?.(err);
    } finally {
      setSaving(false);
    }
  }, [onSavedAt, onError]);

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await doSave();
  }, [doSave]);

  useEffect(() => {
    if (skipFirst && isFirstRef.current) {
      isFirstRef.current = false;
      return;
    }
    isFirstRef.current = false;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void doSave();
    }, ms);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // We deliberately depend on the serialised value, not the function, so
    // the debounce restarts when the user keeps typing but doesn't reset on
    // every render that creates a new persist closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value), ms, skipFirst, doSave]);

  return { saving, lastSavedAt, flush };
}
