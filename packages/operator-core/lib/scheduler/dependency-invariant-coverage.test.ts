/**
 * dependency-invariant-coverage.test.ts — which dependency invariants are PROVEN, by name.
 *
 * Plan: dependency-subsystem-thorough-testing-2026-08-02 (P-005).
 *
 * ⚠ WHAT THIS TEST DOES AND DOES NOT PROVE. It reads `@covers INV-NN` citations out of the
 * dependency test corpus and reports which registry invariants nothing claims. That is an
 * ATTRIBUTION check, not a correctness check: it proves the corpus CLAIMS to prove an
 * invariant, never that the claim is true. A citation on a test that asserts nothing would
 * satisfy this file completely.
 *
 * That limit is deliberate and it is why the citations were added by READING each test
 * rather than by pattern-matching titles. The value here is the inverse direction — the
 * UNCOVERED list. An invariant nobody cites is one nobody has even claimed to have tested,
 * and that is a fact worth failing a build over, because it is exactly the state the whole
 * subsystem was in: ~85 test files, 1,500+ tests, and not one of them able to say which
 * proposition it established.
 *
 * WHY THE CORPUS IS AN EXPLICIT LIST. A glob would make this test quietly weaker every time
 * a file is renamed or moved — the walker would match less, coverage would look unchanged,
 * and nothing would fail. Every path below is asserted to EXIST, so a rename breaks this
 * test loudly instead of silently reducing what it scans. Same reasoning as
 * blocking-floor-single-source.test.ts's "scans a non-trivial number of files" guard.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEPENDENCY_INVARIANTS,
  coveredInvariants,
  unknownCoveredIds,
  uncoveredInvariantIds,
} from './dependency-invariants';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(__dirname, '..');

/**
 * The dependency-subsystem test corpus. Repo-relative to packages/operator-core/lib.
 *
 * Adding a dependency test? Add it here, or its citations do not count.
 *
 * ⚠ THE TWO META FILES ARE EXCLUDED ON PURPOSE, and the reason is the whole point of this
 * plan. They test the TOOLING (the registry's extractor, the fixture factory), not the
 * subsystem, and including them corrupts the measurement in BOTH directions:
 *
 *  - `scheduler/dependency-invariants.test.ts` contains synthetic citations as FIXTURES —
 *    literal `@covers INV-04`, `INV-01, INV-02`, `INV-06 INV-07` passed as test inputs, plus
 *    a deliberate `INV-77` typo control. Scanned as corpus, its test DATA registers as
 *    coverage for five real invariants that it proves nothing about, and its typo control
 *    reports as a corpus defect. Both were observed live when this file first ran.
 *  - `testing/dependency-fixture.test.ts` asserts the factory agrees with `canonicalRef`,
 *    which encodes INV-01 — a pure function agreeing with itself. Its citation was removed
 *    for that reason; see the note in its header.
 *
 * A citation only counts when it sits on a test that exercises production code.
 */
const CORPUS = [
  'scheduler/claim-respects-blocking.integration.test.ts',
  'scheduler/work-item-deps-integrity.integration.test.ts',
  'scheduler/get-next-for-bee-plan-lane-guard.test.ts',
  'scheduler/readiness-reconcile.integration.test.ts',
  'scheduler/blocking-floor-single-source.test.ts',
  'dbos/work-item-deps-store.test.ts',
  'dbos/feature-blockers-edges.integration.test.ts',
  'dbos/feature-blockers-acyclicity.test.ts',
] as const;

/**
 * Invariants NOTHING in the corpus proves yet, each with the reason it is still open.
 *
 * This is a RATCHET, asserted as an exact set. Covering one of these forces a deliberate
 * deletion from this list — coverage cannot improve by accident, and it cannot regress
 * silently either: dropping a citation makes the actual set larger than this one and fails.
 */
const KNOWN_UNCOVERED: Record<string, string> = {
  // INV-09 (transitive blocking) was here until P-005 closed it: the corpus seeded only
  // depth-1 chains, so the one invariant with a documented incident behind it (EI-9108, a
  // 7-deep chain served) had no regression guard. claim-respects-blocking.integration.test.ts
  // now walks 3-deep and 6-deep chains through both doors. Left as a comment because the
  // gap is more instructive than the fix: it was invisible for as long as coverage was
  // counted in lines, and obvious the moment it was counted in propositions.
  //
  // syncFeatureBlockEdges is the PROMOTION path, where replace-semantics is correct and is
  // what its test asserts ("writes/replaces/clears"). No test covers the BACKFILL path's
  // obligation to UNION, so "a backfill silently deletes hand-authored edges" is unguarded.
  'INV-10': 'backfill UNIONs rather than REPLACES — only the promotion path (replace) is tested',
};

const read = (rel: string) => readFileSync(resolve(CORE, rel), 'utf8');

describe('dependency invariant coverage — which propositions the corpus claims to prove', () => {
  it('every corpus file exists (a rename must fail loudly, never shrink the scan silently)', () => {
    const missing = CORPUS.filter((rel) => !existsSync(resolve(CORE, rel)));
    expect(missing).toEqual([]);
  });

  it('scans a non-trivial corpus (guards against an empty read passing as full coverage)', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(8);
    const totalChars = CORPUS.reduce((n, rel) => n + read(rel).length, 0);
    expect(totalChars).toBeGreaterThan(50_000);
  });

  it('no citation names an invariant that does not exist — a typo must never read as coverage', () => {
    const typos = CORPUS.flatMap((rel) => unknownCoveredIds(read(rel)).map((id) => `${rel}: ${id}`));
    expect(typos).toEqual([]);
  });

  it('the uncovered set is EXACTLY the known-open list — coverage cannot drift either way', () => {
    const sources = CORPUS.map(read);
    expect(uncoveredInvariantIds(sources)).toEqual(Object.keys(KNOWN_UNCOVERED).sort());
  });

  it('every known-open invariant carries a reason, and is a real registry id', () => {
    const ids = new Set(DEPENDENCY_INVARIANTS.map((i) => i.id));
    for (const [id, reason] of Object.entries(KNOWN_UNCOVERED)) {
      expect(ids.has(id), `${id} is not a registry invariant`).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('reports coverage by AREA, so a wholly-unproven area cannot hide behind a good total', () => {
    const sources = CORPUS.map(read);
    const uncovered = new Set(uncoveredInvariantIds(sources));
    const byArea = new Map<string, { total: number; covered: number }>();
    for (const inv of DEPENDENCY_INVARIANTS) {
      const row = byArea.get(inv.area) ?? { total: 0, covered: 0 };
      row.total += 1;
      if (!uncovered.has(inv.id)) row.covered += 1;
      byArea.set(inv.area, row);
    }
    // Every area has at least one proven invariant. An area at zero means a whole class of
    // claim (tenancy, observability, ...) rests on nothing, which a headline percentage hides.
    const bare = [...byArea.entries()].filter(([, r]) => r.covered === 0).map(([a]) => a);
    expect(bare).toEqual([]);
  });

  it('the two effectiveness invariants — the ones the escapes were about — are proven', () => {
    const sources = CORPUS.map(read);
    const uncovered = new Set(uncoveredInvariantIds(sources));
    // INV-04/INV-05 are the whole point of the subsystem: an edge that exists must gate,
    // and must stop gating when satisfied. If either loses its citation, fail here rather
    // than let the ratchet's exact-set check report it as an unremarkable list diff.
    expect(uncovered.has('INV-04')).toBe(false);
    expect(uncovered.has('INV-05')).toBe(false);
  });
});

describe('coveredInvariants extraction is not fooled by prose (negative controls)', () => {
  it('does not treat a bare invariant mention as a coverage claim', () => {
    expect(coveredInvariants('This relates to INV-04 but proves nothing.')).toEqual([]);
  });

  it('does not treat a citation inside a quoted example as different from a real one', () => {
    // Honest limitation, asserted so it is a known property rather than a surprise: the
    // extractor is textual, so a citation written anywhere in the file counts. The corpus
    // is curated by hand for exactly this reason.
    expect(coveredInvariants('// @covers INV-04')).toEqual(['INV-04']);
  });
});
