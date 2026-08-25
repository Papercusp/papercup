/**
 * Report-only is a property of the CODE, and this is where that is checked.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-008), D-006.
 *
 * The behavioural tests below are the easy half. The structural ones matter
 * more: a `gating` flag someone can flip, or a stray `process.exit`, is how a
 * report-only stage becomes a gate without anybody deciding it should. The
 * enforcement decision belongs to the work_items:complete adapter behind
 * DESIGN_EVIDENCE_GATE_ENFORCING, and this module must have no route to it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildReport, formatReportSummary } from './report';
import type { CalibrationArtifact, ClassCalibration } from './policy-shape';

/**
 * `report.ts` with comments stripped.
 *
 * The scans below look for names that would mean this module can gate. Its own
 * doc comment explains where enforcement DOES live and names that module, so a
 * raw-source scan fails on the documentation rather than on the code — and a
 * guard that cannot survive being documented is a guard someone deletes the
 * first time it cries wolf.
 */
const REPORT_SOURCE = readFileSync(path.join(__dirname, 'report.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n');

function classOf(overrides: Partial<ClassCalibration> = {}): ClassCalibration {
  return {
    referenceClass: 'artifact-capture',
    cohorts: ['real-surface'],
    noise: { n: 0, maxDiffRatio: null, samples: [] },
    regression: { n: 0, minDiffRatio: null, samples: [] },
    indistinguishablePairs: [],
    fidelityCorpus: { faithfulMaxDiffRatio: null, driftedMinDiffRatio: null, samples: [] },
    captureRuntime: { n: 0, p50Ms: null, maxMs: null },
    comparisonRuntime: { n: 0, p50Ms: null, maxMs: null },
    smallestPixelsTotal: null,
    ...overrides,
  };
}

function artifactOf(classes: ClassCalibration[]): CalibrationArtifact {
  return {
    schemaVersion: 1,
    policyVersion: 'test',
    generatedAt: '2026-08-25T00:00:00.000Z',
    engine: { engine: 'lost-pixel/pixelmatch', engineVersion: '0.0.0-test' },
    environment: {
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      browser: 'chromium',
      theme: 'light',
      fontSet: 'system',
      state: 'default',
    },
    realSurface: { source: 'test', storiesCaptured: classes.length, refusals: [] },
    classes,
    caveats: ['test caveat'],
  };
}

/** A ratio the shipped artifact-capture threshold (~3.4e-5) definitely fails. */
const RATIO_ABOVE_THRESHOLD = 0.02;
/** A ratio it definitely passes. */
const RATIO_BELOW_THRESHOLD = 0;

describe('report-only is structural, not a setting', () => {
  it('types `gating` as the literal false', () => {
    const report = buildReport(artifactOf([classOf()]));
    // Compiles only because the field is `false`, not `boolean`.
    const gating: false = report.gating;
    expect(gating).toBe(false);
  });

  it('never touches a process exit code', () => {
    // The one line of code that would turn this module into a gate.
    expect(REPORT_SOURCE).not.toMatch(/process\.exit/);
    expect(REPORT_SOURCE).not.toMatch(/exitCode/);
  });

  it('has no import path to the enforcement adapter', () => {
    expect(REPORT_SOURCE).not.toMatch(/design-evidence-gate/);
    expect(REPORT_SOURCE).not.toMatch(/ENFORCING/);
  });

  it('would still catch a real enforcement import after comments are stripped', () => {
    // The control for the two scans above. Stripping comments is what lets
    // `report.ts` document where enforcement lives — and it is also exactly how
    // those scans could be neutered into passing on anything. This deliberately
    // wrong source proves they still bite on code.
    const strip = (source: string): string =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');

    const wouldGate = strip(
      [
        '/** A doc comment mentioning design-evidence-gate, which must be ignored. */',
        "import { enforcing } from '../agent-tools/work_items/design-evidence-gate';",
        'if (enforcing) process.exit(1);',
      ].join('\n'),
    );

    expect(wouldGate).toMatch(/design-evidence-gate/);
    expect(wouldGate).toMatch(/process\.exit/);
  });

  it('does not throw when every case fails', () => {
    // A report of total failure is still a report. Throwing here would make the
    // CI step's exit code depend on the verdicts, which is the definition of a
    // gate.
    const report = buildReport(
      artifactOf([
        classOf({
          noise: {
            n: 1,
            maxDiffRatio: RATIO_ABOVE_THRESHOLD,
            samples: [
              {
                caseId: 'noise-that-fails',
                diffRatio: RATIO_ABOVE_THRESHOLD,
                pixelsTotal: 1_024_000,
                comparisonMs: 1,
              },
            ],
          },
        }),
      ]),
    );
    expect(report.summary.fail).toBeGreaterThan(0);
    expect(report.gating).toBe(false);
  });
});

describe('the self-check catches a threshold that has stopped separating', () => {
  it('is consistent when unchanged surfaces pass and real changes fail', () => {
    const report = buildReport(
      artifactOf([
        classOf({
          noise: {
            n: 1,
            maxDiffRatio: RATIO_BELOW_THRESHOLD,
            samples: [
              { caseId: 'quiet', diffRatio: RATIO_BELOW_THRESHOLD, pixelsTotal: 1_024_000, comparisonMs: 1 },
            ],
          },
          regression: {
            n: 1,
            minDiffRatio: RATIO_ABOVE_THRESHOLD,
            samples: [
              { caseId: 'loud', diffRatio: RATIO_ABOVE_THRESHOLD, pixelsTotal: 1_024_000, comparisonMs: 1 },
            ],
          },
        }),
      ]),
    );
    expect(report.selfCheck.consistent).toBe(true);
  });

  it('names an unchanged surface that started failing', () => {
    // The drift no static test can catch: the code is unchanged and the SURFACE
    // moved underneath the threshold.
    const report = buildReport(
      artifactOf([
        classOf({
          noise: {
            n: 1,
            maxDiffRatio: RATIO_ABOVE_THRESHOLD,
            samples: [
              { caseId: 'noisy-now', diffRatio: RATIO_ABOVE_THRESHOLD, pixelsTotal: 1_024_000, comparisonMs: 1 },
            ],
          },
        }),
      ]),
    );
    expect(report.selfCheck.consistent).toBe(false);
    expect(report.selfCheck.noiseThatFailed).toContain('noisy-now');
  });

  it('names a real change that started passing', () => {
    const report = buildReport(
      artifactOf([
        classOf({
          regression: {
            n: 1,
            minDiffRatio: RATIO_BELOW_THRESHOLD,
            samples: [
              { caseId: 'now-invisible', diffRatio: RATIO_BELOW_THRESHOLD, pixelsTotal: 1_024_000, comparisonMs: 1 },
            ],
          },
        }),
      ]),
    );
    expect(report.selfCheck.consistent).toBe(false);
    expect(report.selfCheck.regressionsThatPassed).toContain('now-invisible');
  });

  it('makes no prediction for an advisory-only class', () => {
    // An advisory class produces `invalid`, which is neither a pass nor a
    // failure of a prediction. Marking those as violations would make the
    // self-check cry wolf on every run.
    const report = buildReport(
      artifactOf([
        classOf({
          referenceClass: 'raster-mockup',
          cohorts: ['fixture-corpus'],
          noise: {
            n: 1,
            maxDiffRatio: 0,
            samples: [{ caseId: 'advisory', diffRatio: 0, pixelsTotal: 1000, comparisonMs: 1 }],
          },
        }),
      ]),
    );
    expect(report.cases.every((c) => c.asPredicted === null)).toBe(true);
    expect(report.selfCheck.consistent).toBe(true);
  });
});

describe('the summary counts predictions, not raw verdicts', () => {
  it('does not count an expected regression failure as a problem', () => {
    // The misreading this exists to prevent: a healthy run reads "N fail"
    // because every regression case is SUPPOSED to fail.
    const report = buildReport(
      artifactOf([
        classOf({
          regression: {
            n: 1,
            minDiffRatio: RATIO_ABOVE_THRESHOLD,
            samples: [
              { caseId: 'caught', diffRatio: RATIO_ABOVE_THRESHOLD, pixelsTotal: 1_024_000, comparisonMs: 1 },
            ],
          },
        }),
      ]),
    );
    expect(report.summary.fail).toBe(1);
    expect(report.summary.predictionsMade).toBe(1);
    expect(report.summary.predictionsHeld).toBe(1);
    expect(report.selfCheck.consistent).toBe(true);
  });

  it('leads the summary with predictions held rather than with pass/fail', () => {
    const summary = formatReportSummary(buildReport(artifactOf([classOf()])));
    const predictionsLine = summary.indexOf('predictions held');
    const verdictsLine = summary.indexOf('raw verdicts');
    expect(predictionsLine).toBeGreaterThan(-1);
    expect(predictionsLine).toBeLessThan(verdictsLine);
  });

  it('excludes advisory-only cases from the prediction count', () => {
    const report = buildReport(
      artifactOf([
        classOf({
          referenceClass: 'raster-mockup',
          cohorts: ['fixture-corpus'],
          noise: {
            n: 1,
            maxDiffRatio: 0,
            samples: [{ caseId: 'advisory', diffRatio: 0, pixelsTotal: 1000, comparisonMs: 1 }],
          },
        }),
      ]),
    );
    expect(report.summary.predictionsMade).toBe(0);
  });
});

describe('the summary states what it is', () => {
  it('says report-only on its first line, where a reader scanning a CI log sees it', () => {
    const summary = formatReportSummary(buildReport(artifactOf([classOf()])));
    expect(summary.split('\n')[0]).toMatch(/REPORT-ONLY/);
  });

  it('renders an unmeasured noise floor as unmeasured rather than as a number', () => {
    const summary = formatReportSummary(
      buildReport(artifactOf([classOf({ referenceClass: 'raster-mockup', cohorts: ['fixture-corpus'] })])),
    );
    expect(summary).toContain('noise=unmeasured');
  });

  it('carries the measurement’s caveats through to the report', () => {
    // Scope limits must travel with the numbers. A report that drops them
    // invites someone to quote a same-host figure as a cross-host one.
    const report = buildReport(artifactOf([classOf()]));
    expect(report.caveats).toContain('test caveat');
  });
});
