import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optimize } from '@tailwindcss/node';

// EI-13210: the operator Vite build's CSS optimization pass (Tailwind's
// `@tailwindcss/node` `optimize()`, which shells out to lightningcss for
// minification) used to print a spurious warning for every standards-based
// `::highlight(...)` selector:
//
//   'highlight' is not recognized as a valid pseudo-element. Did you mean
//   ':highlight' (pseudo-class) or is this a typo?
//
// lightningcss (as of 1.32.0, the current latest) genuinely does not know
// about the CSS Custom Highlight API's `::highlight()` pseudo-element, but it
// still emits functionally-correct output for it under `errorRecovery: true`
// (the selector round-trips unminified but byte-for-byte equivalent) — the
// warning is pure noise. `@tailwindcss/node` already special-cases this exact
// situation for Vue's `:deep`/`:slotted`/`:global` pseudo-selectors by
// filtering warnings matching a fixed regex; patches/@tailwindcss+node+*.patch
// (applied via postinstall's `patch-package`) extends that same allowlist to
// cover `highlight`, so a real invalid-selector typo still surfaces loudly.
//
// This test guards that patch: it runs the ACTUAL shipped find-in-page.css
// (which drives the app-wide Ctrl/⌘+F highlight overlay) through the real
// `optimize()` codepath the production build uses, and asserts no warning
// escapes for our selectors — while a genuinely bogus pseudo-element still
// does, so a future regex edit can't silently turn this into a blanket
// warning-suppression.

const __dirname = dirname(fileURLToPath(import.meta.url));
const findInPageCss = readFileSync(resolve(__dirname, '../find-in-page.css'), 'utf-8');

describe('find-in-page.css survives the real @tailwindcss/node optimize() pass', () => {
  it('emits no lightningcss warnings for the shipped ::highlight() selectors', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = optimize(findInPageCss, { minify: true });
      expect(warnSpy).not.toHaveBeenCalled();
      // The selector must still be present, byte-identical modulo whitespace —
      // errorRecovery passes it through unminified rather than dropping it.
      expect(result.code.toString()).toContain('::highlight(papercup-find)');
      expect(result.code.toString()).toContain('::highlight(papercup-find-active)');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still warns loudly on a genuinely unrecognized pseudo-element (the filter is not a blanket silence)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      optimize('::totally-bogus-pseudo-element { color: red; }', { minify: true });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warned = warnSpy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(warned).toMatch(/totally-bogus-pseudo-element/);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
