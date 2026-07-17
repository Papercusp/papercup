/**
 * EI-501 regression guard — the desktop sidecar bundle (.deb/.AppImage/…) must
 * ship opusscript's WASM binary asset (opusscript_native_wasm.wasm) alongside
 * serve.mjs.
 *
 * THE BUG CLASS: voice-node/codec.ts lazily `await import('opusscript')`s —
 * esbuild happily INLINES that pure-JS shim into serve.mjs like any other
 * dependency. But the shim's Emscripten wasm loader
 * (node_modules/opusscript/build/opusscript_native_wasm.js) resolves its
 * binary asset at RUNTIME off `__dirname + "/opusscript_native_wasm.wasm"` —
 * and because build-desktop-sidecar.sh's esbuild banner makes every inlined
 * module share serve.mjs's OWN `__dirname` (derived from
 * `fileURLToPath(import.meta.url)`), that lookup lands next to serve.mjs, not
 * inside node_modules/opusscript/build/. A binary asset like this can never be
 * traced or inlined by esbuild (it isn't a module import at all — it's a
 * runtime fs.readFileSync), so it needs an EXPLICIT copy in the build script,
 * the same class of gotcha as git-ext-bridge.mjs just above it in that file.
 * Without the copy, the packaged app hard-aborts the instant anything touches
 * the voice/Opus codec seam: "Aborted(Error: ENOENT: no such file or
 * directory, open '.../sidecar/opusscript_native_wasm.wasm')".
 *
 * THE GUARD: assert build-desktop-sidecar.sh actually stages
 * opusscript_native_wasm.wasm directly into $SIDECAR_DIR (i.e. next to
 * serve.mjs, not into a node_modules subpath) — and, as a canary, that
 * codec.ts still imports opusscript at all (so this guard doesn't silently
 * go stale if the codec seam is ever swapped for a different Opus impl).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LIB_DIR = import.meta.dirname ?? __dirname;
// operator-core/lib → operator-core → packages → repo root
const REPO_ROOT = join(LIB_DIR, '..', '..', '..');
const BUILD_SCRIPT = join(REPO_ROOT, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh');
const CODEC_FILE = join(LIB_DIR, 'voice-node', 'codec.ts');
// WI-3831: a release SOURCE BUNDLE excludes the whole `papercusp-desktop/` dir
// (the Tauri/Rust shell isn't shipped inside its own bundle target) — the
// build script this guard checks against is then genuinely absent.

describe.skipIf(!existsSync(BUILD_SCRIPT))('desktop sidecar opusscript wasm bundling (EI-501)', () => {
  it('codec.ts still imports opusscript (scanner sanity — keeps this guard from going stale)', () => {
    expect(existsSync(CODEC_FILE)).toBe(true);
    const src = readFileSync(CODEC_FILE, 'utf8');
    expect(src).toMatch(/import\(\s*['"]opusscript['"]\s*\)/);
  });

  it('build-desktop-sidecar.sh copies opusscript_native_wasm.wasm next to serve.mjs', () => {
    const script = readFileSync(BUILD_SCRIPT, 'utf8');
    // Must copy the wasm binary FROM an opusscript/build path INTO
    // $SIDECAR_DIR directly (not a node_modules subpath — codec.ts's runtime
    // __dirname lookup expects it as a sibling of serve.mjs).
    const copiesFromOpusscriptBuild = /opusscript\/build\/opusscript_native_wasm\.wasm/.test(script);
    const copiesToSidecarRoot = /cp\s+"\$_opus_wasm"\s+"\$SIDECAR_DIR\/opusscript_native_wasm\.wasm"/.test(script);

    expect(
      copiesFromOpusscriptBuild && copiesToSidecarRoot,
      'build-desktop-sidecar.sh must stage opusscript_native_wasm.wasm (from ' +
        'node_modules/opusscript/build/) directly into $SIDECAR_DIR, next to serve.mjs — ' +
        'without it the packaged app hard-aborts the instant the voice/Opus codec seam ' +
        'is touched (EI-501).',
    ).toBe(true);
  });

  it('the copy is fail-loud: the build aborts if the wasm is missing or the copy fails', () => {
    const script = readFileSync(BUILD_SCRIPT, 'utf8');
    // Same fail-loud convention as the git-ext-bridge.mjs copy right above it:
    // an ERROR + exit 1 if the source can't be found, and again if the copy
    // didn't land — never a silent skip that ships a broken voice codec.
    expect(script).toMatch(/opusscript_native_wasm\.wasm not found in any node_modules.*\n.*exit 1/);
    expect(script).toMatch(/failed to stage opusscript_native_wasm\.wasm.*\n.*exit 1/);
  });
});
