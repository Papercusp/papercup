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
  'scheduler/dependency-tenant-matrix.integration.test.ts',
  'scheduler/dependency-family-matrix.integration.test.ts',
  'scheduler/dependency-writer-effectiveness.integration.test.ts',
  'scheduler/dependency-writer-census.test.ts',
  'scheduler/cross-door-agreement.integration.test.ts',
  'scheduler/claim-door-census.test.ts',
  // P-009: this file was NOT written for this plan, and that is why it belongs here. Its
  // blocked-dep case proves the issue-family PREVIEW and the real claim door agree — the pair
  // D-007 measured disagreeing — and it carried no citation until P-009 read it and added one.
  'scheduler/claim-ssot-agreement.integration.test.ts',
  'scheduler/work-item-deps-integrity.integration.test.ts',
  'scheduler/get-next-for-bee-plan-lane-guard.test.ts',
  'scheduler/readiness-reconcile.integration.test.ts',
  'scheduler/blocking-floor-single-source.test.ts',
  'dbos/work-item-deps-store.test.ts',
  // P-011: the real-Postgres lifecycle matrix covers both serial orders for edge
  // add/remove, blocker settle/reopen, dependant claim/progress/terminal, deletion,
  // and re-home. The event test is the companion-side-effect half: final-edge
  // removal must notify the holder rather than merely changing reachability.
  'dbos/work-item-deps-lifecycle.integration.test.ts',
  'work-items-events.test.ts',
  'dbos/feature-blockers-edges.integration.test.ts',
  'dbos/feature-blockers-acyclicity.test.ts',
  // P-012, the rename/re-home pair. They prove DIFFERENT halves of INV-03 and neither
  // substitutes for the other:
  //   • repoint-… asserts the REF-LEVEL statement (no edge still names the old slug) against
  //     the real migration 734. Like claim-ssot-agreement under P-009, it already existed and
  //     simply carried no citation — the third time in this plan that the proof was already
  //     written and only the attribution was missing.
  //   • rename-drift-… asserts the CONSEQUENCE — that the edge still WITHHOLDS the item at the
  //     real claim door — which the ref-level suite structurally cannot reach, because its
  //     fixture builds its own work_items table and no claim floor exists in it.
  'repoint-qualified-refs-on-rehome.integration.test.ts',
  'scheduler/rename-drift-effectiveness.integration.test.ts',
  // P-013: the detector's verdict run over REAL WRITER output rather than hand-written rows.
  // work-item-deps-integrity.integration.test.ts proves the detector is silent on clean input
  // and fires on seeded defects — but every row in it is an INSERT the test author wrote, so
  // it cannot speak to what the writers actually produce. This one closes that direction.
  'scheduler/dependency-endpoint-gate.integration.test.ts',
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
  // INV-10 (backfill UNIONs rather than REPLACES) was here until P-008 closed it, and its
  // shape is worth keeping. The backfill and promotion share ONE writer
  // (writePromotedDependencyEdges, D-014), so a test of that function looked like a test of
  // both — while the entire difference is a caller-supplied `preserveExistingEdges` flag, and
  // promotion's test asserts the OPPOSITE behaviour ("writes/replaces/clears") perfectly
  // correctly. A shared implementation is not shared coverage when the callers disagree on a
  // parameter. dependency-writer-effectiveness.integration.test.ts now proves the union
  // through the claim door (the preserved edge still WITHHOLDS after the plan-derived blocker
  // is satisfied), with the replace path run on the same fixture as its negative control.
  //
  // P-003 intentionally names the next five guarantees BEFORE their implementation lanes.
  // A registry test validates their data shape, but it is excluded from CORPUS because testing
  // a proposition's wording does not prove production behavior. Each row stays here until the
  // named later lane lands a real production-path or concurrency proof and cites the invariant.
  'INV-16':
    'P-005/P-007 must prove canonical post-state admission and concurrent write-skew prevention before stranded-set prevention counts as covered.',
  'INV-17':
    'P-005/P-009 must prove rejected work-item and plan batches leave edges and every companion side effect unchanged before atomicity counts as covered.',
  'INV-18':
    'P-005/P-007 must prove one typed admission graph catches cross-family and cross-harness cycles while refusing inert cross-workspace edges.',
  'INV-20':
    'P-013/P-014 must prove lint, monitoring, tools, and the dependency pane consume identical policy rows and preserve healthy-shape noise exclusions.',
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
