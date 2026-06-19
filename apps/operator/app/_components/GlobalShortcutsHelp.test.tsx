// @vitest-environment jsdom
/**
 * GlobalShortcutsHelp.test.tsx — render-tier coverage for the shortcut
 * cheat-sheet host. It owns the `?shortcuts=` nuqs boolean + the
 * `shortcuts.show` binding, and renders ShortcutsCheatSheet (stubbed to a
 * marker reflecting its open prop). We mock useShortcutAction to capture the
 * toggle handler, then assert: closed by default, open via ?shortcuts=true, and
 * the registered shortcut toggles the URL state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

const registered: Array<{ id: string; run: (e: KeyboardEvent) => void }> = [];
vi.mock('../../lib/hotkeys', () => ({
  useShortcutAction: (id: string, run: (e: KeyboardEvent) => void) => {
    registered.push({ id, run });
  },
}));

// Stub the (Radix-Dialog-heavy) cheat sheet to a marker reflecting its open state.
vi.mock('./ShortcutsCheatSheet', () => ({
  default: ({ open }: { open: boolean }) => <div data-testid="sheet" data-open={open ? 'true' : 'false'} />,
}));

import GlobalShortcutsHelp from './GlobalShortcutsHelp';

function renderHost(ui: ReactElement, searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

beforeEach(() => {
  registered.length = 0;
});
afterEach(cleanup);

describe('GlobalShortcutsHelp', () => {
  it('renders the cheat sheet closed by default (?shortcuts absent)', () => {
    renderHost(<GlobalShortcutsHelp />);
    expect(screen.getByTestId('sheet').getAttribute('data-open')).toBe('false');
  });

  it('renders the cheat sheet open when ?shortcuts=true', () => {
    renderHost(<GlobalShortcutsHelp />, '?shortcuts=true');
    expect(screen.getByTestId('sheet').getAttribute('data-open')).toBe('true');
  });

  it('registers the shortcuts.show binding', () => {
    renderHost(<GlobalShortcutsHelp />);
    expect(registered.some((r) => r.id === 'shortcuts.show')).toBe(true);
  });

  it('firing the shortcuts.show shortcut opens the (previously closed) sheet', async () => {
    renderHost(<GlobalShortcutsHelp />);
    expect(screen.getByTestId('sheet').getAttribute('data-open')).toBe('false');
    registered.find((r) => r.id === 'shortcuts.show')!.run(new KeyboardEvent('keydown'));
    await waitFor(() => expect(screen.getByTestId('sheet').getAttribute('data-open')).toBe('true'));
  });
});
