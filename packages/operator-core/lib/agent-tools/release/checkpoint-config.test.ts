/**
 * checkpoint-config.test.ts — the release:checkpoint-config TOOL (live-configurability-audit P-016).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/release/checkpoint-config.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DEFAULTS = vi.hoisted(() => ({ stallReds: 3, stallAgeMs: 21_600_000, chronicFlakeCount: 3, flakeNotifyCooldownMs: 86_400_000, deployBackoffMs: 3_600_000 }));
vi.mock('../../release-checkpoint-config', () => ({
  readReleaseCheckpointOverride: vi.fn(),
  writeReleaseCheckpointConfig: vi.fn(),
  setReleaseCheckpointOverride: vi.fn(),
  releaseCheckpointConfig: vi.fn(() => DEFAULTS),
  RELEASE_CHECKPOINT_DEFAULTS: DEFAULTS,
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

import { readReleaseCheckpointOverride, writeReleaseCheckpointConfig } from '../../release-checkpoint-config';
const readM = vi.mocked(readReleaseCheckpointOverride);
const writeM = vi.mocked(writeReleaseCheckpointConfig);
const tool = (await import('./checkpoint-config')).default;
type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  readM.mockResolvedValue({});
  writeM.mockImplementation(async (patch) => ({ ...patch }) as never);
});

describe('release:checkpoint-config', () => {
  it('get returns effective + overrides + defaults', async () => {
    const b = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
    expect(b).toMatchObject({ effective: { stallReds: 3, deployBackoffMs: 3_600_000 }, overrides: {} });
  });
  it('is operator-authority gated', async () => {
    await expect(tool.handler({ op: 'set', deployBackoffMs: 600_000 } as never, { role: 'bee' } as never)).rejects.toThrow(/operator, architect, or queen/i);
    expect(writeM).not.toHaveBeenCalled();
  });
  it('requires at least one field', async () => {
    await expect(tool.handler({ op: 'set' } as never, { role: 'operator' } as never)).rejects.toThrow(/at least one/i);
  });
  it('applies a valid patch and verifies', async () => {
    const b = body(await tool.handler({ op: 'set', deployBackoffMs: 600_000, stallReds: 5 } as never, { role: 'operator' } as never));
    expect(writeM).toHaveBeenCalledWith({ deployBackoffMs: 600_000, stallReds: 5 });
    expect(b).toMatchObject({ ok: true, applied: true, verify: { ok: true } });
  });
  it('dryRun does not write', async () => {
    const b = body(await tool.handler({ op: 'set', stallReds: 9, dryRun: true } as never, { role: 'operator' } as never));
    expect(writeM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ dryRun: true, applied: false });
  });
});
