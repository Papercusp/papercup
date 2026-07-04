/**
 * Handler-level tests for the three Hive self-declared-wake tools
 * (autoloop-hive-operator-rebuild-2026-06-05 P0, D-002): hive:declare-wake,
 * hive:wake, hive:status. The wake CORE fns (clamp/debounce/subscription
 * projection) are unit-covered in ../../hive/wake.test.ts and round-tripped
 * against real PG in ../../hive/hive-wake-pg.integration.test.ts; THIS file pins
 * the tool-handler ORCHESTRATION the dispatcher runs — slug resolution + the
 * no_home_harness guard, the time/event/none `mode` computation, the
 * fire-vs-floor-skip branch, and the read-only status assembly.
 *
 * The PG-touching hive fns + the blueprint launch are mocked at their module
 * seams; the pure floor/slug helpers (hiveWakeFloorSec / resolveHiveHomeSlug /
 * withinWakeFloor) run REAL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── module-seam mocks (arrow-deref so the hoisted vi.mock factory sees them) ──
const declareHiveTimeWake = vi.fn(async (_sql: unknown, opts: { at: Date; clamped?: boolean }) => ({
  at: opts.at,
  clamped: false,
}));
const clearHiveTimeWake = vi.fn(async () => {});
const setHiveEventSubscriptions = vi.fn(async (_ws: string, subs: unknown[]) => subs.length);
const setHiveCarryNote = vi.fn(async (_ws: string, note: string | null | undefined) => {
  const t = (note ?? '').trim();
  return t.length > 0 ? t : null;
});
const readHiveWakeState = vi.fn<() => Promise<Record<string, unknown>>>();
const recordHiveWake = vi.fn(async () => {});
const claimHiveWakeFire = vi.fn(async () => ({ fired: true, floorSec: 60 }));
const getHiveTimeWake =
  vi.fn<() => Promise<{ active: boolean; nextFireAt: Date | null; lastFiredAt: Date | null } | null>>();
const fireLaunchBlueprint = vi.fn(async () => ({ role: 'operator', kind: 'role' as const }));
const listReactionRules = vi.fn<() => Array<{ id: string }>>(() => []);
const queenWakeEfficiency = vi.fn<() => Promise<Record<string, unknown>>>();

vi.mock('../../hive/wake', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../hive/wake')>();
  return {
    ...real, // keep HIVE_BLUEPRINT_ID + the PURE helpers real
    declareHiveTimeWake: (...a: unknown[]) => declareHiveTimeWake(...(a as [unknown, { at: Date }])),
    clearHiveTimeWake: (...a: unknown[]) => clearHiveTimeWake(...(a as [])),
    setHiveEventSubscriptions: (...a: unknown[]) => setHiveEventSubscriptions(...(a as [string, unknown[]])),
    setHiveCarryNote: (...a: unknown[]) => setHiveCarryNote(...(a as [string, string | null | undefined])),
    readHiveWakeState: (...a: unknown[]) => readHiveWakeState(...(a as [])),
    recordHiveWake: (...a: unknown[]) => recordHiveWake(...(a as [])),
    claimHiveWakeFire: (...a: unknown[]) => claimHiveWakeFire(...(a as [string, { floorSec: number; force?: boolean }])),
    getHiveTimeWake: (...a: unknown[]) => getHiveTimeWake(...(a as [])),
  };
});
vi.mock('../../blueprint/launch-blueprint', () => ({
  fireLaunchBlueprint: (...a: Parameters<typeof fireLaunchBlueprint>) => fireLaunchBlueprint(...a),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../events/registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listReactionRules: () => listReactionRules(),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: {} }),
}));
// EI-309 frontier guard reads the home-harness frontier via this query; default
// to an EMPTY frontier so the declaration-mechanics tests allow no-time wakes.
// evaluateWakeFrontierGuard stays REAL — a test that returns a non-empty frontier
// exercises the genuine refusal. (arrow-deref so the hoisted factory sees it.)
const listUnplacedHiveFrontier = vi.fn(async () => [] as string[]);
vi.mock('../../hive/wake-frontier-guard', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listUnplacedHiveFrontier: (...a: unknown[]) => listUnplacedHiveFrontier(...(a as [])),
}));
// start-hive-wake P-004/P-012: hive:status also reads the started bit + the
// watchdog fire signal — both PG-backed, mocked at their module seams here.
// WI-2012: hive:declare-wake refuses (hive_paused) and hive:wake skips event fires while the
// queen loop is not started — so the declaration/wake MECHANICS tests here run against a
// STARTED hive. The paused-gate behavior has its own dedicated suite (wake-paused-gate.test.ts).
const getHiveStarted = vi.fn(async () => true);
const recentWatchdogFires = vi.fn(async () => 0);
vi.mock('../../hive/started', () => ({
  getHiveStarted: (...a: unknown[]) => getHiveStarted(...(a as [])),
}));
vi.mock('../../hive/watchdog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recentWatchdogFires: (...a: unknown[]) => recentWatchdogFires(...(a as [])),
}));
// B-06 / P-010: hive:queen_efficiency projects queenWakeEfficiency — mock the aggregator at its seam
// (its PG read + aggregation are covered in ../../hive/queen-wake-efficiency.test.ts).
vi.mock('../../hive/queen-wake-efficiency', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queenWakeEfficiency: (...a: unknown[]) => queenWakeEfficiency(...(a as [])),
}));

// SUTs imported AFTER the seams are wired (each self-registers via defineTool).
import declareWakeTool from './declare_wake';
import wakeTool from './wake';
import statusTool from './status';
import queenEfficiencyTool from './queen_efficiency';

type Tool = {
  args: { safeParse: (x: unknown) => { success: boolean } };
  handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
};
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(r.content[0].text);
const ctx = (over: Record<string, unknown> = {}): never => over as never;
const ENV = ['PAPERCUSP_POT_WAKE_FLOOR_SEC', 'PAPERCUSP_HIVE_HOME_SLUG'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k]; // floor → 60s default; no env home-slug fallback
  }
  // sensible defaults; tests override per-case
  declareHiveTimeWake.mockImplementation(async (_sql, opts) => ({ at: opts.at, clamped: false }));
  setHiveEventSubscriptions.mockImplementation(async (_ws, subs) => subs.length);
  readHiveWakeState.mockResolvedValue({ subscriptions: [] });
  getHiveTimeWake.mockResolvedValue(null);
  listReactionRules.mockReturnValue([]);
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('hive:declare-wake', () => {
  const tool = declareWakeTool as unknown as Tool;

  it('no resolvable home harness → ok:false no_home_harness, nothing touched', async () => {
    const res = parse(await tool.handler({ events: [{ on: 'coord:escalate' }] }, ctx()));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no_home_harness');
    expect(declareHiveTimeWake).not.toHaveBeenCalled();
    expect(clearHiveTimeWake).not.toHaveBeenCalled();
    expect(setHiveEventSubscriptions).not.toHaveBeenCalled();
  });

  it("time wake (`at`): declares the one-shot, clears events, mode:'time'", async () => {
    const at = '2026-07-01T00:00:00.000Z';
    const res = parse(await tool.handler({ at, harness: 'papercup' }, ctx()));
    expect(res.ok).toBe(true);
    // canonicalHarnessSlug maps 'papercup' → 'papercusp' (rename-compat shim EI-2224)
    expect(res.harness).toBe('papercusp');
    expect(res.mode).toBe('time');
    expect(res.time).toEqual({ at, clamped: false });
    expect(res.eventRules).toBe(0);
    expect(res.floorSec).toBe(60);
    expect(declareHiveTimeWake).toHaveBeenCalledTimes(1);
    expect(clearHiveTimeWake).not.toHaveBeenCalled();
    // events omitted ⇒ cleared (REPLACE semantics) via an empty-set declare
    expect(setHiveEventSubscriptions).toHaveBeenCalledWith('ws-test', []);
  });

  it('time wake (`inSeconds`): requests ≈ now + N seconds', async () => {
    const before = Date.now();
    const res = parse(await tool.handler({ inSeconds: 600, harness: 'papercup' }, ctx()));
    expect(res.mode).toBe('time');
    expect(declareHiveTimeWake).toHaveBeenCalledTimes(1);
    const opts = declareHiveTimeWake.mock.calls[0][1] as { at: Date };
    const delta = opts.at.getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(600_000 - 50);
    expect(delta).toBeLessThanOrEqual(600_000 + 2_000);
  });

  it("event wake only: clears the time wake, persists subs, mode:'event'", async () => {
    const res = parse(
      await tool.handler(
        { events: [{ on: 'coord:escalate', note: 'watch escalations' }], harness: 'papercup' },
        ctx(),
      ),
    );
    expect(res.mode).toBe('event');
    expect(res.eventRules).toBe(1);
    expect(res.time).toBeNull();
    expect(clearHiveTimeWake).toHaveBeenCalledTimes(1);
    expect(declareHiveTimeWake).not.toHaveBeenCalled();
    expect(setHiveEventSubscriptions).toHaveBeenCalledWith('ws-test', [
      { on: 'coord:escalate', when: undefined, note: 'watch escalations' },
    ]);
  });

  it("time + event together → mode:'time+event'", async () => {
    const res = parse(
      await tool.handler(
        { inSeconds: 300, events: [{ on: 'work_items:complete' }], harness: 'papercup' },
        ctx(),
      ),
    );
    expect(res.mode).toBe('time+event');
    expect(res.eventRules).toBe(1);
    expect(declareHiveTimeWake).toHaveBeenCalledTimes(1);
  });

  it("mode:'none' → clears both, mode:'none'", async () => {
    const res = parse(await tool.handler({ mode: 'none', harness: 'papercup' }, ctx()));
    expect(res.mode).toBe('none');
    expect(res.time).toBeNull();
    expect(res.eventRules).toBe(0);
    expect(clearHiveTimeWake).toHaveBeenCalledTimes(1);
    expect(setHiveEventSubscriptions).toHaveBeenCalledWith('ws-test', []);
  });

  it('EI-309 guard: REFUSES an event-only wake while the home harness has unplaced work (frontier_not_empty)', async () => {
    listUnplacedHiveFrontier.mockResolvedValueOnce(['WI-116', 'WI-117']);
    const res = parse(
      await tool.handler({ events: [{ on: 'work_items:create' }], harness: 'papercup' }, ctx()),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('frontier_not_empty');
    expect(res.frontier).toEqual(['WI-116', 'WI-117']);
    // Refused BEFORE any mutation — the declaration did not partially apply.
    expect(setHiveEventSubscriptions).not.toHaveBeenCalled();
    expect(clearHiveTimeWake).not.toHaveBeenCalled();
  });

  it('EI-309 guard: REFUSES a mode:none wake with an unplaced frontier too', async () => {
    listUnplacedHiveFrontier.mockResolvedValueOnce(['WI-116']);
    const res = parse(await tool.handler({ mode: 'none', harness: 'papercup' }, ctx()));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('frontier_not_empty');
  });

  it('EI-309 guard: force:true OVERRIDES — the event-only declaration applies despite the frontier', async () => {
    listUnplacedHiveFrontier.mockResolvedValueOnce(['WI-116']);
    const res = parse(
      await tool.handler({ events: [{ on: 'work_items:create' }], harness: 'papercup', force: true }, ctx()),
    );
    expect(res.mode).toBe('event');
    expect(res.eventRules).toBe(1);
    expect(setHiveEventSubscriptions).toHaveBeenCalled();
  });

  it('EI-309 guard: a TIME wake is allowed even with an unplaced frontier (a timer re-wakes to place)', async () => {
    listUnplacedHiveFrontier.mockResolvedValueOnce(['WI-116']); // would refuse if read, but a time wake skips the guard
    const res = parse(await tool.handler({ inSeconds: 300, harness: 'papercup' }, ctx()));
    expect(res.mode).toBe('time');
    expect(declareHiveTimeWake).toHaveBeenCalledTimes(1);
  });

  it('EI-309 KILL-SWITCH: flag OFF → an event-only wake is allowed despite an unplaced frontier (revert path)', async () => {
    const [{ setFlagOverridesForTest }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/test'),
      import('@papercusp/flags'),
    ]);
    listUnplacedHiveFrontier.mockResolvedValue(['WI-116', 'WI-117']); // a non-empty frontier
    setFlagOverridesForTest({ [FLAGS.HIVE_WAKE_FRONTIER_GUARD]: false });
    try {
      const res = parse(await tool.handler({ events: [{ on: 'work_items:create' }], harness: 'papercup' }, ctx()));
      expect(res.mode).toBe('event'); // guard disabled ⇒ the declaration applies
      expect(res.eventRules).toBe(1);
    } finally {
      setFlagOverridesForTest(null);
      listUnplacedHiveFrontier.mockResolvedValue([]);
    }
  });

  it('ignores ctx.harnessSlug and requires an explicit harness or PAPERCUSP_HIVE_HOME_SLUG', async () => {
    const res = parse(await tool.handler({ at: '2026-07-01T00:00:00.000Z' }, ctx({ harnessSlug: 'ctx-slug' })));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no_home_harness');
  });

  describe('arg-schema refine guards', () => {
    it('rejects `at` + `inSeconds` together', () => {
      expect(tool.args.safeParse({ at: '2026-07-01T00:00:00Z', inSeconds: 10 }).success).toBe(false);
    });
    it("rejects mode:'none' combined with a time/events", () => {
      expect(tool.args.safeParse({ mode: 'none', inSeconds: 10 }).success).toBe(false);
      expect(tool.args.safeParse({ mode: 'none', events: [{ on: 'coord:escalate' }] }).success).toBe(false);
    });
    it('accepts each valid single shape', () => {
      expect(tool.args.safeParse({ at: '2026-07-01T00:00:00Z' }).success).toBe(true);
      expect(tool.args.safeParse({ inSeconds: 10 }).success).toBe(true);
      expect(tool.args.safeParse({ events: [{ on: 'coord:escalate' }] }).success).toBe(true);
      expect(tool.args.safeParse({ mode: 'none' }).success).toBe(true);
    });
  });
});

describe('hive:wake', () => {
  const tool = wakeTool as unknown as Tool;

  it('no resolvable home harness → ok:false, no launch', async () => {
    const res = parse(await tool.handler({ reason: 'kick' }, ctx()));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no_home_harness');
    expect(fireLaunchBlueprint).not.toHaveBeenCalled();
  });

  it('outside the floor → claims the fire + launches the hive', async () => {
    claimHiveWakeFire.mockResolvedValue({ fired: true, floorSec: 60 });
    const res = parse(await tool.handler({ reason: 'prod fire', source: 'user', harness: 'papercup' }, ctx()));
    // canonicalHarnessSlug maps 'papercup' → 'papercusp' (rename-compat shim EI-2224)
    expect(res).toMatchObject({ ok: true, fired: true, role: 'operator', harness: 'papercusp' });
    expect(claimHiveWakeFire).toHaveBeenCalledWith('ws-test', { floorSec: 60, force: undefined });
    expect(fireLaunchBlueprint).toHaveBeenCalledTimes(1);
    const [bp, input] = fireLaunchBlueprint.mock.calls[0] as unknown as [
      string,
      { installSlug: string; workspaceId: string; kickoff: string },
    ];
    expect(bp).toBe('coding');
    expect(input.installSlug).toBe('papercusp'); // canonicalHarnessSlug maps 'papercup' → 'papercusp' (EI-2224)
    expect(input.workspaceId).toBe('ws-test');
    expect(input.kickoff).toContain('prod fire');
    expect(recordHiveWake).not.toHaveBeenCalled();
  });

  it('within the floor (no force) → skipped:wake-floor, no launch', async () => {
    claimHiveWakeFire.mockResolvedValue({
      fired: false,
      skipped: 'wake-floor',
      floorSec: 60,
      nextAllowedAt: '2026-06-05T12:01:00.000Z',
    });
    const res = parse(await tool.handler({ reason: 'too soon', harness: 'papercup' }, ctx()));
    expect(res).toMatchObject({ ok: true, fired: false, skipped: 'wake-floor', floorSec: 60 });
    expect(typeof res.nextAllowedAt).toBe('string');
    expect(fireLaunchBlueprint).not.toHaveBeenCalled();
    expect(recordHiveWake).not.toHaveBeenCalled();
  });

  it('within the floor + force:true → bypasses the debounce and fires', async () => {
    claimHiveWakeFire.mockResolvedValue({ fired: true, floorSec: 60 });
    const res = parse(await tool.handler({ reason: 'urgent', force: true, harness: 'papercup' }, ctx()));
    expect(res.fired).toBe(true);
    expect(claimHiveWakeFire).toHaveBeenCalledWith('ws-test', { floorSec: 60, force: true });
    expect(fireLaunchBlueprint).toHaveBeenCalledTimes(1);
  });
});

describe('hive:status', () => {
  const tool = statusTool as unknown as Tool;

  it('assembles the time wake, subscriptions, live rule ids, and floor', async () => {
    const nextFire = new Date('2026-07-01T00:00:00.000Z');
    getHiveTimeWake.mockResolvedValue({ active: true, nextFireAt: nextFire, lastFiredAt: null });
    const declaredAt = Date.parse('2026-06-08T00:00:00.000Z');
    const lastWakeAt = Date.parse('2026-06-08T00:30:00.000Z');
    readHiveWakeState.mockResolvedValue({
      subscriptions: [{ on: 'coord:escalate', note: 'x' }],
      lastWakeAt,
      declaredAt,
    });
    listReactionRules.mockReturnValue([
      { id: 'hive-wake:ws-test#0' },
      { id: 'hive-wake:other-ws#0' }, // another workspace — excluded
      { id: 'some:unrelated-rule' },
    ]);

    const res = parse(await tool.handler({ harness: 'papercup' }, ctx()));
    expect(res.ok).toBe(true);
    // canonicalHarnessSlug maps 'papercup' → 'papercusp' (rename-compat shim EI-2224)
    expect(res.harness).toBe('papercusp');
    expect(res.time).toEqual({ active: true, nextFireAt: nextFire.toISOString(), lastFiredAt: null });
    expect(res.subscriptions).toEqual([{ on: 'coord:escalate', note: 'x' }]);
    expect(res.liveRuleIds).toEqual(['hive-wake:ws-test#0']);
    expect(res.lastWakeAt).toBe(new Date(lastWakeAt).toISOString());
    expect(res.declaredAt).toBe(new Date(declaredAt).toISOString());
    expect(res.floorSec).toBe(60);
  });

  it('no home slug → time:null but still returns subscriptions/floor (read-only, no throw)', async () => {
    readHiveWakeState.mockResolvedValue({ subscriptions: [] });
    const res = parse(await tool.handler({}, ctx()));
    expect(res.ok).toBe(true);
    expect(res.time).toBeNull();
    expect(getHiveTimeWake).not.toHaveBeenCalled();
    expect(res.subscriptions).toEqual([]);
    expect(res.floorSec).toBe(60);
  });
});

describe('hive:queen_efficiency (B-06 / P-010 queryable surface)', () => {
  const tool = queenEfficiencyTool as unknown as Tool;
  const sample = (over: Record<string, unknown> = {}) => ({
    runId: 'w',
    tsMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: null,
    turns: null,
    ...over,
  });
  const effResult = (over: Record<string, unknown> = {}) => ({
    wakes: 2,
    cachedWakes: 1,
    totalInputTokens: 3000,
    totalCacheReadTokens: 8000,
    totalCacheCreationTokens: 6000,
    totalOutputTokens: 800,
    totalCostUsd: 0.32,
    cacheHitRatio: 8000 / 17000,
    avgTurns: 4,
    totalTurns: 8,
    turnsReportedWakes: 2,
    samples: [],
    ...over,
  });

  it('scopes to the given harness + limit and projects the headline metrics', async () => {
    queenWakeEfficiency.mockResolvedValue(effResult());
    const res = parse(await tool.handler({ harness: 'papercup', limit: 100 }, ctx()));
    expect(res.ok).toBe(true);
    // canonicalHarnessSlug maps 'papercup' → 'papercusp' (rename-compat shim EI-2224)
    expect(res.harness).toBe('papercusp');
    expect(res.wakes).toBe(2);
    expect(res.cachedWakes).toBe(1); // the "cache is real" signal (P-003)
    expect(res.avgTurns).toBe(4); // Win-2 round-trips
    expect(res.cacheHitRatio).toBeCloseTo(8000 / 17000, 9); // Win-1 cache
    expect(queenWakeEfficiency).toHaveBeenCalledWith('ws-test', { harnessSlug: 'papercusp', limit: 100 }); // canonicalized EI-2224
  });

  it('no harness (+ no env) → workspace-wide (harnessSlug undefined), harness:null, default limit 50', async () => {
    queenWakeEfficiency.mockResolvedValue(effResult({ wakes: 5 }));
    const res = parse(await tool.handler({}, ctx()));
    expect(res.harness).toBeNull();
    expect(res.wakes).toBe(5);
    expect(queenWakeEfficiency).toHaveBeenCalledWith('ws-test', { harnessSlug: undefined, limit: 50 });
  });

  it('caps the recentSamples preview at 10 even when more wakes were aggregated', async () => {
    const many = Array.from({ length: 25 }, (_, i) => sample({ runId: `w${i}`, turns: i }));
    queenWakeEfficiency.mockResolvedValue(effResult({ samples: many }));
    const res = parse(await tool.handler({ harness: 'papercup' }, ctx())) as { recentSamples: unknown[] };
    expect(res.recentSamples).toHaveLength(10);
  });

  describe('arg-schema', () => {
    it('accepts an empty call, a harness, and a bounded limit', () => {
      expect(tool.args.safeParse({}).success).toBe(true);
      expect(tool.args.safeParse({ harness: 'papercup' }).success).toBe(true);
      expect(tool.args.safeParse({ limit: 200 }).success).toBe(true);
    });
    it('rejects an out-of-range / non-integer limit', () => {
      expect(tool.args.safeParse({ limit: 0 }).success).toBe(false);
      expect(tool.args.safeParse({ limit: 501 }).success).toBe(false);
      expect(tool.args.safeParse({ limit: 1.5 }).success).toBe(false);
    });
  });
});
