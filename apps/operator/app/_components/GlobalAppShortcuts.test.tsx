// @vitest-environment jsdom
/**
 * GlobalAppShortcuts.test.tsx — render-tier coverage for the app-level
 * navigation shortcuts. The component renders nothing; it registers five
 * actions (settings.open / goto.inbox / harness.create /
 * goto.insights) against the shortcut bus via useShortcutAction. We mock that
 * hook to capture the handlers and the router-compat useRouter to spy on
 * push(), then invoke each handler and assert the navigation target.
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

  // settings-audit 2026-07-09: goto.insights shipped in the shortcut registry
  // with no handler in ANY component, so the /settings/shortcuts row let a user
  // rebind a key that fired nothing. These lock in the root fallback.
  // (goto.brainstorm removed 2026-07-13 with the /adv Brainstorm tab — the
  // surface lives in the Quick Panel popup now; quick-panel-saved-prompts P-010.)
  it('registers goto.insights and NOT the removed goto.brainstorm', () => {
    render(<GlobalAppShortcuts />);
    expect(handlerFor('goto.insights')).toBeTruthy();
    expect(handlerFor('goto.brainstorm')).toBeFalsy();
  });

  it('goto.insights navigates to /adv?tab=insights', () => {
    render(<GlobalAppShortcuts />);
    handlerFor('goto.insights')!.run(new KeyboardEvent('keydown'));
    expect(push).toHaveBeenCalledWith('/adv?tab=insights');
  });

  it('settings.open navigates to /settings', () => {
    render(<GlobalAppShortcuts />);
    handlerFor('settings.open')!.run(new KeyboardEvent('keydown'));
    expect(push).toHaveBeenCalledWith('/settings');
  });

  it('goto.inbox navigates to the canonical Resolution Inbox face', () => {
    render(<GlobalAppShortcuts />);
    handlerFor('goto.inbox')!.run(new KeyboardEvent('keydown'));
    expect(push).toHaveBeenCalledWith('/adv?opcv=inbox');
  });

  it('harness.create navigates to /adv?create=true', () => {
    render(<GlobalAppShortcuts />);
    handlerFor('harness.create')!.run(new KeyboardEvent('keydown'));
    expect(push).toHaveBeenCalledWith('/adv?create=true');
  });
});
