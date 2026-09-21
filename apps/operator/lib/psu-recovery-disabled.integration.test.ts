// @vitest-environment node
/**
 * psu-recovery-disabled.integration.test.ts — the native recovery authority root
 * is CLOSED on the REAL, shipped `psu` entry point, driven as a subprocess under
 * a REAL PTY.
 *
 * WHY this exists (and what it adds over psu-recovery.test.ts's 8 UNIT tests and
 * over psu-launcher.test.ts's subprocess case):
 *
 *   - psu-recovery.test.ts calls `recoveryAuthorizationEligibility()` directly.
 *     That proves the FUNCTION refuses; it cannot prove the shipped CLI actually
 *     routes through it.
 *   - psu-launcher.test.ts:"reaches recovery redemption without contacting the
 *     operator" spawns the launcher, but `spawnSync` gives the child NO TTY, so
 *     `recoveryFlow` stops at `resolveOwnedTtyPath()` and that test can only ever
 *     observe "native recovery requires a real local terminal". It NEVER reaches
 *     the authority decision — the gate under test here sits strictly downstream
 *     of the one it exercises.
 *
 * Allocating a real PTY (via `script -qec`) is what gets PAST the terminal gate
 * and reaches `recoveryAuthorizationEligibility`, which is the only place the
 * D-010 exclusion is actually enforced. That is this file's whole reason to
 * exist, and it is the integration-layer obligation R-5 carries.
 *
 * NON-VACUOUSNESS — why these assertions cannot pass for the wrong reason:
 *   1. They assert the EXACT reason string
 *      `native-recovery-disabled-external-owner-trust-root-required`, not merely
 *      that the command failed. Delete the unconditional disable at
 *      psu-recovery.mjs:831 and the retained checks below it take over, so the
 *      refusal reason changes (e.g. `inherited-agent-identity`) and these tests
 *      FAIL rather than quietly passing on a different refusal.
 *   2. The first test is a POSITIVE CONTROL for the instrument itself: a missing
 *      `script`, a broken shim, or a launcher that cannot start would refuse
 *      IDENTICALLY to a closed authority. The control asserts the very same
 *      harness runs `--help` successfully AND that the CLI still advertises
 *      `--recovery-authorize`, so "the surface is gone" and "the surface is
 *      closed" cannot be confused.
 *
 * Plan: `managed-agent-capability-contract-and-native-cutover-2026-09-13`, bar R-5
 * (decisions D-007/D-008 forgeability, D-010 drop).
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const LAUNCHER = join(__dirname, '..', 'scripts', 'psu-launcher.mjs');

/** The one reason string that means "the D-010 exclusion refused this". */
const DISABLED_REASON = 'native-recovery-disabled-external-owner-trust-root-required';

/** Single-quote a token for safe embedding in the `script -c` command string. */
function shellQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run the real launcher as a subprocess with a REAL controlling terminal.
 * `script -qec <cmd> /dev/null` allocates a PTY, which is what lets execution
 * reach the authorization gate instead of stopping at the terminal check.
 *
 * NOTE on `output`: a PTY is a SINGLE stream, so the child's stderr is merged
 * into stdout by the terminal itself and `result.stderr` arrives EMPTY. Assert
 * against `output`, never against `stderr` — an empty `stderr` here means "PTY",
 * not "the command printed nothing", and asserting on it would fail even when
 * the refusal is working perfectly.
 */
function runUnderPty(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const inner = [process.execPath, LAUNCHER, ...args].map(shellQuote).join(' ');
  const result = spawnSync('script', ['-qec', inner, '/dev/null'], {
    cwd: process.cwd(),
    // Point at a dead operator so a refusal can never be a network artifact.
    env: { ...process.env, PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1', ...extraEnv },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('psu native recovery — authority root is closed on the shipped entry point', () => {
  it('POSITIVE CONTROL: the PTY harness works and the CLI still advertises the recovery surface', () => {
    const result = runUnderPty(['--help']);

    // If this fails, every refusal assertion below is uninterpretable: a broken
    // instrument refuses exactly like a closed authority.
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);

    // The surface must still EXIST. R-5 claims the path is unreachable, not that
    // the code was deleted — so a vanished flag would mean the other tests are
    // passing because there is nothing left to refuse.
    expect(result.output).toContain('--recovery-authorize');
    expect(result.output).toContain('--recovery-grant');
  });

  it('refuses AUTHORIZATION with the D-010 exclusion reason, not the terminal gate', () => {
    const result = runUnderPty([
      '--recovery-authorize',
      '--recovery-reason=integration guard: authorization must be refused',
      '--',
      '/bin/true',
    ]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.output).toContain(DISABLED_REASON);

    // Prove we got PAST the terminal gate — otherwise this test would be
    // re-asserting what psu-launcher.test.ts already covers, and would keep
    // passing even if the authority root were reopened.
    expect(result.output).not.toMatch(/native recovery requires a real local terminal/);

    // The refusal must be an authority decision, not a network failure.
    expect(result.output).not.toMatch(/ECONNREFUSED|connection profile|retrying/i);
  });

  it('refuses GRANT REDEMPTION with the same reason, before consuming anything', () => {
    const result = runUnderPty(['--recovery-grant=00000000-0000-4000-8000-000000000000']);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.output).toContain(DISABLED_REASON);
    expect(result.output).not.toMatch(/native recovery requires a real local terminal/);
    expect(result.output).not.toMatch(/ECONNREFUSED|connection profile|retrying/i);
  });

  it('refuses recovery even when combined with an explicit agent-session marker', () => {
    // A caller that announces itself as an agent must not get a DIFFERENT answer
    // from one that does not: the exclusion is unconditional, so the reason
    // string must still be the D-010 one rather than an identity-based refusal.
    // If the disable were removed, this shape would refuse with
    // `inherited-agent-identity` instead — a different string, so this assertion
    // fails rather than passing on the wrong refusal.
    const result = runUnderPty(['--recovery-grant=00000000-0000-4000-8000-000000000000'], {
      PAPERCUSP_AGENT_SESSION: '1',
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.output).toContain(DISABLED_REASON);
  });
});
