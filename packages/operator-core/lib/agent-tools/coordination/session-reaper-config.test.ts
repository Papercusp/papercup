/**
 * session-reaper-config.test.ts — the coord:session_reaper_config TOOL (live-configurability-audit P-014).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/session-reaper-config.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../coord-liveness-config', () => ({
  readCoordLivenessConfig: vi.fn(),
  writeCoordLivenessConfig: vi.fn(),
  setCoordLivenessConfig: vi.fn(),
  COORD_LIVENESS_DEFAULTS: { handoffTtlMs: 43_200_000, reclaimGraceMs: 600_000, reclaimRequeueCap: 3, sessionReaperGraceMs: 600_000 },
}));
vi.mock('../../idle-session-reaper', () => ({ runIdleSessionReap: vi.fn() }));
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
import { runIdleSessionReap } from '../../idle-session-reaper';
const readM = vi.mocked(readCoordLivenessConfig);
const writeM = vi.mocked(writeCoordLivenessConfig);
const reapM = vi.mocked(runIdleSessionReap);
const tool = (await import('./session-reaper-config')).default;
type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  readM.mockResolvedValue({});
  writeM.mockImplementation(async (patch) => ({ ...patch }) as never);
  reapM.mockResolvedValue({ enabled: true, scanned: 5, reaped: 2, reapedIds: [], keptLive: 3, dryRun: true } as never);
});

describe('coord:session_reaper_config', () => {
  it('get returns override (null) + default', async () => {
    const b = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
    expect(b).toEqual({ sessionReaperGraceMs: null, default: 600_000 });
  });
  it('is operator-authority gated', async () => {
    await expect(tool.handler({ op: 'set', sessionReaperGraceMs: 300_000 } as never, { role: 'cup' } as never)).rejects.toThrow(/operator, architect, or mug/i);
    expect(writeM).not.toHaveBeenCalled();
  });
  it('dryRun returns a would-reap count and writes nothing', async () => {
    const b = body(await tool.handler({ op: 'set', sessionReaperGraceMs: 300_000, dryRun: true } as never, { role: 'operator' } as never));
    expect(reapM).toHaveBeenCalledWith({ dryRun: true, graceMs: 300_000 });
    expect(writeM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ dryRun: true, applied: false, wouldReap: 2, scanned: 5, reaperEnabled: true });
  });
  it('applies a valid grace and verifies', async () => {
    const b = body(await tool.handler({ op: 'set', sessionReaperGraceMs: 300_000 } as never, { role: 'operator' } as never));
    expect(writeM).toHaveBeenCalledWith({ sessionReaperGraceMs: 300_000 });
    expect(b).toMatchObject({ ok: true, applied: true, verify: { ok: true } });
  });
});
