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
import {
  askToCard,
  buildPlanBoard,
  buildWorkItemBoard,
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
  it('exposes exactly the three the owner asked for, sessions first', () => {
    expect(HUD_TABS).toEqual(['sessions', 'plans', 'items']);
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

  it('sorts needs-you OLDEST first and every other column NEWEST first', () => {
    const older = '2026-07-20T00:00:00.000Z';
    const newer = '2026-07-26T00:00:00.000Z';
    const attention = buildPlanBoard(
      [
        plan({ slug: 'new-ask', updated: newer, itemCounts: { 'needs-human': 1 } }),
        plan({ slug: 'old-ask', updated: older, itemCounts: { 'needs-human': 1 } }),
      ],
      { nowMs: NOW },
    );
    expect(attention.columns.find((c) => c.id === 'needs-you')!.cards.map((c) => c.id)).toEqual([
      'old-ask',
      'new-ask',
    ]);

    const queue = buildPlanBoard(
      [
        plan({ slug: 'old-todo', updated: older, itemCounts: { todo: 1 } }),
        plan({ slug: 'new-todo', updated: newer, itemCounts: { todo: 1 } }),
      ],
      { nowMs: NOW },
    );
    expect(queue.columns.find((c) => c.id === 'ready')!.cards.map((c) => c.id)).toEqual([
      'new-todo',
      'old-todo',
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
