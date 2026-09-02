/**
 * WI-2142447 — the post-close claim recheck, and specifically its ONE piece of judgement:
 * which baseline→current transitions are findings and which are not.
 *
 * ── How falsifiability is proven here, and why not with mutation-probe.sh ──
 *
 * The subject is a MODULE this file imports, so the repo's tier table puts its
 * falsifiability control INSIDE the test file: a permanently-kept, deliberately-wrong
 * classifier asserted to FAIL exactly the cases the real one passes. `mutation-probe.sh`
 * is the wrong instrument at this tier twice over — its copy-out mode cannot redirect a
 * TypeScript module import, and its in-tree mode would need the git-sync lock on a swept
 * shared tree.
 *
 * The control is not decoration. `naiveClassifier` is the implementation anyone would
 * write first (and the one the source item warned about): "falsified now ⇒ finding". Both
 * trap cases below distinguish it from the real one, so if `classifyClaimRecheck` were
 * ever loosened to that shape, the CONTROL tests fail and say so by name.
 */
import { describe, expect, it } from 'vitest';

import type { ClaimSourceReader, CompletionClaim, CompletionClaimVerdict } from './completion-claims';
import {
  classifyClaimRecheck,
  completionClaimBaseline,
  completionClaimKey,
  completionClaimRecheckRecord,
  CompletionClaimRecheckRecordSchema,
  COMPLETION_CLAIM_RECHECK_KEY,
  COMPLETION_CLAIM_RECHECK_REGRESSED,
  recheckCompletionClaims,
  renderCompletionClaimRecheck,
  type CompletionClaimBaseline,
} from './completion-claim-recheck';

const ARRAY_CLAIM: CompletionClaim = {
  kind: 'string-in-array',
  path: 'src/tools.ts',
  container: 'CORE_TOOL_NAMES',
  value: 'coord:dispatch',
  expect: 'present',
};

const SYMBOL_CLAIM: CompletionClaim = {
  kind: 'symbol-defined',
  path: 'src/authority.ts',
  symbol: 'derivedAuthority',
  expect: 'present',
};

/** A reader over an in-memory tree — no fixtures on disk, no repo root. */
function readerFor(files: Record<string, string>): ClaimSourceReader {
  return { readSource: (p) => files[p] ?? null };
}

function baselineOf(entries: Array<[CompletionClaim, CompletionClaimVerdict]>): CompletionClaimBaseline {
  return {
    at: '2026-09-02T00:00:00.000Z',
    entries: entries.map(([claim, verdict]) => ({ claim, verdict, reason: `baseline ${verdict}` })),
  };
}

/**
 * ⛔ DELIBERATELY WRONG — the FALSIFIABILITY CONTROL. Never call this from production code.
 *
 * This is the obvious first implementation: any claim that is falsified NOW is a finding.
 * It is wrong in both directions the module header names, and the CONTROL assertions below
 * pin that it stays distinguishable from the real classifier.
 */
function naiveClassifier(_baseline: CompletionClaimVerdict | null, current: CompletionClaimVerdict): string {
  return current === 'falsified' ? 'regressed' : 'held';
}

describe('classifyClaimRecheck — the full transition table', () => {
  it.each([
    ['holds', 'holds', 'held'],
    ['holds', 'falsified', 'regressed'],
    ['holds', 'unevaluatable', 'indeterminate'],
    ['falsified', 'falsified', 'still-false'],
    ['falsified', 'holds', 'repaired'],
    ['falsified', 'unevaluatable', 'indeterminate'],
    ['unevaluatable', 'falsified', 'falsified-unbaselined'],
    ['unevaluatable', 'holds', 'indeterminate'],
    ['unevaluatable', 'unevaluatable', 'indeterminate'],
  ] as const)('%s -> %s is %s', (baseline, current, expected) => {
    expect(classifyClaimRecheck(baseline, current)).toBe(expected);
  });

  it.each([
    ['falsified', 'falsified-unbaselined'],
    ['holds', 'indeterminate'],
    ['unevaluatable', 'indeterminate'],
  ] as const)('NO baseline -> %s is %s', (current, expected) => {
    expect(classifyClaimRecheck(null, current)).toBe(expected);
  });

  it('ONLY holds -> falsified is a regression, across the whole table', () => {
    const verdicts: (CompletionClaimVerdict | null)[] = ['holds', 'falsified', 'unevaluatable', null];
    const currents: CompletionClaimVerdict[] = ['holds', 'falsified', 'unevaluatable'];
    const regressions = verdicts.flatMap((b) =>
      currents
        .filter((c) => classifyClaimRecheck(b, c) === 'regressed')
        .map((c) => `${String(b)}->${c}`),
    );
    expect(regressions).toEqual(['holds->falsified']);
  });
});

describe('FALSIFIABILITY CONTROL — the deliberately-wrong classifier disagrees where it matters', () => {
  // Trap 1, first half: a claim that can no longer be evaluated is NOT a falsification.
  // The naive classifier gets this right only by accident (unevaluatable is not
  // 'falsified'), so the sharper control is the second half below.
  it('TRAP 1a: unevaluatable NOW is never a finding, whatever the baseline said', () => {
    expect(classifyClaimRecheck('holds', 'unevaluatable')).toBe('indeterminate');
    expect(classifyClaimRecheck('falsified', 'unevaluatable')).toBe('indeterminate');
  });

  it('TRAP 1b: falsified with an UNEVALUATABLE baseline is NOT a regression — control differs', () => {
    // The real classifier: nothing ever witnessed this claim holding, so no transition.
    expect(classifyClaimRecheck('unevaluatable', 'falsified')).toBe('falsified-unbaselined');
    // The wrong one calls it a regression. If the real implementation is ever loosened to
    // match, this assertion fails and names the trap.
    expect(naiveClassifier('unevaluatable', 'falsified')).toBe('regressed');
    expect(classifyClaimRecheck('unevaluatable', 'falsified')).not.toBe(
      naiveClassifier('unevaluatable', 'falsified'),
    );
  });

  it('TRAP 1c: a claim ALREADY false at close is old news, not a fresh finding — control differs', () => {
    expect(classifyClaimRecheck('falsified', 'falsified')).toBe('still-false');
    expect(naiveClassifier('falsified', 'falsified')).toBe('regressed');
    expect(classifyClaimRecheck('falsified', 'falsified')).not.toBe(
      naiveClassifier('falsified', 'falsified'),
    );
  });

  it('CALIBRATION: on the genuine regression both classifiers agree — the control is not simply inverted', () => {
    expect(classifyClaimRecheck('holds', 'falsified')).toBe('regressed');
    expect(naiveClassifier('holds', 'falsified')).toBe('regressed');
  });
});

describe('completionClaimKey', () => {
  it('is stable across re-serialization and key reordering', () => {
    const roundTripped = JSON.parse(
      JSON.stringify({ expect: 'present', value: 'coord:dispatch', kind: 'string-in-array', path: 'src/tools.ts', container: 'CORE_TOOL_NAMES' }),
    ) as CompletionClaim;
    expect(completionClaimKey(roundTripped)).toBe(completionClaimKey(ARRAY_CLAIM));
  });

  it('separates claims that differ in ANY field, including expect', () => {
    const keys = new Set([
      completionClaimKey(ARRAY_CLAIM),
      completionClaimKey({ ...ARRAY_CLAIM, expect: 'absent' }),
      completionClaimKey({ ...ARRAY_CLAIM, container: 'OTHER' }),
      completionClaimKey({ ...ARRAY_CLAIM, value: 'coord:send' }),
      completionClaimKey({ ...ARRAY_CLAIM, path: 'src/other.ts' }),
      completionClaimKey(SYMBOL_CLAIM),
      completionClaimKey({ ...SYMBOL_CLAIM, exported: true }),
    ]);
    expect(keys.size).toBe(7);
  });

  it('a separator character inside a field cannot forge another claim key', () => {
    // The fields are JSON-encoded individually, so a comma or quote in a path stays inside
    // its own encoded field instead of splitting it.
    const sneaky: CompletionClaim = { ...ARRAY_CLAIM, value: '","container":"OTHER' };
    expect(completionClaimKey(sneaky)).not.toBe(completionClaimKey({ ...ARRAY_CLAIM, container: 'OTHER' }));
  });
});

describe('recheckCompletionClaims', () => {
  const holding = { 'src/tools.ts': `export const CORE_TOOL_NAMES = ['coord:send', 'coord:dispatch'] as const;` };
  const broken = { 'src/tools.ts': `export const CORE_TOOL_NAMES = ['coord:send'] as const;` };

  it('the measured case: a claim that HELD at close and is now false is the finding', () => {
    const report = recheckCompletionClaims({
      claims: [ARRAY_CLAIM],
      baseline: baselineOf([[ARRAY_CLAIM, 'holds']]),
      reader: readerFor(broken),
    });
    expect(report.regressed).toBe(1);
    expect(report.anyRegressed).toBe(true);
    expect(report.verdict).toBe(COMPLETION_CLAIM_RECHECK_REGRESSED);
    expect(report.entries[0].status).toBe('regressed');
    expect(report.entries[0].reason).toContain('CORE_TOOL_NAMES');
    expect(report.entries[0].baselineReason).toBe('baseline holds');
  });

  it('a claim that still holds is clean', () => {
    const report = recheckCompletionClaims({
      claims: [ARRAY_CLAIM],
      baseline: baselineOf([[ARRAY_CLAIM, 'holds']]),
      reader: readerFor(holding),
    });
    expect(report).toMatchObject({ held: 1, regressed: 0, anyRegressed: false, verdict: 'clean' });
  });

  it('an UNREADABLE source is indeterminate, never a regression (fail-open)', () => {
    const report = recheckCompletionClaims({
      claims: [ARRAY_CLAIM],
      baseline: baselineOf([[ARRAY_CLAIM, 'holds']]),
      reader: readerFor({}),
    });
    expect(report.regressed).toBe(0);
    expect(report.verdict).toBe('clean');
    expect(report.entries[0].status).toBe('indeterminate');
    expect(report.entries[0].currentVerdict).toBe('unevaluatable');
  });

  it('a RENAMED container is indeterminate — the sweep must not fire on refactors', () => {
    const report = recheckCompletionClaims({
      claims: [ARRAY_CLAIM],
      baseline: baselineOf([[ARRAY_CLAIM, 'holds']]),
      reader: readerFor({ 'src/tools.ts': `export const RENAMED_TOOL_NAMES = ['coord:send'] as const;` }),
    });
    expect(report.entries[0].status).toBe('indeterminate');
    expect(report.regressed).toBe(0);
  });

  it('a SPREAD element makes absence undecidable, so no regression', () => {
    const report = recheckCompletionClaims({
      claims: [ARRAY_CLAIM],
      baseline: baselineOf([[ARRAY_CLAIM, 'holds']]),
      reader: readerFor({ 'src/tools.ts': `export const CORE_TOOL_NAMES = ['coord:send', ...EXTRA] as const;` }),
    });
    expect(report.entries[0].status).toBe('indeterminate');
    expect(report.regressed).toBe(0);
  });

  it('NO baseline at all: a falsified claim is reported but never counted as a regression', () => {
    const report = recheckCompletionClaims({
      claims: [ARRAY_CLAIM],
      baseline: null,
      reader: readerFor(broken),
    });
    expect(report.regressed).toBe(0);
    expect(report.falsifiedUnbaselined).toBe(1);
    expect(report.verdict).toBe('clean');
    expect(report.entries[0].baselineVerdict).toBeNull();
  });

  it('pairs each claim with ITS OWN baseline entry, not by position', () => {
    const report = recheckCompletionClaims({
      // Declared in the opposite order to the baseline.
      claims: [SYMBOL_CLAIM, ARRAY_CLAIM],
      baseline: baselineOf([
        [ARRAY_CLAIM, 'holds'],
        [SYMBOL_CLAIM, 'falsified'],
      ]),
      reader: readerFor({ ...broken, 'src/authority.ts': 'export const unrelated = 1;' }),
    });
    const arrayEntry = report.entries.find((e) => e.claim.kind === 'string-in-array');
    const symbolEntry = report.entries.find((e) => e.claim.kind === 'symbol-defined');
    // Position-based pairing would swap these and report the symbol claim as the regression.
    expect(arrayEntry?.status).toBe('regressed');
    expect(symbolEntry?.status).toBe('still-false');
    expect(report.regressed).toBe(1);
  });

  it('no declared claims is an empty clean report, not a finding', () => {
    const report = recheckCompletionClaims({ claims: [], baseline: null, reader: readerFor({}) });
    expect(report).toMatchObject({ entries: [], regressed: 0, verdict: 'clean' });
    expect(renderCompletionClaimRecheck(report)).toBe('no declared claims');
  });
});

describe('the persisted record', () => {
  it('round-trips through its own schema and carries the SQL-decidable verdict', () => {
    const report = recheckCompletionClaims({
      claims: [ARRAY_CLAIM],
      baseline: baselineOf([[ARRAY_CLAIM, 'holds']]),
      reader: readerFor({ 'src/tools.ts': `export const CORE_TOOL_NAMES = [] as const;` }),
    });
    const record = completionClaimRecheckRecord({
      report,
      at: '2026-09-02T21:00:00.000Z',
      baselinePresent: true,
    });
    expect(CompletionClaimRecheckRecordSchema.safeParse(record).success).toBe(true);
    expect(record.verdict).toBe('regressed');
    expect(record.baselineMissing).toBe(false);
    expect(record.claimsChecked).toBe(1);
    expect(record.entries[0]).toMatchObject({ status: 'regressed', baselineVerdict: 'holds' });
  });

  it('records baselineMissing so a never-baselined close is not read as checked-clean', () => {
    const report = recheckCompletionClaims({ claims: [ARRAY_CLAIM], baseline: null, reader: readerFor({}) });
    const record = completionClaimRecheckRecord({ report, at: 'x', baselinePresent: false });
    expect(record.baselineMissing).toBe(true);
  });

  it('the audit predicate value and the written verdict are the SAME constant', () => {
    // Pins the write/read pair the audit bucket depends on: a predicate keyed on a value
    // nothing writes returns zero rows forever, with no error.
    const report = recheckCompletionClaims({
      claims: [ARRAY_CLAIM],
      baseline: baselineOf([[ARRAY_CLAIM, 'holds']]),
      reader: readerFor({ 'src/tools.ts': `export const CORE_TOOL_NAMES = [] as const;` }),
    });
    expect(completionClaimRecheckRecord({ report, at: 'x', baselinePresent: true }).verdict).toBe(
      COMPLETION_CLAIM_RECHECK_REGRESSED,
    );
    expect(COMPLETION_CLAIM_RECHECK_KEY).toBe('_completionClaimRecheck');
  });
});

describe('completionClaimBaseline', () => {
  it('captures every close-time verdict, falsified ones included', () => {
    const baseline = completionClaimBaseline(
      {
        results: [
          { claim: ARRAY_CLAIM, verdict: 'holds', reason: 'present' },
          { claim: SYMBOL_CLAIM, verdict: 'falsified', reason: 'absent' },
        ],
        held: 1,
        falsified: 1,
        unevaluatable: 0,
        anyFalsified: true,
      },
      '2026-09-02T20:00:00.000Z',
    );
    // A falsified claim MUST be recorded: without it the sweep cannot tell "already false"
    // from "went false", which is the whole distinction this baseline exists to preserve.
    expect(baseline?.entries.map((e) => e.verdict)).toEqual(['holds', 'falsified']);
    expect(baseline?.at).toBe('2026-09-02T20:00:00.000Z');
  });

  it('an empty report produces NO baseline object', () => {
    expect(
      completionClaimBaseline(
        { results: [], held: 0, falsified: 0, unevaluatable: 0, anyFalsified: false },
        'x',
      ),
    ).toBeUndefined();
  });
});
