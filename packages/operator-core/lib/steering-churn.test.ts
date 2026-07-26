/**
 * steering-churn.test.ts — the pure churn detector (hive-network-surface P-010 /
 * Brief B-12; D-004). Counts writer FLIPS over a window: the same item steered by
 * one writer is no churn (the N=1 reality today); sustained ping-pong between
 * different writers (>= threshold flips) is thrash.
 */
import { describe, it, expect, vi } from 'vitest';
import { detectSteeringChurn, STEERING_CHURN_THRESHOLD, type SteerEvent } from './steering-churn';

// WI-5848 (sweep of EI-18668025239634541's class): mocked so the recurrence guard
// below can assert on the `meta.subjectSignature` (conditionKey)
// `defaultSteeringChurnEscalator` passes — without it, every escalation embeds a
// live churn count/writer count/duration in its summary, so dedup falls back to a
// prose hash that never repeats and leaks a fresh permanently-open row per firing.
vi.mock('./agent-tools/coordination/escalations', () => ({
  openEscalation: vi.fn(async () => undefined),
}));

const ev = (writer: string, ts: number): SteerEvent => ({ writer, ts, featureOrder: ts });

describe('detectSteeringChurn', () => {
  it('an empty window → no churn', () => {
    expect(detectSteeringChurn([])).toMatchObject({
      distinctWriters: 0,
      churnCount: 0,
      steerCount: 0,
      trip: false,
    });
  });

  it('a single writer (N=1 today) → 0 flips, never trips', () => {
    const r = detectSteeringChurn([ev('__local__', 1), ev('__local__', 2), ev('__local__', 3)]);
    expect(r).toMatchObject({ distinctWriters: 1, churnCount: 0, steerCount: 3, trip: false });
  });

  it('a single handoff (A→B) is ONE flip — below the default threshold', () => {
    const r = detectSteeringChurn([ev('__local__', 1), ev('peerB', 2)]);
    expect(r.distinctWriters).toBe(2);
    expect(r.churnCount).toBe(1);
    expect(r.trip).toBe(false);
  });

  it('sustained ping-pong (A→B→A→B) trips at the default threshold (3 flips)', () => {
    const r = detectSteeringChurn([ev('__local__', 1), ev('peerB', 2), ev('__local__', 3), ev('peerB', 4)]);
    expect(r.distinctWriters).toBe(2);
    expect(r.churnCount).toBe(3);
    expect(r.trip).toBe(true);
  });

  it('counts flips CHRONOLOGICALLY regardless of input order', () => {
    const r = detectSteeringChurn([ev('peerB', 4), ev('__local__', 1), ev('peerB', 2), ev('__local__', 3)]);
    expect(r.churnCount).toBe(3);
    expect(r.trip).toBe(true);
  });

  it('runs of the same writer between two writers are NOT flips', () => {
    // a,a,a,b → only one flip (a→b)
    const r = detectSteeringChurn([ev('a', 1), ev('a', 2), ev('a', 3), ev('b', 4)]);
    expect(r.distinctWriters).toBe(2);
    expect(r.churnCount).toBe(1);
    expect(r.trip).toBe(false);
  });

  it('honours an explicit threshold (a single flip trips at threshold 1)', () => {
    expect(detectSteeringChurn([ev('__local__', 1), ev('peerB', 2)], { threshold: 1 }).trip).toBe(true);
  });

  it('three writers thrashing also trips', () => {
    const r = detectSteeringChurn([ev('a', 1), ev('b', 2), ev('c', 3), ev('a', 4)]);
    expect(r.distinctWriters).toBe(3);
    expect(r.churnCount).toBe(3);
    expect(r.trip).toBe(true);
  });

  it('exposes the distinct writers sorted (for the escalation body)', () => {
    expect(detectSteeringChurn([ev('z', 1), ev('a', 2), ev('z', 3), ev('a', 4)]).writers).toEqual(['a', 'z']);
  });

  it('the default flip threshold is 3', () => {
    expect(STEERING_CHURN_THRESHOLD).toBe(3);
  });
});

describe('defaultSteeringChurnEscalator — stable conditionKey (WI-5848)', () => {
  const resultBase = {
    distinctWriters: 2,
    writers: ['a', 'b'],
    steerCount: 4,
  };

  it('passes an IDENTICAL non-empty conditionKey across two calls with DIFFERENT churn counts/duration', async () => {
    const { openEscalation } = await import('./agent-tools/coordination/escalations');
    const { defaultSteeringChurnEscalator } = await import('./steering-churn');
    const mockOpenEscalation = vi.mocked(openEscalation);
    mockOpenEscalation.mockClear();

    await defaultSteeringChurnEscalator({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      featureId: 'F-1',
      result: { ...resultBase, churnCount: 3, trip: true },
      windowMs: 5 * 60_000,
    });
    await defaultSteeringChurnEscalator({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      featureId: 'F-1',
      result: { ...resultBase, churnCount: 9, trip: true },
      windowMs: 47 * 60_000,
    });

    expect(mockOpenEscalation).toHaveBeenCalledTimes(2);
    const key1 = (mockOpenEscalation.mock.calls[0]?.[1] as { meta?: { subjectSignature?: string } })?.meta
      ?.subjectSignature;
    const key2 = (mockOpenEscalation.mock.calls[1]?.[1] as { meta?: { subjectSignature?: string } })?.meta
      ?.subjectSignature;
    expect(key1).toBeTruthy();
    expect(key1).toBe(key2); // THE regression this guards: must NOT vary with churnCount/writers/windowMs.
    expect(key1).toBe('steering-churn:ws-1:papercusp:F-1');
  });

  it('keys the conditionKey on the (workspace, harness, feature) identity, distinguishing different items', async () => {
    const { openEscalation } = await import('./agent-tools/coordination/escalations');
    const { defaultSteeringChurnEscalator } = await import('./steering-churn');
    const mockOpenEscalation = vi.mocked(openEscalation);
    mockOpenEscalation.mockClear();

    await defaultSteeringChurnEscalator({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      featureId: 'F-1',
      result: { ...resultBase, churnCount: 3, trip: true },
      windowMs: 5 * 60_000,
    });
    await defaultSteeringChurnEscalator({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      featureId: 'F-2',
      result: { ...resultBase, churnCount: 3, trip: true },
      windowMs: 5 * 60_000,
    });

    const keyA = (mockOpenEscalation.mock.calls[0]?.[1] as { meta?: { subjectSignature?: string } })?.meta
      ?.subjectSignature;
    const keyB = (mockOpenEscalation.mock.calls[1]?.[1] as { meta?: { subjectSignature?: string } })?.meta
      ?.subjectSignature;
    expect(keyA).not.toBe(keyB);
  });
});
