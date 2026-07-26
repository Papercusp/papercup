import { describe, it, expect } from 'vitest';
import {
  buildDigest,
  dedupSignature,
  findLikelyDuplicates,
  signatureRecurrence,
  recallAlreadyDecided,
  titleSimilarity,
} from './digest';
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

describe('titleSimilarity (the Jaccard the 0.8 dedup threshold rides on)', () => {
  it('is 1.0 for identical signatures (word-order + [kind] invariant)', () => {
    expect(titleSimilarity('Fix the login bug', 'fix the login bug')).toBe(1);
    expect(titleSimilarity('login bug fix', 'fix login bug')).toBe(1);
    expect(titleSimilarity('[bug] login fix', 'login fix')).toBe(1);
  });

  it('is 0 for fully disjoint signatures', () => {
    expect(titleSimilarity('alpha beta gamma', 'delta epsilon zeta')).toBe(0);
  });

  it('is the exact token-set Jaccard for partial overlap', () => {
    // {apple,banana} ∩ {banana,cherry} = 1 ; ∪ = 3 → 1/3
    expect(titleSimilarity('apple banana', 'banana cherry')).toBeCloseTo(1 / 3, 5);
  });

  it('treats two signature-empty titles (all sub-3-char tokens) as identical', () => {
    expect(titleSimilarity('a b c', 'x y z')).toBe(1);
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
  it('clusters exact + near-dup correctly across a larger batch (round-4 P-001 precompute path)', () => {
    const cands = [
      cand({ id: 'exactA', title: '[bug] presence list overflows token limit' }),
      cand({ id: 'exactB', title: 'token limit overflows presence list' }), // exact-signature of exactA
      cand({ id: 'nearA', title: 'migration number allocator collision race two agents' }),
      cand({ id: 'nearB', title: 'migration number allocator collision race agents' }), // near-dup of nearA (Jaccard ≥ 0.8)
      ...Array.from({ length: 60 }, (_, i) => cand({ id: `f${i}`, title: `uniquetopic${i}` })),
    ];
    const clusters = findLikelyDuplicates(cands);
    const member = (id: string) => clusters.find((c) => c.ids.includes(id))?.ids.slice().sort();
    expect(member('exactA')).toEqual(['exactA', 'exactB']);
    expect(member('nearA')).toEqual(['nearA', 'nearB']);
    expect(clusters.flatMap((c) => c.ids)).not.toContain('f0'); // distinct filler never clusters
  });
  // WI-5820: the near-dup pass gained an inverted-token-index + size-band
  // pre-filter after a live bg-host CPU profile attributed 842ms of self-time —
  // the largest first-party cost in the sampled window — to jaccard() on this
  // path. Both filter conditions are provably NECESSARY for jaccard >= threshold,
  // so the clusters must be IDENTICAL to the brute-force all-pairs result. These
  // tests are the equivalence proof; without them the optimization is a guess.
  describe('WI-5820 pre-filter equivalence with brute-force all-pairs', () => {
    const NEAR_DUP_JACCARD = 0.8;
    /** The pre-optimization algorithm, verbatim in shape: exact-signature groups,
     *  then an unfiltered O(n²) ascending scan claiming greedily. */
    function bruteForce(candidates: ImprovementCandidate[]): { signature: string; ids: string[] }[] {
      const bySig = new Map<string, string[]>();
      const sigById = new Map<string, string>();
      for (const c of candidates) {
        const sig = dedupSignature(c.title);
        sigById.set(c.id, sig);
        if (!sig) continue;
        const arr = bySig.get(sig) ?? [];
        arr.push(c.id);
        bySig.set(sig, arr);
      }
      const clusters: { signature: string; ids: string[] }[] = [];
      const claimed = new Set<string>();
      for (const [signature, ids] of bySig) {
        if (ids.length > 1) {
          clusters.push({ signature, ids });
          ids.forEach((id) => claimed.add(id));
        }
      }
      const remaining = candidates.filter((c) => !claimed.has(c.id));
      const tok = (t: string) => new Set(dedupSignature(t).split(' ').filter(Boolean));
      const jac = (a: Set<string>, b: Set<string>) => {
        if (a.size === 0 && b.size === 0) return 1;
        let inter = 0;
        for (const t of a) if (b.has(t)) inter += 1;
        const union = a.size + b.size - inter;
        return union === 0 ? 0 : inter / union;
      };
      const sets = remaining.map((c) => tok(c.title));
      for (let i = 0; i < remaining.length; i++) {
        if (claimed.has(remaining[i].id)) continue;
        const a = sets[i];
        if (a.size === 0) continue;
        const group = [remaining[i].id];
        for (let j = i + 1; j < remaining.length; j++) {
          if (claimed.has(remaining[j].id)) continue;
          if (jac(a, sets[j]) >= NEAR_DUP_JACCARD) {
            group.push(remaining[j].id);
            claimed.add(remaining[j].id);
          }
        }
        if (group.length > 1) {
          claimed.add(remaining[i].id);
          clusters.push({
            signature: sigById.get(remaining[i].id) ?? dedupSignature(remaining[i].title),
            ids: group,
          });
        }
      }
      return clusters;
    }

    // Deterministic PRNG so a failure is reproducible from the seed alone.
    function rng(seed: number): () => number {
      let s = seed >>> 0;
      return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
      };
    }

    it.each([1, 2, 3, 4, 5])(
      'matches brute-force exactly on a randomized corpus (seed %i) with heavy token reuse',
      (seed) => {
        const rand = rng(seed * 7919);
        // A vocabulary small enough that near-dups, exact-signature collisions,
        // partial overlaps and size-mismatched pairs all occur naturally.
        const vocab = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
        const cands = Array.from({ length: 120 }, (_, i) => {
          const len = 2 + Math.floor(rand() * 5);
          const words = Array.from({ length: len }, () => vocab[Math.floor(rand() * vocab.length)]);
          return cand({ id: `r${i}`, title: words.join(' ') });
        });
        const norm = (cs: { ids: string[] }[]) =>
          cs
            .map((c) => c.ids.slice().sort().join(','))
            .sort()
            .join(' | ');
        expect(norm(findLikelyDuplicates(cands))).toBe(norm(bruteForce(cands)));
      },
    );

    it('still clusters a pair that shares tokens but sits at the size-band edge', () => {
      // 4 tokens vs 5 tokens, 4 shared → jaccard 4/5 = 0.8, exactly AT threshold.
      // The size band (0.8) must not exclude it: 4/5 = 0.8 is within the band.
      const clusters = findLikelyDuplicates([
        cand({ id: 'p', title: 'alpha bravo charlie delta' }),
        cand({ id: 'q', title: 'alpha bravo charlie delta echo' }),
      ]);
      expect(clusters.length).toBe(1);
      expect(clusters[0].ids.sort()).toEqual(['p', 'q']);
      // and it agrees with the reference
      expect(bruteForce([
        cand({ id: 'p', title: 'alpha bravo charlie delta' }),
        cand({ id: 'q', title: 'alpha bravo charlie delta echo' }),
      ]).length).toBe(1);
    });

    it('never clusters a pair sharing NO token (the inverted-index skip is sound)', () => {
      const clusters = findLikelyDuplicates([
        cand({ id: 'm', title: 'alpha bravo charlie' }),
        cand({ id: 'n', title: 'xray yankee zulu' }),
      ]);
      expect(clusters).toEqual([]);
    });
  });

  it('skips the O(n²) near-dup pass above NEAR_DUP_MAX_CANDIDATES but keeps exact-signature clusters (round-4 P-001 bound)', () => {
    const filler = Array.from({ length: 4100 }, (_, i) => cand({ id: `g${i}`, title: `capfiller${i}` }));
    const clusters = findLikelyDuplicates([
      cand({ id: 'exact1', title: 'token limit overflows presence list' }),
      cand({ id: 'exact2', title: '[bug] presence list overflows token limit' }), // exact-signature match
      cand({ id: 'near1', title: 'migration number allocator collision race two agents' }),
      cand({ id: 'near2', title: 'migration number allocator collision race agents' }), // near-dup, NOT exact-signature
      ...filler,
    ]);
    const flat = clusters.flatMap((c) => c.ids);
    expect(flat).toContain('exact1'); // exact-signature pass still runs above the cap
    expect(flat).toContain('exact2');
    expect(flat).not.toContain('near1'); // near-dup pass skipped above the cap (best-effort, D-001)
    expect(flat).not.toContain('near2');
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

  it('passes payload.watchdogKey through onto the ScoredItem, and omits it when absent (EI-14223)', () => {
    const d = buildDigest(
      [
        cand({ id: 'K1', kind: 'bug', createdAt: daysAgo(1), watchdogKey: 'dispatcher-staleness:auto-implement-dispatcher' }),
        cand({ id: 'K2', kind: 'bug', createdAt: daysAgo(1) }), // keyless — manual capture
      ],
      { nowMs: NOW },
    );
    const k1 = d.autoEligible.find((i) => i.id === 'K1');
    const k2 = d.autoEligible.find((i) => i.id === 'K2');
    expect(k1?.watchdogKey).toBe('dispatcher-staleness:auto-implement-dispatcher');
    expect(k2?.watchdogKey).toBeUndefined();
  });

  it('excludes a remote-authored (federated) bug from the auto lane — routes to humanQueue instead (EI-15659)', () => {
    const d = buildDigest(
      [
        cand({ id: 'RM1', kind: 'bug', createdAt: daysAgo(1), workItemOrigin: 'remote' }),
        cand({ id: 'RM2', kind: 'bug', createdAt: daysAgo(1) }), // local — control, stays auto
      ],
      { nowMs: NOW },
    );
    expect(d.autoEligible.map((i) => i.id)).toEqual(['RM2']);
    const remote = d.humanQueue.find((i) => i.id === 'RM1');
    expect(remote).toBeDefined();
    expect(remote?.tierReason).toMatch(/remote-authored/);
    expect(remote?.workItemOrigin).toBe('remote');
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
    expect(d.recurringSignatures).toEqual([]);
  });

  it('surfaces recurring signatures (P-003) only when a signature recurred (count > 1)', () => {
    const recurring: ImprovementCandidate[] = [
      cand({ id: 'r1', title: 'lock contention stomped my edit', createdAt: daysAgo(8) }),
      cand({ id: 'r2', title: 'my edit stomped by lock contention', createdAt: daysAgo(2) }), // same signature, reworded
      cand({ id: 'u1', title: 'a one-off unique annoyance here', createdAt: daysAgo(1) }),
    ];
    const d = buildDigest(recurring, { nowMs: NOW });
    expect(d.recurringSignatures).toHaveLength(1);
    expect(d.recurringSignatures[0].count).toBe(2);
    expect(d.recurringSignatures[0].ids.sort()).toEqual(['r1', 'r2']);
    expect(d.headline).toMatch(/recurring signature/);
  });
});

/**
 * Recurrence-decay on the STABLE signature (P-003, D-003) — the keystone matcher
 * is the same normalized-signature + Jaccard the dedup uses, NOT raw title text.
 */
describe('signatureRecurrence', () => {
  it('groups re-worded re-encounters under one signature and measures decay from the freshest', () => {
    const items: ImprovementCandidate[] = [
      cand({ id: 'a', title: 'coord inbox overflows token budget', updatedAt: daysAgo(20) }),
      cand({ id: 'b', title: 'token budget overflows coord inbox', updatedAt: daysAgo(3) }),
    ];
    const recs = signatureRecurrence(items, { nowMs: NOW });
    expect(recs).toHaveLength(1);
    expect(recs[0].count).toBe(2);
    // decay measured from the FRESHEST member (3 days), not the oldest.
    expect(recs[0].decayDays).toBe(3);
  });

  it('splits open vs resolved so active friction reads differently from handled', () => {
    const items: ImprovementCandidate[] = [
      cand({ id: 'o', title: 'flaky thing keeps recurring', state: 'open', updatedAt: daysAgo(1) }),
      cand({ id: 'r', title: 'recurring flaky thing keeps', state: 'resolved', updatedAt: daysAgo(40) }),
    ];
    const recs = signatureRecurrence(items, { nowMs: NOW });
    expect(recs[0].openCount).toBe(1);
    expect(recs[0].resolvedCount).toBe(1);
  });

  it('sorts most-recurring first, then freshest', () => {
    const items: ImprovementCandidate[] = [
      cand({ id: 's1', title: 'rare friction alpha', updatedAt: daysAgo(1) }),
      cand({ id: 'm1', title: 'common friction beta', updatedAt: daysAgo(10) }),
      cand({ id: 'm2', title: 'beta common friction', updatedAt: daysAgo(2) }),
      cand({ id: 'm3', title: 'friction common beta', updatedAt: daysAgo(5) }),
    ];
    const recs = signatureRecurrence(items, { nowMs: NOW });
    expect(recs[0].count).toBe(3); // the beta cluster
    expect(recs[0].ids[0]).toBe('m2'); // freshest member first
  });
});

/**
 * "Already decided: <reason>" recall (P-003) — recognise a settled friction by its
 * SIGNATURE before re-proposing it. Only resolved/closed prior items recall.
 */
describe('recallAlreadyDecided', () => {
  it('recalls a prior RESOLVED item with a matching signature (re-worded) and its reason', () => {
    const prior: ImprovementCandidate[] = [
      cand({
        id: 'EI-9',
        title: 'inbox digest should paginate older deltas',
        state: 'resolved',
        decidedReason: 'shipped the +K-older elision instead',
      }),
    ];
    const hits = recallAlreadyDecided('older deltas should paginate inbox digest', prior);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('EI-9');
    expect(hits[0].matchKind).toBe('signature');
    expect(hits[0].reason).toBe('already decided: shipped the +K-older elision instead');
  });

  it('does NOT recall an OPEN item (only already-decided friction recalls)', () => {
    const prior: ImprovementCandidate[] = [
      cand({ id: 'EI-10', title: 'same exact signature here now', state: 'open' }),
    ];
    expect(recallAlreadyDecided('same exact signature here now', prior)).toEqual([]);
  });

  it('does NOT recall an unrelated decided item', () => {
    const prior: ImprovementCandidate[] = [
      cand({ id: 'EI-11', title: 'completely unrelated subject matter', state: 'closed' }),
    ];
    expect(recallAlreadyDecided('presence list dumps stale rows fast', prior)).toEqual([]);
  });

  it('can exclude a given id (so a re-file does not recall itself)', () => {
    const prior: ImprovementCandidate[] = [
      cand({ id: 'self', title: 'a recurring decided friction', state: 'resolved' }),
    ];
    expect(recallAlreadyDecided('a recurring decided friction', prior, { excludeId: 'self' })).toEqual([]);
  });
});
