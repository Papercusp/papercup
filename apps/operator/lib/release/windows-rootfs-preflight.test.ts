/**
 * windows-rootfs-preflight.test — EI-20547482952043431.
 *
 * The 0.0.17-alpha cut lost its Windows leg to a missing WSL rootfs
 * (src-tauri/resources/papercup-runtime.tar.gz), and that single missing file was
 * about to destroy TWO healthy legs: release-local.sh's join_leg() does a hard
 * `exit 1` on any leg's nonzero rc, the legs run in PARALLEL, and the win leg is
 * joined BEFORE mac. At the moment of the abort the linux leg had already produced
 * a signed 3.34GB .deb.
 *
 * The tarball is GITIGNORED, so it is a build artifact that lives only in whichever
 * checkout last ran scripts/build-rootfs.sh — and every release cut runs from a FRESH
 * `git worktree`, which by construction never receives it. So this was not a fluke:
 * it was reachable by every worktree-based cut, and it failed ~10 minutes in, inside
 * the leg, rather than in the seconds-long preflight zone where it was knowable.
 *
 * What this pins is therefore an ORDERING property, which is the part that actually
 * cost the money: the rootfs must be settled BEFORE any leg is launched. A test that
 * merely asserted "a rootfs check exists somewhere" would have passed against the
 * broken tree, because the in-leg check at build-windows-cross.sh:161 already existed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOTFS_ARTIFACT = 'papercup-runtime.tar.gz';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'release-local.sh'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate a repo root containing papercusp-desktop/bin/release-local.sh');
}

const root = repoRoot();
// Subject paths are overridable so falsifiability can be proven against a MUTATED COPY
// outside the tree (scripts/mutation-probe.sh, tier 2). Without this the only way to
// prove these assertions can fail would be to mutate the shared checkout — which
// git-sync can commit mid-probe, and has.
const releaseLocalPath =
  process.env.PROBE_RELEASE_LOCAL ?? join(root, 'papercusp-desktop/bin/release-local.sh');
const winCrossPath =
  process.env.PROBE_WIN_CROSS ?? join(root, 'papercusp-desktop/bin/build-windows-cross.sh');
const releaseLocal = readFileSync(releaseLocalPath, 'utf8');
const winCross = readFileSync(winCrossPath, 'utf8');

describe('windows WSL-rootfs preflight', () => {
  // CALIBRATION. Every ordering assertion below is only as good as these two anchors:
  // if either marker is renamed, indexOf() returns -1 and a naive `preflight < launch`
  // comparison silently PASSES (-1 < anything). These cases make that a failure instead.
  it('the anchors this file reasons about still exist', () => {
    expect(releaseLocal).toContain('WIN_PID=$!');
    expect(releaseLocal).toContain(ROOTFS_ARTIFACT);
  });

  it('settles the rootfs BEFORE any build leg is launched, not inside the win leg', () => {
    // Anchor on the executable assignment, never a comment: a stray mention of the
    // artifact in a header comment must not be able to satisfy this.
    const preflightAt = releaseLocal.indexOf(`rootfs_tarball="$ROOT/src-tauri/resources/${ROOTFS_ARTIFACT}"`);
    const winLegLaunchAt = releaseLocal.indexOf('WIN_PID=$!');

    expect(preflightAt, 'release-local.sh has no executable WSL-rootfs preflight').toBeGreaterThan(-1);
    expect(winLegLaunchAt, 'could not find the win leg launch').toBeGreaterThan(-1);
    expect(
      preflightAt,
      'the WSL-rootfs preflight must run BEFORE the win leg is launched — otherwise a missing ' +
        'rootfs is only discovered ~10min in, and join_leg aborts the whole cut, reaping the ' +
        'healthy linux/mac legs with it',
    ).toBeLessThan(winLegLaunchAt);
  });

  it('verifies the rootfs against the TRACKED stamp rather than mere existence', () => {
    // Existence-only was the original bug's other half: nothing compared the tarball to
    // .rootfs-build-stamp, so a STALE rootfs could be packed into an installer silently.
    // The stamp is tracked, so the pinned commit certifies the bytes — that is what makes
    // hydrating a donor copy safe instead of a guess.
    expect(releaseLocal).toContain('rootfsSha256');
    expect(releaseLocal).toContain('.rootfs-build-stamp');
  });

  it('keeps the in-leg check as the backstop', () => {
    // Defence in depth: the preflight is the cheap early failure, but the leg must still
    // refuse to build without the rootfs (e.g. when invoked directly, outside a cut).
    expect(winCross).toContain(ROOTFS_ARTIFACT);
  });
});
