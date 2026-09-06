import { describe, it, expect } from 'vitest';
import {
  buildDigest,
  dedupSignature,
  findLikelyDuplicates,
  findLikelyDuplicatesDetailed,
  NEAR_DUP_MAX_CANDIDATES,
  signatureRecurrence,
  recallAlreadyDecided,
  titleSimilarity,
  extractQuotedSignatures,
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

  // EI-18790490225750395 D3: three real items were filed against the IDENTICAL
  // Postgres error string with three completely different, non-overlapping
  // titles — invisible to every title-based pass above. A quoted error/exception
  // signature is a far stronger identity signal for exactly this filing pattern.
  describe('quoted-error-signature clustering (EI-18790490225750395 D3)', () => {
    it('clusters candidates quoting an IDENTICAL error string even with disjoint titles', () => {
      const clusters = findLikelyDuplicates([
        cand({
          id: 'q1',
          title: 'LIVE OUTAGE: facts:assert fails ("no unique or exclusion constraint matching the ON CONFLICT specification")',
        }),
        cand({
          id: 'q2',
          title: 'facts:assert handler_error repro',
          body: 'Repro: `no unique or exclusion constraint matching the ON CONFLICT specification`',
        }),
        cand({ id: 'q3', title: 'a totally unrelated item about something else entirely' }),
      ]);
      const quoteCluster = clusters.find((c) => c.signature.startsWith('quote:'));
      expect(quoteCluster?.ids.sort()).toEqual(['q1', 'q2']);
      expect(clusters.flatMap((c) => c.ids)).not.toContain('q3');
    });

    it('does not cluster on short/incidental quoted words (below the signature length floor)', () => {
      const clusters = findLikelyDuplicates([
        cand({ id: 's1', title: 'the button says "ok" apparently' }),
        cand({ id: 's2', title: 'a dialog also says "ok" somewhere' }),
      ]);
      expect(clusters).toEqual([]); // titles are also token-dissimilar, so nothing else catches them either
    });

    it('takes priority over the weaker title-signature pass — an id is not double-clustered', () => {
      const clusters = findLikelyDuplicates([
        cand({ id: 't1', title: 'shared quoted text here', body: 'error: "a sufficiently long quoted error signature"' }),
        cand({ id: 't2', title: 'shared quoted text here', body: 'error: "a sufficiently long quoted error signature"' }),
      ]);
      // Both the quote signature AND the title signature match for this pair —
      // must land in exactly ONE cluster, not two.
      expect(clusters).toHaveLength(1);
      expect(clusters[0].ids.sort()).toEqual(['t1', 't2']);
    });
  });
});

describe('extractQuotedSignatures', () => {
  it('extracts a double-quoted span at least 20 chars, normalized', () => {
    expect(extractQuotedSignatures('boom: "Some Error   Text  That Is Long Enough"')).toEqual([
      'some error text that is long enough',
    ]);
  });
  it('extracts a backtick-quoted span too', () => {
    expect(extractQuotedSignatures('see `a backtick quoted error of decent length`')).toEqual([
      'a backtick quoted error of decent length',
    ]);
  });
  it('ignores quoted spans shorter than the signature floor', () => {
    expect(extractQuotedSignatures('the button says "ok"')).toEqual([]);
  });
  it('returns [] for undefined/empty text', () => {
    expect(extractQuotedSignatures(undefined)).toEqual([]);
    expect(extractQuotedSignatures('')).toEqual([]);
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
    expect(d.census.total).toBe(5);
    expect(d.window.open).toBe(4);
    expect(d.window.byState.resolved).toBe(1);
    expect(d.window.byKind.bug).toBe(4);
    expect(d.window.byKind.change).toBe(1);
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
    expect(d.census.total).toBe(0);
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

  describe('nearDuplicates: false opt-out (P-001/D-001/D-002)', () => {
    // Duplicates the shape findLikelyDuplicates would normally cluster, so a
    // non-null result here would prove the pass actually ran.
    const dupItems: ImprovementCandidate[] = [
      cand({ id: 'D1', title: 'presence dumps stale rows', createdAt: daysAgo(1) }),
      cand({ id: 'D2', title: 'stale rows dumps presence', createdAt: daysAgo(1) }), // exact-signature dup of D1
    ];

    it('defaults to running the pass — likelyDuplicates is an array, never null', () => {
      const d = buildDigest(dupItems, { nowMs: NOW });
      expect(d.likelyDuplicates).not.toBeNull();
      expect(d.likelyDuplicates).toHaveLength(1);
    });

    it('nearDuplicates: false skips the pass entirely — likelyDuplicates is null, not []', () => {
      const d = buildDigest(dupItems, { nowMs: NOW });
      const skipped = buildDigest(dupItems, { nowMs: NOW, nearDuplicates: false });
      expect(skipped.likelyDuplicates).toBeNull();
      // "skipped" must never be confused with "ran, found none" (D-002) — the
      // running pass on the SAME input finds a cluster, proving null != [].
      expect(d.likelyDuplicates?.length).toBeGreaterThan(0);
    });

    it('nearDuplicates: false does not change any other field (scalar rollups untouched)', () => {
      const withPass = buildDigest(dupItems, { nowMs: NOW });
      const withoutPass = buildDigest(dupItems, { nowMs: NOW, nearDuplicates: false });
      // likelyDuplicatesScope is dedup-pass metadata (mirrors likelyDuplicates'
      // own null-when-skipped convention on purpose), not a scalar rollup —
      // excluded here for the same reason likelyDuplicates itself is.
      const { likelyDuplicates: _a, likelyDuplicatesScope: _sa, headline: _h1, ...restWith } = withPass;
      const { likelyDuplicates: _b, likelyDuplicatesScope: _sb, headline: _h2, ...restWithout } = withoutPass;
      expect(restWithout).toEqual(restWith);
    });

    it('nearDuplicates: false omits the likely-dup clause from the headline', () => {
      const d = buildDigest(dupItems, { nowMs: NOW, nearDuplicates: false });
      expect(d.headline).not.toMatch(/likely-dup cluster/);
    });
  });

  describe('census / window (EI-18790490225750395 D2 — census must not be the window size)', () => {
    it('without corpusTotal: total falls back to candidates.length, unchanged from before this option existed', () => {
      const d = buildDigest(items, { nowMs: NOW });
      expect(d.census.total).toBe(items.length);
      expect(d.window.examined).toBe(items.length);
      expect(d.window.windowed).toBe(false);
    });

    it('with corpusTotal LARGER than what was fetched: total reports the TRUE corpus, returned stays the window size', () => {
      // Exactly the filed repro's shape: limit 30 (fetched 5 here for the test),
      // real corpus far bigger (200+).
      const d = buildDigest(items, { nowMs: NOW, corpusTotal: 4321 });
      expect(d.census.total).toBe(4321);
      expect(d.window.examined).toBe(items.length);
      expect(d.window.windowed).toBe(true);
    });

    it('with corpusTotal EQUAL to what was fetched (no real limit in effect): windowed is false', () => {
      const d = buildDigest(items, { nowMs: NOW, corpusTotal: items.length });
      expect(d.census.total).toBe(items.length);
      expect(d.window.windowed).toBe(false);
    });

    it('clamps a caller-bug corpusTotal SMALLER than candidates.length rather than reporting a negative window', () => {
      const d = buildDigest(items, { nowMs: NOW, corpusTotal: 1 });
      expect(d.census.total).toBe(items.length); // clamped up, never below what was actually examined
      expect(d.window.windowed).toBe(false);
    });

    it('the headline reports "returned of total" and flags (windowed) when they differ', () => {
      const windowed = buildDigest(items, { nowMs: NOW, corpusTotal: 999 });
      expect(windowed.headline).toMatch(new RegExp(`${items.length} of 999 loaded \\(windowed\\)`));
      const full = buildDigest(items, { nowMs: NOW });
      expect(full.headline).not.toMatch(/windowed/);
    });
  });

  describe('likelyDuplicatesScope (EI-18790490225750395 D1 — make the dedup window EXPLICIT)', () => {
    it('is null when the dedup pass itself did not run (nearDuplicates: false)', () => {
      const d = buildDigest(items, { nowMs: NOW, nearDuplicates: false, corpusTotal: 999 });
      expect(d.likelyDuplicatesScope).toBeNull();
    });

    it('reports consideredCount/corpusTotal/windowed matching the digest’s own census/window', () => {
      const d = buildDigest(items, { nowMs: NOW, corpusTotal: 999 });
      expect(d.likelyDuplicatesScope).toEqual({
        consideredCount: items.length,
        corpusTotal: 999,
        windowed: true,
        nearDupPass: 'ran',
        nearDupConsidered: expect.any(Number),
      });
    });

    it('an EMPTY likelyDuplicates at a small window is now DISTINGUISHABLE from "no duplicates in the corpus"', () => {
      // The exact filed complaint: likelyDuplicates: [] at limit 30 read as "no
      // dupes exist" when the corpus (200) actually had some. likelyDuplicatesScope
      // makes that unsound inference impossible to make silently.
      const noDupesInWindow: ImprovementCandidate[] = [cand({ id: 'x1', title: 'alpha' }), cand({ id: 'x2', title: 'beta' })];
      const d = buildDigest(noDupesInWindow, { nowMs: NOW, corpusTotal: 200 });
      expect(d.likelyDuplicates).toEqual([]);
      expect(d.likelyDuplicatesScope).toEqual({
        consideredCount: 2,
        corpusTotal: 200,
        windowed: true,
        nearDupPass: 'ran',
        nearDupConsidered: 2,
      });
    });
  });

  /**
   * EI-19393516222436864 — the near-dup leg is cost-gated at
   * NEAR_DUP_MAX_CANDIDATES, and the production corpus (15,166 open rows,
   * measured 2026-08-03) is nearly 4x that bound. So the skip was not an edge
   * case: it was the ALWAYS-taken branch, and nothing in the result said so.
   *
   * These tests deliberately build a corpus ACROSS the bound. A small fixture
   * cannot reproduce a cap — it passes while the capped behaviour goes
   * unexercised, which is a false green in exactly the direction that hides this
   * defect.
   */
  describe('near-dup cost-gate degradation is REPORTED, not silent (EI-19393516222436864)', () => {
    /**
     * Distinct titles, so nothing is claimed by the exact/quote passes first and
     * the near-dup leg really is the one under test.
     *
     * NOTE the discriminator must be >2 chars: dedupSignature drops shorter
     * tokens, so a bare `${i}` disappears and every title collapses to ONE
     * signature — which the exact pass then claims wholesale, leaving nothing for
     * the near-dup leg and reporting 'ran' at any size. That is how the first
     * draft of this fixture quietly failed to exercise the cap.
     */
    const distinct = (n: number): ImprovementCandidate[] =>
      Array.from({ length: n }, (_, i) => cand({ id: `n${i}`, title: `subject${String(i).padStart(6, '0')} alpha bravo` }));

    it('reports nearDupPass:"ran" below the bound', () => {
      const r = findLikelyDuplicatesDetailed(distinct(10));
      expect(r.nearDupPass).toBe('ran');
      expect(r.nearDupConsidered).toBe(10);
    });

    it('reports nearDupPass:"skipped-cost-gate" ABOVE the bound', () => {
      const r = findLikelyDuplicatesDetailed(distinct(NEAR_DUP_MAX_CANDIDATES + 1));
      expect(r.nearDupPass).toBe('skipped-cost-gate');
      expect(r.nearDupConsidered).toBe(NEAR_DUP_MAX_CANDIDATES + 1);
    });

    it('a re-worded duplicate that WOULD cluster below the bound is missed above it — the real cost of the skip', () => {
      // Two titles that overlap enough to pass NEAR_DUP_JACCARD but are not
      // identical, so only the near-dup leg can join them.
      const pair = [
        cand({ id: 'p1', title: 'presence list overflows the sidebar badly' }),
        cand({ id: 'p2', title: 'presence list overflows the sidebar' }),
      ];
      const below = findLikelyDuplicatesDetailed(pair);
      expect(below.nearDupPass).toBe('ran');
      expect(below.clusters.some((c) => c.ids.includes('p1') && c.ids.includes('p2'))).toBe(true);

      // Same pair, buried in a corpus over the bound: the leg never runs, so the
      // pair is NOT clustered. The result must say why rather than imply "no dupe".
      const above = findLikelyDuplicatesDetailed([...pair, ...distinct(NEAR_DUP_MAX_CANDIDATES)]);
      expect(above.nearDupPass).toBe('skipped-cost-gate');
      expect(above.clusters.some((c) => c.ids.includes('p1') && c.ids.includes('p2'))).toBe(false);
    });

    it('buildDigest surfaces the skip in scope AND headline, so a reader cannot infer completeness', () => {
      const d = buildDigest(distinct(NEAR_DUP_MAX_CANDIDATES + 1), { nowMs: NOW });
      expect(d.likelyDuplicatesScope?.nearDupPass).toBe('skipped-cost-gate');
      // windowed is FALSE here — the caller loaded the whole corpus. That is
      // exactly the case that used to read as "fully scoped, exhaustive".
      expect(d.likelyDuplicatesScope?.windowed).toBe(false);
      expect(d.headline).toMatch(/near-dup pass SKIPPED/);
    });

    it('the plain findLikelyDuplicates wrapper is unchanged for callers that only want clusters', () => {
      const via = findLikelyDuplicates(distinct(10));
      expect(via).toEqual(findLikelyDuplicatesDetailed(distinct(10)).clusters);
    });
  });

  /**
   * The ticket's OWN required recurrence guard (EI-18790490225750395, "no guard =
   * not done"): (a) N filings quoting one identical error string cluster together
   * regardless of the window they're read through, and (b) total is invariant
   * under whatever limit produced that window.
   */
  describe('EI-18790490225750395 required recurrence guard', () => {
    const quotedErr =
      '"no unique or exclusion constraint matching the ON CONFLICT specification"';
    const dupes: ImprovementCandidate[] = [
      cand({ id: 'dup1', title: 'LIVE OUTAGE: facts:assert fails ' + quotedErr }),
      cand({ id: 'dup2', title: 'facts:assert broken again', body: `handler_error: ${quotedErr}` }),
      cand({ id: 'dup3', title: 'weird PG write failure', body: `saw ${quotedErr} on write` }),
    ];

    it('(a) three filings quoting an identical error string cluster together at every window size', () => {
      const filler = (n: number) => Array.from({ length: n }, (_, i) => cand({ id: `fill${n}-${i}`, title: `filler ${n} ${i}` }));
      for (const windowSize of [0, 5, 50]) {
        const window = [...dupes, ...filler(windowSize)];
        const clusters = findLikelyDuplicates(window);
        const quoteCluster = clusters.find((c) => c.signature.startsWith('quote:'));
        expect(quoteCluster?.ids.sort()).toEqual(['dup1', 'dup2', 'dup3']);
      }
    });

    it('(b) census.total (corpusTotal) is invariant under limit — it never tracks the window size', () => {
      // Simulates the filed repro table: the SAME true corpus (here: 4321), read
      // through three different window sizes. `total` must report 4321 every time;
        // `window.examined` is free to vary with the window, `census.total` is not.
      const corpusTotal = 4321;
      for (const windowSize of [5, 30, 200]) {
        const window = dupes.slice(0, Math.min(windowSize, dupes.length));
        const d = buildDigest(window, { nowMs: NOW, corpusTotal });
        expect(d.census.total).toBe(corpusTotal);
      }
    });
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

  it('groups differently-worded filings under one watchdogKey — the case free-prose titles never collide on', () => {
    // The real shape this fixes: a machine-minted key is stable while the agent
    // prose around it varies, so the title matcher splits one recurring condition
    // into N singletons. Measured on the live observation lane (2026-09-06): the
    // title signature reaches the escalation threshold for 155 groups where the key
    // reaches it for 538, over the SAME 21,338 keyed rows.
    const items: ImprovementCandidate[] = [
      cand({ id: 'k1', title: 'facts:assert rejected measuredAt as too far in the past', watchdogKey: 'repeated-tool-error:facts:assert:caller' }),
      cand({ id: 'k2', title: 'could not assert a fact — ttlSec required for a volatile subject', watchdogKey: 'repeated-tool-error:facts:assert:caller' }),
      cand({ id: 'k3', title: 'measuredAt is only meaningful with subjectVolatile', watchdogKey: 'repeated-tool-error:facts:assert:caller' }),
    ];
    // Precondition: these titles genuinely do NOT collide on the title matcher, so
    // the grouping below can only come from the key.
    expect(new Set(items.map((i) => dedupSignature(i.title))).size).toBe(3);

    const recs = signatureRecurrence(items, { nowMs: NOW });
    expect(recs).toHaveLength(1);
    expect(recs[0].count).toBe(3);
  });

  it('never merges a keyed filing with a keyless one, or two different keys', () => {
    // hygiene.ts's long-standing rule ("the key asserts one signal identity"): the
    // `key:`/`sig:` namespaces exist so a key can never collide with a title
    // signature that happens to normalize to the same string.
    const items: ImprovementCandidate[] = [
      cand({ id: 'keyed-a', title: 'same words here', watchdogKey: 'source:alpha' }),
      cand({ id: 'keyed-b', title: 'same words here', watchdogKey: 'source:beta' }),
      cand({ id: 'keyless', title: 'same words here' }),
    ];
    const recs = signatureRecurrence(items, { nowMs: NOW });
    expect(recs).toHaveLength(3);
    expect(recs.every((r) => r.count === 1)).toBe(true);
  });

  it('still drops a keyless candidate whose title normalizes to nothing', () => {
    // The pre-existing guard: no title tokens > 2 chars means no identity to group
    // on. A KEYED row always has one, so it must survive the same guard.
    const items: ImprovementCandidate[] = [
      cand({ id: 'empty', title: 'a is on' }),
      cand({ id: 'empty-but-keyed', title: 'a is on', watchdogKey: 'source:gamma' }),
    ];
    expect(dedupSignature('a is on')).toBe('');
    const recs = signatureRecurrence(items, { nowMs: NOW });
    expect(recs.map((r) => r.ids[0])).toEqual(['empty-but-keyed']);
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
