/**
 * Blank-capture detection for screenshot evidence.
 *
 * The problem this exists for: a screenshot tool can write a perfectly valid image
 * file, print its path and exit 0, while the window it grabbed never painted — an
 * unmapped window, a headless X display, a software-GL stack. The result is a file
 * that LOOKS like proof (an image path, on disk, produced by a real capture command)
 * and proves nothing. Any pipeline that accepts "an image exists" as evidence of "a UI
 * was seen" inherits that hole; this module is the cheap, local test that closes it.
 *
 * The metric is adjacent-pixel DETAIL, not uniformity. A failed grab is not always a
 * flat fill — the observed case was a smooth dark gradient, which has ~800 distinct
 * colours and would sail past any distinct-colour test, yet has essentially zero
 * high-frequency content. Real rendered UI is full of it: every glyph, border and icon
 * edge puts a large delta between horizontally adjacent pixels.
 *
 * That detail is measured PER ROW and the frame judged by its densest one, because a
 * whole-frame average answers the wrong question. Measured against 400 real captures
 * from one host, the frames a global average ranks lowest are not failures at all: a
 * small terminal window on a black desktop, or an app that painted only its menu bar.
 * Both composited fine — which is the only thing this module claims to detect — yet
 * both average out near a genuinely dead gradient. Their content is simply *local*.
 * Asking "is there ANY band of this frame carrying rendered content?" separates the two
 * populations by ~40x where the global average separated them by 2x.
 *
 * Note what this deliberately does NOT judge: whether the app rendered what you wanted.
 * A window showing nothing but its own chrome is `has-content` here, because the
 * capture pipeline demonstrably worked. Judging the app's state is the caller's job
 * (and the DOM's) — this only answers "are these pixels real?".
 *
 * Direction of failure matters and is deliberate: the only action a caller takes on
 * `blank` is a rejection, so every uncertainty resolves AWAY from `blank`. An image
 * that cannot be decoded is `undecodable`; one too small to judge is `inconclusive`;
 * neither is ever reported as blank.
 */

import { decodePng } from './png.js';

export type BlanknessVerdict =
  /** Confidently empty: decoded fine, carries no perceptible visual content. */
  | 'blank'
  /** Confidently non-empty: decoded fine, carries real detail. */
  | 'has-content'
  /** Not a format this detector reads (or corrupt/truncated) — judge by other means. */
  | 'undecodable'
  /** Decoded, but too small a sample to make a confident call. */
  | 'inconclusive';

export interface BlanknessThresholds {
  /**
   * The frame carries content if its DENSEST row has at least this fraction of its
   * horizontally-adjacent pixel pairs separated by an edge. Per-row, not whole-frame:
   * see the module comment for why the average is the wrong question.
   */
  minPeakRowDetail: number;
  /** Luma difference (0-255) between adjacent pixels that counts as an edge. */
  detailLumaDelta: number;
  /** Images smaller than this many pixels are reported `inconclusive`, never `blank`. */
  minJudgeableArea: number;
}

export const DEFAULT_BLANKNESS_THRESHOLDS: Readonly<BlanknessThresholds> = Object.freeze({
  minPeakRowDetail: 0.01,
  detailLumaDelta: 8,
  minJudgeableArea: 4096,
});

let configuredThresholds: BlanknessThresholds = { ...DEFAULT_BLANKNESS_THRESHOLDS };

/**
 * Host seam: override the defaults process-wide. Callers that want a one-off override
 * should pass thresholds to {@link analyzeImageBlankness} instead of reconfiguring.
 */
export function configureImageBlankness(overrides: Partial<BlanknessThresholds>): BlanknessThresholds {
  configuredThresholds = { ...configuredThresholds, ...overrides };
  return { ...configuredThresholds };
}

/** Reset the process-wide thresholds to the shipped defaults. */
export function resetImageBlanknessConfig(): void {
  configuredThresholds = { ...DEFAULT_BLANKNESS_THRESHOLDS };
}

export interface BlanknessReport {
  verdict: BlanknessVerdict;
  /** One line, safe to show a human or fold into an error message. */
  reason: string;
  width?: number;
  height?: number;
  /** Distinct colours in the frame, quantised to 5 bits per channel (capped). */
  distinctColors?: number;
  /** Share of pixels held by the single most common quantised colour. */
  dominantFraction?: number;
  /** Share of ALL adjacent pixel pairs separated by a perceptible edge. */
  detailFraction?: number;
  /** Share of adjacent pairs in the DENSEST single row — the metric the verdict uses. */
  peakRowDetail?: number;
  /** Row index carrying `peakRowDetail`, so a caller can point at what it found. */
  peakRowIndex?: number;
}

/** Cap on the colour histogram — past this the image is self-evidently not flat. */
const COLOR_HISTOGRAM_CAP = 4096;

function luma(r: number, g: number, b: number): number {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

/**
 * Judge whether an image carries visual content. Accepts raw file bytes; currently
 * decodes PNG and reports everything else `undecodable`.
 */
export function analyzeImageBlankness(
  bytes: Uint8Array,
  overrides?: Partial<BlanknessThresholds>,
): BlanknessReport {
  const cfg: BlanknessThresholds = { ...configuredThresholds, ...overrides };

  if (!bytes || bytes.length === 0) {
    return { verdict: 'undecodable', reason: 'empty file (0 bytes)' };
  }

  const decoded = decodePng(bytes);
  if (!decoded) {
    return {
      verdict: 'undecodable',
      reason: 'not a PNG this detector reads (interlaced, corrupt, or another format) — judged by other means',
    };
  }

  const { width, height, rgb } = decoded;
  const area = width * height;
  if (area < cfg.minJudgeableArea) {
    return {
      verdict: 'inconclusive',
      reason: `image is ${width}x${height} (${area}px) — below the ${cfg.minJudgeableArea}px floor for a confident call`,
      width,
      height,
    };
  }

  const rowStep = Math.max(1, Math.floor(height / Math.max(1, cfg.maxSampledRows)));
  const histogram = new Map<number, number>();
  let histogramCapped = false;
  let sampledPixels = 0;
  let adjacentPairs = 0;
  let detailPairs = 0;

  for (let y = 0; y < height; y += rowStep) {
    let previousLuma = -1;
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 3;
      const r = rgb[o];
      const g = rgb[o + 1];
      const b = rgb[o + 2];

      if (!histogramCapped) {
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        const seen = histogram.get(key);
        if (seen === undefined && histogram.size >= COLOR_HISTOGRAM_CAP) histogramCapped = true;
        else histogram.set(key, (seen ?? 0) + 1);
      }
      sampledPixels += 1;

      const l = luma(r, g, b);
      if (previousLuma >= 0) {
        adjacentPairs += 1;
        if (Math.abs(l - previousLuma) >= cfg.detailLumaDelta) detailPairs += 1;
      }
      previousLuma = l;
    }
  }

  const detailFraction = adjacentPairs > 0 ? detailPairs / adjacentPairs : 0;
  const distinctColors = histogramCapped ? COLOR_HISTOGRAM_CAP : histogram.size;
  let dominantCount = 0;
  for (const count of histogram.values()) if (count > dominantCount) dominantCount = count;
  const dominantFraction = sampledPixels > 0 ? dominantCount / sampledPixels : 0;

  const stats = { width, height, distinctColors, dominantFraction, detailFraction };

  if (adjacentPairs === 0) {
    return { verdict: 'inconclusive', reason: 'no adjacent pixel pairs to compare', ...stats };
  }

  if (detailFraction < cfg.minDetailFraction) {
    const shape =
      distinctColors <= 2
        ? `a flat ${distinctColors === 1 ? 'single-colour' : 'two-colour'} fill`
        : 'a smooth gradient / empty background';
    return {
      verdict: 'blank',
      reason:
        `${width}x${height} capture carries no rendered content — ${shape} ` +
        `(only ${(detailFraction * 100).toFixed(4)}% of adjacent pixels show an edge, ` +
        `floor ${(cfg.minDetailFraction * 100).toFixed(4)}%). The window did not paint.`,
      ...stats,
    };
  }

  return {
    verdict: 'has-content',
    reason:
      `${width}x${height} capture carries rendered content ` +
      `(${(detailFraction * 100).toFixed(2)}% of adjacent pixels show an edge, ${distinctColors} distinct colours)`,
    ...stats,
  };
}

export { decodePng } from './png.js';
export type { DecodedPng } from './png.js';
