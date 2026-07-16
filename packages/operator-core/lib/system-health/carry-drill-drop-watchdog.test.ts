import { describe, expect, it, vi } from 'vitest';
import { runCarryDrillDropSweepOnce } from './carry-drill-drop-watchdog';
import type { ColdBootDrillLedgerEvent } from '../cold-boot-drill-live';

const T0 = Date.parse('2026-07-15T12:00:00.000Z');

function drop(drillId: string, offsetMs: number, reason = 'busy-gate-expired'): ColdBootDrillLedgerEvent {
  return {
    ts: new Date(T0 + offsetMs).toISOString(),
    kind: 'carry-drill-carry-dropped',
    drillId,
    ownerId: 'su-w',
    sessionClass: 'gateway-claude-headless',
    reason,
  };
}

describe('runCarryDrillDropSweepOnce (EI-12755)', () => {
  it('skips entirely (no ledger read) when the flag is OFF', async () => {
    const readLedger = vi.fn();
    const result = await runCarryDrillDropSweepOnce(T0, {
      flagEnabled: async () => false,
      readLedger,
      escalate: vi.fn(),
    });
    expect(result).toEqual({ watermarkMs: T0, escalated: 0, skipped: true });
    expect(readLedger).not.toHaveBeenCalled();
  });

  it('escalates each fresh drop once and advances the watermark', async () => {
    const escalate = vi.fn(async () => {});
    const result = await runCarryDrillDropSweepOnce(T0, {
      flagEnabled: async () => true,
      readLedger: async () => [drop('d-1', 1_000), drop('d-2', 2_000, 'never-settled')],
      escalate,
    });
    expect(escalate).toHaveBeenCalledTimes(2);
    expect(escalate).toHaveBeenCalledWith(
      expect.objectContaining({ drillId: 'd-2', reason: 'never-settled' }),
    );
    expect(result).toEqual({ watermarkMs: T0 + 2_000, escalated: 2, skipped: false });
  });

  it('a second sweep from the advanced watermark re-alerts nothing', async () => {
    const events = [drop('d-1', 1_000)];
    const escalate = vi.fn(async () => {});
    const first = await runCarryDrillDropSweepOnce(T0, {
      flagEnabled: async () => true,
      readLedger: async () => events,
      escalate,
    });
    const second = await runCarryDrillDropSweepOnce(first.watermarkMs, {
      flagEnabled: async () => true,
      readLedger: async () => events,
      escalate,
    });
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ watermarkMs: first.watermarkMs, escalated: 0, skipped: false });
  });

  it('keeps the OLD watermark when an escalate fails, so the batch retries next tick', async () => {
    const escalate = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('coord log down'));
    const result = await runCarryDrillDropSweepOnce(T0, {
      flagEnabled: async () => true,
      readLedger: async () => [drop('d-1', 1_000), drop('d-2', 2_000)],
      escalate,
    });
    expect(result).toEqual({ watermarkMs: T0, escalated: 1, skipped: false });
  });
});
