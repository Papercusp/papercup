import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  readRecentProductionCarryEvents,
  runCarryDrillDropSweepOnce,
  runProductionCarryDeliverySweepOnce,
  summarizeProductionCarryDelivery,
} from './carry-drill-drop-watchdog';
import type { ColdBootDrillLedgerEvent } from '../cold-boot-drill-live';
import type { PtyHostEvent } from '../events/await/psu-pty-discovery';

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

describe('production carry delivery rate (EI-18168050721107453)', () => {
  const NOW = Date.parse('2026-08-23T20:00:00.000Z');
  const event = (
    kind: string,
    offsetMs: number,
    extra: Record<string, unknown> = {},
  ): PtyHostEvent => ({
    ts: new Date(NOW + offsetMs).toISOString(),
    kind,
    mode: 'carry-respawn',
    ...extra,
  });

  it('uses mutually-exclusive terminal outcomes and breaks failures down by reason', () => {
    const reading = summarizeProductionCarryDelivery(
      [
        event('respawned', -1_000, { nativeId: 'n-1' }),
        event('respawn-carry-delivered', -900, { nativeId: 'n-1' }),
        event('respawned', -800, { nativeId: 'n-2' }),
        event('respawn-carry-dropped', -700, { nativeId: 'n-2', reason: 'never-settled' }),
        event('respawn-failed', -600, { reason: 'spawn-failed' }),
        event('respawn-carry-dropped', -2 * 60 * 60_000, { reason: 'outside-window' }),
        event('respawn-carry-delivered', 1_000),
        event('respawn-carry-delivered', -500, { mode: 'recycle' }),
      ],
      NOW,
    );

    expect(reading).toEqual({
      windowStartMs: NOW - 60 * 60_000,
      windowEndMs: NOW,
      delivered: 1,
      dropped: 1,
      respawnFailed: 1,
      terminalOutcomes: 3,
      deliveryRate: 1 / 3,
      failureReasons: {
        'never-settled': 1,
        'respawn-failed:spawn-failed': 1,
      },
    });
  });

  it('reads recent per-owner bounded tails and excludes the shared drill ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'production-carry-watchdog-'));
    try {
      writeFileSync(
        join(dir, 'su-recent.events.jsonl'),
        `${JSON.stringify(event('respawn-carry-delivered', -1_000))}\n`,
      );
      writeFileSync(
        join(dir, 'carry-drills.events.jsonl'),
        `${JSON.stringify(event('respawn-carry-dropped', -1_000, { reason: 'mirrored' }))}\n`,
      );
      const stalePath = join(dir, 'su-stale.events.jsonl');
      writeFileSync(stalePath, `${JSON.stringify(event('respawn-carry-dropped', -1_000))}\n`);
      const stale = new Date(NOW - 2 * 60 * 60_000);
      utimesSync(stalePath, stale, stale);

      expect(readRecentProductionCarryEvents(dir, NOW)).toEqual([
        expect.objectContaining({ kind: 'respawn-carry-delivered' }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('escalates only below the delivery-rate floor with enough terminal samples', async () => {
    const events = [
      event('respawn-carry-delivered', -3_000),
      event('respawn-carry-dropped', -2_000, { reason: 'busy-gate-expired' }),
      event('respawn-carry-dropped', -1_000, { reason: 'carry-stale' }),
    ];
    const escalate = vi.fn(async () => {});
    const breached = await runProductionCarryDeliverySweepOnce({
      flagEnabled: async () => true,
      readEvents: async () => events,
      escalate,
      now: () => NOW,
      minTerminalOutcomes: 3,
      deliveryRateFloor: 0.5,
    });
    expect(breached.escalated).toBe(true);
    expect(escalate).toHaveBeenCalledWith(
      expect.objectContaining({ delivered: 1, terminalOutcomes: 3, deliveryRate: 1 / 3 }),
    );

    escalate.mockClear();
    const atFloor = await runProductionCarryDeliverySweepOnce({
      flagEnabled: async () => true,
      readEvents: async () => [
        event('respawn-carry-delivered', -2_000),
        event('respawn-carry-dropped', -1_000),
      ],
      escalate,
      now: () => NOW,
      minTerminalOutcomes: 2,
      deliveryRateFloor: 0.5,
    });
    expect(atFloor.escalated).toBe(false);
    expect(escalate).not.toHaveBeenCalled();
  });

  it('skips the production ledger read when the existing watchdog flag is off', async () => {
    const readEvents = vi.fn();
    const result = await runProductionCarryDeliverySweepOnce({
      flagEnabled: async () => false,
      readEvents,
    });
    expect(result).toEqual({ reading: null, escalated: false, skipped: true });
    expect(readEvents).not.toHaveBeenCalled();
  });
});
