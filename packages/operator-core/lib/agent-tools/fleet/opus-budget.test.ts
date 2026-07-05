/**
 * opus-budget.test.ts — the fleet:opus_budget TOOL (live-configurability-audit P-005).
 *
 * Mocks the policy helper + control harness. Asserts: get reads · set is operator-gated ·
 * set requires a field · MONOTONICITY (reserveStart < reserveHard < nearCap < 1) is enforced ·
 * a valid patch applies + verifies · dryRun does not write.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/fleet/opus-budget.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../opus-budget-policy', () => ({
  readOpusBudgetPolicy: vi.fn(),
  writeOpusBudgetPolicy: vi.fn(),
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

import { readOpusBudgetPolicy, writeOpusBudgetPolicy } from '../../opus-budget-policy';
const readM = vi.mocked(readOpusBudgetPolicy);
const writeM = vi.mocked(writeOpusBudgetPolicy);

const tool = (await import('./opus-budget')).default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);
const DEF = { reserveStart: 0.75, reserveHard: 0.88, nearCap: 0.95, staleMs: 600_000 };

beforeEach(() => {
  vi.clearAllMocks();
  readM.mockResolvedValue({ ...DEF });
  writeM.mockImplementation(async (patch) => ({ ...DEF, ...patch }) as never);
});

describe('fleet:opus_budget', () => {
  it('get returns the policy', async () => {
    const b = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
    expect(b).toEqual({ policy: DEF });
  });

  it('is operator-authority gated', async () => {
    await expect(
      tool.handler({ op: 'set', reserveStart: 0.6 } as never, { role: 'cup' } as never),
    ).rejects.toThrow(/operator, architect, or queen/i);
    expect(writeM).not.toHaveBeenCalled();
  });

  it('requires at least one field', async () => {
    await expect(tool.handler({ op: 'set' } as never, { role: 'operator' } as never)).rejects.toThrow(/at least one/i);
  });

  it('enforces monotonicity on the merged policy', async () => {
    // reserveStart 0.9 vs reserveHard 0.88 (existing) → 0.9 < 0.88 false → reject.
    await expect(
      tool.handler({ op: 'set', reserveStart: 0.9 } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/monotonicity/i);
    expect(writeM).not.toHaveBeenCalled();
  });

  it('applies a valid patch and verifies', async () => {
    const b = body(await tool.handler({ op: 'set', reserveStart: 0.6 } as never, { role: 'operator' } as never));
    expect(writeM).toHaveBeenCalledWith({ reserveStart: 0.6 });
    expect(b).toMatchObject({ ok: true, applied: true, verify: { ok: true }, next: { reserveStart: 0.6 } });
  });

  it('dryRun does not write', async () => {
    const b = body(
      await tool.handler({ op: 'set', reserveStart: 0.6, dryRun: true } as never, { role: 'operator' } as never),
    );
    expect(writeM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ dryRun: true, applied: false });
  });
});
