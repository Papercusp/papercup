/**
 * Tests for the su-agent-behavior knowledge-capture teeth gate
 * (su-ideate-learning-substrate-2026-07-10 P-022(b), D-017).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseCaptureAttribution,
  classifyCaptureRating,
  evaluateCapturePersistence,
  resolveCapturePersistenceGate,
  KNOWLEDGE_CAPTURE_CRITERION,
  CAPTURE_NONCAPTURE_STREAK,
  type CaptureRatingSample,
  type CapturePersistenceDeps,
} from './capture-persistence-gate';

const partialAgent = (over: Partial<CaptureRatingSample> = {}): CaptureRatingSample => ({
  rating: 'partial',
  evidence: 'attribution:agent — missed capture at a durable-discovery moment',
  ...over,
});
const pass = (over: Partial<CaptureRatingSample> = {}): CaptureRatingSample => ({ rating: 'pass', evidence: 'captured', ...over });

describe('parseCaptureAttribution', () => {
  it('defaults to agent when no tag is present (D-017 premise)', () => {
    expect(parseCaptureAttribution(undefined)).toBe('agent');
    expect(parseCaptureAttribution('just some evidence, no attribution')).toBe('agent');
  });
  it('reads an explicit agent tag', () => {
    expect(parseCaptureAttribution('attribution:agent, missed the filing')).toBe('agent');
    expect(parseCaptureAttribution('attribution = self')).toBe('agent');
  });
  it('flips to non-agent on an explicit harness/model/na tag', () => {
    expect(parseCaptureAttribution('attribution:harness — the lane was down')).toBe('non-agent');
    expect(parseCaptureAttribution('attribution=model')).toBe('non-agent');
    expect(parseCaptureAttribution('attribution: na')).toBe('non-agent');
  });
});

describe('classifyCaptureRating', () => {
  it('a pass is capture (resets)', () => {
    expect(classifyCaptureRating(pass())).toBe('capture');
    expect(classifyCaptureRating({ rating: 'healthy' })).toBe('capture');
  });
  it('an agent-attributed shortfall is non-capture', () => {
    expect(classifyCaptureRating(partialAgent())).toBe('non-capture');
    expect(classifyCaptureRating({ rating: 'fail', evidence: 'attribution:agent' })).toBe('non-capture');
  });
  it('a shortfall defaults to agent-attribution (non-capture) with no tag', () => {
    expect(classifyCaptureRating({ rating: 'partial' })).toBe('non-capture');
  });
  it('a non-agent-attributed shortfall is neutral (skipped)', () => {
    expect(classifyCaptureRating({ rating: 'partial', evidence: 'attribution:harness' })).toBe('neutral');
  });
  it('unknown / unassessed is neutral', () => {
    expect(classifyCaptureRating({ rating: 'unknown' })).toBe('neutral');
    expect(classifyCaptureRating({ rating: 'idle: stage did not run' })).toBe('neutral');
  });
});

describe('evaluateCapturePersistence', () => {
  it('blocks on 4 consecutive agent-attributed non-capture batteries (D-017)', () => {
    const g = evaluateCapturePersistence([partialAgent(), partialAgent(), { rating: 'fail', evidence: 'attribution:agent' }, partialAgent()]);
    expect(g.blocking).toBe(true);
    expect(g.consecutiveNonCapture).toBe(4);
    expect(g.threshold).toBe(CAPTURE_NONCAPTURE_STREAK);
    expect(g.reason).toContain('BLOCKED');
  });
  it('does NOT block on 3 (below threshold)', () => {
    const g = evaluateCapturePersistence([partialAgent(), partialAgent(), partialAgent()]);
    expect(g.blocking).toBe(false);
    expect(g.consecutiveNonCapture).toBe(3);
  });
  it('a recent capture (pass) RESETS the leading streak even with older non-capture', () => {
    // newest-first: one pass at the head breaks the streak regardless of the tail
    const g = evaluateCapturePersistence([pass(), partialAgent(), partialAgent(), partialAgent(), partialAgent()]);
    expect(g.blocking).toBe(false);
    expect(g.consecutiveNonCapture).toBe(0);
  });
  it('skips neutral batteries (unassessed / non-agent) without breaking the streak', () => {
    // 4 agent non-capture interleaved with unknown + a non-agent shortfall — still 4 consecutive assessed
    const g = evaluateCapturePersistence([
      partialAgent(),
      { rating: 'unknown' },
      partialAgent(),
      { rating: 'partial', evidence: 'attribution:harness' },
      partialAgent(),
      partialAgent(),
    ]);
    expect(g.blocking).toBe(true);
    expect(g.consecutiveNonCapture).toBe(4);
  });
  it('honors a custom threshold', () => {
    const g = evaluateCapturePersistence([partialAgent(), partialAgent()], { threshold: 2 });
    expect(g.blocking).toBe(true);
    expect(g.threshold).toBe(2);
  });
  it('empty history never blocks', () => {
    const g = evaluateCapturePersistence([]);
    expect(g.blocking).toBe(false);
    expect(g.consecutiveNonCapture).toBe(0);
    expect(g.assessed).toBe(0);
  });
});

describe('resolveCapturePersistenceGate (impure)', () => {
  const makeDeps = (history: CaptureRatingSample[], throws = false): CapturePersistenceDeps => ({
    loadCriterionHistory: vi.fn(async () => {
      if (throws) throw new Error('pg down');
      return history;
    }),
  });

  it('blocks over a real (injected) 4-streak history and reads the su-agent-behavior rubric', async () => {
    const deps = makeDeps([partialAgent(), partialAgent(), partialAgent(), partialAgent()]);
    const g = await resolveCapturePersistenceGate({}, deps);
    expect(g.blocking).toBe(true);
    expect(deps.loadCriterionHistory).toHaveBeenCalledWith(
      expect.objectContaining({ rubricRef: 'su-agent-behavior', limit: expect.any(Number) }),
    );
  });

  it('passes sourceHive/since/threshold through to the reader', async () => {
    const deps = makeDeps([partialAgent(), partialAgent()]);
    const g = await resolveCapturePersistenceGate({ sourceHive: 'papercusp', since: '2026-07-01', threshold: 2, limit: 10 }, deps);
    expect(g.blocking).toBe(true);
    expect(deps.loadCriterionHistory).toHaveBeenCalledWith(
      expect.objectContaining({ rubricRef: 'su-agent-behavior', sourceHive: 'papercusp', since: '2026-07-01', limit: 10 }),
    );
  });

  it('FAILS OPEN (non-blocking) on a read error', async () => {
    const g = await resolveCapturePersistenceGate({}, makeDeps([], true));
    expect(g.blocking).toBe(false);
    expect(g.error).toBeDefined();
    expect(g.reason).toBe('read-error');
  });

  it('kill-switch disables the teeth (non-blocking)', async () => {
    const prev = process.env.PAPERCUSP_SU_CAPTURE_TEETH;
    process.env.PAPERCUSP_SU_CAPTURE_TEETH = 'off';
    try {
      const g = await resolveCapturePersistenceGate({}, makeDeps([partialAgent(), partialAgent(), partialAgent(), partialAgent()]));
      expect(g.blocking).toBe(false);
      expect(g.error).toBe('disabled');
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_SU_CAPTURE_TEETH;
      else process.env.PAPERCUSP_SU_CAPTURE_TEETH = prev;
    }
  });

  it('VITEST-inert without injected deps (non-blocking, never touches the store)', async () => {
    const g = await resolveCapturePersistenceGate({});
    expect(g.blocking).toBe(false);
    expect(g.error).toBe('vitest-inert');
  });

  it('exposes the criterion key the gate is about', () => {
    expect(KNOWLEDGE_CAPTURE_CRITERION).toBe('knowledge-capture-and-memory-routing');
  });
});
