/**
 * success-metrics.test.ts (tool surface) — the EI-12148 window-floor args on
 * blender:success-metrics. The ledger math lives in scout/success-metrics.test.ts;
 * this pins the ARG semantics: mutual exclusion, loud unknown-watermark failure, and
 * that the schema accepts the new floor args. All paths here return before any PG read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildProgramSuccessReport: vi.fn(),
  readRunningGeneration: vi.fn(),
}));

vi.mock('../../scout/success-metrics', () => ({
  buildProgramSuccessReport: mocks.buildProgramSuccessReport,
}));

vi.mock('../../scout/generation-watermark', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scout/generation-watermark')>();
  return { ...actual, readRunningGeneration: mocks.readRunningGeneration };
});

import { runSuccessMetrics, successMetricsArgs } from './success-metrics';

describe('blender:success-metrics window-floor args (EI-12148)', () => {
  beforeEach(() => {
    mocks.buildProgramSuccessReport.mockReset().mockResolvedValue({
      verdict: 'pass',
      criteria: [],
      window: { ticks: 1, ranCycles: 1, routedIdeas: 0, ledgerTruncated: false },
    });
    mocks.readRunningGeneration.mockReset().mockResolvedValue({
      sha: '8a9ce7c105',
      hostStartedAt: '2026-07-15T03:11:25.000Z',
    });
  });

  it('schema accepts sinceMs and watermarkRef', () => {
    expect(successMetricsArgs.safeParse({ sinceMs: Date.parse('2026-07-14T18:08:24Z') }).success).toBe(true);
    expect(successMetricsArgs.safeParse({ watermarkRef: 'bg-host-restart' }).success).toBe(true);
    expect(successMetricsArgs.safeParse({}).success).toBe(true);
  });

  it('sinceMs + watermarkRef together is a TEACHING error — two floors cannot both judge', async () => {
    const out = await runSuccessMetrics({ sinceMs: 1, watermarkRef: 'bg-host-restart' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('invalid_args');
  });

  it('an unknown watermarkRef fails LOUD, never silently judges some other window', async () => {
    const out = await runSuccessMetrics({ watermarkRef: 'not-a-watermark' });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain('watermark_unresolved');
      // The teaching error names the vocabulary so the caller can self-correct.
      expect(out.error).toContain('bg-host-restart');
    }
  });

  it('adds running-generation parity evidence to an explicitly windowed judgment', async () => {
    const sinceMs = Date.parse('2026-07-15T03:11:25.000Z');
    const out = await runSuccessMetrics({ sinceMs });

    expect(out).toMatchObject({
      ok: true,
      resolvedWindow: {
        sinceMs,
        sinceIso: '2026-07-15T03:11:25.000Z',
        source: 'sinceMs',
      },
      runningGeneration: {
        sha: '8a9ce7c105',
        hostStartedAt: '2026-07-15T03:11:25.000Z',
      },
    });
    expect(mocks.readRunningGeneration).toHaveBeenCalledOnce();
  });

  it('keeps the default read byte-compatible by omitting generation parity fields', async () => {
    const out = await runSuccessMetrics({});

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.resolvedWindow).toBeUndefined();
      expect(out.runningGeneration).toBeUndefined();
    }
    expect(mocks.readRunningGeneration).not.toHaveBeenCalled();
  });
});
