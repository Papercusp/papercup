/**
 * CSS-token lint — fails CI when a .tsx file references `var(--X)` where
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
 *   1. Globs every .tsx file under app/ and lib/
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
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const OPERATOR_ROOT = resolve(__dirname, '../..');

// Tokens set at runtime by a framework, not in any CSS source. Treat as defined.
const RUNTIME_TOKENS: ReadonlySet<string> = new Set([
  // Radix Select sets this on its trigger to match listbox to trigger width.
  '--radix-select-trigger-width',
  // Operator chat sidebar drives a custom width var on body for chrome offset.
  '--op-chat-w',
]);

// CSS files to read defined tokens from. Order matters only for debugging;
// the lint is just a union of all matches.
const CSS_SOURCES = [
  'app/globals.css',
  'app/_semantic.css',
  'app/_brand-primitives.css',
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
    // Match `  --name:` (any leading whitespace, at column start of
    // its line). Ignore `var(--X)` references inside other rules.
    const re = /^\s*(--[a-z0-9_-]+)\s*:/gim;
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
    } else if (full.endsWith('.tsx')) {
      out.push(full);
    }
  }
}

function collectUsedTokens(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  const files: string[] = [];
  walk(join(OPERATOR_ROOT, 'app'), files);
  walk(join(OPERATOR_ROOT, 'lib'), files);
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    // Match var(--name) or var(--name, fallback).
    // We deliberately stop the name capture at the comma or close-paren.
    const re = /var\(\s*(--[a-z0-9_-]+)\s*[,)]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const name = m[1].toLowerCase();
      const arr = used.get(name) ?? [];
      const rel = file.replace(OPERATOR_ROOT + '/', '');
      if (!arr.includes(rel)) arr.push(rel);
      used.set(name, arr);
    }
  }
  return used;
}

describe('css-tokens lint', () => {
  const defined = readDefinedTokens();
  const used = collectUsedTokens();

  it('every var(--X) reference in .tsx is either defined in CSS or in the runtime-token allowlist', () => {
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
