/**
 * P-005: the production PNG header reader.
 *
 * The adapter refuses unequal dimensions BEFORE any engine call and takes its
 * denominator from the reference image itself, so everything downstream rests on
 * this parser being right. It cannot use `pngjs` (a devDependency), so the risk
 * is the obvious one for any hand-written binary parser: it agrees with itself
 * and disagrees with a real decoder.
 *
 * The central test here is therefore not a unit test of the parser's own logic
 * but a CROSS-VALIDATION: every committed corpus image is decoded by pngjs and
 * by this parser, and the two must agree. A regression in the header offsets
 * fails that comparison immediately, against images whose pixel content is
 * independently pinned by digest.
 */
import { describe, expect, it } from 'vitest';

import { CORPUS_IMAGES } from './corpus/cases';
import { decodePngDimensions, encodePng } from './corpus/synthesize';
import { PngHeaderError, readPngDimensions, readPngDimensionsSafe } from './png-header';

describe('readPngDimensions — cross-validated against a real decoder', () => {
  it('agrees with pngjs on every committed corpus image', () => {
    expect(CORPUS_IMAGES.length).toBeGreaterThan(0);
    for (const image of CORPUS_IMAGES) {
      const buffer = encodePng(image.render());
      const viaFullDecode = decodePngDimensions(buffer);
      const viaHeader = readPngDimensions(buffer);
      expect({ key: image.key, ...viaHeader }).toEqual({ key: image.key, ...viaFullDecode });
    }
  });

  it('reads the differing-size fixture as genuinely differing', () => {
    // The pair that exists precisely because both engines normalise it away.
    const reference = readPngDimensions(
      encodePng(CORPUS_IMAGES.find((i) => i.key === 'dimension/reference')!.render()),
    );
    const wider = readPngDimensions(
      encodePng(CORPUS_IMAGES.find((i) => i.key === 'dimension/wider-same-content')!.render()),
    );
    expect(reference).toEqual({ width: 320, height: 240 });
    expect(wider).toEqual({ width: 360, height: 240 });
    expect(wider.width).not.toBe(reference.width);
  });
});

describe('readPngDimensions — refusals', () => {
  const validPng = encodePng(CORPUS_IMAGES[0]!.render());

  it('refuses a buffer too short to contain an IHDR header', () => {
    expect(() => readPngDimensions(validPng.subarray(0, 20))).toThrow(PngHeaderError);
  });

  it('refuses bytes that are not a PNG', () => {
    const notPng = Buffer.alloc(64, 0x41);
    expect(() => readPngDimensions(notPng)).toThrow(/signature mismatch/);
  });

  it('refuses a PNG whose first chunk is not IHDR', () => {
    const tampered = Buffer.from(validPng);
    tampered.write('IDAT', 12, 'latin1');
    expect(() => readPngDimensions(tampered)).toThrow(/expected 'IHDR'/);
  });

  it('refuses a degenerate declared size rather than returning a zero denominator', () => {
    // A zero here would flow straight into `pixelDifference / pixelsTotal`.
    const tampered = Buffer.from(validPng);
    tampered.writeUInt32BE(0, 16);
    expect(() => readPngDimensions(tampered)).toThrow(/degenerate size/);
  });
});

describe('readPngDimensionsSafe', () => {
  it('reports rather than raises, so a probe seam can classify the failure', () => {
    const ok = readPngDimensionsSafe(encodePng(CORPUS_IMAGES[0]!.render()));
    expect(ok.ok).toBe(true);

    const bad = readPngDimensionsSafe(Buffer.alloc(4));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.detail).toMatch(/need at least 24/);
  });
});
