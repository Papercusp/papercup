import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../../..');

type DtcgToken = { $value: string };
type DtcgTheme = Record<string, DtcgToken>;
type Rgba = Readonly<{ r: number; g: number; b: number; a: number }>;

function themeTokens(file: string): DtcgTheme {
  const parsed = JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')) as Record<string, unknown>;
  const key = Object.keys(parsed).find((candidate) => !candidate.startsWith('_'));
  if (!key) throw new Error(`${file} has no DTCG theme group`);
  return parsed[key] as DtcgTheme;
}

function cssColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    return {
      r: Number.parseInt(hex[1].slice(0, 2), 16) / 255,
      g: Number.parseInt(hex[1].slice(2, 4), 16) / 255,
      b: Number.parseInt(hex[1].slice(4, 6), 16) / 255,
      a: 1,
    };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(value.trim());
  if (rgba) {
    return {
      r: Number(rgba[1]) / 255,
      g: Number(rgba[2]) / 255,
      b: Number(rgba[3]) / 255,
      a: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  if (value.trim() === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  throw new Error(`unsupported CSS color ${value}`);
}

/** CSS source-over compositing. Both operands stay in rendered-pixel space;
 * an alpha surface is never guessed to sit on white. */
function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
    g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
    b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
    a,
  };
}

/** CSS gradients interpolate premultiplied channels, which matters when a
 * stop fades to transparent. Interpolating raw RGB would leave a dark halo. */
function gradientPixel(from: Rgba, to: Rgba, progress: number): Rgba {
  const t = Math.max(0, Math.min(1, progress));
  const a = from.a * (1 - t) + to.a * t;
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (from.r * from.a * (1 - t) + to.r * to.a * t) / a,
    g: (from.g * from.a * (1 - t) + to.g * to.a * t) / a,
    b: (from.b * from.a * (1 - t) + to.b * to.a * t) / a,
    a,
  };
}

function alpha(color: Rgba, opacity: number): Rgba {
  return { ...color, a: color.a * opacity };
}

function luminance(color: Rgba): number {
  if (color.a < 0.999) throw new Error('contrast requires a fully composited pixel');
  const linear = [color.r, color.g, color.b].map((value) => {
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground: Rgba, background: Rgba): number {
  const renderedForeground = foreground.a < 1 ? over(foreground, background) : foreground;
  const first = luminance(renderedForeground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function token(theme: DtcgTheme, name: string): Rgba {
  return cssColor(theme[name].$value);
}

/** Samples the actual two-layer AdvShell paint: an opaque vertical semantic
 * gradient plus the translucent accent radial washed over it. */
function shellPixels(theme: DtcgTheme, steps = 17): Rgba[] {
  const pixels: Rgba[] = [];
  const page = token(theme, 'bg');
  const deepest = token(theme, 'bg-deepest');
  const accent = token(theme, 'accent');
  for (let y = 0; y < steps; y++) {
    for (let x = 0; x < steps; x++) {
      const vertical = gradientPixel(page, deepest, y / (steps - 1));
      const distance = Math.min(1, Math.hypot(x, y) / ((steps - 1) * 0.42));
      const radial = gradientPixel(alpha(accent, 0.09), cssColor('transparent'), distance);
      pixels.push(over(radial, vertical));
    }
  }
  return pixels;
}

/** Samples OverviewTile's translucent bg-2 layer and accent-to-transparent
 * radial over every shell pixel. This is the regression surface the earlier
 * audit incorrectly flattened onto white. */
function tilePixels(theme: DtcgTheme, accentName: string, steps = 17): Rgba[] {
  const baseLayer = token(theme, 'bg-2');
  const accent = token(theme, accentName);
  return shellPixels(theme, steps).map((shell, index) => {
    const x = index % steps;
    const y = Math.floor(index / steps);
    const distance = Math.min(1, Math.hypot(x, y) / ((steps - 1) * 0.52));
    const radial = gradientPixel(alpha(accent, 0.10), cssColor('transparent'), distance);
    return over(radial, over(baseLayer, shell));
  });
}

function worstContrast(foreground: Rgba, pixels: readonly Rgba[]): number {
  return Math.min(...pixels.map((pixel) => contrast(foreground, pixel)));
}

describe('portal-embedded operator theme contract', () => {
  it.each([
    'design-tokens/portal-light.semantic.tokens.json',
    'design-tokens/portal-dark.semantic.tokens.json',
  ])('%s keeps every semantic copy color at WCAG AA contrast on the page surface', (file) => {
    const tokens = themeTokens(file);
    for (const foreground of ['fg', 'fg-dim', 'fg-mute', 'accent', 'accent-strong', 'good', 'warn', 'bad']) {
      expect(contrast(token(tokens, foreground), token(tokens, 'bg')), `${file}: ${foreground} on bg`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    'design-tokens/portal-light.semantic.tokens.json',
    'design-tokens/portal-dark.semantic.tokens.json',
  ])('%s composites gradients and transparency before testing rendered pixels', (file) => {
    const tokens = themeTokens(file);
    const shell = shellPixels(tokens);
    const tileCopy = ['fg', 'fg-dim', 'fg-mute'];
    for (const foreground of tileCopy) {
      for (const accentName of ['accent', 'good', 'warn', 'bad']) {
        const pixels = tilePixels(tokens, accentName);
        expect(
          worstContrast(token(tokens, foreground), pixels),
          `${file}: ${foreground} on translucent ${accentName} tile`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }

    // The shell itself carries the tab/header copy. Checking every sampled
    // pixel prevents a safe first stop from hiding an unreadable far endpoint.
    expect(worstContrast(token(tokens, 'fg'), shell), `${file}: fg on shell gradient`).toBeGreaterThanOrEqual(4.5);
    expect(worstContrast(token(tokens, 'fg-dim'), shell), `${file}: fg-dim on shell gradient`).toBeGreaterThanOrEqual(4.5);

    // Proves the oracle is actually compositing its underlay rather than
    // reviving the predecessor's unconditional white fallback.
    const translucentBlack = cssColor('rgba(0, 0, 0, 0.5)');
    expect(over(translucentBlack, cssColor('#000000'))).toEqual(cssColor('#000000'));
    expect(over(translucentBlack, cssColor('#ffffff'))).not.toEqual(cssColor('#000000'));
  });

  it('keeps the Adv shell gradient and tab chrome on semantic surfaces', () => {
    const source = readFileSync(resolve(ROOT, 'apps/operator-vite/src/components/adv/AdvShell.tsx'), 'utf8');
    expect(source).toContain('var(--bg-deepest');
    expect(source).toContain('var(--bg-deeper');
    expect(source).not.toContain('#04111b');
    expect(source).not.toContain('rgba(3, 10, 20');
  });

  it('keeps overview text, counts, actions, and status dots semantic across themes', () => {
    const source = readFileSync(resolve(ROOT, 'apps/operator-vite/src/components/adv/AdvOverviewTab.tsx'), 'utf8');
    expect(source).toContain('color: var(--fg, #e7f7ff);');
    expect(source).toContain('background: color-mix(in srgb, var(--tile-accent');
    expect(source).toContain("data-health='crit'] { background: var(--bad");
    expect(source).not.toMatch(/accent="#[0-9a-f]{6}"/i);
  });

  it('keeps shared header popovers and operator wordmarks off dark-only literal colors', () => {
    const pills = readFileSync(resolve(ROOT, 'apps/operator-vite/src/components/adv/adv-header-pills.css'), 'utf8');
    const globals = readFileSync(resolve(ROOT, 'apps/operator/app/globals.css'), 'utf8');
    expect(pills).not.toContain('background: #0d1829');
    expect(pills).not.toContain('color: #e6ecf4');
    expect(globals).toMatch(/\.operator-wordmark__title\s*{[^}]*color:\s*var\(--fg\)/s);
    expect(globals).toMatch(/\.pc-voice-btn-label\s*{[^}]*color:\s*var\(--fg\)/s);
  });
});
