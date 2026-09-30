/**
 * hud-entity-board — the Plans / Work items board model
 * (hud-session-launcher-and-board-tabs-2026-07-26 P-009).
 *
 * The classification rules are the whole value of this module, so they are
 * tested directly rather than through a rendered board: a plan is usually
 * several statuses at once and the column has to answer "what does this need
 * from me", not "what does it contain".
 */

import { describe, it, expect } from 'vitest';
// Canonical goal write-vocabulary, imported HERE (test-only) rather than into
// the board module: hud-entity-board.ts is pure and browser-bundled, so it must
// not pull the tool graph in. See GOAL_TERMINAL_STATUSES' comment (WI-37520).
import { GOAL_STATUSES } from '../../../../../packages/agent-mcp/src/tools/goals/create';
import {
  askTargetFor,
  askToCard,
  avatarColorIndex,
  avatarInitials,
  buildGoalBoard,
  buildPlanBoard,
  buildWorkItemBoard,
  planCardMeta,
  HUD_AVATAR_COLOR_COUNT,
  HUD_PLAN_AVATARS_SHOWN,
  goalBurn,
  goalBurnLabel,
  goalColumn,
  goalsTruncationNotice,
  hudHarnessScopeArgs,
  isHudSessionInPotScope,
  isInHudPotScope,
  goalSilence,
  partitionGoals,
  goalSpendLabel,
  identityMatches,
  toGoalCard,
  toPlanCard,
  GOAL_START_CARD_ID,
  GOAL_START_COLUMN,
  GOAL_TERMINAL_STATUSES,
  HUD_DEFAULT_TAB,
  HUD_ENTITY_COLUMNS,
  HUD_TABS,
  HUD_WORK_ITEM_FETCH_STATES,
  planColumn,
  planCountsSummary,
  rollUpStateCounts,
  shortAssignee,
  workItemIdForCard,
  toBadgeTone,
  toWorkItemCard,
  workItemColumn,
  type HudGoalInput,
  type HudPlanInput,
  type HudWorkItemInput,
} from './hud-entity-board';
import type { HudAsk } from './hud-board-model';

const NOW = Date.parse('2026-07-26T18:00:00.000Z');

function plan(over: Partial<HudPlanInput> = {}): HudPlanInput {
  return {
    slug: 'a-plan',
    title: 'A plan',
    status: 'active',
    updated: '2026-07-26T17:00:00.000Z',
    harnessSlug: 'papercusp',
    nextAction: null,
    itemCounts: {},
    ...over,
  };
}

function item(over: Partial<HudWorkItemInput> = {}): HudWorkItemInput {
  return {
    id: 'WI-1',
    kind: 'change',
    title: 'Do the thing',
    state: 'open',
    updatedAt: '2026-07-26T17:00:00.000Z',
    ...over,
  };
}

function ask(over: Partial<HudAsk> = {}): HudAsk {
  return {
    ownerAgentId: null,
    title: 'Ratify the dark flag',
    occurredAt: '2026-07-26T16:00:00.000Z',
    id: 'ask-1',
    kind: 'dark-flag-ratification',
    itemRef: null,
    planSlug: null,
    harnessSlug: 'papercusp',
    ...over,
  };
}

describe('tabs', () => {
  // Goals was added LEFTMOST on a later owner ask [owner 2026-08-09 interactive,
  // verbatim: "make the goal tab in the hud tab the left most tab"], recorded as
  // D-018 on goal-mode-2026-08-07. The tab strip is pinned exactly so a position
  // the owner chose cannot drift silently — so if this assertion just failed,
  // check whether the change was MEANT to reorder tabs before editing it.
  it('exposes the four tabs in owner-set order, goals leftmost', () => {
    expect(HUD_TABS).toEqual(['goals', 'sessions', 'plans', 'items']);
  });

  // LEFTMOST ≠ DEFAULT, and the two are easy to conflate once goals sits first.
  // The owner asked for a position in the strip, not for a different landing
  // tab, so the HUD must still OPEN on sessions. This pins that distinction:
  // making goals the default is a separate behaviour change needing its own ask.
  it('still opens on sessions — leftmost is a position, not the default tab', () => {
    expect(HUD_TABS[0]).toBe('goals');
    expect(HUD_DEFAULT_TAB).toBe('sessions');
  });
});

describe('inherited pot scope', () => {
  it('treats null as workspace-wide and exact arrays as authoritative', () => {
    expect(isInHudPotScope(null, null)).toBe(true);
    expect(isInHudPotScope('child', ['root', 'child'])).toBe(true);
    expect(isInHudPotScope('other', ['root', 'child'])).toBe(false);
    expect(isInHudPotScope(null, ['root'])).toBe(false);
  });

  it('omits the resolver arg for All Pots and preserves an explicit empty scope', () => {
    expect(hudHarnessScopeArgs(null)).toEqual({});
    expect(hudHarnessScopeArgs(['root', 'child'])).toEqual({ harnessSlugs: ['root', 'child'] });
    expect(hudHarnessScopeArgs([])).toEqual({ harnessSlugs: [] });
  });

  it('lets an exact owner/session id address a session outside the selected Pot', () => {
    const session = {
      ownerId: 'su-4b48f72e-ddf3-40fa-a6f1-755e2c7e71f4',
      sessionId: 'a2ca6cd3-1c38-4709-a2ed-deeeb7e6d4e6',
      ompThreadId: null,
      harnessSlug: null,
    };

    expect(isHudSessionInPotScope(session, ['papercusp'], 'su-4b48f')).toBe(true);
    expect(isHudSessionInPotScope(session, ['papercusp'], 'a2ca6cd3')).toBe(true);
    expect(isHudSessionInPotScope(session, ['papercusp'], 'su-deadbe')).toBe(false);
  });

  it('keeps ordinary transcript prose inside the selected Pot', () => {
    const session = {
      ownerId: 'su-4b48f72e-ddf3-40fa-a6f1-755e2c7e71f4',
      harnessSlug: null,
    };

    expect(isHudSessionInPotScope(session, ['papercusp'], 'active conversation')).toBe(false);
    expect(isHudSessionInPotScope(session, null, 'active conversation')).toBe(true);
  });
});

describe('goalColumn', () => {
  function goal(over: Partial<HudGoalInput> = {}): HudGoalInput {
    return { id: 'g1', title: 'Ship a paid app', status: 'active', ...over };
  }

  it('routes a goal with human asks to needs-you', () => {
    expect(goalColumn(goal({ needsHuman: 3 }))).toBe('needs-you');
  });

  it('routes a TERMINAL goal to done even when it still carries human asks', () => {
    // Precedence case 1. A closed goal's leftover needs-human items are moot;
    // surfacing it under "needs you" would ask the owner to act on a finished
    // goal — the one outcome this column ordering exists to prevent.
    //
    // `killed` is the case that had regressed (WI-37520). It is the transition
    // GOAL mode's contract MANDATES when a kill criterion trips, and it was
    // missing from the terminal set — so a killed goal carrying parked asks
    // landed in needs-you and the owner was chased about a goal they had
    // deliberately killed. This loop previously iterated ['closed','done',
    // 'achieved','abandoned']: three statuses `z.enum` rejects outright, and
    // not the one that mattered.
    for (const status of ['achieved', 'killed']) {
      expect(goalColumn(goal({ status, needsHuman: 5 }))).toBe('done');
    }
  });

  it('keeps the terminal set inside the canonical goal vocabulary', () => {
    // The guard that would have caught WI-37520. The board's terminal set is a
    // hand-maintained copy of a z.enum that lives in the tools package, and a
    // copy drifts in BOTH directions: this one had GAINED three statuses the
    // tools reject and LOST the one the contract depends on. Anchoring to the
    // canonical enum makes either drift a red instead of a silent misrender.
    for (const status of GOAL_TERMINAL_STATUSES) {
      expect(GOAL_STATUSES).toContain(status);
    }
    // Pin the complement too, so a status ADDED to the enum later cannot
    // silently default to "not terminal" — it has to be classified here.
    expect([...GOAL_STATUSES].filter((s) => !GOAL_TERMINAL_STATUSES.has(s)).sort()).toEqual([
      'active',
      'paused',
    ]);
  });

  it('prefers needs-you over blocked for a PAUSED goal that has asks', () => {
    // Precedence case 2. Both are owner actions, but needsHuman is a concrete
    // ask while a pause is a state. The pause is not lost — toGoalCard still
    // badges it (asserted below), it just does not outrank the actionable thing.
    expect(goalColumn(goal({ status: 'paused', needsHuman: 2 }))).toBe('needs-you');
  });

  it('routes a paused goal with no asks to blocked', () => {
    expect(goalColumn(goal({ status: 'paused' }))).toBe('blocked');
    expect(goalColumn(goal({ status: 'blocked' }))).toBe('blocked');
  });

  it('separates a goal that is WORKING from one that is merely active', () => {
    // The distinction a status field alone cannot express, and the single most
    // useful thing on this board: a goal can be `active` and totally idle.
    expect(goalColumn(goal({ openWorkItems: 4 }))).toBe('working');
    expect(goalColumn(goal({ openWorkItems: 0 }))).toBe('ready');
    expect(goalColumn(goal({}))).toBe('ready');
  });

  it('is case-insensitive about status', () => {
    // Fixture uses a status the tools can actually EMIT. It read 'CLOSED'
    // before WI-37520 — an unreachable status, so this case asserted the
    // property against a value that never arrives.
    expect(goalColumn(goal({ status: 'KILLED' }))).toBe('done');
    expect(goalColumn(goal({ status: 'Achieved' }))).toBe('done');
    expect(goalColumn(goal({ status: 'Paused' }))).toBe('blocked');
  });

  it('treats an UNRECOGNISED status as a live goal rather than terminal', () => {
    // Degrade toward "still running": mis-filing a live goal as done hides it,
    // whereas mis-filing a dead one as ready is merely noise.
    expect(goalColumn(goal({ status: 'wibble' }))).toBe('ready');
  });
});

describe('goalSpendLabel', () => {
  it('shows the ENFORCED spend against the ceiling when one is set', () => {
    // The ceiling is judged on the rollup snapshot (spentCents), never on the
    // lifetime figure — a lifetime $9,999 must not read as over a weekly $500.
    expect(
      goalSpendLabel({ id: 'g', title: 't', status: 'active', spendUsd: 9_999, spentCents: 31_000, budgetCents: 50_000 }),
    ).toBe('$310 / $500');
  });
  it('names the rolling window the ceiling applies to', () => {
    expect(
      goalSpendLabel({ id: 'g', title: 't', status: 'active', spentCents: 31_000, budgetCents: 50_000, budgetWindowSec: 604_800 }),
    ).toBe('$310 / $500 per 7d');
  });
  it('shows bare spend when no ceiling was set', () => {
    expect(goalSpendLabel({ id: 'g', title: 't', status: 'active', spendUsd: 310 })).toBe('$310');
  });
  it('reads a missing spend as UNMEASURED, never $0 (WI-1074208)', () => {
    expect(goalSpendLabel({ id: 'g', title: 't', status: 'active' })).toBe('spend unmeasured');
    expect(goalSpendLabel({ id: 'g', title: 't', status: 'active', spendUsd: 310, budgetCents: 50_000 }))
      .toBe('unmeasured / $500');
  });
});

describe('goalBurn — the RATE behind the level (P-003)', () => {
  const NOW = Date.parse('2026-08-09T00:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;
  const born = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
  /** An OLD goal, so the age clamp is out of the way unless a test wants it. */
  const g = (extra: Record<string, unknown>) => ({
    id: 'g',
    title: 't',
    status: 'active',
    createdAt: born(90),
    ...extra,
  });

  it('returns NOTHING when nothing measured the window — an unmeasured rate is not a zero rate', () => {
    // The P-002 lesson one item later: a payload with no reading must produce
    // NO chip, because "$0/day" is the most reassuring thing this surface can
    // say and we have no evidence for it.
    expect(goalBurn(g({ spendUsd: 400 }), NOW)).toBeNull();
    expect(goalBurnLabel(g({ spendUsd: 400 }), NOW)).toBeNull();
    // A window with no figure, and a figure with no window, are both no-reading.
    expect(goalBurn(g({ spendRecentWindowDays: 7 }), NOW)).toBeNull();
    expect(goalBurn(g({ spendRecentUsd: 50 }), NOW)).toBeNull();
  });

  it('reports a MEASURED zero as a real answer, distinct from no reading at all', () => {
    const burn = goalBurn(
      g({ spentCents: 40_000, budgetCents: 50_000, spendRecentUsd: 0, spendRecentWindowDays: 7 }),
      NOW,
    );
    expect(burn).not.toBeNull();
    expect(burn!.perDayUsd).toBe(0);
    // Named, not blank: the goal is idle against a real ceiling, worth SAYING.
    expect(burn!.etaAbsent).toBe('no-recent-spend');
  });

  it('names an UNMEASURED enforced level instead of projecting from a guessed zero', () => {
    const burn = goalBurn(
      g({ spendUsd: 400, budgetCents: 50_000, spendRecentUsd: 70, spendRecentWindowDays: 7 }),
      NOW,
    )!;
    expect(burn.etaAbsent).toBe('spend-unmeasured');
    expect(burn.ceilingEtaMs).toBeNull();
  });

  it('reports the MISSING CEILING ahead of the rate, because it is the more basic fact', () => {
    // Precedence, pinned deliberately: with no ceiling there is nothing for any
    // rate to run into, so "no-ceiling" is the honest reason even at zero burn.
    // Reporting "no recent spend" here would imply a ceiling that does not exist.
    const burn = goalBurn(g({ spendUsd: 400, spendRecentUsd: 0, spendRecentWindowDays: 7 }), NOW)!;
    expect(burn.etaAbsent).toBe('no-ceiling');
  });

  it('divides by the window the payload declares, never a hardcoded 7', () => {
    // The guard on the wire-carried window. If someone re-tunes the resolver's
    // window and the UI keeps assuming 7, the rate silently doubles or halves.
    expect(goalBurn(g({ spendRecentUsd: 140, spendRecentWindowDays: 7 }), NOW)!.perDayUsd).toBe(20);
    expect(goalBurn(g({ spendRecentUsd: 140, spendRecentWindowDays: 14 }), NOW)!.perDayUsd).toBe(10);
  });

  it('shortens the denominator to a young goal’s own age rather than understating its burn', () => {
    // $100 in a 2-day-old goal is $50/day. Dividing by the nominal 7 would
    // report $14/day — a 3.5x understatement, in the reassuring direction, on
    // the one number that exists to give advance warning.
    const burn = goalBurn(
      g({ createdAt: born(2), spendRecentUsd: 100, spendRecentWindowDays: 7 }),
      NOW,
    )!;
    expect(burn.perDayUsd).toBe(50);
    expect(burn.windowShort).toBe(true);
  });

  it('never LENGTHENS the denominator for a goal older than the window', () => {
    // The other half of the asymmetry: clamping may only raise the rate.
    const burn = goalBurn(g({ spendRecentUsd: 70, spendRecentWindowDays: 7 }), NOW)!;
    expect(burn.perDayUsd).toBe(10);
    expect(burn.windowShort).toBe(false);
  });

  it('projects the ceiling date from the recent rate, not the lifetime average', () => {
    // $300 spent of a $500 ceiling = $200 of headroom, burning $10/day -> 20 days.
    // The lifetime average over 90 days would be $3.33/day and put the ceiling
    // 60 days out — which is exactly the misreading this item is about.
    const burn = goalBurn(
      g({ spentCents: 30_000, budgetCents: 50_000, spendRecentUsd: 70, spendRecentWindowDays: 7 }),
      NOW,
    )!;
    expect(burn.etaAbsent).toBeNull();
    expect(burn.ceilingEtaMs).toBe(NOW + 20 * DAY);
  });

  it('names WHY there is no date, in every case, rather than going blank', () => {
    const base = { spendRecentUsd: 70, spendRecentWindowDays: 7 };
    expect(goalBurn(g({ ...base, spendUsd: 10 }), NOW)!.etaAbsent).toBe('no-ceiling');
    expect(
      goalBurn(g({ ...base, spentCents: 60_000, budgetCents: 50_000 }), NOW)!.etaAbsent,
    ).toBe('already-over');
    // A ceiling reachable only in ~2000 years is arithmetic, not information.
    expect(
      goalBurn(
        g({ spentCents: 0, budgetCents: 5_000_000, spendRecentUsd: 0.7, spendRecentWindowDays: 7 }),
        NOW,
      )!.etaAbsent,
    ).toBe('beyond-horizon');
  });
});

describe('buildGoalBoard', () => {
  const NOW = Date.parse('2026-08-09T00:00:00.000Z');

  it('states the absence of a kill criterion instead of leaving the reason blank', () => {
    // A goal with no criterion can never stop, so the card must SAY that. An
    // empty reason line would read as "this card is uninformative" rather than
    // as "this goal has nothing that can end it".
    const board = buildGoalBoard([{ id: 'g1', title: 'Endless', status: 'active' }], { nowMs: NOW });
    const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === 'g1')!;
    expect(card.reason).toContain('No kill criterion');
  });

  it('uses the kill criterion verbatim as the reason line when there is one', () => {
    const board = buildGoalBoard(
      [{ id: 'g1', title: 'Ship', status: 'active', killCriterion: 'No paying user by day 30.' }],
      { nowMs: NOW },
    );
    const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === 'g1')!;
    expect(card.reason).toBe('No paying user by day 30.');
  });

  it('keeps the paused fact as a badge even when the column says needs-you', () => {
    // The other half of precedence case 2 — this is what makes it safe for the
    // column to rank the ask above the pause.
    const board = buildGoalBoard(
      [{ id: 'g1', title: 'Ship', status: 'paused', needsHuman: 2 }],
      { nowMs: NOW },
    );
    const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === 'g1')!;
    expect(card.column).toBe('needs-you');
    expect(card.badges.map((b) => b.label)).toContain('paused');
  });

  it('flags spend at or over the ceiling with the alarm tone', () => {
    const board = buildGoalBoard(
      [{ id: 'g1', title: 'Ship', status: 'active', spentCents: 31_000, budgetCents: 30_000 }],
      { nowMs: NOW },
    );
    const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === 'g1')!;
    expect(card.badges.find((b) => b.id === 'g1:spend')?.tone).toBe('bad');
  });

  it('never alarms on an UNMEASURED level, and says it is unmeasured', () => {
    const board = buildGoalBoard(
      [{ id: 'g1', title: 'Ship', status: 'active', spendUsd: 310, budgetCents: 30_000 }],
      { nowMs: NOW },
    );
    const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === 'g1')!;
    const spend = card.badges.find((b) => b.id === 'g1:spend')!;
    expect(spend.tone).toBe('neutral');
    expect(spend.label).toBe('unmeasured / $300');
  });

  it('leaves spend below the ceiling neutral', () => {
    const board = buildGoalBoard(
      [{ id: 'g1', title: 'Ship', status: 'active', spendUsd: 10, budgetCents: 30_000 }],
      { nowMs: NOW },
    );
    const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === 'g1')!;
    expect(card.badges.find((b) => b.id === 'g1:spend')?.tone).toBe('neutral');
  });

  /* ── truncation disclosure (EI-20080280064869122) ──────────────────────── */

  it('says how many goals are hidden when the query capped the list', () => {
    expect(goalsTruncationNotice(100, 214)).toMatch(/Showing 100 of 214 goals/);
    expect(goalsTruncationNotice(100, 214)).toMatch(/114 more/);
  });

  it('stays silent when nothing is hidden — no permanent "showing all N" banner', () => {
    expect(goalsTruncationNotice(4, 4)).toBeNull();
    expect(goalsTruncationNotice(4, 3)).toBeNull();
  });

  it('stays silent when the total is UNMEASURED rather than claiming completeness', () => {
    // An older payload carries no totalGoals. That is "unknown", not "nothing
    // hidden" — but a notice we cannot substantiate is worse than none, so the
    // honest render is silence. The resolver is the place that must supply it.
    expect(goalsTruncationNotice(4, null)).toBeNull();
    expect(goalsTruncationNotice(4, undefined)).toBeNull();
    expect(goalsTruncationNotice(4, Number.NaN)).toBeNull();
  });

  it('CANNOT fire when handed the rendered length as its own total', () => {
    // The defect this guards: passing goals.length as `total` makes the check
    // `shown > shown`, always false — a disclosure that can never fire and is
    // indistinguishable from a working one until the day it is needed.
    for (const n of [0, 4, 100]) expect(goalsTruncationNotice(n, n)).toBeNull();
  });

  /* ── the pots chip (P-007 / D-022) ─────────────────────────────────────── */

  const potsBadge = (goal: Record<string, unknown>) => {
    const board = buildGoalBoard([{ id: 'g1', title: 'Ship', status: 'active', ...goal }], {
      nowMs: NOW,
    });
    const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === 'g1')!;
    return card.badges.find((b) => b.id === 'g1:pots');
  };

  it('names the pots instead of counting them', () => {
    // The item: "the card says 3 pots and never says WHICH".
    expect(potsBadge({ potCount: 2, pots: [{ harnessSlug: 'alpha' }, { harnessSlug: 'beta' }] })?.label).toBe(
      'alpha, beta',
    );
  });

  it('counts overflow from potCount, NOT from the sample it was given', () => {
    // The sample is bounded server-side, so a goal past the cap has more pots
    // than names arrived. Deriving "+N" from the array would under-report it —
    // here: 40 pots, 6 sampled, 2 shown, so 38 hidden and NOT 4.
    const sample = Array.from({ length: 6 }, (_, i) => ({ harnessSlug: `p${i}` }));
    expect(potsBadge({ potCount: 40, pots: sample })?.label).toBe('p0, p1 +38');
  });

  it('SAYS a pot is shared, in the label rather than only the tooltip (D-021)', () => {
    // A reader adding two goals' spend together never hovers to discover they
    // overlap, so the fact has to survive at a glance.
    const badge = potsBadge({
      potCount: 1,
      pots: [{ harnessSlug: 'alpha', role: 'owner', servesGoals: 3 }],
    });
    expect(badge?.label).toBe('alpha · shared');
    expect(badge?.title).toMatch(/also serves 2 other goals/);
    expect(badge?.title).toMatch(/do not add up/);
  });

  it('stays silent about sharing when every pot serves this goal alone', () => {
    // Paired control for the assertion above — without it, a chip that could
    // never say "shared" would pass the negative here.
    const badge = potsBadge({ potCount: 1, pots: [{ harnessSlug: 'alpha', servesGoals: 1 }] });
    expect(badge?.label).toBe('alpha');
    expect(badge?.title).not.toMatch(/shared|add up/);
  });

  it('falls back to the bare count when no sample arrived', () => {
    // A payload from before the list query carried names must degrade to the
    // old chip, not lose the signal.
    expect(potsBadge({ potCount: 3 })?.label).toBe('3 pots');
    expect(potsBadge({ potCount: 3, pots: [] })?.label).toBe('3 pots');
  });

  it('renders no pots chip at all for a goal with none', () => {
    expect(potsBadge({ potCount: 0 })).toBeUndefined();
    // Paired control: the same builder DOES emit one when there is a pot.
    expect(potsBadge({ potCount: 1, pots: [{ harnessSlug: 'alpha' }] })).toBeTruthy();
  });

  it('never lets the pots chip cost more than the ONE slot the count used to', () => {
    // The constraint behind D-022: the card renders only MAX_CHIPS badges, so a
    // chip per pot would push the spend-vs-ceiling badge off a busy card.
    const board = buildGoalBoard(
      [
        {
          id: 'g1',
          title: 'Ship',
          status: 'active',
          potCount: 5,
          pots: Array.from({ length: 5 }, (_, i) => ({ harnessSlug: `p${i}` })),
          spendUsd: 10,
          budgetCents: 30_000,
        },
      ],
      { nowMs: NOW },
    );
    const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === 'g1')!;
    expect(card.badges.filter((b) => b.id.includes(':pots')).length).toBe(1);
    expect(card.badges.find((b) => b.id === 'g1:spend')).toBeTruthy();
  });

  /* ── the burn chip (P-003) ─────────────────────────────────────────────── */

  const burnBadge = (goal: Record<string, unknown>) => {
    const board = buildGoalBoard([{ id: 'g1', title: 'Ship', status: 'active', ...goal }], {
      nowMs: NOW,
    });
    const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === 'g1')!;
    return card.badges.find((b) => b.id === 'g1:burn');
  };

  it('renders NO burn chip when nothing measured the window', () => {
    // Not a $0/day chip. The card says nothing about the rate because it knows
    // nothing about the rate.
    expect(burnBadge({ spendUsd: 310, budgetCents: 50_000 })).toBeUndefined();
  });

  it('promotes the projected ceiling date onto the label when it is close enough to act on', () => {
    // $350 over 7d = $50/day against $200 of headroom -> 4 days out.
    const badge = burnBadge({
      spentCents: 30_000,
      budgetCents: 50_000,
      spendRecentUsd: 350,
      spendRecentWindowDays: 7,
    })!;
    expect(badge.label).toContain('ceiling ~');
    expect(badge.tone).toBe('bad');
  });

  it('keeps a distant projection to the rate alone, so only real warnings shout', () => {
    // $70 over 7d = $10/day against $200 of headroom -> 20 days out.
    const badge = burnBadge({
      spentCents: 30_000,
      budgetCents: 50_000,
      spendRecentUsd: 70,
      spendRecentWindowDays: 7,
    })!;
    expect(badge.label).toBe('$10/day');
    expect(badge.tone).toBe('neutral');
    // The date is still available on hover — promoted, not withheld.
    expect(badge.title).toContain('lands around');
  });

  it('does not print a $0/day rate for a real but sub-dollar burn', () => {
    // moneyish rounds to whole dollars; a rate must not, or a live goal reads
    // as spending nothing.
    const badge = burnBadge({ spendUsd: 5, spendRecentUsd: 2.8, spendRecentWindowDays: 7 })!;
    expect(badge.label).toBe('$0.40/day');
  });

  it('drops the burn chip once the ceiling is already breached', () => {
    // The spend chip is already alarming; a projected date for a ceiling that
    // has been passed would be noise contradicting it.
    expect(
      burnBadge({
        spentCents: 60_000,
        budgetCents: 50_000,
        spendRecentUsd: 70,
        spendRecentWindowDays: 7,
      }),
    ).toBeUndefined();
  });
});

describe('planColumn', () => {
  it('puts a needs-human item above every other signal', () => {
    // Deliberately ALSO wip and blocked: a decision you owe outranks both.
    expect(
      planColumn(plan({ itemCounts: { 'needs-human': 1, wip: 3, blocked: 2 }, status: 'blocked' })),
    ).toBe('needs-you');
  });

  it("honours an explicit blocked status over an item somebody left flipped to wip", () => {
    expect(planColumn(plan({ status: 'blocked', itemCounts: { wip: 1 } }))).toBe('blocked');
  });

  it('is working when anything is in flight', () => {
    expect(planColumn(plan({ itemCounts: { wip: 1, todo: 4, blocked: 1 } }))).toBe('working');
  });

  it('is blocked when nothing moves and something is stuck', () => {
    expect(planColumn(plan({ itemCounts: { blocked: 1, todo: 3 } }))).toBe('blocked');
  });

  it('is ready when work remains and nobody has picked it up', () => {
    expect(planColumn(plan({ itemCounts: { todo: 2, done: 5 } }))).toBe('ready');
  });

  it('is done when every item is settled', () => {
    expect(planColumn(plan({ itemCounts: { done: 5, dropped: 1 } }))).toBe('done');
  });

  it('is done for a shipped plan even if a stale todo lingers', () => {
    expect(planColumn(plan({ status: 'shipped', itemCounts: { todo: 1 } }))).toBe('done');
  });

  it('does not promise readiness for a plan with no items at all', () => {
    expect(planColumn(plan({ itemCounts: {} }))).toBe('done');
    expect(planColumn(plan({ itemCounts: null }))).toBe('done');
  });
});

describe('workItemColumn', () => {
  it('maps the unified vocabulary', () => {
    expect(workItemColumn('needs-human')).toBe('needs-you');
    expect(workItemColumn('wip')).toBe('working');
    expect(workItemColumn('blocked')).toBe('blocked');
    expect(workItemColumn('open')).toBe('ready');
    expect(workItemColumn('done')).toBe('done');
    expect(workItemColumn('dropped')).toBe('done');
  });

  it('tolerates the underscore + legacy spellings still in the store', () => {
    // `needs_human` / `in_progress` are the drift variants ISSUE_STATE_ALIASES
    // normalizes server-side; a pre-migration row can still carry them.
    expect(workItemColumn('needs_human')).toBe('needs-you');
    expect(workItemColumn('in_progress')).toBe('working');
    expect(workItemColumn('resolved')).toBe('done');
    expect(workItemColumn('closed')).toBe('done');
    expect(workItemColumn('deprecated')).toBe('done');
    expect(workItemColumn('  WIP ')).toBe('working');
  });

  it('surfaces an unknown state as work rather than hiding it in done', () => {
    expect(workItemColumn('some-future-state')).toBe('ready');
    expect(workItemColumn(null)).toBe('ready');
  });
});

describe('buildPlanBoard', () => {
  it('returns all five columns even when empty, so the grid never reflows', () => {
    const board = buildPlanBoard([], { nowMs: NOW });
    expect(board.columns.map((c) => c.id)).toEqual([...HUD_ENTITY_COLUMNS]);
    expect(board.total).toBe(0);
    expect(board.columns.every((c) => c.cards.length === 0)).toBe(true);
  });

  it('prefers the plan-authored nextAction over a derived count line', () => {
    const board = buildPlanBoard(
      [plan({ nextAction: 'Ship the migration', itemCounts: { todo: 3 } })],
      { nowMs: NOW },
    );
    expect(board.columns.find((c) => c.id === 'ready')!.cards[0].reason).toBe('Ship the migration');
  });

  it('falls back to a count summary when there is no nextAction', () => {
    const board = buildPlanBoard([plan({ itemCounts: { todo: 3, blocked: 1 } })], { nowMs: NOW });
    expect(board.columns.find((c) => c.id === 'blocked')!.cards[0].reason).toBe('1 blocked · 3 todo');
  });

  /* D-004 (plan-visibility-revamp-2026-08-23 P-006): the sort picker REPLACED
     this board's fixed ordering. The previous rule — needs-you oldest first,
     every other column newest first by ✎ updated — still governs the goals and
     work-items boards via sortKeyFor; on the Plans board the picked axis
     orders EVERY column uniformly, needs-you included. */
  it('orders by ⚒ last work under the DEFAULT sort, sinking never-worked plans', () => {
    const board = buildPlanBoard(
      [
        plan({ slug: 'never-worked', updated: '2026-07-26T17:59:00.000Z', itemCounts: { todo: 1 } }),
        plan({ slug: 'worked-earlier', lastWorkAtMs: NOW - 7_200_000, itemCounts: { todo: 1 } }),
        plan({ slug: 'worked-just-now', lastWorkAtMs: NOW - 60_000, itemCounts: { todo: 1 } }),
      ],
      { nowMs: NOW },
    );
    // The freshest ✎ edit in the set belongs to `never-worked`, and it STILL
    // sinks: an edit is not work, and under the ⚒ axis a plan nobody has run a
    // work item on has no recency to claim.
    expect(board.columns.find((c) => c.id === 'ready')!.cards.map((c) => c.id)).toEqual([
      'worked-just-now',
      'worked-earlier',
      'never-worked',
    ]);
  });

  it('applies the picked sort to needs-you too — no column is exempt (D-004)', () => {
    const board = buildPlanBoard(
      [
        plan({ slug: 'stale-work', lastWorkAtMs: NOW - 7_200_000, itemCounts: { 'needs-human': 1 } }),
        plan({ slug: 'fresh-work', lastWorkAtMs: NOW - 60_000, itemCounts: { 'needs-human': 1 } }),
      ],
      { nowMs: NOW },
    );
    expect(board.columns.find((c) => c.id === 'needs-you')!.cards.map((c) => c.id)).toEqual([
      'fresh-work',
      'stale-work',
    ]);
  });

  it('orders by ✎ updated under last-edit, sinking undated plans', () => {
    const board = buildPlanBoard(
      [
        plan({ slug: 'undated', updated: null, lastWorkAtMs: NOW - 1_000, itemCounts: { todo: 1 } }),
        plan({ slug: 'edited-earlier', updated: '2026-07-20T00:00:00.000Z', itemCounts: { todo: 1 } }),
        plan({ slug: 'edited-recently', updated: '2026-07-26T00:00:00.000Z', itemCounts: { todo: 1 } }),
      ],
      { nowMs: NOW, sort: 'last-edit' },
    );
    // `undated` carries the freshest ⚒ in the set and still sinks: the picked
    // axis is ✎, and a recent ⚒ is not evidence of a recent edit.
    expect(board.columns.find((c) => c.id === 'ready')!.cards.map((c) => c.id)).toEqual([
      'edited-recently',
      'edited-earlier',
      'undated',
    ]);
  });

  it('degrades to the fetch order when NO plan carries the picked axis', () => {
    // The join feed answering empty (or not yet) leaves every sortKey at the
    // sink value; the sort is stable, so the caller's order passes through
    // rather than being scrambled by a half-loaded join.
    const board = buildPlanBoard(
      [
        plan({ slug: 'first', itemCounts: { todo: 1 } }),
        plan({ slug: 'second', itemCounts: { todo: 1 } }),
        plan({ slug: 'third', itemCounts: { todo: 1 } }),
      ],
      { nowMs: NOW },
    );
    expect(board.columns.find((c) => c.id === 'ready')!.cards.map((c) => c.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('caps what it renders but never what it counts', () => {
    const plans = Array.from({ length: 25 }, (_, i) =>
      plan({ slug: `p-${i}`, itemCounts: { todo: 1 } }),
    );
    const board = buildPlanBoard(plans, { nowMs: NOW, maxPerColumn: 10 });
    const ready = board.columns.find((c) => c.id === 'ready')!;
    expect(ready.cards).toHaveLength(10);
    expect(ready.hidden).toBe(15);
    // The count is the TRUTH about the column, not the render budget.
    expect(board.counts.ready).toBe(25);
    expect(board.total).toBe(25);
  });

  it('filters on ref, title and context', () => {
    const plans = [
      plan({ slug: 'alpha-plan', title: 'Alpha', itemCounts: { todo: 1 } }),
      plan({ slug: 'beta-plan', title: 'Beta', harnessSlug: 'other', itemCounts: { todo: 1 } }),
    ];
    expect(buildPlanBoard(plans, { nowMs: NOW, query: 'alpha' }).total).toBe(1);
    expect(buildPlanBoard(plans, { nowMs: NOW, query: 'BETA' }).total).toBe(1);
    expect(buildPlanBoard(plans, { nowMs: NOW, query: 'other' }).total).toBe(1);
    expect(buildPlanBoard(plans, { nowMs: NOW, query: 'nothing' }).total).toBe(0);
  });

  it('titles a card by slug when the plan never set one', () => {
    const board = buildPlanBoard([plan({ title: null, itemCounts: { todo: 1 } })], { nowMs: NOW });
    expect(board.columns.find((c) => c.id === 'ready')!.cards[0].title).toBe('a-plan');
  });
});

describe('buildWorkItemBoard', () => {
  it('folds unattributed asks into needs-you alongside the real rows', () => {
    const board = buildWorkItemBoard(
      [item({ id: 'WI-1', state: 'needs-human' })],
      [ask({ id: 'ask-1' })],
      { nowMs: NOW },
    );
    const needsYou = board.columns.find((c) => c.id === 'needs-you')!;
    expect(needsYou.cards.map((c) => c.id)).toEqual(expect.arrayContaining(['WI-1', 'ask:ask-1']));
    expect(board.counts['needs-you']).toBe(2);
  });

  it('DEDUPES an ask against the canonical work item it points at', () => {
    // The regression this exists for: a `work-item-needs-human` ask carries the
    // work item's id in itemRef, and that item is ALSO in the rows with
    // state='needs-human'. Without the dedupe the column double-counts it.
    const board = buildWorkItemBoard(
      [item({ id: 'WI-7', state: 'needs-human' })],
      [ask({ id: 'ask-7', kind: 'work-item-needs-human', itemRef: 'WI-7' })],
      { nowMs: NOW },
    );
    expect(board.counts['needs-you']).toBe(1);
    expect(board.columns.find((c) => c.id === 'needs-you')!.cards[0].id).toBe('WI-7');
  });

  /* WI-6597 — the case above passed for a YEAR while the live board
     double-counted, because `WI-7` is a shape no producer emits. These use the
     strings read off the live app / the real producers, per the warning in
     work-item-ref.ts. Both live failure modes are pinned separately, because
     each alone re-breaks the guard. */
  it('DEDUPES a HARNESS-QUALIFIED itemRef — the shape the curator actually writes', () => {
    // attention/adapters.ts emits `<harness>#<id>`, never a bare id, so the old
    // `known.has(a.itemRef)` compared 'papercusp#WI-7' against a set of 'WI-7'
    // and never matched — the guard was inert even when itemRef WAS populated.
    const board = buildWorkItemBoard(
      [item({ id: 'WI-7', state: 'needs-human' })],
      [
        ask({
          id: 'work-item-needs-human:WI-7',
          kind: 'work-item-needs-human',
          itemRef: 'papercusp#WI-7',
        }),
      ],
      { nowMs: NOW },
    );
    expect(board.counts['needs-you']).toBe(1);
    expect(board.columns.find((c) => c.id === 'needs-you')!.cards[0].id).toBe('WI-7');
  });

  it('DEDUPES from the ask ID when itemRef is null — the 60/60 live shape', () => {
    // Measured on the live board 2026-07-28: every ask had itemRef null, so the
    // `!a.itemRef ||` disjunct was true and every ask survived. The id already
    // carries the work item, so the board must not depend on the optional field.
    const board = buildWorkItemBoard(
      [item({ id: 'WI-1142', state: 'needs-human' })],
      [ask({ id: 'work-item-needs-human:WI-1142', kind: 'work-item-needs-human', itemRef: null })],
      { nowMs: NOW },
    );
    expect(board.counts['needs-you']).toBe(1);
    expect(board.columns.find((c) => c.id === 'needs-you')!.cards[0].id).toBe('WI-1142');
  });

  it('DEDUPES an owner-wall ask against its work item (composite id, item last)', () => {
    const board = buildWorkItemBoard(
      [item({ id: 'WI-4271', state: 'needs-human' })],
      [ask({ id: 'owner-wall:work-item:WI-4271', kind: 'owner-wall', itemRef: null })],
      { nowMs: NOW },
    );
    expect(board.counts['needs-you']).toBe(1);
  });

  it('keeps an ask that names NO work item, however composite its id', () => {
    // `improvement-triage:1234` ends in a number that is not a work-item id —
    // matching it loosely would silently swallow a real ask.
    const board = buildWorkItemBoard(
      [item({ id: 'WI-1', state: 'needs-human' })],
      [ask({ id: 'improvement-triage:1234', kind: 'work-item-needs-human', itemRef: null })],
      { nowMs: NOW },
    );
    expect(board.counts['needs-you']).toBe(2);
  });

  it('keeps an ask whose itemRef is not among the loaded rows', () => {
    // The rows are a bounded page of ONE harness; an ask can legitimately point
    // outside it. Dropping it would re-open the visibility hole P-002 closed.
    const board = buildWorkItemBoard(
      [item({ id: 'WI-1' })],
      [ask({ id: 'ask-9', kind: 'work-item-needs-human', itemRef: 'WI-999' })],
      { nowMs: NOW },
    );
    expect(board.counts['needs-you']).toBe(1);
    expect(board.columns.find((c) => c.id === 'needs-you')!.cards[0].id).toBe('ask:ask-9');
  });

  it('spreads rows across the columns their state names', () => {
    const board = buildWorkItemBoard(
      [
        item({ id: 'WI-1', state: 'open' }),
        item({ id: 'WI-2', state: 'wip' }),
        item({ id: 'WI-3', state: 'blocked' }),
        item({ id: 'WI-4', state: 'done' }),
        item({ id: 'WI-5', state: 'needs-human' }),
      ],
      [],
      { nowMs: NOW },
    );
    expect(board.counts).toEqual({
      'needs-you': 1,
      working: 1,
      blocked: 1,
      ready: 1,
      done: 1,
    });
  });
});

describe('cards', () => {
  it('badges a work item with kind, severity and a shortened assignee', () => {
    const card = toWorkItemCard(
      item({ kind: 'bug', severity: 'critical', assignee: 'su-709bb0d6-12de-465e-bb82-0f4bb282c87a' }),
      NOW,
    );
    expect(card.badges.map((b) => b.label)).toEqual(['bug', 'critical', 'su-709bb0d6']);
    expect(card.badges[0].workItemKind).toBe('bug');
    expect(card.badges.find((b) => b.label === 'critical')!.tone).toBe('bad');
  });

  it('renders an ask with a human kind label, not the raw enum', () => {
    const card = askToCard(ask({ kind: 'dark-flag-ratification' }), NOW);
    expect(card.badges[0].label).toBe('Dark flag');
    expect(card.column).toBe('needs-you');
  });

  it('falls back to the raw kind for an ask kind the label table omits', () => {
    expect(askToCard(ask({ kind: 'something-new' }), NOW).badges[0].label).toBe('something-new');
  });

  it('derives an age from the injected clock, never Date.now()', () => {
    const card = toWorkItemCard(item({ updatedAt: '2026-07-26T17:30:00.000Z' }), NOW);
    expect(card.sinceSec).toBe(1800);
  });
});

describe('toBadgeTone', () => {
  // The seam between the shared theme's tone vocabulary and the board's.
  // `SEVERITY_TONE` is imported from harness/theme, whose ToneKey is WIDER
  // than BadgeTone — it carries presentation-only keys no chip can render.
  // Today every mapped severity happens to be a legal badge tone, which is
  // precisely why this needs a test: a bare cast would compile and only break
  // when someone maps a severity to one of the other keys.
  it('passes through every tone a chip can actually render', () => {
    for (const t of ['neutral', 'accent', 'good', 'warn', 'bad'] as const) {
      expect(toBadgeTone(t)).toBe(t);
    }
  });

  it('degrades an out-of-vocabulary theme tone to neutral instead of emitting it', () => {
    // 'fg' is a real ToneKey in harness/theme and NOT a BadgeTone.
    expect(toBadgeTone('fg')).toBe('neutral');
    expect(toBadgeTone('chartreuse')).toBe('neutral');
  });

  it('survives a missing severity mapping', () => {
    expect(toBadgeTone(undefined)).toBe('neutral');
    expect(toBadgeTone(null)).toBe('neutral');
    expect(toBadgeTone('')).toBe('neutral');
  });
});

describe('helpers', () => {
  it('orders the count summary by decision value', () => {
    expect(planCountsSummary({ done: 2, todo: 1, 'needs-human': 1, blocked: 1, wip: 1 })).toBe(
      '1 needs you · 1 wip · 1 blocked · 1 todo · 2 done',
    );
  });

  it('has nothing to say about an empty plan', () => {
    expect(planCountsSummary({})).toBeNull();
    expect(planCountsSummary(null)).toBeNull();
  });

  it('shortens an agent id but leaves a human-readable assignee alone', () => {
    expect(shortAssignee('su-709bb0d6-12de-465e')).toBe('su-709bb0d6');
    expect(shortAssignee('avi')).toBe('avi');
  });
});

/* hud-open-destinations-and-true-counts-2026-07-27 P-004 — owner report: the
   Work items tab "is only showing 201 needs you items. Where are all the rest?
   we have way more work items than that."

   Diagnosed on live data (papercusp, 27,514 rows): the tab fetched ONE 500-row
   `updated_ts DESC` window and derived every count from it. That window held
   `done 264, open 197, resolved 21, dropped 9, blocked 8, closed 1` and ZERO of
   the 45 needs-human rows, while the store held 13,126 open+todo. So the board
   reported a sample as if it were a total. */
describe('true per-column totals (P-004)', () => {
  it('rolls a state aggregate up through the SAME mapping the cards use', () => {
    expect(
      rollUpStateCounts([
        { state: 'open', n: 13_126 },
        { state: 'needs-human', n: 45 },
        { state: 'blocked', n: 85 },
        { state: 'wip', n: 3 },
        { state: 'done', n: 9_355 },
        { state: 'resolved', n: 3_278 },
      ]),
    ).toEqual({
      'needs-you': 45,
      working: 3,
      blocked: 85,
      ready: 13_126,
      done: 12_633,
    });
  });

  it('ignores absent/negative counts rather than emitting NaN', () => {
    expect(rollUpStateCounts([{ state: 'open' }, { state: 'open', n: -4 }, { state: 'open', n: 7 }]).ready).toBe(7);
  });

  it('reports the STORE total, not the sampled rows — the reported defect', () => {
    // One fetched card, but the store says 13,126 are ready.
    const board = buildWorkItemBoard([item({ id: 'WI-1', state: 'open' })], [], {
      nowMs: NOW,
      totals: { ready: 13_126 },
    });
    expect(board.counts.ready).toBe(13_126);
    // And the column SAYS what it is not showing, rather than implying it holds
    // everything it counted.
    expect(board.columns.find((c) => c.id === 'ready')!.hidden).toBe(13_125);
  });

  it('never reports fewer than the cards on screen (asks are not in the store totals)', () => {
    const board = buildWorkItemBoard([], [ask({ id: 'a1' }), ask({ id: 'a2' })], {
      nowMs: NOW,
      totals: { 'needs-you': 0 },
    });
    expect(board.counts['needs-you']).toBe(2);
    expect(board.columns.find((c) => c.id === 'needs-you')!.hidden).toBe(0);
  });

  it('FALLS BACK to counting matches while a query filters — a total would lie about the screen', () => {
    const board = buildWorkItemBoard(
      [item({ id: 'WI-1', state: 'open' }), item({ id: 'WI-2', state: 'open' })],
      [],
      { nowMs: NOW, totals: { ready: 13_126 }, query: 'WI-1' },
    );
    expect(board.counts.ready).toBe(1);
    expect(board.total).toBe(1);
  });

  it('without totals the board still counts what it holds (unchanged behaviour)', () => {
    const board = buildWorkItemBoard([item({ id: 'WI-1', state: 'open' })], [], { nowMs: NOW });
    expect(board.counts.ready).toBe(1);
    expect(board.total).toBe(1);
  });

  /* Regression guard for the destination that shipped "unit tested green" and was
     DEAD on the live board: on 2026-07-28 all 60 work-item cards were silent
     no-ops. Nothing tested this resolver at all, and the fixtures that WOULD have
     been written by hand (a bare `WI-7` id, a bare `ref`) are shapes the real
     board never produces — so the cases below are the id/ref strings read off the
     LIVE cards, not invented ones. */
  describe('workItemIdForCard — which item a card opens', () => {
    it('resolves the id from a real ask card id, whose ref is only a kind label', () => {
      // Both taken verbatim from the live board.
      expect(workItemIdForCard({ id: 'ask:work-item-needs-human:WI-1142', ref: 'Work item' }))
        .toBe('WI-1142');
      expect(workItemIdForCard({ id: 'ask:owner-wall:work-item:WI-4271', ref: 'Owner wall' }))
        .toBe('WI-4271');
      expect(workItemIdForCard({ id: 'ask:work-item-needs-human:EI-9770', ref: 'Work item' }))
        .toBe('EI-9770');
    });

    it('resolves a HARNESS-QUALIFIED curator ref, which anchored matching rejects', () => {
      // attention/adapters.ts writes itemRef as `papercusp#WI-7`, never a bare id.
      expect(workItemIdForCard({ id: 'ask:some-kind:opaque', ref: 'papercusp#WI-7' })).toBe('WI-7');
    });

    it('still opens nothing for an ask with no work item behind it', () => {
      expect(workItemIdForCard({ id: 'ask:improvement-triage:1234', ref: 'Improvement' })).toBeNull();
      expect(workItemIdForCard({ id: 'ask:dark-flag-ratification:x', ref: 'Dark flag' })).toBeNull();
    });

    it('resolves a plain work-item card id (the non-ask path)', () => {
      expect(workItemIdForCard({ id: 'WI-1', ref: 'WI-1' })).toBe('WI-1');
      expect(workItemIdForCard({ id: 'wi-42', ref: '' })).toBe('WI-42');
    });

    it('does not treat a plan card as a work item', () => {
      expect(workItemIdForCard({ id: 'hud-tab-public-release-2026-07-28', ref: 'plan' })).toBeNull();
    });
  });

  /* WI-6742 [owner-reported]: clicking a card in "Needs you" did nothing while
     every other column opened a popup. The cause was a destination that could
     come back NULL for the ask cards folded into that column, while the card
     still rendered as a <button>. So the property under test is TOTALITY —
     every card the board builds carries somewhere to go — not merely that the
     happy path routes correctly. */
  describe('WI-6742 — every Work-items card declares a destination', () => {
    const ask = (over: Partial<HudAsk> = {}): HudAsk => ({
      ownerAgentId: null,
      title: 'an ask',
      occurredAt: new Date().toISOString(),
      id: 'improvement-triage:1234',
      kind: 'improvement',
      itemRef: null,
      planSlug: null,
      harnessSlug: null,
      ...over,
    });

    it('routes an ask that IS about a work item to that item, carrying its harness', () => {
      // The live shapes: the id ends in the item, the ref is only a kind label.
      expect(askTargetFor(ask({ id: 'work-item-needs-human:WI-1142', kind: 'work-item-needs-human', harnessSlug: 'papercusp' })))
        .toEqual({ kind: 'work-item', id: 'WI-1142', harnessSlug: 'papercusp' });
      // …and the harness-qualified curator ref form.
      expect(askTargetFor(ask({ itemRef: 'papercusp#WI-7' })))
        .toEqual({ kind: 'work-item', id: 'WI-7', harnessSlug: null });
    });

    it('routes a plan-item ask to the plan', () => {
      expect(askTargetFor(ask({ kind: 'plan-item', ref: { kind: 'plan-item', slug: 'my-plan', itemId: 'P-003' } })))
        .toEqual({ kind: 'plan', slug: 'my-plan' });
    });

    // THE REGRESSION. These are the exact cards the owner clicked: asks with no
    // work item behind them, whose `ref` is a kind label. Before the fix they
    // resolved to null and the click was a silent no-op.
    it('routes an ask with NO entity behind it to the ask itself — never nothing', () => {
      expect(askTargetFor(ask({ id: 'improvement-triage:1234', kind: 'improvement' })))
        .toEqual({ kind: 'ask', askId: 'improvement-triage:1234' });
      expect(askTargetFor(ask({ id: 'standing-approval:cap:h', kind: 'standing-approval' })))
        .toEqual({ kind: 'ask', askId: 'standing-approval:cap:h' });
      expect(askTargetFor(ask({ id: 'dark-flag-ratification:x', kind: 'dark-flag-ratification' })))
        .toEqual({ kind: 'ask', askId: 'dark-flag-ratification:x' });
    });

    // Ordering is load-bearing: an ask carrying BOTH must open the ENTITY, not
    // the plan it merely happens to be filed under.
    it('prefers the work item when the ask also carries plan context', () => {
      expect(
        askTargetFor(ask({
          id: 'work-item-needs-human:WI-99',
          planSlug: 'some-plan',
          ref: { kind: 'plan-item', slug: 'some-plan' },
        })),
      ).toEqual({ kind: 'work-item', id: 'WI-99', harnessSlug: null });
    });

    it('an UNKNOWN ref kind still opens the ask, so a new adapter cannot revive the dead button', () => {
      expect(askTargetFor(ask({ ref: { kind: 'some-future-adapter' } })))
        .toEqual({ kind: 'ask', askId: 'improvement-triage:1234' });
    });

    // The end-to-end property, asserted on the BOARD rather than the helper —
    // this is what the click handler actually reads.
    it('every card buildWorkItemBoard emits has a non-null `open`', () => {
      const board = buildWorkItemBoard(
        [
          { id: 'WI-1', title: 'a', state: 'needs-human', kind: 'bug', severity: null, assignee: null, planSlug: null, updatedAt: null },
        ] as unknown as Parameters<typeof buildWorkItemBoard>[0],
        [
          ask({ id: 'improvement-triage:1', kind: 'improvement' }),
          ask({ id: 'standing-approval:2', kind: 'standing-approval' }),
          ask({ id: 'work-item-needs-human:WI-500', kind: 'work-item-needs-human' }),
        ],
        { nowMs: Date.now() } as Parameters<typeof buildWorkItemBoard>[2],
      );
      const cards = board.columns.flatMap((c) => c.cards);
      expect(cards.length).toBeGreaterThan(1);
      // A single `open: undefined` here is the bug re-appearing.
      expect(cards.filter((c) => c.open == null)).toEqual([]);
    });
  });

  it('the fetch-state list covers every branch workItemColumn maps', () => {
    // A status the board fetches must land somewhere real, and every column the
    // board renders must be reachable from the list — otherwise a column
    // silently stops loading cards.
    const reached = new Set(HUD_WORK_ITEM_FETCH_STATES.map((s) => workItemColumn(s)));
    for (const id of HUD_ENTITY_COLUMNS) expect(reached.has(id)).toBe(true);
  });
});

/**
 * The "+ Start a goal" card (goals-tab-improvement-2026-08-09 P-015).
 *
 * It is the product's ONLY path to starting a goal, so what is pinned here is
 * that it is reachable in the state that matters most (an empty board) and that
 * it does not corrupt the board's counts on the way.
 */
describe('buildGoalBoard — the "+ Start a goal" card', () => {
  const NOW = Date.parse('2026-08-09T00:00:00.000Z');
  const startCardOf = (board: ReturnType<typeof buildGoalBoard>) =>
    board.columns.flatMap((c) => c.cards).find((c) => c.id === GOAL_START_CARD_ID) ?? null;

  it('is the FIRST card in the leftmost lane', () => {
    const board = buildGoalBoard(
      [{ id: 'g1', title: 'Ship', status: 'active', killCriterion: 'day 30' }],
      { nowMs: NOW },
    );
    const lane = board.columns.find((c) => c.id === GOAL_START_COLUMN)!;
    expect(lane.cards[0]?.id).toBe(GOAL_START_CARD_ID);
  });

  it('is present on an EMPTY board — the case it exists for', () => {
    const board = buildGoalBoard([], { nowMs: NOW });
    expect(startCardOf(board)).toBeTruthy();
    // ...and it says what the empty board would have said, since it is the only
    // thing on screen.
    expect(startCardOf(board)!.reason).toContain('No goals yet');
  });

  it('is NOT counted as a goal', () => {
    // The whole failure this guards: a board reporting "1" with zero goals on
    // it. `total`/`counts` describe the goal population; the action card is not
    // part of it.
    const board = buildGoalBoard([], { nowMs: NOW });
    expect(board.total).toBe(0);
    expect(board.counts[GOAL_START_COLUMN]).toBe(0);
    // Which means a column can hold a card while the count reads zero — the
    // reason HudEntityColumns gates its empty state on cards, not on the count.
    expect(board.columns.find((c) => c.id === GOAL_START_COLUMN)!.cards).toHaveLength(1);
  });

  it('is withheld while a search is active, so "no matches" stays truthful', () => {
    const board = buildGoalBoard(
      [{ id: 'g1', title: 'Ship', status: 'active' }],
      { nowMs: NOW, query: 'nothing-matches-this' },
    );
    expect(startCardOf(board)).toBeNull();
    expect(board.total).toBe(0);
    // Nothing left on the board at all ⇒ the "No goals match …" message renders.
    expect(board.columns.every((c) => c.cards.length === 0)).toBe(true);
  });

  it('declares its intent as an ACTION rather than a destination', () => {
    // WI-6742: a click handler that re-derives intent from an id is one
    // unmatched string away from a dead button, and this card has no entity id.
    const board = buildGoalBoard([], { nowMs: NOW });
    expect(startCardOf(board)!.open).toEqual({ kind: 'start-goal' });
  });
});

/**
 * Subdirectives (goals-tab-improvement-2026-08-09 P-017 / D-006 / D-014).
 *
 * ⚠ THE GUARD THE ITEM TEXT ASKS FOR IS NOT THE GUARD BUILT HERE, deliberately.
 * P-010 and P-017 both prescribe "a parent + two children fixture asserting no
 * summed figure is rendered anywhere", inherited from D-002/D-021. D-006 — written
 * after both — retires that hazard for parent/child: "a child has no separable
 * spend and no separable session cost … the sub-goal spend-summing hazard D-002
 * warned about mostly dissolves … Do not carry the parent/child version of that
 * worry into the nested layout; carry the project version."
 *
 * So the fixture is kept (parent + two children) and the assertion is STRONGER:
 * a child contributes no spend figure at all, because `HudSubGoal` has nowhere to
 * put one. Asserting "no summed number appears" would test that nobody wrote an
 * addition; asserting the child shape carries no money field tests that nobody
 * CAN. D-002 still binds at the top level, where distinct goals share projects —
 * that is P-007's obligation and is untouched here.
 */
describe('buildGoalBoard — subdirectives (P-017)', () => {
  const NOW = Date.parse('2026-08-09T00:00:00.000Z');
  const allCards = (b: ReturnType<typeof buildGoalBoard>) =>
    b.columns.flatMap((c) => c.cards).filter((c) => c.id !== GOAL_START_CARD_ID);

  /** Parent + two children, the fixture both item texts call for. */
  const FAMILY: HudGoalInput[] = [
    { id: 'parent', title: 'Ship a paid app', status: 'active', spendUsd: 300, spentCents: 30_000, budgetCents: 50_000 },
    { id: 'kid1', title: 'Rewrite onboarding', status: 'active', parentId: 'parent', spendUsd: 120 },
    { id: 'kid2', title: 'Cut the trial to 7 days', status: 'achieved', parentId: 'parent', spendUsd: 80 },
  ];

  it('gives a child NO card of its own — the whole of D-006 on this board', () => {
    // Before P-017 every row went through toGoalCard, so a child landed in
    // whatever lane its own status implied and read as a peer of its parent.
    const ids = allCards(buildGoalBoard(FAMILY, { nowMs: NOW })).map((c) => c.id);
    expect(ids).toEqual(['parent']);
    expect(ids).not.toContain('kid1');
    expect(ids).not.toContain('kid2');
  });

  it('nests both children on the parent card, terminal state preserved', () => {
    const [card] = allCards(buildGoalBoard(FAMILY, { nowMs: NOW }));
    expect(card.subGoals?.map((s) => s.title)).toEqual([
      'Rewrite onboarding',
      'Cut the trial to 7 days',
    ]);
    // A finished directive is struck through, not dropped — it is part of how the
    // goal got here, so the list of what steered the agent stays complete.
    expect(card.subGoals?.map((s) => s.terminal)).toEqual([false, true]);
  });

  it('carries NO spend on a child, so parent+child spend cannot be added (D-006)', () => {
    const [card] = allCards(buildGoalBoard(FAMILY, { nowMs: NOW }));
    for (const sub of card.subGoals ?? []) {
      // Not "the number is absent" — there is no field that could hold one.
      expect(sub).not.toHaveProperty('spendUsd');
      expect(sub).not.toHaveProperty('badges');
      expect(Object.keys(sub).sort()).toEqual(['id', 'ref', 'status', 'terminal', 'title']);
    }
  });

  it('leaves the PARENT spend exactly its own — never the family total', () => {
    // The children are worth $120 + $80; a rolled-up figure would read $500.
    const [card] = allCards(buildGoalBoard(FAMILY, { nowMs: NOW }));
    const spend = card.badges.find((b) => b.id === 'parent:spend')!;
    expect(spend.label).toBe('$300 / $500');
  });

  it('PROMOTES an orphan instead of dropping it, and says why', () => {
    // A child whose parent is outside the window has no card to nest inside.
    // Silently discarding it would remove a real goal from the board with
    // nothing saying so — the one outcome this board's counts discipline bars.
    const board = buildGoalBoard(
      [{ id: 'kid1', title: 'Rewrite onboarding', status: 'active', parentId: 'missing' }],
      { nowMs: NOW },
    );
    const cards = allCards(board);
    expect(cards.map((c) => c.id)).toEqual(['kid1']);
    expect(cards[0].context).toContain('not on this board');
  });

  it('finds a nested child by search, through its parent card', () => {
    // A child has no card, so the parent is the only thing a query can return it
    // in. Without this the filter would hide a matching child entirely.
    const board = buildGoalBoard(FAMILY, { nowMs: NOW, query: 'onboarding' });
    expect(allCards(board).map((c) => c.id)).toEqual(['parent']);
  });

  it('does not treat a self-parented row as its own child', () => {
    // Would otherwise nest a card inside itself and drop it from every lane.
    const { roots, childrenByParent } = partitionGoals([
      { id: 'g1', title: 'Loop', status: 'active', parentId: 'g1' },
    ]);
    expect(roots.map((r) => r.id)).toEqual(['g1']);
    expect(childrenByParent.size).toBe(0);
  });

  it('counts goals, not directives — a family of three is one card', () => {
    const board = buildGoalBoard(FAMILY, { nowMs: NOW });
    expect(board.total).toBe(1);
  });

  /* EVERY FETCHED ROW RENDERS EXACTLY ONCE — the invariant behind the orphan and
     depth cases alike. A goal that disappears cannot announce that it has, so
     these two are asserted by counting the whole set rather than by inspecting
     the case that happens to be interesting. */
  it('nests a GRANDCHILD on the root card instead of dropping it', () => {
    // parent_id is a free self-FK, so A←B←C is representable. Attaching C to B
    // would strand it: B is not a root, so B has no card to nest C inside.
    // Flattening to the root is also what D-006 means — the root is the agent,
    // and every descendant is a direction that agent was pointed in.
    const board = buildGoalBoard(
      [
        { id: 'a', title: 'Root goal', status: 'active' },
        { id: 'b', title: 'Child', status: 'active', parentId: 'a' },
        { id: 'c', title: 'Grandchild', status: 'active', parentId: 'b' },
      ],
      { nowMs: NOW },
    );
    const cards = allCards(board);
    expect(cards.map((c) => c.id)).toEqual(['a']);
    expect(cards[0].subGoals?.map((s) => s.title).sort()).toEqual(['Child', 'Grandchild']);
  });

  it('keeps a PARENT CYCLE visible rather than hanging or dropping it', () => {
    // Uninterpretable data must fail toward visible, never toward vanished — and
    // the walk must terminate.
    const board = buildGoalBoard(
      [
        { id: 'x', title: 'X', status: 'active', parentId: 'y' },
        { id: 'y', title: 'Y', status: 'active', parentId: 'x' },
      ],
      { nowMs: NOW },
    );
    expect(allCards(board).map((c) => c.id).sort()).toEqual(['x', 'y']);
  });
});

describe('goalSilence — staleness escalation + the abandoned state (goals-tab-improvement-2026-08-09 P-004)', () => {
  const HOUR = 3600 * 1000;
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  function goal(over: Partial<HudGoalInput> = {}): HudGoalInput {
    return { id: 'g1', title: 'Ship a paid app', status: 'active', ...over };
  }
  const chip = (g: HudGoalInput) =>
    toGoalCard(g, NOW).badges.find((b) => b.id === 'g1:silence') ?? null;

  // ── The item's real content: `updatedAt` is the DEFINITION-edit time, so it
  // cannot answer "is this moving". These two cases are the whole point, and
  // they fail in OPPOSITE directions — which is why both are pinned.
  it('does NOT call a busy goal stalled just because nobody has retitled it', () => {
    // Definition untouched for 30 days, work moving 10 minutes ago. Ageing off
    // updatedAt brands this maximally stale — the most damaging possible false
    // alarm, because it fires on the HEALTHIEST goals on the board.
    const g = goal({ updatedAt: iso(30 * 24 * HOUR), lastActivityAt: iso(10 * 60 * 1000) });
    expect(goalSilence(g, NOW).state).toBe('moving');
    expect(chip(g)).toBeNull();
  });

  it('still calls a dead goal stalled when its definition was just edited', () => {
    // The inverse: retitling a goal nothing has worked on in a week would, on
    // the naive implementation, report it as fresh — silence laundered into
    // activity by an edit that moved no work at all.
    const g = goal({ updatedAt: iso(30 * 1000), lastActivityAt: iso(7 * 24 * HOUR), openWorkItems: 2 });
    expect(goalSilence(g, NOW).state).toBe('stalled');
    expect(chip(g)?.label).toBe('stalled');
  });

  // ── UNMEASURED is not zero (the P-002 rule, third application).
  it('says NOTHING when there is no activity reading at all', () => {
    const g = goal({ updatedAt: iso(90 * 24 * HOUR) });
    expect(goalSilence(g, NOW)).toEqual({ state: 'unmeasured', silentSec: null });
    expect(chip(g)).toBeNull();
    expect(toGoalCard(g, NOW).sinceSec).toBeNull();
  });

  // ── Silence is only information when the goal CLAIMS to be running.
  it('never escalates a goal that is silent on purpose', () => {
    for (const status of ['achieved', 'killed', 'paused', 'blocked']) {
      const g = goal({ status, lastActivityAt: iso(60 * 24 * HOUR), openWorkItems: 0 });
      expect(goalSilence(g, NOW).state).toBe('expected');
      expect(chip(g)).toBeNull();
    }
  });

  it('treats a PAUSED goal as deliberately quiet even when it also has asks', () => {
    // goalColumn reports `needs-you` here, so keying the verdict off the COLUMN
    // instead of the STATUS would escalate a goal the owner deliberately stopped.
    const g = goal({ status: 'paused', needsHuman: 3, lastActivityAt: iso(60 * 24 * HOUR) });
    expect(goalColumn(g)).toBe('needs-you');
    expect(goalSilence(g, NOW).state).toBe('expected');
  });

  // ── The escalation itself.
  it('escalates stalled -> abandoned only when nothing is queued to move it', () => {
    const silent = iso(5 * 24 * HOUR);
    expect(goalSilence(goal({ lastActivityAt: silent, openWorkItems: 3 }), NOW).state).toBe('stalled');
    expect(goalSilence(goal({ lastActivityAt: silent, openWorkItems: 0 }), NOW).state).toBe('abandoned');
  });

  it('carries a heavier tone for abandoned than for stalled', () => {
    const stalled = chip(goal({ lastActivityAt: iso(30 * HOUR), openWorkItems: 1 }));
    const abandoned = chip(goal({ lastActivityAt: iso(5 * 24 * HOUR), openWorkItems: 0 }));
    expect(stalled?.tone).toBe('warn');
    expect(abandoned?.tone).toBe('bad');
    expect(abandoned?.label).toBe('abandoned');
  });

  it('does not fire at all inside the threshold', () => {
    expect(goalSilence(goal({ lastActivityAt: iso(23 * HOUR), openWorkItems: 0 }), NOW).state).toBe('moving');
  });

  it('holds back `abandoned` while the goal is still SPENDING', () => {
    // Recent spend is an independent sign of life — a long agent turn burns
    // money before it writes a work item. Without this the board would call a
    // goal abandoned while an agent was actively working on it.
    const g = goal({ lastActivityAt: iso(5 * 24 * HOUR), openWorkItems: 0, spendRecentUsd: 12 });
    expect(goalSilence(g, NOW).state).toBe('stalled');
  });

  it('does NOT let an ABSENT spend reading count as a sign of life', () => {
    // The asymmetry that makes the line above safe: `?? 0` is used only to
    // DOWNGRADE, so no reading must leave the alarm standing.
    const g = goal({ lastActivityAt: iso(5 * 24 * HOUR), openWorkItems: 0, spendRecentUsd: null });
    expect(goalSilence(g, NOW).state).toBe('abandoned');
  });

  it('a MEASURED zero spend does not rescue it either', () => {
    const g = goal({ lastActivityAt: iso(5 * 24 * HOUR), openWorkItems: 0, spendRecentUsd: 0 });
    expect(goalSilence(g, NOW).state).toBe('abandoned');
  });

  // ── Display vs ordering: only ONE of them is allowed to guess.
  it('ages the card off activity, not off the definition edit', () => {
    const g = goal({ updatedAt: iso(HOUR), lastActivityAt: iso(3 * HOUR) });
    expect(toGoalCard(g, NOW).sinceSec).toBe(3 * 3600);
  });

  it('still orders a never-active goal by when it was defined', () => {
    // DISPLAY refuses to guess (sinceSec is null above); ORDERING must not, or
    // the column cannot be laid out at all. They are allowed to differ, and
    // this pins that they do.
    const never = goal({ updatedAt: iso(2 * HOUR) });
    const card = toGoalCard(never, NOW);
    expect(card.sinceSec).toBeNull();
    expect(card.sortKey).toBe(toGoalCard(goal({ lastActivityAt: iso(2 * HOUR) }), NOW).sortKey);
  });
});

/**
 * Identity filtering — [owner 2026-08-10] "they should all be filterable by the
 * session id and agent id like the session tab is".
 *
 * The MISS cases carry the weight here. A filter that over-matches looks like it
 * works (results appear, they are just wrong), so "absent identity matches
 * nothing" is pinned explicitly rather than left to `''.includes()` semantics.
 */
describe('identityMatches', () => {
  const FULL = 'su-12b70e95-84ce-4ea0-b546-8a692cdc949c';

  it('matches a SHORT prefix of an owner id — what the owner actually types', () => {
    // The whole point: nobody types the full uuid. An exact-match rule would
    // make the feature unusable for the ids people have in their heads.
    expect(identityMatches({ ownerId: FULL }, 'su-12b70')).toBe(true);
  });

  it('matches case-insensitively and on any of the three fields', () => {
    expect(identityMatches({ ownerId: FULL }, 'SU-12B70'.toLowerCase())).toBe(true);
    expect(identityMatches({ sessionId: 'session-4821' }, '4821')).toBe(true);
    expect(identityMatches({ agentHandle: 'su-12b70e95' }, 'b70e')).toBe(true);
  });

  it('MISSES when no field contains the needle', () => {
    expect(identityMatches({ ownerId: FULL }, 'su-99999')).toBe(false);
  });

  it('an ABSENT identity matches NOTHING — never everything', () => {
    // The regression guard for the failure mode D-003 forbids: if this ever
    // returns true, every unassigned card matches every query and the filter
    // silently stops filtering.
    expect(identityMatches(undefined, 'su-12b70')).toBe(false);
    expect(identityMatches({}, 'su-12b70')).toBe(false);
    expect(identityMatches({ ownerId: null, sessionId: null }, 'su-12b70')).toBe(false);
    expect(identityMatches({ ownerId: '' }, 'su-12b70')).toBe(false);
  });

  it('an empty needle matches nothing, so it can never widen a search', () => {
    expect(identityMatches({ ownerId: FULL }, '')).toBe(false);
  });

  it('searches EVERY identity in a list, not just the first', () => {
    // A goal can carry more than one agent, and resolveGoalDetail returns the
    // list precisely so a second stamp stays visible. Matching only [0] would
    // hide the second agent from search — the bug that comment guards against.
    const two = [{ ownerId: 'su-aaaaaaaa-1111' }, { ownerId: 'su-bbbbbbbb-2222' }];
    expect(identityMatches(two, 'su-bbbbbbbb')).toBe(true);
    expect(identityMatches(two, 'su-aaaaaaaa')).toBe(true);
    expect(identityMatches(two, 'su-cccccccc')).toBe(false);
    expect(identityMatches([], 'su-aaaaaaaa')).toBe(false);
  });
});

describe('plan + goal cards carry identity (P-006)', () => {
  // Local, matching the file's existing convention — `goal()` is defined per
  // describe block here rather than hoisted to module scope.
  function goal(over: Partial<HudGoalInput> = {}): HudGoalInput {
    return { id: 'g1', title: 'Ship a paid app', status: 'active', ...over };
  }

  it('a plan card takes its identity from harness_plans.owner', () => {
    const card = toPlanCard(
      { slug: 'p1', status: 'active', owner: 'su-12b70e95-84ce-4ea0-b546-8a692cdc949c' },
      NOW,
    );
    expect(identityMatches(card.identity, 'su-12b70')).toBe(true);
  });

  it('an OWNERLESS plan does not fall back to its harness', () => {
    // The fabrication D-003 forbids: filtering by an agent id would otherwise
    // return every plan in that agent's harness and look like it worked.
    const card = toPlanCard({ slug: 'p1', status: 'active', harnessSlug: 'papercusp' }, NOW);
    expect(card.identity).toBeUndefined();
    expect(identityMatches(card.identity, 'papercusp')).toBe(false);
  });

  it('a goal card carries ALL its agents', () => {
    const card = toGoalCard(
      goal({ agents: [{ ownerId: 'su-12b70e95-1111' }, { ownerId: 'su-0056be10-2222' }] }),
      NOW,
    );
    expect(identityMatches(card.identity, 'su-0056be10')).toBe(true);
    expect(identityMatches(card.identity, 'su-12b70')).toBe(true);
  });

  it('a goal with no agents has undefined identity, not an empty list', () => {
    expect(toGoalCard(goal({ agents: [] }), NOW).identity).toBeUndefined();
    expect(toGoalCard(goal({}), NOW).identity).toBeUndefined();
  });

  /**
   * goal-live-holder-guarantee-2026-08-18 P-001. The payload resolves each
   * holder's liveness fresh on every read; this board is the LAST layer that
   * could quietly throw it away, and until P-001 it did — mapping agents down to
   * `{ownerId, agentHandle}` and nothing else.
   *
   * That is the whole defect one level up from where it was fixed: a goal-mode
   * row OUTLIVES the session that wrote it, so a card built from the identity
   * alone rendered a steward six days dead exactly as it rendered one working.
   * These lock the carry-through, so a later "simplify the map" cannot silently
   * restore it.
   */
  it('carries each holder LIVENESS through to the card — a dead holder is distinguishable', () => {
    const card = toGoalCard(
      goal({
        agents: [
          { ownerId: 'su-alive-1111', live: true, sessionState: 'live' },
          { ownerId: 'su-dead-2222', live: false, sessionState: 'ended' },
        ],
      }),
      NOW,
    );
    const ids = card.identity as Array<{ ownerId?: string | null; live?: boolean | null }>;
    expect(ids.map((i) => [i.ownerId, i.live])).toEqual([
      ['su-alive-1111', true],
      ['su-dead-2222', false],
    ]);
  });

  /**
   * The direction most likely to be "tidied" into a boolean. An UNRESOLVABLE
   * verdict is not a dead one: the presence oracle omits an entry when its
   * wakeability fetch degrades, so coercing null→false here would mark every
   * holder on the board dead at once during a transient hiccup.
   */
  it('keeps an UNRESOLVED verdict as null — never coerced to false', () => {
    const card = toGoalCard(goal({ agents: [{ ownerId: 'su-unknown-3333' }] }), NOW);
    const ids = card.identity as Array<{ live?: boolean | null; sessionState?: string | null }>;
    expect(ids[0].live).toBeNull();
    expect(ids[0].sessionState).toBeNull();
  });
});

describe('work-item cards carry identity so the Work items tab filters by agent', () => {
  it('populates ownerId + agentHandle from the assignee', () => {
    const card = toWorkItemCard(item({ assignee: 'su-12b70e95-84ce-4ea0-b546-8a692cdc949c' }), NOW);
    // A work item has exactly ONE assignee, so its identity is the scalar arm
    // of the union — pinned explicitly, since a list here would mean the
    // builder started guessing at additional owners.
    expect(Array.isArray(card.identity)).toBe(false);
    const one = card.identity as { ownerId?: string; agentHandle?: string } | undefined;
    expect(one?.ownerId).toBe('su-12b70e95-84ce-4ea0-b546-8a692cdc949c');
    expect(one?.agentHandle).toBe('su-12b70e95');
    expect(identityMatches(card.identity, 'su-12b70')).toBe(true);
  });

  it('leaves identity UNDEFINED when unassigned, rather than an empty object', () => {
    // Not `{ ownerId: null }`: a present-but-empty identity is the shape most
    // likely to be "tidied up" later into one that matches everything.
    expect(toWorkItemCard(item({ assignee: null }), NOW).identity).toBeUndefined();
    expect(toWorkItemCard(item({}), NOW).identity).toBeUndefined();
  });

  it('filters the board by agent id, keeping only that agent’s items', () => {
    const board = buildWorkItemBoard(
      [
        item({ id: 'WI-MINE', assignee: 'su-12b70e95-84ce-4ea0-b546-8a692cdc949c' }),
        item({ id: 'WI-THEIRS', assignee: 'su-0056be10-6496-40e0-bd98-f88198fe84b4' }),
        item({ id: 'WI-NOBODY' }),
      ],
      [],
      { nowMs: NOW, query: 'su-12b70' },
    );
    const ids = board.columns.flatMap((c) => c.cards.map((card) => card.id));
    expect(ids).toEqual(['WI-MINE']);
  });
});

describe('planCardMeta — the enriched plan card (plan-visibility-revamp-2026-08-23 P-007)', () => {
  const OWNER_A = 'su-76a83f22-1111-4ea0-b546-8a692cdc949c';
  const OWNER_B = 'su-6e294c10-2222-40e0-bd98-f88198fe84b4';
  const OWNER_C = 'su-f4aa0000-3333-40e0-bd98-f88198fe84b4';
  const OWNER_D = 'su-82be7000-4444-40e0-bd98-f88198fe84b4';
  const OWNER_E = 'su-5a000000-5555-40e0-bd98-f88198fe84b4';

  it('computes ✎ from `updated` and ⚒ from lastWorkAtMs, in seconds', () => {
    const meta = planCardMeta(
      plan({ updated: new Date(NOW - 120_000).toISOString(), lastWorkAtMs: NOW - 41_000 }),
      NOW,
    );
    expect(meta.editedSec).toBe(120);
    expect(meta.workedSec).toBe(41);
  });

  /* hud-plan-card-density-2026-08-31 D-003, at the MODEL layer.
     The rendered pips are covered in HudEntityColumns.test.tsx; this is the
     other half, and it exists because of a specific critique (WI-1743279 F5c):
     the acceptance rubric bound THIS file to the counts criterion while the file
     contained zero references to either count, so nothing in it could have gone
     red for that criterion's falsifier. A path binding is not a detection
     binding. These three cases are the detection. */
  it('derives the exception counts off itemCounts, under the keys the board writes', () => {
    const meta = planCardMeta(plan({ itemCounts: { 'needs-human': 2, blocked: 3, todo: 4 } }), NOW);
    expect(meta.needsHumanCount).toBe(2);
    expect(meta.blockedCount).toBe(3);
  });

  it('reports 0 — not null — for the counts a plan simply does not have', () => {
    // Unlike ✎/⚒ above, absence here is a real zero: "no item needs a human" is
    // a fact the counts DO establish, and the card renders no pip for it.
    expect(planCardMeta(plan({ itemCounts: { todo: 4 } }), NOW).needsHumanCount).toBe(0);
    expect(planCardMeta(plan({ itemCounts: {} }), NOW).blockedCount).toBe(0);
    expect(planCardMeta(plan({ itemCounts: null }), NOW).needsHumanCount).toBe(0);
  });

  it('reads the COUNTS, never the badge labels that restate them', () => {
    // The falsifier for D-003. A label-parsing implementation would agree with
    // the case above, because there the label and the count say the same thing.
    // It cannot agree here: the badges say one number and itemCounts says
    // another, and only the counts are allowed to win.
    const meta = planCardMeta(
      plan({ itemCounts: { 'needs-human': 7, blocked: 1 }, badges: [{ text: '99 blocked', tone: 'bad' }] } as never),
      NOW,
    );
    expect(meta.needsHumanCount).toBe(7);
    expect(meta.blockedCount).toBe(1);
  });

  it('reports null — not zero — for a plan never worked or with no edit stamp', () => {
    // The same unmeasured-is-not-zero rule the goals board applies (P-002):
    // "worked 0s ago" would claim activity that never happened.
    const meta = planCardMeta(plan({ updated: null, lastWorkAtMs: null }), NOW);
    expect(meta.editedSec).toBeNull();
    expect(meta.workedSec).toBeNull();
  });

  it('reports settled-over-total progress, counting dropped as settled', () => {
    const meta = planCardMeta(
      plan({ itemCounts: { done: 2, dropped: 1, todo: 5, wip: 1 } }),
      NOW,
    );
    expect(meta.itemsDone).toBe(3);
    expect(meta.itemsTotal).toBe(9);
  });

  it('reports NULL items for a plan with none — never a 0/0 fraction', () => {
    const meta = planCardMeta(plan({ itemCounts: {} }), NOW);
    expect(meta.itemsDone).toBeNull();
    expect(meta.itemsTotal).toBeNull();
  });

  it('caps the avatar stack and reports the overflow from the full population', () => {
    const meta = planCardMeta(
      plan({
        agents: [OWNER_A, OWNER_B, OWNER_C, OWNER_D, OWNER_E].map((ownerId) => ({ ownerId })),
      }),
      NOW,
    );
    expect(meta.avatars).toHaveLength(HUD_PLAN_AVATARS_SHOWN);
    expect(meta.avatarsOverflow).toBe(1);
  });

  it('spends the capped avatar slots on LIVE agents first', () => {
    const meta = planCardMeta(
      plan({
        agents: [
          { ownerId: OWNER_A, live: false },
          { ownerId: OWNER_B, live: null },
          { ownerId: OWNER_C, live: true },
          { ownerId: OWNER_D, live: false },
          { ownerId: OWNER_E, live: true },
        ],
      }),
      NOW,
    );
    expect(meta.avatars.map((a) => a.live)).toEqual([true, true, null, false]);
  });

  it('counts ONLY positive live verdicts in the pill — unknown is not alive', () => {
    const meta = planCardMeta(
      plan({
        agents: [
          { ownerId: OWNER_A, live: true },
          { ownerId: OWNER_B, live: null },
          { ownerId: OWNER_C },
          { ownerId: OWNER_D, live: false },
        ],
      }),
      NOW,
    );
    expect(meta.liveCount).toBe(1);
  });

  it('builds the who line from declared intents, live agents first, capped at two', () => {
    const meta = planCardMeta(
      plan({
        agents: [
          { ownerId: OWNER_A, live: false, intent: 'archived sweep' },
          { ownerId: OWNER_B, live: true, intent: 'recording D-001' },
          { ownerId: OWNER_C, live: true, intent: 'P-045 verification' },
        ],
      }),
      NOW,
    );
    expect(meta.who).toBe('su-6e294c10: recording D-001 · su-f4aa0000: P-045 verification');
  });

  it('reports NO who line when nobody declared an intent — never an empty string', () => {
    const meta = planCardMeta(
      plan({ agents: [{ ownerId: OWNER_A }, { ownerId: OWNER_B, intent: '   ' }] }),
      NOW,
    );
    expect(meta.who).toBeNull();
  });

  it('derives stable initials and a stable palette index from the owner id', () => {
    expect(avatarInitials(OWNER_A)).toBe('76');
    expect(avatarInitials('not-an-id')).toBe('no');
    const idx = avatarColorIndex(OWNER_A);
    expect(idx).toBe(avatarColorIndex(OWNER_A));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(HUD_AVATAR_COLOR_COUNT);
  });

  it('attaches meta to every plan card, agents or none — ✎/⚒ mean something alone', () => {
    const card = toPlanCard(plan(), NOW);
    expect(card.plan).toBeDefined();
    expect(card.plan?.avatars).toEqual([]);
    expect(card.plan?.liveCount).toBe(0);
    expect(card.plan?.who).toBeNull();
  });

  it('extends card identity with the roster agents, deduped against the owner', () => {
    const card = toPlanCard(
      plan({ owner: OWNER_A, agents: [{ ownerId: OWNER_A, live: true }, { ownerId: OWNER_B }] }),
      NOW,
    );
    const ids = (Array.isArray(card.identity) ? card.identity : [card.identity]).map(
      (i) => i?.ownerId,
    );
    expect(ids).toEqual([OWNER_A, OWNER_B]);
  });

  it('filters the Plans board by an agent WORKING the plan, not only its owner', () => {
    const board = buildPlanBoard(
      [
        plan({ slug: 'worked-by-b', agents: [{ ownerId: OWNER_B, live: true }] }),
        plan({ slug: 'other-plan' }),
      ],
      { nowMs: NOW, query: 'su-6e294' },
    );
    const ids = board.columns.flatMap((c) => c.cards.map((card) => card.id));
    expect(ids).toEqual(['worked-by-b']);
  });
});
