import { describe, expect, it } from 'vitest';
import { buildBrowserCrashHealthPatterns, type BrowserCrashAggregate } from './browser-crash-health-lane';
import { flattenDigest } from './lenses';
import type { CorpusDigest } from './types';

const row = (fingerprint: string, rows: number): BrowserCrashAggregate => ({
  fingerprint, rows, boundary: 'adv-tab', errorType: 'TypeError',
  component: 'LearningTab', tab: 'learning', latestId: '42',
  latestAt: '2026-09-25T18:00:00Z',
});

describe('browser crash corpus patterns', () => {
  it('flattens a citable, redacted aggregate and rejects forged fingerprints', () => {
    const lane = buildBrowserCrashHealthPatterns([
      row('adv-tab:TypeError:LearningTab:learning', 3),
      row('raw URL ?token=secret', 4),
    ]);
    const digest = {
      recurringFriction: [], timeTokenSinks: [], chronicDeferrals: [], capabilityGaps: [],
      browserCrashHealth: lane,
    } satisfies CorpusDigest;
    const flat = flattenDigest(digest);
    expect(flat.map((pattern) => pattern.ref)).toEqual(['telemetry-report:42']);
    expect(flat[0]).toMatchObject({ category: 'browser-crash-health' });
    expect(flat[0]?.summary).toContain('3 redacted TypeError');
    expect(flat[0]?.detail).not.toContain('secret');
  });
});
