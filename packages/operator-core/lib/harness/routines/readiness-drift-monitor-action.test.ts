/**
 * readiness-drift-monitor-action.test.ts — the WIRING of the two sweeps this action runs
 * (work-item-dependency-edges-2026-08-02, EI-19325959789634791 / D-017 step 2).
 *
 * The detectors themselves are proven against real Postgres in their own integration tests
 * (readiness-reconcile.integration.test.ts, work-item-deps-integrity.integration.test.ts).
 * What CANNOT be proven there — and is the actual regression risk — is that the action
 * calls them at all, and under the right conditions. This file pins exactly that.
 *
 * The pin that matters most: the endpoint sweep must run EVEN WHEN readiness drift is 0.
 * The readiness sweep early-returns on drift=0, and that is the overwhelmingly common tick
 * (papercusp logged drift=0 hourly through 2026-08-02). Moving the endpoint call below that
 * return — an easy, innocent-looking edit — would silently disable it forever while the log
 * kept printing a reassuring green line. That is precisely the failure mode this whole plan
 * exists to prevent: a detector nobody runs is not a safety net, it is a comment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const reconcileReadinessMock = vi.fn();
const reconcileEndpointsMock = vi.fn();
const reconcileGraphPolicyMock = vi.fn();

vi.mock('../../scheduler/readiness-reconcile', () => ({
  reconcileReadiness: () => reconcileReadinessMock(),
}));
vi.mock('../../scheduler/work-item-deps-integrity', () => ({
  reconcileWorkItemDepEndpoints: () => reconcileEndpointsMock(),
  reconcileDependencyGraphPolicy: () => reconcileGraphPolicyMock(),
}));

import './readiness-drift-monitor-action';
import { getSystemAction, type SystemActionCtx } from './system-actions';

const ctx = (payloadTemplate: Record<string, unknown> | null = null): SystemActionCtx => ({
  installSlug: 'papercusp',
  workspaceId: 'ws-test',
  triggerConfig: {},
  payloadTemplate,
});

const CLEAN_READINESS = { drift: 0, missing: [], extra: [] };
const CLEAN_ENDPOINTS = { defects: 0, mismatched: [], dangling: [] };
const CLEAN_GRAPH_POLICY = {
  workspaces: [],
  nodes: 0,
  edges: 0,
  findings: [],
  hardBlocks: 0,
  advisories: 0,
  strandedNodes: 0,
  telemetry: {
    schemaVersion: 'dependency-graph-performance-v1',
    operation: 'census',
    durationMs: 12.3,
    budgetMs: 5_000,
    budgetStatus: 'within-budget',
    nodes: 0,
    edges: 0,
    scaleBaseline: { nodes: 130_000, edges: 1_500 },
  },
};

const run = async (payloadTemplate: Record<string, unknown> | null = null) => {
  const action = getSystemAction('readiness-drift-monitor');
  expect(action, 'the action must be registered by importing the module').toBeTruthy();
  await action!(ctx(payloadTemplate));
};

// This action's whole output surface is the operator log, so every tick writes to
// console. The repo fails a test on unexpected console output (vitest-fail-on-console),
// so the spies are installed for ALL tests — and the defect test reads its assertions
// off `warnSpy` rather than installing a second, competing spy.
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  reconcileReadinessMock.mockResolvedValue(CLEAN_READINESS);
  reconcileEndpointsMock.mockResolvedValue(CLEAN_ENDPOINTS);
  reconcileGraphPolicyMock.mockResolvedValue(CLEAN_GRAPH_POLICY);
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe('system:readiness-drift-monitor — sweep wiring', () => {
  it('runs BOTH sweeps on a clean tick — the endpoint sweep is not gated behind readiness drift', async () => {
    await run();
    expect(reconcileReadinessMock).toHaveBeenCalledTimes(1);
    // The load-bearing assertion. drift=0 early-returns the readiness sweep; the endpoint
    // sweep must still have run.
    expect(reconcileEndpointsMock).toHaveBeenCalledTimes(1);
    expect(reconcileGraphPolicyMock).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/durationMs=12\.3.*budgetStatus=within-budget/));
  });

  it('still runs the endpoint sweep when the readiness sweep THROWS', async () => {
    // The two answer different questions, so one being broken must not blind the other.
    reconcileReadinessMock.mockRejectedValue(new Error('oracle exploded'));
    await expect(run()).resolves.toBeUndefined(); // a monitor must never wedge the tick
    expect(reconcileEndpointsMock).toHaveBeenCalledTimes(1);
  });

  it('still runs the readiness sweep when the ENDPOINT sweep throws', async () => {
    reconcileEndpointsMock.mockRejectedValue(new Error('endpoint sweep exploded'));
    await expect(run()).resolves.toBeUndefined();
    expect(reconcileReadinessMock).toHaveBeenCalled();
  });

  it('still runs readiness and endpoint sweeps when the GRAPH POLICY sweep throws', async () => {
    reconcileGraphPolicyMock.mockRejectedValue(new Error('graph policy exploded'));
    await expect(run()).resolves.toBeUndefined();
    expect(reconcileReadinessMock).toHaveBeenCalledTimes(1);
    expect(reconcileEndpointsMock).toHaveBeenCalledTimes(1);
  });

  it('reports graph-policy findings without mutating intent', async () => {
    reconcileGraphPolicyMock.mockResolvedValue({
      workspaces: [
        { workspaceId: 'default', nodes: 2, edges: 2, findings: [{ code: 'cycle', classification: 'hard-block' }] },
      ],
      nodes: 2,
      edges: 2,
      findings: [{ code: 'cycle', classification: 'hard-block' }],
      hardBlocks: 1,
      advisories: 0,
      strandedNodes: 2,
      telemetry: { ...CLEAN_GRAPH_POLICY.telemetry, nodes: 2, edges: 2 },
    });
    await run();
    const logged = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(logged).toContain('DEPENDENCY POLICY FINDINGS');
    expect(logged).toContain('cycle:hard-block');
    expect(logged).toMatch(/detect-only/i);
    expect(reconcileGraphPolicyMock).toHaveBeenCalledTimes(1);
  });

  it('runs the endpoint sweep even with repair disabled — it is detect-only either way', async () => {
    // payload_template.repair=false suppresses READINESS repair. The endpoint sweep never
    // repairs at all, so the flag must not suppress its detection.
    reconcileReadinessMock.mockResolvedValue({
      drift: 1,
      missing: [{ workspace_id: 'default', harness_slug: 'papercup', feature_id: 'F-1' }],
      extra: [],
    });
    await run({ repair: false });
    expect(reconcileEndpointsMock).toHaveBeenCalledTimes(1);
    // Detect-only: exactly one readiness pass, no repair + re-check second pass.
    expect(reconcileReadinessMock).toHaveBeenCalledTimes(1);
  });

  it('reports endpoint defects without attempting any repair of them', async () => {
    reconcileEndpointsMock.mockResolvedValue({
      defects: 1,
      mismatched: [
        {
          relation: 'work_item_deps',
          row_id: '42',
          workspace_id: 'default',
          side: 'blocked',
          declared_kind: 'feature',
          ref: 'papercup#WI-1',
          expected_kind: 'issue',
        },
      ],
      dangling: [],
    });
    await run();

    // `warnSpy` is declared as ReturnType<typeof vi.spyOn> with its generics
    // uninstantiated, so `mock.calls` degrades to any[] and this parameter was an
    // implicit any (TS7006) — invisible to vitest, which never typechecks, but a
    // hard red on the operator-core tsc gate that CI and green-checkpoint DO run.
    // `unknown[]` is deliberately stronger than typing the spy: console.warn's own
    // params are `any`, so a typed spy would still hand back `any` elements, while
    // this forces the String() conversion the assertion already performs.
    const logged = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(logged).toContain('ENDPOINT DEFECTS');
    // Repairable, not merely countable — and the RELATION is part of being repairable:
    // work_item_deps is the mirror (re-run the writer), coord_links is the source (correct
    // the row itself), so a finding that omitted it would name the wrong repair.
    expect(logged).toContain('work_item_deps#42');
    // The finding must say a mismatch means the WRITE SEAM was bypassed — that is the
    // whole diagnostic value, and the reason this sweep does not self-repair.
    expect(logged).toMatch(/bypass/i);
    // And it must be detected exactly once, with no second "did it converge" pass —
    // that pattern belongs to the readiness sweep, which owns repair.
    expect(reconcileEndpointsMock).toHaveBeenCalledTimes(1);
  });
});
