// @vitest-environment jsdom
/**
 * GoalDetailPanel render coverage (goal-mode-2026-08-07 P-021).
 *
 * The arithmetic is covered exhaustively in goal-detail-model.test.ts. What
 * only a DOM can prove — and what this suite therefore pins — are the four
 * claims the surface makes that a passing model test would not catch:
 *
 *   1. A KILLED project is still on the page. This is the one the item calls
 *      out: dropping it is a one-word change (`.filter(p => !p.removed)`) that
 *      every model test still passes, and the page then only ever shows growth.
 *   2. An unmeasured tripwire does not render as a filled bar.
 *   3. The panel asks for the workspace it was GIVEN — a `'default'` fallback
 *      here renders a healthy-looking page pointed at the wrong tenant.
 *   4. A free-text criterion with no tripwires renders prose and no chart
 *      furniture — the normal case, and the one most likely to regress into an
 *      empty-state placeholder that implies something is missing.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { GoalDetailInput } from './goal-detail-model';

const syncCalls: Array<{ queryName: string; args?: Record<string, unknown>; enabled?: boolean }> = [];
let syncResult: { data: unknown[] | null; loading: boolean; error: unknown } = {
  data: null,
  loading: false,
  error: null,
};

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string; args?: Record<string, unknown>; enabled?: boolean }) => {
    syncCalls.push(opts);
    return { ...syncResult, fetching: false, invalidate: vi.fn() };
  },
}));

// The Radix dialog renders into a portal; the assertions below read
// document.body, so no shim is needed — but jsdom lacks the pointer-capture
// APIs Radix probes on mount.
beforeEach(() => {
  syncCalls.length = 0;
  syncResult = { data: null, loading: false, error: null };
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
});
afterEach(cleanup);

// eslint-disable-next-line import/first
import GoalDetailPanel from './GoalDetailPanel';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');

function detail(over: Partial<GoalDetailInput> = {}): GoalDetailInput {
  return {
    goal: {
      id: 'goal-1',
      title: 'Ship a paid app',
      status: 'active',
      killCriterion: 'Stop if no paying user by day 30.',
      spendUsd: 310,
      budgetCents: 50_000,
      ...over.goal,
    },
    projects: [],
    waitingOnYou: [],
    activity: [],
    spendByDay: [],
    spendLabel: 'fleet spend',
    spendNote: 'Goal spend figures do not sum.',
    ...over,
  };
}

function renderPanel(data: GoalDetailInput | null, props: Record<string, unknown> = {}) {
  syncResult = { data: data ? [data] : null, loading: false, error: null };
  return render(
    <GoalDetailPanel
      goalId="goal-1"
      workspaceId="ws-real"
      nowMs={NOW}
      onClose={() => {}}
      {...props}
    />,
  );
}

describe('GoalDetailPanel', () => {
  it('renders nothing and fires no query while closed', () => {
    render(<GoalDetailPanel goalId={null} workspaceId="ws-real" nowMs={NOW} onClose={() => {}} />);
    expect(document.body.textContent).not.toContain('This goal ends when');
    expect(syncCalls[0]?.enabled).toBe(false);
  });

  it('asks goals.detail for the workspace it was GIVEN, never a default', () => {
    // A silent 'default' here returns a real-looking empty page for the wrong
    // tenant — the failure mode that is hardest to see, because "no goals yet"
    // is a state this surface legitimately shows (the WI-5125 shape).
    renderPanel(detail());
    const call = syncCalls.find((c) => c.queryName === 'goals.detail');
    expect(call).toBeTruthy();
    expect(call?.args).toMatchObject({ workspaceId: 'ws-real', goalId: 'goal-1' });
    expect(call?.enabled).toBe(true);
  });

  it('leads with the kill criterion, verbatim', () => {
    renderPanel(detail());
    expect(screen.getByTestId('goal-kill-criterion').textContent).toBe(
      'Stop if no paying user by day 30.',
    );
  });

  it('shouts when NO kill criterion is set', () => {
    renderPanel(detail({ goal: { id: 'goal-1', title: 'g', status: 'active', killCriterion: null } }));
    const el = screen.getByTestId('goal-kill-criterion');
    expect(el.textContent).toMatch(/nothing can stop this goal/i);
    expect(el.className).toContain('hud-goal__criterion--missing');
  });

  it('renders a free-text criterion with NO tripwire furniture', () => {
    // Tripwires are optional; the no-bars case must look finished, not empty.
    renderPanel(detail());
    expect(screen.queryByTestId('goal-tripwires')).toBeNull();
    expect(screen.getByTestId('goal-kill-criterion')).toBeTruthy();
  });

  it('renders tripwire bars, and does NOT fill an unmeasured one', () => {
    renderPanel(
      detail({
        goal: {
          id: 'goal-1',
          title: 'g',
          status: 'active',
          killCriterion: 'stop at 30 days or $500',
          tripwires: [
            { metric: 'elapsed', label: 'Elapsed', threshold: 30, current: 12, unit: 'days' },
            { metric: 'spend', label: 'Spend', threshold: 500, current: 310, unit: 'usd' },
            { metric: 'builds', label: 'Shipped builds', threshold: 1 },
          ],
        },
      }),
    );
    const bars = screen.getByTestId('goal-tripwires');
    expect(bars.textContent).toContain('day 12 of 30');
    expect(bars.textContent).toContain('$310 of $500');
    expect(bars.textContent).toContain('not measured yet');

    // Three bars, but only TWO fills: the unread one must be visually distinct
    // from a real zero rather than a zero-width fill nobody can tell apart.
    expect(bars.querySelectorAll('.hud-goal__bar-fill')).toHaveLength(2);
    expect(bars.querySelectorAll('.hud-goal__bar-unread')).toHaveLength(1);
  });

  it('KEEPS a closed project on the page, with its reason', () => {
    // The invariant the item singles out. A `.filter(p => !p.removed)` in the
    // component would leave every model test green and delete the only
    // evidence that the agent closes things.
    renderPanel(
      detail({
        projects: [
          { harnessSlug: 'alpha', role: 'owner', killCriterion: 'ship by day 14', servesGoals: 1 },
          {
            harnessSlug: 'beta',
            role: 'contributing',
            killCriterion: 'ship by day 14',
            servesGoals: 1,
            removedAt: '2026-08-05T00:00:00Z',
            note: 'no traction after two weeks',
          },
        ],
      }),
    );
    expect(screen.getByTestId('goal-projects').textContent).toContain('alpha');

    const closed = screen.getByTestId('goal-projects-closed');
    expect(closed.textContent).toContain('beta');
    expect(closed.textContent).toContain('no traction after two weeks');
    expect(closed.querySelector('.hud-goal__proj--removed')).toBeTruthy();
  });

  it('shows each project its OWN kill criterion and the shared badge', () => {
    renderPanel(
      detail({
        projects: [
          { harnessSlug: 'alpha', role: 'owner', killCriterion: 'ship by day 14', servesGoals: 3 },
          { harnessSlug: 'gamma', role: 'contributing', servesGoals: 1 },
        ],
      }),
    );
    const grid = screen.getByTestId('goal-projects');
    expect(grid.textContent).toContain('ship by day 14');
    expect(grid.textContent).toContain('shared with 2 other goals');
    // Clause 4 requires one per project — its absence is surfaced, not hidden.
    expect(grid.textContent).toContain('No kill criterion for this project');
  });

  it('lists waiting-on-you above activity and opens an item', () => {
    const onOpenWorkItem = vi.fn();
    renderPanel(
      detail({
        waitingOnYou: [
          { id: 'WI-1', title: 'Approve the pricing page', harnessSlug: 'alpha', updatedAt: '2026-08-09T08:00:00Z' },
        ],
        activity: [
          { id: 'WI-2', title: 'Built the checkout', harnessSlug: 'alpha', closedAt: '2026-08-09T09:00:00Z' },
        ],
      }),
      { onOpenWorkItem },
    );
    const body = document.body.textContent ?? '';
    expect(body.indexOf('Waiting on you')).toBeLessThan(body.indexOf('Activity'));

    fireEvent.click(screen.getByRole('button', { name: 'Approve the pricing page' }));
    expect(onOpenWorkItem).toHaveBeenCalledWith('WI-1');
  });

  it('carries the do-not-sum caveat next to the spend chart', () => {
    // D-021: a shared project counts in full against every goal it serves, so
    // these figures do not add up. This is the section most likely to be
    // screenshotted, so the caveat travels with it.
    renderPanel(
      detail({
        spendByDay: [
          { day: '2026-08-01', harnessSlug: 'alpha', costUsd: 3 },
          { day: '2026-08-02', harnessSlug: 'alpha', costUsd: 8 },
        ],
      }),
    );
    expect(screen.getByTestId('goal-spend-chart').querySelectorAll('.hud-goal__col')).toHaveLength(2);
    expect(document.body.textContent).toContain('Goal spend figures do not sum.');
  });

  it('says a goal is gone rather than rendering an empty shell', () => {
    syncResult = { data: [{ goal: null }], loading: false, error: null };
    render(<GoalDetailPanel goalId="goal-1" workspaceId="ws-real" nowMs={NOW} onClose={() => {}} />);
    expect(document.body.textContent).toContain('no longer exists');
  });

  it('surfaces a load error instead of an empty page', () => {
    syncResult = { data: null, loading: false, error: new Error('boom') };
    render(<GoalDetailPanel goalId="goal-1" workspaceId="ws-real" nowMs={NOW} onClose={() => {}} />);
    expect(document.body.textContent).toContain('Could not load this goal');
  });

  it('closing clears the selection', () => {
    const onClose = vi.fn();
    renderPanel(detail(), { onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
