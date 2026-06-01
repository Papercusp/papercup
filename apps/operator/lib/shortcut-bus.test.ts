/**
 * Coverage for shortcut-bus: registerAction stacking/unregister, refreshKeymap
 * resolution, and dispatchKeydown's match → run pipeline incl. the form-tag
 * guard, ignoreEventWhen, return-false fall-through, preventDefault default +
 * opt-out, and the "match but no/again-skipped handler → still claim the browser
 * default for palette/editor/search categories" rule. The registry is mocked;
 * the real matcher (shortcut-match) is used.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./shortcut-registry', () => {
  const base: Record<string, string> = {
    'find.open': 'mod+f',
    'cmd.palette': 'mod+p',
    'editor.save': 'mod+s',
    'nav.next': 'j',
  };
  const cat: Record<string, string> = {
    'find.open': 'navigation',
    'cmd.palette': 'palette',
    'editor.save': 'editor',
    'nav.next': 'nav',
  };
  return {
    SHORTCUTS: Object.keys(base).map((id) => ({ id })),
    effectiveCombo: (id: string, overrides: Record<string, string>) => overrides[id] ?? base[id],
    getShortcutDef: (id: string) => ({ id, category: cat[id] }),
  };
});

import { registerAction, refreshKeymap, getResolvedKeymap, dispatchKeydown, _resetActions } from './shortcut-bus';

type EvInit = { ctrlKey?: boolean; target?: { tagName?: string; isContentEditable?: boolean } | null };
const ev = (key: string, init: EvInit = {}): KeyboardEvent =>
  ({
    key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: init.target ?? null,
    preventDefault: vi.fn(),
  }) as unknown as KeyboardEvent;

beforeEach(() => {
  _resetActions();
  refreshKeymap({});
});

describe('refreshKeymap / getResolvedKeymap', () => {
  it('resolves one entry per registry shortcut', () => {
    expect(getResolvedKeymap().map((e) => e.id).sort()).toEqual([
      'cmd.palette',
      'editor.save',
      'find.open',
      'nav.next',
    ]);
  });
});

describe('dispatchKeydown — handler firing', () => {
  it('runs a registered handler on a match + preventDefaults by default', () => {
    const run = vi.fn();
    registerAction({ id: 'nav.next', run, options: {} });
    const e = ev('j');
    expect(dispatchKeydown(e)).toBe('nav.next');
    expect(run).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('unregister stops the handler from firing', () => {
    const run = vi.fn();
    const off = registerAction({ id: 'nav.next', run, options: {} });
    off();
    dispatchKeydown(ev('j'));
    expect(run).not.toHaveBeenCalled();
  });

  it('returns null when nothing matches', () => {
    expect(dispatchKeydown(ev('z'))).toBeNull();
  });

  it('respects preventDefault:false (runs but lets the default through)', () => {
    const run = vi.fn();
    registerAction({ id: 'nav.next', run, options: { preventDefault: false } });
    const e = ev('j');
    dispatchKeydown(e);
    expect(run).toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe('dispatchKeydown — guards', () => {
  it('skips a handler when focus is in a form tag (no enableOnFormTags)', () => {
    const run = vi.fn();
    registerAction({ id: 'nav.next', run, options: {} });
    dispatchKeydown(ev('j', { target: { tagName: 'INPUT' } }));
    expect(run).not.toHaveBeenCalled();
  });

  it('fires in a form tag when enableOnFormTags includes it', () => {
    const run = vi.fn();
    registerAction({ id: 'nav.next', run, options: { enableOnFormTags: ['INPUT'] } });
    dispatchKeydown(ev('j', { target: { tagName: 'INPUT' } }));
    expect(run).toHaveBeenCalledOnce();
  });

  it('treats contentEditable as a form tag', () => {
    const run = vi.fn();
    registerAction({ id: 'nav.next', run, options: {} });
    dispatchKeydown(ev('j', { target: { tagName: 'DIV', isContentEditable: true } }));
    expect(run).not.toHaveBeenCalled();
  });

  it('skips when ignoreEventWhen returns true', () => {
    const run = vi.fn();
    registerAction({ id: 'nav.next', run, options: { ignoreEventWhen: () => true } });
    dispatchKeydown(ev('j'));
    expect(run).not.toHaveBeenCalled();
  });
});

describe('dispatchKeydown — browser-default claim', () => {
  it('preventDefaults a matched palette combo even with no handler', () => {
    const e = ev('p', { ctrlKey: true }); // mod+p = cmd.palette, category palette
    expect(dispatchKeydown(e)).toBe('cmd.palette');
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('does NOT claim a plain nav combo when its handler is absent', () => {
    const e = ev('j'); // nav.next, category nav (not claimed)
    expect(dispatchKeydown(e)).toBe('nav.next');
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('claims find.open (Ctrl+F) even with no handler, so the native browser find never shows', () => {
    // find.open is category 'navigation' (which is NOT a claimed category) —
    // it is claimed by id, the safety net that suppresses the webview's native
    // find bar on routes where GlobalFindInPage has not bound the action.
    const e = ev('f', { ctrlKey: true });
    expect(dispatchKeydown(e)).toBe('find.open');
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('still claims an editor combo when the handler returned false (fall-through)', () => {
    const run = vi.fn(() => false);
    registerAction({ id: 'editor.save', run, options: {} });
    const e = ev('s', { ctrlKey: true });
    dispatchKeydown(e);
    expect(run).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled(); // editor category claims it
  });
});
