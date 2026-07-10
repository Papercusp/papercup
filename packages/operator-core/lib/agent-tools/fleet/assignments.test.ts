/**
 * assignments.test.ts — `reconcileWakeability` (EI-6077): fleet:assignments'
 * `alive` is heartbeat-freshness only, which can diverge from whether
 * coord:dispatch/coord:send can actually REACH the agent (a live
 * `coord:inbox-wake:<id>` standing await). This pins the reconciliation with an
 * INJECTED wakeability fetcher — no PG needed (mirrors dispatch.test.ts's
 * composeDispatch pattern: extract the pure/DI-testable core, mock the IO seam).
 */
import { describe, expect, it } from 'vitest';
import {
  reconcileWakeability,
  deriveMemberVerdict,
  decorateMemberVerdicts,
  decorateParkedOn,
  VERDICT_SPEAKING_FRESH_MS,
  VERDICT_STALL_MS,
  type MemberVerdict,
} from './assignments';
import { shapeFleetAssignments } from './assignments-shape';
import type { AgentAssignment } from '../../fleet/assignments';
import type { WakeMode } from '../coordination/wake-mode';
import type { SessionState, WakeabilitySignals } from '../coordination/presence-wakeability';

function baseAgent(overrides: Partial<AgentAssignment> = {}): AgentAssignment & {
  sessionState?: SessionState | null;
} {
  return {
    agentId: 'su-agent-1',
    label: null,
    name: null,
    present: true,
    alive: true,
    // Fresh by default — the fixture models a "heartbeat-alive" agent (it sets
    // alive:true), and since fleet-liveness-zombie-await-2026-07-07 an hour-cold
    // heartbeat is authoritatively `ended`, so a static past date would read dead.
    heartbeatAt: new Date().toISOString(),
    intent: '',
    declaredPlanSlug: null,
    fleetSlug: null,
    fleetRole: null,
    claims: [],
    orphaned: false,
    stalled: false,
    declaredUnclaimed: false,
    doing: null,
    queued: [],
    load: 0,
    ...overrides,
  };
}

const fakeFetch =
  (signals: Record<string, WakeabilitySignals>) =>
  async (ids: string[]): Promise<Map<string, WakeabilitySignals>> =>
    new Map(ids.filter((id) => id in signals).map((id) => [id, signals[id]]));

describe('reconcileWakeability (EI-6077)', () => {
  it('the exact EI-6077 evidence: heartbeat-alive but no live inbox-wake await → sessionState ended, alive downgraded', async () => {
    const agent = baseAgent({ alive: true });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: false, liveTurn: false } });
    const [out] = await reconcileWakeability([agent], fetchFn, async () => new Set());
    expect(out.sessionState).toBe('ended');
    expect(out.alive).toBe(false);
  });

  it('EI-8106: not wakeable but positively recorded live → sessionState recorded, not ended', async () => {
    const agent = baseAgent({ alive: false });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: false, liveTurn: true } });
    const [out] = await reconcileWakeability([agent], fetchFn, async () => new Set(['su-agent-1']));
    expect(out.sessionState).toBe('recorded');
    expect(out.alive).toBe(true);
  });

  it('heartbeat-alive AND wakeable with a running turn → sessionState live, alive stays true', async () => {
    const agent = baseAgent({ alive: true });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: true, liveTurn: true } });
    const [out] = await reconcileWakeability([agent], fetchFn, async () => new Set());
    expect(out.sessionState).toBe('live');
    expect(out.alive).toBe(true);
  });

  it('heartbeat-alive, wakeable, but idle (no running turn) → sessionState parked, alive stays true', async () => {
    const agent = baseAgent({ alive: true });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: true, liveTurn: false } });
    const [out] = await reconcileWakeability([agent], fetchFn, async () => new Set());
    expect(out.sessionState).toBe('parked');
    expect(out.alive).toBe(true);
  });

  it('fleet-liveness-zombie-await-2026-07-07: wakeable but hour-cold heartbeat → ended, not parked', async () => {
    // The reboot-zombie shape on the fleet:assignments surface: a lingering
    // (never-cancelled) wake-await makes it wakeable, but the heartbeat has been
    // cold for an hour → the DEAD-ceiling backstop forces `ended`, not `parked`.
    const agent = baseAgent({ alive: false, heartbeatAt: new Date(Date.now() - 72 * 60_000).toISOString() });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: true, liveTurn: false } });
    const [out] = await reconcileWakeability([agent], fetchFn, async () => new Set());
    expect(out.sessionState).toBe('ended');
    expect(out.alive).toBe(false);
  });

  it('no wakeability signal for the agent (e.g. a federated peer) — leaves alive/sessionState untouched', async () => {
    const agent = baseAgent({ alive: true });
    const fetchFn = fakeFetch({});
    const [out] = await reconcileWakeability([agent], fetchFn, async () => new Set(['su-agent-1']));
    expect(out.sessionState).toBeUndefined();
    expect(out.alive).toBe(true);
  });

  it('never REVIVES an already-dead (heartbeat-stale) agent', async () => {
    const agent = baseAgent({ alive: false });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: true, liveTurn: true } });
    const [out] = await reconcileWakeability([agent], fetchFn, async () => new Set());
    // stale:true (since !alive) with wakeable+liveTurn still resolves 'parked' per
    // deriveSessionState (liveTurn && !stale is required for 'live') — the point
    // pinned here is it does NOT flip a heartbeat-dead agent back to alive:true.
    expect(out.alive).toBe(false);
  });

  it('empty input is a no-op (never calls the fetcher)', async () => {
    let called = false;
    const fetchFn = async () => {
      called = true;
      return new Map<string, WakeabilitySignals>();
    };
    const out = await reconcileWakeability([], fetchFn);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});

// ─────────────────── EI-8995: the single derived member verdict ───────────────────

const NOW = 1_800_000_000_000;

function verdictInput(overrides: Partial<Parameters<typeof deriveMemberVerdict>[0]> = {}) {
  return {
    present: true,
    alive: true,
    sessionState: 'live' as SessionState,
    stalled: false,
    load: 0,
    lastToolCallAtMs: null as number | null,
    ...overrides,
  };
}

describe('deriveMemberVerdict (EI-8995)', () => {
  it('sessionState ended → dead, regardless of a warm heartbeat', () => {
    expect(deriveMemberVerdict(verdictInput({ sessionState: 'ended', alive: true }), NOW)).toBe('dead');
  });

  it('heartbeat-dead → dead', () => {
    expect(deriveMemberVerdict(verdictInput({ alive: false, sessionState: null }), NOW)).toBe('dead');
  });

  it('fresh tool call → speaking (really working right now)', () => {
    const last = NOW - VERDICT_SPEAKING_FRESH_MS + 1_000;
    expect(deriveMemberVerdict(verdictInput({ lastToolCallAtMs: last }), NOW)).toBe('speaking');
  });

  it('speaking OUTRANKS a stalled claim: a live member with one stuck ITEM is a re-steer, not a relaunch', () => {
    const last = NOW - 60_000;
    expect(deriveMemberVerdict(verdictInput({ stalled: true, load: 2, lastToolCallAtMs: last }), NOW)).toBe(
      'speaking',
    );
  });

  it('holding work + quiet past the stall window → stalled (the member-level wedge)', () => {
    const last = NOW - VERDICT_STALL_MS - 60_000;
    expect(deriveMemberVerdict(verdictInput({ load: 1, lastToolCallAtMs: last }), NOW)).toBe('stalled');
  });

  it('per-claim stall rollup (not speaking) → stalled even when idle-loaded recently', () => {
    const last = NOW - VERDICT_SPEAKING_FRESH_MS - 60_000;
    expect(deriveMemberVerdict(verdictInput({ stalled: true, lastToolCallAtMs: last }), NOW)).toBe('stalled');
  });

  it('worked before, quiet now, holding nothing → first-turn-done (between wakes / drained)', () => {
    const last = NOW - VERDICT_STALL_MS - 60_000;
    expect(deriveMemberVerdict(verdictInput({ load: 0, lastToolCallAtMs: last }), NOW)).toBe('first-turn-done');
  });

  it('present but ZERO tool calls ever → joined (a join event is NOT liveness)', () => {
    expect(deriveMemberVerdict(verdictInput({ lastToolCallAtMs: null }), NOW)).toBe('joined');
  });

  it('claims at boot with no tool call yet is joined, NOT stalled (never wedge-flag a boot window)', () => {
    expect(deriveMemberVerdict(verdictInput({ load: 3, lastToolCallAtMs: null }), NOW)).toBe('joined');
  });

  it('recorded-live but not coord-registered → booted (the pre-join bootstrap gap)', () => {
    expect(
      deriveMemberVerdict(verdictInput({ sessionState: 'recorded' as SessionState, lastToolCallAtMs: null }), NOW),
    ).toBe('booted');
    expect(deriveMemberVerdict(verdictInput({ present: false, sessionState: null }), NOW)).toBe('booted');
  });
});

describe('decorateMemberVerdicts (EI-8995)', () => {
  function memberAgent(overrides: Partial<AgentAssignment> = {}): AgentAssignment & {
    sessionState?: SessionState | null;
    verdict?: MemberVerdict;
    wakeMode?: WakeMode;
    lastToolCallAt?: string | null;
  } {
    return {
      agentId: 'su-member-1',
      label: null,
      name: null,
      present: true,
      alive: true,
      heartbeatAt: new Date(NOW).toISOString(),
      intent: '',
      declaredPlanSlug: null,
      fleetSlug: 'f-1',
      fleetRole: 'member',
      claims: [],
      orphaned: false,
      stalled: false,
      declaredUnclaimed: false,
      doing: null,
      queued: [],
      load: 0,
      sessionState: 'live',
      ...overrides,
    };
  }

  it('stamps verdict + lastToolCallAt from the batch fetch, wakeMode from override ?? default', async () => {
    const lastIso = new Date(NOW - 30_000).toISOString();
    const [speaking, manual] = await decorateMemberVerdicts(
      [memberAgent(), memberAgent({ agentId: 'su-member-2' })],
      async () => new Map([['su-member-1', lastIso]]),
      async () => new Map<string, WakeMode>([['su-member-2', 'manual']]),
      async () => 'auto',
      NOW,
    );
    expect(speaking.verdict).toBe('speaking');
    expect(speaking.lastToolCallAt).toBe(lastIso);
    expect(speaking.wakeMode).toBe('auto'); // no override → the global default
    expect(manual.verdict).toBe('joined'); // no tool call ever
    expect(manual.lastToolCallAt).toBeNull();
    expect(manual.wakeMode).toBe('manual'); // per-agent override wins
  });

  it('a manual GLOBAL default stamps manual on members with no override — the silently-staged-wakes read', async () => {
    const [out] = await decorateMemberVerdicts(
      [memberAgent()],
      async () => new Map(),
      async () => new Map<string, WakeMode>(),
      async () => 'manual',
      NOW,
    );
    expect(out.wakeMode).toBe('manual');
  });

  it('empty input is a no-op (never calls any fetcher)', async () => {
    let called = 0;
    const out = await decorateMemberVerdicts(
      [],
      async () => ((called += 1), new Map()),
      async () => ((called += 1), new Map()),
      async () => ((called += 1), 'auto' as WakeMode),
    );
    expect(out).toEqual([]);
    expect(called).toBe(0);
  });
});

describe('decorateParkedOn — P-001 fleet-member-dx (EI-9014)', () => {
  it('stamps parkedOn from active non-inbox-wake awaits (injected fetcher)', async () => {
    const agents = [baseAgent({ agentId: 'a1' }), baseAgent({ agentId: 'a2' })];
    await decorateParkedOn(agents, async () => [
      { subscriberId: 'a1', eventKey: 'p2p-git:phase3-open' },
    ]);
    expect((agents[0] as { parkedOn?: string[] }).parkedOn).toEqual(['p2p-git:phase3-open']);
    expect((agents[1] as { parkedOn?: string[] }).parkedOn).toBeUndefined();
  });

  it('dedupes repeated keys and caps at 6 per agent', async () => {
    const agents = [baseAgent({ agentId: 'a1' })];
    const rows = [
      { subscriberId: 'a1', eventKey: 'k1' },
      { subscriberId: 'a1', eventKey: 'k1' }, // dupe
      ...Array.from({ length: 10 }, (_, i) => ({ subscriberId: 'a1', eventKey: `k${i + 2}` })),
    ];
    await decorateParkedOn(agents, async () => rows);
    const parked = (agents[0] as { parkedOn?: string[] }).parkedOn ?? [];
    expect(parked[0]).toBe('k1');
    expect(new Set(parked).size).toBe(parked.length); // no dupes
    expect(parked.length).toBeLessThanOrEqual(6);
  });

  it('empty agent list is a no-op that never calls the fetcher', async () => {
    let called = false;
    await decorateParkedOn([], async () => {
      called = true;
      return [];
    });
    expect(called).toBe(false);
  });

  it('no parked rows leaves every row unstamped', async () => {
    const agents = [baseAgent({ agentId: 'a1' })];
    await decorateParkedOn(agents, async () => []);
    expect((agents[0] as { parkedOn?: string[] }).parkedOn).toBeUndefined();
  });
});

describe('shapeFleetAssignments carries parkedOn at every tier (P-001 fleet-member-dx)', () => {
  const data = {
    ok: true,
    summary: { agents: 2 },
    orphaned: [],
    stalled: [],
    agents: [
      { agentId: 'a1', parkedOn: ['p2p-git:phase3-open'], claims: [], queued: [] },
      { agentId: 'a2', claims: [], queued: [] },
    ],
  };

  it('trimmed tier keeps parkedOn on parked rows and omits it elsewhere', () => {
    const shaped = shapeFleetAssignments(data, 'trimmed') as {
      agents: Array<Record<string, unknown>>;
    };
    expect(shaped.agents[0].parkedOn).toEqual(['p2p-git:phase3-open']);
    expect('parkedOn' in shaped.agents[1]).toBe(false);
  });

  it('standard tier keeps it too', () => {
    const shaped = shapeFleetAssignments(data, 'standard') as {
      agents: Array<Record<string, unknown>>;
    };
    expect(shaped.agents[0].parkedOn).toEqual(['p2p-git:phase3-open']);
  });
});
