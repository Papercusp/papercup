/**
 * checkpoint-config.test.ts — the release:checkpoint-config TOOL (live-configurability-audit P-016).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/release/checkpoint-config.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DEFAULTS = vi.hoisted(() => ({ stallReds: 3, stallAgeMs: 21_600_000, chronicFlakeCount: 3, flakeNotifyCooldownMs: 86_400_000, deployBackoffMs: 3_600_000 }));
// EI-21363817573800034: STATEFUL hold mock. The tool's verify step reads the hold back after
// writing it, so a stub that always answers 'clear' would make a successful write look like a
// failed one — the mock has to actually round-trip.
const holdBox = vi.hoisted(() => ({ current: null as null | { governingRef: string } }));
vi.mock('../../release-checkpoint-config', () => ({
  readReleaseCheckpointOverride: vi.fn(),
  writeReleaseCheckpointConfig: vi.fn(),
  setReleaseCheckpointOverride: vi.fn(),
  releaseCheckpointConfig: vi.fn(() => DEFAULTS),
  RELEASE_CHECKPOINT_DEFAULTS: DEFAULTS,
  readQualificationAdmission: vi.fn(async () =>
    holdBox.current ? { status: 'held', hold: holdBox.current } : { status: 'clear' },
  ),
  setQualificationHold: vi.fn(async (h: null | { governingRef: string }) => {
    holdBox.current = h;
  }),
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
  holdBox.current = null;
});

describe('release:checkpoint-config', () => {
  it('get returns effective + overrides + defaults', async () => {
    const b = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
    expect(b).toMatchObject({ effective: { stallReds: 3, deployBackoffMs: 3_600_000 }, overrides: {} });
  });
  it('is operator-authority gated', async () => {
    await expect(tool.handler({ op: 'set', deployBackoffMs: 600_000 } as never, { role: 'cup' } as never)).rejects.toThrow(/operator, architect, or mug/i);
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

describe('EI-21363817573800034: the qualification hold (op:hold / op:unhold)', () => {
  it('get surfaces the admission state, so a HELD gate never just looks idle', async () => {
    expect(body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never))).toMatchObject({
      admission: { status: 'clear' },
    });
    holdBox.current = { governingRef: 'stable-candidate-related-gate-2026-08-23#D-028' };
    expect(body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never))).toMatchObject({
      admission: { status: 'held', hold: { governingRef: 'stable-candidate-related-gate-2026-08-23#D-028' } },
    });
  });

  it('placing a hold is operator-authority gated — freezing the release gate is not an ambient power', async () => {
    await expect(
      tool.handler({ op: 'hold', governingRef: 'plan#D-028' } as never, { role: 'cup' } as never),
    ).rejects.toThrow(/operator, architect, or mug/i);
    expect(holdBox.current).toBeNull();
  });

  it('lifting a hold is gated too — otherwise the guard could be bypassed by anyone it blocks', async () => {
    holdBox.current = { governingRef: 'plan#D-028' };
    await expect(tool.handler({ op: 'unhold' } as never, { role: 'cup' } as never)).rejects.toThrow(
      /operator, architect, or mug/i,
    );
    expect(holdBox.current).toMatchObject({ governingRef: 'plan#D-028' });
  });

  it('places an attributable hold and verifies it round-tripped', async () => {
    const b = body(
      await tool.handler(
        {
          op: 'hold',
          governingRef: 'stable-candidate-related-gate-2026-08-23#D-028',
          blockingItems: ['EI-21345855843068720'],
          reason: 'owner-directed serializer hold',
        } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(b).toMatchObject({ ok: true, op: 'hold', applied: true, verify: { ok: true } });
    expect(holdBox.current).toMatchObject({
      governingRef: 'stable-candidate-related-gate-2026-08-23#D-028',
      blockingItems: ['EI-21345855843068720'],
      placedBy: 'role:operator',
    });
    // Attribution is stamped by the TOOL, not supplied by the caller — a hold whose author is
    // self-reported is not evidence of anything.
    expect(typeof (holdBox.current as unknown as { placedAtMs: number }).placedAtMs).toBe('number');
  });

  it('unhold lifts it, so the scheduled gate resumes', async () => {
    holdBox.current = { governingRef: 'plan#D-028' };
    const b = body(await tool.handler({ op: 'unhold' } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: true, op: 'unhold', applied: true, verify: { ok: true } });
    expect(holdBox.current).toBeNull();
  });

  it('dryRun previews without freezing the gate', async () => {
    const b = body(
      await tool.handler({ op: 'hold', governingRef: 'plan#D-028', dryRun: true } as never, { role: 'operator' } as never),
    );
    expect(b).toMatchObject({ dryRun: true, applied: false });
    expect(holdBox.current).toBeNull();
  });
});
