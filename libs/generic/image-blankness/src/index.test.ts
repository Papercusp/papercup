import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BLANKNESS_THRESHOLDS,
  analyzeImageBlankness,
  configureImageBlankness,
  decodePng,
  resetImageBlanknessConfig,
} from './index.js';
import { PNG_SIGNATURE as SIGNATURE, contentPng, encodePng, rgbSamples as rgbImage } from './testing.js';

/**
 * A stand-in for real UI: a dark panel carrying rows of high-contrast "glyph" runs.
 * Sparse as screenshots go — a frame that passes here passes comfortably for anything
 * busier.
 */
function fakeUiScreenshot(width: number, height: number): Uint8Array {
  const decoded = decodePng(contentPng(width, height));
  if (!decoded) throw new Error('fixture failed to encode');
  return decoded.rgb;
}

afterEach(() => resetImageBlanknessConfig());

describe('analyzeImageBlankness', () => {
  it('calls a flat single-colour capture blank', () => {
    const png = encodePng(320, 240, rgbImage(320, 240, () => [17, 17, 22]));
    const report = analyzeImageBlankness(png);
    expect(report.verdict).toBe('blank');
    expect(report.distinctColors).toBe(1);
    expect(report.detailFraction).toBe(0);
    expect(report.reason).toContain('did not paint');
  });

  it('calls a smooth gradient blank — the case a distinct-colour test would miss', () => {
    // The observed failure mode: "a dark background gradient, no app chrome, nothing".
    const png = encodePng(320, 240, rgbImage(320, 240, (_x, y) => [y % 256, y % 256, (y + 8) % 256]));
    const report = analyzeImageBlankness(png);
    expect(report.verdict).toBe('blank');
    // Many distinct colours, yet no rendered content — this is why detail is the metric.
    expect(report.distinctColors).toBeGreaterThan(16);
    expect(report.reason).toContain('gradient');
  });

  it('calls a rendered UI frame has-content', () => {
    const report = analyzeImageBlankness(encodePng(320, 240, fakeUiScreenshot(320, 240)));
    expect(report.verdict).toBe('has-content');
    expect(report.peakRowDetail).toBeGreaterThan(DEFAULT_BLANKNESS_THRESHOLDS.minPeakRowDetail);
  });

  it('finds content that occupies only a narrow band of an otherwise empty frame', () => {
    // The case a whole-frame average gets wrong, and the reason the verdict is per-row:
    // a real capture of an app that painted nothing but a title strip. It composited,
    // so it is evidence — 99% emptiness must not make it read as a dead grab.
    const width = 1280;
    const height = 800;
    const pixels = rgbImage(width, height, (x, y) => (y === 3 && x % 5 < 2 ? [20, 20, 25] : [250, 250, 250]));
    const report = analyzeImageBlankness(encodePng(width, height, pixels));

    expect(report.verdict).toBe('has-content');
    expect(report.peakRowIndex).toBe(3);
    // The decisive bit: spread over the whole frame this content averages out BELOW the
    // floor. Judged per row it is 40% edges. A global average would have called a real
    // capture dead and rejected a legitimate close.
    expect(report.detailFraction).toBeLessThan(DEFAULT_BLANKNESS_THRESHOLDS.minPeakRowDetail);
    expect(report.peakRowDetail).toBeGreaterThan(0.3);
  });

  it('treats a fully transparent RGBA capture as blank (composited over black)', () => {
    const width = 200;
    const height = 200;
    const samples = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      samples[i * 4] = (i * 7) % 256; // non-uniform colour...
      samples[i * 4 + 1] = (i * 13) % 256;
      samples[i * 4 + 2] = (i * 29) % 256;
      samples[i * 4 + 3] = 0; // ...but nothing is actually visible
    }
    const report = analyzeImageBlankness(encodePng(width, height, samples, { colorType: 6 }));
    expect(report.verdict).toBe('blank');
  });

  it('reads greyscale and palette captures', () => {
    const grey = new Uint8Array(200 * 200).fill(40);
    expect(analyzeImageBlankness(encodePng(200, 200, grey, { colorType: 0 })).verdict).toBe('blank');

    // An optimiser turns a blank grab into a tiny indexed PNG — the detector must
    // still read it, or it goes blind to its own primary case.
    const indexed = new Uint8Array(200 * 200).fill(1);
    const palettePng = encodePng(200, 200, indexed, {
      colorType: 3,
      palette: [
        [0, 0, 0],
        [30, 30, 36],
      ],
    });
    expect(analyzeImageBlankness(palettePng).verdict).toBe('blank');
  });

  it('reverses the Up scanline filter', () => {
    const pixels = fakeUiScreenshot(320, 240);
    const filtered = analyzeImageBlankness(encodePng(320, 240, pixels, { filter: 2 }));
    const unfiltered = analyzeImageBlankness(encodePng(320, 240, pixels, { filter: 0 }));
    expect(filtered.verdict).toBe('has-content');
    expect(filtered.detailFraction).toBeCloseTo(unfiltered.detailFraction ?? 0, 10);
  });

  it('round-trips pixel values through the decoder', () => {
    const png = encodePng(4, 2, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]));
    const decoded = decodePng(png);
    expect(decoded?.width).toBe(4);
    expect(decoded?.height).toBe(2);
    expect(Array.from(decoded?.rgb ?? [])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  });
});

describe('abstaining rather than guessing', () => {
  it('never reports blank for bytes it cannot decode', () => {
    expect(analyzeImageBlankness(new Uint8Array(0)).verdict).toBe('undecodable');
    expect(analyzeImageBlankness(Uint8Array.from(Buffer.from('not an image at all'))).verdict).toBe('undecodable');
    // A JPEG header — a real image, just not one this detector reads.
    expect(analyzeImageBlankness(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a]))).toMatchObject({
      verdict: 'undecodable',
    });
    // Valid signature, truncated body.
    expect(analyzeImageBlankness(Uint8Array.from(SIGNATURE)).verdict).toBe('undecodable');
  });

  it('reports a too-small crop inconclusive rather than blank', () => {
    const tiny = encodePng(32, 32, rgbImage(32, 32, () => [10, 10, 10]));
    const report = analyzeImageBlankness(tiny);
    expect(report.verdict).toBe('inconclusive');
    expect(report.reason).toContain('below the');
  });

  it('refuses an interlaced PNG instead of half-decoding it', () => {
    const png = Buffer.from(encodePng(200, 200, rgbImage(200, 200, () => [9, 9, 9])));
    // IHDR data begins 8 (signature) + 8 (length+type) bytes in; interlace is its 13th byte.
    png[8 + 8 + 12] = 1;
    expect(analyzeImageBlankness(Uint8Array.from(png)).verdict).toBe('undecodable');
  });
});

describe('configureImageBlankness', () => {
  it('applies overrides process-wide and per call', () => {
    const uiPng = encodePng(320, 240, fakeUiScreenshot(320, 240));
    expect(analyzeImageBlankness(uiPng).verdict).toBe('has-content');

    // An absurd floor makes even a busy frame read blank — proof the knob is live.
    configureImageBlankness({ minPeakRowDetail: 0.99 });
    expect(analyzeImageBlankness(uiPng).verdict).toBe('blank');

    // A per-call override wins over the configured value.
    expect(analyzeImageBlankness(uiPng, { minPeakRowDetail: 0.001 }).verdict).toBe('has-content');

    resetImageBlanknessConfig();
    expect(analyzeImageBlankness(uiPng).verdict).toBe('has-content');
  });
});

/**
 * Sub-byte GRAYSCALE PNGs (colour type 0, bit depth 1/2/4).
 *
 * Why this matters and is not exotic-format housekeeping: ImageMagick's `import ... png:-`
 * — the command Papercusp's screen-capture path runs — chooses its encoding by CONTENT. A
 * uniform frame comes back as 1-bit grayscale; the moment anything paints, it becomes 8-bit
 * truecolour. Measured on a 1024x768 X display (2026-08-23):
 *
 *   blank grab   → color_type 0, bit_depth 1,   233 bytes,   1 colour
 *   painted grab → color_type 2, bit_depth 8, 9,461 bytes, 376 colours
 *
 * So the BLANK capture is precisely the one that arrives sub-byte, and this decoder used to
 * reject it as `undecodable`. Because `undecodable` deliberately resolves AWAY from `blank`,
 * the guard failed open on exactly the input it exists to catch: a genuinely blank
 * screenshot was accepted as evidence that a UI had been seen. Both directions are pinned
 * below — that it now reads blank frames as blank, AND that it does not start calling
 * detailed bilevel frames blank instead.
 */
describe('sub-byte grayscale (what a blank screen capture actually is)', () => {
  /** One entry per pixel; `encodePng` packs them to the requested bit depth. */
  const graySamples = (w: number, h: number, at: (x: number, y: number) => number): Uint8Array => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) out[y * w + x] = at(x, y);
    return out;
  };

  it('decodes a 1-bit grayscale frame instead of calling it undecodable', () => {
    const png = encodePng(128, 64, graySamples(128, 64, () => 0), { colorType: 0, bitDepth: 1 });
    const report = analyzeImageBlankness(png);
    expect(report.verdict).not.toBe('undecodable');
    expect(report.width).toBe(128);
    expect(report.height).toBe(64);
  });

  it('judges an all-zero 1-bit frame BLANK — the failure mode this closes', () => {
    const png = encodePng(128, 64, graySamples(128, 64, () => 0), { colorType: 0, bitDepth: 1 });
    expect(analyzeImageBlankness(png).verdict).toBe('blank');
  });

  it('judges a 1-bit frame with real structure as content, NOT a false blank', () => {
    // The control for the SCALING half of the fix. A 1-bit sample is 0 or 1; unscaled, two
    // adjacent pixels differ by a luma of 1 — under the edge threshold — so a bilevel frame
    // FULL of edges would be reported blank. That is a false `blank`, the only verdict
    // callers act on by rejecting evidence, so it is the expensive direction to be wrong in.
    const png = encodePng(128, 64, graySamples(128, 64, (x) => x % 2), { colorType: 0, bitDepth: 1 });
    expect(analyzeImageBlankness(png).verdict).toBe('has-content');
  });

  it('scales sub-byte samples to full range so 1-bit white reads as white', () => {
    const png = encodePng(128, 64, graySamples(128, 64, () => 1), { colorType: 0, bitDepth: 1 });
    const decoded = decodePng(png);
    expect(decoded).not.toBeNull();
    // Unscaled this would be 1 — indistinguishable from black. Scaled, it is 255.
    expect(decoded?.rgb[0]).toBe(255);
  });

  it('handles 2-bit and 4-bit grayscale too, at both ends of the range', () => {
    for (const [bitDepth, max] of [
      [2, 3],
      [4, 15],
    ] as const) {
      const dark = encodePng(64, 64, graySamples(64, 64, () => 0), { colorType: 0, bitDepth });
      const light = encodePng(64, 64, graySamples(64, 64, () => max), { colorType: 0, bitDepth });
      expect(decodePng(dark)?.rgb[0], `depth ${bitDepth} min`).toBe(0);
      expect(decodePng(light)?.rgb[0], `depth ${bitDepth} max`).toBe(255);
      expect(analyzeImageBlankness(dark).verdict, `depth ${bitDepth} uniform`).toBe('blank');
    }
  });

  it('still refuses bit depths the PNG spec does not allow for a colour type', () => {
    // Truecolour has no legal 1-bit form. Widening grayscale must not have widened this.
    const bogus = encodePng(64, 64, new Uint8Array(64 * 64 * 3), { colorType: 2, bitDepth: 1 });
    expect(decodePng(bogus)).toBeNull();
  });
});
