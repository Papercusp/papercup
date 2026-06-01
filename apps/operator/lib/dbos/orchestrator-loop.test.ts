import { describe, test, expect, vi, afterEach } from 'vitest';

// Control the workspace registry for orchestratorWorkspaceIds (P-020). Only
// readRegistry + activeWorkspaceId are consumed by orchestrator-loop here.
vi.mock('@/lib/workspace-registry', () => ({
  activeWorkspaceId: () => 'global-ws',
  readRegistry: () => ({
    current: 'global-ws',
    workspaces: [{ id: 'ws-a' }, { id: 'ws-b' }, { id: 'ws-c' }],
  }),
}));

import {
  selectFeaturesToDispatch,
  resolveOrchestratorHarnesses,
  shouldScheduleOrchestrator,
  resolvePerHarnessCap,
  orchestratorWorkspaceIds,
} from './orchestrator-loop';

const f = (id: string, status: string) => ({ id, status });

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

describe('selectFeaturesToDispatch', () => {
  test('empty eligible → nothing', () => {
    expect(selectFeaturesToDispatch([], 0, 4)).toEqual([]);
  });

  test('picks only needs-work statuses (todo/failing + pending/failed aliases)', () => {
    const eligible = [
      f('F-1', 'todo'),
      f('F-2', 'in_progress'),
      f('F-3', 'failing'),
      f('F-4', 'passed'),
      f('F-5', 'blocked'),
      f('F-6', 'pending'),
      f('F-7', 'failed'),
      f('F-8', 'deprecated'),
    ];
    expect(selectFeaturesToDispatch(eligible, 0, 10)).toEqual(['F-1', 'F-3', 'F-6', 'F-7']);
  });

  test('bounded by free slots (cap - liveCount)', () => {
    const eligible = [f('F-1', 'pending'), f('F-2', 'pending'), f('F-3', 'failed')];
    expect(selectFeaturesToDispatch(eligible, 0, 2)).toEqual(['F-1', 'F-2']); // 2 free slots
    expect(selectFeaturesToDispatch(eligible, 1, 2)).toEqual(['F-1']); // 1 free slot
  });

  test('cap already reached → nothing started', () => {
    const eligible = [f('F-1', 'pending')];
    expect(selectFeaturesToDispatch(eligible, 4, 4)).toEqual([]);
    expect(selectFeaturesToDispatch(eligible, 5, 4)).toEqual([]); // over cap
  });

  test('preserves order, slices to slots', () => {
    const eligible = [f('F-9', 'failed'), f('F-1', 'pending'), f('F-5', 'pending')];
    expect(selectFeaturesToDispatch(eligible, 0, 2)).toEqual(['F-9', 'F-1']);
  });

  test('over cost cap → dispatch nothing, regardless of eligible work (P-004)', () => {
    const eligible = [f('F-1', 'todo'), f('F-2', 'failing')];
    expect(selectFeaturesToDispatch(eligible, 0, 4, /* overCostCap */ true)).toEqual([]);
  });

  test('under cost cap → unchanged selection', () => {
    const eligible = [f('F-1', 'todo')];
    expect(selectFeaturesToDispatch(eligible, 0, 4, /* overCostCap */ false)).toEqual(['F-1']);
  });
});
