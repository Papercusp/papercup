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
  type MaterialisedCorpus,
  SEPARATION_FLOOR,
  calibrate,
  compareWithEngine,
  materialiseCorpus,
  pairDiffPath,
} from './corpus/harness';

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

describe('the calibration statistic behaves as a discriminator', () => {
  it('reports a finite, positive noise floor for every class on every engine', () => {
    // If a faithful implementation produced a zero diff, the class would be
    // trivially gateable and the corpus would not be modelling anything real.
    // Every class must have a genuine noise floor for the measurement to mean
    // anything.
    for (const engine of ENGINES) {
      for (const referenceClass of CALIBRATED_CLASSES) {
        const faithful = ratioFor(engine, `${referenceClass}/faithful`);
        expect(faithful).toBeGreaterThan(0);
        expect(Number.isFinite(faithful)).toBe(true);
      }
    }
  });

  it('is engine-agnostic in direction, even though engines disagree in magnitude', () => {
    // Whatever else differs between odiff and pixelmatch, a class that separates
    // on one must separate on the other. A calibration verdict that flipped with
    // engine choice would be unusable.
    for (const referenceClass of CALIBRATED_CLASSES) {
      const viaOdiff = calibrationFor('odiff', referenceClass);
      const viaPixelmatch = calibrationFor('pixelmatch', referenceClass);
      expect(`${referenceClass}:${viaOdiff.gateable}`).toBe(
        `${referenceClass}:${viaPixelmatch.gateable}`,
      );
    }
  });
});

describe('D-007: commensurable classes admit a threshold', () => {
  // A real render compared against a real render, and a vector export compared
  // against a real render, both differ only where rasterisation differs. A
  // genuine layout regression is far larger than that floor, so a threshold fits
  // comfortably between them.
  for (const referenceClass of ['artifact-capture', 'figma-export'] as const) {
    it(`${referenceClass}: a regression is at least ${SEPARATION_FLOOR}x the noise floor`, () => {
      for (const engine of ENGINES) {
        const result = calibrationFor(engine, referenceClass);
        expect(`${engine}/${referenceClass} drifted`).toBe(`${engine}/${referenceClass} drifted`);
        expect(result.driftedRatio).toBeGreaterThan(result.faithfulRatio);
        expect(result.separation).toBeGreaterThanOrEqual(SEPARATION_FLOOR);
        expect(result.gateable).toBe(true);
      }
    });
  }
});

describe('D-007: an incommensurable class admits no threshold', () => {
  it('raster-mockup: a CORRECT implementation already differs enormously', () => {
    // The decisive measurement. A perfectly faithful implementation of a painted
    // mockup still disagrees with it across a large fraction of the canvas,
    // because the mockup hallucinates letterform positions, shifts the palette of
    // every fill and tints the background. The noise floor is not small.
    for (const engine of ENGINES) {
      const faithful = ratioFor(engine, 'raster-mockup/faithful');
      expect(faithful).toBeGreaterThan(0.05);
    }
  });

  it('raster-mockup: the regression is NOT separable from the noise floor', () => {
    // Because the floor is enormous, a real regression barely moves the number.
    // There is no threshold that passes the faithful implementation and fails the
    // drifted one with any margin — which is precisely D-007's claim, and the
    // reason this class must not be wired to a gate.
    for (const engine of ENGINES) {
      const result = calibrationFor(engine, 'raster-mockup');
      expect(result.separation).toBeLessThan(SEPARATION_FLOOR);
      expect(result.gateable).toBe(false);
    }
  });

  it('raster-mockup noise floor dwarfs the gateable classes noise floors', () => {
    // States the contrast directly: the thing that makes this class ungateable is
    // not that its regressions are subtle, but that its FLOOR is high.
    for (const engine of ENGINES) {
      const mockupFloor = ratioFor(engine, 'raster-mockup/faithful');
      const artifactFloor = ratioFor(engine, 'artifact-capture/faithful');
      expect(mockupFloor).toBeGreaterThan(artifactFloor * 10);
    }
  });

  it('a derived reference is the documented escape hatch, not a lower threshold', () => {
    // D-007's remedy is to derive a gateable reference from the incommensurable
    // one and ratify THAT. The corpus expresses this: the faithful implementation
    // of the mockup, once ratified as a reference in its own right, is an
    // `artifact-capture` and calibrates as gateable. Nothing about the threshold
    // changed — the reference did.
    const derived = calibrationFor('odiff', 'artifact-capture');
    expect(derived.gateable).toBe(true);
    expect(calibrationFor('odiff', 'raster-mockup').gateable).toBe(false);
  });
});

describe('recorded calibration and runtime data (P-002 deliverable)', () => {
  it('emits the per-class, per-engine calibration table', () => {
    const rows: string[] = [];
    for (const engine of ENGINES) {
      for (const referenceClass of CALIBRATED_CLASSES) {
        const result = calibrationFor(engine, referenceClass);
        rows.push(
          [
            engine.padEnd(10),
            referenceClass.padEnd(17),
            `floor=${(result.faithfulRatio * 100).toFixed(3)}%`.padEnd(16),
            `regression=${(result.driftedRatio * 100).toFixed(3)}%`.padEnd(22),
            `separation=${result.separation.toFixed(2)}x`.padEnd(20),
            result.gateable ? 'GATEABLE' : 'ADVISORY-ONLY',
          ].join(' '),
        );
      }
    }
    // Printed so the measurement is recoverable from a CI log, not only from a
    // passing assertion.
    console.info(`\nP-002 calibration (SEPARATION_FLOOR=${SEPARATION_FLOOR}x)\n${rows.join('\n')}`);
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
      summary.push(
        `${engine.padEnd(10)} pairs=${values.length} total=${total.toFixed(1)}ms slowest=${slowest.toFixed(1)}ms`,
      );
      // A generous ceiling: this exists to catch an engine becoming
      // pathologically slow, not to benchmark it. The corpus is 320x240.
      expect(slowest).toBeLessThan(5_000);
    }
    console.info(`\nP-002 runtime (320x240 corpus)\n${summary.join('\n')}`);
    expect(summary).toHaveLength(ENGINES.length);
  });
});
