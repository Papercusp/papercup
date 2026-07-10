/**
 * scale-policy.test.ts — the accounts:scale_policy TOOL (live-configurability-audit P-006).
 *
 * Mocks the policy helper + control harness. Asserts: get reads · set is operator-gated ·
 * set requires a field · a valid patch applies + verifies · dryRun does not write.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/accounts/scale-policy.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../scale-policy', () => ({
  readScalePolicy: vi.fn(),
  writeScalePolicy: vi.fn(),
}));
vi.mock('../../gateway-control/control-harness', () => ({
  runControlMutation: vi.fn(async (spec: any, opts: any = {}) => {
    const prev = await spec.capturePrev();
    if (opts.dryRun) return { dryRun: true, applied: false, prev, preview: spec.describe?.(prev) };
    const next = await spec.apply();
    const verify = spec.verify ? await spec.verify(next) : undefined;
    return { dryRun: false, applied: true, prev, next, verify, auditId: 'aud-1' };
  }),
}));

import { readScalePolicy, writeScalePolicy } from '../../scale-policy';
const readM = vi.mocked(readScalePolicy);
const writeM = vi.mocked(writeScalePolicy);

const tool = (await import('./scale-policy')).default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);
const DEF = { windowMs: 900_000, sustainedPenaltyThreshold: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  readM.mockResolvedValue({ ...DEF });
  writeM.mockImplementation(async (patch) => ({ ...DEF, ...patch }) as never);
});

describe('accounts:scale_policy', () => {
  it('get returns the policy', async () => {
    const b = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
    expect(b).toEqual({ policy: DEF });
  });

  it('is operator-authority gated', async () => {
    await expect(
      tool.handler({ op: 'set', sustainedPenaltyThreshold: 5 } as never, { role: 'cup' } as never),
    ).rejects.toThrow(/operator, architect, or mug/i);
    expect(writeM).not.toHaveBeenCalled();
  });

  it('requires at least one field', async () => {
    await expect(tool.handler({ op: 'set' } as never, { role: 'operator' } as never)).rejects.toThrow(/at least one/i);
  });

  it('applies a valid patch and verifies', async () => {
    const b = body(await tool.handler({ op: 'set', sustainedPenaltyThreshold: 5 } as never, { role: 'operator' } as never));
    expect(writeM).toHaveBeenCalledWith({ sustainedPenaltyThreshold: 5 });
    expect(b).toMatchObject({ ok: true, applied: true, verify: { ok: true }, next: { sustainedPenaltyThreshold: 5 } });
  });

  it('dryRun does not write', async () => {
    const b = body(
      await tool.handler({ op: 'set', windowMs: 600_000, dryRun: true } as never, { role: 'operator' } as never),
    );
    expect(writeM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ dryRun: true, applied: false });
  });
});
