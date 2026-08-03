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
 *   2. Resolves `var()` chains — INCLUDING a token whose value is an opaque,
 *      two-operand `color-mix(in oklab|srgb, A [p%], B [p%])` — down to a hex
 *      literal
 *   3. Globs CSS under app/ and operator-vite/src/ for rules that set BOTH
 *      `color` and `background`/`background-color` to a `var(--token)`
 *   4. Asserts every such pair clears WCAG AA in EVERY theme
 *
 * Only directly-paired declarations are checked (both in the same rule), which
 * is the exact shape of the bug and keeps false positives at zero — a rule that
 * inherits its background from a parent is out of scope.
 *
 * EI-19386265666375541: this lint used to skip EVERY pair whose token resolved
 * to a `color-mix()` unconditionally — including the fully-deterministic,
 * opaque-to-opaque case (`color-mix(in oklab, var(--accent-strong) 58%,
 * var(--bg-popover))`, both operands solid colors, the result a single
 * knowable hex). That is exactly the shape local "plate" tokens use throughout
 * this codebase (a strong accent mixed toward the surface it sits on), so the
 * carve-out silently blinded the lint to the one category of token this app
 * actually uses for tinted fills, and a real sub-AA pair (the session popup's
 * zone caps, 4.05:1 against a 4.5:1 floor) shipped uncaught. The resolver below
 * computes that class for real. A `color-mix()` operand that is `transparent`,
 * `currentColor`, or carries alpha (`rgba()`/`hsla()`) is still correctly left
 * unresolved — its true rendered color depends on what is painted underneath,
 * which this per-rule static check cannot see — but such a skip is no longer
 * SILENT: `skipped pairs` below snapshots every one, so a new skip is a
 * reviewed diff instead of a gap nobody notices.
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

/**
 * Token sources: the palette tier, the :root semantic base, and globals.css's
 * one-off :root aliases — then each theme's overlay. globals.css is NOT
 * optional: it is where aliases like `--accent-bg: var(--accent-soft)` live, and
 * WI-4834's bug was written against exactly that alias. Omitting it makes those
 * tokens unresolvable, which silently SKIPS the pair rather than failing it —
 * i.e. the lint would vacuously pass on the very bug it exists to catch.
 */
const PALETTE = 'app/_brand-primitives.css';
const BASE = 'app/_semantic.css';
const GLOBAL_ALIASES = 'app/globals.css';
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

/** Every `--x: value;` custom-property declaration in ANY rule block of
 * already-comment-stripped CSS text, last-write-wins. Used both for the
 * global token tables (below) and, per-file, for COMPONENT-LOCAL tokens (see
 * `collectPairs` — the `--pc-zone-*` pattern this file's own header comment
 * describes: "the css-tokens lint only resolves a component-local token
 * INSIDE the file that defines it"). No selector filtering: a local token is
 * as valid a source as `:root`, and it is exactly the shape this lint used to
 * be blind to. */
function extractCustomProps(stripped: string): Map<string, string> {
  const out = new Map<string, string>();
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(stripped)) !== null) {
    const decl = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
    let d: RegExpExecArray | null;
    while ((d = decl.exec(m[2])) !== null) out.set(d[1].toLowerCase(), d[2].trim());
  }
  return out;
}

function readBlocks(rel: string): Map<string, string> {
  let content: string;
  try {
    content = readFileSync(join(OPERATOR_ROOT, rel), 'utf-8');
  } catch {
    return new Map(); // a clean checkout may not have generated _semantic.css yet
  }
  return extractCustomProps(content.replace(/\/\*[\s\S]*?\*\//g, ''));
}

function tableFor(theme: string): Map<string, string> {
  const t = new Map<string, string>([
    ...readBlocks(PALETTE),
    ...readBlocks(BASE),
    ...readBlocks(GLOBAL_ALIASES),
  ]);
  const overlay = THEME_FILES[theme];
  if (overlay) for (const [k, v] of readBlocks(overlay)) t.set(k, v);
  return t;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const VAR_REF = /^var\(\s*(--[a-z0-9-]+)\s*(?:,[\s\S]*)?\)$/i;

/* ── general color-expression resolution (values, not just var() chains) ──
 * Handles hex literals, a small set of named colors, `var(--x[, fallback])`,
 * and an opaque two-operand `color-mix(in oklab|srgb, A [p%]?, B [p%]?)`. */

const NAMED_COLORS: Readonly<Record<string, string>> = {
  white: '#ffffff',
  black: '#000000',
  red: '#ff0000',
};
/** Keywords whose real color depends on paint context this static per-rule
 * check cannot see — correctly left unresolved, not a resolver gap. */
const DYNAMIC_KEYWORDS = new Set(['transparent', 'currentcolor']);

/** Split a comma-separated argument list, respecting nested parens. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Split only on the FIRST top-level comma — `var()`'s `<name>, <fallback>`
 * shape, where the fallback itself may legally contain further commas. */
function splitFirstTopLevel(s: string): [string, string | undefined] {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
  }
  return [s.trim(), undefined];
}

function parseFnCall(raw: string): { name: string; args: string } | null {
  const m = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(raw.trim());
  return m ? { name: m[1].toLowerCase(), args: m[2] } : null;
}

/* oklab / srgb color-mix math (ported from the investigation behind
 * EI-19386265666375541, self-tested there against known WCAG pairs:
 * white/black = 21.00, #767676/#fff = 4.54). */
const srgbToLin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.slice(1);
  const out = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return [out[0], out[1], out[2]];
}
function rgbToHex(rgb: number[]): string {
  return `#${rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('')}`;
}
function toOklab([r, g, b]: readonly number[]): [number, number, number] {
  const R = srgbToLin(r),
    G = srgbToLin(g),
    B = srgbToLin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function fromOklab([L, a, b]: readonly number[]): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    linToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
function mixOklab(hexA: string, hexB: string, pctA: number): string {
  const A = toOklab(hexToRgb(hexA));
  const B = toOklab(hexToRgb(hexB));
  const p = pctA / 100;
  return rgbToHex(fromOklab([0, 1, 2].map((i) => A[i] * p + B[i] * (1 - p))));
}
function mixSrgb(hexA: string, hexB: string, pctA: number): string {
  const A = hexToRgb(hexA);
  const B = hexToRgb(hexB);
  const p = pctA / 100;
  return rgbToHex([0, 1, 2].map((i) => A[i] * p + B[i] * (1 - p)));
}

type SkipReason = 'unknown-token' | 'dynamic-or-alpha' | 'unsupported-function' | 'depth-exceeded';
interface Resolved {
  hex: string;
  unresolved?: undefined;
}
interface Unresolved {
  hex: null;
  unresolved: { reason: SkipReason; detail: string };
}

/** Resolve ONE color expression — a hex literal, a named color, `var()`, or an
 * opaque two-operand `color-mix()` — to a `#rrggbb`. Never both resolved and
 * unresolved; see the file header for why a `color-mix()` touching
 * transparent/currentColor/alpha is correctly left unresolved rather than a
 * resolver gap. */
function resolveColorExpr(raw: string, table: Map<string, string>, depth = 0): Resolved | Unresolved {
  const fail = (reason: SkipReason, detail: string): Unresolved => ({ hex: null, unresolved: { reason, detail } });
  if (depth > 12) return fail('depth-exceeded', raw);
  const v = raw.trim();

  if (HEX.test(v)) {
    let h = v.slice(1);
    if (h.length === 3)
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    return { hex: `#${h.toLowerCase()}` };
  }
  const lower = v.toLowerCase();
  if (DYNAMIC_KEYWORDS.has(lower)) return fail('dynamic-or-alpha', v);
  if (NAMED_COLORS[lower]) return { hex: NAMED_COLORS[lower] };

  const call = parseFnCall(v);
  if (!call) return fail('unknown-token', v);

  if (call.name === 'var') {
    const [token, fallback] = splitFirstTopLevel(call.args);
    const rawToken = table.get(token.toLowerCase());
    if (rawToken !== undefined) return resolveColorExpr(rawToken, table, depth + 1);
    if (fallback !== undefined) return resolveColorExpr(fallback, table, depth + 1);
    return fail('unknown-token', token);
  }

  if (call.name === 'color-mix') {
    const inMatch = /^in\s+([a-z0-9-]+)(?:\s+\w+\s+hue)?\s*,\s*([\s\S]+)$/i.exec(call.args.trim());
    if (!inMatch) return fail('unsupported-function', v);
    const space = inMatch[1].toLowerCase();
    if (space !== 'oklab' && space !== 'srgb')
      return fail('unsupported-function', `color-mix in ${space}`);
    const parts = splitTopLevel(inMatch[2]);
    if (parts.length !== 2) return fail('unsupported-function', v);

    const parsed = parts.map((part) => {
      const m = /^([\s\S]+?)\s+([\d.]+)%$/.exec(part);
      return m
        ? { expr: m[1].trim(), pct: parseFloat(m[2]) }
        : { expr: part, pct: undefined as number | undefined };
    });
    // CSS color-mix percentage resolution: neither given -> 50/50; one given
    // -> the other is `100% - it`.
    let p0 = parsed[0].pct;
    let p1 = parsed[1].pct;
    if (p0 === undefined && p1 === undefined) {
      p0 = 50;
      p1 = 50;
    } else if (p0 === undefined) p0 = 100 - (p1 as number);
    else if (p1 === undefined) p1 = 100 - p0;

    const a = resolveColorExpr(parsed[0].expr, table, depth + 1);
    if (a.unresolved) return a;
    const b = resolveColorExpr(parsed[1].expr, table, depth + 1);
    if (b.unresolved) return b;

    const total = p0 + p1;
    const pctA = total > 0 ? (p0 / total) * 100 : 50; // normalize when p0+p1 != 100
    const hex = space === 'oklab' ? mixOklab(a.hex, b.hex, pctA) : mixSrgb(a.hex, b.hex, pctA);
    return { hex };
  }

  return fail('unsupported-function', v);
}

/** Resolve a token to a `#rrggbb`, following var()/color-mix() chains. */
function resolveToken(token: string, table: Map<string, string>, depth = 0): Resolved | Unresolved {
  const raw = table.get(token.toLowerCase());
  if (raw === undefined) return { hex: null, unresolved: { reason: 'unknown-token', detail: token } };
  return resolveColorExpr(raw, table, depth);
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

interface SkippedPair {
  file: string;
  selector: string;
  colorToken: string;
  bgToken: string;
  /** One `<theme>:<color|background>:<reason>` entry per theme that could not
   * be resolved (deduped) — enough to tell a reader WHY without re-deriving it. */
  reasons: string[];
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

function collectPairs(): { pairs: Pair[]; skipped: SkippedPair[] } {
  const tables = Object.fromEntries(Object.keys(THEME_FILES).map((t) => [t, tableFor(t)]));
  const found: Pair[] = [];
  const skipped: SkippedPair[] = [];
  for (const file of cssFiles()) {
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '');

    // Component-local tokens declared anywhere in THIS file (e.g. chat-controls.css's
    // `--pc-zone-fill`/`--pc-zone-label`, defined on `.pc-zone` rather than `:root`)
    // overlay the global table for pairs found in this file only — mirroring the
    // real cascade (a local redefinition shadows a same-named global one) and, more
    // importantly, making resolvable the exact class of pair this lint's own header
    // comment already documents as file-scoped-only.
    const localTokens = extractCustomProps(stripped);
    const fileTables =
      localTokens.size > 0
        ? Object.fromEntries(
            Object.keys(tables).map((t) => [t, new Map([...tables[t], ...localTokens])]),
          )
        : tables;

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
      const reasons = new Set<string>();
      for (const theme of Object.keys(fileTables)) {
        const fg = resolveToken(cv[1], fileTables[theme]);
        const bg = resolveToken(bv[1], fileTables[theme]);
        if (fg.unresolved) {
          reasons.add(`${theme}:color:${fg.unresolved.reason}(${fg.unresolved.detail})`);
          continue;
        }
        if (bg.unresolved) {
          reasons.add(`${theme}:background:${bg.unresolved.reason}(${bg.unresolved.detail})`);
          continue;
        }
        min = Math.min(min, contrastRatio(fg.hex, bg.hex) / need);
      }
      const key = `${selector} :: ${cv[1]} :: ${bv[1]}`;
      if (min === Infinity) {
        // Not resolvable in ANY theme — genuinely can't verify this pair.
        // Recorded (not silently dropped) so a new one is a reviewed diff.
        if (!ALLOW.has(key)) {
          skipped.push({
            file: file.replace(`${APPS_ROOT}/`, ''),
            selector,
            colorToken: cv[1],
            bgToken: bv[1],
            reasons: [...reasons].sort(),
          });
        }
        continue;
      }
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
  return { pairs: found, skipped };
}

describe('contrast lint', () => {
  const { pairs, skipped } = collectPairs();

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

  it('tracks every pair the lint could NOT statically verify — a new skip is a reviewed diff, not a silent gap', () => {
    // EI-19386265666375541: the real bug wasn't just that color-mix() went
    // unresolved — it's that going unresolved was SILENT, so a pair could ship
    // sub-AA and nothing noticed. resolveColorExpr now resolves the opaque,
    // deterministic case; what's left here is genuinely unresolvable (an
    // operand that depends on paint order this per-rule check can't see:
    // transparent, currentColor, alpha). That's fine — but it must be VISIBLE.
    // A snapshot means any NEW skip shows up as a diff someone has to look at,
    // instead of vanishing into the same silence that caused the original bug.
    const summary = skipped
      .map((s) => `${s.file} :: ${s.selector} :: color:${s.colorToken} on background:${s.bgToken}\n    ${s.reasons.join('\n    ')}`)
      .sort();
    expect(summary).toMatchSnapshot();
  });
});
