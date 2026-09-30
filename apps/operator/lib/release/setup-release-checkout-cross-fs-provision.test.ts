/**
 * WI-10004073: setup-release-checkout.sh block 3b provisions the gitignored runtime
 * assets under apps/operator/public (wake-runtime, vad-runtime, vditor, porcupine,
 * monaco) into the release root. Every copy path must produce the SAME tree as the
 * hard-link path. (Block 3b's other behaviour is covered by
 * setup-release-checkout-runtime-assets.test.ts.)
 *
 * The defect: `cp -al SRC DST || cp -a SRC DST`. Across filesystems `cp -al` fails
 * with EXDEV only AFTER it has created DST, so the `cp -a` fallback copied INTO that
 * directory and produced DST/<basename>/… . A /mnt/data release root shipped
 * spa/wake-runtime with no top-level ORT files, and every gate passed it.
 *
 * These tests source the shipped `provision_runtime_asset()` out of the script (the
 * sed extraction setup-release-checkout-deps.test.ts uses) and force the
 * cross-filesystem failure with a PATH shim: `cp -al` creates DST and then exits 1,
 * which is what EXDEV-after-mkdir looks like to the caller. The calibration case
 * proves the shim reproduces the old bug, so a green run cannot come from a shim
 * that never fails.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Overridable so scripts/mutation-probe.sh can point the suite at an out-of-tree copy. */
const SCRIPT_PATH =
  process.env.PROBE_SCRIPT ?? join(__dirname, '../../bin/release/setup-release-checkout.sh');

/**
 * Deliberately WRONG control: the pre-fix fallback, kept here permanently so the
 * suite can prove its shim reproduces the nesting. Never used as the subject.
 */
const OLD_FALLBACK =
  'old_fallback() { mkdir -p "$(dirname "$2")"; cp -al "$1" "$2" 2>/dev/null || cp -a "$1" "$2" 2>/dev/null; }';

let work: string;

/** Sorted relative file list of a tree, so two trees compare by shape. */
function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/**
 * A `cp` shim. Mode `exdev`: `cp -al SRC DST` creates DST (as the real EXDEV failure
 * does) and exits 1; every other invocation delegates to the real cp. Mode `allfail`:
 * every cp creates its target directory and exits 1.
 */
function writeCpShim(binDir: string, mode: 'exdev' | 'allfail'): void {
  mkdirSync(binDir, { recursive: true });
  const realCp = spawnSync('bash', ['-c', 'command -v cp'], { encoding: 'utf8' }).stdout.trim();
  const shim = [
    '#!/usr/bin/env bash',
    'last="${@: -1}"',
    mode === 'allfail'
      ? 'mkdir -p "$last"; exit 1'
      : 'if [ "$1" = "-al" ]; then mkdir -p "$last"; exit 1; fi',
    `exec ${realCp} "$@"`,
  ].join('\n');
  writeFileSync(join(binDir, 'cp'), shim);
  chmodSync(join(binDir, 'cp'), 0o755);
}

/** Run a bash snippet with the shipped function sourced and an optional cp shim first on PATH. */
function runBash(snippet: string, shimDir?: string, extraEnv: Record<string, string> = {}) {
  const wrapper = [
    'set -uo pipefail',
    'source <(sed -n "/^provision_runtime_asset()/,/^}/p" "$SETUP_SCRIPT")',
    OLD_FALLBACK,
    snippet,
  ].join('\n');
  return spawnSync('bash', ['-c', wrapper], {
    env: {
      ...process.env,
      ...extraEnv,
      SETUP_SCRIPT: SCRIPT_PATH,
      PATH: shimDir ? `${shimDir}:${process.env.PATH}` : (process.env.PATH ?? ''),
    },
    encoding: 'utf8',
  });
}

/** An ORT-runtime-shaped source directory, like apps/operator/public/wake-runtime. */
function makeSource(): string {
  const src = join(work, 'integration/apps/operator/public/wake-runtime');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'ort-wasm-simd-threaded.jsep.mjs'), 'jsep');
  writeFileSync(join(src, 'ort-wasm-simd-threaded.wasm'), 'wasm');
  mkdirSync(join(src, 'models'));
  writeFileSync(join(src, 'models/silero.onnx'), 'onnx');
  return src;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'provision-runtime-asset-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('provision_runtime_asset — cross-filesystem copy parity (WI-10004073)', () => {
  it('is extractable from the shipped script', () => {
    const r = runBash('declare -F provision_runtime_asset');
    expect(r.status, r.stderr).toBe(0);
  });

  it('calibration: the shim reproduces the old cross-filesystem nesting', () => {
    const src = makeSource();
    const dst = join(work, 'release/apps/operator/public/wake-runtime');
    const shim = join(work, 'shim');
    writeCpShim(shim, 'exdev');
    const r = runBash('old_fallback "$SRC" "$DST"', shim, { SRC: src, DST: dst });
    expect(r.status, r.stderr).toBe(0);
    expect(listTree(dst)).toContain('wake-runtime/ort-wasm-simd-threaded.jsep.mjs');
    expect(existsSync(join(dst, 'ort-wasm-simd-threaded.jsep.mjs'))).toBe(false);
  });

  it('produces the same tree as the source when the hard-link attempt fails part-way', () => {
    const src = makeSource();
    const dst = join(work, 'release/apps/operator/public/wake-runtime');
    const stage = join(work, 'release/.provision-stage');
    const shim = join(work, 'shim');
    writeCpShim(shim, 'exdev');
    const r = runBash('provision_runtime_asset "$SRC" "$DST"', shim, {
      SRC: src,
      DST: dst,
      PROVISION_STAGE_DIR: stage,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(listTree(dst)).toEqual(listTree(src));
    expect(existsSync(join(dst, 'wake-runtime'))).toBe(false);
    expect(readdirSync(stage)).toEqual([]);
  });

  it('produces the same tree via the hard-link path', () => {
    const src = makeSource();
    const dst = join(work, 'release/apps/operator/public/wake-runtime');
    const r = runBash('provision_runtime_asset "$SRC" "$DST"', undefined, { SRC: src, DST: dst });
    expect(r.status, r.stderr).toBe(0);
    expect(listTree(dst)).toEqual(listTree(src));
    expect(readdirSync(join(work, 'release/apps/operator/public'))).toEqual(['wake-runtime']);
  });

  it('provisions a single file asset the same way', () => {
    const srcDir = join(work, 'integration/apps/operator/public/porcupine');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'porcupine_params.pv'), 'pv');
    const dst = join(work, 'release/apps/operator/public/porcupine/porcupine_params.pv');
    const shim = join(work, 'shim');
    writeCpShim(shim, 'exdev');
    const r = runBash('provision_runtime_asset "$SRC" "$DST"', shim, {
      SRC: join(srcDir, 'porcupine_params.pv'),
      DST: dst,
      PROVISION_STAGE_DIR: join(work, 'release/.provision-stage'),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(join(work, 'release/apps/operator/public/porcupine'))).toEqual(['porcupine_params.pv']);
  });

  it('fails without leaving a destination or a partial tree when every copy fails', () => {
    const src = makeSource();
    const dst = join(work, 'release/apps/operator/public/wake-runtime');
    const stage = join(work, 'release/.provision-stage');
    const shim = join(work, 'shim');
    writeCpShim(shim, 'allfail');
    const r = runBash('provision_runtime_asset "$SRC" "$DST"', shim, {
      SRC: src,
      DST: dst,
      PROVISION_STAGE_DIR: stage,
    });
    expect(r.status).toBe(1);
    expect(existsSync(dst)).toBe(false);
    expect(readdirSync(stage)).toEqual([]);
  });

  it('the 3b loop routes every asset through provision_runtime_asset', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    const loop = source.slice(source.indexOf('PUBLIC_ASSET_REL="apps/operator/public"'));
    expect(loop).toMatch(/if provision_runtime_asset "\$_asset_src" "\$_asset_dst"; then/);
    expect(loop.slice(0, 1500)).not.toMatch(/cp -al "\$_asset_src"/);
  });
});
