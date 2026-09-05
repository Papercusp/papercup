/**
 * CSS-token lint — fails CI when a source file references `var(--X)` where
 * `--X` isn't defined anywhere in the operator's CSS sources.
 *
 * Catches the regression class that periodic audits keep finding:
 * concurrent agents drop in shadcn/Tailwind/Starlight-vocabulary tokens
 * (`--text-1`, `--surface`, `--muted-foreground`, `--card`, `--danger`,
 * `--ok`, `--sl-color-*`, etc.) that aren't defined and render either
 * via fallback hex (anchoring visuals to a non-themeable color) or
 * transparently (invisible cards).
 *
 * The lint:
 *   1. Globs every .tsx/.ts/.css file under app/, lib/, and operator-vite/src/
 *   2. Extracts every `var(--name)` reference
 *   3. Globs every .css file under app/ and reads `--name:` definitions
 *   4. Asserts every used token is either defined OR in the carve-out list
 *
 * If you intentionally add a new theme token, define it in
 *   - app/_semantic.css (regenerated from design-tokens via `pnpm tokens`)
 *   - app/_brand-primitives.css (palette tier)
 *   - or app/globals.css :root (one-off semantic alias)
 *
 * If you're using a token that the browser / framework sets at runtime
 * (Radix sizes its content via --radix-XXX, Vaul sets vaul-side, etc.),
 * add it to RUNTIME_TOKENS below.
 *
 * Component-LOCAL custom properties — a `--name:` both defined and used
 * inside the same source file (e.g. a styled-jsx <style> block) — are recognized
 * automatically: they're satisfied within the component, even though the
 * global CSS-source scan can't see a definition that lives in a .tsx.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const OPERATOR_ROOT = resolve(__dirname, '../..');
const APPS_ROOT = resolve(OPERATOR_ROOT, '..');
const SOURCE_ROOTS = [
  join(OPERATOR_ROOT, 'app'),
  join(OPERATOR_ROOT, 'lib'),
  join(APPS_ROOT, 'operator-vite/src'),
];
const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.css'] as const;

// Tokens set at runtime by a framework, not in any CSS source. Treat as defined.
const RUNTIME_TOKENS: ReadonlySet<string> = new Set([
  // Radix Select sets this on its trigger to match listbox to trigger width.
  '--radix-select-trigger-width',
  // Radix Select publishes the viewport space available to its content.
  '--radix-select-content-available-height',
  // Radix Popover's positioner publishes these on the content element: the
  // trigger's width, and how much room is actually left beside/below it before
  // the viewport edge. harness/Combobox.tsx's panel uses the width to never be
  // narrower than the control it drops from, and the available-height to bound
  // its scroll container to the space genuinely on screen — the P-006 fix in
  // `hud-session-launcher-and-board-tabs-2026-07-26` (a plan list that ran off
  // the bottom with no scrollbar).
  '--radix-popover-trigger-width',
  '--radix-popover-content-available-width',
  '--radix-popover-content-available-height',
  // harness/Combobox.tsx passes its `maxListHeight` prop down as an inline
  // custom property on the popover content, so the caller's ceiling and the
  // Radix-measured available height can be min()'d together in CSS.
  '--h-combobox-max-list',
  // Operator chat sidebar drives a custom width var on body for chrome offset.
  '--op-chat-w',
  // Layout rails measure themselves in JS and write the current width on <html>.
  '--left-sidebar-w',
  '--dev-rail-w',
  // EnvSwitcherBar measures its own height and publishes it on <html> (docEl)
  // so the app's top-anchored chrome can offset below the fixed bar.
  '--pc-env-bar-h',
  // Sonner writes these per-toast; globals.css uses them to keep stacked toasts compact.
  '--toasts-before',
  '--lift-amount',
  // The adv HUD derives a per-fleet accent colour in JS and injects it on each card
  // (app/adv/hud/hud.css documents this at the top of the file: "fleetColor … is injected
  // as the --hud-fleet custom property per card"). Runtime-set by definition, so it can
  // never appear in a CSS source — exactly what this allowlist is for.
  '--hud-fleet',
  '--front-toast-height',
  // Voice controls write live input levels for the mic activity ring.
  '--mic-level',
  // Dev swarm identity artwork assigns these per rendered item.
  '--intro-index',
  '--bee-index',
  // React Flow / harness chrome geometry knobs that are supplied by the component.
  '--xy-handle-tx',
  // @papercusp/card-stack's <CardStack accent> sets this via an inline style
  // on its own deck wrapper (`style={{ '--cs-accent': accent }}`); it cascades
  // through the DOM to every descendant rendered inside the stack (card heads
  // in ObservationsPanel/AnalyzePanel/LearningTab, etc.). It's never written
  // to a static CSS source, so the token scan can't see a definition — every
  // use already carries a `var(--cs-accent, var(--accent, ...))` fallback for
  // when no CardStack ancestor supplies it.
  '--cs-accent',
]);

// CSS files to read defined tokens from. Order matters only for debugging;
// the lint is just a union of all matches.
const CSS_SOURCES = [
  'app/globals.css',
  'app/_semantic.css',
  'app/_brand-primitives.css',
  // Stylesheets carried by the mounted operator surfaces (portal-parity P-005/P-003):
  // rules that used to live in globals.css, moved with their local mini-palettes
  // (`--vault-*`) so hosts that never load globals.css still style those surfaces.
  'app/_primitives.css',
  'app/settings/settings.css',
  'app/support/support.css',
  '../operator-vite/src/components/left-sidebar/left-sidebar.styles.ts',
  '../operator-vite/src/components/dev-admin-rail/dev-admin-rail.styles.ts',
  '../operator-vite/src/components/adv/scheduled-calendar.css',
  // The pc-orders panel palette (--pc-orders-*) is defined here and legitimately
  // consumed by sibling files in the same panel (Disclosures.css inherits it via
  // CSS custom-property inheritance, with global-token fallbacks) — a shared
  // mini-palette, same class as scheduled-calendar.css above.
  'app/adv/sessions/AgentOrders.css',
  '../operator-vite/src/components/voice-video/VoiceChannelPanel.css',
  '../operator-vite/src/components/voice-video/VideoGrid.css',
];

function readDefinedTokens(): Set<string> {
  const defined = new Set<string>(RUNTIME_TOKENS);
  for (const rel of CSS_SOURCES) {
    let content: string;
    try {
      content = readFileSync(join(OPERATOR_ROOT, rel), 'utf-8');
    } catch {
      // CSS file missing — semantic.css may not be generated in some
      // clean checkouts; just skip.
      continue;
    }
    // Match `--name:` declarations at line start or inside a CSS rule block.
    // Ignore `var(--X)` references inside other rules.
    const re = /(?:^|\n|[;{])\s*(--[a-z0-9_-]+)\s*:/gim;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      defined.add(m[1]);
    }
  }
  return defined;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.next') || name === 'operator-mock' || name === 'test-results') {
      continue;
    }
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (
      SOURCE_EXTENSIONS.some((ext) => full.endsWith(ext)) &&
      !/\.(?:test|spec)\.(?:tsx|ts)$/.test(full)
    ) {
      out.push(full);
    }
  }
}

/**
 * Blank out COMMENT spans so a comment that merely *mentions* a token is not
 * counted as a usage — or as a component-local definition — of it.
 * EI-19420634904212731.
 *
 * Before this, the lint regexed the file's raw text, so the natural response to
 * a token bug ("fix the code line, then leave a comment quoting the broken form
 * so the next agent doesn't repeat it") RE-TRIGGERED the exact failure it was
 * documenting — and presented as "my fix didn't land", because the reported
 * token was nowhere in the executable source.
 *
 * Comment characters are replaced with spaces rather than deleted, so the
 * output is byte-length-identical and newline positions are preserved (asserted
 * below). That is what makes this safe: we can only ever BLANK a span, never
 * shift or drop source, so a `var(--X)` outside a comment cannot move or vanish.
 *
 * The failure mode to avoid is the opposite of the bug: a naive strip turns a
 * loud, correct lint into a SILENTLY PERMISSIVE one. So the scanner tracks
 * string, template-literal and regex-literal state before honouring a `/`:
 *   - `'https://x'` — the `//` sits inside a string, so it opens no comment
 *     (a naive line-strip would eat the rest of the line, hiding real usages);
 *   - `/['"]/` — a regex literal containing a quote must not open a string
 *     state and swallow the code that follows it.
 * `.css` has no `//` line-comment form at all (there, `//` appears in
 * `url(https://…)`), so `lineComments` is false for CSS and only `/* *\/`
 * spans are blanked.
 */
export function stripCommentsForTokenScan(
  src: string,
  { lineComments }: { lineComments: boolean },
): string {
  const out = src.split('');
  const n = src.length;
  // A `/` opens a REGEX literal only where an expression cannot already have
  // ended; after a value-ish token it is division. Keyed on the last
  // significant character, which is enough for the shapes that appear here.
  const REGEX_OK_AFTER = new Set([
    '',  '(', ',', '=', ':', '[', '!', '&', '|',
    '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>',
  ]);
  const blankRange = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  let i = 0;
  let prevSig = '';
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blankRange(i, stop);
      i = stop;
      continue;
    }
    if (lineComments && c === '/' && c2 === '/') {
      let end = src.indexOf('\n', i);
      if (end === -1) end = n;
      blankRange(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === c) {
          i++;
          break;
        }
        // An unterminated quote must not swallow the rest of the file: a plain
        // string cannot span a newline, so bail and resume normal scanning.
        if (src[i] === '\n') break;
        i++;
      }
      prevSig = c;
      continue;
    }
    if (c === '`') {
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '`') {
          i++;
          break;
        }
        i++;
      }
      prevSig = '`';
      continue;
    }
    if (lineComments && c === '/' && REGEX_OK_AFTER.has(prevSig)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '\n') break; // a regex literal cannot span lines — not a regex
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) {
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (closed) {
        i = j;
        prevSig = '/';
        continue;
      }
      // Not a regex after all — fall through and treat `/` as an ordinary char.
    }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return out.join('');
}

function collectUsedTokens(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  const files: string[] = [];
  for (const root of SOURCE_ROOTS) walk(root, files);
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    // Component-local custom properties: a `--name:` defined inside this same
    // file (e.g. a styled-jsx <style> block), or a React inline custom-property
    // key such as `{ ['--name' as string]: value }`, is satisfied within the
    // component. The global CSS-source scan can't see definitions that live in a
    // a global source, so collect this file's own definitions and treat self-references as
    // defined.
    // EI-19420634904212731: scan with comments BLANKED. Applied to the local
    // definitions too, not just the usages — a `--name:` sitting in a comment
    // must not register as a component-local definition, or it would SUPPRESS a
    // genuine undefined-token failure (the silently-permissive direction).
    const scan = stripCommentsForTokenScan(content, {
      lineComments: !file.endsWith('.css'),
    });
    const localDefs = new Set<string>();
    const defRe = /(?:^|\n|[;{])\s*(--[a-z0-9_-]+)\s*:/gim;
    let dm: RegExpExecArray | null;
    while ((dm = defRe.exec(scan)) !== null) {
      localDefs.add(dm[1].toLowerCase());
    }
    const reactDefRe = /['"`](--[a-z0-9_-]+)['"`]\s*(?:as\s+string)?\s*[:\]]/gi;
    while ((dm = reactDefRe.exec(scan)) !== null) {
      localDefs.add(dm[1].toLowerCase());
    }
    // Match var(--name) or var(--name, fallback).
    // We deliberately stop the name capture at the comma or close-paren.
    const re = /var\(\s*(--[a-z0-9_-]+)\s*[,)]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan)) !== null) {
      const name = m[1].toLowerCase();
      if (localDefs.has(name)) continue; // defined in this same component
      const arr = used.get(name) ?? [];
      const rel = file.replace(APPS_ROOT + '/', '');
      if (!arr.includes(rel)) arr.push(rel);
      used.set(name, arr);
    }
  }
  return used;
}

describe('css-tokens lint', () => {
  const defined = readDefinedTokens();
  const used = collectUsedTokens();

  it('every var(--X) reference in source files is either defined in CSS or in the runtime-token allowlist', () => {
    const undefined_: Array<{ token: string; files: string[] }> = [];
    for (const [token, files] of used) {
      if (!defined.has(token)) {
        undefined_.push({ token, files });
      }
    }
    if (undefined_.length > 0) {
      const report = undefined_
        .map((u) => `  ${u.token}\n${u.files.map((f) => `    ${f}`).join('\n')}`)
        .join('\n');
      throw new Error(
        `Found ${undefined_.length} undefined CSS token(s):\n${report}\n\n` +
          `Fix: either define the token in app/_semantic.css / app/globals.css :root, ` +
          `or replace with an existing token from the operator vocabulary (--bg, --bg-2, --bg-3, ` +
          `--fg, --fg-dim, --fg-mute, --border, --accent, --good, --warn, --bad). ` +
          `If the framework sets it at runtime, add it to RUNTIME_TOKENS in this test file.`,
      );
    }
    expect(undefined_).toHaveLength(0);
  });

  // EI-19420634904212731. This file is a `.test.ts`, which `walk()` excludes
  // from the scan — so the deliberately-undefined tokens below are inert here.
  describe('stripCommentsForTokenScan', () => {
    const ts = (s: string) => stripCommentsForTokenScan(s, { lineComments: true });
    const css = (s: string) => stripCommentsForTokenScan(s, { lineComments: false });
    const tokens = (s: string) => [...s.matchAll(/var\(\s*(--[a-z0-9_-]+)\s*[,)]/gi)].map((m) => m[1]);

    it('blanks a token mentioned only in a line or block comment', () => {
      expect(tokens(ts(`// the old var(--bg-subtle, #171717) failed the lint\n`))).toEqual([]);
      expect(tokens(ts(`/* do not reintroduce var(--bg-subtle) here */`))).toEqual([]);
    });

    it('still sees a real usage on a line that also carries a comment', () => {
      expect(tokens(ts(`const a = 'var(--bg-2)'; // was var(--bg-subtle)`))).toEqual(['--bg-2']);
    });

    it('does not treat // inside a string as a comment (the URL trap)', () => {
      // A naive line-strip eats the rest of the line here, HIDING a real usage.
      expect(tokens(ts(`const u = 'https://x.dev'; const c = 'var(--accent)';`))).toEqual(['--accent']);
      expect(tokens(css(`a { background: url(https://x.dev/i.png); color: var(--accent); }`))).toEqual(['--accent']);
    });

    it('does not let a regex literal containing quotes swallow following code', () => {
      expect(tokens(ts(`const re = /['"]/g; const c = 'var(--accent)';`))).toEqual(['--accent']);
    });

    it('does not let a template literal or apostrophe-in-comment swallow code', () => {
      expect(tokens(ts('const t = `a ${x} b`; const c = "var(--accent)";'))).toEqual(['--accent']);
      // An unpaired apostrophe in prose must not open a string state.
      expect(tokens(ts(`// don't do this\nconst c = 'var(--accent)';`))).toEqual(['--accent']);
    });

    it('treats // as ordinary text in CSS, where it is not a comment', () => {
      expect(tokens(css(`/* var(--gone) */\na { color: var(--accent); }`))).toEqual(['--accent']);
    });

    it('does not count a --name: written inside a comment as a local definition', () => {
      // The permissive direction: a commented-out definition must NOT satisfy a
      // real usage elsewhere in the file.
      const src = `/* --made-up: red; */\n.a { color: var(--made-up); }`;
      expect(/(?:^|\n|[;{])\s*(--[a-z0-9_-]+)\s*:/gim.test(css(src))).toBe(false);
      expect(tokens(css(src))).toEqual(['--made-up']);
    });

    it('only ever blanks: byte length, newline positions and non-comment text are preserved', () => {
      const src = `// c\nconst a = 'https://x'; /* b */ const d = var(--accent);\n`;
      const stripped = ts(src);
      expect(stripped).toHaveLength(src.length);
      expect([...stripped].map((ch, i) => (ch === '\n' ? i : -1)).filter((i) => i >= 0)).toEqual(
        [...src].map((ch, i) => (ch === '\n' ? i : -1)).filter((i) => i >= 0),
      );
      expect(ts(stripped)).toBe(stripped); // idempotent
    });

    it('is stable on the real source tree — stripping never invents a token', () => {
      // Whole-tree guard: every token surviving the strip must genuinely appear
      // in the raw file too, so the fix can only ever REMOVE comment mentions.
      const files: string[] = [];
      for (const root of SOURCE_ROOTS) walk(root, files);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files.slice(0, 400)) {
        let raw: string;
        try {
          raw = readFileSync(file, 'utf-8');
        } catch {
          continue;
        }
        const stripped = stripCommentsForTokenScan(raw, { lineComments: !file.endsWith('.css') });
        expect(stripped).toHaveLength(raw.length);
        const rawTokens = new Set(tokens(raw));
        for (const t of tokens(stripped)) expect(rawTokens.has(t)).toBe(true);
      }
    });
  });

  it('CSS sources contain a usable token vocabulary', () => {
    // Sanity: if this is < 50, the CSS files probably failed to load.
    // WI-3220: Make this more lenient during development when semantic.css
    // might not be generated yet (e.g., fresh checkout before `pnpm tokens` is run).
    // The main validation (first test) will catch missing tokens in actual source files.
    const minTokens = defined.has('--fg') ? 10 : 50;
    expect(defined.size).toBeGreaterThan(minTokens);
    // These tokens must always be present in the base vocabulary when CSS files load
    if (defined.size > 50) {
      expect(defined.has('--fg')).toBe(true);
      expect(defined.has('--bg-2')).toBe(true);
      expect(defined.has('--accent')).toBe(true);
    }
  });
});
