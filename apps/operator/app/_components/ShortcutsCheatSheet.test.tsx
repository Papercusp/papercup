// @vitest-environment jsdom
//
// ShortcutsCheatSheet — the read-only keyboard-shortcut cheat sheet.
// The combo pretty-printer (prettyCombo) carries all the real logic — token
// glyph mapping, alternates (`,`), sequences (`>`) — so it's extracted +
// tested branch-by-branch. A render-smoke drives the Radix dialog open/closed
// with a mocked shortcut registry to confirm the grouped surface paints.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

beforeAll(() => {
  // Radix Dialog touches ResizeObserver / matchMedia in jsdom.
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

// Pin the platform so the glyph table is deterministic (Ctrl, not ⌘).
const { isMac } = vi.hoisted(() => ({ isMac: { value: false } }));
vi.mock('@papercusp/operator-core/lib/shortcut-match', () => ({
  isMacPlatform: () => isMac.value,
}));

// A tiny stand-in registry so the render-smoke doesn't depend on the real
// (large, evolving) shortcut catalog.
vi.mock('@papercusp/operator-core/lib/shortcut-registry', () => ({
  SHORTCUTS: [
    { id: 'palette.open', category: 'palette', description: 'Open quick actions' },
    { id: 'nav.back', category: 'navigation', description: 'Go back' },
  ],
  effectiveCombo: (id: string) => (id === 'palette.open' ? 'mod+k' : 'mod+ArrowLeft'),
}));

// hotkeys' useShortcutOverrides subscribes to a store; a no-op map is enough.
vi.mock('../../lib/hotkeys', () => ({ useShortcutOverrides: () => ({}) }));

// RouteLink pulls in the router/progress stack — render a plain anchor that
// forwards onClick so the cheat-sheet's "close on Settings click" wiring is testable.
vi.mock('./RouteLink', () => ({
  default: ({ children, href, onClick }: { children: React.ReactNode; href: string; onClick?: (e: React.MouseEvent) => void }) => (
    <a href={href} onClick={onClick}>{children}</a>
  ),
}));

import ShortcutsCheatSheet, { prettyCombo } from './ShortcutsCheatSheet';

afterEach(cleanup);

describe('prettyCombo', () => {
  it('returns an empty list for an empty combo', () => {
    expect(prettyCombo('')).toEqual([]);
  });

  it('maps `mod` to the platform glyph (Ctrl off mac)', () => {
    expect(prettyCombo('mod+k')).toEqual(['Ctrl+K']);
  });

  it('uppercases single-character keys', () => {
    expect(prettyCombo('a')).toEqual(['A']);
  });

  it('maps named keys to their glyphs', () => {
    expect(prettyCombo('arrowdown')).toEqual(['↓']);
    expect(prettyCombo('enter')).toEqual(['↵']);
    expect(prettyCombo('escape')).toEqual(['Esc']);
    expect(prettyCombo('slash')).toEqual(['/']);
  });

  it('splits alternates on comma into separate combos', () => {
    expect(prettyCombo('mod+k, shift+p')).toEqual(['Ctrl+K', 'Shift+P']);
  });

  it('joins a `>` sequence with " then "', () => {
    expect(prettyCombo('g>h')).toEqual(['G then H']);
  });

  it('handles modifier + sequence together', () => {
    expect(prettyCombo('mod+shift+a')).toEqual(['Ctrl+Shift+A']);
  });

  it('drops empty alternates from a trailing comma', () => {
    expect(prettyCombo('mod+k,')).toEqual(['Ctrl+K']);
  });
});

describe('prettyCombo on mac', () => {
  it('uses ⌘/⇧/⌥ glyphs', () => {
    isMac.value = true;
    try {
      expect(prettyCombo('mod+shift+alt+k')).toEqual(['⌘+⇧+⌥+K']);
    } finally {
      isMac.value = false;
    }
  });
});

describe('<ShortcutsCheatSheet />', () => {
  it('renders nothing visible when closed', () => {
    render(<ShortcutsCheatSheet open={false} onClose={() => {}} />);
    expect(screen.queryByText('Keyboard shortcuts')).toBeNull();
  });

  it('renders grouped shortcuts with pretty combos when open', () => {
    render(<ShortcutsCheatSheet open onClose={() => {}} />);
    expect(screen.getByText('Keyboard shortcuts')).toBeTruthy();
    expect(screen.getByText('Open quick actions')).toBeTruthy();
    expect(screen.getByText('Go back')).toBeTruthy();
    // mod+k → "Ctrl" + "K" kbd tokens (Ctrl appears for both shortcuts).
    expect(screen.getAllByText('Ctrl').length).toBeGreaterThan(0);
    expect(screen.getByText('K')).toBeTruthy();
  });

  it('clicking the Settings → Shortcuts link fires onClose', () => {
    const onClose = vi.fn();
    render(<ShortcutsCheatSheet open onClose={onClose} />);
    const link = screen.getByText('Settings → Shortcuts').closest('a') as HTMLAnchorElement;
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener('click', prevent, true);
    try {
      fireEvent.click(link);
    } finally {
      document.removeEventListener('click', prevent, true);
    }
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pressing Escape closes the dialog via onClose (Radix onOpenChange→false)', () => {
    const onClose = vi.fn();
    render(<ShortcutsCheatSheet open onClose={onClose} />);
    fireEvent.keyDown(screen.getByText('Keyboard shortcuts').closest('[role="dialog"]')!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
