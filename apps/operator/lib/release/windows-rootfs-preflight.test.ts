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

// EVERY leg-launch site, not just the Windows one. The win leg is the one the rootfs
// gates, but it is NOT the first leg launched — linux is (release-local.sh:1142), and at
// the moment of the 0.0.17 abort the linux leg had already produced a signed 3.34GB .deb.
// So a preflight that merely precedes `WIN_PID=$!` would still permit the exact loss this
// item is about: it could sit between the linux launch and the win launch, exit 1, and
// reap a leg that was already ~10 minutes into real work. The property worth pinning is
// therefore "before the FIRST leg", which is what `Math.min` over these anchors expresses.
const LEG_LAUNCH_ANCHORS = ['LINUX_PID=$!', 'ANDROID_PID=$!', 'WIN_PID=$!', 'MAC_PID=$!'] as const;

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
    for (const anchor of LEG_LAUNCH_ANCHORS) {
      // A renamed anchor must FAIL here rather than quietly weaken the ordering test
      // below — Math.min over a set containing -1 is -1, and `preflight < -1` is false,
      // so a missing anchor would read as a violation with a misleading message; a
      // missing anchor in a `>` comparison would pass vacuously. Neither is acceptable
      // without being told which anchor moved.
      expect(releaseLocal, `leg-launch anchor ${anchor} is gone — re-anchor this guard`).toContain(anchor);
    }
    expect(releaseLocal).toContain(ROOTFS_ARTIFACT);
  });

  it('settles the rootfs BEFORE the FIRST build leg is launched, not inside the win leg', () => {
    // Anchor on the executable assignment, never a comment: a stray mention of the
    // artifact in a header comment must not be able to satisfy this.
    const preflightAt = releaseLocal.indexOf(`rootfs_tarball="$ROOT/src-tauri/resources/${ROOTFS_ARTIFACT}"`);
    expect(preflightAt, 'release-local.sh has no executable WSL-rootfs preflight').toBeGreaterThan(-1);

    const launches = LEG_LAUNCH_ANCHORS.map((anchor) => ({ anchor, at: releaseLocal.indexOf(anchor) }));
    for (const { anchor, at } of launches) {
      expect(at, `could not find the ${anchor} leg launch`).toBeGreaterThan(-1);
    }
    const first = launches.reduce((a, b) => (a.at <= b.at ? a : b));

    expect(
      preflightAt,
      `the WSL-rootfs preflight must run BEFORE the FIRST leg is launched (${first.anchor}) — a ` +
        'preflight that only precedes the WIN launch still lets a missing rootfs exit 1 while an ' +
        'earlier leg is already building, and join_leg then aborts the whole cut and reaps it. In ' +
        '0.0.17 the linux leg had already produced a signed 3.34GB .deb when that happened.',
    ).toBeLessThan(first.at);
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
