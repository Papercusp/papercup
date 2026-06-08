/**
 * @vitest-environment jsdom
 *
 * RTL tests for useUiIntent — registers a feature intent on mount, unregisters
 * on unmount, and keeps the handler fresh without re-registering.
 * Run with: cd apps/operator && npx vitest run lib/ui/use-ui-intent.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useUiIntent } from './use-ui-intent';
import { lookupIntent } from '@papercusp/operator-core/lib/ui/intent-registry';

afterEach(cleanup);

describe('useUiIntent', () => {
  it('registers a non-builtin intent on mount and removes it on unmount', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useUiIntent('feat:mount', handler));
    const entry = lookupIntent('feat:mount');
    expect(entry).toBeDefined();
    expect(entry?.builtIn).toBe(false);
    unmount();
    expect(lookupIntent('feat:mount')).toBeUndefined();
  });

  it('dispatches to the latest handler without re-registering on handler change', async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const { rerender } = renderHook(({ h }) => useUiIntent('feat:fresh', h), {
      initialProps: { h: h1 as (a: Record<string, unknown>) => unknown },
    });
    rerender({ h: h2 });
    await lookupIntent('feat:fresh')!.handler({ a: 1 });
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledWith({ a: 1 });
  });

  it('moves registration to the new name when the name changes', () => {
    const { rerender } = renderHook(({ n }) => useUiIntent(n, vi.fn()), {
      initialProps: { n: 'feat:n1' },
    });
    expect(lookupIntent('feat:n1')).toBeDefined();
    rerender({ n: 'feat:n2' });
    expect(lookupIntent('feat:n1')).toBeUndefined();
    expect(lookupIntent('feat:n2')).toBeDefined();
  });
});
