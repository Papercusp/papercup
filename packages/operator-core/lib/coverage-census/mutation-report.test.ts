import { describe, expect, it } from 'vitest';

import {
  fileLethality,
  MutationReportError,
  nonLethalTests,
  overallLethality,
  parseMutationReport,
  testLethality,
  toMutationEvidenceRecords,
  type MutantStatus,
  type MutationReport,
  type MutationReportMutant,
} from './mutation-report';

/**
 * Falsifiability here is carried by PERMANENT IN-TEST CONTROLS, not by mutating the
 * shared tree. This repo's git-sync sweep commits the whole working tree every few
 * minutes, so a probe that edits the real module can be committed mid-run even when
 * nothing goes wrong — a trap cannot fix that (see scripts/mutation-probe.sh's header).
 * So the deliberately-WRONG scorers below live here forever, beside a calibration case
 * the real implementation must pass. If the real scorer ever degrades into one of them,
 * the calibration test fails.
 */

let nextId = 0;
function mutants(spec: Partial<Record<MutantStatus, number>>): MutationReportMutant[] {
  const out: MutationReportMutant[] = [];
  for (const [status, count] of Object.entries(spec)) {
    for (let i = 0; i < (count ?? 0); i += 1) {
      out.push({ id: String(nextId++), status: status as MutantStatus });
    }
  }
  return out;
}

function report(files: Record<string, MutationReportMutant[]>): MutationReport {
  return {
    schemaVersion: '1.0',
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { mutants: v }])),
  };
}

describe('mutation-report — scoring calibration against a REAL Stryker run', () => {
  /**
   * These are not invented numbers. They are the measured aggregate of the first-ever
   * Stryker run in this repo (WI-2142121, @papercusp/publish-auth, 2026-09-03):
   *
   *   All files | 76.31 total | 83.38 covered | 301 killed | 5 timeout | 61 survived | 34 no-cov
   *
   * Pinning them here means our scorer is calibrated against Stryker's OWN arithmetic
   * rather than against our reading of the docs. If Stryker changes how it scores, or
   * we drift from it, this fails.
   */
  const REAL = { Killed: 301, Timeout: 5, Survived: 61, NoCoverage: 34 } as const;

  it('reproduces Stryker’s own total and covered scores exactly', () => {
    const counts = overallLethality(report({ 'src/all.ts': mutants(REAL) }));

    expect(counts.killed).toBe(301);
    expect(counts.timeout).toBe(5);
    expect(counts.survived).toBe(61);
    expect(counts.noCoverage).toBe(34);
    expect(counts.detected).toBe(306);
    expect(counts.scored).toBe(401);

    expect(counts.mutationScore).toBe(76.31);
    expect(counts.coveredScore).toBe(83.38);
  });

  it('CONTROL: two plausible wrong scorers do NOT produce 76.31 — so the calibration discriminates', () => {
    const { Killed: killed, Timeout: timeout, Survived: survived, NoCoverage: noCoverage } = REAL;
    const round = (n: number, d: number) => Math.round((n / d) * 10000) / 100;

    // Wrong #1: counting NoCoverage as detected (a mutant nothing ran is not "caught").
    const countsNoCovAsDetected = round(killed + timeout + noCoverage, killed + timeout + survived + noCoverage);
    // Wrong #2: omitting NoCoverage from the denominator (that is the COVERED score,
    // not the total — conflating them silently inflates the headline number).
    const omitNoCovFromDenominator = round(killed + timeout, killed + timeout + survived);

    expect(countsNoCovAsDetected).not.toBe(76.31);
    expect(omitNoCovFromDenominator).not.toBe(76.31);
    // ...and the second wrong answer is exactly the covered score, which is precisely
    // why the two must be reported as separate fields rather than one number.
    expect(omitNoCovFromDenominator).toBe(83.38);
  });

  it('excludes non-verdict mutants from the denominator instead of counting them as misses', () => {
    const counts = overallLethality(
      report({
        'src/a.ts': mutants({ Killed: 1, CompileError: 5, Ignored: 3, Pending: 2, RuntimeError: 1 }),
      }),
    );

    expect(counts.unscored).toBe(11);
    expect(counts.scored).toBe(1);
    // A compile error is not evidence the tests are weak. Folding those 11 in would
    // report 8.33 for a suite that caught everything it could actually judge.
    expect(counts.mutationScore).toBe(100);
  });
});

describe('mutation-report — the false-zero guard', () => {
  it('returns null, NOT 0, when nothing was scored', () => {
    const counts = overallLethality(report({ 'src/a.ts': mutants({ Ignored: 4 }) }));

    expect(counts.scored).toBe(0);
    // 0 would be indistinguishable from a genuinely terrible score. The honest answer
    // to "what is the mutation score of nothing" is "there isn't one".
    expect(counts.mutationScore).toBeNull();
    expect(counts.coveredScore).toBeNull();
  });

  it('coveredScore is null when every mutant was uncovered, even though total score is 0', () => {
    const counts = overallLethality(report({ 'src/a.ts': mutants({ NoCoverage: 7 }) }));

    expect(counts.mutationScore).toBe(0); // genuinely 0: 7 mutants judged, none caught
    expect(counts.coveredScore).toBeNull(); // but nothing was COVERED, so no covered score
  });
});

describe('mutation-report — parse refuses undetermined input', () => {
  it('refuses a report describing zero files rather than reporting it clean', () => {
    expect(() => parseMutationReport({ schemaVersion: '1.0', files: {} })).toThrow(MutationReportError);
    expect(() => parseMutationReport({ schemaVersion: '1.0', files: {} })).toThrow(/ZERO files/);
  });

  it('refuses a non-object and a missing files map', () => {
    expect(() => parseMutationReport(null)).toThrow(MutationReportError);
    expect(() => parseMutationReport('{}')).toThrow(MutationReportError);
    expect(() => parseMutationReport({ schemaVersion: '1.0' })).toThrow(/no `files` map/);
  });

  it('refuses a file entry with no mutants array, naming the file', () => {
    expect(() => parseMutationReport({ files: { 'src/x.ts': { language: 'typescript' } } })).toThrow(
      /src\/x\.ts/,
    );
  });

  it('accepts a real-shaped report and narrows unknown statuses to Pending', () => {
    const parsed = parseMutationReport({
      schemaVersion: '1.0',
      files: {
        'src/a.ts': {
          language: 'typescript',
          mutants: [
            { id: 1, status: 'Killed', killedBy: ['26'], coveredBy: ['6', '26'] },
            { id: 2, status: 'NotARealStatus' },
          ],
        },
      },
      testFiles: { 'src/a.test.ts': { tests: [{ id: '26', name: 'kills it' }] } },
    });

    expect(parsed.files['src/a.ts'].mutants[0].id).toBe('1');
    expect(parsed.files['src/a.ts'].mutants[0].killedBy).toEqual(['26']);
    // An unrecognized status must not silently become a miss.
    expect(parsed.files['src/a.ts'].mutants[1].status).toBe('Pending');
    expect(parsed.testFiles?.['src/a.test.ts'].tests[0].name).toBe('kills it');
  });
});

describe('mutation-report — per-test lethality (census P-016’s binding predicate)', () => {
  const withBindings: MutationReport = {
    schemaVersion: '1.0',
    files: {
      'src/a.ts': {
        mutants: [
          // killer covers and kills
          { id: 'm1', status: 'Killed', killedBy: ['killer'], coveredBy: ['killer', 'passenger'] },
          { id: 'm2', status: 'Killed', killedBy: ['killer'], coveredBy: ['killer', 'passenger'] },
          // nobody kills this one; passenger ran it and did not notice
          { id: 'm3', status: 'Survived', killedBy: [], coveredBy: ['passenger'] },
          // nothing covered this at all
          { id: 'm4', status: 'NoCoverage', killedBy: [], coveredBy: [] },
        ],
      },
    },
    testFiles: {
      'src/a.test.ts': {
        tests: [
          { id: 'killer', name: 'pins the behaviour' },
          { id: 'passenger', name: 'executes without asserting' },
          { id: 'bystander', name: 'never touches this surface' },
        ],
      },
    },
  };

  it('counts kills and coverage per test, and resolves names', () => {
    const byId = Object.fromEntries(testLethality(withBindings).map((t) => [t.testId, t]));

    expect(byId.killer).toMatchObject({
      name: 'pins the behaviour',
      killedCount: 2,
      coveredCount: 2,
      lethal: true,
    });
    expect(byId.passenger).toMatchObject({
      name: 'executes without asserting',
      killedCount: 0,
      coveredCount: 3,
      lethal: false,
    });
  });

  it('flags a covers-but-never-kills test as NON-LETHAL — the whole point of the module', () => {
    const flagged = nonLethalTests(withBindings);

    expect(flagged.map((t) => t.testId)).toEqual(['passenger']);
    expect(flagged[0].coveredCount).toBeGreaterThan(0);
    expect(flagged[0].killedCount).toBe(0);
  });

  it('does NOT flag a test the report never associates with any mutant', () => {
    // `bystander` is declared in testFiles but appears in no killedBy/coveredBy. That is
    // untested-surface evidence, not weak-assertion evidence, and conflating the two
    // would flood the non-lethal list with tests that are simply about something else.
    expect(testLethality(withBindings).map((t) => t.testId)).not.toContain('bystander');
    expect(nonLethalTests(withBindings).map((t) => t.testId)).not.toContain('bystander');
  });

  it('returns an empty non-lethal list when every binding kills something', () => {
    // Matches the measured result for @papercusp/publish-auth: 29 test bindings, 0 non-lethal.
    const allLethal: MutationReport = {
      schemaVersion: '1.0',
      files: {
        'src/a.ts': {
          mutants: [
            { id: 'm1', status: 'Killed', killedBy: ['t1'], coveredBy: ['t1'] },
            { id: 'm2', status: 'Killed', killedBy: ['t2'], coveredBy: ['t2'] },
          ],
        },
      },
    };

    expect(nonLethalTests(allLethal)).toEqual([]);
    // ...and a positive control, so an empty result can never be a broken-instrument zero.
    expect(testLethality(allLethal)).toHaveLength(2);
  });
});

describe('mutation-report — spec-evidence records (P-011’s producer half)', () => {
  const withSource: MutationReport = {
    schemaVersion: '1.0',
    files: {
      'src/a.ts': {
        source: 'export const a = 1;',
        mutants: [
          { id: 'm1', status: 'Killed', killedBy: ['t1'], coveredBy: ['t1', 't2'] },
          { id: 'm2', status: 'Survived', killedBy: [], coveredBy: ['t2'] },
        ],
      },
      'src/b.ts': { source: 'export const b = 2;', mutants: [{ id: 'm3', status: 'NoCoverage' }] },
    },
    testFiles: {
      'src/a.test.ts': {
        tests: [
          { id: 't1', name: 'pins it' },
          { id: 't2', name: 'just runs it' },
        ],
      },
    },
  };

  it('emits one mutation record per mutated file, keyed by the report’s own path', () => {
    const records = toMutationEvidenceRecords(withSource, { fingerprintFor: () => 'fp' });

    expect(records.map((r) => r.evidenceRef)).toEqual(['mutation:src/a.ts', 'mutation:src/b.ts']);
    expect(new Set(records.map((r) => r.evidenceKind))).toEqual(new Set(['mutation']));
  });

  it('takes sourceFingerprint from the caller, passing the file and its source', () => {
    const seen: Array<[string, string | undefined]> = [];
    const records = toMutationEvidenceRecords(withSource, {
      fingerprintFor: (file, source) => {
        seen.push([file, source]);
        return `fp:${file}`;
      },
    });

    // The module must not invent a fingerprint scheme — there is no repo-wide convention
    // to match, so whatever the caller supplies is what freshness comparison will use.
    expect(seen).toEqual([
      ['src/a.ts', 'export const a = 1;'],
      ['src/b.ts', 'export const b = 2;'],
    ]);
    expect(records[0].sourceFingerprint).toBe('fp:src/a.ts');
  });

  it('carries per-file counts, keeping a coverage hole distinct from a weak assertion', () => {
    const byRef = Object.fromEntries(
      toMutationEvidenceRecords(withSource, { fingerprintFor: () => 'fp' }).map((r) => [r.evidenceRef, r]),
    );

    // a.ts: 1 killed, 1 survived -> covered, but under-asserted
    expect(byRef['mutation:src/a.ts'].details).toMatchObject({
      detected: 1,
      survived: 1,
      noCoverage: 0,
      mutationScore: 50,
      coveredScore: 50,
    });
    // b.ts: nothing covered at all -> score 0 but NO covered score to report
    expect(byRef['mutation:src/b.ts'].details).toMatchObject({
      detected: 0,
      noCoverage: 1,
      mutationScore: 0,
      coveredScore: null,
    });
  });

  it('preserves file source through the parse path, so fingerprintFor receives real bytes', () => {
    // REGRESSION (caught end-to-end, not by the hand-built fixtures above): the parser
    // originally dropped `source`, so every fingerprint degraded to a hash of undefined —
    // identical for all files, which would make freshness comparison read every surface
    // as unchanged forever. The hand-built reports in this file construct MutationReport
    // directly and therefore CANNOT catch it; this test must go through parseMutationReport.
    const parsed = parseMutationReport({
      schemaVersion: '1.0',
      files: {
        'src/a.ts': { source: 'export const a = 1;', mutants: [{ id: 'm1', status: 'Killed' }] },
        'src/b.ts': { source: 'export const b = 2;', mutants: [{ id: 'm2', status: 'Killed' }] },
      },
    });

    expect(parsed.files['src/a.ts'].source).toBe('export const a = 1;');

    const seen: Array<string | undefined> = [];
    toMutationEvidenceRecords(parsed, {
      fingerprintFor: (_f, source) => {
        seen.push(source);
        return String(source);
      },
    });

    expect(seen).toEqual(['export const a = 1;', 'export const b = 2;']);
    // The bug's signature was every fingerprint input being identical. Assert distinctness
    // explicitly — a per-file fingerprint that never varies is the failure mode.
    expect(new Set(seen).size).toBe(2);
  });

  it('reports non-lethal test names report-wide, not sliced per file', () => {
    const records = toMutationEvidenceRecords(withSource, { fingerprintFor: () => 'fp' });

    // t2 covers mutants in a.ts and kills none. Slicing lethality per file would
    // misreport a test that kills in one file and merely covers another, so every
    // record carries the same report-wide list.
    for (const r of records) expect(r.details.nonLethalTestNames).toEqual(['just runs it']);
  });
});

describe('mutation-report — per-file breakdown', () => {
  it('scores each file independently and preserves the report’s own paths', () => {
    const rows = fileLethality(
      report({
        // the two measured extremes from the real run
        'src/random.ts': mutants({ Killed: 3, Survived: 2, NoCoverage: 13 }),
        'src/secret-hash.ts': mutants({ Killed: 12, Survived: 1 }),
      }),
    );

    const byFile = Object.fromEntries(rows.map((r) => [r.file, r]));
    expect(byFile['src/random.ts'].mutationScore).toBe(16.67);
    expect(byFile['src/secret-hash.ts'].mutationScore).toBe(92.31);

    // random.ts is a COVERAGE hole, not a weak-assertion one — its covered score is
    // far better than its total. Reporting only the total hides which fix is needed.
    expect(byFile['src/random.ts'].coveredScore).toBe(60);
  });
});
