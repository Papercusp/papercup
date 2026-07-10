/**
 * bee-transcript-cap (P-013, D-007) — the pure decision + the flag-gated sweep.
 * getFlag is mocked so the double-gate (FLAGS.CUP_TRANSCRIPT_CAP) is exercised both ways.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getFlag = vi.fn();
vi.mock('@papercusp/flags/server', () => ({ getFlag: (...a: unknown[]) => getFlag(...a) }));

import {
  shouldRecycleCupTranscript,
  runCupTranscriptCapSweep,
  DEFAULT_CUP_TRANSCRIPT_CAPS,
  type CupTranscriptMetrics,
} from './bee-transcript-cap';

const cup = (over: Partial<CupTranscriptMetrics> = {}): CupTranscriptMetrics => ({
  ownerId: 's-cup-1',
  sessionId: 'sess-1',
  harness: 'acme',
  idle: true,
  tasks: 0,
  carriedReadTokens: 0,
  transcriptEntries: 0,
  ...over,
});

beforeEach(() => getFlag.mockReset());

describe('shouldRecycleCupTranscript (pure)', () => {
  it('recycles an idle cup over the task cap', () => {
    expect(shouldRecycleCupTranscript(cup({ tasks: DEFAULT_CUP_TRANSCRIPT_CAPS.maxTasks })).recycle).toBe(true);
  });
  it('recycles an idle cup over the carried-token cap', () => {
    expect(
      shouldRecycleCupTranscript(cup({ carriedReadTokens: DEFAULT_CUP_TRANSCRIPT_CAPS.maxCarriedReadTokens })).recycle,
    ).toBe(true);
  });
  it('recycles an idle cup over the transcript-entry cap', () => {
    expect(
      shouldRecycleCupTranscript(cup({ transcriptEntries: DEFAULT_CUP_TRANSCRIPT_CAPS.maxTranscriptEntries })).recycle,
    ).toBe(true);
  });
  it('NEVER recycles a mid-task cup, even far over every cap (D-005)', () => {
    const d = shouldRecycleCupTranscript(cup({ idle: false, tasks: 9999, carriedReadTokens: 9e9, transcriptEntries: 9e9 }));
    expect(d.recycle).toBe(false);
    expect(d.reason).toBeNull();
  });
  it('keeps an idle cup under every cap', () => {
    expect(shouldRecycleCupTranscript(cup({ tasks: 1, carriedReadTokens: 1000, transcriptEntries: 10 })).recycle).toBe(
      false,
    );
  });
});

describe('runCupTranscriptCapSweep (flag-gated)', () => {
  it('flag OFF: reports the over-cap cohort but recycles NOTHING', async () => {
    getFlag.mockResolvedValue(false);
    const recycle = vi.fn(async () => {});
    const report = await runCupTranscriptCapSweep({
      deps: { listCups: async () => [cup({ tasks: 99 })], recycle },
    });
    expect(report.enabled).toBe(false);
    expect(report.overCap).toBe(1);
    expect(report.recycled).toBe(0);
    expect(recycle).not.toHaveBeenCalled();
    expect(report.targets[0].ownerId).toBe('s-cup-1');
  });

  it('flag ON: recycles the over-cap idle cup', async () => {
    getFlag.mockResolvedValue(true);
    const recycle = vi.fn(async (_m: CupTranscriptMetrics) => {});
    const report = await runCupTranscriptCapSweep({
      deps: { listCups: async () => [cup({ tasks: 99 }), cup({ ownerId: 's-ok', tasks: 1 })], recycle },
    });
    expect(report.enabled).toBe(true);
    expect(report.overCap).toBe(1);
    expect(report.recycled).toBe(1);
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(recycle.mock.calls[0][0].ownerId).toBe('s-cup-1');
  });

  it('flag ON + dry_run: reports the cohort, recycles nothing', async () => {
    getFlag.mockResolvedValue(true);
    const recycle = vi.fn(async () => {});
    const report = await runCupTranscriptCapSweep({
      dryRun: true,
      deps: { listCups: async () => [cup({ tasks: 99 })], recycle },
    });
    expect(report.dryRun).toBe(true);
    expect(report.overCap).toBe(1);
    expect(report.recycled).toBe(0);
    expect(recycle).not.toHaveBeenCalled();
  });

  it('never recycles a mid-task cup even when armed (D-005)', async () => {
    getFlag.mockResolvedValue(true);
    const recycle = vi.fn(async () => {});
    const report = await runCupTranscriptCapSweep({
      deps: { listCups: async () => [cup({ idle: false, tasks: 99 })], recycle },
    });
    expect(report.overCap).toBe(0);
    expect(recycle).not.toHaveBeenCalled();
  });

  it('is fail-soft per cup: a recycle throw is counted, the sweep continues', async () => {
    getFlag.mockResolvedValue(true);
    const recycle = vi
      .fn()
      .mockRejectedValueOnce(new Error('nudge failed'))
      .mockResolvedValueOnce(undefined);
    const report = await runCupTranscriptCapSweep({
      deps: {
        listCups: async () => [cup({ ownerId: 's-a', tasks: 99 }), cup({ ownerId: 's-b', tasks: 99 })],
        recycle,
      },
    });
    expect(report.overCap).toBe(2);
    expect(report.recycled).toBe(1);
    expect(report.failed).toBe(1);
  });

  it('degrades to empty when listCups throws', async () => {
    getFlag.mockResolvedValue(true);
    const report = await runCupTranscriptCapSweep({
      deps: {
        listCups: async () => {
          throw new Error('pg down');
        },
        recycle: async () => {},
      },
    });
    expect(report.scanned).toBe(0);
    expect(report.overCap).toBe(0);
  });
});
