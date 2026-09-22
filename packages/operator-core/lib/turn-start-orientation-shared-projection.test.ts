/**
 * P-018 — "what was the agent told" has ONE answer.
 *
 * The HUD conversation popup's Orders rail and the turn-start block are two
 * different surfaces reading the same question. Before this plan they were two
 * different BUILDERS: the popup shaped `buildCarryBrief` output inline in
 * `getAgentOrders`, while the agent actually received
 * `buildTurnStartOrientationBlock`'s registry render. Nothing made them agree,
 * and nothing would have reported it when they stopped.
 *
 * These tests pin the mechanism that makes them agree BY CONSTRUCTION:
 * `projectOrientationRows` is the single projection, and the sink is the only
 * thing a caller varies.
 *
 * ⚠ The test that matters is `sameFixtureSameRows` below — it is the plan
 * item's own acceptance wording ("same fixture => same rows in both"). The
 * others exist so a future edit that breaks the guarantee fails HERE, with a
 * message naming what broke, rather than silently in a screen nobody diffs.
 */
import { describe, expect, it } from 'vitest';
import {
  ORIENTATION_CLASS_REGISTRY,
  projectOrientationRows,
  renderOrientationLines,
  selectOrientationSegments,
  type OrientationState,
} from './turn-start-orientation';

/**
 * A fixture that lights up EVERY class carrying the `agent-orders` sink.
 *
 * Deliberately not a minimal fixture: a projection-equality test whose fixture
 * populates two classes would pass while the other three diverged, which is the
 * failure mode this file exists to catch. `assertFixtureCoversAgentOrdersSink`
 * below asserts the coverage rather than trusting this comment.
 */
function fixture(): OrientationState {
  return {
    held: [],
    ownerDirectives: [
      {
        id: 4242,
        verbatimText: 'stop refactoring the gate and green it first',
        recordedBy: 'owner',
        createdAtMs: Date.UTC(2026, 8, 21, 12, 0, 0),
        sourceTurnRef: 'turn:abc123',
        dispositionStatus: null,
      },
    ],
    openChecks: [
      {
        id: 'blocker-1',
        claim: 'waiting on the release credential to be rotated',
        recheck: 'accounts:status',
        pointer: 'WI-10002406',
        kind: 'blocker',
      },
    ],
    unansweredDirected: 2,
    unansweredStale: 0,
    inboxRecent: [],
    openAsks: null,
    announcedGates: [],
    modes: null,
    loopArmed: true,
    loopFireWithheld: false,
    improvementTriage: null,
    executableFrontier: null,
    neverDropFacts: ['wall:no-owner-credential', 'guard-rail:never-force-past-red'],
    toolSurface: null,
    carryBlindWindow: null,
  } as unknown as OrientationState;
}

/** The classes declared to reach the HUD Orders rail. Read from the registry,
 *  never hardcoded — a hardcoded list would pass after someone withdrew a sink,
 *  which is precisely the regression this file is for. */
function agentOrdersClassIds(): string[] {
  return ORIENTATION_CLASS_REGISTRY.filter((entry) =>
    entry.applicableSinks.includes('agent-orders'),
  ).map((entry) => String(entry.id));
}

describe('P-018 shared obligation+delta projection', () => {
  it('declares the agent-orders sink on the obligation classes, and only those', () => {
    // The membership IS the decision (see TURN_START_AND_AGENT_ORDERS). Pinning
    // it means widening the popup's obligation section is a deliberate edit here
    // and not a quiet side effect of touching a shared const.
    expect(agentOrdersClassIds().sort()).toEqual(
      ['neverDropFacts', 'obligations', 'openChecks', 'ownerDirectives', 'unansweredDirected'].sort(),
    );
  });

  it('fixture covers every class carrying the sink (guards a vacuous equality pass)', () => {
    const rows = projectOrientationRows(fixture(), 'agent-orders', null);
    const emitted = new Set(rows.map((r) => String(r.classId)));
    // `obligations` is legitimately absent — the fixture carries no obligation
    // agenda, and the class renders nothing without one. Every OTHER class must
    // have produced a row, or this file's equality assertion is comparing empty
    // lists and proving nothing.
    for (const id of agentOrdersClassIds()) {
      if (id === 'obligations') continue;
      expect(emitted, `class ${id} emitted no row — the fixture no longer exercises it`).toContain(id);
    }
    expect(rows.length).toBeGreaterThan(0);
  });

  it('sameFixtureSameRows: the popup renders the SAME rows turn-start rendered', () => {
    const state = fixture();

    const turnStart = projectOrientationRows(state, 'turn-start', null);
    const agentOrders = projectOrientationRows(state, 'agent-orders', null);

    // The popup is a SUBSET by design — it may render more observer detail
    // elsewhere, but its obligation section is exactly turn-start's rows for
    // the classes it carries. So compare per class: identical text, identical
    // order, identical sequence.
    const shared = new Set(agentOrdersClassIds());
    const turnStartShared = turnStart.filter((r) => shared.has(String(r.classId)));

    expect(agentOrders).toEqual(turnStartShared);

    // And character-for-character on the rendered line, stated separately so a
    // failure says WHICH text diverged rather than dumping two object arrays.
    expect(agentOrders.map((r) => r.text)).toEqual(turnStartShared.map((r) => r.text));
  });

  it('turn-start lines are these rows — not a second render of them', () => {
    const state = fixture();
    // renderOrientationLines is the block's only line source, so this equality
    // is what makes the popup's rows the agent's ACTUAL text rather than a
    // faithful-looking parallel build.
    expect(renderOrientationLines(state, null)).toEqual(
      projectOrientationRows(state, 'turn-start', null).map((r) => r.text),
    );
  });

  it('row order matches selectOrientationSegments — the two views cannot disagree', () => {
    const state = fixture();
    const viaSegments: string[] = [];
    for (const segment of selectOrientationSegments('turn-start')) {
      viaSegments.push(...segment.render(state, null));
    }
    expect(projectOrientationRows(state, 'turn-start', null).map((r) => r.text)).toEqual(viaSegments);
  });

  it('rows carry ascending order, so a bounder can evict by priority (P-019)', () => {
    const rows = projectOrientationRows(fixture(), 'agent-orders', null);
    const orders = rows.map((r) => r.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('an unknown sink projects nothing rather than falling back to turn-start', () => {
    // A silent fallback would let a typo'd sink render the full turn-start set
    // into an observer surface and look correct.
    expect(
      projectOrientationRows(fixture(), 'not-a-sink' as unknown as 'agent-orders', null),
    ).toEqual([]);
  });
});
