/**
 * Guard: Vditor must never fetch its runtime assets from the public internet.
 *
 * WI-7088. Vditor resolves everything it lazily loads — the Lute markdown
 * parser, i18n, toolbar icons, highlight.js, mermaid/KaTeX, emoji, content
 * themes — from `options.cdn`, defaulting to `https://unpkg.com/vditor@<ver>`.
 * We never set it, so every cold markdown render fetched ~4.9MB across the
 * internet before it could paint (lute.min.js alone is 3907KB, and being a
 * Go->WASM-transpiled blob it is slow to PARSE even when the bytes are cached).
 * That was the "opening a plan takes several seconds" bug, and it also made
 * markdown rendering silently require connectivity.
 *
 * The failure mode this guards is quiet and per-surface: `cdn` is an OPTIONAL
 * option with a WORKING default, so a new Vditor call site that forgets it does
 * not throw, does not warn, and looks fine on a fast connection — it just
 * reintroduces the multi-megabyte internet fetch for its own surface. Nothing
 * else in the build would notice. Hence a text-level assertion over the source:
 * the property either appears at each entry point or it does not.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const MARKDOWN_EDITOR = resolve(HERE, 'MarkdownEditor.tsx');

/** Every way Vditor can be entered: the static preview renderer and the editor
 *  constructor. Both read `options.cdn`; both are lazy `import('vditor')`. */
const VDITOR_ENTRY_POINTS = /(?:Vditor\.preview\(|new Vditor\()/g;

describe('vditor cdn (WI-7088)', () => {
  it('every Vditor entry point passes an explicit cdn', async () => {
    const src = await readFile(MARKDOWN_EDITOR, 'utf8');

    const entryPoints = src.match(VDITOR_ENTRY_POINTS) ?? [];
    const cdnArgs = src.match(/cdn:\s*VDITOR_CDN\b/g) ?? [];

    // Three today: preloadVditor's warm render, MarkdownPreview, MarkdownEditor.
    expect(entryPoints.length).toBeGreaterThanOrEqual(3);
    expect(cdnArgs.length).toBe(entryPoints.length);
  });

  it('no OTHER module constructs Vditor behind this guard\'s back', () => {
    // The assertion above only inspects MarkdownEditor.tsx. A second module
    // importing vditor directly would be invisible to it — so pin the fact that
    // MarkdownEditor.tsx is the single wrapper. `git grep` (not a tree walk)
    // keeps this off node_modules, the generated public/vditor mirror, and dist.
    const hits = execFileSync(
      'git',
      ['grep', '-l', '-E', "from 'vditor'|import\\('vditor'\\)", '--', 'apps', 'packages', 'libs'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
      // Tests may stub the module; only real call sites matter here.
      .filter((f) => !f.includes('.test.'));

    expect(hits).toEqual(['apps/operator/app/_components/MarkdownEditor.tsx']);
  });

  it('the cdn base resolves to a real local mirror, not the internet', async () => {
    const src = await readFile(MARKDOWN_EDITOR, 'utf8');
    const base = src.match(/export const VDITOR_CDN = '([^']+)'/)?.[1];

    expect(base).toBeTruthy();
    // A protocol-bearing base is the regression: that is unpkg/jsdelivr again.
    expect(base).toMatch(/^\//);
    expect(base).not.toMatch(/^https?:|^\/\//);

    // `publicDir` is apps/operator/public (apps/operator-vite/vite.config.ts),
    // so the base maps there and is served at that path in dev + copied into
    // dist for prod. lute.min.js is the one asset EVERY render needs, so its
    // absence means the mirror never got populated and markdown will 404
    // rather than merely be slow.
    const mirrored = resolve(REPO_ROOT, 'apps/operator/public', base!.replace(/^\//, ''), 'dist/js/lute/lute.min.js');
    expect(
      existsSync(mirrored),
      `vditor mirror missing at ${mirrored} — run apps/operator/scripts/setup-vditor-runtime.sh (normally chained from apps/operator's postinstall and operator-vite's prebuild)`,
    ).toBe(true);
  });
});
