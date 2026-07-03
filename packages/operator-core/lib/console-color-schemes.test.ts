/**
 * Coverage for console-color-schemes — the curated catalog bound permanently to
 * each fleet. Guards the two things that matter: the catalog is well-formed +
 * legible (valid hex, distinct, enough fg/bg contrast), and the allocation /
 * lookup helpers behave (next-unused, deterministic fallback, stable names).
 */
import { describe, expect, it } from 'vitest';
import {
  COLOR_SCHEMES,
  COLOR_SQUARES,
  DEFAULT_SCHEME,
  allocateNextSchemeName,
  hexToHsv,
  nearestColorSquareEmoji,
  oscRecolorSequence,
  oscResetSequence,
  schemeByName,
  schemeForSlug,
  type ColorScheme,
} from './console-color-schemes';

const HEX = /^#[0-9a-f]{6}$/;

/** WCAG relative luminance of an #rrggbb color. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const chan = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * chan[0]! + 0.7152 * chan[1]! + 0.0722 * chan[2]!;
}

/** WCAG contrast ratio between two colors (>= 1). */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe('oscRecolorSequence', () => {
  const scheme: ColorScheme = { name: 'demo', bg: '#581c87', fg: '#f5e8ff', cursor: '#d8b4fe' };

  it('emits OSC 10 (fg), 11 (bg), 12 (cursor), each BEL-terminated', () => {
    expect(oscRecolorSequence(scheme)).toBe(
      '\x1b]10;#f5e8ff\x07\x1b]11;#581c87\x07\x1b]12;#d8b4fe\x07',
    );
  });

  it('orders fg → bg → cursor (the bg paint lands before the cursor)', () => {
    const s = oscRecolorSequence(scheme);
    expect(s.indexOf(']10;')).toBeLessThan(s.indexOf(']11;'));
    expect(s.indexOf(']11;')).toBeLessThan(s.indexOf(']12;'));
  });

  it('every catalog scheme yields exactly three well-formed OSC triples', () => {
    for (const sc of COLOR_SCHEMES) {
      const seq = oscRecolorSequence(sc);
      expect(seq).toContain(`\x1b]10;${sc.fg}\x07`);
      expect(seq).toContain(`\x1b]11;${sc.bg}\x07`);
      expect(seq).toContain(`\x1b]12;${sc.cursor}\x07`);
      // one BEL per OSC, no stray control bytes
      expect((seq.match(/\x07/g) ?? []).length).toBe(3);
    }
  });
});

describe('oscResetSequence', () => {
  it('resets fg (OSC 110), bg (111), cursor (112) to the terminal default', () => {
    expect(oscResetSequence()).toBe('\x1b]110\x07\x1b]111\x07\x1b]112\x07');
  });
  it('carries no color values (pure reset) and exactly three BELs', () => {
    const s = oscResetSequence();
    expect(s).not.toContain('#');
    expect((s.match(/\x07/g) ?? []).length).toBe(3);
  });
});

describe('COLOR_SCHEMES catalog', () => {
  it('has a healthy number of schemes', () => {
    expect(COLOR_SCHEMES.length).toBeGreaterThanOrEqual(24);
  });

  it('every field is valid lowercase #rrggbb hex', () => {
    for (const s of COLOR_SCHEMES) {
      expect(s.bg, s.name).toMatch(HEX);
      expect(s.fg, s.name).toMatch(HEX);
      expect(s.cursor, s.name).toMatch(HEX);
    }
  });

  it('names are unique (renaming one would orphan its bound fleets)', () => {
    const names = COLOR_SCHEMES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('backgrounds are unique (fleets must look distinct)', () => {
    const bgs = COLOR_SCHEMES.map((s) => s.bg);
    expect(new Set(bgs).size).toBe(bgs.length);
  });

  it('every scheme keeps fg/bg contrast >= 4.5 (bright ANSI must stay legible)', () => {
    for (const s of COLOR_SCHEMES) {
      expect(contrast(s.fg, s.bg), `${s.name} fg/bg`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('backgrounds are dark (so bright ANSI colors read on top)', () => {
    for (const s of COLOR_SCHEMES) {
      expect(luminance(s.bg), `${s.name} bg luminance`).toBeLessThan(0.18);
    }
  });

  it('DEFAULT_SCHEME is a catalog member', () => {
    expect(COLOR_SCHEMES).toContainEqual(DEFAULT_SCHEME);
  });
});

describe('schemeByName', () => {
  it('round-trips every catalog name', () => {
    for (const s of COLOR_SCHEMES) expect(schemeByName(s.name)).toEqual(s);
  });
  it('returns undefined for unknown / empty', () => {
    expect(schemeByName('no-such-scheme')).toBeUndefined();
    expect(schemeByName(null)).toBeUndefined();
    expect(schemeByName(undefined)).toBeUndefined();
    expect(schemeByName('')).toBeUndefined();
  });
});

describe('schemeForSlug (deterministic fallback)', () => {
  it('is stable for the same slug', () => {
    expect(schemeForSlug('alpha-fleet')).toEqual(schemeForSlug('alpha-fleet'));
  });
  it('always returns a catalog member', () => {
    for (const slug of ['a', 'fleet-one', 'dummy-fleet-gcd-lcm-2026-06-30', '']) {
      expect(COLOR_SCHEMES).toContainEqual(schemeForSlug(slug));
    }
  });
});

describe('hexToHsv', () => {
  it('converts primaries to their canonical hue (s=v=1)', () => {
    expect(hexToHsv('#ff0000')).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv('#00ff00')).toEqual({ h: 120, s: 1, v: 1 });
    expect(hexToHsv('#0000ff')).toEqual({ h: 240, s: 1, v: 1 });
  });
  it('reads grayscale as zero saturation, value = lightness', () => {
    expect(hexToHsv('#000000')).toEqual({ h: 0, s: 0, v: 0 });
    expect(hexToHsv('#808080').s).toBe(0);
    expect(hexToHsv('#ffffff')).toEqual({ h: 0, s: 0, v: 1 });
  });
  it('accepts a missing #, 3-digit shorthand, and falls back to black on garbage', () => {
    expect(hexToHsv('ff0000')).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv('#f00')).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv('not-a-color')).toEqual({ h: 0, s: 0, v: 0 });
  });
});

describe('nearestColorSquareEmoji', () => {
  it('snaps pure hues to their family square (cyan→blue, magenta→purple)', () => {
    expect(nearestColorSquareEmoji('#ff0000')).toBe('🟥');
    expect(nearestColorSquareEmoji('#ff8000')).toBe('🟧');
    expect(nearestColorSquareEmoji('#ffff00')).toBe('🟨');
    expect(nearestColorSquareEmoji('#00ff00')).toBe('🟩');
    expect(nearestColorSquareEmoji('#00ffff')).toBe('🟦'); // cyan → blue (no cyan square)
    expect(nearestColorSquareEmoji('#0000ff')).toBe('🟦');
    expect(nearestColorSquareEmoji('#8a2be2')).toBe('🟪');
    expect(nearestColorSquareEmoji('#ff00ff')).toBe('🟪'); // magenta → purple
  });
  it('maps near-grayscale to a neutral square by lightness', () => {
    expect(nearestColorSquareEmoji('#111111')).toBe('⬛');
    expect(nearestColorSquareEmoji('#eeeeee')).toBe('⬜');
  });
  it('reads a dark warm color as brown, a bright one as orange/yellow', () => {
    expect(nearestColorSquareEmoji('#3a2c08')).toBe('🟫'); // antique-gold bg (dark amber)
    expect(nearestColorSquareEmoji('#78350f')).toBe('🟧'); // burnt-amber bg (brighter)
  });
  it('maps representative catalog backgrounds to the expected family', () => {
    const bg = (name: string) => schemeByName(name)!.bg;
    expect(nearestColorSquareEmoji(bg('royal-purple'))).toBe('🟪');
    expect(nearestColorSquareEmoji(bg('forest'))).toBe('🟩');
    expect(nearestColorSquareEmoji(bg('oxblood'))).toBe('🟥');
    expect(nearestColorSquareEmoji(bg('midnight-slate'))).toBe('🟦');
    expect(nearestColorSquareEmoji(bg('graphite'))).toBe('⬛');
  });
  it('every catalog scheme bg resolves to a valid palette square', () => {
    for (const s of COLOR_SCHEMES) {
      expect(COLOR_SQUARES as readonly string[], s.name).toContain(nearestColorSquareEmoji(s.bg));
    }
  });
});

describe('allocateNextSchemeName', () => {
  it('hands out the first scheme when nothing is in use', () => {
    expect(allocateNextSchemeName([])).toBe(COLOR_SCHEMES[0]!.name);
  });
  it('skips schemes already in use (preserving catalog order)', () => {
    const used = [COLOR_SCHEMES[0]!.name, COLOR_SCHEMES[1]!.name];
    expect(allocateNextSchemeName(used)).toBe(COLOR_SCHEMES[2]!.name);
  });
  it('assigns every catalog scheme exactly once across N fleets (no early collision)', () => {
    const used: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < COLOR_SCHEMES.length; i++) {
      const next = allocateNextSchemeName(used);
      expect(seen.has(next), `collision at ${i}`).toBe(false);
      seen.add(next);
      used.push(next);
    }
    expect(seen.size).toBe(COLOR_SCHEMES.length);
  });
  it('wraps deterministically once the catalog is exhausted', () => {
    const all = COLOR_SCHEMES.map((s) => s.name);
    const next = allocateNextSchemeName(all);
    expect(COLOR_SCHEMES.map((s) => s.name)).toContain(next);
  });
});
