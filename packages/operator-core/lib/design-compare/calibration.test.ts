/**
 * P-002 per-reference-class calibration.
 *
 * D-007 claims that pixel-diff gateability is a property of the REFERENCE CLASS.
 * This file turns that claim into a measurement by asking one question of each
 * class:
 *
 *     Is there anywhere honest to put a threshold?
 *
 * For each class the corpus supplies a FAITHFUL implementation (whose diff is the
 * class's irreducible noise floor) and a DRIFTED one (a real regression a gate
 * must catch). The separation statistic is how many times larger the regression
 * is than the noise floor. A class is gateable when that ratio clears
 * `SEPARATION_FLOOR`; below it, any threshold either passes regressions or fails
 * correct work.
 *
 * SCOPE OF THE CLAIM — read before quoting a number from here.
 * The corpus is synthetic (see `corpus/cases.ts`). These tests prove the METHOD
 * discriminates, and that it discriminates in the direction D-007 predicts for
 * each class's modelled noise profile. They do NOT establish production
 * thresholds, and no class may be promoted to `gateable` in a shipped policy on
 * their strength alone. P-008 supplies the real-surface cohort that does that.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CALIBRATED_CLASSES, CORPUS_PAIRS } from './corpus/cases';
import {
  type ClassCalibration,
  ENGINES,
  type EngineId,
  LOST_PIXEL_DEFAULT_ENGINE,
  type MaterialisedCorpus,
  SEPARATION_FLOOR,
  calibrate,
  compareWithEngine,
  materialiseCorpus,
  pairDiffPath,
} from './corpus/harness';

/**
 * The engine every calibration number in this file is measured on. See the
 * "engine fitness" block below for why it is not the lost-pixel default.
 */
const CALIBRATION_ENGINE: EngineId = 'pixelmatch';

let workDir: string;
let corpus: MaterialisedCorpus;

/** engine -> pair id -> measured diff ratio */
const ratios = new Map<EngineId, Map<string, number>>();
/** engine -> pair id -> measured wall time */
const timings = new Map<EngineId, Map<string, number>>();

beforeAll(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'design-compare-calibration-'));
  corpus = materialiseCorpus(path.join(workDir, 'corpus'));

  for (const engine of ENGINES) {
    const byPair = new Map<string, number>();
    const byPairMs = new Map<string, number>();
    for (const pair of CORPUS_PAIRS) {
      const reference = corpus.paths.get(pair.reference);
      const candidate = corpus.paths.get(pair.candidate);
      if (!reference || !candidate) throw new Error(`corpus incomplete for pair ${pair.id}`);
      const measured = await compareWithEngine(
        engine,
        reference,
        candidate,
        pairDiffPath(workDir, engine, pair.id),
        { threshold: 0 },
      );
      byPair.set(pair.id, measured.diffRatio);
      byPairMs.set(pair.id, measured.elapsedMs);
    }
    ratios.set(engine, byPair);
    timings.set(engine, byPairMs);
  }
}, 60_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const ratioFor = (engine: EngineId, pairId: string): number => {
  const value = ratios.get(engine)?.get(pairId);
  if (value === undefined) throw new Error(`no measurement for ${engine}/${pairId}`);
  return value;
};

const calibrationFor = (engine: EngineId, referenceClass: string): ClassCalibration =>
  calibrate(
    referenceClass,
    engine,
    ratioFor(engine, `${referenceClass}/faithful`),
    ratioFor(engine, `${referenceClass}/drifted`),
  );

describe('engine fitness: calibration runs on pixelmatch, and why', () => {
  /**
   * Calibration is measured on pixelmatch ONLY. This is not a preference; odiff
   * as lost-pixel invokes it is unfit to carry this measurement at all.
   *
   * `engine-proof.test.ts` pins the mechanism: odiff runs at its own default
   * colour-distance threshold, which lost-pixel never configures, so a whole-image
   * shift of up to 45/255 per channel reads as a perfect match. The noise a
   * commensurable reference class legitimately produces — antialiasing on glyph
   * edges — lives entirely inside that blind spot.
   *
   * The consequence for calibration is stark: on odiff the measured noise floor
   * for a commensurable class is exactly ZERO, not because the implementations
   * agree but because the engine cannot see where they disagree. A floor of zero
   * makes the separation statistic degenerate, and a gate calibrated against it
   * would be calibrated against nothing.
   */
  it('odiff is wholly blind to the finest class, and under-measures every class', () => {
    // The blindness is a threshold effect, not a constant: differences below
    // odiff's colour tolerance vanish completely, and differences that straddle it
    // are partially counted. Both behaviours disqualify it as a calibration
    // instrument, but they disqualify it in different ways and the distinction
    // matters when reading the table below.
    //
    // artifact-capture is two browser renders of the same DOM, so its only
    // disagreement is antialiasing — entirely inside the tolerance. odiff reports
    // exactly zero: the floor is not small, it is INVISIBLE.
    expect(ratioFor('odiff', 'artifact-capture/faithful')).toBe(0);

    // figma-export carries heavier rasterisation differences that DO cross the
    // tolerance, so odiff counts them — and counts MORE of them than pixelmatch
    // does, because pixelmatch is suppressing the same pixels as antialiasing
    // (see the includeAA proof in engine-proof.test.ts).
    //
    // So neither engine dominates the other. They disagree in BOTH directions on
    // the same corpus, because each applies a different unversioned noise
    // heuristic. That is the real disqualifier: not that one under-counts, but
    // that "the number of differing pixels" is not a single well-defined quantity
    // across the two engines a gate might be pointed at.
    expect(ratioFor('odiff', 'figma-export/faithful')).toBeGreaterThan(
      ratioFor(CALIBRATION_ENGINE, 'figma-export/faithful'),
    );
  });

  it('pixelmatch reports a finite, positive noise floor for every class', () => {
    // The property odiff fails. A faithful implementation must produce a small but
    // real difference, or the corpus is not modelling anything and the separation
    // statistic has no denominator.
    for (const referenceClass of CALIBRATED_CLASSES) {
      const faithful = ratioFor(CALIBRATION_ENGINE, `${referenceClass}/faithful`);
      expect(faithful).toBeGreaterThan(0);
      expect(Number.isFinite(faithful)).toBe(true);
    }
  });

  it('records that the adapter must SELECT pixelmatch rather than inherit the default', () => {
    // lost-pixel's dispatcher falls through to odiff unless compareEngine is
    // exactly 'pixelmatch', and no config in this repo sets it. So the engine that
    // cannot measure is the engine that runs today.
    expect(LOST_PIXEL_DEFAULT_ENGINE).toBe('odiff');
    expect(CALIBRATION_ENGINE).toBe('pixelmatch');
    expect(CALIBRATION_ENGINE).not.toBe(LOST_PIXEL_DEFAULT_ENGINE);
  });
});

describe('D-007: commensurable classes admit a threshold', () => {
  // A real render compared against a real render, and a vector export compared
  // against a real render, both differ only where rasterisation differs. A
  // genuine layout regression is far larger than that floor, so a threshold fits
  // comfortably between them.
  for (const referenceClass of ['artifact-capture', 'figma-export'] as const) {
    it(`${referenceClass}: a regression is at least ${SEPARATION_FLOOR}x the noise floor`, () => {
      const result = calibrationFor(CALIBRATION_ENGINE, referenceClass);
      expect(result.driftedRatio).toBeGreaterThan(result.faithfulRatio);
      expect(result.separation).toBeGreaterThanOrEqual(SEPARATION_FLOOR);
      expect(result.gateable).toBe(true);
    });
  }
});

describe('D-007: an incommensurable class admits no threshold', () => {
  it('raster-mockup: a CORRECT implementation already differs enormously', () => {
    // The decisive measurement. A perfectly faithful implementation of a painted
    // mockup still disagrees with it across a large fraction of the canvas,
    // because the mockup hallucinates letterform positions, shifts the palette of
    // every fill and tints the background. The noise floor is not small.
    expect(ratioFor(CALIBRATION_ENGINE, 'raster-mockup/faithful')).toBeGreaterThan(0.05);
  });

  it('raster-mockup: the regression is NOT separable from the noise floor', () => {
    // Because the floor is enormous, a real regression barely moves the number.
    // There is no threshold that passes the faithful implementation and fails the
    // drifted one with any margin — which is precisely D-007's claim, and the
    // reason this class must not be wired to a gate.
    const result = calibrationFor(CALIBRATION_ENGINE, 'raster-mockup');
    expect(result.separation).toBeLessThan(SEPARATION_FLOOR);
    expect(result.gateable).toBe(false);
  });

  it('raster-mockup noise floor dwarfs the gateable classes noise floors', () => {
    // States the contrast directly: the thing that makes this class ungateable is
    // not that its regressions are subtle, but that its FLOOR is high.
    const mockupFloor = ratioFor(CALIBRATION_ENGINE, 'raster-mockup/faithful');
    const artifactFloor = ratioFor(CALIBRATION_ENGINE, 'artifact-capture/faithful');
    expect(mockupFloor).toBeGreaterThan(artifactFloor * 10);
  });

  it('a derived reference is the documented escape hatch, not a lower threshold', () => {
    // D-007's remedy is to derive a gateable reference from the incommensurable
    // one and ratify THAT. The corpus expresses this: the faithful implementation
    // of the mockup, once ratified as a reference in its own right, is an
    // `artifact-capture` and calibrates as gateable. Nothing about the threshold
    // changed — the reference did.
    const derived = calibrationFor(CALIBRATION_ENGINE, 'artifact-capture');
    expect(derived.gateable).toBe(true);
    expect(calibrationFor(CALIBRATION_ENGINE, 'raster-mockup').gateable).toBe(false);
  });
});

describe('recorded calibration and runtime data (P-002 deliverable)', () => {
  it('emits the per-class, per-engine calibration table', () => {
    const rows: string[] = [];
    for (const engine of ENGINES) {
      for (const referenceClass of CALIBRATED_CLASSES) {
        const result = calibrationFor(engine, referenceClass);
        const blind = engine !== CALIBRATION_ENGINE && result.faithfulRatio === 0;
        rows.push(
          [
            engine.padEnd(10),
            referenceClass.padEnd(17),
            `floor=${(result.faithfulRatio * 100).toFixed(3)}%`.padEnd(16),
            `regression=${(result.driftedRatio * 100).toFixed(3)}%`.padEnd(22),
            `separation=${result.separation.toFixed(2)}x`.padEnd(20),
            blind ? 'UNFIT (blind floor)' : result.gateable ? 'GATEABLE' : 'ADVISORY-ONLY',
          ].join(' '),
        );
      }
    }
    // Printed so the measurement is recoverable from a CI log, not only from a
    // passing assertion. Both engines are shown deliberately: the odiff rows are
    // the evidence for excluding it, not leftovers.
    console.info(
      `\nP-002 calibration (SEPARATION_FLOOR=${SEPARATION_FLOOR}x, calibrated on ${CALIBRATION_ENGINE})\n${rows.join('\n')}`,
    );
    expect(rows).toHaveLength(ENGINES.length * CALIBRATED_CLASSES.length);
  });

  it('emits per-engine runtime for the corpus and stays within a sane budget', () => {
    const summary: string[] = [];
    for (const engine of ENGINES) {
      const engineTimings = timings.get(engine);
      if (!engineTimings) throw new Error(`no timings for ${engine}`);
      const values = [...engineTimings.values()];
      const total = values.reduce((sum, value) => sum + value, 0);
      const slowest = Math.max(...values);
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      summary.push(
        `${engine.padEnd(10)} pairs=${values.length} total=${total.toFixed(1)}ms median=${median.toFixed(1)}ms slowest=${slowest.toFixed(1)}ms`,
      );
      // A generous ceiling: this exists to catch an engine becoming
      // pathologically slow, not to benchmark it. The corpus is 320x240.
      //
      // Assert the MEDIAN, not the slowest pair. Each pair is timed once, by
      // wall clock, around an await that may spawn a child process (odiff), and
      // the first pair also pays the engine's cold start. So `slowest` is a
      // single sample that one scheduling or IO stall can inflate. That happened
      // in the green-checkpoint suite: 13.3s for one pair (WI-10002602), while
      // the file passed 97 of 98 runs over 14 days and passed alone afterwards.
      // A real engine slowdown is systematic and moves the median, so the median
      // still catches the regression this ceiling exists for.
      expect(median).toBeLessThan(5_000);
    }
    console.info(`\nP-002 runtime (320x240 corpus)\n${summary.join('\n')}`);
    expect(summary).toHaveLength(ENGINES.length);
  });
});
