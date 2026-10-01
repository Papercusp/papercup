// @vitest-environment jsdom
// PotHealthPane — REBUILT for the su-only era (retire-mug-kettle-su-only-2026-08-09
// P-018..P-021, design D-032). Pins the three questions the pane now answers —
// what the pot is POINTED AT (goals), whether it is WORKING (throughput +
// attention), and who is DRIVING (su agents) — plus the two rulings that are
// easiest to undo by accident:
//
//   1. liveness comes from `fleet.status`'s `sessionState`, NOT from a heartbeat
//      (the "warm-dead" case below is the regression guard, and it is the whole
//      reason the pane was rebuilt rather than patched);
//   2. the goals section is ONE `goals.list` — never a per-goal `goals.detail`
//      fan-out.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  queries: {} as Record<string, { data?: unknown[] }>,
  queryNames: [] as string[],
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string }) => {
    h.queryNames.push(opts.queryName);
    return { data: h.queries[opts.queryName]?.data };
  },
}));

import { PotHealthPane } from './PotHealthPane';

const NOW = Date.now();

function seedGoals(goals: unknown[] = [defaultGoal()]) {
  h.queries['goals.list'] = {
    data: [{ goals, portfolioSpendUsd: 412.5, portfolioPots: 3 }],
  };
}

function defaultGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'G-1',
    title: 'Ship the desktop beta',
    status: 'active',
    killCriterion: 'Stop when the beta has 20 external installs.',
    tripwires: [
      { metric: 'spend', label: 'spend', threshold: 500, current: 310, unit: 'usd' },
      // No `current` — this one must render as UNREAD, never as a healthy zero.
      { metric: 'installs', label: 'installs', threshold: 20 },
    ],
    budgetCents: 50_000,
    // With a ceiling set, the ceiling line reads the windowed `spentCents` and never
    // substitutes lifetime `spendUsd` (goalCeilingSpendUsd) — absent ⇒ "Unmeasured".
    spentCents: 31_000,
    spendUsd: 310,
    spendRecentUsd: 70,
    spendRecentWindowDays: 7,
    openWorkItems: 9,
    needsHuman: 2,
    potCount: 3,
    lastActivityAt: new Date(NOW - 3 * 60 * 60_000).toISOString(),
    ...overrides,
  };
}

function seedAgents(rows: unknown[]) {
  h.queries['fleet.status'] = { data: rows };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    ownerId: 'su-aaaa',
    label: 'su · aaaa',
    role: 'su',
    intent: 'rebuilding the pot health pane',
    planSlug: 'retire-mug-kettle-su-only-2026-08-09',
    potSlug: 'papercusp',
    fleetSlug: null,
    fleetRole: null,
    sessionState: 'live',
    lastActiveSecAgo: 45,
    ...overrides,
  };
}

/** The server's 8s-deadline fallback for `plans.attentionCounts`: a graceful
 *  EMPTY feed, which derives to all-zeros, marked `degraded` (WI-39779). This
 *  is the exact shape a timed-out read puts on the wire — the zeros are the
 *  point, and rendering them as fact is what WI-39802 fixed. */
const DEGRADED_ATTENTION = {
  decisionItems: 0,
  decisionPlans: 0,
  alerts: 0,
  total: 0,
  degraded: true,
};

function seedThroughput(attentionOverrides: Record<string, unknown> = {}) {
  h.queries['workItems.stats'] = {
    data: [
      { kind: 'bug', state: 'open', n: 12, terminal: false },
      { kind: 'change', state: 'done', n: 40, terminal: true },
      { kind: 'task', state: 'wip', n: 3, terminal: false },
    ],
  };
  h.queries['workItems.delta24h'] = {
    data: [
      { kind: 'bug', opened: 4, closed: 6 },
      { kind: 'change', opened: 2, closed: 1 },
    ],
  };
  h.queries['plans.attentionCounts'] = {
    data: [{ decisionItems: 2, decisionPlans: 1, alerts: 0, total: 3, ...attentionOverrides }],
  };
  h.queries['usage.spend'] = {
    data: [{ h1: { spendUsd: 1.25, calls: 30 }, h24: { spendUsd: 42.5, calls: 900 } }],
  };
}

function seedAll() {
  seedGoals();
  seedAgents([agent()]);
  seedThroughput();
}

beforeEach(() => {
  h.queries = {};
  h.queryNames = [];
});
afterEach(cleanup);

describe('PotHealthPane (su-only rebuild — P-018..P-021 / D-032)', () => {
  it('reads only REUSED sync queries — no parallel data path, and no retired mug/kettle brief', () => {
    seedAll();
    render(<PotHealthPane />);

    expect(new Set(h.queryNames)).toEqual(
      new Set([
        'goals.list',
        'fleet.status',
        'workItems.stats',
        'workItems.delta24h',
        'plans.attentionCounts',
        'usage.spend',
      ]),
    );
    // The retired tier's briefs must not come back.
    expect(h.queryNames).not.toContain('mugBrief.floorView');
    expect(h.queryNames).not.toContain('overwatch.snapshot');
    expect(h.queryNames).not.toContain('overwatch.liveness');
  });

  it('does NOT fan out a goals.detail per goal — the goals section is one query', () => {
    seedGoals([defaultGoal(), defaultGoal({ id: 'G-2', title: 'Second goal' })]);
    seedAgents([agent()]);
    seedThroughput();
    render(<PotHealthPane />);

    expect(h.queryNames).not.toContain('goals.detail');
    expect(h.queryNames.filter((q) => q === 'goals.list')).toHaveLength(1);
  });

  it('orders WHO IS DRIVING after IS IT WORKING at the bottom of the pane', () => {
    seedAll();
    render(<PotHealthPane />);

    const sectionHeadings = screen.getAllByRole('heading', { level: 3 }).map((heading) => {
      const suffix = heading.querySelector('.op-ph-sec-d')?.textContent ?? '';
      return heading.textContent?.replace(suffix, '').trim();
    });
    expect(sectionHeadings).toEqual([
      'What the pot is pointed at',
      'Is it working',
      'Who is driving',
    ]);
  });

  it('renders a loading placeholder while every query is cold', () => {
    render(<PotHealthPane />);
    expect(screen.getByText(/loading pot health/i)).toBeTruthy();
  });

  it('GOALS: renders the kill criterion, the ceiling, and the goal meta', () => {
    seedAll();
    const { container } = render(<PotHealthPane />);

    expect(screen.getByText('Stop when the beta has 20 external installs.')).toBeTruthy();
    // Scoped to the kv grid on purpose: "$310 of $500" is ALSO the spend
    // tripwire's value text, and the two are different readouts that happen to
    // agree. Asserting it unscoped would pass even if the ceiling row vanished.
    const kvValues = [...container.querySelectorAll('.op-ph-kv .op-ph-v')].map(
      (el) => el.textContent,
    );
    expect(kvValues).toContain('$310 of $500');
    expect(screen.getByText(/3 pots · 9 open · 2 need you/)).toBeTruthy();
  });

  it('GOALS: a goal with NO kill criterion says so loudly — nothing can stop it', () => {
    seedGoals([defaultGoal({ killCriterion: null })]);
    seedAgents([agent()]);
    seedThroughput();
    render(<PotHealthPane />);

    expect(screen.getByText(/no kill criterion was set/i)).toBeTruthy();
  });

  it('GOALS: an UNMEASURED tripwire renders as unread, never as a healthy zero', () => {
    seedAll();
    const { container } = render(<PotHealthPane />);

    const barValues = [...container.querySelectorAll('.op-ph-bar-value')].map(
      (el) => el.textContent ?? '',
    );
    // The measured tripwire shows its reading...
    expect(barValues).toContain('$310 of $500');
    // ...and the unmeasured one refuses to render a 0 it never took.
    expect(barValues.some((v) => /not measured yet/i.test(v))).toBe(true);
    expect(barValues).not.toContain('0 of 20');

    // Stronger than the text check: an unread bar must have NO fill element at
    // all, so it cannot read as a 0%-consumed (i.e. healthy) bar.
    const unread = container.querySelector('.op-ph-bar.unread');
    expect(unread).toBeTruthy();
    expect(unread?.querySelector('.op-ph-bar-fill')).toBeNull();
  });

  it('SU AGENTS: renders sessionState as the liveness verdict', () => {
    seedGoals();
    seedAgents([agent({ sessionState: 'live' })]);
    seedThroughput();
    render(<PotHealthPane />);

    expect(screen.getByText('su · aaaa')).toBeTruthy();
    expect(screen.getByText('live')).toBeTruthy();
    expect(screen.getByText('rebuilding the pot health pane')).toBeTruthy();
  });

  /**
   * THE REGRESSION GUARD for the reason this pane was rebuilt.
   *
   * A warm-dead session keeps beating — `lastActiveSecAgo` is small — while the
   * shared oracle has already ruled `sessionState: 'ended'`. Any liveness
   * derived from recency (the old pane's `live.alive`, or `PresenceRail`'s
   * heartbeat rule) renders this agent as healthy and green. It must not.
   */
  it('SU AGENTS: a WARM-DEAD agent (fresh heartbeat, sessionState ended) is not shown as healthy', () => {
    seedGoals();
    seedAgents([agent({ sessionState: 'ended', lastActiveSecAgo: 3 })]);
    seedThroughput();
    const { container } = render(<PotHealthPane />);

    expect(screen.getByText('ended')).toBeTruthy();
    // Its dot must carry the dead tone, and no live tone anywhere in the row.
    const row = container.querySelector('.op-ph-agent');
    expect(row).toBeTruthy();
    expect(row?.querySelector('.op-pot-dot.bad')).toBeTruthy();
    expect(row?.querySelector('.op-pot-dot.ok')).toBeNull();
    // And it must not be counted among the drivers.
    expect(screen.getByText('0 driving')).toBeTruthy();
  });

  it('SU AGENTS: an ABSENT verdict reads as unknown, not as live', () => {
    seedGoals();
    seedAgents([agent({ sessionState: null })]);
    seedThroughput();
    const { container } = render(<PotHealthPane />);

    expect(screen.getByText('unknown')).toBeTruthy();
    expect(container.querySelector('.op-ph-agent .op-pot-dot.ok')).toBeNull();
  });

  it('THROUGHPUT: renders open work, 24h movement, attention and spend', () => {
    seedAll();
    render(<PotHealthPane />);

    // open = the non-terminal rows only (12 + 3), never the done ones.
    expect(screen.getByText('15 items')).toBeTruthy();
    expect(screen.getByText('6 opened · 7 closed')).toBeTruthy();
    expect(screen.getByText('2 items · 1 plans')).toBeTruthy();
    expect(screen.getByText(/\$1\.25 last hour · \$42\.50 last 24h \(900 calls\)/)).toBeTruthy();
    expect(screen.getByText(/\$412\.50 across 3 pots/)).toBeTruthy();
  });

  it('honest empty states: no goals steering, nobody driving', () => {
    seedGoals([]);
    seedAgents([]);
    seedThroughput();
    render(<PotHealthPane />);

    expect(screen.getByText(/nothing is steering this pot/i)).toBeTruthy();
    expect(screen.getByText(/nobody is driving this pot/i)).toBeTruthy();
  });

  /* ── A DEGRADED attention read must never render as fact (WI-39779/WI-39802) ──
   *
   * `plans.attentionCounts` has an 8s server deadline whose graceful fallback is
   * an EMPTY feed deriving to all-zeros. WI-39779 put a `degraded` bit on the
   * row so that empty is distinguishable from a real one; the failure this
   * guards is the bit being DROPPED again — at the local row type, or (as it
   * was) by computing `attentionDegraded` and then never rendering it.
   *
   * The two readouts degrade DIFFERENTLY and both directions are pinned: the
   * chip is a MIXED aggregate (goals term unaffected ⇒ a real FLOOR survives),
   * the kv rows are PURE attention (⇒ nothing survives). */
  describe('degraded attention read', () => {
    it('CHIP: states a FLOOR — never a confident total that silently omits the attention terms', () => {
      seedGoals(); // defaultGoal carries needsHuman: 2 — a real, un-degraded term
      seedAgents([agent()]);
      seedThroughput(DEGRADED_ATTENTION);
      render(<PotHealthPane />);

      // The floor (the goals term) is stated AS a floor...
      expect(screen.getByText('≥2 need you')).toBeTruthy();
      // ...and never as the bare total, which would read as "exactly 2 need you"
      // while the attention terms silently contributed 0.
      expect(screen.queryByText('2 need you')).toBeNull();
    });

    it('CHIP: with NO floor to state, still renders — the pane must not assert "nothing needs you"', () => {
      seedGoals([defaultGoal({ needsHuman: 0 })]);
      seedAgents([agent()]);
      seedThroughput(DEGRADED_ATTENTION);
      render(<PotHealthPane />);

      // needYou === 0 here. Un-degraded that correctly renders NO chip; degraded
      // it must not vanish, because a missing chip reads as a confident all-clear.
      expect(screen.getByText('? need you')).toBeTruthy();
    });

    it('KV ROWS: pure-attention rows read `unknown` and drop the all-clear dot', () => {
      seedGoals();
      seedAgents([agent()]);
      seedThroughput(DEGRADED_ATTENTION);
      render(<PotHealthPane />);

      // Both pure-attention rows ("needs a decision" and "alerts") degrade.
      const unknown = screen.getAllByText('unknown — read timed out');
      expect(unknown).toHaveLength(2);
      // The `ok` dot is earned only by a REAL zero; a timed-out read has none.
      for (const row of unknown) expect(row.querySelector('.op-pot-dot')).toBeNull();
      expect(screen.queryByText('0 items · 0 plans')).toBeNull();
    });

    it('CONTROL: an un-degraded read is untouched — real zeros keep their dot and the plain chip', () => {
      seedAll();
      render(<PotHealthPane />);

      // Positive control for the two absence assertions above: on a real read the
      // dot IS present and the chip has no floor marker, so those queries are
      // measuring the degraded branch rather than a broken selector.
      expect(screen.getByText('5 need you')).toBeTruthy();
      expect(screen.queryByText(/≥\d+ need you/)).toBeNull();
      expect(screen.queryByText('unknown — read timed out')).toBeNull();
      expect(screen.getByText('0').querySelector('.op-pot-dot.ok')).toBeTruthy();
    });
  });
});
