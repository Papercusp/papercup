/**
 * android-versionname-preflight.test — EI-20547913278500965.
 *
 * The 0.0.17-alpha cut's Android leg died AFTER a full Gradle release build with
 * "APK versionName is 0.1.0, but requested release version is 0.0.17", because
 * android/app/build.gradle.kts hardcoded `versionName = "0.1.0"` while
 * tools/build-scripts/android-release-provenance.sh:66-67 asserts the packaged APK's
 * versionName EQUALS the requested version. The android leg is joined FATALLY
 * (join_leg), so that one line aborted the whole desktop cut.
 *
 * NOTE WHAT WAS ALREADY TRUE, because it is the reason this guard is shaped the way it
 * is: a check DID exist, and it was correct. It was simply POST-BUILD — reachable only
 * after ~10 minutes of Gradle work. So "assert that a versionName check exists" would
 * have passed against the broken tree. What actually cost the cut was WHERE the check
 * sat, so what this pins is again an ORDERING property: the assignment must be read
 * statically BEFORE any leg is launched, where the fix costs seconds.
 *
 * SIBLING-REPO DISCIPLINE: papercup-rust-mobile is NOT in this monorepo. A guard that
 * unconditionally read it would go RED wherever the sibling is absent (CI), red-pinning
 * the fleet gate for every unrelated change. So the assertions split by what they read:
 * everything about release-local.sh is in-repo and NON-SKIPPABLE, and only the assertions
 * that read the sibling can skip — never silently (vitest reports skips), and never at
 * all when PAPERCUSP_REQUIRE_MOBILE_SIBLING=1 demands them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RELEASE_VERSION_ENV = 'PAPERCUP_RELEASE_VERSION';

// Same anchor set, and the same reason, as windows-rootfs-preflight.test.ts: the android
// leg is NOT the first leg launched (linux is), so a preflight that merely preceded
// `ANDROID_PID=$!` could still exit 1 while the linux leg was already minutes into real
// work, and join_leg would reap it.
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
// Overridable so falsifiability can be proven against a MUTATED COPY outside the tree
// (scripts/mutation-probe.sh, tier 2) instead of mutating the shared checkout, which
// git-sync can commit mid-probe.
const releaseLocalPath =
  process.env.PROBE_RELEASE_LOCAL ?? join(root, 'papercusp-desktop/bin/release-local.sh');
const releaseLocal = readFileSync(releaseLocalPath, 'utf8');

/** Resolve the sibling mobile repo the way release-local.sh's resolve_mobile_root does. */
function resolveMobileRoot(): string | null {
  const explicit = process.env.PROBE_MOBILE_ROOT ?? process.env.PAPERCUSP_MOBILE_ROOT;
  if (explicit) return existsSync(explicit) ? explicit : null;
  let dir = root;
  for (let i = 0; i < 8; i += 1) {
    for (const cand of [join(dir, 'papercup-rust-mobile'), join(resolve(dir, '..'), 'papercup-rust-mobile')]) {
      if (existsSync(join(cand, 'crates')) || existsSync(join(cand, 'Makefile'))) return cand;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const mobileRoot = resolveMobileRoot();
const gradlePath = mobileRoot ? join(mobileRoot, 'android/app/build.gradle.kts') : null;
const sibling = gradlePath && existsSync(gradlePath) ? { gradlePath } : null;
const requireSibling = process.env.PAPERCUSP_REQUIRE_MOBILE_SIBLING === '1';

function analyzeVersionNameAssignments(gradle: string): {
  assignments: string[];
  hardcoded: string[];
} {
  const lines = gradle.split('\n').map((line) => line.replace(/\/\/.*$/, ''));
  const rows = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /versionName\s*=/.test(line));

  const derivesFromReleaseEnv = ({ line, index }: { line: string; index: number }): boolean => {
    if (line.includes(RELEASE_VERSION_ENV)) return true;

    const rhs = /versionName\s*=\s*([A-Za-z_]\w*)/.exec(line)?.[1];
    if (!rhs) return false;

    for (let bindingAt = index - 1; bindingAt >= 0; bindingAt -= 1) {
      const binding = new RegExp(`\\b(?:val|var)\\s+${rhs}\\s*=`).exec(lines[bindingAt]);
      if (!binding) continue;

      const baseIndent = lines[bindingAt].match(/^\s*/)?.[0].length ?? 0;
      const statement = [lines[bindingAt].trim()];
      for (let continuationAt = bindingAt + 1; continuationAt < index; continuationAt += 1) {
        const continuation = lines[continuationAt];
        if (!continuation.trim()) continue;
        const indent = continuation.match(/^\s*/)?.[0].length ?? 0;
        if (indent <= baseIndent) break;
        statement.push(continuation.trim());
      }
      return statement.join(' ').includes(RELEASE_VERSION_ENV);
    }
    return false;
  };

  return {
    assignments: rows.map(({ line }) => line),
    hardcoded: rows.filter((row) => !derivesFromReleaseEnv(row)).map(({ line }) => line),
  };
}

describe('android versionName preflight (in-repo — never skipped)', () => {
  it('the anchors this file reasons about still exist', () => {
    // CALIBRATION. indexOf() returns -1 for a renamed anchor, and `-1 < anything` is true,
    // so a naive ordering assertion would silently PASS against a tree whose anchors moved.
    for (const anchor of LEG_LAUNCH_ANCHORS) {
      expect(releaseLocal, `leg-launch anchor ${anchor} is gone — re-anchor this guard`).toContain(anchor);
    }
  });

  it('reads the Android versionName assignment BEFORE the FIRST build leg is launched', () => {
    // Anchor on the executable assignment, never a comment: the header comment above the
    // preflight names this same file, and a comment must not be able to satisfy the guard.
    const preflightAt = releaseLocal.indexOf('android_gradle="$MOBILE_ROOT/android/app/build.gradle.kts"');
    expect(
      preflightAt,
      'release-local.sh has no executable Android versionName preflight — a hardcoded versionName ' +
        'is then discoverable only ~10 minutes in, by the post-build provenance assertion, which ' +
        'fails the fatally-joined android leg and aborts the whole cut.',
    ).toBeGreaterThan(-1);

    const launches = LEG_LAUNCH_ANCHORS.map((anchor) => ({ anchor, at: releaseLocal.indexOf(anchor) }));
    for (const { anchor, at } of launches) {
      expect(at, `could not find the ${anchor} leg launch`).toBeGreaterThan(-1);
    }
    const first = launches.reduce((a, b) => (a.at <= b.at ? a : b));

    expect(
      preflightAt,
      `the Android versionName preflight must run BEFORE the FIRST leg is launched (${first.anchor}). ` +
        'A preflight that only precedes the ANDROID launch still permits the loss this guards: it ' +
        'would exit 1 while the linux leg was already building, and join_leg reaps it.',
    ).toBeLessThan(first.at);
  });

  it('gates the preflight on the android leg being enabled', () => {
    // A desktop-only cut (WITH_ANDROID=0 / PAPERCUSP_SKIP_MOBILE=1 / no sibling) must stay
    // legal. If this gate were dropped, every desktop-only cut would refuse on a sibling
    // repo it was never going to build.
    const preflightAt = releaseLocal.indexOf('android_gradle="$MOBILE_ROOT/android/app/build.gradle.kts"');
    const gateAt = releaseLocal.lastIndexOf('if [[ "$WITH_ANDROID" == "1" ]]; then', preflightAt);
    expect(gateAt, 'the versionName preflight is not gated on WITH_ANDROID=1').toBeGreaterThan(-1);
  });

  it('asserts the env-derived form rather than any versionName mention', () => {
    // The property is "tracks the release version this script itself supplies", so the
    // preflight must name that exact env var — not merely look for the word versionName.
    const preflightAt = releaseLocal.indexOf('android_gradle="$MOBILE_ROOT/android/app/build.gradle.kts"');
    const block = releaseLocal.slice(preflightAt, preflightAt + 3000);
    expect(block).toContain(RELEASE_VERSION_ENV);
    expect(block).toContain('versionName');
  });

  it('follows an env-derived local binding without accepting a hardcoded binding', () => {
    const envDerived = analyzeVersionNameAssignments(`
      val releaseVersion =
          System.getenv("${RELEASE_VERSION_ENV}") ?: "0.1.0"
      versionName = releaseVersion
    `);
    const hardcoded = analyzeVersionNameAssignments(`
      val releaseVersion = "0.1.0"
      versionName = releaseVersion
    `);

    expect(envDerived.hardcoded).toEqual([]);
    expect(hardcoded.hardcoded).toEqual(['      versionName = releaseVersion']);
  });
});

describe('android versionName preflight (reads the sibling repo)', () => {
  it('the sibling mobile repo is present, or this suite is explicitly not asserting it', () => {
    // EXPLICIT, never silent. Without this case a missing sibling would make the block
    // below vanish from the report and read as "verified" to anyone skimming a green run.
    if (!sibling) {
      expect(
        requireSibling,
        'papercup-rust-mobile is absent, so the sibling-reading assertions below are SKIPPED — ' +
          'the non-skippable release-local.sh assertions above still ran. Set ' +
          'PAPERCUSP_REQUIRE_MOBILE_SIBLING=1 to make this absence a failure.',
      ).toBe(false);
      return;
    }
    expect(existsSync(sibling.gradlePath)).toBe(true);
  });

  it.skipIf(!sibling)('derives versionName from the release-version env, in every assignment', () => {
    const gradle = readFileSync(sibling!.gradlePath, 'utf8');
    // Strip line comments before matching, and do NOT anchor to start-of-line: the
    // single-line flavor form `create("store") { versionName = "1.0.0" }` slips past a
    // `^\s*versionName` pattern (measured), and such an assignment overrides defaultConfig
    // in the packaged APK. Stripping `//` keeps a commented-out historical hardcode from
    // reading as a live violation.
    const { assignments, hardcoded } = analyzeVersionNameAssignments(gradle);

    expect(assignments.length, `no versionName assignment in ${sibling!.gradlePath}`).toBeGreaterThan(0);
    expect(
      hardcoded,
      `every versionName assignment must derive from ${RELEASE_VERSION_ENV}; a hardcoded one ` +
        'makes the post-build provenance assertion unsatisfiable and fails the whole cut',
    ).toEqual([]);
  });

  it.skipIf(!sibling)('keeps the post-build provenance assertion as the backstop', () => {
    // Defence in depth. The preflight reads SOURCE; only this assertion reads the BUILT
    // artifact, so it is the one that can catch a Gradle-side surprise (a manifest
    // override, a plugin rewriting the value) that static reading cannot see.
    const provenance = join(mobileRoot!, 'tools/build-scripts/android-release-provenance.sh');
    if (!existsSync(provenance)) {
      throw new Error(`expected the provenance script at ${provenance}`);
    }
    const text = readFileSync(provenance, 'utf8');
    expect(text).toContain('manifest version-name');
    expect(text).toContain('but requested release version is');
  });
});
