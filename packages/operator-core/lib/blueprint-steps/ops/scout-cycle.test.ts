/**
 * Unit coverage for the `blender:cycle` CoordOp wrapper (scout-cycle.ts). The cycle
 * runner (runScoutCycleTick, scout/register-scout-action.test.ts) is tested
 * separately and mocked here; injecting non-null deps via setScoutCycleDeps also
 * keeps the op off its lazy production-deps import (no llm/cycle graph). Under test
 * is THIS file's surface: the workspaceId guard, the tick→result projection
 * (fired/reason + the optional cycleId/routedCount/costUsd/retryAfterSec/error),
 * installSlug default, the payloadTemplate threading, and registration.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/blueprint-steps/ops/scout-cycle.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { registerCoordOp, runScoutCycleTick } = vi.hoisted(() => ({
  registerCoordOp: vi.fn(),
  runScoutCycleTick: vi.fn(),
}));
const { isWorkspaceCoordinationOn } = vi.hoisted(() => ({
  isWorkspaceCoordinationOn: vi.fn(async () => false),
}));
vi.mock('../../coord-ops/registry.js', () => ({ registerCoordOp }));
vi.mock('../../scout/run.js', () => ({ runScoutCycleTick }));

// WI-5785 (P-051 regression): mocks for the LAZY production-deps path (used only by
// the "lazy production deps" describe block below, which never calls setScoutCycleDeps).
const { registerScoutAction, registrants, hiveSingleRunner, scoutCeiling, admissionPromoter } = vi.hoisted(() => ({
  registerScoutAction: { productionScoutRunner: vi.fn() },
  registrants: { recordScoutTickToGovernor: vi.fn() },
  hiveSingleRunner: { checkHiveSingleRunner: vi.fn().mockResolvedValue({ run: true }) },
  scoutCeiling: { scoutWorkspaceCeilingGate: vi.fn() },
  admissionPromoter: { readWorkItemAdmissionProducerPressure: vi.fn() },
}));
vi.mock('../../scout/register-scout-action.js', () => registerScoutAction);
vi.mock('../../learning-governor/registrants.js', () => registrants);
vi.mock('../../hive-single-runner.js', () => hiveSingleRunner);
vi.mock('../../learning-governor/scout-ceiling.js', () => scoutCeiling);
vi.mock('../../work-items-admission-promoter.js', () => admissionPromoter);

// Pin WORKSPACE_COORDINATION OFF so the installSlug assertion exercises the
// per-hive default (`ctx.harnessSlug ?? 'op'`) this test was written for, rather
// than the workspace-sentinel collapse the ON default (graduated 2026-06-23) maps
// it to. Keep the pure workspaceBrainScopeKey real so the threading is still real.
vi.mock('../../workspace-brain-scope.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isWorkspaceCoordinationOn };
});

import { scoutCycleOp, setScoutCycleDeps } from './scout-cycle';

const ctx = (over: Record<string, unknown> = {}) => ({ workspaceId: 'ws-1', harnessSlug: 'h1', log: vi.fn(), ...over });
const fakeDeps = { runCycle: vi.fn(), recordGovernor: vi.fn(), hiveRunnerGate: vi.fn() };

afterEach(() => {
  runScoutCycleTick.mockReset();
  isWorkspaceCoordinationOn.mockReset().mockResolvedValue(false);
  setScoutCycleDeps(null);
});

describe('scoutCycleOp metadata', () => {
  it('declares its name + schemas and is registered on import', () => {
    expect(scoutCycleOp.name).toBe('blender:cycle');
    expect(scoutCycleOp.argsSchema.safeParse({}).success).toBe(true);
    expect(registerCoordOp).toHaveBeenCalledWith(scoutCycleOp);
  });
});

describe('scoutCycleOp.run', () => {
  it('throws without a workspaceId', async () => {
    setScoutCycleDeps(fakeDeps as never);
    await expect(scoutCycleOp.run({}, ctx({ workspaceId: undefined }) as never)).rejects.toThrow(/workspaceId/);
  });

  it('a fired cycle projects all tick fields', async () => {
    setScoutCycleDeps(fakeDeps as never);
    runScoutCycleTick.mockResolvedValue({
      fired: true,
      reason: 'idle+friction',
      cycleId: 'cyc-1',
      routedCount: 3,
      costUsd: 0.4,
    });
    const r = await scoutCycleOp.run({}, ctx() as never);
    expect(r).toEqual({
      fired: true,
      reason: 'idle+friction',
      cycleId: 'cyc-1',
      routedCount: 3,
      costUsd: 0.4,
      retryAfterSec: undefined,
      error: undefined,
    });
  });

  it('a withheld cycle passes through reason + retryAfterSec (no cycleId)', async () => {
    setScoutCycleDeps(fakeDeps as never);
    runScoutCycleTick.mockResolvedValue({ fired: false, reason: 'too-soon', retryAfterSec: 120 });
    const r = await scoutCycleOp.run({}, ctx() as never);
    expect(r).toMatchObject({ fired: false, reason: 'too-soon', retryAfterSec: 120 });
    expect(r.cycleId).toBeUndefined();
    expect(r.routedCount).toBeUndefined();
  });

  it('threads payloadTemplate + injected deps and defaults installSlug to "op"', async () => {
    setScoutCycleDeps(fakeDeps as never);
    runScoutCycleTick.mockResolvedValue({ fired: false, reason: 'too-soon' });
    const payload = { budget: { maxCostUsd: 1 } };
    await scoutCycleOp.run(payload, ctx({ harnessSlug: undefined }) as never);
    const [arg0, arg1] = runScoutCycleTick.mock.calls[0];
    expect(arg0).toEqual({
      workspaceId: 'ws-1',
      installSlug: 'op',
      admissionQueueScope: { kind: 'harness', harnessSlug: 'op' },
      payloadTemplate: payload,
    });
    expect(arg1).toBe(fakeDeps);
  });

  it('keeps the workspace tick sentinel separate from workspace-wide queue health', async () => {
    isWorkspaceCoordinationOn.mockResolvedValueOnce(true);
    setScoutCycleDeps(fakeDeps as never);
    runScoutCycleTick.mockResolvedValue({ fired: false, reason: 'too-soon' });
    await scoutCycleOp.run({}, ctx() as never);
    expect(runScoutCycleTick.mock.calls[0][0]).toEqual({
      workspaceId: 'ws-1',
      installSlug: 'ws-1',
      admissionQueueScope: { kind: 'workspace' },
      payloadTemplate: {},
    });
  });

  it('declares and threads cycleTimeoutMs through the routine payload', async () => {
    setScoutCycleDeps(fakeDeps as never);
    runScoutCycleTick.mockResolvedValue({ fired: false, reason: 'cycle-error', error: 'timeout' });
    const payload = { cycleTimeoutMs: 2500 };
    await scoutCycleOp.run(payload, ctx() as never);
    expect(runScoutCycleTick.mock.calls[0][0]).toMatchObject({ payloadTemplate: payload });
  });

  it('logs fired + reason via ctx.log', async () => {
    setScoutCycleDeps(fakeDeps as never);
    runScoutCycleTick.mockResolvedValue({ fired: true, reason: 'idle', cycleId: 'c', routedCount: 1 });
    const c = ctx();
    await scoutCycleOp.run({}, c as never);
    expect(c.log).toHaveBeenCalledWith(expect.stringMatching(/blender:cycle fired=true reason=idle/));
  });
});

// WI-5785 (P-051 regression): the LAZY production-deps path (no test deps injected)
// is exactly the path that ran in production unwired for the workspace-wide scout
// ceiling — the tests above all inject fakeDeps and so never exercised it. Cover the
// lazy-build branch directly to pin the wiring so it can't silently drop again.
describe('scoutCycleOp lazy production deps (WI-5785)', () => {
  it('wires spend and admission-pressure gates into the deps runScoutCycleTick receives', async () => {
    runScoutCycleTick.mockResolvedValue({ fired: false, reason: 'too-soon' });
    await scoutCycleOp.run({}, ctx() as never);
    const [, deps] = runScoutCycleTick.mock.calls[0];
    expect(deps.runCycle).toBe(registerScoutAction.productionScoutRunner);
    expect(deps.recordGovernor).toBe(registrants.recordScoutTickToGovernor);
    expect(typeof deps.hiveRunnerGate).toBe('function');
    expect(deps.workspaceCeilingGate).toBe(scoutCeiling.scoutWorkspaceCeilingGate);
    expect(deps.admissionPressureGate).toBe(admissionPromoter.readWorkItemAdmissionProducerPressure);
  });
});
