/**
 * live-federation-gate-fromrepo-default.test.ts — default-drift guard for the gate's
 * `from-repo` leg (originally WI-5629/WI-5628; re-pointed to D-016 on 2026-07-27).
 *
 * HISTORY. The live-federation gate (papercusp-desktop/bin/live-federation-gate.sh) has a
 * `from-repo` leg that was EXPECTED to fail while WI-971 (outbox drain never wired for
 * joined/created hive harnesses) was open, so the script defaulted SKIP_FROMREPO=1 to keep
 * an ad-hoc invocation from re-running a known-red and filing a confusing "NEW regression"
 * bug (WI-5628) plus a spurious staleness EI (WI-5629).
 *
 * CURRENT INTENT (what this file now guards). Both written conditions for that skip have
 * closed, so the p2p-release lane FLIPPED the default 1 -> 0 — the leg RUNS by default:
 *   • WI-971 is RESOLVED and live-verified twice on the packaged binary (WI-5775), and
 *   • WI-5783 (the WITNESS sub-probe's unrelated failure) is RESOLVED.
 * Ratified as D-016 on plan `p2p-public-release-remaining-lanes-2026-07-16`, which also
 * records WHY it matters: with the skip in place the gate could report GREEN while never
 * running this leg — and a skipped leg is NOT a green leg (D-015).
 *
 * So the guard's DIRECTION is inverted, not its purpose: the default must stay pinned and
 * explicit so it cannot silently drift again (in EITHER direction) without someone editing
 * this file and restating the intent. To opt out for a one-off ad-hoc run, pass
 * SKIP_FROMREPO=1; do not restore 1 as the standing default to quiet a red.
 *
 * STATIC leg (all platforms): pins the exact default-value shape in source.
 * BEHAVIORAL leg (all platforms — plain bash parameter expansion, no OS-specific bits):
 * extracts the REAL default-resolution line from the shipping script and evals it under bash,
 * proving (1) a bare/unset invocation resolves to "0" (run — matches D-016) and (2) an
 * explicit `SKIP_FROMREPO=1` override still opts out (the ad-hoc escape hatch is intact).
 *
 * NOTE for future editors: the behavioral legs append `echo` on its OWN LINE, never
 * `;`-joined. The extracted source line carries a trailing `# …` comment, and a `;`-joined
 * echo lands INSIDE that comment — which silently yields '' and makes these tests fail for
 * a reason that has nothing to do with the default they guard.
 *
 *   cd packages/operator-core && npx vitest run lib/live-federation-gate-fromrepo-default.test.ts
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
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
const GATE_PATH = join(ROOT, 'papercusp-desktop', 'bin', 'live-federation-gate.sh');
const gate = readFileSync(GATE_PATH, 'utf8');

/**
 * Extract the shipping script's REAL default-resolution line and resolve it under bash.
 *
 * `echo` goes on its OWN LINE (a newline terminates a trailing `#` comment) — a `;`-joined
 * echo would be swallowed by the comment the line now carries and always return ''.
 */
function resolveSkipFromRepo(env: NodeJS.ProcessEnv): string {
  const line = gate.match(/^SKIP_MATRIX=.*SKIP_FROMREPO=.*$/m)?.[0];
  expect(
    line,
    'could not locate the SKIP_MATRIX/SKIP_FROMREPO default-resolution line in the gate source',
  ).toBeTruthy();
  return execFileSync('bash', ['-c', `${line}\necho "$SKIP_FROMREPO"`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
    timeout: 30_000,
    killSignal: 'SIGKILL',
  }).trim();
}

describe('D-016: live-federation-gate.sh SKIP_FROMREPO defaults to 0 (run the leg)', () => {
  it('source pins the default-resolution shape to :-0, not :-1', () => {
    expect(gate).toMatch(/SKIP_FROMREPO="\$\{SKIP_FROMREPO:-0\}"/);
    expect(gate).not.toMatch(/SKIP_FROMREPO="\$\{SKIP_FROMREPO:-1\}"/);
  });

  it('behaviorally: a bare invocation resolves SKIP_FROMREPO to 0 (the leg RUNS — a skipped leg is not a green leg, D-015)', () => {
    // deliberately no SKIP_FROMREPO in the child env
    expect(resolveSkipFromRepo({})).toBe('0');
  });

  it('behaviorally: an explicit SKIP_FROMREPO=1 override still opts out (the one-off ad-hoc escape hatch)', () => {
    expect(resolveSkipFromRepo({ SKIP_FROMREPO: '1' })).toBe('1');
  });

  it('the behavioral probe is comment-proof — the extracted line ends in a trailing # comment, and the echo must survive it', () => {
    // Guards the exact latent break that made both legs above return '' regardless of
    // the default: a `;`-joined echo lands inside the trailing comment.
    const line = gate.match(/^SKIP_MATRIX=.*SKIP_FROMREPO=.*$/m)?.[0] ?? '';
    expect(line).toMatch(/#/); // the line really does carry a trailing comment today
    const semicolonJoined = execFileSync('bash', ['-c', `${line}; echo "$SKIP_FROMREPO"`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
      timeout: 30_000,
      killSignal: 'SIGKILL',
    }).trim();
    expect(semicolonJoined).toBe(''); // …and would silently swallow the probe
    expect(resolveSkipFromRepo({})).not.toBe(''); // the newline form does not
  });
});
