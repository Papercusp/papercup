// @vitest-environment jsdom

/**
 * GoalTab — the rail glance for GOAL mode (goal-mode-2026-08-07 P-019).
 *
 * What these tests are actually protecting, in priority order:
 *
 *   1. D-021 SURVIVES INTO THE PIXELS. A project can serve several goals, so
 *      per-goal spend deliberately does not sum and the header must render the
 *      resolver's distinct-project `portfolioSpendUsd` rather than a re-sum of
 *      the cards. This is the invariant most likely to be "helpfully" broken by
 *      a later edit that notices the numbers do not add up — so it is asserted
 *      with a fixture where re-summing gives a DIFFERENT, wrong answer. A test
 *      whose fixture makes both formulas agree would pass either way and prove
 *      nothing.
 *   2. A goal with NO kill criterion is rendered LOUDLY, not as a blank line.
 *      Nothing can stop such a goal, which makes its absence the single most
 *      important thing on the card.
 *   3. Tripwire arithmetic is clamped, because an OVERSHOT tripwire (day 34 of
 *      a 30-day box) is exactly the case the owner needs to believe, and a bar
 *      rendering past its track reads as a layout bug at that moment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { GoalSummaryRow } from '@papercusp/operator-core/lib/sync-resolver/goals';

const H = vi.hoisted(() => ({
  rows: [] as unknown[],
  loading: false,
  error: null as unknown,
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: H.rows, loading: H.loading, error: H.error }),
}));

vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@radix-ui/react-tooltip', () => ({
  Provider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/lib/use-workspace-id', () => ({
  useWorkspaceId: () => 'papercusp-workspace',
}));

const SEED = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/app/_components/inbox/chat-seed', () => ({
  seedOperatorChatDraft: SEED.fn,
}));

import GoalTab, {
  GOAL_KICKOFF_DRAFT,
  rankGoals,
  tripwireBreached,
  tripwireFill,
  tripwireLabel,
} from './GoalTab';

function goal(over: Partial<GoalSummaryRow> = {}): GoalSummaryRow {
  return {
    id: 'g1',
    title: 'Ship a paid app',
    body: null,
    status: 'active',
    parentId: null,
    killCriterion: 'No paying user by day 30.',
    tripwires: [],
    budgetCents: 50_000,
    spentCents: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    projectCount: 2,
    openWorkItems: 7,
    needsHuman: 0,
    spendUsd: 310,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  H.rows = [];
  H.loading = false;
  H.error = null;
  SEED.fn.mockClear();
});

describe('tripwire arithmetic', () => {
  it('clamps an OVERSHOT tripwire to a full bar while the label keeps the real numbers', () => {
    const t = { metric: 'days', label: 'elapsed', threshold: 30, current: 34, unit: 'days' };
    // Clamped: an unclamped 1.13 would paint past the track.
    expect(tripwireFill(t)).toBe(1);
    // …but the overshoot is NOT lost — it survives in both the flag and the text.
    expect(tripwireBreached(t)).toBe(true);
    expect(tripwireLabel(t)).toBe('34 of 30 days');
  });

  it('treats a missing `current` as zero rather than NaN', () => {
    // A tripwire whose evidence has not landed yet is the NORMAL state right
    // after goal creation, so it must render as an empty bar, not a broken one.
    const t = { metric: 'builds', label: 'shipped builds', threshold: 1 };
    expect(tripwireFill(t)).toBe(0);
    expect(tripwireBreached(t)).toBe(false);
    expect(tripwireLabel(t)).toBe('0 of 1');
  });

  it('does not divide by a zero or negative threshold', () => {
    expect(tripwireFill({ metric: 'x', label: 'x', threshold: 0, current: 5 })).toBe(0);
    expect(tripwireBreached({ metric: 'x', label: 'x', threshold: 0, current: 5 })).toBe(false);
  });
});

describe('rankGoals', () => {
  it('puts the goals that can still change first', () => {
    const ranked = rankGoals([
      goal({ id: 'closed', status: 'closed' }),
      goal({ id: 'paused', status: 'paused' }),
      goal({ id: 'active', status: 'active' }),
    ]);
    expect(ranked.map((g) => g.id)).toEqual(['active', 'paused', 'closed']);
  });

  it('is pure — it does not reorder its input', () => {
    const input = [goal({ id: 'a', status: 'closed' }), goal({ id: 'b', status: 'active' })];
    rankGoals(input);
    expect(input.map((g) => g.id)).toEqual(['a', 'b']);
  });
});

describe('GoalTab rendering', () => {
  it('renders the PORTFOLIO total, not the sum of the cards (D-021)', () => {
    // The fixture is chosen so the two formulas DISAGREE: two goals at $300 each
    // sum to $600, but they share a project, so the honest distinct-project
    // portfolio figure is $400. A fixture where they agreed would pass whether
    // or not the component re-sums, and would protect nothing.
    H.rows = [
      {
        goals: [
          goal({ id: 'g1', title: 'Goal one', spendUsd: 300 }),
          goal({ id: 'g2', title: 'Goal two', spendUsd: 300 }),
        ],
        portfolioSpendUsd: 400,
        portfolioProjects: 3,
      },
    ];
    render(<GoalTab active />);

    expect(screen.getByTestId('goal-portfolio-spend').textContent).toContain('$400');
    // The wrong answer must be absent, not merely unasserted.
    expect(screen.getByTestId('goal-portfolio-spend').textContent).not.toContain('$600');
    // Each goal still reports its own FULL cost — that is the other half of D-021.
    expect(screen.getByTestId('goal-spend-g1').textContent).toContain('$300');
    expect(screen.getByTestId('goal-spend-g2').textContent).toContain('$300');
  });

  it('says LOUDLY when a goal has no kill criterion', () => {
    H.rows = [{ goals: [goal({ killCriterion: null })], portfolioSpendUsd: 0, portfolioProjects: 0 }];
    render(<GoalTab active />);
    // "nothing can stop this" is the point: a goal with no criterion never ends,
    // so the absence has to be readable at a glance rather than an empty line.
    expect(screen.getByTestId('goal-ends-g1').textContent).toContain('no kill criterion');
  });

  it('renders the criterion verbatim when there is one', () => {
    H.rows = [{ goals: [goal()], portfolioSpendUsd: 0, portfolioProjects: 0 }];
    render(<GoalTab active />);
    expect(screen.getByTestId('goal-ends-g1').textContent).toContain('No paying user by day 30.');
  });

  it('flags a breached tripwire in the markup, not only in the label text', () => {
    H.rows = [
      {
        goals: [
          goal({
            tripwires: [
              { metric: 'days', label: 'elapsed', threshold: 30, current: 34, unit: 'days' },
              { metric: 'builds', label: 'shipped', threshold: 1, current: 0 },
            ],
          }),
        ],
        portfolioSpendUsd: 0,
        portfolioProjects: 0,
      },
    ];
    render(<GoalTab active />);
    expect(screen.getByTestId('goal-wire-g1-days').getAttribute('data-breached')).toBe('true');
    expect(screen.getByTestId('goal-wire-g1-builds').getAttribute('data-breached')).toBe('false');
  });

  it('marks spend that has reached the ceiling', () => {
    H.rows = [
      { goals: [goal({ budgetCents: 30_000, spendUsd: 310 })], portfolioSpendUsd: 310, portfolioProjects: 1 },
    ];
    render(<GoalTab active />);
    // $310 against a $300 ceiling — the second thing that can stop a goal.
    expect(screen.getByTestId('goal-spend-g1').closest('[data-over]')?.getAttribute('data-over')).toBe('true');
  });

  it('surfaces the waiting-on-you count only when there is something to act on', () => {
    H.rows = [
      { goals: [goal({ id: 'g1', needsHuman: 0 }), goal({ id: 'g2', needsHuman: 3 })], portfolioSpendUsd: 0, portfolioProjects: 0 },
    ];
    render(<GoalTab active />);
    // A permanent "0 waiting on you" row trains the owner to ignore the slot,
    // which is precisely when a real 3 needs to catch their eye.
    expect(screen.queryByTestId('goal-needsyou-g1')).toBeNull();
    expect(screen.getByTestId('goal-needsyou-g2').textContent).toContain('3 waiting on you');
  });

  it('renders nothing at all when the tab is not the active one', () => {
    // Panels are lazy()'d but STAY mounted once visited, so an inactive tab that
    // still rendered would keep re-querying in the background.
    H.rows = [{ goals: [goal()], portfolioSpendUsd: 0, portfolioProjects: 0 }];
    const { container } = render(<GoalTab active={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('invites the FIRST goal instead of showing a bare empty state', () => {
    H.rows = [{ goals: [], portfolioSpendUsd: 0, portfolioProjects: 0 }];
    render(<GoalTab active />);
    expect(screen.getByTestId('left-sidebar-goal').textContent).toContain('No goals yet');
  });
});

/**
 * The kickoff half of P-022 — the replacement for a "New Goal" form.
 *
 * The button stages a draft in a composer that lives in ANOTHER pane and may
 * not even be mounted, so the two things worth pinning are (a) that it really
 * seeds, and (b) that it says so IN PLACE. Without (b) this is the
 * "I clicked it and nothing happened" failure (WI-5175) by construction: the
 * only feedback would be in a pane the owner isn't looking at.
 */
describe('GoalTab kickoff (P-022)', () => {
  it('seeds the chat composer with the kickoff draft when Start a goal is clicked', () => {
    H.rows = [{ goals: [], portfolioSpendUsd: 0, portfolioProjects: 0 }];
    render(<GoalTab active />);
    fireEvent.click(screen.getByTestId('goal-start-kickoff'));
    expect(SEED.fn).toHaveBeenCalledTimes(1);
    expect(SEED.fn).toHaveBeenCalledWith(GOAL_KICKOFF_DRAFT);
  });

  it('confirms IN PLACE, because the composer it seeded is in another pane', () => {
    H.rows = [{ goals: [], portfolioSpendUsd: 0, portfolioProjects: 0 }];
    render(<GoalTab active />);
    expect(screen.queryByTestId('goal-kickoff-seeded')).toBeNull();
    fireEvent.click(screen.getByTestId('goal-start-kickoff'));
    const note = screen.getByTestId('goal-kickoff-seeded');
    expect(note.textContent).toContain('Kickoff drafted');
    // role=status so a screen reader announces it — a silently-appearing line
    // is the same non-feedback as no line at all.
    expect(note.getAttribute('role')).toBe('status');
  });

  it('offers kickoff even when goals ALREADY exist — it is not an empty-state affordance', () => {
    H.rows = [{ goals: [goal()], portfolioSpendUsd: 310, portfolioProjects: 1 }];
    render(<GoalTab active />);
    expect(screen.getByTestId('goal-start-kickoff')).toBeTruthy();
  });

  it('drafts a PROMPT the owner finishes rather than a message that auto-sends', () => {
    // The trailing "The goal: " is what makes this a template and not a form:
    // it is left open, and nothing here sends anything.
    expect(GOAL_KICKOFF_DRAFT.endsWith('The goal: ')).toBe(true);
  });

  it('names goals:propose, so the agent lands on the confirm card instead of creating unilaterally', () => {
    // If this drifts to goals:create the whole P-022 confirm step is bypassed
    // and the owner never sees the criterion or the ceiling before the write.
    expect(GOAL_KICKOFF_DRAFT).toContain('goals:propose');
    expect(GOAL_KICKOFF_DRAFT).not.toContain('goals:create');
  });

  it('asks for the portfolio read and the relationship — the two things a form cannot do', () => {
    expect(GOAL_KICKOFF_DRAFT).toContain('goals:list');
    expect(GOAL_KICKOFF_DRAFT).toContain('kill criterion');
    expect(GOAL_KICKOFF_DRAFT).toContain('spend ceiling');
    expect(GOAL_KICKOFF_DRAFT).toContain('sub-goal');
  });
});
