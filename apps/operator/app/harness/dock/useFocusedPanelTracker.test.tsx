/**
 * @vitest-environment jsdom
 *
 * Sanity tests for useFocusedPanelTracker — verifies the
 * subscribe/dispatch wiring without booting nuqs. We can't easily
 * intercept nuqs setter calls in jsdom without a full Next router
 * shim, so the assertions focus on the dockview-side wiring +
 * onDockApiBind contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFocusedPanelTracker } from './useFocusedPanelTracker';
import { bindDockApi } from './dock-actions';

// nuqs requires a Next.js adapter context. Provide a minimal mock at
// module-load time so useQueryState resolves to a no-op. Dynamic import
// inside the factory (not a static top-level import) — a static import
// referenced here collides with this file's own pre-mock import of
// useFocusedPanelTracker (which itself imports 'nuqs'), producing a
// "Cannot access '__vi_import_N__' before initialization" TDZ error from
// vitest's mock-hoisting transform.
vi.mock('nuqs', async () => {
  const { nuqsParsers } = await import('@papercusp/test-config/nuqs-mock');
  return {
    ...nuqsParsers,
    useQueryState: () => [
      '',
      (() => Promise.resolve(null)) as unknown as (val: string, options?: unknown) => Promise<unknown>,
    ],
    parseAsString: { withDefault: (_: string) => ({}) },
  };
});

interface FakeApi {
  activeGroup: { activePanel: { id: string; params: { harnessSlug?: string } } | null } | null;
  onDidActivePanelChange: ReturnType<typeof vi.fn>;
}

function fakeApi(initial: { id: string; harnessSlug: string } | null = null): FakeApi {
  let listener: ((p: unknown) => void) | null = null;
  return {
    activeGroup: initial
      ? { activePanel: { id: initial.id, params: { harnessSlug: initial.harnessSlug } } }
      : null,
    onDidActivePanelChange: vi.fn((fn: (p: unknown) => void) => {
      listener = fn;
      return { dispose: () => { listener = null; } };
    }),
    // Test-only helper
    _trigger(panel: { id: string; params: { harnessSlug?: string } }) {
      // Update the active panel before firing so the tracker reads it.
      (this as FakeApi).activeGroup = { activePanel: panel };
      listener?.(panel);
    },
  } as unknown as FakeApi;
}

beforeEach(() => bindDockApi(null));
afterEach(() => bindDockApi(null));

describe('useFocusedPanelTracker', () => {
  it('subscribes to onDidActivePanelChange when api binds', () => {
    const api = fakeApi({ id: 'p1', harnessSlug: 'sheets' });
    bindDockApi(api as unknown as Parameters<typeof bindDockApi>[0]);
    renderHook(() => useFocusedPanelTracker());
    expect(api.onDidActivePanelChange).toHaveBeenCalledTimes(1);
  });

  it('does nothing when api is null', () => {
    bindDockApi(null);
    expect(() => renderHook(() => useFocusedPanelTracker())).not.toThrow();
  });

  it('handles api swap to null without crashing', () => {
    const api = fakeApi({ id: 'p1', harnessSlug: 'sheets' });
    bindDockApi(api as unknown as Parameters<typeof bindDockApi>[0]);
    renderHook(() => useFocusedPanelTracker());
    // Calling bindDockApi(null) is what we're testing — no throw.
    expect(() => act(() => {
      bindDockApi(null);
    })).not.toThrow();
  });
});
