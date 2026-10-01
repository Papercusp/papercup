/**
 * governor-arm.test.ts — the governor:arm TOOL (self-learning-public-release-readiness P-011).
 *
 * Mocks the governor store + control harness. Asserts: operator-gated · requires a field ·
 * refuses an unknown loopId (existing lanes only) · applies enable/budget + verifies ·
 * dryRun does not write.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/learning/governor-arm.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../learning-governor/store', () => ({
  getLearningLoop: vi.fn(),
  registerLearningLoop: vi.fn(),
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

import { getLearningLoop, registerLearningLoop } from '../../learning-governor/store';

const getM = vi.mocked(getLearningLoop);
const regM = vi.mocked(registerLearningLoop);

const tool = (await import('./governor-arm')).default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

const LANE = {
  workspaceId: 'ws-1', loopId: 'red-queen', potSlug: 'papercusp', displayName: 'Red Queen',
  budgetKind: 'lifetime', budgetUsd: 25, spentUsd: 3, priority: 100, enabled: true, enforcement: 'governor', meta: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  getM.mockResolvedValue({ ...LANE } as never);
  regM.mockResolvedValue({ ...LANE } as never);
});

describe('governor:arm', () => {
  it('is operator-authority gated', async () => {
    await expect(tool.handler({ loopId: 'red-queen', enabled: false } as never, { role: 'cup' } as never)).rejects.toThrow(
      /operator, architect, or mug/i,
    );
    expect(regM).not.toHaveBeenCalled();
  });

  it('requires enabled and/or budgetUsd', async () => {
    await expect(tool.handler({ loopId: 'red-queen' } as never, { role: 'operator' } as never)).rejects.toThrow(
      /enabled and\/or budgetUsd/i,
    );
  });

  it('rejects dryRun-only calls at argument validation', () => {
    const dryRunOnly = tool.args.safeParse({ loopId: 'red-queen', dryRun: true });
    expect(dryRunOnly.success).toBe(false);
    if (!dryRunOnly.success) expect(dryRunOnly.error.issues[0]?.message).toMatch(/enabled and\/or budgetUsd/i);
    expect(tool.args.safeParse({ loopId: 'red-queen', enabled: false, dryRun: true }).success).toBe(true);
    expect(tool.args.safeParse({ loopId: 'red-queen', budgetUsd: null, dryRun: true }).success).toBe(true);
  });

  it('refuses an unknown loopId — existing lanes only', async () => {
    getM.mockResolvedValue(null as never);
    await expect(
      tool.handler({ loopId: 'no-such-lane', enabled: true } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/EXISTING lanes only/i);
    expect(regM).not.toHaveBeenCalled();
  });

  it('applies enable + budget and verifies', async () => {
    getM.mockResolvedValue({ ...LANE, enabled: false, budgetUsd: 10 } as never); // prev read
    const afterWrite = { ...LANE, enabled: false, budgetUsd: 10 };
    regM.mockImplementation(async () => {
      // Subsequent reads reflect the write.
      getM.mockResolvedValue({ ...LANE, enabled: false, budgetUsd: 10 } as never);
      return afterWrite as never;
    });
    const b = body(
      await tool.handler({ loopId: 'red-queen', enabled: false, budgetUsd: 10 } as never, { role: 'operator' } as never),
    );
    expect(regM).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: 'ws-1', loopId: 'red-queen', enabled: false, budgetUsd: 10,
    });
    expect(b).toMatchObject({ ok: true, applied: true, loopId: 'red-queen', verify: { ok: true } });
  });

  it('dryRun does not write', async () => {
    const b = body(
      await tool.handler({ loopId: 'red-queen', budgetUsd: 99, dryRun: true } as never, { role: 'operator' } as never),
    );
    expect(regM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ dryRun: true, applied: false });
  });
});
