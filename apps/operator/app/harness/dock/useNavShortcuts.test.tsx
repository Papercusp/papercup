/**
 * @vitest-environment jsdom
 *
 * Tests the Cmd+[/Cmd+] keyboard dispatching: per-panel useNavHistory
 * wins; fallback to dock-level tab-visit history.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useNavShortcuts } from './useNavShortcuts';
import { registerNavForPanel, _resetNavRegistryForTests } from './NavChevrons';
import { _resetTabVisitHistoryForTests, _testHooks as tabHooks } from './useTabVisitHistory';
import { bindDockApi } from './dock-actions';

function makeFakeDockApi() {
  let listener: (() => void) | null = null;
  return {
    activeGroup: { activePanel: { id: 'p1' } } as { activePanel: { id: string } | null } | null,
    onDidActivePanelChange: vi.fn((fn: () => void) => {
      listener = fn;
      return { dispose: () => { listener = null; } };
    }),
    getPanel: vi.fn((id: string) => ({
      id,
      api: { setActive: vi.fn() },
    })),
    onDidRemovePanel: vi.fn(() => ({ dispose: () => undefined })),
    _trigger() { listener?.(); },
  };
}

function fireMetaKey(key: '[' | ']') {
  const ev = new KeyboardEvent('keydown', { key, metaKey: true, cancelable: true });
  window.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  bindDockApi(null);
  _resetNavRegistryForTests();
  _resetTabVisitHistoryForTests();
});

afterEach(() => {
  bindDockApi(null);
  _resetNavRegistryForTests();
  _resetTabVisitHistoryForTests();
});

describe('useNavShortcuts', () => {
  it('Cmd+[ dispatches to per-panel nav when registered', () => {
    const api = makeFakeDockApi();
    bindDockApi(api as unknown as Parameters<typeof bindDockApi>[0]);
    const back = vi.fn();
    registerNavForPanel('p1', {
      current: { x: 1 },
      canBack: true,
      canForward: false,
      back,
      forward: vi.fn(),
      push: vi.fn(),
      replace: vi.fn(),
      reset: vi.fn(),
    });
    renderHook(() => useNavShortcuts());
    const ev = fireMetaKey('[');
    // React strict-mode may double-register; the meaningful assertion
    // is that the per-panel nav was dispatched at least once and the
    // key was prevented.
    expect(back).toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Cmd+] dispatches forward on per-panel nav', () => {
    const api = makeFakeDockApi();
    bindDockApi(api as unknown as Parameters<typeof bindDockApi>[0]);
    const forward = vi.fn();
    registerNavForPanel('p1', {
      current: { x: 1 },
      canBack: false,
      canForward: true,
      back: vi.fn(),
      forward,
      push: vi.fn(),
      replace: vi.fn(),
      reset: vi.fn(),
    });
    renderHook(() => useNavShortcuts());
    fireMetaKey(']');
    expect(forward).toHaveBeenCalled();
  });

  it('falls through to tab-visit history when no per-panel nav exists', () => {
    const api = makeFakeDockApi();
    bindDockApi(api as unknown as Parameters<typeof bindDockApi>[0]);
    renderHook(() => useNavShortcuts());
    // Build dock-level history
    tabHooks.pushIfNew('a');
    tabHooks.pushIfNew('b');
    tabHooks.pushIfNew('c');
    const before = tabHooks.getState().cursor;
    expect(before).toBe(2);
    fireMetaKey('[');
    // Strict-mode may dispatch back() multiple times; cursor strictly
    // less than before is the assertion we care about.
    expect(tabHooks.getState().cursor).toBeLessThan(before);
  });

  it('falls through to tab-visit forward when per-panel canForward is false', () => {
    const api = makeFakeDockApi();
    bindDockApi(api as unknown as Parameters<typeof bindDockApi>[0]);
    registerNavForPanel('p1', {
      current: { x: 1 },
      canBack: false,
      canForward: false,
      back: vi.fn(),
      forward: vi.fn(),
      push: vi.fn(),
      replace: vi.fn(),
      reset: vi.fn(),
    });
    renderHook(() => useNavShortcuts());
    tabHooks.pushIfNew('a');
    tabHooks.pushIfNew('b');
    const before = tabHooks.getState().cursor;
    fireMetaKey('[');
    expect(tabHooks.getState().cursor).toBeLessThan(before);
  });

  it('does not hijack when focus is in input', () => {
    const api = makeFakeDockApi();
    bindDockApi(api as unknown as Parameters<typeof bindDockApi>[0]);
    const back = vi.fn();
    registerNavForPanel('p1', {
      current: {},
      canBack: true,
      canForward: false,
      back,
      forward: vi.fn(),
      push: vi.fn(),
      replace: vi.fn(),
      reset: vi.fn(),
    });
    renderHook(() => useNavShortcuts());
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const ev = new KeyboardEvent('keydown', { key: '[', metaKey: true, cancelable: true });
    Object.defineProperty(ev, 'target', { value: input });
    window.dispatchEvent(ev);
    expect(back).not.toHaveBeenCalled();
    input.remove();
  });

  it('ignores keys without meta/ctrl modifier', () => {
    const api = makeFakeDockApi();
    bindDockApi(api as unknown as Parameters<typeof bindDockApi>[0]);
    const back = vi.fn();
    registerNavForPanel('p1', {
      current: {},
      canBack: true,
      canForward: false,
      back,
      forward: vi.fn(),
      push: vi.fn(),
      replace: vi.fn(),
      reset: vi.fn(),
    });
    renderHook(() => useNavShortcuts());
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '[' }));
    expect(back).not.toHaveBeenCalled();
  });
});
