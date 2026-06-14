import { describe, it, expect } from 'vitest';
import { computeLastActiveSecAgo, mergeTier1, type PresenceTier1Joins } from './presence-tier1';

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

describe('mergeTier1', () => {
  const rec = (ownerId: string, lastActiveAt: string | null) => ({
    ownerId,
    lastActiveAt,
    ownerLabel: `lbl-${ownerId}`, // a base field that must survive the merge
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
      claimedItems: ['P-001', 'P-002'],
      model: 'opus',
      awaitingEvent: true,
      awaitingEventKey: 'plan-run:finished:7',
      wakeMode: 'manual',
    });
  });

  it('a record with no join entry (e.g. a federated peer) gets lastActiveSecAgo only', () => {
    const out = mergeTier1([rec('fed:1@boxA', null)], new Map(), NOW);
    expect(out[0].lastActiveSecAgo).toBeNull();
    expect((out[0] as Partial<PresenceTier1Joins>).claimedItems).toBeUndefined();
    expect((out[0] as Partial<PresenceTier1Joins>).wakeMode).toBeUndefined();
  });
});
