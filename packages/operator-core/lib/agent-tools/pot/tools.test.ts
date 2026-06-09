/**
 * Handler-level tests for the three Pot self-declared-wake tools
 * (autoloop-pot-operator-rebuild-2026-06-05 P0, D-002): pot:declare-wake,
 * pot:wake, pot:status. The wake CORE fns (clamp/debounce/subscription
 * projection) are unit-covered in ../../pot/wake.test.ts and round-tripped
 * against real PG in ../../pot/pot-wake-pg.integration.test.ts; THIS file pins
 * the tool-handler ORCHESTRATION the dispatcher runs — slug resolution + the
 * no_home_harness guard, the time/event/none `mode` computation, the
 * fire-vs-floor-skip branch, and the read-only status assembly.
 *
 * The PG-touching pot fns + the blueprint launch are mocked at their module
 * seams; the pure floor/slug helpers (potWakeFloorSec / resolvePotHomeSlug /
 * withinWakeFloor) run REAL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── module-seam mocks (arrow-deref so the hoisted vi.mock factory sees them) ──
const declarePotTimeWake = vi.fn(async (_sql: unknown, opts: { at: Date; clamped?: boolean }) => ({
  at: opts.at,
  clamped: false,
}));
const clearPotTimeWake = vi.fn(async () => {});
const setPotEventSubscriptions = vi.fn(async (_ws: string, subs: unknown[]) => subs.length);
const readPotWakeState = vi.fn<() => Promise<Record<string, unknown>>>();
const recordPotWake = vi.fn(async () => {});
const getPotTimeWake =
  vi.fn<() => Promise<{ active: boolean; nextFireAt: Date | null; lastFiredAt: Date | null } | null>>();
const fireLaunchBlueprint = vi.fn(async () => ({ role: 'operator', kind: 'role' as const }));
const listReactionRules = vi.fn<() => Array<{ id: string }>>(() => []);

vi.mock('../../pot/wake', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../pot/wake')>();
  return {
    ...real, // keep POT_BLUEPRINT_ID + the PURE helpers real
    declarePotTimeWake: (...a: unknown[]) => declarePotTimeWake(...(a as [unknown, { at: Date }])),
    clearPotTimeWake: (...a: unknown[]) => clearPotTimeWake(...(a as [])),
    setPotEventSubscriptions: (...a: unknown[]) => setPotEventSubscriptions(...(a as [string, unknown[]])),
    readPotWakeState: (...a: unknown[]) => readPotWakeState(...(a as [])),
    recordPotWake: (...a: unknown[]) => recordPotWake(...(a as [])),
    getPotTimeWake: (...a: unknown[]) => getPotTimeWake(...(a as [])),
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

// SUTs imported AFTER the seams are wired (each self-registers via defineTool).
import declareWakeTool from './declare_wake';
import wakeTool from './wake';
import statusTool from './status';

type Tool = {
  args: { safeParse: (x: unknown) => { success: boolean } };
  handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
};
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(r.content[0].text);
const ctx = (over: Record<string, unknown> = {}): never => over as never;
const ENV = ['PAPERCUSP_POT_WAKE_FLOOR_SEC', 'PAPERCUSP_POT_HOME_SLUG'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k]; // floor → 60s default; no env home-slug fallback
  }
  // sensible defaults; tests override per-case
  declarePotTimeWake.mockImplementation(async (_sql, opts) => ({ at: opts.at, clamped: false }));
  setPotEventSubscriptions.mockImplementation(async (_ws, subs) => subs.length);
  readPotWakeState.mockResolvedValue({ subscriptions: [] });
  getPotTimeWake.mockResolvedValue(null);
  listReactionRules.mockReturnValue([]);
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('pot:declare-wake', () => {
  const tool = declareWakeTool as unknown as Tool;

  it('no resolvable home harness → ok:false no_home_harness, nothing touched', async () => {
    const res = parse(await tool.handler({ events: [{ on: 'coord:escalate' }] }, ctx()));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no_home_harness');
    expect(declarePotTimeWake).not.toHaveBeenCalled();
    expect(clearPotTimeWake).not.toHaveBeenCalled();
    expect(setPotEventSubscriptions).not.toHaveBeenCalled();
  });

  it("time wake (`at`): declares the one-shot, clears events, mode:'time'", async () => {
    const at = '2026-07-01T00:00:00.000Z';
    const res = parse(await tool.handler({ at, harness: 'papercup' }, ctx()));
    expect(res.ok).toBe(true);
    expect(res.harness).toBe('papercup');
    expect(res.mode).toBe('time');
    expect(res.time).toEqual({ at, clamped: false });
    expect(res.eventRules).toBe(0);
    expect(res.floorSec).toBe(60);
    expect(declarePotTimeWake).toHaveBeenCalledTimes(1);
    expect(clearPotTimeWake).not.toHaveBeenCalled();
    // events omitted ⇒ cleared (REPLACE semantics) via an empty-set declare
    expect(setPotEventSubscriptions).toHaveBeenCalledWith('ws-test', []);
  });

  it('time wake (`inSeconds`): requests ≈ now + N seconds', async () => {
    const before = Date.now();
    const res = parse(await tool.handler({ inSeconds: 600, harness: 'papercup' }, ctx()));
    expect(res.mode).toBe('time');
    expect(declarePotTimeWake).toHaveBeenCalledTimes(1);
    const opts = declarePotTimeWake.mock.calls[0][1] as { at: Date };
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
    expect(clearPotTimeWake).toHaveBeenCalledTimes(1);
    expect(declarePotTimeWake).not.toHaveBeenCalled();
    expect(setPotEventSubscriptions).toHaveBeenCalledWith('ws-test', [
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
    expect(declarePotTimeWake).toHaveBeenCalledTimes(1);
  });

  it("mode:'none' → clears both, mode:'none'", async () => {
    const res = parse(await tool.handler({ mode: 'none', harness: 'papercup' }, ctx()));
    expect(res.mode).toBe('none');
    expect(res.time).toBeNull();
    expect(res.eventRules).toBe(0);
    expect(clearPotTimeWake).toHaveBeenCalledTimes(1);
    expect(setPotEventSubscriptions).toHaveBeenCalledWith('ws-test', []);
  });

  it('uses ctx.harnessSlug when no explicit harness is passed', async () => {
    const res = parse(await tool.handler({ at: '2026-07-01T00:00:00.000Z' }, ctx({ harnessSlug: 'ctx-slug' })));
    expect(res.ok).toBe(true);
    expect(res.harness).toBe('ctx-slug');
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

describe('pot:wake', () => {
  const tool = wakeTool as unknown as Tool;

  it('no resolvable home harness → ok:false, no launch', async () => {
    const res = parse(await tool.handler({ reason: 'kick' }, ctx()));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no_home_harness');
    expect(fireLaunchBlueprint).not.toHaveBeenCalled();
  });

  it('outside the floor → fires the pot launch + records the wake', async () => {
    readPotWakeState.mockResolvedValue({ subscriptions: [] }); // no prior wake
    const res = parse(await tool.handler({ reason: 'prod fire', source: 'user', harness: 'papercup' }, ctx()));
    expect(res).toMatchObject({ ok: true, fired: true, role: 'operator', harness: 'papercup' });
    expect(fireLaunchBlueprint).toHaveBeenCalledTimes(1);
    const [bp, input] = fireLaunchBlueprint.mock.calls[0] as unknown as [
      string,
      { installSlug: string; workspaceId: string; kickoff: string },
    ];
    expect(bp).toBe('pot');
    expect(input.installSlug).toBe('papercup');
    expect(input.workspaceId).toBe('ws-test');
    expect(input.kickoff).toContain('prod fire');
    expect(recordPotWake).toHaveBeenCalledTimes(1);
  });

  it('within the floor (no force) → skipped:wake-floor, no launch', async () => {
    readPotWakeState.mockResolvedValue({ subscriptions: [], lastWakeAt: Date.now() - 10_000 });
    const res = parse(await tool.handler({ reason: 'too soon', harness: 'papercup' }, ctx()));
    expect(res).toMatchObject({ ok: true, fired: false, skipped: 'wake-floor', floorSec: 60 });
    expect(typeof res.nextAllowedAt).toBe('string');
    expect(fireLaunchBlueprint).not.toHaveBeenCalled();
    expect(recordPotWake).not.toHaveBeenCalled();
  });

  it('within the floor + force:true → bypasses the debounce and fires', async () => {
    readPotWakeState.mockResolvedValue({ subscriptions: [], lastWakeAt: Date.now() - 10_000 });
    const res = parse(await tool.handler({ reason: 'urgent', force: true, harness: 'papercup' }, ctx()));
    expect(res.fired).toBe(true);
    expect(fireLaunchBlueprint).toHaveBeenCalledTimes(1);
  });
});

describe('pot:status', () => {
  const tool = statusTool as unknown as Tool;

  it('assembles the time wake, subscriptions, live rule ids, and floor', async () => {
    const nextFire = new Date('2026-07-01T00:00:00.000Z');
    getPotTimeWake.mockResolvedValue({ active: true, nextFireAt: nextFire, lastFiredAt: null });
    const declaredAt = Date.parse('2026-06-08T00:00:00.000Z');
    const lastWakeAt = Date.parse('2026-06-08T00:30:00.000Z');
    readPotWakeState.mockResolvedValue({
      subscriptions: [{ on: 'coord:escalate', note: 'x' }],
      lastWakeAt,
      declaredAt,
    });
    listReactionRules.mockReturnValue([
      { id: 'pot-wake:ws-test#0' },
      { id: 'pot-wake:other-ws#0' }, // another workspace — excluded
      { id: 'some:unrelated-rule' },
    ]);

    const res = parse(await tool.handler({ harness: 'papercup' }, ctx()));
    expect(res.ok).toBe(true);
    expect(res.harness).toBe('papercup');
    expect(res.time).toEqual({ active: true, nextFireAt: nextFire.toISOString(), lastFiredAt: null });
    expect(res.subscriptions).toEqual([{ on: 'coord:escalate', note: 'x' }]);
    expect(res.liveRuleIds).toEqual(['pot-wake:ws-test#0']);
    expect(res.lastWakeAt).toBe(new Date(lastWakeAt).toISOString());
    expect(res.declaredAt).toBe(new Date(declaredAt).toISOString());
    expect(res.floorSec).toBe(60);
  });

  it('no home slug → time:null but still returns subscriptions/floor (read-only, no throw)', async () => {
    readPotWakeState.mockResolvedValue({ subscriptions: [] });
    const res = parse(await tool.handler({}, ctx()));
    expect(res.ok).toBe(true);
    expect(res.time).toBeNull();
    expect(getPotTimeWake).not.toHaveBeenCalled();
    expect(res.subscriptions).toEqual([]);
    expect(res.floorSec).toBe(60);
  });
});
