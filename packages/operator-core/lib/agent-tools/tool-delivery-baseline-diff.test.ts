/**
 * tool-delivery-baseline-diff — the guard for P-012 / AUTO-BAR-R-7-P-012:
 * "the generator emits a diff against the MEASURED Aug-20 baseline of 61 names
 * (43 OMP-core + 18 Claude extras at commit 84829ccc), naming what it KEPT, what it
 * ADDED with that addition's measured justification, and what it DROPPED with a reason."
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT IS THE CONTROL FOR A NUMBER RATHER THAN A FEATURE ──
 *
 * The baseline diff is not a convenience report. It exists because D-007 caught a wrong
 * number being carried forward with the authority of a generated artifact: the owner was
 * told the Aug-20 seed was "19 OMP-core + 7 Claude extras = 26 tools", that 26 came from a
 * PRIOR SESSION'S OWN ANSWER and was never checked against the code, and the measured set
 * at the last Aug-20 commit is 43 + 18 = 61 distinct names. A derivation reporting "we grew
 * from 26 to 90" would have laundered that error into a committed artifact.
 *
 * So the thing under test is an ANTI-LAUNDERING property, and it has two halves that fail
 * independently:
 *
 *   1. The ANCHOR is the measured fact (61 @ 84829ccc), not the remembered one (26).
 *      Nothing else in the repo asserts this; `tool-delivery-floors.test.ts` consumes the
 *      same JSON as a FLOOR source but never checks the counts the clause names.
 *   2. The REPORT is a true partition of that anchor. A diff that quietly omits names —
 *      above all the DROPPED ones — is the flattering failure mode, and it is invisible by
 *      inspection because the header prints its own counts. That is precisely the shape of
 *      the bug D-007 caught, one level up: a number that describes itself.
 *
 * Hence the permanent deliberately-wrong renderer at the bottom. The repo's guard
 * discipline for an imported MODULE is a control that lives in the test file rather than a
 * mutation of the shared tree, plus a calibration the REAL subject must pass — so
 * `assertPartitionsBaseline` is run against both, and the control's expected failure is
 * asserted. Without it, every assertion here would also pass if the property itself were
 * broken.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  renderBaselineDiff,
  BASELINE_PATH,
  type GeneratedAgent,
  type SeedBaseline,
} from '../../../../scripts/gen-tool-delivery';

const REPO_ROOT = resolve(__dirname, '../../../..');

type CatalogEntry = { name: string; fullBytes: number; compactBytes: number };
type DemandEntry = { name: string; callers: number; calls: number };

/** Parse the report into its emitted lines, keyed by the FIRST token.
 *  ⚠ `TOOL_DELIVERY_BASELINE_RESTORE_COST` is prefixed by `TOOL_DELIVERY_BASELINE`, so a
 *  `startsWith` match silently folds the two together — match the token exactly. */
function linesOf(report: string, tag: string): string[] {
  return report
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .filter((l) => l.trim().split(/\s+/)[0] === tag);
}

function namesOf(report: string, tag: string): string[] {
  return linesOf(report, tag).map((l) => l.trim().split(/\s+/)[1]);
}

function headerFields(report: string): Record<string, string> {
  const [line] = linesOf(report, 'TOOL_DELIVERY_BASELINE');
  expect(line, 'the report must open with a TOOL_DELIVERY_BASELINE header').toBeDefined();
  const out: Record<string, string> = {};
  for (const tok of line.trim().split(/\s+/).slice(1)) {
    const eq = tok.indexOf('=');
    if (eq > 0) out[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return out;
}

/**
 * THE PROPERTY. Every baseline name lands in exactly one of KEPT / DROPPED; every ADDED
 * name is genuinely new; and the header's own counts agree with the lines actually emitted.
 *
 * This is the calibration AND the control: the real renderer must satisfy it, and the
 * deliberately-wrong renderer at the bottom of this file must not.
 */
function assertPartitionsBaseline(
  report: string,
  agent: GeneratedAgent,
  baseline: SeedBaseline,
): void {
  const kept = namesOf(report, 'TOOL_DELIVERY_KEPT');
  const added = namesOf(report, 'TOOL_DELIVERY_ADDED');
  const dropped = namesOf(report, 'TOOL_DELIVERY_DROPPED');
  const advertised = new Set(agent.advertised);
  const base = new Set(baseline.union);

  // (a) kept ∪ dropped == the baseline, exactly — no name invented, none lost.
  expect([...kept, ...dropped].sort()).toEqual([...baseline.union].sort());
  // (b) ...and disjointly: a name reported as both kept and dropped is meaningless.
  expect(kept.filter((n) => dropped.includes(n))).toEqual([]);
  // (c) every KEPT name really is still advertised; every DROPPED one really is not.
  expect(kept.filter((n) => !advertised.has(n))).toEqual([]);
  expect(dropped.filter((n) => advertised.has(n))).toEqual([]);
  // (d) ADDED is exactly the advertised names absent from the baseline.
  expect(added.sort()).toEqual(agent.advertised.filter((n) => !base.has(n)).sort());
  // (e) the header describes the body rather than itself.
  const h = headerFields(report);
  expect({
    baselineNames: Number(h.baselineNames),
    kept: Number(h.kept),
    added: Number(h.added),
    dropped: Number(h.dropped),
  }).toEqual({
    baselineNames: baseline.union.length,
    kept: kept.length,
    added: added.length,
    dropped: dropped.length,
  });
}

// ── Fixtures ───────────────────────────────────────────────────────────────────────────
// Deliberately tiny and hand-checkable: 3 baseline names, one of each outcome, plus a
// dropped name that no longer exists in the catalog at all (the second drop reason).

const FIXTURE_BASELINE: SeedBaseline = {
  commit: 'fixture0',
  commitDate: '2026-08-20T23:23:39Z',
  counts: { ompCore: 2, claudeExtras: 2, union: 4 },
  union: ['a:kept-one', 'a:kept-two', 'b:dropped-cheapskate', 'c:dropped-vanished'],
};

const FIXTURE_AGENT: GeneratedAgent = {
  budgetBytes: 100_000,
  spentBytes: 900,
  budgetOverrun: 0,
  counts: { full: 1, compact: 2, deferred: 0 },
  advertised: ['a:kept-one', 'a:kept-two', 'z:added-newcomer'],
  floors: ['a:kept-one'],
  rows: [
    { name: 'a:kept-one', tier: 'full', fullBytes: 400, compactBytes: 120, callers: 9, calls: 90 },
    { name: 'a:kept-two', tier: 'compact', fullBytes: 500, compactBytes: 150, callers: 4, calls: 40 },
    {
      name: 'z:added-newcomer',
      tier: 'compact',
      fullBytes: 700,
      compactBytes: 200,
      callers: 7,
      calls: 70,
    },
  ],
};

const FIXTURE_CATALOG = new Map<string, CatalogEntry>([
  ['a:kept-one', { name: 'a:kept-one', fullBytes: 400, compactBytes: 120 }],
  ['a:kept-two', { name: 'a:kept-two', fullBytes: 500, compactBytes: 150 }],
  ['z:added-newcomer', { name: 'z:added-newcomer', fullBytes: 700, compactBytes: 200 }],
  // present in the catalog but ranked below the value line
  ['b:dropped-cheapskate', { name: 'b:dropped-cheapskate', fullBytes: 9000, compactBytes: 4000 }],
  // 'c:dropped-vanished' deliberately ABSENT — the tool no longer exists
]);

const FIXTURE_DEMAND = new Map<string, DemandEntry>([
  ['a:kept-one', { name: 'a:kept-one', callers: 9, calls: 90 }],
  ['a:kept-two', { name: 'a:kept-two', callers: 4, calls: 40 }],
  ['z:added-newcomer', { name: 'z:added-newcomer', callers: 7, calls: 70 }],
  ['b:dropped-cheapskate', { name: 'b:dropped-cheapskate', callers: 1, calls: 2 }],
]);

const REPORT = renderBaselineDiff(
  FIXTURE_AGENT,
  FIXTURE_BASELINE,
  FIXTURE_CATALOG,
  FIXTURE_DEMAND,
);

// ── The committed anchor ───────────────────────────────────────────────────────────────

describe('the committed Aug-20 baseline is the MEASURED fact the clause names', () => {
  const baseline = JSON.parse(
    readFileSync(resolve(REPO_ROOT, BASELINE_PATH), 'utf8'),
  ) as SeedBaseline;

  it('is 43 OMP-core + 18 Claude extras = 61 distinct names at commit 84829ccc', () => {
    expect({
      commit: baseline.commit,
      ompCore: baseline.counts.ompCore,
      claudeExtras: baseline.counts.claudeExtras,
      union: baseline.counts.union,
    }).toEqual({ commit: '84829ccc', ompCore: 43, claudeExtras: 18, union: 61 });
  });

  it('agrees with itself — a baseline that disagrees with itself cannot anchor a diff', () => {
    expect(baseline.union).toHaveLength(baseline.counts.union);
    expect(new Set(baseline.union).size).toBe(baseline.union.length);
  });

  it('is NOT the remembered 26 that D-007 corrected', () => {
    // The specific regression: someone "simplifies" the baseline back to the figure the
    // owner was told. 26 was a prior session's own answer, never checked against the code.
    expect(baseline.counts.union).not.toBe(26);
    expect(baseline.counts.ompCore).not.toBe(19);
    expect(baseline.counts.claudeExtras).not.toBe(7);
  });
});

// ── The report ─────────────────────────────────────────────────────────────────────────

describe('renderBaselineDiff emits a true partition of the baseline', () => {
  it('partitions the baseline into KEPT and DROPPED, and reports counts that match', () => {
    assertPartitionsBaseline(REPORT, FIXTURE_AGENT, FIXTURE_BASELINE);
  });

  it('names the baseline commit and date, so the comparison states what it is against', () => {
    const h = headerFields(REPORT);
    expect(h.commit).toBe('fixture0');
    expect(h.date).toBe('2026-08-20T23:23:39Z');
  });

  it('sorts each section, so one tool moving does not reshuffle the whole diff', () => {
    for (const tag of ['TOOL_DELIVERY_KEPT', 'TOOL_DELIVERY_ADDED', 'TOOL_DELIVERY_DROPPED']) {
      const names = namesOf(REPORT, tag);
      expect(names, tag).toEqual([...names].sort());
    }
  });
});

describe('every ADDED name carries the measured justification for adding it', () => {
  it('states callers, calls and both byte tiers — not a bare name', () => {
    const [line] = linesOf(REPORT, 'TOOL_DELIVERY_ADDED');
    expect(line).toContain('z:added-newcomer');
    expect(line).toContain('callers=7');
    expect(line).toContain('calls=70');
    expect(line).toContain('fullB=700');
    expect(line).toContain('compactB=200');
    // the density that actually ranked it, in the same units the policy ranks on
    expect(line).toMatch(/callersPerKB=\d+\.\d/);
  });

  it('marks a floor as a floor, so a mandate is not mistaken for a demand win', () => {
    const kept = linesOf(REPORT, 'TOOL_DELIVERY_KEPT');
    const floorLine = kept.find((l) => l.includes('a:kept-one'));
    const plainLine = kept.find((l) => l.includes('a:kept-two'));
    expect(floorLine).toContain('floor=1');
    expect(plainLine).not.toContain('floor=1');
  });
});

describe('every DROPPED name carries a CHECKABLE reason', () => {
  it('prices a below-the-value-line drop with the numbers that ranked it', () => {
    const line = linesOf(REPORT, 'TOOL_DELIVERY_DROPPED').find((l) =>
      l.includes('b:dropped-cheapskate'),
    );
    expect(line).toContain('reason=below-value-line');
    expect(line).toContain('callers=1');
    expect(line).toContain('compactB=4000');
    expect(line).toMatch(/callersPerKB=\d+\.\d/);
  });

  it('distinguishes a tool that no longer EXISTS from one that lost on value', () => {
    // Conflating these is how a report makes an unavoidable removal look like a judgement
    // call — or worse, a judgement call look unavoidable.
    const line = linesOf(REPORT, 'TOOL_DELIVERY_DROPPED').find((l) =>
      l.includes('c:dropped-vanished'),
    );
    expect(line).toContain('reason=absent-from-catalog');
    expect(line).not.toContain('reason=below-value-line');
  });

  it('states the cost of restoring the ENTIRE baseline, so "keep them all" is priced', () => {
    const [line] = linesOf(REPORT, 'TOOL_DELIVERY_BASELINE_RESTORE_COST');
    // only b:dropped-cheapskate has a catalog cost; c:dropped-vanished has none
    expect(line).toContain('compactBytes=4000');
    expect(line).toContain('spentBytes=900');
    expect(line).toContain('budgetBytes=100000');
    expect(line).toContain('wouldSpend=4900');
  });
});

// ── Falsifiability ─────────────────────────────────────────────────────────────────────

/**
 * A deliberately-wrong renderer, kept PERMANENTLY rather than produced by mutating the
 * shared tree (git-sync sweeps the whole tree every few minutes, so an in-tree mutation can
 * be committed even when nothing goes wrong). It is the flattering failure: it reports what
 * it kept and what it gained, and silently omits what it gave up — while printing a header
 * whose counts describe its own truncated body, so the report is internally consistent and
 * wrong.
 */
function renderBaselineDiffOmittingDrops(
  agent: GeneratedAgent,
  baseline: SeedBaseline,
): string {
  const advertised = new Set(agent.advertised);
  const base = new Set(baseline.union);
  const kept = baseline.union.filter((n) => advertised.has(n)).sort();
  const added = agent.advertised.filter((n) => !base.has(n)).sort();
  const out = [
    `TOOL_DELIVERY_BASELINE commit=${baseline.commit} date=${baseline.commitDate} ` +
      `baselineNames=${baseline.counts.union} kept=${kept.length} added=${added.length} dropped=0\n`,
  ];
  for (const n of kept) out.push(`TOOL_DELIVERY_KEPT ${n} tier=full callers=1 calls=1\n`);
  for (const n of added) out.push(`TOOL_DELIVERY_ADDED ${n} tier=full callers=1 calls=1\n`);
  return out.join('');
}

describe('the partition check can actually FAIL — the control that proves this guard works', () => {
  it('CATCHES a diff that omits the names it dropped', () => {
    const bad = renderBaselineDiffOmittingDrops(FIXTURE_AGENT, FIXTURE_BASELINE);
    expect(() => assertPartitionsBaseline(bad, FIXTURE_AGENT, FIXTURE_BASELINE)).toThrow();
  });

  it('and the control is still report-SHAPED, so it fails on the property, not on parsing', () => {
    // Without this, a later "simplification" of the control could feed the checker an
    // unparseable string — the assertion above would still throw and this whole section
    // would pass vacuously while testing nothing.
    const bad = renderBaselineDiffOmittingDrops(FIXTURE_AGENT, FIXTURE_BASELINE);
    expect(linesOf(bad, 'TOOL_DELIVERY_BASELINE')).toHaveLength(1);
    expect(namesOf(bad, 'TOOL_DELIVERY_KEPT')).toEqual(['a:kept-one', 'a:kept-two']);
    expect(namesOf(bad, 'TOOL_DELIVERY_ADDED')).toEqual(['z:added-newcomer']);
    expect(namesOf(bad, 'TOOL_DELIVERY_DROPPED')).toEqual([]);
  });

  it('and the REAL renderer passes the same check the control fails (calibration)', () => {
    expect(() =>
      assertPartitionsBaseline(REPORT, FIXTURE_AGENT, FIXTURE_BASELINE),
    ).not.toThrow();
    expect(namesOf(REPORT, 'TOOL_DELIVERY_DROPPED')).toEqual([
      'b:dropped-cheapskate',
      'c:dropped-vanished',
    ]);
  });
});
