/**
 * success-metrics.test.ts (tool surface) — the EI-12148 window-floor args on
 * blender:success-metrics, plus the EI-12146 rubric-derived DEFAULT window. The ledger
 * math lives in scout/success-metrics.test.ts; this pins the ARG semantics (mutual
 * exclusion, loud unknown-watermark failure, schema shape) and the window-resolution
 * PROVENANCE for every path: explicit sinceMs/watermarkRef, the rubric's own declared
 * window (rolling / post-watermark, resolved / unresolved), and the rubric-unavailable
 * fallback. All paths here return before any real PG/systemctl IO.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildProgramSuccessReport: vi.fn(),
  readRunningGeneration: vi.fn(),
  resolveWatermarkRef: vi.fn(),
  getRubric: vi.fn(),
}));

vi.mock('../../scout/success-metrics', () => ({
  buildProgramSuccessReport: mocks.buildProgramSuccessReport,
}));

vi.mock('../../scout/generation-watermark', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scout/generation-watermark')>();
  // Default: pass through to the REAL resolver (no IO for an unknown/typo'd ref — it
  // returns synchronously-failed before ever touching systemctl). Individual tests
  // override this via mockResolvedValueOnce/mockImplementationOnce for the
  // known 'bg-host-restart' ref, so no test ever execs a real systemctl.
  mocks.resolveWatermarkRef.mockImplementation(actual.resolveWatermarkRef);
  return { ...actual, readRunningGeneration: mocks.readRunningGeneration, resolveWatermarkRef: mocks.resolveWatermarkRef };
});

vi.mock('../../rubrics', () => ({ getRubric: mocks.getRubric }));

import {
  runSuccessMetrics,
  successMetricsArgs,
  RELEASE_READINESS_RUBRIC_SLUG,
  CYCLE_ERROR_RATE_CRITERION_KEY,
} from './success-metrics';

describe('blender:success-metrics window-floor args (EI-12148) + rubric-derived default (EI-12146)', () => {
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
    // Default: no rubric found — every test exercises the EI-12146 rubric-derived
    // default path explicitly instead, via its own mockResolvedValueOnce.
    mocks.getRubric.mockReset().mockResolvedValue(null);
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
    expect(mocks.getRubric).not.toHaveBeenCalled();
  });

  it('an unknown watermarkRef fails LOUD, never silently judges some other window', async () => {
    const out = await runSuccessMetrics({ watermarkRef: 'not-a-watermark' });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain('watermark_unresolved');
      // The teaching error names the vocabulary so the caller can self-correct.
      expect(out.error).toContain('bg-host-restart');
    }
    expect(mocks.getRubric).not.toHaveBeenCalled();
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
    // An explicit override skips the rubric read entirely — it is not consulted at all.
    expect(mocks.getRubric).not.toHaveBeenCalled();
  });

  describe('EI-12146: default window (no sinceMs/watermarkRef) resolves from the rubric', () => {
    it('reads the release-readiness rubric\'s cycle-error-rate criterion', async () => {
      await runSuccessMetrics({});
      expect(mocks.getRubric).toHaveBeenCalledWith(RELEASE_READINESS_RUBRIC_SLUG);
    });

    it('falls back to the pre-EI-12146 hardcoded default when the rubric cannot be read at all (byte-compatible)', async () => {
      // beforeEach already stubs getRubric → null (rubric not found / read failed).
      const out = await runSuccessMetrics({});

      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.resolvedWindow).toBeUndefined();
        expect(out.runningGeneration).toBeUndefined();
      }
      expect(mocks.readRunningGeneration).not.toHaveBeenCalled();
      const callArg = mocks.buildProgramSuccessReport.mock.calls[0]?.[0];
      expect(callArg?.sinceMs).toBeUndefined();
    });

    it('falls back to the hardcoded default when the rubric has no cycle-error-rate criterion window declared', async () => {
      mocks.getRubric.mockResolvedValue({
        criteria: [{ key: CYCLE_ERROR_RATE_CRITERION_KEY, title: 'x', model: 'x', method: 'x', driftMarkers: 'x' }],
      });
      const out = await runSuccessMetrics({});

      expect(out.ok).toBe(true);
      if (out.ok) expect(out.resolvedWindow).toBeUndefined();
      expect(mocks.readRunningGeneration).not.toHaveBeenCalled();
    });

    it('resolves a rolling window the rubric declares, and passes it through to the report + parity evidence', async () => {
      const nowMs = Date.parse('2026-07-18T12:00:00.000Z');
      vi.useFakeTimers().setSystemTime(nowMs);
      try {
        mocks.getRubric.mockResolvedValue({
          criteria: [
            {
              key: CYCLE_ERROR_RATE_CRITERION_KEY,
              title: 'x',
              model: 'x',
              method: 'x',
              driftMarkers: 'x',
              window: { kind: 'rolling', ms: 3_600_000 },
            },
          ],
        });

        const out = await runSuccessMetrics({});

        const expectedSinceMs = nowMs - 3_600_000;
        expect(out).toMatchObject({
          ok: true,
          resolvedWindow: { sinceMs: expectedSinceMs, source: 'rubric:window' },
          runningGeneration: { sha: '8a9ce7c105' },
        });
        expect(mocks.buildProgramSuccessReport).toHaveBeenCalledWith(expect.objectContaining({ sinceMs: expectedSinceMs }));
        expect(mocks.readRunningGeneration).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it('resolves a post-watermark window the rubric declares via the named watermark ref', async () => {
      const wmMs = Date.parse('2026-07-17T09:00:00.000Z');
      mocks.getRubric.mockResolvedValue({
        criteria: [
          {
            key: CYCLE_ERROR_RATE_CRITERION_KEY,
            title: 'x',
            model: 'x',
            method: 'x',
            driftMarkers: 'x',
            window: { kind: 'post-watermark', watermarkRef: 'bg-host-restart' },
          },
        ],
      });
      mocks.resolveWatermarkRef.mockResolvedValueOnce({ ok: true, ms: wmMs });

      const out = await runSuccessMetrics({});

      expect(out).toMatchObject({
        ok: true,
        resolvedWindow: { sinceMs: wmMs, sinceIso: new Date(wmMs).toISOString(), source: 'rubric:window' },
      });
      expect(mocks.buildProgramSuccessReport).toHaveBeenCalledWith(expect.objectContaining({ sinceMs: wmMs }));
    });

    it('degrades to the rolling default (with provenance) when the rubric\'s post-watermark ref cannot resolve — never silently judges nothing', async () => {
      const nowMs = Date.parse('2026-07-18T12:00:00.000Z');
      vi.useFakeTimers().setSystemTime(nowMs);
      try {
        mocks.getRubric.mockResolvedValue({
          criteria: [
            {
              key: CYCLE_ERROR_RATE_CRITERION_KEY,
              title: 'x',
              model: 'x',
              method: 'x',
              driftMarkers: 'x',
              window: { kind: 'post-watermark', watermarkRef: 'bg-host-restart' },
            },
          ],
        });
        mocks.resolveWatermarkRef.mockResolvedValueOnce({ ok: false, error: 'bg-host not running' });

        const out = await runSuccessMetrics({});

        expect(out.ok).toBe(true);
        if (out.ok) {
          expect(out.resolvedWindow?.source).toBe('rubric:watermark-unresolved');
          // A never-throws degrade must still judge SOME concrete window, not nothing.
          expect(typeof out.resolvedWindow?.sinceMs).toBe('number');
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('a rubric read that throws degrades to the hardcoded default rather than failing the whole done-check', async () => {
      mocks.getRubric.mockRejectedValue(new Error('pg unavailable'));
      const out = await runSuccessMetrics({});

      expect(out.ok).toBe(true);
      if (out.ok) expect(out.resolvedWindow).toBeUndefined();
    });
  });
});
