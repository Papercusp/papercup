/**
 * set-watchdog-tunables.test.ts — the improvements:set-watchdog-tunables TOOL layer
 * (live-configurability-audit-2026-06-20 P-004, the canary).
 *
 * Pins the tool's own logic, NOT the control harness (separately covered by
 * control-harness.test.ts) and NOT the PG helper (thin SQL): we mock both. Asserts:
 *   • get → returns the current tunables (reads the helper).
 *   • set rejects unknown keys (loud, not a silent no-op) + negative/non-finite values.
 *   • set is operator/architect-gated.
 *   • set wires capturePrev/apply/verify onto the helper + returns trimmed output.
 *   • dryRun passes through (no apply).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/improvements/set-watchdog-tunables.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A small real-shaped whitelist (the real ~30-key list lives in watchdog.ts; we only
// need representative keys to exercise the validation, and mocking avoids pulling the
// heavy watchdog module into a unit test).
vi.mock('../../harness/improvements/watchdog', () => ({
  PAYLOAD_TUNABLE_KEYS: ['maxPerTick', 'transientMinCount', 'structuralMinRate'] as const,
}));

vi.mock('../../harness/improvements/watchdog-tunables', () => ({
  readWatchdogTunables: vi.fn(),
  applyWatchdogTunables: vi.fn(),
  restoreWatchdogPayload: vi.fn(),
}));

// Fake harness: exercise the spec (capturePrev → apply → verify) so we can assert the
// tool built it correctly, without touching the real audit/PG write.
vi.mock('../../gateway-control/control-harness', () => ({
  runControlMutation: vi.fn(async (spec: any, opts: any = {}) => {
    const prev = await spec.capturePrev();
    if (opts.dryRun) {
      return { action: spec.action, subject: spec.subject, dryRun: true, applied: false, prev, preview: spec.describe?.(prev) };
    }
    const next = await spec.apply();
    const verify = spec.verify ? await spec.verify(next) : undefined;
    return { action: spec.action, subject: spec.subject, dryRun: false, applied: true, prev, next, verify, auditId: 'aud-1' };
  }),
}));

import { readWatchdogTunables, applyWatchdogTunables } from '../../harness/improvements/watchdog-tunables';
import { runControlMutation } from '../../gateway-control/control-harness';

const readM = vi.mocked(readWatchdogTunables);
const applyM = vi.mocked(applyWatchdogTunables);
const runM = vi.mocked(runControlMutation);

const mod = await import('./set-watchdog-tunables');
const tool = mod.default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  readM.mockResolvedValue({ payload: { maxPerTick: 3 }, tunables: { maxPerTick: 3 } } as never);
  applyM.mockResolvedValue({ payload: { maxPerTick: 5 }, tunables: { maxPerTick: 5 } } as never);
});

describe('improvements:set-watchdog-tunables — get', () => {
  it('returns the current tunables from the helper', async () => {
    const b = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
    expect(b).toEqual({ tunables: { maxPerTick: 3 } });
    expect(readM).toHaveBeenCalledTimes(1);
  });
});

describe('improvements:set-watchdog-tunables — set guards', () => {
  it('rejects an unknown tunable key (loud, not a silent no-op)', async () => {
    await expect(
      tool.handler({ op: 'set', tunables: { notAKey: 1 } } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/unknown watchdog tunable key/i);
    expect(runM).not.toHaveBeenCalled();
  });

  it('rejects a negative value', async () => {
    await expect(
      tool.handler({ op: 'set', tunables: { maxPerTick: -1 } } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/finite and >= 0/i);
  });

  it('rejects an empty patch', async () => {
    await expect(
      tool.handler({ op: 'set', tunables: {} } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/at least one tunable/i);
  });

  it('rejects a role without operator-config write authority (e.g. bee)', async () => {
    await expect(
      tool.handler({ op: 'set', tunables: { maxPerTick: 5 } } as never, { role: 'bee' } as never),
    ).rejects.toThrow(/operator, architect, or queen/i);
    expect(runM).not.toHaveBeenCalled();
  });

  it('accepts the queen (operator-equivalent, EI-2204)', async () => {
    const b = body(await tool.handler({ op: 'set', tunables: { maxPerTick: 5 } } as never, { role: 'queen' } as never));
    expect(applyM).toHaveBeenCalledWith({ maxPerTick: 5 });
    expect(b).toMatchObject({ ok: true, applied: true });
  });
});

describe('improvements:set-watchdog-tunables — set apply', () => {
  it('wires the spec onto the helper, applies the patch, and returns trimmed output', async () => {
    const b = body(
      await tool.handler({ op: 'set', tunables: { maxPerTick: 5 } } as never, { role: 'operator' } as never),
    );
    expect(applyM).toHaveBeenCalledWith({ maxPerTick: 5 });
    expect(b).toMatchObject({
      ok: true,
      dryRun: false,
      applied: true,
      auditId: 'aud-1',
      prev: { maxPerTick: 3 },
      next: { maxPerTick: 5 },
      verify: { ok: true },
    });
  });

  it('dryRun previews the diff without applying', async () => {
    const b = body(
      await tool.handler(
        { op: 'set', tunables: { maxPerTick: 5 }, dryRun: true } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(applyM).not.toHaveBeenCalled();
    expect(b.dryRun).toBe(true);
    expect(b.applied).toBe(false);
    expect(b.preview).toEqual({ current: { maxPerTick: 3 }, proposed: { maxPerTick: 5 } });
  });
});
