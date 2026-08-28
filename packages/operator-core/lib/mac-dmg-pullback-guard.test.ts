/**
 * mac-dmg-pullback-guard.test.ts — regression guard for WI-489075.
 *
 * THE BUG: papercusp-desktop/bin/mac-vm-verify-build.sh — the documented macOS
 * PUBLIC-RELEASE verification build — could not fail its own final step:
 *
 *   scp "$VM:.../$MAC_BUILD_TARGET/release/bundle/dmg/*.dmg" "$SCRATCH/dmg/" || true
 *   echo; echo "=== DMGs ==="; ls -la "$SCRATCH/dmg/" 2>/dev/null
 *   echo "=== BUILD DONE sha=$SHA ... ==="
 *
 * The script sets `set -uo pipefail` but deliberately NOT `-e`, so three things
 * compounded: the `|| true` swallowed a failed pull, the `2>/dev/null` listing
 * neither printed nor failed on an empty directory, and "BUILD DONE" was then
 * printed unconditionally before an exit 0. Any of — scp failure (VM down, key
 * rejected, network), a remote build that emitted no bundle, or a
 * MAC_BUILD_TARGET not matching the directory tauri actually bundled into —
 * produced a confident green "public-release verification" with ZERO artifacts
 * on disk. After the `mkdir -p "$SCRATCH/dmg"` the whole 169-line file contained
 * no existence, count, or size assertion of any kind.
 *
 * WHY NOTHING DOWNSTREAM CATCHES IT — the reason this guard has to exist:
 * the pull-back is the ONLY evidence this build produced a shippable artifact.
 * CI has zero macOS runners, the only Mac available is a native Intel VM, and
 * the script never boots what it retrieves. Nothing re-checks the DMG later, so
 * "the build reported success" was, in practice, the entire artifact contract.
 *
 * CLASS: EI-21713782985040786 — "required verification evidence is not a
 * mandatory predicate of success; unavailable or failed probes are converted
 * into a successful outer result." Sibling instance on the same build path:
 * WI-484916 / mac-shim-arch-guard.test.ts. Same rule both times: a probe that
 * cannot fail is not a check, and an UNMEASURED result is scored as FAIL.
 *
 * BEHAVIOURAL leg: sources the REAL shipping lib and runs its predicate against
 * real directories, so the decision is exercised with no Mac, no VM, no network.
 * STATIC leg: pins that mac-vm-verify-build.sh cannot reintroduce the bug.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'lib', 'mac-dmg-pullback.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate the repo root (no papercusp-desktop/bin/lib/mac-dmg-pullback.sh above this test)');
}

const ROOT = repoRoot();

// Both overridable so scripts/mutation-probe.sh can point a leg at a historical
// snapshot and prove this guard actually catches the pre-fix source, without
// ever mutating the shared tree (CLAUDE.md, "Proving a guard is falsifiable").
const LIB = process.env.PROBE_MAC_DMG_PULLBACK_SH
  ?? join(ROOT, 'papercusp-desktop', 'bin', 'lib', 'mac-dmg-pullback.sh');
const VERIFY_SH = process.env.PROBE_MAC_VERIFY_BUILD_SH
  ?? join(ROOT, 'papercusp-desktop', 'bin', 'mac-vm-verify-build.sh');

/** Run the REAL shipping predicate against a directory. */
function assertPullback(dir: string, target = 'universal-apple-darwin') {
  const r = spawnSync(
    'bash',
    ['-c', 'set -uo pipefail; source "$1"; assert_dmg_pullback "$2" "$3"', 'bash', LIB, dir, target],
    { encoding: 'utf8' },
  );
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'dmg-pullback-guard-'));
}

describe('WI-489075: the macOS release-artifact pull-back contract', () => {
  it('REFUSES an empty pull-back directory (the exact silent-green case)', () => {
    const dir = join(scratch(), 'dmg');
    mkdirSync(dir, { recursive: true });
    const { status, out } = assertPullback(dir);
    expect(status).not.toBe(0);
    expect(out).toMatch(/0 DMGs retrieved/);
  });

  it('names MAC_BUILD_TARGET when nothing was retrieved, since a target/bundle-dir mismatch is a real cause', () => {
    const dir = join(scratch(), 'dmg');
    mkdirSync(dir, { recursive: true });
    const { out } = assertPullback(dir, 'aarch64-apple-darwin');
    expect(out).toContain('aarch64-apple-darwin');
  });

  it('REFUSES a zero-byte DMG — a file that exists is not an artifact', () => {
    const dir = join(scratch(), 'dmg');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Papercusp.dmg'), '');
    const { status, out } = assertPullback(dir);
    expect(status).not.toBe(0);
    expect(out).toMatch(/zero bytes/);
  });

  it('REFUSES when any one of several DMGs is zero-byte, not just the first', () => {
    const dir = join(scratch(), 'dmg');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Papercusp.dmg'), 'realbytes');
    writeFileSync(join(dir, 'Papercusp-Server.dmg'), '');
    expect(assertPullback(dir).status).not.toBe(0);
  });

  it('accepts a genuine non-empty artifact and reports the count', () => {
    const dir = join(scratch(), 'dmg');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Papercusp.dmg'), 'realbytes');
    writeFileSync(join(dir, 'Papercusp-Server.dmg'), 'realbytes');
    const { status, out } = assertPullback(dir);
    expect(status).toBe(0);
    expect(out).toMatch(/2 artifact\(s\)/);
  });

  it('does not treat the literal unmatched glob as an artifact (no nullglob under bash 3.2)', () => {
    const dir = join(scratch(), 'dmg');
    mkdirSync(dir, { recursive: true });
    const { status, out } = assertPullback(dir);
    expect(status).not.toBe(0);
    expect(out).not.toMatch(/1 artifact/);
  });

  it('REFUSES a missing directory rather than reporting success', () => {
    expect(assertPullback(join(scratch(), 'never-created')).status).not.toBe(0);
  });
});

describe('WI-489075: mac-vm-verify-build.sh cannot reintroduce the silent-green pull-back', () => {
  const src = readFileSync(VERIFY_SH, 'utf8');

  it('never re-adds an unobservable `*.dmg ... || true` pull-back', () => {
    const offenders = src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .filter((l) => l.includes('.dmg') && /\|\|\s*(true|:)\s*$/.test(l));
    expect(offenders).toEqual([]);
  });

  it('asserts the artifact via the shared contract rather than inline ad-hoc logic', () => {
    expect(src).toContain('assert_dmg_pullback');
  });

  it('sources the contract it calls, so the call cannot be a no-op', () => {
    expect(src).toMatch(/source\s+"\$HERE\/lib\/mac-dmg-pullback\.sh"/);
  });

  it('does not announce BUILD DONE without an artifact assertion before it', () => {
    const done = src.indexOf('BUILD DONE');
    const assertAt = src.indexOf('assert_dmg_pullback "');
    expect(done).toBeGreaterThan(-1);
    expect(assertAt).toBeGreaterThan(-1);
    expect(assertAt).toBeLessThan(done);
  });
});
