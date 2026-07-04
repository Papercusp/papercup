/**
 * reclaim-config.test.ts — the work_items:reclaim_config TOOL (live-configurability-audit P-014).
 *
 * Mocks the coord-liveness-config helper + control harness. Asserts: get reads · set is
 * operator-gated · set requires a field · a valid patch applies + verifies · dryRun does not write.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/reclaim-config.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../coord-liveness-config', () => ({
  readCoordLivenessConfig: vi.fn(),
  writeCoordLivenessConfig: vi.fn(),
  setCoordLivenessConfig: vi.fn(),
  COORD_LIVENESS_DEFAULTS: { handoffTtlMs: 43_200_000, reclaimGraceMs: 600_000, reclaimParkedGraceMs: 1_800_000, reclaimRequeueCap: 3, sessionReaperGraceMs: 600_000 },
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

const tool = (await import('./reclaim-config')).default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  readM.mockResolvedValue({});
  writeM.mockImplementation(async (patch) => ({ ...patch }) as never);
});

describe('work_items:reclaim_config', () => {
  it('get returns overrides (null when unset) + defaults', async () => {
    const b = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
    expect(b).toMatchObject({
      reclaimGraceMs: null,
      reclaimParkedGraceMs: null,
      reclaimRequeueCap: null,
      defaults: { reclaimGraceMs: 600_000, reclaimParkedGraceMs: 1_800_000, reclaimRequeueCap: 3 },
    });
  });

  it('is operator-authority gated', async () => {
    await expect(
      tool.handler({ op: 'set', reclaimRequeueCap: 5 } as never, { role: 'bee' } as never),
    ).rejects.toThrow(/operator, architect, or queen/i);
    expect(writeM).not.toHaveBeenCalled();
  });

  it('requires at least one field', async () => {
    await expect(tool.handler({ op: 'set' } as never, { role: 'operator' } as never)).rejects.toThrow(/at least one/i);
  });

  it('applies a valid patch and verifies', async () => {
    const b = body(await tool.handler({ op: 'set', reclaimGraceMs: 300_000, reclaimRequeueCap: 5 } as never, { role: 'operator' } as never));
    expect(writeM).toHaveBeenCalledWith({ reclaimGraceMs: 300_000, reclaimRequeueCap: 5 });
    expect(b).toMatchObject({ ok: true, applied: true, verify: { ok: true } });
  });

  it('applies the reclaimParkedGraceMs knob (WI-2689 churn fix)', async () => {
    const b = body(await tool.handler({ op: 'set', reclaimParkedGraceMs: 2_700_000 } as never, { role: 'operator' } as never));
    expect(writeM).toHaveBeenCalledWith({ reclaimParkedGraceMs: 2_700_000 });
    expect(b).toMatchObject({ ok: true, applied: true, verify: { ok: true } });
  });

  it('dryRun does not write', async () => {
    const b = body(await tool.handler({ op: 'set', reclaimRequeueCap: 7, dryRun: true } as never, { role: 'operator' } as never));
    expect(writeM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ dryRun: true, applied: false });
  });
});
