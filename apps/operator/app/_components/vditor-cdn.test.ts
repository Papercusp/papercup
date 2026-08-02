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

/**
 * Drop comments before pattern-matching. Load-bearing, not tidiness: this very
 * file's subject documents its own API in prose ("the first `new Vditor(...)`",
 * "each Vditor.preview() call"), so a naive match counts those doc mentions as
 * call sites — the first cut of this test read 6 entry points where 3 exist and
 * failed against correct code. A guard that miscounts the thing it guards is
 * worse than no guard, because the noise is what gets silenced.
 *
 * Block comments go first, so a URL living inside one (`https://unpkg.com/...`
 * in the VDITOR_CDN docs) is already gone. The line-comment rule then refuses to
 * fire on a `//` preceded by `:` so it cannot bite a bare protocol in real code.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('vditor cdn (WI-7088)', () => {
  it('every Vditor entry point passes an explicit cdn', async () => {
    const src = stripComments(await readFile(MARKDOWN_EDITOR, 'utf8'));

    const entryPoints = src.match(VDITOR_ENTRY_POINTS) ?? [];
    const cdnArgs = src.match(/cdn:\s*VDITOR_CDN\b/g) ?? [];

    // Three today: preloadVditor's warm render, MarkdownPreview, MarkdownEditor.
    expect(entryPoints.length).toBeGreaterThanOrEqual(3);
    expect(cdnArgs.length).toBe(entryPoints.length);
  });

  it('no OTHER module constructs Vditor behind this guard\'s back', async () => {
    // The assertion above only inspects MarkdownEditor.tsx. A second module
    // constructing Vditor would be invisible to it — so pin the fact that
    // MarkdownEditor.tsx is the single wrapper. `git grep` (not a tree walk)
    // keeps this off node_modules, the generated public/vditor mirror, and dist.
    const candidates = execFileSync(
      'git',
      ['grep', '-l', '-E', "from 'vditor'|import\\('vditor'\\)|new Vditor\\(|Vditor\\.preview\\(",
       '--', '*.ts', '*.tsx'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
      // Tests may stub the module; only real call sites matter here.
      .filter((f) => !f.includes('.test.'));

    // A file only counts as a call site if it constructs Vditor in CODE. Several
    // files legitimately DISCUSS it in prose — ChunkReloadPrompt.tsx documents
    // `import('vditor')` as its motivating example — and a memory-bench JSON
    // fixture even quotes this bug's own history back. Matching raw text flagged
    // all of them; comment-stripped code is the honest test.
    const constructors: string[] = [];
    for (const file of candidates) {
      const code = stripComments(await readFile(resolve(REPO_ROOT, file), 'utf8'));
      if (VDITOR_ENTRY_POINTS.test(code)) constructors.push(file);
      VDITOR_ENTRY_POINTS.lastIndex = 0; // /g regex carries state between .test()
    }

    expect(constructors).toEqual(['apps/operator/app/_components/MarkdownEditor.tsx']);
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
