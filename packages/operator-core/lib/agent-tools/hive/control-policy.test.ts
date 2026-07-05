/**
 * control-policy.test.ts — the pot:control_policy TOOL (live-configurability-audit P-015).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/hive/control-policy.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../hive-control-policy', () => ({
  readHiveControlPolicy: vi.fn(),
  writeHiveControlPolicy: vi.fn(),
  setHiveControlPolicy: vi.fn(),
  HIVE_CONTROL_DEFAULTS: { breakerThreshold: 3, recoveryDebounceMs: 300_000, dormancyGraceMs: 600_000, infraBreakerThreshold: 12 },
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

import { readHiveControlPolicy, writeHiveControlPolicy } from '../../hive-control-policy';
const readM = vi.mocked(readHiveControlPolicy);
const writeM = vi.mocked(writeHiveControlPolicy);
const tool = (await import('./control-policy')).default;
type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  readM.mockResolvedValue({});
  writeM.mockImplementation(async (patch) => ({ ...patch }) as never);
});

describe('pot:control_policy', () => {
  it('get returns effective (defaults when unset) + overrides', async () => {
    const b = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
    expect(b).toMatchObject({ effective: { breakerThreshold: 3, infraBreakerThreshold: 12 }, overrides: {} });
  });
  it('is operator-authority gated', async () => {
    await expect(tool.handler({ op: 'set', breakerThreshold: 5 } as never, { role: 'cup' } as never)).rejects.toThrow(/operator, architect, or queen/i);
    expect(writeM).not.toHaveBeenCalled();
  });
  it('requires at least one field', async () => {
    await expect(tool.handler({ op: 'set' } as never, { role: 'operator' } as never)).rejects.toThrow(/at least one/i);
  });
  it('applies a valid patch and verifies', async () => {
    const b = body(await tool.handler({ op: 'set', breakerThreshold: 5, recoveryDebounceMs: 120_000 } as never, { role: 'operator' } as never));
    expect(writeM).toHaveBeenCalledWith({ breakerThreshold: 5, recoveryDebounceMs: 120_000 });
    expect(b).toMatchObject({ ok: true, applied: true, verify: { ok: true } });
  });
  it('dryRun does not write', async () => {
    const b = body(await tool.handler({ op: 'set', breakerThreshold: 9, dryRun: true } as never, { role: 'operator' } as never));
    expect(writeM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ dryRun: true, applied: false });
  });
});
