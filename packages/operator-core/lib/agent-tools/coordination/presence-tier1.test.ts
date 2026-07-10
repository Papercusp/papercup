import { describe, it, expect } from 'vitest';
import {
  computeIntentStale,
  computeIntentDivergent,
  computeLastActiveSecAgo,
  INTENT_STALE_SEC,
  INTENT_DIVERGENCE_SEC,
  mergeTier1,
  type PresenceTier1Joins,
} from './presence-tier1';

const NOW = 1_700_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

describe('computeLastActiveSecAgo', () => {
  it('null when lastActiveAt is null or unparseable', () => {
    expect(computeLastActiveSecAgo(null, NOW)).toBeNull();
    expect(computeLastActiveSecAgo('not-a-date', NOW)).toBeNull();
  });

  it('seconds since lastActiveAt', () => {
    expect(computeLastActiveSecAgo(iso(NOW - 30_000), NOW)).toBe(30);
    expect(computeLastActiveSecAgo(iso(NOW - 1_000), NOW)).toBe(1);
  });

  it('clamps a future stamp to 0 (clock skew never goes negative)', () => {
    expect(computeLastActiveSecAgo(iso(NOW + 5_000), NOW)).toBe(0);
  });
});

describe('computeIntentStale', () => {
  it('null when activity is unknown (cannot judge a federated/never-active peer)', () => {
    expect(computeIntentStale(null)).toBeNull();
  });

  it('false while genuine activity is within the threshold', () => {
    expect(computeIntentStale(0)).toBe(false);
    expect(computeIntentStale(INTENT_STALE_SEC - 1)).toBe(false);
    expect(computeIntentStale(INTENT_STALE_SEC)).toBe(false); // boundary: exactly at threshold is NOT yet stale
  });

  it('true once genuine activity is past the threshold — the idle-but-heartbeating case', () => {
    expect(computeIntentStale(INTENT_STALE_SEC + 1)).toBe(true);
    // an su host idle 3h43m but still beating every 60s → its declared intent is stale
    expect(computeIntentStale(3 * 60 * 60 + 43 * 60)).toBe(true);
  });

  it('honors an explicit threshold override', () => {
    expect(computeIntentStale(100, 60)).toBe(true);
    expect(computeIntentStale(50, 60)).toBe(false);
  });
});

describe('computeIntentDivergent', () => {
  it('null when either side is unknown', () => {
    expect(computeIntentDivergent(null, 10)).toBeNull();
    expect(computeIntentDivergent(10, null)).toBeNull();
    expect(computeIntentDivergent(null, null)).toBeNull();
  });

  it('false when the intent text is at least as fresh as the activity gap allows', () => {
    expect(computeIntentDivergent(0, 0)).toBe(false);
    expect(computeIntentDivergent(100, 100)).toBe(false); // same age, no gap
    expect(computeIntentDivergent(INTENT_DIVERGENCE_SEC, 0)).toBe(false); // boundary
  });

  it('true once intentAgeSec runs past lastActiveSecAgo by more than the threshold — the EI-8988 drift case', () => {
    // su-6073d: fresh activity (root-causing WI-3646) but a 25-min-stale intent string.
    expect(computeIntentDivergent(INTENT_DIVERGENCE_SEC + 1, 0)).toBe(true);
    expect(computeIntentDivergent(25 * 60, 30)).toBe(true);
  });

  it('honors an explicit threshold override', () => {
    expect(computeIntentDivergent(100, 0, 60)).toBe(true);
    expect(computeIntentDivergent(50, 0, 60)).toBe(false);
  });
});

describe('mergeTier1', () => {
  const rec = (ownerId: string, lastActiveAt: string | null, intentDeclaredAt: string | null = null) => ({
    ownerId,
    lastActiveAt,
    intentDeclaredAt,
    ownerLabel: `lbl-${ownerId}`, // a base field that must survive the merge
  });

  it('attaches intentAgeSec + intentDivergent (EI-8988): fresh activity, stale intent text', () => {
    // Root-causing WI-3646 3s ago, but the declared intent string is 25 minutes old.
    const out = mergeTier1(
      [rec('su-6073d', iso(NOW - 3_000), iso(NOW - 25 * 60 * 1000))],
      new Map(),
      NOW,
    );
    expect(out[0].lastActiveSecAgo).toBe(3);
    expect(out[0].intentStale).toBe(false); // genuinely active — NOT idle
    expect(out[0].intentAgeSec).toBe(25 * 60);
    expect(out[0].intentDivergent).toBe(true); // but its declared text is drifted
  });

  it('intentDivergent is missing/omitted intentDeclaredAt on the base type — degrades to null, not a throw', () => {
    const out = mergeTier1([{ ownerId: 'a', lastActiveAt: iso(NOW - 10_000), ownerLabel: 'lbl-a' }], new Map(), NOW);
    expect(out[0].intentAgeSec).toBeNull();
    expect(out[0].intentDivergent).toBeNull();
  });

  it('attaches lastActiveSecAgo + the join fields, preserving base fields', () => {
    const joins = new Map<string, PresenceTier1Joins>([
      [
        'a',
        {
          claimedItems: ['P-001', 'P-002'],
          model: 'opus',
          awaitingEvent: true,
          awaitingEventKey: 'plan-run:finished:7',
          awaitingNote: 'waiting on the run',
          wakeMode: 'manual',
        },
      ],
    ]);
    const out = mergeTier1([rec('a', iso(NOW - 10_000))], joins, NOW);
    expect(out[0]).toMatchObject({
      ownerId: 'a',
      ownerLabel: 'lbl-a', // base field preserved
      lastActiveSecAgo: 10,
      intentStale: false, // active 10s ago → its intent is current
      claimedItems: ['P-001', 'P-002'],
      model: 'opus',
      awaitingEvent: true,
      awaitingEventKey: 'plan-run:finished:7',
      wakeMode: 'manual',
    });
  });

  it('flags intentStale TRUE for an idle-but-present agent (the heartbeat-alive-but-not-working case)', () => {
    // No join entry needed — intentStale is derived purely from last_active_at.
    const out = mergeTier1([rec('su-idle', iso(NOW - (INTENT_STALE_SEC + 60) * 1000))], new Map(), NOW);
    expect(out[0].lastActiveSecAgo).toBe(INTENT_STALE_SEC + 60);
    expect(out[0].intentStale).toBe(true);
  });

  it('a record with no join entry (e.g. a federated peer) gets lastActiveSecAgo + intentStale only', () => {
    const out = mergeTier1([rec('fed:1@boxA', null)], new Map(), NOW);
    expect(out[0].lastActiveSecAgo).toBeNull();
    expect(out[0].intentStale).toBeNull(); // activity unknown → cannot judge
    expect((out[0] as Partial<PresenceTier1Joins>).claimedItems).toBeUndefined();
    expect((out[0] as Partial<PresenceTier1Joins>).wakeMode).toBeUndefined();
  });
});
