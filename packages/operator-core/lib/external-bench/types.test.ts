/**
 * Unit tests for the fairness classification scheme (benchmark-fairness-fix, Priority 1).
 *
 * The split between SCORED capability terminals and NON-SCORED external/transient/infra terminals IS the
 * fairness fix. {@link isScoredStopReason} / {@link NON_SCORED_STOP_REASONS} are the single source of truth
 * every live rollup keys on; {@link generationStatusForStopReason} is the bridge onto the bench-metrics
 * GenerationStatus vocabulary (so `isScored` over the immutable rows agrees with the live rollups).
 */
import { describe, it, expect } from 'vitest';
import {
  isScoredStopReason,
  generationStatusForStopReason,
  NON_SCORED_STOP_REASONS,
  type GenerationStopReason,
} from './types';
import { isScored } from '@papercusp/bench-metrics';
import type { TaskRunResult } from '@papercusp/bench-metrics';

describe('isScoredStopReason — the fairness predicate', () => {
  const scored: GenerationStopReason[] = ['done', 'escalate', 'budget-exhausted', 'max-turns'];
  const nonScored: GenerationStopReason[] = ['error', 'timeout', 'infra-failed'];

  it.each(scored)('genuine capability terminal "%s" is SCORED (counted in resolved%%)', (sr) => {
    expect(isScoredStopReason(sr)).toBe(true);
  });

  it.each(nonScored)('external/transient/infra terminal "%s" is NON-scored (excluded, never a fail)', (sr) => {
    expect(isScoredStopReason(sr)).toBe(false);
    expect(NON_SCORED_STOP_REASONS.has(sr)).toBe(true);
  });

  it('a null/absent stopReason is treated as scored (a graded row stands on its grade)', () => {
    expect(isScoredStopReason(null)).toBe(true);
    expect(isScoredStopReason(undefined)).toBe(true);
  });

  it('THE central fix: a wall-clock timeout is NO LONGER scored (was routed to max-turns-as-scored)', () => {
    expect(isScoredStopReason('timeout')).toBe(false);
    // …but a GENUINE turn-bound exhaustion (the spine ran its full turn budget) stays scored.
    expect(isScoredStopReason('max-turns')).toBe(true);
  });
});

describe('generationStatusForStopReason — bridge onto bench-metrics, agrees with isScored', () => {
  it('maps each stopReason to a GenerationStatus whose isScored matches the predicate', () => {
    const all: GenerationStopReason[] = ['done', 'escalate', 'budget-exhausted', 'max-turns', 'timeout', 'infra-failed', 'error'];
    for (const sr of all) {
      const status = generationStatusForStopReason(sr);
      // Build a minimal scored-by-grader row and flip only the generationStatus the bridge derives.
      const row = {
        runId: 'r', suite: 'swe-bench-pro', modality: 'diff', taskId: 't', arm: 'papercusp', seed: 1,
        resolved: false, graderStatus: 'failed', graderFamily: 'swe-bench-pro', graderVersion: 'v1',
        tokensIn: 0, tokensOut: 0, tokensTotal: 0, costUsd: 0, priceTableVersion: 'price-table-v1',
        wallClockMs: 0, turns: 0, capped: false, generationStatus: status,
        modelId: 'claude-opus-4-8', harnessVersion: 'h', preregHash: 'p', rolloutId: 'ro', createdAt: '2026-06-16T00:00:00Z',
      } satisfies TaskRunResult;
      // bench-metrics isScored over the bridged generationStatus must agree with our stopReason predicate.
      expect(isScored(row)).toBe(isScoredStopReason(sr));
    }
  });

  it('timeout → timeout, infra-failed/error → error, everything scored → completed', () => {
    expect(generationStatusForStopReason('timeout')).toBe('timeout');
    expect(generationStatusForStopReason('infra-failed')).toBe('error');
    expect(generationStatusForStopReason('error')).toBe('error');
    expect(generationStatusForStopReason('done')).toBe('completed');
    expect(generationStatusForStopReason('max-turns')).toBe('completed');
    expect(generationStatusForStopReason('escalate')).toBe('completed');
  });
});
