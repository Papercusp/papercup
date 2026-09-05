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
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listLiveTypeScriptFiles } from './live-source-files';
import { stripJsComments } from './strip-js-comments';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const MARKDOWN_EDITOR = resolve(HERE, 'MarkdownEditor.tsx');
const SETUP_SCRIPT = resolve(REPO_ROOT, 'apps/operator/scripts/setup-vditor-runtime.sh');
const MARKMAP_BUNDLE = resolve(REPO_ROOT, 'apps/operator/public/vditor/dist/js/markmap/markmap.min.js');
const THIRD_LANGUAGES = resolve(
  REPO_ROOT,
  'apps/operator/public/vditor/dist/js/highlight.js/third-languages.js',
);
const LOCAL_MARKMAP_ASSETS = resolve(REPO_ROOT, 'apps/operator/public/vditor-local');

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
 * SUPERSEDED IMPLEMENTATION (cdn-egress-fixes-2026-08-02 P-001): the two-regex
 * form this file used to carry stripped BLOCK comments first, so a `/*` inside a
 * LINE comment opened a phantom block comment that ran to the next `*​/` anywhere
 * in the file. Measured on HarnessPluginsSection.tsx, that swallowed 44 lines
 * including a real import. It never fired on MarkdownEditor.tsx, but the failure
 * is silent whenever the swallowed region still leaves the count above the floor
 * — so it is fixed at the shared helper for both guards, not left latent here.
 */
const stripComments = stripJsComments;

describe('vditor cdn (WI-7088)', () => {
  it('every Vditor entry point passes an explicit cdn', async () => {
    const src = stripComments(await readFile(MARKDOWN_EDITOR, 'utf8'));

    const entryPoints = src.match(VDITOR_ENTRY_POINTS) ?? [];
    const cdnArgs = src.match(/cdn:\s*VDITOR_CDN\b/g) ?? [];

    // Three today: preloadVditor's warm render, MarkdownPreview, MarkdownEditor.
    expect(entryPoints.length).toBeGreaterThanOrEqual(3);
    expect(cdnArgs.length).toBe(entryPoints.length);
  });

  it('every Vditor entry point pins math.engine to KaTeX', async () => {
    // EI-19370965762703309. MathJax lazily loads speech-rule-engine from
    // `cdn.jsdelivr.net/npm/speech-rule-engine@<ver>/lib/mathmaps` — the public
    // internet, i.e. the exact egress this file exists to prevent. KaTeX is
    // served from the local mirror, so pinning it keeps that path dead code.
    //
    // CORRECTING THE FILING'S PREMISE: the item worried that the unpinned
    // warm-up render might FALL BACK to MathJax, and explicitly could not
    // determine vditor's default. It is KaTeX. vditor's own types document
    // `engine` as "默认值: 'KaTeX'" (dist/types/index.d.ts:495) and its bundled
    // defaults read `math:{engine:"KaTeX",inlineDigit:!1,macros:{}}`. So an
    // unset engine was never the live risk, and the warm-up was not one
    // content-change away from egress.
    //
    // The invariant is still worth pinning, for the two reasons that survive:
    //   1. an EXPLICIT `engine: 'MathJax'` at any entry point reopens the
    //      egress — asserted directly below, since that is the real risk;
    //   2. the KaTeX default belongs to vditor, not to us, so a future upgrade
    //      could change it silently. Pinning per entry point makes the property
    //      ours and hold by construction, as `cdn` and `transform` already do.
    const src = stripComments(await readFile(MARKDOWN_EDITOR, 'utf8'));

    const entryPoints = src.match(VDITOR_ENTRY_POINTS) ?? [];
    const mathEngines = src.match(/math:\s*\{\s*engine:\s*['"]KaTeX['"]\s*\}/g) ?? [];

    // The direct statement of the property: nothing may select MathJax. The
    // count assertion below implies this today (a MathJax pin displaces a
    // KaTeX one and breaks the count), but only indirectly and with a far
    // worse failure message.
    expect(src).not.toMatch(/engine:\s*['"]MathJax['"]/);

    // Comment-stripping is load-bearing here, not cosmetic: the raw source
    // carries 6 entry-point-shaped tokens, 3 of which are prose describing the
    // call sites. Matching raw text would compare 2 against 6 and mis-report
    // the gap's size.
    expect(entryPoints.length).toBeGreaterThanOrEqual(3);
    expect(mathEngines.length).toBe(entryPoints.length);
  });

  it('no OTHER module constructs Vditor behind this guard\'s back', async () => {
    // The assertion above only inspects MarkdownEditor.tsx. A second module
    // constructing Vditor would be invisible to it — so enumerate every live
    // source file. The filesystem-only source
    // enumerator keeps this off node_modules, the generated public/vditor
    // mirror, and dist without asking git to spawn worker threads.
    const candidates = (await listLiveTypeScriptFiles(REPO_ROOT))
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

    expect(constructors).toEqual([
      'apps/operator/app/_components/MarkdownEditor.tsx',
      'libs/generic/ui-primitives/src/PlanDocumentView.tsx',
    ]);
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

  it('vendors markmap scripts locally and rewrites the prebuilt loader', async () => {
    const setup = await readFile(SETUP_SCRIPT, 'utf8');
    const markmap = await readFile(MARKMAP_BUNDLE, 'utf8');

    // These URLs are injected by Vditor's prebuilt markmap bundle, so a local
    // VDITOR_CDN base cannot redirect them. The setup script must copy the
    // browser bundles and patch the exact script-src values during every fresh
    // install/build, including an already-stamped v3.11.2 mirror.
    expect(setup).toContain('resolve_asset d3 dist/d3.min.js 6.7.0');
    expect(setup).toContain('resolve_asset markmap-view dist/index.min.js 0.14.3');
    expect(setup).toContain('resolve_asset webfontloader webfontloader.js 1.6.28');
    expect(setup).toContain("/vditor-local/d3.min.js");
    expect(setup).toContain("/vditor-local/markmap-view.min.js");
    expect(setup).toContain("/vditor-local/webfontloader.js");

    const operatorPkg = JSON.parse(
      await readFile(resolve(REPO_ROOT, 'apps/operator/package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const vitePkg = JSON.parse(
      await readFile(resolve(REPO_ROOT, 'apps/operator-vite/package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(operatorPkg.scripts?.postinstall).toContain('setup-vditor-runtime.sh');
    expect(vitePkg.scripts?.prebuild).toContain('setup-vditor-runtime.sh');

    for (const [name, remote, local, file] of [
      ['d3', 'https://cdn.jsdelivr.net/npm/d3@6.7.0', '/vditor-local/d3.min.js', 'd3.min.js'],
      ['markmap-view', 'https://cdn.jsdelivr.net/npm/markmap-view@0.14.3', '/vditor-local/markmap-view.min.js', 'markmap-view.min.js'],
      ['webfontloader', 'https://cdn.jsdelivr.net/npm/webfontloader@1.6.28/webfontloader.js', '/vditor-local/webfontloader.js', 'webfontloader.js'],
    ] as const) {
      expect(existsSync(resolve(LOCAL_MARKMAP_ASSETS, file)), `${name} local browser bundle is missing`).toBe(true);
      expect(markmap, `${name} markmap loader still contains its remote script URL`).not.toContain(remote);
      expect(markmap, `${name} markmap loader no longer points at the local script`).toContain(local);
    }
  });

  it('does not classify inline third-language grammars as runtime loaders', async () => {
    const src = await readFile(THIRD_LANGUAGES, 'utf8');

    // The jsDelivr strings in this file are provenance comments. The grammar
    // bodies immediately register with the already-local highlight.js runtime;
    // there is no fetch/XHR or script-element injection to vendor.
    expect(src).toMatch(/hljs\.registerLanguage\("(?:abap|solidity|yul)"/);
    expect(src).not.toMatch(/\b(?:fetch|XMLHttpRequest)\b/);
    expect(src).not.toMatch(/createElement\s*\(\s*["']script["']\s*\)/);
  });
});
