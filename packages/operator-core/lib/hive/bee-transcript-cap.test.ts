/**
 * bee-transcript-cap (P-013, D-007) — the pure decision + the flag-gated sweep.
 * getFlag is mocked so the double-gate (FLAGS.BEE_TRANSCRIPT_CAP) is exercised both ways.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getFlag = vi.fn();
vi.mock('@papercusp/flags/server', () => ({ getFlag: (...a: unknown[]) => getFlag(...a) }));

import {
  shouldRecycleBeeTranscript,
  runBeeTranscriptCapSweep,
  DEFAULT_BEE_TRANSCRIPT_CAPS,
  type BeeTranscriptMetrics,
} from './bee-transcript-cap';

const bee = (over: Partial<BeeTranscriptMetrics> = {}): BeeTranscriptMetrics => ({
  ownerId: 's-bee-1',
  sessionId: 'sess-1',
  harness: 'acme',
  idle: true,
  tasks: 0,
  carriedReadTokens: 0,
  transcriptEntries: 0,
  ...over,
});

beforeEach(() => getFlag.mockReset());

describe('shouldRecycleBeeTranscript (pure)', () => {
  it('recycles an idle bee over the task cap', () => {
    expect(shouldRecycleBeeTranscript(bee({ tasks: DEFAULT_BEE_TRANSCRIPT_CAPS.maxTasks })).recycle).toBe(true);
  });
  it('recycles an idle bee over the carried-token cap', () => {
    expect(
      shouldRecycleBeeTranscript(bee({ carriedReadTokens: DEFAULT_BEE_TRANSCRIPT_CAPS.maxCarriedReadTokens })).recycle,
    ).toBe(true);
  });
  it('recycles an idle bee over the transcript-entry cap', () => {
    expect(
      shouldRecycleBeeTranscript(bee({ transcriptEntries: DEFAULT_BEE_TRANSCRIPT_CAPS.maxTranscriptEntries })).recycle,
    ).toBe(true);
  });
  it('NEVER recycles a mid-task bee, even far over every cap (D-005)', () => {
    const d = shouldRecycleBeeTranscript(bee({ idle: false, tasks: 9999, carriedReadTokens: 9e9, transcriptEntries: 9e9 }));
    expect(d.recycle).toBe(false);
    expect(d.reason).toBeNull();
  });
  it('keeps an idle bee under every cap', () => {
    expect(shouldRecycleBeeTranscript(bee({ tasks: 1, carriedReadTokens: 1000, transcriptEntries: 10 })).recycle).toBe(
      false,
    );
  });
});

describe('runBeeTranscriptCapSweep (flag-gated)', () => {
  it('flag OFF: reports the over-cap cohort but recycles NOTHING', async () => {
    getFlag.mockResolvedValue(false);
    const recycle = vi.fn(async () => {});
    const report = await runBeeTranscriptCapSweep({
      deps: { listBees: async () => [bee({ tasks: 99 })], recycle },
    });
    expect(report.enabled).toBe(false);
    expect(report.overCap).toBe(1);
    expect(report.recycled).toBe(0);
    expect(recycle).not.toHaveBeenCalled();
    expect(report.targets[0].ownerId).toBe('s-bee-1');
  });

  it('flag ON: recycles the over-cap idle bee', async () => {
    getFlag.mockResolvedValue(true);
    const recycle = vi.fn(async (_m: BeeTranscriptMetrics) => {});
    const report = await runBeeTranscriptCapSweep({
      deps: { listBees: async () => [bee({ tasks: 99 }), bee({ ownerId: 's-ok', tasks: 1 })], recycle },
    });
    expect(report.enabled).toBe(true);
    expect(report.overCap).toBe(1);
    expect(report.recycled).toBe(1);
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(recycle.mock.calls[0][0].ownerId).toBe('s-bee-1');
  });

  it('flag ON + dry_run: reports the cohort, recycles nothing', async () => {
    getFlag.mockResolvedValue(true);
    const recycle = vi.fn(async () => {});
    const report = await runBeeTranscriptCapSweep({
      dryRun: true,
      deps: { listBees: async () => [bee({ tasks: 99 })], recycle },
    });
    expect(report.dryRun).toBe(true);
    expect(report.overCap).toBe(1);
    expect(report.recycled).toBe(0);
    expect(recycle).not.toHaveBeenCalled();
  });

  it('never recycles a mid-task bee even when armed (D-005)', async () => {
    getFlag.mockResolvedValue(true);
    const recycle = vi.fn(async () => {});
    const report = await runBeeTranscriptCapSweep({
      deps: { listBees: async () => [bee({ idle: false, tasks: 99 })], recycle },
    });
    expect(report.overCap).toBe(0);
    expect(recycle).not.toHaveBeenCalled();
  });

  it('is fail-soft per bee: a recycle throw is counted, the sweep continues', async () => {
    getFlag.mockResolvedValue(true);
    const recycle = vi
      .fn()
      .mockRejectedValueOnce(new Error('nudge failed'))
      .mockResolvedValueOnce(undefined);
    const report = await runBeeTranscriptCapSweep({
      deps: {
        listBees: async () => [bee({ ownerId: 's-a', tasks: 99 }), bee({ ownerId: 's-b', tasks: 99 })],
        recycle,
      },
    });
    expect(report.overCap).toBe(2);
    expect(report.recycled).toBe(1);
    expect(report.failed).toBe(1);
  });

  it('degrades to empty when listBees throws', async () => {
    getFlag.mockResolvedValue(true);
    const report = await runBeeTranscriptCapSweep({
      deps: {
        listBees: async () => {
          throw new Error('pg down');
        },
        recycle: async () => {},
      },
    });
    expect(report.scanned).toBe(0);
    expect(report.overCap).toBe(0);
  });
});
