/**
 * live-federation-gate-fromrepo-default.test.ts — regression guard for WI-5629/WI-5628.
 *
 * The live-federation gate (papercusp-desktop/bin/live-federation-gate.sh) has a `from-repo`
 * leg that is EXPECTED to fail while WI-971 (outbox drain never wired for joined/created hive
 * harnesses) is open. The production systemd unit already sets
 * `Environment=SKIP_FROMREPO=1` to suppress that known-red — but the SCRIPT's own default
 * used to disagree (0), so any manual/ad-hoc invocation (the kind the gate's own
 * GATE_DISPLAY doc-comment explicitly anticipates, e.g. reproducing a red for debugging)
 * silently re-ran the known WI-971 red and:
 *   (a) filed a confusing "NEW regression — investigate" bug for a condition that isn't new
 *       (live case: WI-5628), and
 *   (b) fed that RED into check_staleness(), filing a spurious "no green run" staleness EI
 *       too (live case: WI-5629), even though the production timer's own state was healthy.
 *
 * Fix: default SKIP_FROMREPO to 1 in the script itself, so the script's default now matches
 * documented production intent regardless of caller. An explicit `SKIP_FROMREPO=0` override
 * still opts back in (e.g. to verify WI-971's fix once it lands).
 *
 * STATIC leg (all platforms): pins the exact default-value shape in source, so a later edit
 * cannot silently regress the default back to 0.
 * BEHAVIORAL leg (all platforms — plain bash parameter expansion, no OS-specific bits):
 * extracts the REAL default-resolution line from the shipping script and evals it under bash,
 * proving (1) a bare/unset invocation resolves to "1" (skip — matches production intent) and
 * (2) an explicit `SKIP_FROMREPO=0` override still resolves to "0" (opt-in path intact).
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

describe('WI-5629/WI-5628: live-federation-gate.sh SKIP_FROMREPO defaults to 1 (skip)', () => {
  it('source pins the default-resolution shape to :-1, not :-0', () => {
    expect(gate).toMatch(/SKIP_FROMREPO="\$\{SKIP_FROMREPO:-1\}"/);
    expect(gate).not.toMatch(/SKIP_FROMREPO="\$\{SKIP_FROMREPO:-0\}"/);
  });

  it('behaviorally: a bare invocation resolves SKIP_FROMREPO to 1 (matches prod intent without any env override)', () => {
    const line = gate.match(/^SKIP_MATRIX=.*SKIP_FROMREPO=.*$/m)?.[0];
    expect(line, 'could not locate the SKIP_MATRIX/SKIP_FROMREPO default-resolution line in the gate source').toBeTruthy();
    const out = execFileSync('bash', ['-c', `${line}; echo "$SKIP_FROMREPO"`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' }, // deliberately no SKIP_FROMREPO in the child env
    }).trim();
    expect(out).toBe('1');
  });

  it('behaviorally: an explicit SKIP_FROMREPO=0 override still opts back in (e.g. to verify WI-971 once it lands)', () => {
    const line = gate.match(/^SKIP_MATRIX=.*SKIP_FROMREPO=.*$/m)?.[0];
    expect(line).toBeTruthy();
    const out = execFileSync('bash', ['-c', `${line}; echo "$SKIP_FROMREPO"`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', SKIP_FROMREPO: '0' },
    }).trim();
    expect(out).toBe('0');
  });
});
