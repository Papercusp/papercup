/**
 * handoff-config.test.ts — the coord:handoff_config TOOL (live-configurability-audit P-014).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/handoff-config.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../coord-liveness-config', () => ({
  readCoordLivenessConfig: vi.fn(),
  writeCoordLivenessConfig: vi.fn(),
  setCoordLivenessConfig: vi.fn(),
  COORD_LIVENESS_DEFAULTS: { handoffTtlMs: 43_200_000, reclaimGraceMs: 600_000, reclaimRequeueCap: 3, sessionReaperGraceMs: 600_000 },
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

import { readCoordLivenessConfig, writeCoordLivenessConfig } from '../../coord-liveness-config';
const readM = vi.mocked(readCoordLivenessConfig);
const writeM = vi.mocked(writeCoordLivenessConfig);
const tool = (await import('./handoff-config')).default;
type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  readM.mockResolvedValue({});
  writeM.mockImplementation(async (patch) => ({ ...patch }) as never);
});

describe('coord:handoff_config', () => {
  it('get returns override (null) + default', async () => {
    const b = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
    expect(b).toEqual({ handoffTtlMs: null, default: 43_200_000 });
  });
  it('is operator-authority gated', async () => {
    await expect(tool.handler({ op: 'set', handoffTtlMs: 3_600_000 } as never, { role: 'cup' } as never)).rejects.toThrow(/operator, architect, or queen/i);
    expect(writeM).not.toHaveBeenCalled();
  });
  it('applies a valid TTL and verifies', async () => {
    const b = body(await tool.handler({ op: 'set', handoffTtlMs: 3_600_000 } as never, { role: 'operator' } as never));
    expect(writeM).toHaveBeenCalledWith({ handoffTtlMs: 3_600_000 });
    expect(b).toMatchObject({ ok: true, applied: true, verify: { ok: true } });
  });
  it('dryRun does not write', async () => {
    const b = body(await tool.handler({ op: 'set', handoffTtlMs: 3_600_000, dryRun: true } as never, { role: 'operator' } as never));
    expect(writeM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ dryRun: true, applied: false });
  });
});
