/**
 * EI-1589 regression guard — the desktop sidecar bundle (.deb) must ship every
 * third-party npm package that operator-core loads via a runtime
 * `createRequire(import.meta.url)('<bare>')`.
 *
 * THE BUG CLASS: esbuild only bundles STATIC imports and the *global* `require`.
 * A `createRequire(import.meta.url)('rrule')` (or a locally-bound
 * `const require = createRequire(...); require('luxon')`) is an arbitrary
 * function call esbuild can NOT follow, so the package is neither inlined into
 * serve.mjs nor added to the externalize+copy list — 0 files ship in the .deb's
 * sidecar/node_modules. At boot the operator throws `Cannot find module '<x>'`,
 * exits before embedded-PG/Hono come up → `EMBEDDED_PG_FAILED` → the desktop
 * app never starts. This is exactly how `rrule` (fixed earlier) and then `luxon`
 * (EI-1589, landed 2026-06-17 in 5472dec3c without the copy line) bricked the
 * packaged build.
 *
 * Why ~28.6k green unit tests miss it: dev/test runs under tsx with a hoisted
 * root node_modules where every bare module resolves; nothing exercises the
 * packaged esbuild bundle's module graph. Only a live packaged-instance boot —
 * or this static guard — catches a missing copy line.
 *
 * THE GUARD: scan operator-core/lib for every third-party bare specifier loaded
 * through createRequire, then assert each one is copied into the sidecar by
 * papercusp-desktop/bin/build-desktop-sidecar.sh (either an explicit
 * `copy_pkg_closure <name>` or a NATIVE_PKGS entry, which is closure-copied in a
 * loop). A new createRequire('foo') without the matching copy line fails HERE,
 * red, instead of silently in a packaged boot.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isBuiltin } from 'node:module';

const LIB_DIR = import.meta.dirname ?? __dirname;
// operator-core/lib → operator-core → packages → repo root
const REPO_ROOT = join(LIB_DIR, '..', '..', '..');
const BUILD_SCRIPT = join(REPO_ROOT, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh');
// WI-3831: a release SOURCE BUNDLE excludes the WHOLE `papercusp-desktop/` dir
// (papercusp-desktop/bin/stage-source-tree.sh `--exclude='./papercusp-desktop'`
// — it's the Tauri/Rust shell, not shipped inside its own bundle target). The
// build script this guard checks against is then genuinely absent — there is
// nothing to assert about the sidecar bundling on that install.

/** Walk *.ts under operator-core/lib, excluding tests, d.ts, node_modules, fixtures. */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'fixtures' || entry === 'bench') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.d.ts') &&
      !entry.endsWith('.test.ts')
    ) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * A specifier needs to be copied into the sidecar iff it is a third-party bare
 * module: not a node builtin, not a relative/absolute path, and not a
 * `@papercusp/*` workspace package (those are inlined by esbuild's workspace
 * bundling, or externalized+copied through their own NATIVE_PKGS path).
 */
function isThirdPartyBare(spec: string): boolean {
  if (spec.startsWith('.') || spec.startsWith('/')) return false;
  if (spec.startsWith('node:') || isBuiltin(spec)) return false;
  if (spec.startsWith('@papercusp/')) return false;
  return true;
}

/**
 * Extract every bare specifier loaded via a createRequire-derived require in one
 * source file — both the inline form `createRequire(import.meta.url)('x')` and
 * the aliased form `const NAME = createRequire(import.meta.url); NAME('x')`.
 */
function createRequireSpecifiers(src: string): string[] {
  const specs: string[] = [];

  // Inline: createRequire(<anything>)('<spec>')
  const inline = /createRequire\s*\([^)]*\)\s*\(\s*['"]([^'"]+)['"]/g;
  for (let m = inline.exec(src); m; m = inline.exec(src)) specs.push(m[1]);

  // Aliased: capture identifiers bound to createRequire(...), then their calls.
  const bind = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createRequire\s*\(/g;
  const names = new Set<string>();
  for (let m = bind.exec(src); m; m = bind.exec(src)) names.add(m[1]);
  for (const name of names) {
    const call = new RegExp(`\\b${name}\\s*\\(\\s*['"]([^'"]+)['"]`, 'g');
    for (let m = call.exec(src); m; m = call.exec(src)) specs.push(m[1]);
  }

  return specs;
}

/** Packages the build script copies into the sidecar node_modules. */
function copiedPackages(script: string): Set<string> {
  const copied = new Set<string>();

  // Explicit literal copies: `copy_pkg_closure rrule`  (skip the `"$np"` loop call
  // and the function definition `copy_pkg_closure() {`).
  const closure = /copy_pkg_closure\s+([A-Za-z0-9@._/-]+)/g;
  for (let m = closure.exec(script); m; m = closure.exec(script)) {
    const name = m[1];
    if (name === '()' || name.startsWith('"') || name.startsWith('$')) continue;
    copied.add(name);
  }

  // NATIVE_PKGS=( ... ) — closure-copied via `for np ...; do copy_pkg_closure "$np"`.
  const arr = /NATIVE_PKGS=\(([\s\S]*?)\)/.exec(script);
  if (arr) {
    for (const rawLine of arr[1].split('\n')) {
      const line = rawLine.replace(/#.*$/, '').trim(); // strip comments
      for (const tok of line.split(/\s+/)) {
        if (tok && /^[A-Za-z0-9@._/-]+$/.test(tok)) copied.add(tok);
      }
    }
  }

  return copied;
}

describe.skipIf(!existsSync(BUILD_SCRIPT))('desktop sidecar createRequire bundling (EI-1589)', () => {
  const files = collectSourceFiles(LIB_DIR);
  const found = new Map<string, string[]>(); // spec -> source files
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const spec of createRequireSpecifiers(src)) {
      if (!isThirdPartyBare(spec)) continue;
      const rel = file.slice(REPO_ROOT.length + 1);
      const list = found.get(spec) ?? [];
      if (!list.includes(rel)) list.push(rel);
      found.set(spec, list);
    }
  }

  it('finds the known createRequire third-party deps (scanner sanity)', () => {
    // If this ever goes empty the scanner silently broke and the guard below is
    // a no-op — fail loudly instead. rrule + luxon both live in
    // harness/routines/schedule-next.ts.
    expect([...found.keys()].sort()).toEqual(expect.arrayContaining(['luxon', 'rrule']));
  });

  it('every createRequire third-party dep is copied into the .deb sidecar', () => {
    const script = readFileSync(BUILD_SCRIPT, 'utf8');
    const copied = copiedPackages(script);

    const missing = [...found.entries()]
      .filter(([spec]) => !copied.has(spec))
      .map(([spec, where]) => `${spec} (loaded in ${where.join(', ')})`);

    expect(
      missing,
      `These bare modules are loaded via createRequire in operator-core but are NOT ` +
        `copied into the desktop sidecar by build-desktop-sidecar.sh. esbuild can't ` +
        `follow a createRequire call, so they will be MISSING from the packaged .deb ` +
        `and crash boot with "Cannot find module" → EMBEDDED_PG_FAILED. Add a ` +
        `\`copy_pkg_closure <name>\` line (next to the rrule/luxon copies) for each:`,
    ).toEqual([]);
  });
});
