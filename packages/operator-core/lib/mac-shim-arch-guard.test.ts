/**
 * mac-shim-arch-guard.test.ts — regression guard for WI-484916.
 *
 * THE BUG: papercusp-desktop/bin/mac-vm-build.sh built the macOS embedded-terminal
 * shim universal, but degraded silently when that failed:
 *
 *   swift build -c release --arch x86_64 --arch arm64 \
 *     || { echo "universal shim build failed; retrying host-arch only"; swift build -c release; }
 *   ...
 *   lipo -info src-tauri/resources/libPapercuspTermShim.dylib || true
 *
 * Two independent failures compounding:
 *   1. a failed universal build fell back to a HOST-ARCH-ONLY dylib and kept going;
 *   2. the only architecture check was suffixed `|| true`, so its failure was
 *      unobservable — it printed, it never asserted.
 * Net effect: an x86_64-only terminal shim could be embedded in a
 * universal-apple-darwin bundle, load fine on Intel, and fail on Apple Silicon,
 * with every build reporting success.
 *
 * WHY NOTHING DOWNSTREAM CATCHES IT — the reason this guard has to exist:
 * the arm64 half of what we ship is executed by NOTHING in this project.
 * Measured 2026-08-28: the only Mac available is a native Intel VM (uname=x86_64,
 * sysctl.proc_translated unset so not Rosetta, hw.optional.arm64 absent,
 * "Intel Core Processor (Skylake)"); CI has ZERO macOS runners; and
 * mac-vm-verify-build.sh builds a DMG and copies it back without ever booting it.
 * So this contract is not one check among many for the Apple Silicon slice — it
 * is the only one.
 *
 * CLASS: the can-falsely-pass shape P-411/WI-5788 eliminated for rig scenarios,
 * one level up in the build path. Same rule: a probe that cannot fail is not a
 * check, and an UNMEASURED result is scored as FAIL, never silently as a pass.
 *
 * BEHAVIOURAL leg: sources the REAL shipping lib and runs its predicate against a
 * stubbed `lipo`, so the decision is exercised without macOS or a Mach-O file.
 * STATIC leg: pins that mac-vm-build.sh cannot reintroduce either half of the bug.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'lib', 'mac-shim-arch.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate the repo root (no papercusp-desktop/bin/lib/mac-shim-arch.sh above this test)');
}

const ROOT = repoRoot();
const LIB = join(ROOT, 'papercusp-desktop', 'bin', 'lib', 'mac-shim-arch.sh');
// Overridable so scripts/mutation-probe.sh can point the STATIC leg at a
// historical snapshot and prove this guard actually catches the pre-fix source,
// without ever mutating the shared tree (CLAUDE.md, "Proving a guard is
// falsifiable" — tier 2). Defaults to the real shipping script.
const BUILD_SH = process.env.PROBE_MAC_BUILD_SH ?? join(ROOT, 'papercusp-desktop', 'bin', 'mac-vm-build.sh');

/**
 * Run assert_shim_slices out of the REAL lib with `lipo` stubbed to report
 * `archs`. Passing archs=null makes the stub emit nothing and exit non-zero —
 * the UNMEASURED case, which must FAIL rather than pass vacuously.
 */
function assertSlices(archs: string | null, target: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shim-arch-'));
  const lipo = join(dir, 'lipo');
  writeFileSync(
    lipo,
    archs === null ? '#!/usr/bin/env bash\nexit 1\n' : `#!/usr/bin/env bash\necho "${archs}"\n`,
  );
  chmodSync(lipo, 0o755);
  const dylib = join(dir, 'libPapercuspTermShim.dylib');
  writeFileSync(dylib, 'not-a-real-macho');
  const res = spawnSync(
    'bash',
    ['-c', `source ${JSON.stringify(LIB)}; assert_shim_slices ${JSON.stringify(dylib)} ${JSON.stringify(target)}`],
    {
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    },
  );
  return { code: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function requiredSlices(target: string): string {
  const res = spawnSync(
    'bash',
    ['-c', `source ${JSON.stringify(LIB)}; required_shim_slices ${JSON.stringify(target)}`],
    { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' },
  );
  return (res.stdout ?? '').trim();
}

describe('WI-484916: the macOS term-shim slice contract', () => {
  it('derives the required slices from the TARGET, not the build host', () => {
    expect(requiredSlices('universal-apple-darwin')).toBe('x86_64 arm64');
    expect(requiredSlices('aarch64-apple-darwin')).toBe('arm64');
    expect(requiredSlices('x86_64-apple-darwin')).toBe('x86_64');
    // An unrecognised target enforces nothing rather than guessing.
    expect(requiredSlices('some-future-triple')).toBe('');
  });

  it('accepts a genuinely universal dylib for the universal ship target', () => {
    const { code } = assertSlices('x86_64 arm64', 'universal-apple-darwin');
    expect(code).toBe(0);
  });

  // THE REGRESSION. This is the exact artifact the old code shipped silently.
  it('REFUSES an x86_64-only dylib for the universal ship target', () => {
    const { code, out } = assertSlices('x86_64', 'universal-apple-darwin');
    expect(code).not.toBe(0);
    expect(out).toMatch(/MISSING a required slice/);
    expect(out).toMatch(/arm64/);
  });

  it('REFUSES an x86_64-only dylib when the target is explicitly aarch64', () => {
    const { code } = assertSlices('x86_64', 'aarch64-apple-darwin');
    expect(code).not.toBe(0);
  });

  it('accepts an x86_64-only dylib when the target really is x86_64-only', () => {
    const { code } = assertSlices('x86_64', 'x86_64-apple-darwin');
    expect(code).toBe(0);
  });

  // UNMEASURED must not be indistinguishable from OK — the `|| true` lesson.
  it('scores an unreadable lipo result as FAIL, not as a pass', () => {
    const { code, out } = assertSlices(null, 'universal-apple-darwin');
    expect(code).not.toBe(0);
    expect(out).toMatch(/UNMEASURED as FAIL/);
  });

  it('does not silently accept an empty arch list', () => {
    const { code } = assertSlices('', 'universal-apple-darwin');
    expect(code).not.toBe(0);
  });
});

describe('WI-484916: mac-vm-build.sh cannot reintroduce either half of the bug', () => {
  const build = readFileSync(BUILD_SH, 'utf8');

  it('never re-adds an unobservable `lipo ... || true` architecture probe', () => {
    // Comments describing the historical bug are fine; an executable line is not.
    const offending = build
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .filter((l) => /\blipo\b/.test(l) && /\|\|\s*true/.test(l));
    expect(offending).toEqual([]);
  });

  it('asserts the slices via the shared contract rather than inline ad-hoc logic', () => {
    expect(build).toMatch(/source "\$HERE\/lib\/mac-shim-arch\.sh"/);
    expect(build).toMatch(/assert_shim_slices .*\|\| exit 1/);
  });

  it('refuses the host-arch fallback when the target requires arm64', () => {
    // The fallback must be guarded by a required-slices test, not unconditional.
    expect(build).toMatch(/REQUIRED_SHIM_SLICES/);
    expect(build).toMatch(/Refusing the host-arch fallback/);
    const unconditional = /\|\|\s*\{\s*echo "universal shim build failed; retrying host-arch only"; swift build -c release; \}/;
    expect(build).not.toMatch(unconditional);
  });
});
