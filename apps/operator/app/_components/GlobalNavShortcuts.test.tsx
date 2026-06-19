// @vitest-environment jsdom
/**
 * GlobalNavShortcuts.test.tsx — render-tier coverage for the desktop-shell
 * back/forward navigation shortcuts. The component renders nothing; it
 * registers two actions (`navigation.back` / `navigation.forward`) against the
 * shortcut bus via `useShortcutAction`. We mock that hook to capture the
 * registered handlers, then invoke them and assert they call the raw History
 * API — and that they register with the form-tag opt-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
// Capture each useShortcutAction(id, run, opts) call so the test can drive the
// registered handler directly.
const registered: Array<{ id: string; run: (e: KeyboardEvent) => void; opts: unknown }> = [];
vi.mock('../../lib/hotkeys', () => ({
  useShortcutAction: (id: string, run: (e: KeyboardEvent) => void, opts: unknown) => {
    registered.push({ id, run, opts });
  },
}));

import GlobalNavShortcuts from './GlobalNavShortcuts';

function handlerFor(id: string) {
  return registered.find((r) => r.id === id);
}

beforeEach(() => {
  registered.length = 0;
});
afterEach(cleanup);

describe('GlobalNavShortcuts', () => {
  it('renders nothing', () => {
    const { container } = render(<GlobalNavShortcuts />);
    expect(container.firstChild).toBeNull();
  });

  it('registers both navigation.back and navigation.forward actions', () => {
    render(<GlobalNavShortcuts />);
    expect(handlerFor('navigation.back')).toBeTruthy();
    expect(handlerFor('navigation.forward')).toBeTruthy();
  });

  it('enables the shortcuts while focus is in form inputs (enableOnFormTags)', () => {
    render(<GlobalNavShortcuts />);
    const back = handlerFor('navigation.back')!;
    expect(back.opts).toMatchObject({ enableOnFormTags: ['INPUT', 'TEXTAREA', 'SELECT'] });
  });

  it('navigation.back calls window.history.back()', () => {
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    render(<GlobalNavShortcuts />);
    handlerFor('navigation.back')!.run(new KeyboardEvent('keydown'));
    expect(backSpy).toHaveBeenCalledTimes(1);
    backSpy.mockRestore();
  });

  it('navigation.forward calls window.history.forward()', () => {
    const fwdSpy = vi.spyOn(window.history, 'forward').mockImplementation(() => {});
    render(<GlobalNavShortcuts />);
    handlerFor('navigation.forward')!.run(new KeyboardEvent('keydown'));
    expect(fwdSpy).toHaveBeenCalledTimes(1);
    fwdSpy.mockRestore();
  });
});
