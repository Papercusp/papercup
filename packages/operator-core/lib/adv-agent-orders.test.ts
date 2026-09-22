/**
 * Unit tests for the PURE half of adv-agent-orders
 * (session-chat-popup-direction-d-2026-08-02 P-011/P-012).
 *
 * The IO half (`getAgentOrders`) composes existing authorities that are covered
 * by their own suites; what is genuinely new logic — and therefore genuinely
 * worth testing — is the grading and flattening below.
 *
 * ONE exception, at the bottom of this file: the SINK the popup projects at is
 * a decision made here and nowhere else, so no other suite can cover it. A
 * mutation probe (P-018) proved that omission was load-bearing — see that
 * describe block for the gap and what closes it.
 */
import { describe, expect, it, vi } from 'vitest';
import { projectOrientationRows, type OrientationState } from './turn-start-orientation';
import { carryStaleness, getAgentOrders, missionFromTrace, renderRoute } from './adv-agent-orders';

/**
 * The orientation fixture, hoisted so the `./turn-start-orientation` mock
 * factory and the assertions can share ONE definition — a second copy would
 * let the two drift and quietly stop comparing the same thing.
 *
 * It must light up at least one turn-start-ONLY class (here: `held` and
 * `loopArmed`) or the two sinks project identically and the sink assertions
 * below prove nothing. That is asserted, not trusted — see the calibration.
 */
const { orientationFixture } = vi.hoisted(() => ({
  orientationFixture: (): Record<string, unknown> => ({
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
  }),
}));

// Only the IO leg is stubbed. `projectOrientationRows` is spread through REAL
// on purpose: the assertions compare against the true projection, so they
// cannot pass by agreeing with a fake.
vi.mock('./turn-start-orientation', async (importActual) => {
  const actual = await importActual<typeof import('./turn-start-orientation')>();
  return { ...actual, resolveOrientationState: async () => orientationFixture() };
});

// The remaining legs are each `.catch()`-degraded inside `getAgentOrders`, so
// stubbing them to their unavailable/empty reading keeps this a UNIT test (no
// database) while exercising the real composition path.
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'test-workspace' }));
vi.mock('./agent-tools/coordination/control-anchor', () => ({
  buildControlAnchorState: async () => null,
}));
vi.mock('./carry-brief', () => ({
  buildCarryBrief: async () => null,
  detectTerminalCitedRefs: () => [],
}));
vi.mock('./agent-tools/coordination/wake-mode', () => ({
  getDefaultWakeMode: async () => 'auto',
  getWakeModeOverride: async () => null,
}));
vi.mock('./agent-orient-disclosures', () => ({ readOrientDisclosures: async () => null }));

describe('carryStaleness', () => {
  it('grades a cold agent harder than a warm one at the SAME age', () => {
    // The whole point of the function: for a cold-carry agent the checkpoint is
    // its only memory across wakes, so an age that is unremarkable for a warm
    // agent is a correctness problem for a cold one. Asserted at two points so
    // the test pins the SHAPE of the difference, not one lucky threshold.
    expect(carryStaleness(10 * 60_000, 'cold')).toBe('aging');
    expect(carryStaleness(10 * 60_000, 'warm')).toBe('fresh');

    expect(carryStaleness(30 * 60_000, 'cold')).toBe('stale');
    expect(carryStaleness(30 * 60_000, 'warm')).toBe('aging');
  });

  it('walks cold through fresh → aging → stale', () => {
    expect(carryStaleness(2 * 60_000, 'cold')).toBe('fresh');
    expect(carryStaleness(10 * 60_000, 'cold')).toBe('aging');
    expect(carryStaleness(60 * 60_000, 'cold')).toBe('stale');
  });

  it('walks warm through fresh → aging → stale', () => {
    expect(carryStaleness(5 * 60_000, 'warm')).toBe('fresh');
    expect(carryStaleness(45 * 60_000, 'warm')).toBe('aging');
    expect(carryStaleness(4 * 60 * 60_000, 'warm')).toBe('stale');
  });

  it('returns unknown rather than guessing when the age is unusable', () => {
    // An unknown age must NOT render as "fresh" — that is the failure mode the
    // three-state rule (plan D-003) exists to prevent, in miniature.
    expect(carryStaleness(null, 'warm')).toBe('unknown');
    expect(carryStaleness(Number.NaN, 'cold')).toBe('unknown');
    expect(carryStaleness(-1, 'warm')).toBe('unknown');
  });

  it('treats an unknown carry mode as warm rather than failing', () => {
    expect(carryStaleness(10 * 60_000, null)).toBe('fresh');
  });
});

describe('renderRoute', () => {
  it('renders a fleet route with its role', () => {
    expect(renderRoute({ kind: 'fleet', fleet: 'hud-redesign', role: 'leader' })).toBe(
      'fleet:hud-redesign (leader)',
    );
  });

  it('renders a fleet route without a role', () => {
    expect(renderRoute({ kind: 'fleet', fleet: 'hud-redesign', role: null })).toBe(
      'fleet:hud-redesign',
    );
  });

  it('renders non-fleet routes as their bare kind', () => {
    expect(renderRoute({ kind: 'self' })).toBe('self');
    expect(renderRoute({ kind: 'mug' })).toBe('mug');
  });

  it('does not claim a fleet when the slug is missing', () => {
    // A malformed route must degrade, never render "fleet:undefined".
    expect(renderRoute({ kind: 'fleet' })).toBe('fleet');
  });
});

describe('missionFromTrace', () => {
  const trace = {
    effectiveMission: {
      constraint: 'execute-owner-directed-scope',
      source: 'route:self',
      explanation: 'Advance the current owner-directed task.',
    },
    decisions: [
      {
        key: 'execution-authorization',
        status: 'effective',
        effective: { value: 'confirm-before-execution', source: 'generic-playbook' },
        suppressed: [],
      },
      {
        key: 'mission',
        status: 'effective',
        effective: { value: 'execute-owner-directed-scope', source: 'route:self' },
        suppressed: [
          {
            value: 'generic-backlog-selection',
            source: 'generic-playbook',
            reason: 'owner-directed scope is the effective mission.',
          },
        ],
      },
    ],
  };

  it('lifts the mission, the authority, and the route', () => {
    const m = missionFromTrace(trace, 'self');
    expect(m?.constraint).toBe('execute-owner-directed-scope');
    expect(m?.authority).toBe('confirm-before-execution');
    expect(m?.authoritySource).toBe('generic-playbook');
    expect(m?.route).toBe('self');
  });

  it('collects suppressions from EVERY decision, tagged with their key', () => {
    // The panel's whole reason for showing suppressions is that a suppressed
    // rule is indistinguishable from a disobeyed one without them — so they
    // must not be dropped just because they live under a non-authority key.
    const m = missionFromTrace(trace, 'self');
    expect(m?.suppressed).toHaveLength(1);
    expect(m?.suppressed[0]).toMatchObject({
      key: 'mission',
      value: 'generic-backlog-selection',
    });
    expect(m?.suppressed[0]?.reason).toContain('owner-directed');
  });

  it('returns null for a missing trace rather than a fabricated default', () => {
    // Rendering a default "confirm-before-execution" for an agent whose trace we
    // could not read would be a false statement about its authority — worse
    // than an honest blank.
    expect(missionFromTrace(null, 'self')).toBeNull();
    expect(missionFromTrace(undefined, 'self')).toBeNull();
  });

  it('survives a trace with no decisions at all', () => {
    const m = missionFromTrace({ effectiveMission: { constraint: 'x' } }, null);
    expect(m?.constraint).toBe('x');
    expect(m?.authority).toBeNull();
    expect(m?.suppressed).toEqual([]);
  });
});

/**
 * P-018 — the popup projects at the `agent-orders` SINK, and that choice is
 * made HERE, at one call site, so no other suite can cover it.
 *
 * ── Why this block exists (a mutation probe, not a hunch) ───────────────────
 * Swapping that call site's sink literal from 'agent-orders' to the other
 * VALID value 'turn-start' was caught by ZERO tests:
 *
 *   MUTATION_PROBE_RESULT verdict=survived expected=caught
 *
 * The sibling suite (turn-start-orientation-shared-projection.test.ts) covers
 * an UNKNOWN sink — 'not-a-sink' projects [] — but never a valid-but-WRONG one,
 * and this file covered only the pure half. The gap sat exactly between them.
 *
 * It is not cosmetic: 'turn-start' is a SUPERSET (15 classes carry it that the
 * popup does not), so the mutation silently renders an agent's full turn-start
 * set into an OBSERVER surface — and every existing assertion still passes.
 */
describe('getAgentOrders — the obligation rows are the agent-orders projection', () => {
  it('projects at the agent-orders sink, not the full turn-start set', async () => {
    const state = orientationFixture() as unknown as OrientationState;
    const expectedAgentOrders = projectOrientationRows(state, 'agent-orders', null);
    const turnStartRows = projectOrientationRows(state, 'turn-start', null);

    // CALIBRATION FIRST. Both assertions below are vacuous if the fixture
    // stops discriminating the two sinks (a class list change, or a future
    // edit stubbing the projection so both return []). Then the block would
    // keep passing while covering nothing — the very state the probe found.
    expect(
      turnStartRows,
      'fixture no longer discriminates the sinks — the assertions below prove nothing',
    ).not.toEqual(expectedAgentOrders);

    const orders = await getAgentOrders('su-test-owner');

    // The rows ARE the real projection at the popup's sink...
    expect(orders.obligationRows).toEqual(expectedAgentOrders);
    // ...and are NOT the turn-start set. Given a discriminating fixture either
    // assertion alone fails under the mutant; both are stated so the failure
    // names WHICH direction it diverged, and so the guarantee still holds if a
    // later fixture change narrows the difference.
    expect(orders.obligationRows).not.toEqual(turnStartRows);
  });
});
