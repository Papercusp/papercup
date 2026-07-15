/**
 * win-leg-build-timeout.test.ts — regression guard for EI-12902.
 *
 * The Windows release leg (papercusp-desktop/bin/build-windows-on-vm.sh) blocks
 * the whole cut on a single remote `ssh … vm-release-build.ps1` build, joined by
 * release-local.sh's bare `wait "$pid"`. It historically had NO build timeout at
 * all — only ssh keepalives (ConnectTimeout / ServerAliveInterval /
 * ServerAliveCountMax), which prove the VM's sshd still ANSWERS, not that the build
 * is PROGRESSING. So a wedged build (deadlocked/spinning ISCC, a full disk, a stuck
 * MSVC child) hung the ENTIRE cut forever, with no watchdog and no exit code. The
 * mac leg already carried a build timeout; this guard pins the win leg's PARITY so
 * a future edit cannot silently drop the bound again.
 *
 * These are STATIC assertions over the shell scripts (no VM, no real cut — the fix
 * cannot be exercised without a Windows VM build). Run:
 *   cd packages/operator-core && npx vitest run lib/win-leg-build-timeout.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'build-windows-on-vm.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'could not locate the repo root (no papercusp-desktop/bin/build-windows-on-vm.sh above this test)',
  );
}

const ROOT = repoRoot();
const winLeg = readFileSync(join(ROOT, 'papercusp-desktop', 'bin', 'build-windows-on-vm.sh'), 'utf8');
const releaseLocal = readFileSync(join(ROOT, 'papercusp-desktop', 'bin', 'release-local.sh'), 'utf8');

describe('EI-12902: the Windows leg bounds its remote build (mac parity)', () => {
  it('wraps the blocking build ssh in a `timeout` bounded by PAPERCUSP_WIN_BUILD_TIMEOUT_SEC', () => {
    // The remote build is `ssh … vm-release-build.ps1`. It MUST be bounded — a bare
    // blocking ssh hangs the leg (and, via join_leg's bare `wait`, the whole cut).
    expect(winLeg).toMatch(/timeout[^\n]*WIN_BUILD_TIMEOUT_SEC/);
    expect(winLeg).toMatch(/PAPERCUSP_WIN_BUILD_TIMEOUT_SEC/);
  });

  it('the `timeout` actually wraps the vm-release-build.ps1 invocation', () => {
    // Guards against the bound existing but being wired to the wrong command: a
    // `timeout … "${SSH[@]}" … vm-release-build.ps1` must appear together.
    expect(winLeg).toMatch(/timeout[\s\S]{0,320}vm-release-build\.ps1/);
  });

  it('on timeout it does NOT re-invoke and leaves the build for inspection (D-005 parity with mac)', () => {
    // Same reasoning the mac leg documents: a re-run doubles the wall clock, it does
    // not save it. On expiry we fail loudly and leave the VM build running.
    expect(winLeg).toMatch(/NOT re-invoking/i);
    expect(winLeg).toMatch(/exceeded the .*hard cap/i);
  });

  it('the backstop is generous enough not to kill a healthy (long) build', () => {
    // The correction on EI-12902 measured a healthy leg at ~5,000-6,000s+ (GUI ISCC
    // alone 2,557s). A naive small timeout would falsely kill good builds. The
    // default must sit well above that — the filing/correction floor is ≥7200s.
    const m = winLeg.match(/PAPERCUSP_WIN_BUILD_TIMEOUT_SEC:-(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(7200);
  });

  it('parity anchor: the mac leg carries a build timeout too (the shape this mirrors)', () => {
    // The invariant is "every VM leg that blocks the cut on a remote build carries a
    // build timeout". If this fails, the mac reference itself regressed.
    expect(releaseLocal).toMatch(/PAPERCUSP_MAC_BUILD_TIMEOUT_SEC/);
  });

  it('the misleading "several minutes" ISCC log line is corrected', () => {
    // The ISCC phase is ~40+ min at today's payload and block-buffers silently; the
    // old "several minutes" line actively misled operators into reading a normal
    // build as hung. The corrected line must name the real cost + the buffering.
    expect(winLeg).not.toContain('full seed stored raw; several minutes');
    expect(winLeg).toMatch(/block-buffer/i);
  });
});
