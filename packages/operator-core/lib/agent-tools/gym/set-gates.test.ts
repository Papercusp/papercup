/**
 * set-gates.test.ts — the gym:set-gates TOOL (live-configurability-audit P-012).
 *
 * Mocks the gym-gates helper + control harness. Asserts: get reads · set is operator-gated ·
 * set requires a field · a valid patch applies + verifies · dryRun does not write.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/gym/set-gates.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../gym-gates', () => ({
  readGymGates: vi.fn(),
  writeGymGates: vi.fn(),
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

import { readGymGates, writeGymGates } from '../../gym-gates';
const readM = vi.mocked(readGymGates);
const writeM = vi.mocked(writeGymGates);

const tool = (await import('./set-gates')).default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);
const DEF = { epsilon: 0.1, delta: 0.5, costCeiling: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  readM.mockResolvedValue({ ...DEF });
  writeM.mockImplementation(async (_h, patch) => ({ ...DEF, ...patch }) as never);
});

describe('gym:set-gates', () => {
  it('get returns the harness gates', async () => {
    const b = body(await tool.handler({ op: 'get', harness: 'h' } as never, { role: 'su' } as never));
    expect(b).toEqual({ harness: 'h', gates: DEF });
  });

  it('is operator-authority gated', async () => {
    await expect(
      tool.handler({ op: 'set', harness: 'h', epsilon: 0.2 } as never, { role: 'bee' } as never),
    ).rejects.toThrow(/operator, architect, or queen/i);
    expect(writeM).not.toHaveBeenCalled();
  });

  it('requires at least one field', async () => {
    await expect(tool.handler({ op: 'set', harness: 'h' } as never, { role: 'operator' } as never)).rejects.toThrow(/at least one/i);
  });

  it('applies a valid patch and verifies', async () => {
    const b = body(await tool.handler({ op: 'set', harness: 'h', epsilon: 0.2, costCeiling: 5 } as never, { role: 'operator' } as never));
    expect(writeM).toHaveBeenCalledWith('h', { epsilon: 0.2, costCeiling: 5 });
    expect(b).toMatchObject({ ok: true, applied: true, verify: { ok: true }, harness: 'h' });
  });

  it('dryRun does not write', async () => {
    const b = body(await tool.handler({ op: 'set', harness: 'h', delta: 0.7, dryRun: true } as never, { role: 'operator' } as never));
    expect(writeM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ dryRun: true, applied: false });
  });
});
