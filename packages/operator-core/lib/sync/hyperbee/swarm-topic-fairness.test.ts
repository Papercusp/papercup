/**
 * WI-6063 — per-topic connection fairness on the shared swarm.
 *
 * The bug being fixed is SILENT: Hyperswarm stops connecting at `maxPeers`
 * without an error or an event, so a topic that has been starved of its share of
 * the budget looks exactly like a topic with no peers available. A fairness bound
 * that is itself wrong fails the SAME silent way. So these tests assert the two
 * safety properties directly rather than trusting the mechanism:
 *
 *   1. it does NOTHING until the budget is genuinely under pressure, and
 *   2. it never throttles a topic that is at or below its share.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Corestore from 'corestore';
import {
  computeFairShare,
  joinHarnessSwarm,
  evaluateSwarmFairness,
  FAIRNESS_ENGAGE_RATIO,
  MIN_PEERS_PER_TOPIC,
  reportPeerCapPressure,
  resolveMaxClientConnections,
  swarmConstructorOpts,
  swarmFairnessSnapshot,
  _registerTopicFairnessForTests,
  _resetSwarmFairnessForTests,
  type HyperswarmLike,
  type SwarmHandle,
  type TopicDialThrottleInfo,
} from './swarm';
import type { SwarmGuard } from './swarm-guard';

/** A swarm fake with a settable live-connection count and a fixed ceiling. */
function fakeSwarm(maxPeers: number | undefined) {
  const connections = new Set<unknown>();
  const swarm = { connections, maxPeers } as unknown as HyperswarmLike;
  return {
    swarm,
    setLive(n: number) {
      connections.clear();
      for (let i = 0; i < n; i++) connections.add({ i });
    },
  };
}

/** A discovery-session fake that records every `refresh()` it is handed. */
function fakeSession() {
  const calls: Array<{ client?: boolean; server?: boolean }> = [];
  return {
    calls,
    session: {
      refresh(opts?: object) {
        calls.push((opts ?? {}) as { client?: boolean; server?: boolean });
        return Promise.resolve();
      },
    },
  };
}

/**
 * Register `topics` on `swarm` with the given live peer counts, and return an
 * evaluator bound to those counts (so the policy is exercised without real
 * announce channels) plus the per-topic refresh call log.
 */
function harness(swarm: HyperswarmLike, peers: Record<string, number>) {
  const sessions: Record<string, ReturnType<typeof fakeSession>> = {};
  const throttles: TopicDialThrottleInfo[] = [];
  const releases: Array<() => void> = [];
  for (const topicHex of Object.keys(peers)) {
    const s = fakeSession();
    sessions[topicHex] = s;
    releases.push(
      _registerTopicFairnessForTests(swarm, {
        topicHex,
        session: () => s.session,
        onThrottle: (info) => throttles.push(info),
      }),
    );
  }
  return {
    sessions,
    throttles,
    releases,
    counts: peers,
    evaluate: () => evaluateSwarmFairness(swarm, (t) => peers[t] ?? 0),
    snapshot: () => swarmFairnessSnapshot(swarm, (t) => peers[t] ?? 0),
  };
}

describe('computeFairShare', () => {
  it('splits the ceiling evenly across the joined topics', () => {
    expect(computeFairShare(256, 4)).toBe(64);
    expect(computeFairShare(100, 3)).toBe(33); // floored
  });

  it('never returns less than the per-topic floor, however many topics share the swarm', () => {
    // 256 peers across 100 topics is 2 each — a "fair" share that would itself
    // starve every topic. The floor is what stops the fix becoming the bug.
    expect(computeFairShare(256, 100)).toBe(MIN_PEERS_PER_TOPIC);
    expect(computeFairShare(8, 64)).toBe(MIN_PEERS_PER_TOPIC);
  });
});

describe('resolveMaxClientConnections — the inbound reserve', () => {
  const prev = process.env.PAPERCUSP_SWARM_INBOUND_RESERVE;
  afterEach(() => {
    if (prev === undefined) delete process.env.PAPERCUSP_SWARM_INBOUND_RESERVE;
    else process.env.PAPERCUSP_SWARM_INBOUND_RESERVE = prev;
  });

  it('reserves an eighth of the budget for inbound peers at the 256 floor', () => {
    delete process.env.PAPERCUSP_SWARM_INBOUND_RESERVE;
    expect(resolveMaxClientConnections(256)).toBe(224); // 256 - 32
  });

  it('clamps the reserve so it neither vanishes nor dominates', () => {
    delete process.env.PAPERCUSP_SWARM_INBOUND_RESERVE;
    expect(resolveMaxClientConnections(16)).toBe(8); // floor of 8 reserved
    expect(resolveMaxClientConnections(4096)).toBe(4032); // capped at 64 reserved
  });

  it('honours an explicit override, including 0 to disable the reserve', () => {
    process.env.PAPERCUSP_SWARM_INBOUND_RESERVE = '0';
    expect(resolveMaxClientConnections(256)).toBe(256);
    process.env.PAPERCUSP_SWARM_INBOUND_RESERVE = '100';
    expect(resolveMaxClientConnections(256)).toBe(156);
  });

  it('never returns 0 — a node that can never dial is indistinguishable from a broken swarm', () => {
    process.env.PAPERCUSP_SWARM_INBOUND_RESERVE = '9999';
    expect(resolveMaxClientConnections(16)).toBe(1);
  });

  it('is wired into the real constructor options', () => {
    delete process.env.PAPERCUSP_SWARM_INBOUND_RESERVE;
    const opts = swarmConstructorOpts({ defaultMaxPeers: 256 });
    expect(opts.maxPeers).toBe(256);
    expect(opts.maxClientConnections).toBe(224);
  });
});

describe('evaluateSwarmFairness', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy?.mockRestore();
    infoSpy?.mockRestore();
  });

  it('is a COMPLETE no-op below the engage ratio, however lopsided the topics are', () => {
    // The safety property: with budget to spare there is no scarcity to
    // arbitrate, so even a wildly dominant topic must be left alone. If this
    // test ever fails, the fix is throttling healthy swarms.
    const { swarm, setLive } = fakeSwarm(100);
    _resetSwarmFairnessForTests(swarm);
    setLive(10); // 10% — far below the 85% engage ratio
    const h = harness(swarm, { aaaa: 90, bbbb: 0 });
    const shares = h.evaluate();
    expect(h.sessions.aaaa.calls).toEqual([]); // never touched
    expect(shares.every((s) => s.dialPaused === false)).toBe(true);
    expect(shares.every((s) => s.fairShare === null)).toBe(true);
    expect(h.throttles).toEqual([]);
  });

  it('pauses a topic that is OVER its share once the budget is under pressure', () => {
    const { swarm, setLive } = fakeSwarm(100);
    _resetSwarmFairnessForTests(swarm);
    setLive(Math.ceil(100 * FAIRNESS_ENGAGE_RATIO)); // exactly at the engage point
    // fair share = max(8, floor(100/2)) = 50
    const h = harness(swarm, { aaaa: 80, bbbb: 5 });
    const shares = h.evaluate();

    const hog = shares.find((s) => s.topicHex === 'aaaa');
    const starved = shares.find((s) => s.topicHex === 'bbbb');
    expect(hog?.fairShare).toBe(50);
    expect(hog?.dialPaused).toBe(true);
    // The starved topic must be left dialling — that is the whole point.
    expect(starved?.dialPaused).toBe(false);
    expect(h.sessions.bbbb.calls).toEqual([]);
  });

  it('keeps the topic ANNOUNCING when it pauses dialling (server side never dropped)', () => {
    // A paused topic must still be findable/dialable BY peers. Turning both
    // sides off would also throw upstream ("Cannot refresh with neither client
    // nor server option") — so this asserts both the intent and the contract.
    const { swarm, setLive } = fakeSwarm(100);
    _resetSwarmFairnessForTests(swarm);
    setLive(90);
    const h = harness(swarm, { aaaa: 80, bbbb: 5 });
    h.evaluate();
    expect(h.sessions.aaaa.calls).toEqual([{ client: false, server: true }]);
    for (const call of h.sessions.aaaa.calls) {
      expect(call.client === false && call.server === false).toBe(false);
    }
  });

  it('does NOT pause a topic sitting exactly AT its share (the marginal-topic off-by-one)', () => {
    const { swarm, setLive } = fakeSwarm(100);
    _resetSwarmFairnessForTests(swarm);
    setLive(90);
    const h = harness(swarm, { aaaa: 50, bbbb: 50 }); // share = 50 exactly
    const shares = h.evaluate();
    expect(shares.every((s) => s.dialPaused === false)).toBe(true);
    expect(h.sessions.aaaa.calls).toEqual([]);
    expect(h.sessions.bbbb.calls).toEqual([]);
  });

  it('never throttles when only ONE topic is on the swarm', () => {
    const { swarm, setLive } = fakeSwarm(100);
    _resetSwarmFairnessForTests(swarm);
    setLive(100); // fully at cap
    const h = harness(swarm, { aaaa: 100 });
    const shares = h.evaluate();
    expect(shares[0]?.dialPaused).toBe(false);
    expect(h.sessions.aaaa.calls).toEqual([]);
  });

  it('RESUMES a paused topic once pressure lifts — without needing a connection event', () => {
    // The load-bearing anti-starvation property. At the cap no `connection`
    // events fire at all, so resume can only come from the level-based tick. A
    // regression here re-creates the original bug with extra steps: a topic
    // throttled by a transient spike and never released.
    const { swarm, setLive } = fakeSwarm(100);
    _resetSwarmFairnessForTests(swarm);
    setLive(95);
    const h = harness(swarm, { aaaa: 80, bbbb: 5 });
    h.evaluate();
    expect(h.snapshot().find((s) => s.topicHex === 'aaaa')?.dialPaused).toBe(true);

    setLive(20); // pressure lifts; NO new connection events are delivered
    h.evaluate();
    expect(h.snapshot().find((s) => s.topicHex === 'aaaa')?.dialPaused).toBe(false);
    expect(h.sessions.aaaa.calls).toEqual([
      { client: false, server: true },
      { client: true, server: true },
    ]);
  });

  it('fires the throttle callback on TRANSITIONS only, not once per evaluation', () => {
    const { swarm, setLive } = fakeSwarm(100);
    _resetSwarmFairnessForTests(swarm);
    setLive(95);
    const h = harness(swarm, { aaaa: 80, bbbb: 5 });
    h.evaluate();
    h.evaluate();
    h.evaluate(); // still over share — must not re-fire
    expect(h.throttles).toHaveLength(1);
    expect(h.throttles[0]).toMatchObject({
      topicHex: 'aaaa',
      paused: true,
      peers: 80,
      fairShare: 50,
      topicCount: 2,
    });

    setLive(10);
    h.evaluate();
    h.evaluate();
    expect(h.throttles).toHaveLength(2);
    expect(h.throttles[1]).toMatchObject({ topicHex: 'aaaa', paused: false });
    // And the session was toggled exactly twice, not once per tick.
    expect(h.sessions.aaaa.calls).toHaveLength(2);
  });

  it('does nothing when the ceiling is unknowable (a minimal fake / older build)', () => {
    const { swarm, setLive } = fakeSwarm(undefined);
    _resetSwarmFairnessForTests(swarm);
    setLive(10_000);
    const h = harness(swarm, { aaaa: 9000, bbbb: 1 });
    const shares = h.evaluate();
    expect(shares.every((s) => s.dialPaused === false)).toBe(true);
    expect(h.sessions.aaaa.calls).toEqual([]);
  });

  it('releasing a PAUSED topic resumes its dialling before deregistering it', () => {
    // A close-while-throttled must not leave the shared discovery session
    // latched client-off for a sibling harness on the same topic.
    const { swarm, setLive } = fakeSwarm(100);
    _resetSwarmFairnessForTests(swarm);
    setLive(95);
    const h = harness(swarm, { aaaa: 80, bbbb: 5 });
    h.evaluate();
    expect(h.sessions.aaaa.calls).toEqual([{ client: false, server: true }]);

    h.releases[0]?.(); // release 'aaaa'
    expect(h.sessions.aaaa.calls).toEqual([
      { client: false, server: true },
      { client: true, server: true },
    ]);
    expect(h.snapshot().some((s) => s.topicHex === 'aaaa')).toBe(false);
  });

  it('tolerates a session that cannot refresh, and retries it on the next tick', () => {
    // A minimal/unavailable session must not latch: if the toggle could not be
    // applied, the entry stays unpaused so the next tick tries again — silently
    // recording "paused" for a topic that is still dialling would make the
    // observability lie, which is worse than not throttling at all.
    const { swarm, setLive } = fakeSwarm(100);
    _resetSwarmFairnessForTests(swarm);
    setLive(95);
    let broken = true;
    const throttles: TopicDialThrottleInfo[] = [];
    const calls: Array<{ client?: boolean; server?: boolean }> = [];
    _registerTopicFairnessForTests(swarm, {
      topicHex: 'aaaa',
      session: () =>
        broken
          ? undefined
          : {
              refresh(opts?: object) {
                calls.push((opts ?? {}) as { client?: boolean });
                return Promise.resolve();
              },
            },
      onThrottle: (i) => throttles.push(i),
    });
    _registerTopicFairnessForTests(swarm, { topicHex: 'bbbb', session: () => ({}) });
    const counts: Record<string, number> = { aaaa: 80, bbbb: 5 };

    evaluateSwarmFairness(swarm, (t) => counts[t] ?? 0);
    expect(swarmFairnessSnapshot(swarm, (t) => counts[t] ?? 0)[0]?.dialPaused).toBe(false);
    expect(throttles).toEqual([]);

    broken = false;
    evaluateSwarmFairness(swarm, (t) => counts[t] ?? 0);
    expect(calls).toEqual([{ client: false, server: true }]);
    expect(throttles).toHaveLength(1);
  });
});

describe('reportPeerCapPressure — WI-6063 per-topic breakdown', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy?.mockRestore();
  });

  it('names WHICH topics hold the budget, so the cap signal carries a diagnosis', () => {
    const { swarm, setLive } = fakeSwarm(10);
    _resetSwarmFairnessForTests(swarm);
    _registerTopicFairnessForTests(swarm, { topicHex: 'aaaaaaaabbbb', session: () => ({}) });
    _registerTopicFairnessForTests(swarm, { topicHex: 'ccccccccdddd', session: () => ({}) });
    setLive(10);
    const info = reportPeerCapPressure(swarm);
    expect(info?.atCap).toBe(true);
    expect(info?.topics?.map((t) => t.topicHex).sort()).toEqual([
      'aaaaaaaabbbb',
      'ccccccccdddd',
    ]);
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/Per-topic: /);
  });

  it('omits the breakdown entirely when no topic is registered (unchanged legacy shape)', () => {
    const { swarm, setLive } = fakeSwarm(10);
    _resetSwarmFairnessForTests(swarm);
    setLive(10);
    const info = reportPeerCapPressure(swarm);
    // Exact shape: existing consumers assert this object with toEqual.
    expect(info).toEqual({ liveConnections: 10, maxPeers: 10, atCap: true });
  });
});

/**
 * The tests above drive the policy through `_registerTopicFairnessForTests`, so
 * they would ALL still pass if `joinHarnessSwarm` never registered a topic and
 * the shared refresh tick never called the evaluator — i.e. if the feature were
 * completely unwired. These pin the wiring itself against the REAL join path.
 */
describe('joinHarnessSwarm — fairness wiring (not the policy)', () => {
  const ALLOW_GUARD: SwarmGuard = {
    firewall: () => false,
    isBannedKey: () => false,
    isBannedIp: () => false,
    banKey: () => {},
    banIp: () => {},
    recordConnection: async () => ({ allow: true }),
  };
  const STORE = { replicate: () => {} } as unknown as Corestore;
  const TOPIC_A = Buffer.alloc(32, 1);
  const TOPIC_B = Buffer.alloc(32, 2);

  const handles: SwarmHandle[] = [];
  // The pause path deliberately console.warn()s (a real pressure signal), which
  // the repo's fail-on-console gate treats as a defect unless asserted — so the
  // wiring tests, which DO drive a pause, must mock it out explicitly.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(async () => {
    while (handles.length) {
      try {
        await handles.pop()!.close();
      } catch {
        /* best-effort */
      }
    }
    warnSpy?.mockRestore();
    infoSpy?.mockRestore();
    vi.useRealTimers();
  });

  /** A swarm fake with a real ceiling + settable load, recording refresh args. */
  function makeSwarm(maxPeers: number) {
    const refreshes: Array<{ topic: string; opts: { client?: boolean; server?: boolean } }> = [];
    const connections = new Set<unknown>();
    const swarm: HyperswarmLike = {
      join: (topic: Buffer) => {
        const hex = topic.toString('hex');
        return {
          flushed: async () => {},
          refresh: (opts?: object) => {
            refreshes.push({ topic: hex, opts: (opts ?? {}) as { client?: boolean } });
          },
        };
      },
      leave: () => {},
      on: () => {},
      off: () => {},
      connections,
      maxPeers,
    };
    return {
      swarm,
      refreshes,
      setLive(n: number) {
        connections.clear();
        for (let i = 0; i < n; i++) connections.add({ i });
      },
    };
  }

  it('registers the topic in the fairness registry, and close() deregisters it', async () => {
    vi.useFakeTimers();
    const f = makeSwarm(100);
    _resetSwarmFairnessForTests(f.swarm);
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC_A,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 10_000,
      slowRefreshMs: 10_000,
    });
    expect(swarmFairnessSnapshot(f.swarm).map((s) => s.topicHex)).toEqual([
      TOPIC_A.toString('hex'),
    ]);
    await handle.close();
    expect(swarmFairnessSnapshot(f.swarm)).toEqual([]);
  });

  it('the SHARED refresh tick runs the evaluator (no separate timer, and it is really called)', async () => {
    vi.useFakeTimers();
    const f = makeSwarm(100);
    _resetSwarmFairnessForTests(f.swarm);
    for (const topic of [TOPIC_A, TOPIC_B]) {
      handles.push(
        await joinHarnessSwarm({
          store: STORE,
          topic,
          swarm: f.swarm,
          guard: ALLOW_GUARD,
          refreshMs: 50,
          fastWindowMs: 10_000,
          slowRefreshMs: 10_000,
        }),
      );
    }
    const hexA = TOPIC_A.toString('hex');
    f.setLive(95); // engage fairness

    // Force TOPIC_A into the paused state with an injected count, then let the
    // REAL tick run. The tick evaluates with the production peer-count reader,
    // under which A holds 0 peers — so a tick that genuinely calls the evaluator
    // must RESUME it. If the evaluator were not wired to the tick, A would stay
    // paused and no `client:true` refresh would ever be recorded.
    evaluateSwarmFairness(f.swarm, (t) => (t === hexA ? 80 : 1));
    expect(swarmFairnessSnapshot(f.swarm).find((s) => s.topicHex === hexA)?.dialPaused).toBe(true);
    const pausedCalls = f.refreshes.filter(
      (r) => r.topic === hexA && r.opts.client === false,
    ).length;
    expect(pausedCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(120);

    expect(swarmFairnessSnapshot(f.swarm).find((s) => s.topicHex === hexA)?.dialPaused).toBe(false);
    expect(
      f.refreshes.some((r) => r.topic === hexA && r.opts.client === true && r.opts.server === true),
    ).toBe(true);
  });
});
