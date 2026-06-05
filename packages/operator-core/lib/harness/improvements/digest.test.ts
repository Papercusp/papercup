import { describe, it, expect } from 'vitest';
import { buildDigest, dedupSignature, findLikelyDuplicates } from './digest';
import type { ImprovementCandidate } from './policy';

const NOW = Date.parse('2026-06-04T12:00:00Z');
function daysAgo(n: number): string {
  return new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();
}
function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return { kind: 'change', scope: 'operator', title: 'a thing', state: 'open', ...p };
}

describe('dedupSignature', () => {
  it('strips the [kind] prefix and is word-order invariant', () => {
    expect(dedupSignature('[bug] Presence list overflows')).toBe(dedupSignature('list presence overflows'));
  });
  it('ignores punctuation + case', () => {
    expect(dedupSignature('coord:inbox OVERFLOWS!!')).toBe(dedupSignature('coord inbox overflows'));
  });
});

describe('findLikelyDuplicates', () => {
  it('clusters exact normalized-signature matches', () => {
    const clusters = findLikelyDuplicates([
      cand({ id: 'a', title: '[bug] presence list overflows token limit' }),
      cand({ id: 'b', title: 'token limit overflows presence list' }),
      cand({ id: 'c', title: 'something entirely different here' }),
    ]);
    const all = clusters.flatMap((c) => c.ids).sort();
    expect(all).toEqual(['a', 'b']);
  });
  it('catches near-duplicates by token overlap', () => {
    const clusters = findLikelyDuplicates([
      cand({ id: 'x', title: 'migration number allocator collision race two agents' }),
      cand({ id: 'y', title: 'migration number allocator collision race agents' }),
    ]);
    expect(clusters.length).toBe(1);
    expect(clusters[0].ids.sort()).toEqual(['x', 'y']);
  });
  it('returns no clusters when everything is distinct', () => {
    expect(
      findLikelyDuplicates([cand({ id: '1', title: 'alpha beta gamma' }), cand({ id: '2', title: 'delta epsilon zeta' })]),
    ).toEqual([]);
  });
});

describe('buildDigest', () => {
  const items: ImprovementCandidate[] = [
    cand({ id: 'B1', kind: 'bug', severity: 'major', title: 'presence dumps stale rows', createdAt: daysAgo(2) }),
    cand({ id: 'B2', kind: 'bug', severity: 'critical', title: 'tool crashes on missing key', createdAt: daysAgo(1) }),
    cand({ id: 'C1', kind: 'change', severity: 'minor', title: 'bigger inbox digest', createdAt: daysAgo(5) }),
    cand({ id: 'B3', kind: 'bug', severity: 'major', title: 'deploy gate flake', createdAt: daysAgo(3) }), // keyword→human
    cand({ id: 'R1', kind: 'bug', severity: 'minor', title: 'resolved already', state: 'resolved', createdAt: daysAgo(10) }),
  ];

  it('splits open items into auto lane vs human queue (D-004)', () => {
    const d = buildDigest(items, { nowMs: NOW });
    expect(d.autoEligible.map((i) => i.id).sort()).toEqual(['B1', 'B2']);
    // C1 (change) + B3 (deploy keyword) are human; R1 is resolved so not queued.
    expect(d.humanQueue.map((i) => i.id).sort()).toEqual(['B3', 'C1']);
  });

  it('counts resolved items in rollups but not in the queues', () => {
    const d = buildDigest(items, { nowMs: NOW });
    expect(d.total).toBe(5);
    expect(d.open).toBe(4);
    expect(d.byState.resolved).toBe(1);
    expect(d.byKind.bug).toBe(4);
    expect(d.byKind.change).toBe(1);
  });

  it('sorts the auto lane by score (critical floats above major)', () => {
    const d = buildDigest(items, { nowMs: NOW });
    expect(d.autoEligible[0].id).toBe('B2'); // critical > major
  });

  it('produces a non-empty headline mentioning the split', () => {
    const d = buildDigest(items, { nowMs: NOW });
    expect(d.headline).toMatch(/auto-eligible/);
    expect(d.headline).toMatch(/need a human/);
  });

  it('is deterministic given nowMs', () => {
    expect(buildDigest(items, { nowMs: NOW })).toEqual(buildDigest(items, { nowMs: NOW }));
  });

  it('empty input yields an empty but well-formed digest', () => {
    const d = buildDigest([], { nowMs: NOW });
    expect(d.total).toBe(0);
    expect(d.autoEligible).toEqual([]);
    expect(d.humanQueue).toEqual([]);
    expect(d.likelyDuplicates).toEqual([]);
  });
});
