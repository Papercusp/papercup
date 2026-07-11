/**
 * Tests for the coord:orient capture-MISS advisory
 * (su-ideate-learning-substrate-2026-07-10 P-022(a), D-017).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  detectHighSignalMarkers,
  computeCaptureMissHint,
  resolveCaptureMissHint,
  type CaptureMissHintDeps,
} from './orient-capture-miss-hint';

describe('detectHighSignalMarkers', () => {
  it('detects an error-retry CLUSTER (≥2 tokens), not a single mention', () => {
    expect(detectHighSignalMarkers(['the test passed, 0 errors']).errorRetryCluster).toBe(false);
    const m = detectHighSignalMarkers(['retried the failing test after the timeout, then it errored again']);
    expect(m.errorRetryCluster).toBe(true);
    expect(m.hits).toContain('error-retry cluster');
  });
  it('detects an EI-* reference', () => {
    const m = detectHighSignalMarkers(['root-caused via EI-9326']);
    expect(m.eiReference).toBe(true);
    expect(m.hits).toContain('EI-* reference');
  });
  it('detects durable-discovery language', () => {
    expect(detectHighSignalMarkers(['turns out the root cause was a stale cache']).durableDiscovery).toBe(true);
    expect(detectHighSignalMarkers(['the fix was to canonicalize the workspace id']).durableDiscovery).toBe(true);
    expect(detectHighSignalMarkers(['a subtle footgun in the join']).durableDiscovery).toBe(true);
  });
  it('a plain status line trips nothing', () => {
    const m = detectHighSignalMarkers(['flipped P-022 to done, wrote the plan Now block']);
    expect(m.errorRetryCluster).toBe(false);
    expect(m.eiReference).toBe(false);
    expect(m.durableDiscovery).toBe(false);
    expect(m.hits).toEqual([]);
  });
});

describe('computeCaptureMissHint', () => {
  const markers = detectHighSignalMarkers(['turns out EI-9326 was the root cause']);
  it('fires when high-signal AND zero filings', () => {
    const hint = computeCaptureMissHint({ markers, laneFilingsSince: 0 });
    expect(hint).not.toBeNull();
    expect(hint?.advise).toBe(true);
    expect(hint?.reason).toContain('lane:observation');
    expect(hint?.reason).toContain('not a quota');
  });
  it('does NOT fire when the caller filed something', () => {
    expect(computeCaptureMissHint({ markers, laneFilingsSince: 1 })).toBeNull();
  });
  it('does NOT fire on a quiet (no-marker) turn even with zero filings', () => {
    const quiet = detectHighSignalMarkers(['flipped an item to done']);
    expect(computeCaptureMissHint({ markers: quiet, laneFilingsSince: 0 })).toBeNull();
  });
});

describe('resolveCaptureMissHint (impure)', () => {
  const makeDeps = (over: {
    filings?: number;
    filingsThrows?: boolean;
    samples?: string[];
    samplesThrows?: boolean;
  } = {}): CaptureMissHintDeps => ({
    countLaneFilingsSince: vi.fn(async () => {
      if (over.filingsThrows) throw new Error('pg');
      return over.filings ?? 0;
    }),
    gatherSignalText: vi.fn(async () => {
      if (over.samplesThrows) throw new Error('carry-note store');
      return over.samples ?? [];
    }),
  });

  it('fires the advisory on a high-signal zero-filing caller', async () => {
    const deps = makeDeps({ filings: 0, samples: ['retried the failing build twice; turns out EI-100 was the culprit'] });
    const hint = await resolveCaptureMissHint({ ownerId: 'su-x', harness: 'papercusp' }, deps);
    expect(hint?.advise).toBe(true);
    expect(deps.gatherSignalText).toHaveBeenCalledWith('su-x', 'papercusp');
  });

  it('SHORT-CIRCUITS the marker gather when the caller filed something', async () => {
    const deps = makeDeps({ filings: 2, samples: ['turns out EI-1 was the root cause'] });
    const hint = await resolveCaptureMissHint({ ownerId: 'su-x', harness: 'papercusp' }, deps);
    expect(hint).toBeUndefined();
    expect(deps.gatherSignalText).not.toHaveBeenCalled();
  });

  it('does not nudge on an UNCONFIRMED filing count (read error → -1)', async () => {
    const deps = makeDeps({ filingsThrows: true, samples: ['turns out EI-1 was the root cause'] });
    const hint = await resolveCaptureMissHint({ ownerId: 'su-x', harness: 'papercusp' }, deps);
    expect(hint).toBeUndefined();
    expect(deps.gatherSignalText).not.toHaveBeenCalled();
  });

  it('returns undefined when zero-filing but the turn was quiet', async () => {
    const deps = makeDeps({ filings: 0, samples: ['flipped P-1 to done'] });
    expect(await resolveCaptureMissHint({ ownerId: 'su-x', harness: 'papercusp' }, deps)).toBeUndefined();
  });

  it('fail-soft: a signal-gather error yields no advisory (never throws)', async () => {
    const deps = makeDeps({ filings: 0, samplesThrows: true });
    expect(await resolveCaptureMissHint({ ownerId: 'su-x', harness: 'papercusp' }, deps)).toBeUndefined();
  });

  it('blank ownerId → undefined', async () => {
    expect(await resolveCaptureMissHint({ ownerId: '  ' }, makeDeps({ filings: 0 }))).toBeUndefined();
  });

  it('kill-switch disables the advisory', async () => {
    const prev = process.env.PAPERCUSP_SU_CAPTURE_MISS;
    process.env.PAPERCUSP_SU_CAPTURE_MISS = 'off';
    try {
      const deps = makeDeps({ filings: 0, samples: ['turns out EI-1 was the root cause'] });
      expect(await resolveCaptureMissHint({ ownerId: 'su-x', harness: 'papercusp' }, deps)).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_SU_CAPTURE_MISS;
      else process.env.PAPERCUSP_SU_CAPTURE_MISS = prev;
    }
  });

  it('VITEST-inert without injected deps', async () => {
    expect(await resolveCaptureMissHint({ ownerId: 'su-x', harness: 'papercusp' })).toBeUndefined();
  });
});
