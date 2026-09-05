/**
 * plans:new search-first dedup — pure scoring tests (audit P-049 / EI-134).
 *
 * Duplicate plans split project history: the second author never finds the
 * first plan's decisions. plans:new now surfaces overlapping existing plans
 * (`similar_exists` + candidates) unless force: true.
 */

import { describe, expect, it } from 'vitest';
import { dedupTokens, findSimilarPlans } from '../new';

const ROWS = [
  { planSlug: 'locks-grant-cascade-2026-06-01', title: 'Locks grant cascade correctness', status: 'shipped', archived: false },
  { planSlug: 'plans-rail-sort-2026-05-30', title: 'Plans rail sorting', status: 'active', archived: false },
  { planSlug: 'coord-e2e-testing-2026-06-10', title: 'Coord system E2E testing', status: 'ready', archived: false },
  { planSlug: 'old-locks-cleanup-2026-04-01', title: 'Locks cleanup (superseded)', status: 'superseded', archived: true },
];

describe('dedupTokens', () => {
  it('drops the date suffix, stopwords, and short tokens; dedupes', () => {
    expect(dedupTokens('locks-grant-cascade-2026-06-01', 'Fix the locks grant cascade')).toEqual([
      'locks', 'grant', 'cascade',
    ]);
  });

  it('keeps meaningful single tokens', () => {
    expect(dedupTokens('hyperbee', 'Hyperbee')).toEqual(['hyperbee']);
  });
});

describe('findSimilarPlans', () => {
  it('surfaces plans sharing ≥2 topic tokens; 1-token overlap does not rank', () => {
    const similar = findSimilarPlans(['locks', 'grant', 'cascade'], ROWS);
    expect(similar.map((s) => s.slug)).toEqual(['locks-grant-cascade-2026-06-01']);
    expect(similar[0].sharedTokens).toEqual(['locks', 'grant', 'cascade']);
  });

  it('single-token proposals match on that one token', () => {
    const similar = findSimilarPlans(['coord'], ROWS);
    expect(similar.map((s) => s.slug)).toEqual(['coord-e2e-testing-2026-06-10']);
  });

  it('archived plans ARE candidates (the "continue, don\'t duplicate" signal)', () => {
    const similar = findSimilarPlans(['locks', 'cleanup'], ROWS);
    expect(similar.some((s) => s.slug === 'old-locks-cleanup-2026-04-01' && s.archived)).toBe(true);
  });

  it('no overlap → empty (creation proceeds)', () => {
    expect(findSimilarPlans(['totally', 'unrelated'], ROWS)).toEqual([]);
    expect(findSimilarPlans([], ROWS)).toEqual([]);
  });

  it('ignores generic planning language even when the corpus is small', () => {
    const proposed = dedupTokens(
      'restore-psu-pui-command-boundary-2026-08-24',
      'Keep PSU/PUI command boundary',
    );
    const rows = [
      {
        planSlug: 'restore-papercusp-main-green-2026-08-20',
        title: 'Restore Papercusp main green',
        status: 'active',
        archived: false,
      },
      {
        planSlug: 'su-loop-capability-parity-2026-07-03',
        title: 'Keep SU loop capability parity boundary',
        status: 'active',
        archived: false,
      },
    ];

    expect(proposed).toEqual(['psu', 'pui', 'command']);
    expect(findSimilarPlans(proposed, rows)).toEqual([]);
  });

  it('keeps domain overlap after removing generic planning language', () => {
    const proposed = dedupTokens('restore-papercusp-main-green-2026-08-24', 'Keep Papercusp main green');
    const rows = [
      {
        planSlug: 'papercusp-main-green-release-2026-08-20',
        title: 'Papercusp main green release',
        status: 'active',
        archived: false,
      },
    ];

    expect(findSimilarPlans(proposed, rows).map((s) => s.slug)).toEqual([
      'papercusp-main-green-release-2026-08-20',
    ]);
  });

  it('caps at 5 candidates', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      planSlug: `locks-grant-thing-${i}-2026-06-0${(i % 9) + 1}`,
      title: 'locks grant',
      status: 'active',
      archived: false,
    }));
    expect(findSimilarPlans(['locks', 'grant'], many)).toHaveLength(5);
  });

  // P-003 (cross-platform-hardening-and-agent-ergonomics-2026-07-05): precision fixes.

  it('matches on TOKENS, not substrings — `cross` does not match `across`', () => {
    const rows = [
      { planSlug: 'across-the-board-refactor-2026-05-01', title: 'Across the board refactor', status: 'active', archived: false },
    ];
    // Old substring matcher (`hay.includes('cross')`) wrongly matched "across".
    expect(findSimilarPlans(['cross'], rows)).toEqual([]);
  });

  describe('corpus-generic token suppression (large index only)', () => {
    // A large index where `agent` (~20/28) and `platform` (~9/28) are ubiquitous
    // project words, plus two distinctive plans. DF suppression only engages at
    // ≥25 rows — below that, every token is treated as distinctive (old behavior).
    const bigRows = [
      ...Array.from({ length: 18 }, (_, i) => ({
        planSlug: `agent-widget-${i}-2026-01-0${(i % 9) + 1}`,
        title: `Agent widget ${i}`,
        status: 'active',
        archived: false,
      })),
      ...Array.from({ length: 8 }, (_, i) => ({
        planSlug: `platform-thing-${i}-2026-02-0${(i % 8) + 1}`,
        title: `Platform thing ${i}`,
        status: 'active',
        archived: false,
      })),
      { planSlug: 'agent-platform-shell-2026-03-01', title: 'Agent platform shell', status: 'active', archived: false },
      { planSlug: 'gateway-hardening-2026-03-02', title: 'Gateway hardening agent', status: 'active', archived: false },
    ];

    it('does NOT flag when overlap is ONLY corpus-generic tokens (the false-positive fix)', () => {
      // `agent` + `platform` are both ubiquitous → no distinctive overlap → no match,
      // even against `agent-platform-shell` which shares both.
      expect(findSimilarPlans(['agent', 'platform'], bigRows)).toEqual([]);
    });

    it('STILL flags a genuine duplicate that shares a DISTINCTIVE token (EI-134 preserved)', () => {
      // Shares `agent` (generic) + `hardening` (distinctive, 1/28) → flagged.
      const similar = findSimilarPlans(['agent', 'platform', 'hardening'], bigRows);
      expect(similar.map((s) => s.slug)).toContain('gateway-hardening-2026-03-02');
      expect(similar.map((s) => s.slug)).not.toContain('agent-platform-shell-2026-03-01');
    });

    // EI-20316169827703913 — the absolute `GENERIC_DF_FRACTION = 0.25` cut was
    // INERT on the real corpus: measured 2026-09-05, the most common non-stopword
    // token across 1,726 plans was `acceptance` at 0.184, so NOTHING ever reached
    // a quarter of the corpus, `isGeneric` was false for every token, and P-003's
    // suppression did nothing. These rows reproduce that shape — a pronounced head
    // that still sits BELOW 25% of the corpus — which the old constant could not
    // suppress and the corpus-relative cut does.
    describe('corpus-relative cut (head below any absolute quarter-of-corpus fraction)', () => {
      // 19/100 = 0.19 for `acceptance`/`gate` — under the old >0.25 rule both were
      // "distinctive", so an overlap on them alone flagged. 81 filler plans carry
      // only unique tokens, so the head is genuinely the corpus head.
      const liveShaped = [
        ...Array.from({ length: 18 }, (_, i) => ({
          planSlug: `acceptance-gate-run-${i}-2026-01-01`,
          title: `Acceptance gate run ${i}`,
          status: 'active',
          archived: false,
        })),
        {
          planSlug: 'quietbox-acceptance-gate-2026-08-13',
          title: 'Quietbox acceptance gate',
          status: 'active',
          archived: false,
        },
        ...Array.from({ length: 81 }, (_, i) => ({
          planSlug: `alpha${i}-beta${i}-2026-02-01`,
          title: `Alpha${i} beta${i}`,
          status: 'active',
          archived: false,
        })),
      ];

      it('suppresses a head token at 19% of the corpus (the old 0.25 fraction could not)', () => {
        // Exactly the filed refusal: overlap is ONLY generic gate vocabulary.
        expect(findSimilarPlans(['acceptance', 'gate'], liveShaped)).toEqual([]);
      });

      it('STILL flags when a DISTINCTIVE token is also shared (EI-134 preserved)', () => {
        const similar = findSimilarPlans(['acceptance', 'gate', 'quietbox'], liveShaped);
        expect(similar.map((s) => s.slug)).toContain('quietbox-acceptance-gate-2026-08-13');
      });

      // THE ANTI-VACUITY INVARIANT. The cut is a fraction (<1) of the corpus's own
      // observed maximum, so the most common token ALWAYS clears it — the mechanism
      // cannot go silently inert the way an absolute constant did. This asserts the
      // property directly at several head heights, including ones far below any
      // plausible hand-picked fraction; it fails if the cut ever stops being
      // corpus-relative.
      it.each([50, 25, 12])(
        'head token in %i/100 plans is still suppressed — the cut is never unreachable',
        (headCount) => {
          const rows = [
            ...Array.from({ length: headCount }, (_, i) => ({
              planSlug: `ubiquitous-token-${i}-2026-01-01`,
              title: `Ubiquitous token ${i}`,
              status: 'active',
              archived: false,
            })),
            ...Array.from({ length: 100 - headCount }, (_, i) => ({
              planSlug: `zeta${i}-eta${i}-2026-02-01`,
              title: `Zeta${i} eta${i}`,
              status: 'active',
              archived: false,
            })),
          ];
          // `ubiquitous` + `token` are the corpus head → no distinctive overlap.
          expect(findSimilarPlans(['ubiquitous', 'token'], rows)).toEqual([]);
        },
      );
    });

    it('below the large-corpus threshold, generic suppression is OFF (small index keeps old behavior)', () => {
      // Same two rows only (2 < 25) → `agent`+`platform` are NOT treated as generic,
      // so an agent-platform overlap DOES flag (no DF data to trust on a tiny corpus).
      const smallRows = [
        { planSlug: 'agent-platform-shell-2026-03-01', title: 'Agent platform shell', status: 'active', archived: false },
      ];
      expect(findSimilarPlans(['agent', 'platform'], smallRows).map((s) => s.slug)).toEqual([
        'agent-platform-shell-2026-03-01',
      ]);
    });
  });
});
