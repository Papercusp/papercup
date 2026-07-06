/**
 * provenance.test.ts — signal-origin provenance (self-learning-frontier P-002 /
 * D-002, brief FB-03).
 *
 * The load-bearing assertion of the lane: A DRILL-TAGGED ROW NEVER REACHES AN
 * ORGANIC LEARNER. Every loop consumer reads through the one repointable seam
 * (readImprovementItems), so the proof drives REAL consumer entry points over a
 * mixed-origin store and asserts the synthetic rows are invisible:
 *   - the decay sweep (a learner that writes lifecycle verdicts back),
 *   - the watchdog's key-dup partition (cross-origin dups must not absorb
 *     each other's signals),
 * plus the exact-match fail-closed semantics of the helpers themselves.
 * Capture-side isolation (dedup/recall origin-scoping) is capture-core.test.ts;
 * the SQL column round-trip is provenance.integration.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SIGNAL_ORIGIN,
  ORGANIC_ONLY,
  SIGNAL_ORIGINS,
  effectiveOrigin,
  isSignalOrigin,
  originAllowed,
} from './provenance';
import { readImprovementItems } from './read-items';
import { runDecaySweep } from './decay';
import { partitionSignalsByKnownKeys, type WatchdogSignal } from './watchdog';
import type { EngineerIssue } from '../../issues-engineer';

function issue(p: Partial<EngineerIssue> & { id: string; title: string }): EngineerIssue {
  return {
    kind: 'bug',
    scope: 'operator',
    body: '',
    severity: 'minor',
    source: 'su',
    state: 'open',
    assignee: null,
    assignedBy: null,
    assignedAt: null,
    payload: null,
    foundDuring: null,
    linkedFeatureId: null,
    createdBy: 'su-test',
    signalOrigin: 'organic',
    assigneeRank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    lastProgressAt: null,
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    ...p,
  };
}

describe('provenance helpers — exact-match, fail-closed', () => {
  it('the four origins are recognized; anything else is not', () => {
    for (const o of SIGNAL_ORIGINS) expect(isSignalOrigin(o)).toBe(true);
    expect(isSignalOrigin('mystery')).toBe(false);
    expect(isSignalOrigin('')).toBe(false);
    expect(isSignalOrigin(undefined)).toBe(false);
    expect(isSignalOrigin(7)).toBe(false);
  });

  it('a missing value is organic (the migration-DEFAULT semantics); junk stays junk', () => {
    expect(effectiveOrigin(undefined)).toBe(DEFAULT_SIGNAL_ORIGIN);
    expect(effectiveOrigin(null)).toBe(DEFAULT_SIGNAL_ORIGIN);
    expect(effectiveOrigin('drill')).toBe('drill');
    expect(effectiveOrigin('mystery')).toBe('mystery'); // NOT normalized to organic
  });

  it('originAllowed defaults to organic-only and fails closed on junk', () => {
    expect(originAllowed(undefined)).toBe(true); // legacy row = organic
    expect(originAllowed('organic')).toBe(true);
    expect(originAllowed('drill')).toBe(false);
    expect(originAllowed('mystery')).toBe(false); // junk never reaches organic consumers
    expect(originAllowed('drill', ['drill'])).toBe(true);
    expect(originAllowed('organic', ['drill'])).toBe(false);
    expect(ORGANIC_ONLY).toEqual(['organic']);
  });
});

describe('THE PROOF — a drill row never reaches an organic learner (D-002)', () => {
  // A mixed store in which every synthetic row is maximally tempting to a
  // learner: resolved + applied lifecycle (decay would grade it), same title
  // signature as the organic row (recurrence matching would bite).
  const mixedStore = [
    issue({
      id: 'EI-ORGANIC',
      title: 'presence list dumps stale rows',
      state: 'resolved',
      updatedAt: '2026-06-02T00:00:00Z',
      // code-bug = decay-VERIFIABLE class: if the drill rows leaked in, the fake
      // same-signature drill "recurrence" would flip this to recurred instead.
      payload: { ideaLifecycle: { state: 'applied', stateUpdatedAt: '2026-06-02T00:00:00Z', ideaType: 'code-bug' } },
    }),
    issue({
      id: 'EI-DRILL',
      title: 'presence list dumps stale rows',
      state: 'resolved',
      signalOrigin: 'drill',
      updatedAt: '2026-06-02T00:00:00Z',
      payload: { ideaLifecycle: { state: 'applied', stateUpdatedAt: '2026-06-02T00:00:00Z' } },
    }),
    issue({
      id: 'EI-DRILL-OPEN',
      title: 'presence list dumps stale rows',
      state: 'open',
      signalOrigin: 'drill',
      createdAt: '2026-06-10T00:00:00Z', // post-resolution — would read as a recurrence
    }),
    issue({ id: 'EI-REPLAY', title: 'replay artifact row', signalOrigin: 'replay' }),
  ];

  it('the decay sweep (real consumer, real seam) grades the organic row and never touches a synthetic one', async () => {
    const touched: string[] = [];
    const result = await runDecaySweep(
      { nowMs: Date.parse('2026-07-01T00:00:00Z') },
      {
        // The REAL seam with an injected lister that "forgets" to filter — the
        // gate inside readImprovementItems is what is under test.
        readItems: () => readImprovementItems({}, { listIssues: async () => mixedStore }),
        mergeIssuePayload: async (id) => (touched.push(id), null),
        commentIssue: async () => null,
      },
    );
    expect(result.scanned).toBe(1); // ONLY the organic row entered the learner
    expect(touched).not.toContain('EI-DRILL');
    expect(touched).not.toContain('EI-DRILL-OPEN');
    expect(touched).not.toContain('EI-REPLAY');
    // And the drill "recurrence" did NOT poison the organic row's verdict: with
    // the drill rows invisible there is no same-signature recurrence, so the
    // organic row decay-verifies instead of being marked recurred.
    expect(touched).toEqual(['EI-ORGANIC']);
    expect(result.verified).toBe(1);
    expect(result.recurred).toBe(0);
  });

  it('the watchdog partition never lets cross-origin dups absorb a signal', () => {
    const drillSignal: WatchdogSignal = {
      source: 'red-test',
      key: 'lib/a.test.ts',
      title: 'Test failing repeatedly: lib/a.test.ts',
      body: '',
      severity: 'major',
      origin: 'drill',
    };
    const organicSignal: WatchdogSignal = { ...drillSignal, origin: undefined };

    // An ORGANIC open item on the same key must not read the DRILL signal as
    // known-open (the drill would silently never file)…
    const organicDup = { watchdogKey: 'red-test:lib/a.test.ts', state: 'open', updatedAt: '2026-06-01T00:00:00Z', signalOrigin: 'organic' };
    expect(partitionSignalsByKnownKeys([drillSignal], [organicDup]).fresh).toEqual([drillSignal]);

    // …and a DRILL open item must not absorb the ORGANIC signal (synthetic
    // suppressing real — the exact pathology D-002 exists to prevent).
    const drillDup = { ...organicDup, signalOrigin: 'drill' };
    expect(partitionSignalsByKnownKeys([organicSignal], [drillDup]).fresh).toEqual([organicSignal]);

    // Same-origin matching is unchanged: organic-on-organic is known-open.
    expect(partitionSignalsByKnownKeys([organicSignal], [organicDup]).knownOpen).toEqual([organicSignal]);
    // A legacy dup with NO origin reads organic — still matches an organic signal.
    const legacyDup = { watchdogKey: 'red-test:lib/a.test.ts', state: 'open', updatedAt: '2026-06-01T00:00:00Z' };
    expect(partitionSignalsByKnownKeys([organicSignal], [legacyDup]).knownOpen).toEqual([organicSignal]);
  });
});
