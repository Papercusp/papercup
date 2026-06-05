import { describe, test, expect, vi, afterEach } from 'vitest';

// Control the workspace registry for orchestratorWorkspaceIds (P-020). Only
// readRegistry + activeWorkspaceId are consumed by orchestrator-loop here.
vi.mock('../workspace-registry', () => ({
  activeWorkspaceId: () => 'global-ws',
  readRegistry: () => ({
    current: 'global-ws',
    workspaces: [{ id: 'ws-a' }, { id: 'ws-b' }, { id: 'ws-c' }],
  }),
}));

import {
  computeFrontier,
  resolveOrchestratorHarnesses,
  shouldScheduleOrchestrator,
  resolvePerHarnessCap,
  orchestratorWorkspaceIds,
  type FrontierFeature,
} from './orchestrator-loop';

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
});

describe('orchestratorWorkspaceIds — which workspaces a sweep covers (Phase E P-020)', () => {
  const savedPin = process.env.PAPERCUSP_WORKSPACE_ID;
  const savedShared = process.env.PAPERCUSP_SHARED_OPERATOR;
  afterEach(() => {
    if (savedPin === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = savedPin;
    if (savedShared === undefined) delete process.env.PAPERCUSP_SHARED_OPERATOR;
    else process.env.PAPERCUSP_SHARED_OPERATOR = savedShared;
  });

  test('PAPERCUSP_WORKSPACE_ID pin → just that one (dedicated single-workspace process), even under shared-operator', () => {
    process.env.PAPERCUSP_WORKSPACE_ID = 'pinned-ws';
    process.env.PAPERCUSP_SHARED_OPERATOR = '1';
    expect(orchestratorWorkspaceIds()).toEqual(['pinned-ws']);
  });

  test('shared operator, no pin → EVERY registered workspace (P-020)', () => {
    delete process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_SHARED_OPERATOR = '1';
    expect(orchestratorWorkspaceIds()).toEqual(['ws-a', 'ws-b', 'ws-c']);
  });

  test('dev / legacy (no shared-operator flag) → only the global active workspace (today\'s behavior)', () => {
    delete process.env.PAPERCUSP_WORKSPACE_ID;
    delete process.env.PAPERCUSP_SHARED_OPERATOR;
    expect(orchestratorWorkspaceIds()).toEqual(['global-ws']);
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
});
