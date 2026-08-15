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

/**
 * WI-39339 — the SAME class as the rootfs above, for the Windows leg's host-capability
 * preconditions (cargo-xwin, the rustup target, wine, xvfb-run, ISCC, the signing key).
 * build-windows-cross.sh:139-149 already checked all six, but INSIDE the leg, which is
 * launched in parallel and joined fatally — so host state that could not change during the
 * cut was discovered ~10 minutes in and took the healthy legs down with it.
 */
describe('windows toolchain preflight', () => {
  // The executable anchor, never a comment — the block's header comment names these same
  // tools, so matching on prose would let a deleted preflight satisfy this guard.
  const PREFLIGHT_ANCHOR = 'win_missing=()';

  it('settles the Windows toolchain BEFORE the FIRST build leg is launched', () => {
    const preflightAt = releaseLocal.indexOf(PREFLIGHT_ANCHOR);
    expect(preflightAt, 'release-local.sh has no executable Windows toolchain preflight').toBeGreaterThan(-1);

    const launches = LEG_LAUNCH_ANCHORS.map((anchor) => ({ anchor, at: releaseLocal.indexOf(anchor) }));
    for (const { anchor, at } of launches) {
      expect(at, `could not find the ${anchor} leg launch`).toBeGreaterThan(-1);
    }
    const first = launches.reduce((a, b) => (a.at <= b.at ? a : b));
    expect(
      preflightAt,
      `the Windows toolchain preflight must run BEFORE the FIRST leg is launched (${first.anchor}) — ` +
        'a missing wine or an unprovisioned Inno prefix cannot change during a cut, so discovering ' +
        'it after a leg is already building buys nothing and costs every other leg.',
    ).toBeLessThan(first.at);
  });

  it('is gated on the windows leg being enabled and not reused', () => {
    // A desktop cut with WITH_WINDOWS=0, or a PAPERCUSP_REUSE_WIN=1 rerun that skips the
    // windows build entirely, must not be refused for a toolchain it will never invoke.
    const preflightAt = releaseLocal.indexOf(PREFLIGHT_ANCHOR);
    const gateAt = releaseLocal.lastIndexOf('if [[ "$WITH_WINDOWS" == "1"', preflightAt);
    expect(gateAt, 'the toolchain preflight is not gated on WITH_WINDOWS=1').toBeGreaterThan(-1);
    const gateLine = releaseLocal.slice(gateAt, releaseLocal.indexOf('\n', gateAt));
    expect(gateLine, 'the toolchain preflight must also skip a PAPERCUSP_REUSE_WIN=1 rerun').toContain(
      'PAPERCUSP_REUSE_WIN',
    );
  });

  it('reports EVERY missing prerequisite at once, not just the first', () => {
    // Failing on the first missing tool turns provisioning a fresh host into an N-cut
    // discovery loop. The accumulate-then-report shape is the property worth pinning.
    const preflightAt = releaseLocal.indexOf(PREFLIGHT_ANCHOR);
    const block = releaseLocal.slice(preflightAt, preflightAt + 3000);
    expect(block).toContain('win_missing+=(');
    expect(block).toContain('${#win_missing[@]}');
  });

  it('mirrors build-windows-cross.sh’s OWN path defaults, so the preflight and the leg agree', () => {
    // THE FAILURE THIS EXISTS FOR: the preflight re-derives ISCC/key/target paths that are
    // DEFINED in build-windows-cross.sh. If those defaults drift apart, the preflight happily
    // verifies one path while the leg uses another — a guard that passes while the leg dies,
    // which is strictly worse than no guard because it also buys false confidence.
    // Leading whitespace is allowed: release-local.sh's copies sit INDENTED inside the
    // `if [[ "$WITH_WINDOWS" == "1" ... ]]` block, while build-windows-cross.sh's are at
    // column 0. (A column-0-anchored pattern matched neither of the indented ones and the
    // calibration assertions below caught it — which is what they are there for.)
    const rhs = (text: string, name: string): string | null => {
      const m = text.match(new RegExp(`^[ \\t]*${name}="([^\\n]*)"$`, 'm'));
      return m ? m[1] : null;
    };
    // Normalise only the ONE legitimate difference: the two files name the wine-prefix
    // variable differently, and nothing else about the values may differ.
    const norm = (v: string | null): string | null =>
      v === null ? null : v.replace('$win_wineprefix_inno', '$WINEPREFIX_INNO');

    const pairs: Array<[string, string]> = [
      ['TARGET', 'win_target'],
      ['KEY_FILE', 'win_key_file'],
      ['WINEPREFIX_INNO', 'win_wineprefix_inno'],
      ['ISCC_EXE', 'win_iscc_exe'],
    ];
    for (const [legName, preflightName] of pairs) {
      const legValue = rhs(winCross, legName);
      const preflightValue = norm(rhs(releaseLocal, preflightName));
      // Calibration: a null on either side means the assignment was renamed, which would make
      // a bare equality check pass vacuously (null === null). Fail loudly instead.
      expect(legValue, `build-windows-cross.sh no longer defines ${legName} — re-anchor this guard`).not.toBeNull();
      expect(
        preflightValue,
        `release-local.sh no longer defines ${preflightName} — re-anchor this guard`,
      ).not.toBeNull();
      expect(
        preflightValue,
        `${preflightName} in release-local.sh has drifted from ${legName} in build-windows-cross.sh. ` +
          'The preflight would check a different path than the leg uses.',
      ).toBe(legValue);
    }
  });

  it('keeps the in-leg toolchain checks as the backstop', () => {
    // build-windows-cross.sh must stay safe to invoke directly, outside a cut, where no
    // preflight has run. This is defence in depth, not relocation.
    for (const needle of ['cargo-xwin', 'wine', 'xvfb-run', 'ISCC', 'signing key']) {
      expect(winCross, `in-leg check for ${needle} disappeared`).toContain(needle);
    }
  });
});
