import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the History tab's desktop theme binding (plan
 * project-history-tab-desktop-and-portal-2026-09-16, P-002):
 *
 *  1. every `--ph-*` token ProjectHistoryView.css CONSUMES is bound in
 *     adv-history-tab.css under `.pc-project-history` (an unbound token silently renders the
 *     primitive's light-only fallback inside a dark shell);
 *  2. every colour binding references a semantic var that apps/operator/app/_semantic.css
 *     DEFINES (a rename there fails here instead of at the owner's screen);
 *  3. falsifiability control: a copy of the binding with one token removed is reported.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');
const bindingCss = readFileSync(join(here, 'adv-history-tab.css'), 'utf8');
const primitiveCss = readFileSync(
  join(repoRoot, 'libs', 'generic', 'ui-primitives', 'src', 'ProjectHistoryView.css'),
  'utf8',
);
const semanticCss = readFileSync(join(repoRoot, 'apps', 'operator', 'app', '_semantic.css'), 'utf8');

/** Tokens the primitive consumes: `var(--ph-x` sites, not its own fallback declarations. */
function consumedPhTokens(css: string): Set<string> {
  return new Set(Array.from(css.matchAll(/var\(\s*(--ph-[a-z0-9-]+)/g), (m) => m[1]));
}

/** `--ph-x: <value>` declarations inside the `.pc-project-history { … }` block. */
function boundPhTokens(css: string): Map<string, string> {
  const block = /\.pc-project-history\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  return new Map(
    Array.from(block.matchAll(/(--ph-[a-z0-9-]+)\s*:\s*([^;]+);/g), (m) => [m[1], m[2].trim()]),
  );
}

function definedSemanticVars(css: string): Set<string> {
  return new Set(Array.from(css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm), (m) => m[1]));
}

describe('adv-history-tab.css — --ph-* → semantic theme binding', () => {
  it('binds every --ph-* token ProjectHistoryView.css consumes', () => {
    const consumed = consumedPhTokens(primitiveCss);
    expect(consumed.size).toBeGreaterThan(5);
    const bound = boundPhTokens(bindingCss);
    const missing = [...consumed].filter((t) => !bound.has(t)).sort();
    expect(missing).toEqual([]);
  });

  it('every var() a binding references is defined by _semantic.css', () => {
    const defined = definedSemanticVars(semanticCss);
    const bad: string[] = [];
    for (const [token, value] of boundPhTokens(bindingCss)) {
      for (const m of value.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
        if (!defined.has(m[1])) bad.push(`${token} → ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('colour tokens are bound to theme vars, never raw colours', () => {
    const rawColour = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;
    const offenders = [...boundPhTokens(bindingCss)]
      .filter(([token]) => !/--ph-(control-h|shadow-float)$/.test(token))
      .filter(([, value]) => rawColour.test(value))
      .map(([token]) => token);
    expect(offenders).toEqual([]);
  });

  it('control: a binding with one token removed is reported as missing', () => {
    const mutated = bindingCss.replace(/\n\s*--ph-text:[^;]+;/, '');
    expect(mutated).not.toEqual(bindingCss);
    const bound = boundPhTokens(mutated);
    const missing = [...consumedPhTokens(primitiveCss)].filter((t) => !bound.has(t));
    expect(missing).toEqual(['--ph-text']);
  });
});
