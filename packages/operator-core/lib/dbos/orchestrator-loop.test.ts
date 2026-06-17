import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';

// Control the workspace policy for orchestratorWorkspaceIds (P-020). The
// pin → shared-all → global-active policy itself lives in (and is
// behaviorally tested at) workspace-registry.test.ts `backgroundWorkspaceIds`;
// here we only verify the dispatcher delegates to it.
vi.mock('../workspace-registry', () => ({
  backgroundWorkspaceIds: () => ['ws-a', 'ws-b', 'ws-c'],
}));

import type { HarnessConfig } from '@papercusp/orchestrator';
import {
  computeFrontier,
  resolveOrchestratorHarnesses,
  shouldScheduleOrchestrator,
  resolvePerHarnessCap,
  resolveDispatchPolicy,
  orchestratorWorkspaceIds,
  harnessDispatchesLocally,
  isOverdue,
  getSafetyCeiling,
  type FrontierFeature,
} from './orchestrator-loop';
import {
  registerDeploymentDriver,
  _resetDeploymentDriversForTests,
  type DeploymentDriver,
  type Frame,
} from '@papercusp/deployment-driver';

/** Frontier-feature factory: defaults to an unblocked, no-plan, unordered feature. */
const f = (
  id: string,
  status: string,
  over: Partial<FrontierFeature> = {},
): FrontierFeature => ({ id, status, blockedBy: [], sourcePlan: null, order: null, ...over });
const NO_PLANS = new Map<string, number>();
const NONE = new Set<string>();

describe('resolveOrchestratorHarnesses — all-harnesses default + allowlist override (P-006)', () => {
  const all = ['papercup', 'sheets', 'restart'];

  test('"*" → every harness in the workspace (the default-on-for-all rollout)', () => {
    expect(resolveOrchestratorHarnesses('*', all)).toEqual(all);
  });

  test('whitespace around "*" still means all', () => {
    expect(resolveOrchestratorHarnesses('  *  ', all)).toEqual(all);
  });

  test('empty / unset → ALL (P-009 flip: DBOS is the default orchestrator for every harness)', () => {
    expect(resolveOrchestratorHarnesses('', all)).toEqual(all);
    expect(resolveOrchestratorHarnesses(undefined, all)).toEqual(all);
  });

  test('explicit comma list is an override (scoped testing) — not all', () => {
    expect(resolveOrchestratorHarnesses('sheets', all)).toEqual(['sheets']);
    expect(resolveOrchestratorHarnesses('sheets, restart', all)).toEqual(['sheets', 'restart']);
  });

  test('"none" / "off" → disabled (explicit opt-out, e.g. the shared dev box)', () => {
    expect(resolveOrchestratorHarnesses('none', all)).toEqual([]);
    expect(resolveOrchestratorHarnesses('off', all)).toEqual([]);
    expect(resolveOrchestratorHarnesses('  none  ', all)).toEqual([]);
  });

  test('trims + drops blanks in an explicit list', () => {
    expect(resolveOrchestratorHarnesses(' sheets , , restart ,', all)).toEqual(['sheets', 'restart']);
  });
});

describe('shouldScheduleOrchestrator — when to arm the 30s tick (P-009: schedule by default)', () => {
  test('"*" → schedule (all-harnesses mode)', () => {
    expect(shouldScheduleOrchestrator('*')).toBe(true);
  });
  test('explicit allowlist → schedule', () => {
    expect(shouldScheduleOrchestrator('sheets,restart')).toBe(true);
  });
  test('empty / unset → schedule (default-all)', () => {
    expect(shouldScheduleOrchestrator('')).toBe(true);
    expect(shouldScheduleOrchestrator(undefined)).toBe(true);
  });
  test('"none" / "off" → do NOT schedule (explicit opt-out)', () => {
    expect(shouldScheduleOrchestrator('none')).toBe(false);
    expect(shouldScheduleOrchestrator('off')).toBe(false);
  });
});

describe('resolvePerHarnessCap — honor the harness parallelism settings (#1)', () => {
  // The DBOS dispatcher must cap concurrent pipelines per harness from that
  // harness's own `parallelWorkers` config — NOT a flat global. A default
  // harness (no config) runs one feature at a time; a harness configured for
  // N runs N concurrently, matching the legacy lane-pool behavior.

  test('default harness (parallelMax=1, no maxFeaturesInFlight) → 1 (one feature at a time)', () => {
    expect(resolvePerHarnessCap({ parallelMax: 1, maxFeaturesInFlight: null })).toBe(1);
  });

  test('parallelWorkers.max=2 → 2 concurrent pipelines', () => {
    expect(resolvePerHarnessCap({ parallelMax: 2, maxFeaturesInFlight: null })).toBe(2);
  });

  test('maxFeaturesInFlight tightens below the worker budget', () => {
    // 4 workers but only 2 distinct features at once → cap 2.
    expect(resolvePerHarnessCap({ parallelMax: 4, maxFeaturesInFlight: 2 })).toBe(2);
  });

  test('maxFeaturesInFlight never widens past the worker budget', () => {
    // 1 worker but maxFeaturesInFlight=5 → still bounded by the 1-worker budget.
    expect(resolvePerHarnessCap({ parallelMax: 1, maxFeaturesInFlight: 5 })).toBe(1);
  });

  test('env ceiling clamps the per-harness cap (shared-dev-box safety)', () => {
    expect(resolvePerHarnessCap({ parallelMax: 8, maxFeaturesInFlight: null, envCeiling: 4 })).toBe(4);
  });

  test('a high config under the ceiling is honored in full', () => {
    expect(resolvePerHarnessCap({ parallelMax: 6, maxFeaturesInFlight: null, envCeiling: 16 })).toBe(6);
  });

  test('floors at 1 even with degenerate inputs', () => {
    expect(resolvePerHarnessCap({ parallelMax: 0, maxFeaturesInFlight: 0, envCeiling: 0 })).toBe(1);
  });

  // ── blueprint-declared dispatch policy (D-005 / P-006) ────────────────────
  test('a silent config defers to the blueprint dispatch.concurrency', () => {
    expect(
      resolvePerHarnessCap({ parallelMax: null, maxFeaturesInFlight: null, blueprintConcurrency: 4 }),
    ).toBe(4);
  });

  test('a silent config with no blueprint policy keeps the legacy floor of 1', () => {
    expect(resolvePerHarnessCap({ parallelMax: null, maxFeaturesInFlight: null })).toBe(1);
    expect(
      resolvePerHarnessCap({ parallelMax: null, maxFeaturesInFlight: null, blueprintConcurrency: null }),
    ).toBe(1);
  });

  test('an explicit per-install config OVERRIDES the blueprint (instance refines shape)', () => {
    expect(
      resolvePerHarnessCap({ parallelMax: 2, maxFeaturesInFlight: null, blueprintConcurrency: 4 }),
    ).toBe(2);
    // explicit 1 is NOT "silent" — it wins over a wider blueprint value.
    expect(
      resolvePerHarnessCap({ parallelMax: 1, maxFeaturesInFlight: null, blueprintConcurrency: 4 }),
    ).toBe(1);
  });

  test('maxFeaturesInFlight tightens a blueprint-sourced budget too', () => {
    expect(
      resolvePerHarnessCap({ parallelMax: null, maxFeaturesInFlight: 2, blueprintConcurrency: 4 }),
    ).toBe(2);
  });

  test('blueprint safetyCeiling tightens the default ceiling…', () => {
    expect(
      resolvePerHarnessCap({
        parallelMax: null,
        maxFeaturesInFlight: null,
        blueprintConcurrency: 12,
        blueprintSafetyCeiling: 8,
      }),
    ).toBe(8);
  });

  test('…but can never RAISE it past the imperative SAFETY_CEILING (D-007)', () => {
    // SAFETY_CEILING now scales with resource-profile (F-E2 of app-wide-load-traps),
    // so we test that the function clamps to whatever getSafetyCeiling() returns.
    const ceiling = getSafetyCeiling();
    expect(
      resolvePerHarnessCap({
        parallelMax: null,
        maxFeaturesInFlight: null,
        blueprintConcurrency: 99,
        blueprintSafetyCeiling: 99,
      }),
    ).toBe(ceiling);
  });

  test('the env ceiling (explicit operator override) still clamps a blueprint budget', () => {
    expect(
      resolvePerHarnessCap({
        parallelMax: null,
        maxFeaturesInFlight: null,
        envCeiling: 2,
        blueprintConcurrency: 8,
      }),
    ).toBe(2);
  });
});

describe('resolveDispatchPolicy — blueprint dispatch: merged with per-install config (D-005 / P-006)', () => {
  const cfg = (c: Record<string, unknown> = {}): HarnessConfig => c as HarnessConfig;
  const LEGACY_READINESS = ['todo', 'failing', 'pending', 'failed'];
  /** A declared dispatch policy as the schema resolves it (readiness default filled). */
  const dispatch = (over: Record<string, unknown> = {}) => ({
    priority: 'plan-order' as const,
    readiness: LEGACY_READINESS,
    ...over,
  });

  test('no blueprint → the legacy config-only resolution, byte-equivalent (cap 1, NEEDS_WORK, cfg untouched)', () => {
    const c = cfg();
    const r = resolveDispatchPolicy({ dispatch: null, cfg: c });
    expect(r.cap).toBe(1);
    expect([...r.readiness].sort()).toEqual([...LEGACY_READINESS].sort());
    expect(r.effectiveCfg).toBe(c); // identity — no overlay invented
  });

  test('no blueprint + explicit parallelWorkers config → exactly the legacy cap', () => {
    const r = resolveDispatchPolicy({ dispatch: null, cfg: cfg({ parallelWorkers: { max: 3 } }) });
    expect(r.cap).toBe(3);
  });

  test('coding-style policy (concurrency 4) fills a silent config', () => {
    const r = resolveDispatchPolicy({ dispatch: dispatch({ concurrency: 4 }), cfg: cfg() });
    expect(r.cap).toBe(4);
  });

  test('per-install parallelWorkers.max wins over the blueprint concurrency', () => {
    const r = resolveDispatchPolicy({
      dispatch: dispatch({ concurrency: 4 }),
      cfg: cfg({ parallelWorkers: { max: 2 } }),
    });
    expect(r.cap).toBe(2);
  });

  test('a declared dispatch with the schema-default readiness === the legacy set (byte-equivalence)', () => {
    const r = resolveDispatchPolicy({ dispatch: dispatch({ concurrency: 4 }), cfg: cfg() });
    expect([...r.readiness].sort()).toEqual([...LEGACY_READINESS].sort());
  });

  test('a narrowed readiness is honored', () => {
    const r = resolveDispatchPolicy({
      dispatch: dispatch({ readiness: ['todo'] }),
      cfg: cfg(),
    });
    expect(r.readiness.has('todo')).toBe(true);
    expect(r.readiness.has('failing')).toBe(false);
  });

  test('dispatch.costCapUsd fills a silent config (overlaid for evaluateCostCap)', () => {
    const r = resolveDispatchPolicy({ dispatch: dispatch({ costCapUsd: 25 }), cfg: cfg() });
    expect((r.effectiveCfg as Record<string, unknown>).maxCostUsd).toBe(25);
  });

  test('per-install maxCostUsd wins over dispatch.costCapUsd (no overlay)', () => {
    const c = cfg({ maxCostUsd: 10 });
    const r = resolveDispatchPolicy({ dispatch: dispatch({ costCapUsd: 25 }), cfg: c });
    expect(r.effectiveCfg).toBe(c);
    expect((r.effectiveCfg as Record<string, unknown>).maxCostUsd).toBe(10);
  });

  test('the live fleet cap (maxSimultaneousAgents, D-004) clamps the merged result', () => {
    const r = resolveDispatchPolicy({
      dispatch: dispatch({ concurrency: 8 }),
      cfg: cfg(),
      fleetCap: 3,
    });
    expect(r.cap).toBe(3);
    // No fleet clamp when omitted/null (legacy behavior).
    const r2 = resolveDispatchPolicy({ dispatch: dispatch({ concurrency: 8 }), cfg: cfg(), fleetCap: null });
    expect(r2.cap).toBe(8);
    // Floor of 1 survives an absurdly low fleet cap (dispatch never starves).
    const r3 = resolveDispatchPolicy({ dispatch: dispatch({ concurrency: 8 }), cfg: cfg(), fleetCap: 0 });
    expect(r3.cap).toBe(8); // 0 = invalid → ignored, not "cap everything to 0"
  });

  test('the env ceiling clamps the merged result', () => {
    const r = resolveDispatchPolicy({
      dispatch: dispatch({ concurrency: 8 }),
      cfg: cfg(),
      envCeiling: 2,
    });
    expect(r.cap).toBe(2);
  });
});

describe('orchestratorWorkspaceIds — which workspaces a sweep covers (Phase E P-020)', () => {
  test('delegates to the canonical backgroundWorkspaceIds policy (behavioral cases live in workspace-registry.test.ts)', () => {
    expect(orchestratorWorkspaceIds()).toEqual(['ws-a', 'ws-b', 'ws-c']);
  });
});

describe('computeFrontier — frontier dispatch (P-042)', () => {
  const start = (features: FrontierFeature[], slots: number, planPriority = NO_PLANS, owned = NONE) =>
    computeFrontier(features, planPriority, owned, slots).toStart;

  test('empty → nothing', () => {
    expect(computeFrontier([], NO_PLANS, NONE, 4)).toEqual({ toStart: [], stuck: false });
  });

  test('picks only needs-work statuses (todo/failing + pending/failed aliases)', () => {
    const features = [
      f('F-1', 'todo'),
      f('F-2', 'in_progress'),
      f('F-3', 'failing'),
      f('F-4', 'passed'),
      f('F-5', 'blocked'),
      f('F-6', 'pending'),
      f('F-7', 'failed'),
      f('F-8', 'deprecated'),
    ];
    // deterministic feature_id order within the (single, no-plan) group.
    expect(start(features, 10)).toEqual(['F-1', 'F-3', 'F-6', 'F-7']);
  });

  test('bounded by free slots', () => {
    const features = [f('F-1', 'pending'), f('F-2', 'pending'), f('F-3', 'failed')];
    expect(start(features, 2)).toEqual(['F-1', 'F-2']);
    expect(start(features, 1)).toEqual(['F-1']);
  });

  test('no free slots (cap full / over cost cap) → nothing started', () => {
    const features = [f('F-1', 'pending')];
    expect(start(features, 0)).toEqual([]);
    expect(start(features, -1)).toEqual([]);
  });

  test('orders within a group by (order ASC NULLS LAST, feature_id)', () => {
    const features = [
      f('F-9', 'failed', { order: 1 }),
      f('F-1', 'pending'), // no order → last
      f('F-5', 'pending', { order: 2 }),
    ];
    expect(start(features, 3)).toEqual(['F-9', 'F-5', 'F-1']);
  });

  // ── blocked_by frontier ──────────────────────────────────────────────────
  test('a feature blocked by a non-terminal blocker stays out of the frontier', () => {
    const features = [f('F-1', 'todo'), f('F-2', 'todo', { blockedBy: ['F-1'] })];
    expect(start(features, 4)).toEqual(['F-1']); // F-2 waits for F-1
  });

  test('a feature whose blocker is PASSED (terminal) is ready', () => {
    const features = [f('F-1', 'passed'), f('F-2', 'todo', { blockedBy: ['F-1'] })];
    expect(start(features, 4)).toEqual(['F-2']);
  });

  test('a FAILING blocker is non-terminal → dependent stays blocked', () => {
    const features = [f('F-1', 'failing'), f('F-2', 'todo', { blockedBy: ['F-1'] })];
    // F-1 itself is needs-work + ready; F-2 blocked by the non-terminal F-1.
    expect(start(features, 4)).toEqual(['F-1']);
  });

  test('a blocked_by id absent from the set is treated as satisfied (no deadlock)', () => {
    const features = [f('F-2', 'todo', { blockedBy: ['F-GONE'] })];
    expect(start(features, 4)).toEqual(['F-2']);
  });

  // ── plan grouping + priority ─────────────────────────────────────────────
  test('orders groups by plan priority (lower first), filling greedily', () => {
    const features = [
      f('A-1', 'todo', { sourcePlan: 'plan-a' }),
      f('B-1', 'todo', { sourcePlan: 'plan-b' }),
      f('A-2', 'todo', { sourcePlan: 'plan-a' }),
    ];
    const prio = new Map([['plan-b', 1], ['plan-a', 2]]); // plan-b higher priority
    expect(start(features, 2, prio)).toEqual(['B-1', 'A-1']); // drain plan-b, then plan-a
  });

  test('manual / no-plan features sort after all plans', () => {
    const features = [
      f('M-1', 'todo'), // no plan
      f('A-1', 'todo', { sourcePlan: 'plan-a' }),
    ];
    const prio = new Map([['plan-a', 5]]);
    expect(start(features, 2, prio)).toEqual(['A-1', 'M-1']);
  });

  test('a high-priority plan blocked lets a lower plan fill the gap', () => {
    const features = [
      f('A-1', 'todo', { sourcePlan: 'plan-a', blockedBy: ['A-0'] }), // blocked (A-0 not terminal)
      f('A-0', 'failing', { sourcePlan: 'plan-a' }),
      f('B-1', 'todo', { sourcePlan: 'plan-b' }),
    ];
    const prio = new Map([['plan-a', 1], ['plan-b', 2]]);
    // plan-a's A-1 is blocked; A-0 (failing) is ready; B-1 fills remaining slot.
    expect(start(features, 2, prio)).toEqual(['A-0', 'B-1']);
  });

  // ── owned (carve-out) + stuck signal ─────────────────────────────────────
  test('an owned (in-flight) feature is excluded from candidates but still blocks dependents', () => {
    const features = [
      f('F-1', 'todo'), // in-flight
      f('F-2', 'todo', { blockedBy: ['F-1'] }),
    ];
    const owned = new Set(['F-1']);
    const r = computeFrontier(features, NO_PLANS, owned, 4);
    expect(r.toStart).toEqual([]); // F-1 owned, F-2 blocked by non-terminal F-1
  });

  test('stuck = work remains but nothing is ready (all blocked/failing)', () => {
    const features = [
      f('F-1', 'failing'),
      f('F-2', 'todo', { blockedBy: ['F-1'] }),
    ];
    // F-1 is ready (failing = needs-work, unblocked) → NOT stuck.
    expect(computeFrontier(features, NO_PLANS, NONE, 0).stuck).toBe(false);
    // Now F-1 in-flight (owned) and F-2 blocked by it → nothing ready, work remains.
    expect(computeFrontier(features, NO_PLANS, new Set(['F-1']), 4).stuck).toBe(true);
  });

  test('not stuck when ready features exist but slots are full', () => {
    const features = [f('F-1', 'todo')];
    expect(computeFrontier(features, NO_PLANS, NONE, 0).stuck).toBe(false);
  });

  // ── blueprint-declared readiness (D-005 / P-006) ─────────────────────────
  test('a declared readiness set replaces the legacy NEEDS_WORK selection', () => {
    const features = [f('F-1', 'todo'), f('F-2', 'failing'), f('F-3', 'pending')];
    // narrowed to todo-only: failing/pending are no longer dispatchable.
    expect(computeFrontier(features, NO_PLANS, NONE, 10, new Set(['todo'])).toStart).toEqual(['F-1']);
  });

  test('omitting readiness keeps the legacy selection byte-identical (default param)', () => {
    const features = [f('F-1', 'todo'), f('F-2', 'failing'), f('F-3', 'pending'), f('F-4', 'failed')];
    expect(computeFrontier(features, NO_PLANS, NONE, 10).toStart).toEqual(
      computeFrontier(features, NO_PLANS, NONE, 10, new Set(['todo', 'failing', 'pending', 'failed'])).toStart,
    );
  });

  test('the stuck signal respects the declared readiness too', () => {
    // F-1 is failing — under todo-only readiness there is NO pending work at
    // all, so the frontier is empty but NOT stuck.
    const features = [f('F-1', 'failing')];
    expect(computeFrontier(features, NO_PLANS, NONE, 4, new Set(['todo']))).toEqual({
      toStart: [],
      stuck: false,
    });
  });
});

describe('isOverdue — deadline comparison (handles both ISO strings and Date objects)', () => {
  test('returns false for future deadline as ISO string', () => {
    const futureDate = new Date(Date.now() + 1000 * 60 * 60); // 1 hour in the future
    expect(isOverdue(futureDate.toISOString())).toBe(false);
  });

  test('returns false for future deadline as Date object', () => {
    const futureDate = new Date(Date.now() + 1000 * 60 * 60); // 1 hour in the future
    expect(isOverdue(futureDate)).toBe(false);
  });

  test('returns true for past deadline as ISO string', () => {
    const pastDate = new Date(Date.now() - 1000 * 60 * 60); // 1 hour in the past
    expect(isOverdue(pastDate.toISOString())).toBe(true);
  });

  test('returns true for past deadline as Date object', () => {
    const pastDate = new Date(Date.now() - 1000 * 60 * 60); // 1 hour in the past
    expect(isOverdue(pastDate)).toBe(true);
  });

  test('correctly compares deadline times without type mismatch', () => {
    // This test ensures the bug is fixed: comparing ISO string with Date object
    // should work correctly by converting to the same type first
    const now = new Date();
    const pastISOString = new Date(now.getTime() - 5000).toISOString();
    const futureDate = new Date(now.getTime() + 5000);

    expect(isOverdue(pastISOString)).toBe(true);
    expect(isOverdue(futureDate)).toBe(false);
  });
});

describe('harnessDispatchesLocally — deployment placement gate (cloud-deployment P-004)', () => {
  const remoteDriver: DeploymentDriver = {
    target: 'latitude',
    placement: 'remote',
    async provision(): Promise<Frame> {
      return { id: 'lat-1', target: 'latitude', placement: 'remote' };
    },
    async install() {},
    async join() {},
    async teardown() {},
  };

  // Reset BEFORE each test: orchestrator-loop's module load registers LatitudeDriver
  // (via ../deployment/configure), so start each test from a known local-only registry.
  beforeEach(() => _resetDeploymentDriversForTests());

  test('null project (slug not in this workspace) → dispatches locally', () => {
    expect(harnessDispatchesLocally(null)).toBe(true);
  });

  test('no deployment field (every existing harness) → dispatches locally', () => {
    expect(harnessDispatchesLocally({})).toBe(true);
    expect(harnessDispatchesLocally({ deployment: undefined })).toBe(true);
  });

  test('explicit local deployment → dispatches locally', () => {
    expect(harnessDispatchesLocally({ deployment: { target: 'local' } })).toBe(true);
  });

  test('a registered remote driver → the local orchestrator skips it (frame owns dispatch)', () => {
    registerDeploymentDriver(remoteDriver);
    expect(harnessDispatchesLocally({ deployment: { target: 'latitude', region: 'NYC' } })).toBe(false);
  });

  test('a non-local target with NO registered driver → conservatively dispatches locally', () => {
    // No driver wired up yet → never silently route work to a frame that isn't there.
    expect(harnessDispatchesLocally({ deployment: { target: 'latitude' } })).toBe(true);
  });
});
