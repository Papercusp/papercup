/**
 * Contrast lint — fails CI when a CSS rule paints text on a background using
 * semantic tokens that COLLIDE (both light, or both dark) in any shipped theme.
 *
 * Catches the regression class WI-4834 shipped to the owner: the Quick Panel's
 * "New prompt" button set `color: var(--accent-strong)` on
 * `background: var(--accent-bg, ...)`. `--accent-bg` resolves to `--accent-soft`
 * — a LIGHT accent tint — and `--accent-strong` is ALSO light, so the label was
 * light-on-light at 1.26:1 in every theme (WCAG AA needs 4.5:1): effectively
 * invisible. The same pairing had been copied into `.pc-qp__pin.on` and
 * `.pc-qp__tag`. Nothing caught it, because each token is individually valid —
 * only the PAIR is wrong, and no lint looked at pairs.
 *
 * The trap is that `--accent-strong` reads like "the strong/prominent accent",
 * so it looks like the right choice for a label ON an accent surface. It isn't:
 * it's a light accent for text on the DARK app ground. The token for text drawn
 * on an accent fill is `--accent-ink`.
 *
 * The lint:
 *   1. Builds a per-theme token table (`_brand-primitives.css` palette +
 *      `_semantic.css` :root, overlaid with each `_semantic.<theme>.css`)
 *   2. Resolves `var()` chains down to a hex literal
 *   3. Globs CSS under app/ and operator-vite/src/ for rules that set BOTH
 *      `color` and `background`/`background-color` to a `var(--token)`
 *   4. Asserts every such pair clears WCAG AA in EVERY theme
 *
 * Only directly-paired declarations are checked (both in the same rule), which
 * is the exact shape of the bug and keeps false positives at zero — a rule that
 * inherits its background from a parent is out of scope. Pairs whose tokens
 * resolve to `color-mix()`/`rgba()`/gradients are skipped (not statically
 * resolvable to one hex).
 *
 * Fix a failure by pairing correctly, not by widening the carve-out:
 *   - text ON an accent fill (`--accent`, `--accent-soft`, `--accent-strong`)
 *     -> `color: var(--accent-ink)`
 *   - text on the app ground (`--bg`, `--bg-2`, `--bg-3`)
 *     -> `--fg` / `--fg-dim` / `--fg-mute`, or `--accent-strong` for an accent label
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const OPERATOR_ROOT = resolve(__dirname, '../..');
const APPS_ROOT = resolve(OPERATOR_ROOT, '..');
const CSS_ROOTS = [join(OPERATOR_ROOT, 'app'), join(APPS_ROOT, 'operator-vite/src')];

/** Token sources: the palette tier + the :root base, then each theme's overlay. */
const PALETTE = 'app/_brand-primitives.css';
const BASE = 'app/_semantic.css';
const THEME_FILES: Readonly<Record<string, string | null>> = {
  default: null, // :root base only
  frost: 'app/_semantic.frost.css',
  black: 'app/_semantic.black.css',
  honeycomb: 'app/_semantic.honeycomb.css',
};

/**
 * Known-and-accepted pairs, as `selector :: --color :: --background`.
 * KEEP THIS EMPTY. A failure here is a real legibility bug in a shipped theme —
 * repair the token pair (see the header). Only a pair that is genuinely
 * decorative (never renders readable text) belongs here, with a reason.
 */
const ALLOW: ReadonlySet<string> = new Set([]);

function readBlocks(rel: string): Map<string, string> {
  const out = new Map<string, string>();
  let content: string;
  try {
    content = readFileSync(join(OPERATOR_ROOT, rel), 'utf-8');
  } catch {
    return out; // a clean checkout may not have generated _semantic.css yet
  }
  const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(stripped)) !== null) {
    const decl = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
    let d: RegExpExecArray | null;
    while ((d = decl.exec(m[2])) !== null) out.set(d[1].toLowerCase(), d[2].trim());
  }
  return out;
}

function tableFor(theme: string): Map<string, string> {
  const t = new Map<string, string>([...readBlocks(PALETTE), ...readBlocks(BASE)]);
  const overlay = THEME_FILES[theme];
  if (overlay) for (const [k, v] of readBlocks(overlay)) t.set(k, v);
  return t;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const VAR_REF = /^var\(\s*(--[a-z0-9-]+)\s*(?:,[\s\S]*)?\)$/i;

/** Resolve a token to a `#rrggbb`, following var() chains. null if not a plain color. */
function resolveToken(token: string, table: Map<string, string>, depth = 0): string | null {
  if (depth > 12) return null;
  const raw = table.get(token.toLowerCase());
  if (!raw) return null;
  const v = raw.trim();
  if (HEX.test(v)) {
    let h = v.slice(1);
    if (h.length === 3)
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    return `#${h.toLowerCase()}`;
  }
  const ref = VAR_REF.exec(v);
  return ref ? resolveToken(ref[1], table, depth + 1) : null;
}

function relativeLuminance(hex: string): number {
  const h = hex.slice(1);
  const chan = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)];
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA: 3:1 for large text (>=24px, or >=18.66px bold), else 4.5:1. */
function threshold(body: string): number {
  const size = /(?<![-\w])font-size\s*:\s*([\d.]+)px/i.exec(body);
  const weight = /(?<![-\w])font-weight\s*:\s*(\d+)/i.exec(body);
  const px = size ? parseFloat(size[1]) : 0;
  const bold = weight ? parseInt(weight[1], 10) >= 700 : false;
  if (px >= 24 || (px >= 18.66 && bold)) return 3;
  return 4.5;
}

interface Pair {
  file: string;
  selector: string;
  colorToken: string;
  bgToken: string;
  min: number;
}

function cssFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === '_retired' || name === 'dist') continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (full.endsWith('.css')) out.push(full);
    }
  };
  for (const root of CSS_ROOTS) walk(root);
  return out;
}

function collectPairs(): Pair[] {
  const tables = Object.fromEntries(Object.keys(THEME_FILES).map((t) => [t, tableFor(t)]));
  const found: Pair[] = [];
  for (const file of cssFiles()) {
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = rule.exec(stripped)) !== null) {
      const selector = m[1].replace(/\s+/g, ' ').trim();
      const body = m[2];
      if (selector.startsWith('@') || selector.startsWith('--')) continue;
      const c = /(?<![-\w])color\s*:\s*([^;]+);/i.exec(body);
      const b = /(?<![-\w])background(?:-color)?\s*:\s*([^;]+);/i.exec(body);
      if (!c || !b) continue;
      const cv = VAR_REF.exec(c[1].trim());
      const bv = VAR_REF.exec(b[1].trim());
      if (!cv || !bv) continue;

      const need = threshold(body);
      let min = Infinity;
      for (const theme of Object.keys(tables)) {
        const fg = resolveToken(cv[1], tables[theme]);
        const bg = resolveToken(bv[1], tables[theme]);
        if (!fg || !bg) continue; // color-mix()/rgba()/gradient — not statically resolvable
        min = Math.min(min, contrastRatio(fg, bg) / need);
      }
      if (min === Infinity) continue;
      const key = `${selector} :: ${cv[1]} :: ${bv[1]}`;
      if (ALLOW.has(key)) continue;
      found.push({
        file: file.replace(`${APPS_ROOT}/`, ''),
        selector,
        colorToken: cv[1],
        bgToken: bv[1],
        min,
      });
    }
  }
  return found;
}

describe('contrast lint', () => {
  const pairs = collectPairs();

  it('every color-on-background token pair clears WCAG AA in every theme', () => {
    const failures = pairs.filter((p) => p.min < 1);
    if (failures.length > 0) {
      const report = failures
        .map(
          (f) =>
            `  ${f.file}\n    ${f.selector}\n` +
            `    color: var(${f.colorToken})  on  background: var(${f.bgToken})\n` +
            `    worst theme is ${(f.min * 100).toFixed(0)}% of the required ratio`,
        )
        .join('\n');
      throw new Error(
        `Found ${failures.length} unreadable token pair(s):\n${report}\n\n` +
          `These tokens collide (both light, or both dark) in at least one theme. ` +
          `For text ON an accent fill (--accent / --accent-soft / --accent-strong) use ` +
          `color: var(--accent-ink). For text on the app ground (--bg / --bg-2 / --bg-3) use ` +
          `--fg / --fg-dim / --fg-mute. Do NOT add the pair to ALLOW to silence this — ` +
          `--accent-strong is a light accent for text on the DARK ground, never a label on an accent fill.`,
      );
    }
    expect(failures).toHaveLength(0);
  });

  it('resolves a usable number of token pairs (guards against the scan silently finding nothing)', () => {
    // If the CSS or token files fail to load/parse this drops to 0 and the lint
    // above would vacuously pass. The operator ships well over a dozen such pairs.
    expect(pairs.length).toBeGreaterThan(10);
  });
});
