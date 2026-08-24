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
const CHANNEL_FN_RE = /desktop_channel_is_strict\(\)\s*\{[\s\S]*?\n\}\n/;
const CHANNEL_LIB_PATH = join(ROOT, 'papercusp-desktop', 'bin', 'lib', 'gen-latest-manifest.sh');

/**
 * EI-19933289145316787 (2026-08-09): on this shared, git-sync'd tree, a checkpoint/CI
 * worktree's files can be mid-`git checkout` (submodule update, sweep-commit) at the exact
 * moment this file reads them. A read landing in that window can see a truncated/partial
 * gen-latest-manifest.sh whose regex-extracted `desktop_channel_is_strict` text doesn't
 * form valid bash — with NO exception thrown (the regex still "matches" something), so
 * `runHelper` silently synthesizes a script where the function fails to define. That
 * produced the EXACT can-falsely-pass signature this file exists to catch, one level up:
 * `bash: line N: desktop_channel_is_strict: command not found` -> exit 127 -> lenient
 * branch -> "BLOCKS a stable cut" asserts `expect(status).toBe(1)` and gets 0. Confirmed
 * via harness_shared.test_runs + checkpoint-log archaeology: the source is BYTE-IDENTICAL
 * between the failing commits and a passing HEAD run minutes later, so this was never a
 * code regression — it was this test's OWN single-read-at-import-time technique losing a
 * race with a concurrent checkout on the tree it reads from.
 *
 * Fix: read + extract FRESH on every `runHelper` call (never cache at module scope) and
 * retry a fresh read/extract when the synthesized run itself reports the tell-tale
 * "command not found" signature — a transient torn read self-heals on a re-read moments
 * later. A real, persistent breakage (the function genuinely removed/renamed) still fails,
 * because it survives every retry identically.
 */
function readChannelFn(): RegExpMatchArray | null {
  return readFileSync(CHANNEL_LIB_PATH, 'utf8').match(CHANNEL_FN_RE);
}

const TORN_READ_SIGNATURE = /desktop_channel_is_strict: command not found/;
const MAX_TORN_READ_RETRIES = 3;

/** Eval the REAL helper under bash with the given channel/override and report its exit code. */
function runHelper(opts: { channel: string; override?: string }): { status: number | null; out: string } {
  const helperMatch = SCRIPT.match(HELPER_RE);
  expect(helperMatch, 'could not locate _wi3047_unverified() in release-local.sh').toBeTruthy();

  const env = opts.override === undefined ? '' : `PAPERCUSP_ALLOW_UNVERIFIED_SUBMODULE=${JSON.stringify(opts.override)}\n`;

  let last: { status: number | null; out: string } | undefined;
  for (let attempt = 1; attempt <= MAX_TORN_READ_RETRIES; attempt++) {
    // Fresh read + extraction EVERY attempt (not just every test) — a torn read is a
    // property of a single readFileSync call, not of the test process's lifetime.
    const channelFnMatch = readChannelFn();
    // Not optional bookkeeping: without this the helper's strictness check is an undefined
    // command (127), which reads as "not strict" and quietly turns every case below lenient.
    expect(
      channelFnMatch,
      'could not locate desktop_channel_is_strict() in bin/lib/gen-latest-manifest.sh — ' +
        'the helper depends on it, and a MISSING definition degrades to the LENIENT branch ' +
        'rather than erroring, so this must fail loudly here instead',
    ).toBeTruthy();
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
    const res = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    const out = res.stdout + res.stderr;
    last = { status: res.status, out };
    if (!TORN_READ_SIGNATURE.test(out)) return last;
    // Torn read detected — sleep briefly (synchronously; this is a test helper) so a
    // concurrent checkout has a moment to finish, then retry with a fresh read.
    spawnSync('sleep', ['0.2'], { timeout: 5_000, killSignal: 'SIGKILL' });
  }
  // Every retry reproduced the same "command not found" signature — this is no longer
  // explicable as a torn read; surface it plainly instead of the bare status mismatch.
  throw new Error(
    `desktop_channel_is_strict was undefined across ${MAX_TORN_READ_RETRIES} fresh reads of ` +
      `${CHANNEL_LIB_PATH} — this looks like a REAL removal/rename, not a torn read. Last output:\n${last!.out}`,
  );
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
