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
  // Layout rails measure themselves in JS and write the current width on <html>.
  '--left-sidebar-w',
  '--dev-rail-w',
  // EnvSwitcherBar measures its own height and publishes it on <html> (docEl)
  // so the app's top-anchored chrome can offset below the fixed bar.
  '--pc-env-bar-h',
  // Sonner writes these per-toast; globals.css uses them to keep stacked toasts compact.
  '--toasts-before',
  '--lift-amount',
  '--front-toast-height',
  // Voice controls write live input levels for the mic activity ring.
  '--mic-level',
  // Dev swarm identity artwork assigns these per rendered item.
  '--intro-index',
  '--bee-index',
  // React Flow / harness chrome geometry knobs that are supplied by the component.
  '--xy-handle-tx',
]);

// CSS files to read defined tokens from. Order matters only for debugging;
// the lint is just a union of all matches.
const CSS_SOURCES = [
  'app/globals.css',
  'app/_semantic.css',
  'app/_brand-primitives.css',
  '../operator-vite/src/components/left-sidebar/left-sidebar.styles.ts',
  '../operator-vite/src/components/dev-admin-rail/dev-admin-rail.styles.ts',
  '../operator-vite/src/components/adv/scheduled-calendar.css',
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
    const localDefs = new Set<string>();
    const defRe = /(?:^|\n|[;{])\s*(--[a-z0-9_-]+)\s*:/gim;
    let dm: RegExpExecArray | null;
    while ((dm = defRe.exec(content)) !== null) {
      localDefs.add(dm[1].toLowerCase());
    }
    const reactDefRe = /['"`](--[a-z0-9_-]+)['"`]\s*(?:as\s+string)?\s*[:\]]/gi;
    while ((dm = reactDefRe.exec(content)) !== null) {
      localDefs.add(dm[1].toLowerCase());
    }
    // Match var(--name) or var(--name, fallback).
    // We deliberately stop the name capture at the comma or close-paren.
    const re = /var\(\s*(--[a-z0-9_-]+)\s*[,)]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
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

  it('CSS sources contain a usable token vocabulary', () => {
    // Sanity: if this is < 50, the CSS files probably failed to load.
    expect(defined.size).toBeGreaterThan(50);
    expect(defined.has('--fg')).toBe(true);
    expect(defined.has('--bg-2')).toBe(true);
    expect(defined.has('--accent')).toBe(true);
  });
});
