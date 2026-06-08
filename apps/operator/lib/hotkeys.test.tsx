/**
 * @vitest-environment jsdom
 *
 * RTL tests for the operator hotkey hooks: useShortcutAction (register-once +
 * ref-fresh run/options) and useShortcutOverrides (re-render on shortcut change).
 * Run with: cd apps/operator && npx vitest run lib/hotkeys.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const bus = vi.hoisted(() => ({ registered: [] as Array<Record<string, any>>, dispose: vi.fn() }));
vi.mock('@papercusp/operator-core/lib/shortcut-bus', () => ({
  registerAction: (a: Record<string, unknown>) => {
    bus.registered.push(a);
    return bus.dispose;
  },
}));

const reg = vi.hoisted(() => ({ overrides: {} as Record<string, string> }));
vi.mock('@papercusp/operator-core/lib/shortcut-registry', () => ({
  loadOverrides: () => reg.overrides,
}));

import { useShortcutAction, useShortcutOverrides } from './hotkeys';

afterEach(() => {
  cleanup();
  bus.registered.length = 0;
  bus.dispose.mockClear();
  reg.overrides = {};
});

describe('useShortcutAction', () => {
  it('registers an action with the id on mount and disposes on unmount', () => {
    const { unmount } = renderHook(() => useShortcutAction('save', vi.fn()));
    expect(bus.registered).toHaveLength(1);
    expect(bus.registered[0].id).toBe('save');
    unmount();
    expect(bus.dispose).toHaveBeenCalled();
  });

  it('registers ONCE and keeps the run callback fresh via ref across re-renders', () => {
    const r1 = vi.fn();
    const r2 = vi.fn();
    const { rerender } = renderHook(({ r }) => useShortcutAction('save', r), { initialProps: { r: r1 } });
    rerender({ r: r2 });
    expect(bus.registered).toHaveLength(1); // not re-registered
    const evt = {} as KeyboardEvent;
    bus.registered[0].run(evt);
    expect(r1).not.toHaveBeenCalled();
    expect(r2).toHaveBeenCalledWith(evt);
  });

  it('exposes live option getters that follow the latest options', () => {
    const { rerender } = renderHook(({ o }) => useShortcutAction('save', () => {}, o), {
      initialProps: { o: { preventDefault: true } as Record<string, unknown> },
    });
    expect(bus.registered[0].options.preventDefault).toBe(true);
    rerender({ o: { preventDefault: false } });
    expect(bus.registered[0].options.preventDefault).toBe(false);
  });
});

describe('useShortcutOverrides', () => {
  it('returns the initial override map', () => {
    reg.overrides = { save: 'mod+s' };
    const { result } = renderHook(() => useShortcutOverrides());
    expect(result.current).toEqual({ save: 'mod+s' });
  });

  it('re-renders when a papercusp:shortcuts-changed event fires', () => {
    reg.overrides = {};
    const { result } = renderHook(() => useShortcutOverrides());
    expect(result.current).toEqual({});
    reg.overrides = { save: 'mod+k' };
    act(() => {
      window.dispatchEvent(new Event('papercusp:shortcuts-changed'));
    });
    expect(result.current).toEqual({ save: 'mod+k' });
  });
});
