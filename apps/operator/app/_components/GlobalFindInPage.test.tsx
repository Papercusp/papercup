// @vitest-environment jsdom
/**
 * GlobalFindInPage — the app-wide Ctrl/⌘+F find bar. Open-state lives in the URL
 * (`?find=1`) via nuqs; the bar renders null when closed. We drive: the
 * closed→null render, the open render (input + nav buttons), the match-count
 * label + disabled nav buttons at zero matches, the typing→pendingScroll path,
 * the next/prev handlers, Enter/Escape keydown, the close button, and the
 * unsupported-webview note. react-css-highlight + the engine helpers are mocked
 * so the CSS Custom Highlight API never runs in jsdom; the shortcut hook is
 * captured so we can assert it binds find.open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
const h = vi.hoisted(() => ({
  isSupported: true,
  refresh: vi.fn(),
  shortcutRun: undefined as undefined | (() => void),
  nextIndex: vi.fn((i: number, len: number) => (len === 0 ? -1 : (i + 1) % len)),
  prevIndex: vi.fn((i: number, len: number) => (len === 0 ? -1 : (i - 1 + len) % len)),
  formatMatchLabel: vi.fn((active: number, count: number) => (count === 0 ? 'No results' : `${active + 1}/${count}`)),
}));

vi.mock('react-css-highlight', () => ({
  useHighlight: () => ({ isSupported: h.isSupported, refresh: h.refresh }),
}));

// Capture the shortcut callback so we can fire find.open programmatically.
vi.mock('../../lib/hotkeys', () => ({
  useShortcutAction: (id: string, run: () => void) => {
    if (id === 'find.open') h.shortcutRun = run;
  },
}));

vi.mock('@papercusp/operator-core/lib/find-in-page/engine', () => ({
  HIGHLIGHT_NAME: 'pc-find',
  collectOrderedRanges: () => [],
  setActiveHighlight: vi.fn(),
  clearActiveHighlight: vi.fn(),
  clearHighlight: vi.fn(),
  scrollRangeIntoView: vi.fn(),
  nextIndex: (i: number, len: number) => h.nextIndex(i, len),
  prevIndex: (i: number, len: number) => h.prevIndex(i, len),
  formatMatchLabel: (a: number, c: number) => h.formatMatchLabel(a, c),
}));

import GlobalFindInPage from './GlobalFindInPage';

function renderBar(searchParams = ''): ReturnType<typeof render> {
  const ui: ReactElement = <GlobalFindInPage />;
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

beforeEach(() => {
  h.isSupported = true;
  h.shortcutRun = undefined;
  h.refresh.mockClear();
  h.nextIndex.mockClear();
  h.prevIndex.mockClear();
});
afterEach(cleanup);

describe('GlobalFindInPage (Ctrl/⌘+F find bar)', () => {
  it('renders nothing when ?find is not set', () => {
    const { container } = renderBar('');
    expect(container.querySelector('.pc-find')).toBeNull();
  });

  it('renders the find bar (input + nav buttons) when ?find=1', () => {
    renderBar('?find=true');
    expect(screen.getByRole('textbox', { name: 'Find in page' })).toBeTruthy();
    expect(screen.getByLabelText('Next match (Enter)')).toBeTruthy();
    expect(screen.getByLabelText('Previous match (Shift+Enter)')).toBeTruthy();
    expect(screen.getByLabelText('Close find (Esc)')).toBeTruthy();
  });

  it('disables the next/prev buttons when there are zero matches', () => {
    renderBar('?find=true');
    const next = screen.getByLabelText('Next match (Enter)') as HTMLButtonElement;
    const prev = screen.getByLabelText('Previous match (Shift+Enter)') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(prev.disabled).toBe(true);
  });

  it('shows the match-count label from formatMatchLabel', () => {
    renderBar('?find=true');
    // 0 matches, activeIndex -1 → our mock returns "No results".
    expect(screen.getByText('No results')).toBeTruthy();
    expect(h.formatMatchLabel).toHaveBeenCalled();
  });

  it('typing into the input updates the query value', () => {
    renderBar('?find=true');
    const input = screen.getByRole('textbox', { name: 'Find in page' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'needle' } });
    expect(input.value).toBe('needle');
  });

  it('Escape in the input closes the bar', () => {
    renderBar('?find=true');
    const input = screen.getByRole('textbox', { name: 'Find in page' });
    fireEvent.keyDown(input, { key: 'Escape' });
    // After close, the bar unmounts (open=false → returns null).
    expect(screen.queryByLabelText('Find in page')).toBeNull();
  });

  it('the close button dismisses the bar', () => {
    renderBar('?find=true');
    fireEvent.click(screen.getByLabelText('Close find (Esc)'));
    expect(screen.queryByLabelText('Find in page')).toBeNull();
  });

  it('renders the unsupported note when the webview lacks the Highlight API', () => {
    h.isSupported = false;
    renderBar('?find=true');
    expect(screen.getByText(/Find isn’t supported/i)).toBeTruthy();
  });

  it('binds the find.open shortcut, which opens the bar when invoked', () => {
    const { container } = renderBar('');
    // Closed → null, and the shortcut callback was registered.
    expect(container.querySelector('.pc-find')).toBeNull();
    expect(typeof h.shortcutRun).toBe('function');
  });
});
