/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DockNavChevrons } from './DockNavChevrons';
import {
  _resetTabVisitHistoryForTests,
  _testHooks as tabHooks,
} from './useTabVisitHistory';

beforeEach(() => _resetTabVisitHistoryForTests());
afterEach(() => {
  cleanup();
  _resetTabVisitHistoryForTests();
});

describe('DockNavChevrons', () => {
  it('always renders both buttons (disabled when empty)', () => {
    render(<DockNavChevrons />);
    expect(screen.getByLabelText('Back to previous tab')).toBeTruthy();
    expect(screen.getByLabelText('Forward to next tab')).toBeTruthy();
  });

  it('back button disabled when no history', () => {
    render(<DockNavChevrons />);
    const back = screen.getByLabelText('Back to previous tab') as HTMLButtonElement;
    expect(back.disabled).toBe(true);
  });

  it('back button enabled when tab-visit history has cursor > 0', () => {
    render(<DockNavChevrons />);
    tabHooks.pushIfNew('a');
    tabHooks.pushIfNew('b');
    // Re-render gets triggered by store subscription.
    // The state may not auto-flush; verify via getState first.
    expect(tabHooks.getState().cursor).toBe(1);
    // Force re-render by re-running render assertion.
    // (Note: jsdom's effect timing — the store notifies, the component
    // re-renders. We assert eventually.)
    cleanup();
    render(<DockNavChevrons />);
    const back = screen.getByLabelText('Back to previous tab') as HTMLButtonElement;
    expect(back.disabled).toBe(false);
  });

  it('renders aria-label "Tab history" on the group', () => {
    render(<DockNavChevrons />);
    expect(screen.getByLabelText('Tab history')).toBeTruthy();
  });

  it('forward disabled by default', () => {
    render(<DockNavChevrons />);
    const fwd = screen.getByLabelText('Forward to next tab') as HTMLButtonElement;
    expect(fwd.disabled).toBe(true);
  });
});
