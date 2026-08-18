/**
 * learning-frontier-read — the lane→flag map's completeness drift-guard +
 * the governor row↔lane matcher (learning-tab-visibility-2026-07-18 P-003).
 *
 * The completeness assert is the load-bearing test: a NEW workspace-singleton
 * learning loop cannot be added to LEARNING_SINGLETONS without deciding its
 * flag column here (an explicit null = "no flag gate, always-on"), so the
 * Frontier grid can never silently render a lane with an unknown gate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { FLAGS } from '@papercusp/flags';
import { LEARNING_SINGLETONS } from '../blueprint/seed-learning-singletons';
import {
  applyFrontierPotLens,
  FRONTIER_LANE_FLAGS,
  governorRowMatchesLane,
  type FrontierGovernorInfo,
  type FrontierLaneSnapshot,
} from './learning-frontier-read';

describe('FRONTIER_LANE_FLAGS', () => {
  it('covers every LEARNING_SINGLETONS lane (explicit null = deliberately ungated)', () => {
    for (const loop of LEARNING_SINGLETONS) {
      expect(
        Object.prototype.hasOwnProperty.call(FRONTIER_LANE_FLAGS, loop.blueprintId),
        `LEARNING_SINGLETONS gained '${loop.blueprintId}' — add it to FRONTIER_LANE_FLAGS (a flag key, or an explicit null for an always-on/ungated lane) so the Frontier grid renders its gate column.`,
      ).toBe(true);
    }
  });

  it('maps only to real flag registry values', () => {
    const known = new Set(Object.values(FLAGS));
    for (const [lane, key] of Object.entries(FRONTIER_LANE_FLAGS)) {
      if (key == null) continue;
      expect(known.has(key), `lane '${lane}' maps to '${key}', which is not a FLAGS value`).toBe(true);
    }
  });

  it('has no orphan lanes (every mapped lane exists in LEARNING_SINGLETONS)', () => {
    const ids = new Set(LEARNING_SINGLETONS.map((l) => l.blueprintId));
    for (const lane of Object.keys(FRONTIER_LANE_FLAGS)) {
      expect(ids.has(lane), `FRONTIER_LANE_FLAGS maps '${lane}', which is not a LEARNING_SINGLETONS blueprintId`).toBe(true);
    }
  });
});

describe('governorRowMatchesLane', () => {
  it('matches exact ids and the <id>:<scope> convention', () => {
    expect(governorRowMatchesLane('regret', 'regret')).toBe(true);
    expect(governorRowMatchesLane('regret:papercusp', 'regret')).toBe(true);
  });

  it("matches scout's blender: registration prefix", () => {
    expect(governorRowMatchesLane('blender:papercusp', 'scout')).toBe(true);
  });

  it('does not match unrelated registrations', () => {
    expect(governorRowMatchesLane('gym:papercusp', 'scout')).toBe(false);
    expect(governorRowMatchesLane('gym:papercusp', 'regret')).toBe(false);
  });
});

describe('applyFrontierPotLens (pot-scope-all-learnings P-005)', () => {
  const lane = (blueprintId: string, potSlug: string | null): FrontierLaneSnapshot => ({
    blueprintId,
    alwaysOn: false,
    status: 'firing',
    active: true,
    collision: false,
    expectedMaterialized: true,
    lastFiredAt: null,
    daysSinceFire: null,
    activityLastAt: null,
    activitySource: null,
    flagKey: null,
    flagOn: null,
    potSlug,
    governor: null,
    outcome: null,
  });
  const gov = (loopId: string, potSlug: string | null): FrontierGovernorInfo => ({
    loopId,
    potSlug,
    budgetUsd: null,
    spentUsd: 0,
    budgetKind: 'monthly',
    enabled: true,
    enforcement: 'advisory',
    priority: 0,
  });

  it('no lens ⇒ passes both lists through untouched', () => {
    const lanes = [lane('scout', 'oddsmith'), lane('gym', null)];
    const unmatched = [gov('regret:x', 'oddsmith'), gov('drill', null)];
    expect(applyFrontierPotLens(lanes, unmatched, null)).toEqual({
      lanes,
      unmatchedGovernor: unmatched,
    });
  });

  it("drops lanes registered to ANOTHER pot but keeps pot-less machinery lanes (they aren't tenant content)", () => {
    const mine = lane('scout', 'oddsmith');
    const theirs = lane('gym', 'papercusp');
    const machinery = lane('iq-battery', null);
    const { lanes } = applyFrontierPotLens([mine, theirs, machinery], [], 'oddsmith');
    expect(lanes).toEqual([mine, machinery]);
  });

  it('filters unmatched governor rows STRICTLY — a null pot is excluded under any lens (D-002)', () => {
    const mine = gov('regret:oddsmith', 'oddsmith');
    const theirs = gov('regret:papercusp', 'papercusp');
    const unattributed = gov('drill', null);
    const { unmatchedGovernor } = applyFrontierPotLens([], [mine, theirs, unattributed], 'oddsmith');
    expect(unmatchedGovernor).toEqual([mine]);
  });
});

/**
 * EI-20801200386596605 — the hang bound.
 *
 * Every leg below had its own try/catch and the resolver had an outer one, which
 * reads like isolation and IS, for a leg that THROWS. For a leg that merely HANGS
 * it was nothing: the legs run sequentially, so one wedged reader blew the ~10s
 * resolver timeout and 500'd the whole grid — which then could not ship even the
 * `degraded({ lanes: [] })` snapshot index.ts builds for exactly this case.
 *
 * This read is the WORST instance of the family (releaseReadiness / retainFeed
 * were 2-leg parallel fan-outs): FOUR SEQUENTIAL legs, which is why the bound has
 * to be one SHARED deadline. Four independent 6s budgets would total 24s and
 * overrun by 2.4x the timeout they exist to stay under.
 */
describe('readFrontierSnapshot bounds a HUNG leg (EI-20801200386596605)', () => {
  /** Never settles — a wedged reader, not a failing one. */
  const hang = () => new Promise<never>(() => {});

  const readLearningLoopHealth = vi.fn();
  const getFlag = vi.fn();
  const listLearningLoops = vi.fn();

  /** Enough of a LearningLoopHealth row for the lane mapping to consume. */
  const healthRow = {
    blueprintId: 'regret',
    alwaysOn: false,
    status: 'firing',
    active: true,
    collision: false,
    expectedMaterialized: true,
    lastFiredAt: '2026-08-18T00:00:00.000Z',
    daysSinceFire: 0,
    activityLastAt: null,
    activitySource: null,
  };

  const governorRow = {
    loopId: 'regret:papercusp',
    potSlug: 'papercusp',
    budgetUsd: 5,
    spentUsd: 1,
    budgetKind: 'monthly',
    enabled: true,
    enforcement: 'advisory',
    priority: 1,
  };

  /**
   * Leg 4 reads through the tagged template directly rather than an injectable
   * module, so a fake `sql` stands in for it. Returning no rows makes every lane
   * rollup read null — the documented per-lane fail-soft, not an error.
   */
  const emptySql = (() => Promise.resolve([])) as unknown as Sql;
  /** A `sql` whose queries never settle — leg 4 wedged at the STORE, not the module. */
  const hangingSql = (() => hang()) as unknown as Sql;

  /**
   * Each leg reports its own casualty through console.warn, so the spy is not
   * just noise suppression — it is the assertion surface for WHICH leg degraded
   * and why. A silent spy would let a read that degrades for some other reason
   * pass these tests.
   */
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readLearningLoopHealth.mockResolvedValue([healthRow]);
    getFlag.mockResolvedValue(true);
    listLearningLoops.mockResolvedValue([governorRow]);
    vi.doMock('../blueprint/learning-loop-read', () => ({
      readLearningLoopHealth: (...a: unknown[]) => readLearningLoopHealth(...a),
    }));
    vi.doMock('@papercusp/flags/server', () => ({
      getFlag: (...a: unknown[]) => getFlag(...a),
    }));
    vi.doMock('../learning-governor/store', () => ({
      listLearningLoops: (...a: unknown[]) => listLearningLoops(...a),
    }));
  });

  /** Re-imported per test so the doMock'd dynamic imports above take effect. */
  const load = async () => (await import('./learning-frontier-read')).readFrontierSnapshot;

  it('a hung liveness leg still SERVES the grid instead of taking the read down', async () => {
    readLearningLoopHealth.mockImplementation(hang);
    const read = await load();

    const snap = await read(emptySql, 'w', { budgetMs: 40 });

    // Before the bound this never returned at all — the caller ate the resolver
    // timeout and the client got a 500 rather than a degraded grid.
    expect(snap.lanes).toEqual([]);
    expect(snap.generatedAt).toEqual(expect.any(String));
    // The leg that did NOT hang still delivered: its governor row survives as
    // unmatched rather than being lost with the hung one.
    expect(snap.unmatchedGovernor.map((g) => g.loopId)).toEqual(['regret:papercusp']);
    // It degraded for THIS reason — the budget — not incidentally.
    expect(warn).toHaveBeenCalledWith(
      '[learning.frontier] loop-health read failed:',
      'loop-health exceeded the read budget',
    );
  });

  it('a hung leg 4 keeps the legs that already returned — the deadline is shared, not fatal', async () => {
    const read = await load();

    const snap = await read(hangingSql, 'w', { budgetMs: 40 });

    // Legs 1-3 completed before leg 4 wedged, so the lane renders in full and
    // only its outcome rollup is missing. A naive whole-read timeout would have
    // thrown all of this away instead.
    expect(snap.lanes).toHaveLength(1);
    expect(snap.lanes[0]?.blueprintId).toBe('regret');
    expect(snap.lanes[0]?.governor?.loopId).toBe('regret:papercusp');
    expect(snap.lanes[0]?.outcome).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[learning.frontier] outcome rollup failed:',
      'lane-outcomes exceeded the read budget',
    );
  });

  // Without this control both guards above pass just as happily against a read
  // that degrades UNCONDITIONALLY — "always empty" satisfies every assertion
  // that only ever inspects the wedged case. This is the calibration that makes
  // the two above evidence of bounding rather than evidence of breakage.
  it('a healthy read under the SAME budget degrades nothing — the guard discriminates on the hang, not on the budget', async () => {
    const read = await load();

    const snap = await read(emptySql, 'w', { budgetMs: 40 });

    expect(snap.lanes).toHaveLength(1);
    expect(snap.lanes[0]?.blueprintId).toBe('regret');
    expect(snap.lanes[0]?.flagOn).toBe(true);
    expect(snap.lanes[0]?.governor?.loopId).toBe('regret:papercusp');
    expect(snap.unmatchedGovernor).toEqual([]);
    // Nothing degraded at all — no leg reported a casualty under this budget.
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * The cases above assert what a BOUNDED read does. This one proves the BOUND is
   * what makes them pass: under a budget that cannot fire inside the test, the
   * identical hang never settles. So deleting the bound would break those guards
   * rather than leave them quietly green — which is the question "is this guard
   * falsifiable?" actually asks.
   *
   * Shape borrowed from su-3387c6b6's control on the two sibling reads. It needs
   * NO source mutation, so it is exempt from the whole mutation-probe hazard in
   * CLAUDE.md ("Proving a guard is falsifiable"): nothing is written to the
   * shared tree, so the git-sync sweep cannot commit a mutant.
   *
   * "Never settles" is the condition under test, so it has to be an ASSERTABLE
   * outcome rather than a vitest timeout — hence the PENDING sentinel.
   */
  const PENDING = Symbol('still-pending');
  const settledWithin = <T>(p: Promise<T>, ms: number): Promise<T | typeof PENDING> =>
    Promise.race([
      p,
      new Promise<typeof PENDING>((resolve) => {
        const t = setTimeout(() => resolve(PENDING), ms);
        (t as unknown as { unref?: () => void }).unref?.();
      }),
    ]);

  it('CONTROL: with a budget that cannot fire, the same hang takes the whole grid down — so the guards above are falsifiable', async () => {
    readLearningLoopHealth.mockImplementation(hang);
    const read = await load();

    // Effectively unbounded: this is the pre-fix behaviour, and it never returns.
    expect(await settledWithin(read(emptySql, 'w', { budgetMs: 10 * 60_000 }), 150)).toBe(PENDING);

    // Calibration: the IDENTICAL call under a real budget settles, degraded. Without
    // this half, a read that never settled under ANY budget would also pass above.
    const bounded = await settledWithin(read(emptySql, 'w', { budgetMs: 40 }), 2000);
    expect(bounded).not.toBe(PENDING);
    expect(bounded !== PENDING && bounded.lanes).toEqual([]);
  });
});
