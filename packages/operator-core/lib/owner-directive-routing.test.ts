/**
 * P-008 of owner-directive-delivery-redesign-2026-09-22 (R-7): an ended
 * session does not strand its directives. Pins every branch of the route, the
 * unknown-liveness rule (never reroute on a missing verdict), and the leader
 * pre-filter that keeps the turn-start read cheap for sessions leading nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionState } from './agent-tools/coordination/presence-wakeability';
import { namedQueryStageTimings, traceNamedQueryStage, withNamedQueryDiagnosticContext } from './agent-tools/db-diagnostic-correlation-wiring';
import {
  directivesInheritedBy,
  routeDirective,
  routeOpenDirectives,
  type DirectiveRoutingDeps,
  type DirectiveRoutingFacts,
} from './owner-directive-routing';

const GONE = 'su-gone';
const LEADER = 'su-leader';
const HOLDER = 'su-holder';

function facts(over: Partial<DirectiveRoutingFacts> = {}): DirectiveRoutingFacts {
  return {
    states: new Map<string, SessionState | null>([
      [GONE, 'ended'],
      [LEADER, 'live'],
      [HOLDER, 'live'],
    ]),
    fleets: new Map([[GONE, 'fleet-a']]),
    leaders: new Map([['fleet-a', LEADER]]),
    holders: new Map(),
    ...over,
  };
}

const row = { id: 7, recordedBy: GONE };

describe('routeDirective', () => {
  it('stays with a live, parked or unknown addressee', () => {
    for (const state of ['live', 'parked', 'suspect', null] as const) {
      expect(routeDirective(row, facts({ states: new Map([[GONE, state]]) }))).toEqual({ kind: 'addressee' });
    }
  });

  it('passes an ended addressee\'s directive to its live fleet leader', () => {
    expect(routeDirective(row, facts())).toEqual({ kind: 'fleet-leader', fleetSlug: 'fleet-a', leaderOwnerId: LEADER });
    // `recorded` (a transcript with no process) is gone too.
    const recorded = facts({ states: new Map<string, SessionState | null>([[GONE, 'recorded'], [LEADER, 'live']]) });
    expect(routeDirective(row, recorded).kind).toBe('fleet-leader');
  });

  it('a live holder of linked work keeps it, ahead of the leader', () => {
    expect(routeDirective(row, facts({ holders: new Map([[7, [HOLDER]]]) }))).toEqual({ kind: 'holder', holders: [HOLDER] });
    // A holder that has itself ended holds nothing.
    const endedHolder = facts({
      holders: new Map([[7, [HOLDER]]]),
      states: new Map<string, SessionState | null>([[GONE, 'ended'], [HOLDER, 'ended'], [LEADER, 'live']]),
    });
    expect(routeDirective(row, endedHolder).kind).toBe('fleet-leader');
  });

  it('is unhandled with no fleet, a leaderless fleet, a self-led fleet, or an ended leader', () => {
    expect(routeDirective(row, facts({ fleets: new Map() }))).toEqual({ kind: 'unhandled', why: 'no-fleet', fleetSlug: null });
    expect(routeDirective(row, facts({ leaders: new Map([['fleet-a', null]]) }))).toMatchObject({ why: 'no-leader' });
    expect(routeDirective(row, facts({ leaders: new Map([['fleet-a', GONE]]) }))).toMatchObject({ why: 'no-leader' });
    const endedLeader = facts({ states: new Map<string, SessionState | null>([[GONE, 'ended'], [LEADER, 'ended']]) });
    expect(routeDirective(row, endedLeader)).toEqual({ kind: 'unhandled', why: 'leader-ended', fleetSlug: 'fleet-a' });
  });
});

function fakeDeps(states: Record<string, SessionState | null>, over: Partial<DirectiveRoutingDeps> = {}) {
  const deps: DirectiveRoutingDeps = {
    sessionStates: vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, states[id] ?? null]))),
    lastFleets: vi.fn(async () => new Map([[GONE, 'fleet-a']])),
    fleetLeaders: vi.fn(async () => new Map([['fleet-a', LEADER]])),
    directiveHolders: vi.fn(async () => new Map()),
    fleetsLedBy: vi.fn(async () => ['fleet-a']),
    ...over,
  };
  return deps;
}

describe('routeOpenDirectives', () => {
  it.each(['addressees', 'membership', 'related'] as const)(
    'retains a pending %s leg in the original attention request', async boundary => {
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const paused = new Promise<void>(resolve => { release = resolve; });
      const pause = async (leg: typeof boundary) => {
        if (leg === boundary) { enter(); await paused; }
      };
      const deps = fakeDeps({ [GONE]: 'ended', [LEADER]: 'live' }, {
        sessionStates: vi.fn(async ids => {
          await pause(ids.includes(GONE) ? 'addressees' : 'related');
          return new Map<string, SessionState>(ids.map(id => [id, id === GONE ? 'ended' : 'live']));
        }),
        directiveHolders: vi.fn(async () => { await pause('membership'); return new Map(); }),
      });
      await withNamedQueryDiagnosticContext('plans.attention', async requestId => {
        const read = routeOpenDirectives('ws', [row], deps);
        try {
          await entered;
          expect(namedQueryStageTimings()).toMatchObject({ requestId, omittedStages: 0 });
          expect(namedQueryStageTimings()?.stages).toEqual(expect.arrayContaining([
            expect.objectContaining({ stage: `directive-route-${boundary}`, outcome: 'pending' }),
          ]));
          if (boundary === 'addressees') expect(deps.directiveHolders).not.toHaveBeenCalled();
          if (boundary === 'membership') expect(deps.fleetLeaders).not.toHaveBeenCalled();
        } finally {
          release();
          await read;
        }
        expect((await read).get(row.id)).toEqual({ kind: 'fleet-leader', fleetSlug: 'fleet-a', leaderOwnerId: LEADER });
        expect(namedQueryStageTimings()?.stages.every(stage => stage.outcome === 'fulfilled')).toBe(true);
      });
      expect(namedQueryStageTimings()).toBeNull();
    },
  );

  it('records a rejected route leg without replacing its error or continuing dependent reads', async () => {
    const failure = new Error('directive holder read unavailable');
    const deps = fakeDeps({ [GONE]: 'ended' }, {
      directiveHolders: vi.fn(async () => { throw failure; }),
    });
    await withNamedQueryDiagnosticContext('plans.attention', async () => {
      await expect(routeOpenDirectives('ws', [row], deps)).rejects.toBe(failure);
      expect(namedQueryStageTimings()?.stages).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 'directive-route-membership', outcome: 'rejected' }),
      ]));
      expect(deps.fleetLeaders).not.toHaveBeenCalled();
    });
  });

  it('retains both liveness phases and membership when the request trace is almost full', async () => {
    await withNamedQueryDiagnosticContext('plans.attention', async () => {
      for (let i = 0; i < 29; i++) await traceNamedQueryStage('attention-plans', async () => undefined);
      const routes = await routeOpenDirectives('ws', [row], fakeDeps({ [GONE]: 'ended', [LEADER]: 'live' }));
      expect(routes.get(row.id)?.kind).toBe('fleet-leader');
      expect(namedQueryStageTimings()?.omittedStages).toBe(0);
      expect(namedQueryStageTimings()?.stages.slice(-3)).toEqual([
        expect.objectContaining({ stage: 'directive-route-addressees', outcome: 'fulfilled' }),
        expect.objectContaining({ stage: 'directive-route-membership', outcome: 'fulfilled' }),
        expect.objectContaining({ stage: 'directive-route-related', outcome: 'fulfilled' }),
      ]);
    });
  });

  it('asks liveness for the leader it discovered, and routes only the ended rows', async () => {
    const deps = fakeDeps({ [GONE]: 'ended', 'su-alive': 'live', [LEADER]: 'live' });
    const routes = await routeOpenDirectives('ws', [row, { id: 8, recordedBy: 'su-alive' }], deps);
    expect(routes.get(7)).toEqual({ kind: 'fleet-leader', fleetSlug: 'fleet-a', leaderOwnerId: LEADER });
    expect(routes.get(8)).toEqual({ kind: 'addressee' });
    expect(deps.sessionStates).toHaveBeenLastCalledWith([LEADER]);
  });

  it('skips every fleet read when no addressee has ended', async () => {
    const deps = fakeDeps({ [GONE]: 'live' });
    await routeOpenDirectives('ws', [row], deps);
    expect(deps.lastFleets).not.toHaveBeenCalled();
    expect(deps.directiveHolders).not.toHaveBeenCalled();
  });
});

describe('directivesInheritedBy', () => {
  it('returns the directives passed to this leader', async () => {
    const deps = fakeDeps({ [GONE]: 'ended', [LEADER]: 'live' });
    const open = [row, { id: 9, recordedBy: LEADER }];
    expect(await directivesInheritedBy({ workspaceId: 'ws', ownerId: LEADER, open }, deps)).toEqual(new Set([7]));
  });

  it('costs a session that leads no fleet one read and nothing else', async () => {
    const deps = fakeDeps({ [GONE]: 'ended' }, { fleetsLedBy: vi.fn(async () => []) });
    expect(await directivesInheritedBy({ workspaceId: 'ws', ownerId: 'su-nobody', open: [row] }, deps)).toEqual(new Set());
    expect(deps.lastFleets).not.toHaveBeenCalled();
    expect(deps.sessionStates).not.toHaveBeenCalled();
  });

  it('ignores ended members of fleets it does not lead', async () => {
    const deps = fakeDeps({ [GONE]: 'ended', [LEADER]: 'live' }, { fleetsLedBy: vi.fn(async () => ['fleet-b']) });
    expect(await directivesInheritedBy({ workspaceId: 'ws', ownerId: LEADER, open: [row] }, deps)).toEqual(new Set());
    expect(deps.sessionStates).not.toHaveBeenCalled();
  });
});
