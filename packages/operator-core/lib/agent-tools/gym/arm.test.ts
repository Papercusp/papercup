/**
 * arm.test.ts — the gym:arm TOOL (self-learning-public-release-readiness P-011).
 *
 * Mocks the control-plane + governor store + control harness. Asserts: operator-gated ·
 * requires a field · arming writes BOTH layers (autoloop config + gym:<slug> governor row)
 * with the same enabled/budget · verify reads both back · dryRun does not write.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/gym/arm.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../gym/control-plane', () => ({
  getAutoloop: vi.fn(),
  setAutoloop: vi.fn(),
}));
vi.mock('../../learning-governor/store', () => ({
  getLearningLoop: vi.fn(),
  registerLearningLoop: vi.fn(),
}));
vi.mock('../../learning-governor/core', () => ({
  gymLoopId: (slug: string) => `gym:${slug}`,
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-1' }));
// Partial mock: agent-mcp (defineTool's home) also imports `generated` from
// db-org, so a full module mock breaks its bootstrap — override getOrgPg only.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));
vi.mock('../../gateway-control/control-harness', () => ({
  runControlMutation: vi.fn(async (spec: any, opts: any = {}) => {
    const prev = await spec.capturePrev();
    if (opts.dryRun) return { dryRun: true, applied: false, prev, preview: spec.describe?.(prev) };
    const next = await spec.apply();
    const verify = spec.verify ? await spec.verify(next) : undefined;
    return { dryRun: false, applied: true, prev, next, verify, auditId: 'aud-1' };
  }),
}));

import { getAutoloop, setAutoloop } from '../../gym/control-plane';
import { getLearningLoop, registerLearningLoop } from '../../learning-governor/store';

const getAutoM = vi.mocked(getAutoloop);
const setAutoM = vi.mocked(setAutoloop);
const getLoopM = vi.mocked(getLearningLoop);
const regLoopM = vi.mocked(registerLearningLoop);

const tool = (await import('./arm')).default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

const AUTO_ARMED = {
  workspaceId: 'ws-1', harnessSlug: 'papercusp', enabled: true, budgetUsd: 50,
  spentUsd: 0, status: 'idle', lastCycle: null, lastCycleAt: null, updatedAt: 1,
};
const LOOP_ARMED = {
  workspaceId: 'ws-1', loopId: 'gym:papercusp', potSlug: 'papercusp', displayName: 'Gym autoloop (papercusp)',
  budgetKind: 'lifetime', budgetUsd: 50, spentUsd: 0, priority: 100, enabled: true, enforcement: 'native', meta: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  getAutoM.mockResolvedValue({ ...AUTO_ARMED } as never);
  getLoopM.mockResolvedValue({ ...LOOP_ARMED } as never);
  setAutoM.mockResolvedValue({ ...AUTO_ARMED } as never);
  regLoopM.mockResolvedValue({ ...LOOP_ARMED } as never);
});

describe('gym:arm', () => {
  it('is operator-authority gated', async () => {
    await expect(
      tool.handler({ harness: 'papercusp', enabled: true } as never, { role: 'cup' } as never),
    ).rejects.toThrow(/operator, architect, or mug/i);
    expect(setAutoM).not.toHaveBeenCalled();
    expect(regLoopM).not.toHaveBeenCalled();
  });

  it('requires enabled and/or budgetUsd', async () => {
    await expect(tool.handler({ harness: 'papercusp' } as never, { role: 'operator' } as never)).rejects.toThrow(
      /enabled and\/or budgetUsd/i,
    );
  });

  it('rejects dryRun-only calls at argument validation', () => {
    const dryRunOnly = tool.args.safeParse({ harness: 'papercusp', dryRun: true });
    expect(dryRunOnly.success).toBe(false);
    if (!dryRunOnly.success) expect(dryRunOnly.error.issues[0]?.message).toMatch(/enabled and\/or budgetUsd/i);
    expect(tool.args.safeParse({ harness: 'papercusp', enabled: false, dryRun: true }).success).toBe(true);
    expect(tool.args.safeParse({ harness: 'papercusp', budgetUsd: null, dryRun: true }).success).toBe(true);
  });

  it('arming writes BOTH layers with the same state and verifies', async () => {
    const b = body(
      await tool.handler({ harness: 'papercusp', enabled: true, budgetUsd: 50 } as never, { role: 'operator' } as never),
    );
    expect(setAutoM).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: 'ws-1', harnessSlug: 'papercusp', enabled: true, budgetUsd: 50,
    });
    expect(regLoopM).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: 'ws-1', loopId: 'gym:papercusp', potSlug: 'papercusp',
      displayName: 'Gym autoloop (papercusp)', enabled: true, budgetUsd: 50,
    });
    expect(b).toMatchObject({ ok: true, applied: true, harness: 'papercusp', loopId: 'gym:papercusp', verify: { ok: true } });
  });

  it('verify fails when a layer did not take the change', async () => {
    // Governor row stays disarmed after apply — the drift this tool exists to prevent.
    getLoopM.mockResolvedValue({ ...LOOP_ARMED, enabled: false } as never);
    const b = body(await tool.handler({ harness: 'papercusp', enabled: true } as never, { role: 'operator' } as never));
    expect(b.verify).toMatchObject({ ok: false });
  });

  it('dryRun does not write either layer', async () => {
    const b = body(
      await tool.handler({ harness: 'papercusp', enabled: false, dryRun: true } as never, { role: 'operator' } as never),
    );
    expect(setAutoM).not.toHaveBeenCalled();
    expect(regLoopM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ dryRun: true, applied: false });
  });
});
