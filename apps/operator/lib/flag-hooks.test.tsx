/**
 * @vitest-environment jsdom
 *
 * RTL tests for useFlag — reads the snapshot, subscribes, re-renders on change,
 * and falls back to FLAG_DEFAULTS when a key is absent.
 * Run with: cd apps/operator && npx vitest run lib/flag-hooks.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

// Shared holder so the mocked `subscribe`/`subscribeToFlagStream` can hand
// their callbacks back to the test.
const h = vi.hoisted(() => ({
  emit: (_v: Record<string, boolean>) => {},
  subscribeArgs: [] as unknown[],
  reportReachable: vi.fn(),
  reportUnreachable: vi.fn(),
}));

vi.mock('@papercusp/flags', () => ({ FLAG_DEFAULTS: { myFeature: false } }));
vi.mock('@papercusp/flags/client', () => ({
  getFlagSnapshot: () => ({ flags: {} as Record<string, boolean> }),
  loadFlags: () => Promise.resolve(),
  subscribe: (fn: (v: Record<string, boolean>) => void) => {
    h.emit = fn;
    return () => {};
  },
  subscribeToFlagStream: (...args: unknown[]) => {
    h.subscribeArgs = args;
    return { close() {} };
  },
}));
vi.mock('@papercusp/sync', () => ({
  reportSyncReachable: h.reportReachable,
  reportSyncUnreachable: h.reportUnreachable,
}));

import { useFlag } from './flag-hooks';

afterEach(cleanup);

describe('useFlag', () => {
  it('starts at the default when the snapshot lacks the key', () => {
    const { result } = renderHook(() => useFlag('myFeature' as never));
    expect(result.current).toBe(false);
  });

  it('re-renders to the new value when the flag stream emits', () => {
    const { result } = renderHook(() => useFlag('myFeature' as never));
    act(() => h.emit({ myFeature: true }));
    expect(result.current).toBe(true);
  });

  it('falls back to the default when an update omits the key', () => {
    const { result } = renderHook(() => useFlag('myFeature' as never));
    act(() => h.emit({ myFeature: true }));
    expect(result.current).toBe(true);
    act(() => h.emit({})); // key absent → default false
    expect(result.current).toBe(false);
  });
});

describe('flags-stream connectivity wiring', () => {
  it('subscribes with onOpen/onStatusChange hooks feeding the shared sync connectivity store', () => {
    renderHook(() => useFlag('myFeature' as never));
    const [, hooks] = h.subscribeArgs as [
      unknown,
      { onOpen?: () => void; onStatusChange?: (s: string) => void } | undefined,
    ];
    expect(hooks).toBeDefined();

    hooks?.onOpen?.();
    expect(h.reportReachable).toHaveBeenCalled();

    hooks?.onStatusChange?.('failing');
    expect(h.reportUnreachable).toHaveBeenCalledTimes(1);

    // Non-'failing' statuses (e.g. 'open', 'connecting') don't report unreachable.
    hooks?.onStatusChange?.('open');
    expect(h.reportUnreachable).toHaveBeenCalledTimes(1);
  });
});
