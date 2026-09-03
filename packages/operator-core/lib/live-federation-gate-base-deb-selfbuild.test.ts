/**
 * live-federation-gate-base-deb-selfbuild.test.ts — regression guard for WI-2143486.
 *
 * THE BUG (two independent faults, same outcome: the gate could never obtain a base package).
 *
 * The gate repacks a Package=papercusp-gui .deb. When none is on disk, EI-21713671250062619 added
 * a bounded self-build hatch: build one, then re-select. From 2026-08-28 the hatch failed EVERY
 * window, so the gate reported `BLOCKED (base-package-missing)`, never stamped last-green, and the
 * WI-261/P-013 staleness sentinel correctly fired at 150h+. Both faults are the same species — an
 * instrument answering a NARROWER question than the one asked, and reporting it as the answer:
 *
 *  1. EXIT CODE READ AS ARTIFACT EXISTENCE. tauri.conf.json sets bundle.createUpdaterArtifacts, so
 *     `tauri build` signs the updater artifact AFTER the .deb is bundled. The signing step failed
 *     (see 2), exiting non-zero with a COMPLETE, repackable .deb already on disk. The hatch read
 *     that exit code as "no artifact" and threw the artifact away:
 *
 *         if ( cd "$DESKTOP_DIR" && npm run build ); then <re-select> else log "BUILD FAILED" fi
 *
 *     Measured 2026-09-03 in the gate's own base-build.log: "Bundling Papercusp GUI_0.0.18_amd64.deb
 *     … Finished 1 bundle at: …" followed by a non-zero exit. The gate then burned a full rebuild
 *     every window and still declared itself artifact-less.
 *
 *  2. THE SIGNING FAILURE ITSELF, and it is a PARTIAL FIX regressing. bin/build-deb-repacked.sh
 *     defaults TAURI_SIGNING_PRIVATE_KEY (landed 2026-09-02 for this very class) but did NOT
 *     default TAURI_SIGNING_PRIVATE_KEY_PASSWORD. Unset, Tauri's signer PROMPTS; on a tty-less
 *     systemd oneshot the prompt cannot be read and the build dies with "incorrect updater private
 *     key password: No such device or address (os error 6)" — a message that blames the password's
 *     CONTENT when nothing could be READ. Its sibling bin/build-and-archive-deb.sh has always
 *     exported the password. Verified 2026-09-03 with same-capability controls against the real key
 *     in a tty-less process: exported-empty SIGNS; unset reproduces that exact error string.
 *
 *  3. (Same wake, same block.) CARGO_TARGET_ROOT was `${CARGO_TARGET_DIR:-$HOME/.cargo-target}` —
 *     one of cargo's INPUTS, not its effective output. ~/.cargo/config.toml's `target-dir` moved
 *     the real target directory to /mnt/data/cargo-target on 2026-09-03, so every candidate glob
 *     pointed at a different filesystem holding no bundle dir, and the selector reported "no
 *     candidate" for an artifact that existed. Reproduced directly: the derived root selects
 *     Package=papercusp-gui; the old expression returns "FATAL: no Debian package with
 *     Package=papercusp-gui among 1 existing candidate(s)" — the gate's exact observed failure.
 *
 * THE FIX: export the signing password at source; ask cargo for its effective target_directory;
 * and re-select UNCONDITIONALLY, letting the selector — which reads each candidate's own Debian
 * Package field — be the authority on what exists. The build's exit code is kept as diagnostics.
 *
 * WHY BOTH 1 AND 2 ARE FIXED, not just the root cause: fixing only the signing leaves the gate one
 * unrelated late-stage build failure away from discarding a produced artifact again. Fault 1 is the
 * CLASS; fault 2 was merely this instance of it.
 *
 * STATIC leg: pins the password export before the tauri invocation, the derived target dir, the
 * single shared selector helper, and the absence of the exit-code gate.
 * BEHAVIORAL leg: evals the REAL extracted hatch out of the shipping script under bash, driving the
 * REAL fed_select_newest_deb_by_package over REAL fixture .debs, with `npm` stubbed to reproduce
 * "bundle succeeds, then exit 1". Includes a PERMANENT deliberately-wrong control (the pre-fix
 * exit-code-gated shape) so falsifiability is proved without ever mutating the shared tree.
 *
 *   cd packages/operator-core && npx vitest run lib/live-federation-gate-base-deb-selfbuild.test.ts
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'live-federation-gate.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'could not locate the repo root (no papercusp-desktop/bin/live-federation-gate.sh above this test)',
  );
}

const ROOT = repoRoot();
// Subject paths are overridable so falsifiability can also be proved against a FROZEN snapshot
// (scripts/mutation-probe.sh --against-last-without) rather than by mutating the shared tree.
const GATE_PATH =
  process.env.PROBE_GATE_SCRIPT ?? join(ROOT, 'papercusp-desktop', 'bin', 'live-federation-gate.sh');
const REPACK_PATH =
  process.env.PROBE_REPACK_SCRIPT ??
  join(ROOT, 'papercusp-desktop', 'bin', 'build-deb-repacked.sh');
const ASSERTS_PATH = join(ROOT, 'papercusp-desktop', 'bin', 'lib', 'federation-asserts.sh');

const gate = readFileSync(GATE_PATH, 'utf8');
const repack = readFileSync(REPACK_PATH, 'utf8');
const asserts = readFileSync(ASSERTS_PATH, 'utf8');

/** A shell function definition, extracted by name from column-0 or indented source. */
function extractFn(src: string, name: string, indent = ''): string {
  const re = new RegExp(`^${indent}${name}\\(\\) \\{\\n[\\s\\S]*?\\n${indent}\\}$`, 'm');
  const m = src.match(re);
  expect(m?.[0], `could not extract shell function ${name}() from the source`).toBeTruthy();
  return m![0];
}

/** The REAL self-build hatch: build → (re-select regardless of rc) → give up only if none found. */
function extractSelfBuildHatch(): string {
  const m = gate.match(/^ {8}BASE_BUILD_RC=0\n[\s\S]*?\n {8}fi$/m);
  expect(
    m?.[0],
    'could not extract the self-build hatch (BASE_BUILD_RC=0 … fi) from the gate source — ' +
      'if the block was restructured, re-point this extractor at it rather than deleting the guard',
  ).toBeTruthy();
  return m![0];
}

/**
 * Build the bash harness that runs a candidate hatch implementation against real fixtures.
 * `hatch` is the shell text under test — either the shipped one, or the pre-fix control.
 */
function runHatch(hatch: string, opts: { buildExit: number; producesDeb: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'wi2143486-'));
  const debDir = join(dir, 'cargo', 'release', 'bundle', 'deb');
  const stubBin = join(dir, 'bin');
  mkdirSync(debDir, { recursive: true });
  mkdirSync(stubBin, { recursive: true });
  mkdirSync(join(dir, 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'deb'), {
    recursive: true,
  });
  mkdirSync(join(dir, 'work'), { recursive: true });

  // A stub `npm` reproducing the observed reality: the bundle IS written, then the run exits
  // non-zero on the trailing updater-signature step.
  const mkdeb = `
    root="$1"; pkg="$2"; out="$3"
    mkdir -p "$root/DEBIAN"
    printf 'Package: %s\\nVersion: 0.0.18\\nArchitecture: amd64\\nMaintainer: t <t@t>\\nDescription: fixture\\n' "$pkg" > "$root/DEBIAN/control"
    dpkg-deb --build "$root" "$out" >/dev/null 2>&1
  `;
  writeFileSync(
    join(stubBin, 'npm'),
    `#!/usr/bin/env bash\n${
      opts.producesDeb
        ? `mkdeb() {${mkdeb}}\nmkdeb "$(mktemp -d)/pkg" papercusp-gui ${JSON.stringify(
            join(debDir, 'Papercusp GUI_0.0.18_amd64.deb'),
          )}\n`
        : ''
    }echo "Bundling Papercusp GUI_0.0.18_amd64.deb"\necho "incorrect updater private key password: No such device or address (os error 6)" >&2\nexit ${opts.buildExit}\n`,
    { mode: 0o755 },
  );
  chmodSync(join(stubBin, 'npm'), 0o755);

  const script = `
set -u
export PATH=${JSON.stringify(stubBin)}:$PATH
DESKTOP_DIR=${JSON.stringify(join(dir, 'desktop'))}
CARGO_TARGET_ROOT=${JSON.stringify(join(dir, 'cargo'))}
WORK=${JSON.stringify(join(dir, 'work'))}
log() { echo "[log] $*"; }
${extractFn(asserts, 'fed_select_newest_deb_by_package')}
${extractFn(gate, 'gate_select_base_gui_deb', '    ')}
BASE_DEB=""
${hatch}
echo "RESULT_BASE_DEB=$BASE_DEB"
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60_000 });
}

/**
 * PERMANENT deliberately-wrong control: the pre-fix shape, kept in the test file forever so the
 * behavioral assertions below are provably falsifiable WITHOUT mutating the shared tree
 * (git-sync sweeps the whole checkout on a schedule; an in-tree mutant can be committed).
 */
const PRE_FIX_EXIT_CODE_GATED_HATCH = `
        if ( cd "$DESKTOP_DIR" && npm run build ) >"$WORK/base-build.log" 2>&1; then
          if BASE_DEB="$(gate_select_base_gui_deb)"; then
            log "fresh base .deb built and selected: $BASE_DEB"
          else
            log "built a Debian bundle but no fresh candidate matched — giving up"
            BASE_DEB=""
          fi
        else
          log "BUILD FAILED building a fresh base .deb — giving up"
        fi
`;

describe('live-federation gate: the base-.deb self-build hatch (WI-2143486)', () => {
  describe('static — build-deb-repacked.sh must be non-interactive-safe', () => {
    it('THE BUG: it exports the signing PASSWORD, not just the signing KEY', () => {
      expect(
        /^export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="\$\{TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-\}"$/m.test(
          repack,
        ),
        'build-deb-repacked.sh must export TAURI_SIGNING_PRIVATE_KEY_PASSWORD (defaulting to empty) ' +
          'or Tauri prompts for it and every tty-less caller — the systemd gate, CI, a detached agent ' +
          'shell — dies with "No such device or address (os error 6)" AFTER bundling a usable .deb.',
      ).toBe(true);
    });

    it('the password is exported BEFORE the tauri invocation that consumes it', () => {
      const pw = repack.indexOf('export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=');
      const build = repack.search(/^tauri "\$TAURI_SUBCOMMAND"/m);
      expect(pw).toBeGreaterThan(-1);
      expect(build).toBeGreaterThan(-1);
      expect(pw, 'the export must precede the tauri build call to have any effect').toBeLessThan(
        build,
      );
    });

    it('it still parses (bash -n) after the edit', () => {
      expect(() =>
        execFileSync('bash', ['-n', REPACK_PATH], { encoding: 'utf8', timeout: 30_000 }),
      ).not.toThrow();
    });
  });

  describe('static — the gate looks where cargo actually writes', () => {
    it('THE BUG: CARGO_TARGET_ROOT is DERIVED from cargo, not guessed from one of its inputs', () => {
      expect(
        /cargo metadata --no-deps --format-version 1/.test(gate),
        'the gate must ask cargo for its effective target_directory; reading only CARGO_TARGET_DIR ' +
          'misses ~/.cargo/config.toml target-dir and silently blinds the base-.deb selector.',
      ).toBe(true);
    });

    it('the historical expression survives only as a FALLBACK, never as the primary', () => {
      const derived = gate.search(/CARGO_TARGET_ROOT="\$\(\n\s*cd "\$DESKTOP_DIR\/src-tauri"/);
      const fallback = gate.indexOf('CARGO_TARGET_ROOT="${CARGO_TARGET_DIR:-$HOME/.cargo-target}"');
      expect(derived, 'the derived assignment must exist').toBeGreaterThan(-1);
      if (fallback > -1) {
        expect(
          fallback,
          'the env-var expression must come AFTER the derivation (fallback), not before it',
        ).toBeGreaterThan(derived);
      }
    });

    it('one shared selector helper — the two probe sites cannot drift apart', () => {
      expect(/^ {4}gate_select_base_gui_deb\(\) \{$/m.test(gate)).toBe(true);
      const calls = gate.match(/gate_select_base_gui_deb\)/g) ?? [];
      expect(
        calls.length,
        'both the pre-build probe and the post-build re-select must call the shared helper',
      ).toBeGreaterThanOrEqual(2);
    });

    it('the script still parses (bash -n) after the edit', () => {
      expect(() =>
        execFileSync('bash', ['-n', GATE_PATH], { encoding: 'utf8', timeout: 30_000 }),
      ).not.toThrow();
    });
  });

  describe('static — the re-select is not gated on the build exit code', () => {
    it('THE BUG: no `if ( … npm run build ); then <select>` shape survives', () => {
      expect(
        /if \( cd "\$DESKTOP_DIR" && npm run build \)[^\n]*; then/.test(gate),
        'the re-select must not sit inside the build\'s success branch: `tauri build` signs the ' +
          'updater artifact AFTER bundling, so a non-zero exit routinely accompanies a complete .deb.',
      ).toBe(false);
    });

    it('the exit code is captured for diagnostics rather than used as a gate', () => {
      expect(/BASE_BUILD_RC=0/.test(gate)).toBe(true);
      expect(/\|\| BASE_BUILD_RC=\$\?/.test(gate)).toBe(true);
    });
  });

  describe('behavioral — the REAL hatch, over REAL fixture .debs', () => {
    it('THE BUG: build exits non-zero but produced the .deb ⇒ it is STILL selected', () => {
      const out = runHatch(extractSelfBuildHatch(), { buildExit: 1, producesDeb: true });
      expect(out).toMatch(/RESULT_BASE_DEB=.*Papercusp GUI_0\.0\.18_amd64\.deb/);
      expect(out, 'the non-zero exit must be reported, not silently ignored').toMatch(
        /base build exited 1 — re-selecting anyway/,
      );
    });

    it('POSITIVE CONTROL: a clean build (rc=0) still selects the artifact', () => {
      const out = runHatch(extractSelfBuildHatch(), { buildExit: 0, producesDeb: true });
      expect(out).toMatch(/RESULT_BASE_DEB=.*Papercusp GUI_0\.0\.18_amd64\.deb/);
    });

    it('NEGATIVE CONTROL: a build that produces NOTHING still yields no base .deb', () => {
      const out = runHatch(extractSelfBuildHatch(), { buildExit: 1, producesDeb: false });
      expect(out).toMatch(/RESULT_BASE_DEB=$/m);
      expect(out).toMatch(/no Package=papercusp-gui candidate matched/);
    });

    it('FALSIFIABILITY: the pre-fix exit-code-gated shape FAILS the first assertion', () => {
      const out = runHatch(PRE_FIX_EXIT_CODE_GATED_HATCH, { buildExit: 1, producesDeb: true });
      // The artifact exists on disk, yet the pre-fix shape discards it — this is precisely the
      // bug, reproduced. If this ever starts selecting the .deb, the guard above proves nothing.
      expect(out).toMatch(/RESULT_BASE_DEB=$/m);
      expect(out).toMatch(/BUILD FAILED/);
    });
  });
});
