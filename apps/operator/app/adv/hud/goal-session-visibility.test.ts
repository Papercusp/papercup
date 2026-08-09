/**
 * P-020's guard: a goal's agent appears on EXACTLY ONE board.
 *
 * The plan item is explicit that a test checking only the sessions pane is
 * worthless here, because the two real failures are invisible from that side:
 *
 *   BOTH   — the session renders on the Goals tab AND in the sessions pane,
 *            the duplication the rail deletion was meant to end;
 *   NEITHER— the session is filtered out of the sessions pane while having no
 *            goal card to appear under, so it is on screen nowhere and nothing
 *            says so. Nobody files a bug about a session they cannot see, which
 *            is why this direction gets the most cases below.
 *
 * So every assertion here is a PAIR: what the sessions board shows, and what
 * the goals board shows, for the same fixture.
 */

import { describe, it, expect } from 'vitest';
import { buildHudBoard, HUD_DEFAULT_THRESHOLDS, type HudRosterEntry } from './hud-board-model';
import { buildGoalBoard, type HudGoalInput } from './hud-entity-board';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const GOAL_ID = 'ship-the-focus-kit-84cff3';

function entry(over: Partial<HudRosterEntry> = {}): HudRosterEntry {
  return {
    ownerId: 'su-11112222-3333-4444-5555-666677778888',
    label: 'su · su-11112',
    source: 'omp-hook-session',
    intent: 'greening the release gate',
    currentFiles: [],
    liveness: 'live',
    stale: false,
    lastActiveAt: iso(5_000),
    intentDeclaredAt: iso(60_000),
    loopArmed: false,
    modes: [],
    pidAlive: true,
    claims: [],
    declaredUnclaimed: false,
    currentPlanSlug: null,
    harnessSlug: null,
    agentPaneKind: 'su',
    role: 'su',
    agent: 'claude',
    advSessionId: 7,
    windowId: null,
    wakeMode: 'auto',
    pendingWakes: 0,
    fleetSlug: null,
    fleetColor: null,
    fleetRole: null,
    contextTokens: null,
    compactionLimit: null,
    openAwait: null,
    thinking: false,
    ...over,
  };
}

const goalInput = (over: Partial<HudGoalInput> = {}): HudGoalInput => ({
  id: GOAL_ID,
  title: 'Ship the Papercusp Focus Kit',
  status: 'active',
  killCriterion: 'kill if no shipped build by day 30',
  ...over,
});

/** Every owner id rendered on the sessions board, across all columns. */
function sessionOwners(board: ReturnType<typeof buildHudBoard>): string[] {
  return board.columns.flatMap((c) => c.sessions.map((s) => s.ownerId));
}

/** Every card ref rendered on the goals board, across all columns. */
function goalRefs(board: ReturnType<typeof buildGoalBoard>): string[] {
  return board.columns.flatMap((c) => c.cards.map((card) => card.ref));
}

const ORDINARY = 'su-aaaa1111-2222-3333-4444-555566667777';
const GOAL_AGENT = 'su-bbbb1111-2222-3333-4444-555566667777';

const boardOpts = { nowMs: NOW, thresholds: HUD_DEFAULT_THRESHOLDS };

describe('P-020 — a goal session renders on exactly one board', () => {
  it('hides the goal agent from the sessions pane and shows its goal on the goals board', () => {
    const sessions = buildHudBoard(
      [
        entry({ ownerId: ORDINARY }),
        entry({
          ownerId: GOAL_AGENT,
          modes: [{ mode: 'goal', ownerDirected: true, since: iso(600_000), subject: GOAL_ID }],
        }),
      ],
      [],
      boardOpts,
    );
    const goals = buildGoalBoard([goalInput()], { nowMs: NOW });

    // The ordinary session is on the sessions board and nowhere else.
    expect(sessionOwners(sessions)).toContain(ORDINARY);
    // The goal agent is NOT — it is represented by its goal card instead.
    expect(sessionOwners(sessions)).not.toContain(GOAL_AGENT);
    // ...and that goal card genuinely exists, which is the half a sessions-only
    // test cannot see. Without this the filter above would pass while having
    // made the session disappear entirely.
    expect(goalRefs(goals)).toContain(GOAL_ID);

    expect(sessions.total).toBe(1);
    expect(goals.total).toBe(1);
  });

  it('KEEPS a goal-mode session whose goal is not yet filed — the neither-board case', () => {
    // mode='goal' with subject NULL: the agent entered GOAL mode but goals:create
    // has not run, so no goal row and no goal card exists for it. Measured
    // 2026-08-09, this was the ONLY live goal-mode row in the workspace — the
    // supposedly-transient state is the one that actually occurs.
    const sessions = buildHudBoard(
      [
        entry({
          ownerId: GOAL_AGENT,
          modes: [{ mode: 'goal', ownerDirected: true, since: iso(600_000), subject: null }],
        }),
      ],
      [],
      boardOpts,
    );
    const goals = buildGoalBoard([], { nowMs: NOW });

    expect(goalRefs(goals)).toHaveLength(0);
    // Hiding it here would put it on NO board at all.
    expect(sessionOwners(sessions)).toContain(GOAL_AGENT);
  });

  it('keeps a goal-mode session carrying a blank subject visible', () => {
    // Same hazard as null, different spelling. `toRow` normalizes '' to null in
    // the store, but the wire type permits a string, and a board that treated
    // '' as a goal id would hide the session and then look for a goal card
    // named ''.
    const sessions = buildHudBoard(
      [entry({ ownerId: GOAL_AGENT, modes: [{ mode: 'goal', subject: '   ' }] })],
      [],
      boardOpts,
    );
    expect(sessionOwners(sessions)).toContain(GOAL_AGENT);
  });

  it('does not hide a session merely for holding other modes with subjects', () => {
    // DRAIN and GRADE use the same `subject` slot for a scope / rubric ref. A
    // filter keyed on "has a subject" rather than "is the goal axis" would
    // silently vanish every draining agent from the board.
    const sessions = buildHudBoard(
      [
        entry({
          ownerId: ORDINARY,
          modes: [
            { mode: 'auto', ownerDirected: true, since: iso(1000), subject: null },
            { mode: 'drain', ownerDirected: true, since: iso(1000), subject: 'harness:papercusp' },
          ],
        }),
      ],
      [],
      boardOpts,
    );
    expect(sessionOwners(sessions)).toContain(ORDINARY);
  });

  it('renders a goal agent the user navigated to BY ID, exemption beating the filter', () => {
    // WI-37204: an id-addressed session is exempt from the narrowing filters.
    // A goal's agent is exactly the kind of session a deep link points at, and
    // a link that resolves to an empty board is indistinguishable from a dead
    // one.
    const sessions = buildHudBoard(
      [
        entry({
          ownerId: GOAL_AGENT,
          modes: [{ mode: 'goal', ownerDirected: true, since: iso(600_000), subject: GOAL_ID }],
        }),
      ],
      [],
      { ...boardOpts, exemptOwners: new Set([GOAL_AGENT]) },
    );
    expect(sessionOwners(sessions)).toContain(GOAL_AGENT);
  });

  it('tolerates the legacy bare-string mode form without hiding anything', () => {
    // The roster payload historically flattened modes to bare ids. Such an
    // entry cannot carry a subject, so it can never be a goal session — the
    // safe reading, and the one that keeps an older operator's payload
    // rendering rather than blanking the board.
    const sessions = buildHudBoard([entry({ ownerId: ORDINARY, modes: ['goal'] })], [], boardOpts);
    expect(sessionOwners(sessions)).toContain(ORDINARY);
  });
});
