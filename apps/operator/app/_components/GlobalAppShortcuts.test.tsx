// @vitest-environment jsdom
/**
 * GlobalAppShortcuts.test.tsx — render-tier coverage for the app-level
 * navigation shortcuts. The component renders nothing; it registers three
 * actions (settings.open / goto.inbox / harness.create) against the shortcut
 * bus via useShortcutAction. We mock that hook to capture the handlers and the
 * router-compat useRouter to spy on push(), then invoke each handler and assert
 * the navigation target.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const registered: Array<{ id: string; run: (e: KeyboardEvent) => void }> = [];
vi.mock('../../lib/hotkeys', () => ({
  useShortcutAction: (id: string, run: (e: KeyboardEvent) => void) => {
    registered.push({ id, run });
  },
}));

const push = vi.fn();
vi.mock('../../lib/router-compat/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

import GlobalAppShortcuts from './GlobalAppShortcuts';

function handlerFor(id: string) {
  return registered.find((r) => r.id === id);
}

beforeEach(() => {
  registered.length = 0;
  push.mockReset();
});
afterEach(cleanup);

describe('GlobalAppShortcuts', () => {
  it('renders nothing', () => {
    const { container } = render(<GlobalAppShortcuts />);
    expect(container.firstChild).toBeNull();
  });

  it('registers settings.open, goto.inbox and harness.create', () => {
    render(<GlobalAppShortcuts />);
    expect(handlerFor('settings.open')).toBeTruthy();
    expect(handlerFor('goto.inbox')).toBeTruthy();
    expect(handlerFor('harness.create')).toBeTruthy();
  });

  it('settings.open navigates to /settings', () => {
    render(<GlobalAppShortcuts />);
    handlerFor('settings.open')!.run(new KeyboardEvent('keydown'));
    expect(push).toHaveBeenCalledWith('/settings');
  });

  it('goto.inbox navigates to /adv?tab=conversations', () => {
    render(<GlobalAppShortcuts />);
    handlerFor('goto.inbox')!.run(new KeyboardEvent('keydown'));
    expect(push).toHaveBeenCalledWith('/adv?tab=conversations');
  });

  it('harness.create navigates to /adv?create=true', () => {
    render(<GlobalAppShortcuts />);
    handlerFor('harness.create')!.run(new KeyboardEvent('keydown'));
    expect(push).toHaveBeenCalledWith('/adv?create=true');
  });
});
