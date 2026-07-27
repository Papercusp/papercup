import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BLANKNESS_THRESHOLDS,
  analyzeImageBlankness,
  configureImageBlankness,
  decodePng,
  resetImageBlanknessConfig,
} from './index.js';

// ── minimal PNG encoder, so every fixture below is a real file a viewer could open ──

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface EncodeOptions {
  /** PNG colour type: 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. */
  colorType?: number;
  bitDepth?: number;
  palette?: number[][];
  /** Per-scanline filter byte; the decoder must reverse whichever we pick. */
  filter?: number;
}

/** Encode raw samples (already in the layout the colour type expects) as a PNG. */
function encodePng(width: number, height: number, samples: Uint8Array, opts: EncodeOptions = {}): Uint8Array {
  const colorType = opts.colorType ?? 2;
  const bitDepth = opts.bitDepth ?? 8;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] ?? 3;
  const stride = width * channels;
  const filter = opts.filter ?? 0;

  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i += 1) {
      const value = samples[y * stride + i];
      if (filter === 2) {
        // "Up": store the delta against the row above, as a real encoder would.
        const above = y === 0 ? 0 : samples[(y - 1) * stride + i];
        raw[y * (stride + 1) + 1 + i] = (value - above) & 0xff;
      } else {
        raw[y * (stride + 1) + 1 + i] = value;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts: Buffer[] = [SIGNATURE, chunk('IHDR', ihdr)];
  if (colorType === 3) {
    const entries = opts.palette ?? [[0, 0, 0]];
    parts.push(chunk('PLTE', Uint8Array.from(entries.flat())));
  }
  parts.push(chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0)));
  return Uint8Array.from(Buffer.concat(parts));
}

function rgbImage(width: number, height: number, at: (x: number, y: number) => [number, number, number]): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = at(x, y);
      const o = (y * width + x) * 3;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    }
  }
  return out;
}

/**
 * A stand-in for real UI: a dark panel carrying rows of high-contrast "glyph" runs.
 * Only ~4% of its pixels sit on an edge — far less than a text-dense screenshot, so a
 * frame that passes here passes comfortably for anything busier.
 */
function fakeUiScreenshot(width: number, height: number): Uint8Array {
  return rgbImage(width, height, (x, y) => {
    const onTextRow = y % 24 >= 8 && y % 24 < 16;
    const inGlyph = onTextRow && x > 40 && x < width - 40 && x % 7 < 3;
    return inGlyph ? [235, 235, 240] : [24, 26, 32];
  });
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
