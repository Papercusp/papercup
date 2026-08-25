/**
 * The shape of the calibration artifact a threshold policy is derived from.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-008).
 *
 * This file holds types only, and exists so `report-cli.ts` (which MEASURES the
 * artifact) and `policy.ts` (which DERIVES thresholds from it) can agree on the
 * shape without importing each other. The measuring side must never import the
 * deriving side: a calibration that could read the threshold it sets would be
 * circular, and the cheapest way to make that impossible is for the dependency
 * edge not to exist.
 */
import type { CaptureEnvironment, ReferenceClass } from './contract';

/** Bump when a field's meaning changes such that an older artifact cannot be read. */
export const CALIBRATION_SCHEMA_VERSION = 1 as const;

/** One measured comparison. */
export interface CalibrationSample {
  readonly caseId: string;
  readonly diffRatio: number;
  readonly pixelsTotal: number;
  readonly comparisonMs: number;
}

export interface RuntimeStats {
  readonly n: number;
  readonly p50Ms: number | null;
  readonly maxMs: number | null;
}

export interface ClassCalibration {
  readonly referenceClass: ReferenceClass;
  /** Which legs of the cohort contributed to this class. */
  readonly cohorts: readonly string[];
  /**
   * Capture-to-capture variance of an UNCHANGED surface. The maximum is what
   * matters: a threshold below the worst observed noise fails correct work.
   */
  readonly noise: {
    readonly n: number;
    readonly maxDiffRatio: number | null;
    readonly samples: readonly CalibrationSample[];
  };
  /**
   * Difference between two genuinely different renders. The minimum is what
   * matters: a threshold above the smallest observed real difference passes a
   * regression.
   */
  readonly regression: {
    readonly n: number;
    readonly minDiffRatio: number | null;
    readonly samples: readonly CalibrationSample[];
  };
  readonly captureRuntime: RuntimeStats;
  readonly comparisonRuntime: RuntimeStats;
  /**
   * The smallest image the class was measured on. One differing pixel in this
   * image is the finest distinction the measurement could have made, and is
   * what the derivation uses instead of treating an observed zero as a true
   * zero.
   */
  readonly smallestPixelsTotal: number | null;
}

export interface CalibrationArtifact {
  readonly schemaVersion: typeof CALIBRATION_SCHEMA_VERSION;
  readonly policyVersion: string;
  readonly generatedAt: string;
  readonly engine: { readonly engine: string; readonly engineVersion: string };
  readonly environment: CaptureEnvironment;
  readonly realSurface: {
    readonly source: string;
    readonly storiesCaptured: number;
    readonly refusals: readonly string[];
  };
  readonly classes: readonly ClassCalibration[];
  /** Scope limits a reader must see next to the numbers, not in a commit message. */
  readonly caveats: readonly string[];
}
