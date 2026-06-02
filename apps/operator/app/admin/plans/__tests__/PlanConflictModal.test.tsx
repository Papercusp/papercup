/**
 * @vitest-environment jsdom
 *
 * PlanConflictModal — compare-and-swap stale-recovery surface tests
 * (P-301, D-011).
 *
 * Covers:
 *  - Closed modal (open={false}) renders nothing.
 *  - Open modal renders the conflict explanation + the on-disk current
 *    content in a <pre>.
 *  - "Keep my draft open" fires onKeepEditing (and not onReload).
 *  - "Discard my edits & reload" fires onReload (and not onKeepEditing).
 *  - Dismissing the dialog (Radix onOpenChange(false), here via Escape)
 *    routes to onKeepEditing — the deliberate non-destructive default.
 *
 * Uses @testing-library/react + vitest only (no jest-dom matchers).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PlanConflictModal from '../PlanConflictModal';

afterEach(() => cleanup());

const DISK_CONTENT = '# Plan v2\n\nSomeone else edited this on disk.';

describe('PlanConflictModal — open/closed', () => {
  it('renders nothing when open is false', () => {
    render(
      <PlanConflictModal
        open={false}
        currentContent={DISK_CONTENT}
        onReload={vi.fn()}
        onKeepEditing={vi.fn()}
      />,
    );
    expect(screen.queryByText('Plan changed on disk')).toBeNull();
    expect(screen.queryByText(/Someone else edited this on disk/)).toBeNull();
  });

  it('renders the heading, explanation, and on-disk current content when open', () => {
    render(
      <PlanConflictModal
        open
        currentContent={DISK_CONTENT}
        onReload={vi.fn()}
        onKeepEditing={vi.fn()}
      />,
    );
    // Heading (the sr-only Dialog.Title also carries this string, so there
    // are 2 matches — use getAllByText).
    expect(screen.getAllByText('Plan changed on disk').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/compare-and-swap, D-011/)).toBeTruthy();
    expect(screen.getByText('Current version on disk')).toBeTruthy();
    // The on-disk content is rendered verbatim inside the <pre>.
    expect(screen.getByText(/Someone else edited this on disk\./)).toBeTruthy();
  });
});

describe('PlanConflictModal — actions', () => {
  it('"Keep my draft open" fires onKeepEditing only', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    const onKeepEditing = vi.fn();
    render(
      <PlanConflictModal
        open
        currentContent={DISK_CONTENT}
        onReload={onReload}
        onKeepEditing={onKeepEditing}
      />,
    );
    await user.click(screen.getByText('Keep my draft open'));
    expect(onKeepEditing).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();
  });

  it('"Discard my edits & reload" fires onReload only', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    const onKeepEditing = vi.fn();
    render(
      <PlanConflictModal
        open
        currentContent={DISK_CONTENT}
        onReload={onReload}
        onKeepEditing={onKeepEditing}
      />,
    );
    await user.click(screen.getByText(/Discard my edits .* reload/));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onKeepEditing).not.toHaveBeenCalled();
  });

  it('dismissing the dialog (Escape) routes to onKeepEditing, not onReload', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    const onKeepEditing = vi.fn();
    render(
      <PlanConflictModal
        open
        currentContent={DISK_CONTENT}
        onReload={onReload}
        onKeepEditing={onKeepEditing}
      />,
    );
    // Radix Dialog closes on Escape → onOpenChange(false) → onKeepEditing.
    await user.keyboard('{Escape}');
    expect(onKeepEditing).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();
  });
});
