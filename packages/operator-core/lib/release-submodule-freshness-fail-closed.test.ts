/**
 * release-submodule-freshness-fail-closed.test.ts — P-412 / WI-3047 hardening.
 *
 * papercusp-desktop/bin/release-local.sh refuses to cut a stable/beta release from a STALE
 * `libs/papercusp` submodule (the 2026-07-05 incident: a seeded Linux .deb shipped the
 * pre-505/506 schema). build-desktop-sidecar.sh's own WI-3047 check explicitly defers to this
 * one as "where that class is actually caught".
 *
 * THE BUG THIS PINS (found 2026-07-25, P-412): the guard had two fail-OPEN skip paths — a
 * failed `git fetch` and a non-git submodule dir both WARNed and CONTINUED on EVERY channel.
 * So a single transient network blip on the build box silently reduced a BLOCKING stable/beta
 * gate to nothing, with no signal distinguishing "verified fresh" from "never checked". That
 * is the can-falsely-pass class (WI-5788/P-411) at the point where it matters most: what ships
 * to public users. The guard already failed CLOSED on an unknown commit COUNT ('?' != '0') —
 * it just failed OPEN on an unknown FETCH.
 *
 * Running a real cut needs a signing chain + toolchains, so per this repo's regex-extraction
 * convention (see hive-git-drill-migration-freshness-guard.test.ts) this extracts the REAL
 * `_wi3047_unverified` helper verbatim from the shipping script and evals it under bash.
 *
 * The load-bearing cases are the FAIL-CLOSED ones: stable/beta must EXIT NON-ZERO when the
 * check could not run. If a future edit makes those pass, the gate is back to decorative.
 *
 *   cd packages/operator-core && npx vitest run lib/release-submodule-freshness-fail-closed.test.ts
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'release-local.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate the repo root (no papercusp-desktop/bin/release-local.sh above this test)');
}

const ROOT = repoRoot();
const SCRIPT = readFileSync(join(ROOT, 'papercusp-desktop', 'bin', 'release-local.sh'), 'utf8');

// Extract the helper verbatim: `_wi3047_unverified() {` through its closing brace at column 0.
const HELPER_RE = /_wi3047_unverified\(\)\s*\{[\s\S]*?\n\}\n/;
const helperMatch = SCRIPT.match(HELPER_RE);

/**
 * The helper's CHANNEL-POLICY DEPENDENCY, extracted the same verbatim way.
 *
 * `_wi3047_unverified` branches on `desktop_channel_is_strict "$CHANNEL"`, which
 * release-local.sh gets from `lib/gen-latest-manifest.sh` (sourced at its line ~167).
 * Eval'ing the helper ALONE leaves that undefined — and the way bash fails there is
 * silent and wrong-way:
 *
 *   undefined command -> exit 127 -> `if ! desktop_channel_is_strict ...` is TRUE
 *   -> the helper takes the LENIENT branch -> WARNs and returns 0 on EVERY channel.
 *
 * `set -e` does not save us: the call sits in an `if` condition, which is an exempt
 * context. So every fail-closed assertion in this file silently began exercising the
 * lenient path the moment that check was refactored out of the helper — the guard read
 * as "the shipping gate regressed to fail-open" when the shipping gate was fine and the
 * HARNESS was the thing that had gone permissive. That is the can-falsely-pass class
 * this file exists to prevent, reproduced one level up in the test itself.
 *
 * Extracted rather than stubbed on purpose: a hand-written `desktop_channel_is_strict`
 * here would assert against a channel policy of the test's own invention, so a real
 * change to which channels are strict would not be caught.
 */
const CHANNEL_LIB = readFileSync(join(ROOT, 'papercusp-desktop', 'bin', 'lib', 'gen-latest-manifest.sh'), 'utf8');
const CHANNEL_FN_RE = /desktop_channel_is_strict\(\)\s*\{[\s\S]*?\n\}\n/;
const channelFnMatch = CHANNEL_LIB.match(CHANNEL_FN_RE);

/** Eval the REAL helper under bash with the given channel/override and report its exit code. */
function runHelper(opts: { channel: string; override?: string }): { status: number | null; out: string } {
  expect(helperMatch, 'could not locate _wi3047_unverified() in release-local.sh').toBeTruthy();
  // Not optional bookkeeping: without this the helper's strictness check is an undefined
  // command (127), which reads as "not strict" and quietly turns every case below lenient.
  expect(
    channelFnMatch,
    'could not locate desktop_channel_is_strict() in bin/lib/gen-latest-manifest.sh — ' +
      'the helper depends on it, and a MISSING definition degrades to the LENIENT branch ' +
      'rather than erroring, so this must fail loudly here instead',
  ).toBeTruthy();
  const env = opts.override === undefined ? '' : `PAPERCUSP_ALLOW_UNVERIFIED_SUBMODULE=${JSON.stringify(opts.override)}\n`;
  // `set -euo pipefail` mirrors the real script: a helper that trips set -e under an empty
  // var or a false test would abort the cut, which this must catch too.
  const script = [
    'set -euo pipefail',
    `CHANNEL=${JSON.stringify(opts.channel)}`,
    env,
    // Sourced by release-local.sh in production; must be defined BEFORE the helper here.
    channelFnMatch![0],
    helperMatch![0],
    '_wi3047_unverified "could not fetch libs/papercusp origin/main (offline / network / auth?)"',
    'echo REACHED_END',
  ].join('\n');
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return { status: res.status, out: res.stdout + res.stderr };
}

describe('P-412/WI-3047: an UNVERIFIABLE submodule freshness check must not pass a shipping cut', () => {
  it('source pins the fail-closed helper and its exit path', () => {
    expect(SCRIPT).toMatch(/_wi3047_unverified\(\)/);
    // Both former fail-open sites must now route through the helper.
    expect(SCRIPT).toMatch(/_wi3047_unverified "could not fetch libs\/papercusp/);
    expect(SCRIPT).toMatch(/_wi3047_unverified "\$PAPERCUSP_SUBMODULE_DIR is not a git repo"/);
    // The old unconditional warn-and-continue phrasing must be gone.
    expect(SCRIPT).not.toMatch(/skipping freshness check \(offline/);
    expect(SCRIPT).not.toMatch(/skipping submodule freshness check/);
  });

  // ── FAIL-CLOSED CONTROLS (the point of the change) ────────────────────────────────
  it('BLOCKS a stable cut when freshness could not be verified', () => {
    const { status, out } = runHelper({ channel: 'stable' });
    expect(status).toBe(1);
    expect(out).toMatch(/ERROR/);
    expect(out).toMatch(/Refusing to cut/);
    expect(out).not.toMatch(/REACHED_END/);
  });

  it('BLOCKS a beta cut when freshness could not be verified', () => {
    const { status, out } = runHelper({ channel: 'beta' });
    expect(status).toBe(1);
    expect(out).not.toMatch(/REACHED_END/);
  });

  it('names the actual reason so the operator can fix the cause', () => {
    const { out } = runHelper({ channel: 'stable' });
    expect(out).toMatch(/offline \/ network \/ auth\?/);
    expect(out).toMatch(/PAPERCUSP_ALLOW_UNVERIFIED_SUBMODULE=1/);
  });

  // ── The deliberate, logged escape hatches ─────────────────────────────────────────
  it('WARNS but continues on alpha (unchanged behaviour — alpha cuts are routine)', () => {
    const { status, out } = runHelper({ channel: 'alpha' });
    expect(status).toBe(0);
    expect(out).toMatch(/WARN/);
    expect(out).toMatch(/UNVERIFIED/);
    expect(out).toMatch(/REACHED_END/);
  });

  it('continues on stable ONLY with the explicit operator override, and says so', () => {
    const { status, out } = runHelper({ channel: 'stable', override: '1' });
    expect(status).toBe(0);
    expect(out).toMatch(/deliberate operator override/);
    expect(out).toMatch(/REACHED_END/);
  });

  it('does NOT treat a non-1 override value as permission', () => {
    // Guards against `PAPERCUSP_ALLOW_UNVERIFIED_SUBMODULE=0` / 'false' / '' reading as opt-in.
    for (const v of ['0', 'false', '']) {
      const { status } = runHelper({ channel: 'stable', override: v });
      expect(status, `override=${JSON.stringify(v)} must not unblock a stable cut`).toBe(1);
    }
  });

  it('is set -e safe when the override var is unset (no spurious abort)', () => {
    // The helper reads ${PAPERCUSP_ALLOW_UNVERIFIED_SUBMODULE:-0} under `set -u`; an
    // unguarded read there would abort the cut for the wrong reason.
    const { status, out } = runHelper({ channel: 'alpha' });
    expect(status).toBe(0);
    expect(out).not.toMatch(/unbound variable/);
  });
});
