import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard test for scripts/shrink-swapfile.sh (EI-20589765301078360).
 *
 * The script performs a NON-ABORTABLE swap migration on the shared host. If its
 * precondition gate is wrong in the permissive direction it does not fail
 * loudly — it OOMs the box and destroys every running agent's uncommitted work.
 * So the gate's ability to REFUSE is the thing under test, not its ability to
 * pass.
 *
 * The load-bearing case is `filed OOM conditions`. An earlier draft of the gate
 * used a 25% RAM factor with a 16 GiB floor and returned OPEN for exactly the
 * conditions the originating issue measured as OOM-causing (160.5 GiB swapped
 * against 66 GiB available RAM). That is the regression this file exists to
 * prevent; if someone loosens RAM_FACTOR / MIN_RAM_HEADROOM_G, this fails.
 *
 * `safe conditions` is the CALIBRATION control. Without it, every assertion
 * here would still pass if the script were broken into refusing unconditionally
 * (or crashed on startup), which would look like a very strict gate rather than
 * a dead one.
 */

const repoRoot = path.resolve(__dirname, '../../..');
const script = path.join(repoRoot, 'scripts/shrink-swapfile.sh');

const GIB_KB = 1048576;

/** All measurements the gate reads, injected so no real host state is touched. */
type Measurements = {
  swapUsedGiB: number;
  memAvailGiB: number;
  stagingFreeGiB: number;
  psiFullAvg60: number;
  load1: number;
};

const SAFE: Measurements = {
  swapUsedGiB: 40,
  memAvailGiB: 200,
  stagingFreeGiB: 900,
  psiFullAvg60: 1,
  load1: 5,
};

function runGate(m: Measurements, args: string[] = ['--check']): number {
  try {
    execFileSync('bash', [script, ...args], {
      env: {
        ...process.env,
        SWAPSHRINK_TEST_SWAP_USED_KB: String(Math.round(m.swapUsedGiB * GIB_KB)),
        SWAPSHRINK_TEST_MEM_AVAIL_KB: String(Math.round(m.memAvailGiB * GIB_KB)),
        SWAPSHRINK_TEST_STAGING_FREE_KB: String(Math.round(m.stagingFreeGiB * GIB_KB)),
        SWAPSHRINK_TEST_PSI_FULL_AVG60: String(m.psiFullAvg60),
        SWAPSHRINK_TEST_LOAD1: String(m.load1),
      },
      stdio: 'pipe',
      timeout: 60_000,
    });
    return 0;
  } catch (err) {
    return typeof (err as { status?: number }).status === 'number'
      ? ((err as { status: number }).status)
      : 2;
  }
}

const GATE_OPEN = 0;
const GATE_CLOSED = 1;
const MISUSE = 2;

describe('shrink-swapfile.sh precondition gate', () => {
  it('the script exists and is executable', () => {
    expect(existsSync(script)).toBe(true);
    // syntax check: a script that cannot parse would make every refusal below
    // pass for the wrong reason.
    // WI-41180: bounded like runGate's call above — an unbounded sync spawn wedges the shared
    // pure-lane worker fork, which vitest cannot time out.
    expect(() =>
      execFileSync('bash', ['-n', script], { stdio: 'pipe', timeout: 30_000, killSignal: 'SIGKILL' }),
    ).not.toThrow();
  });

  // CALIBRATION: proves the gate can say yes. Without this, a gate broken into
  // always-refusing would satisfy every other assertion in this file.
  it('opens under genuinely safe conditions', () => {
    expect(runGate(SAFE)).toBe(GATE_OPEN);
  });

  // THE REGRESSION CONTROL — see file header.
  it('REFUSES the conditions the issue measured as OOM-causing (160.5G swap / 66G RAM)', () => {
    expect(
      runGate({ ...SAFE, swapUsedGiB: 160.5, memAvailGiB: 66 }),
    ).toBe(GATE_CLOSED);
  });

  it('refuses when RAM headroom is below the absolute floor', () => {
    expect(runGate({ ...SAFE, swapUsedGiB: 10, memAvailGiB: 50 })).toBe(GATE_CLOSED);
  });

  it('refuses when RAM headroom is below the proportional floor', () => {
    // 200 GiB swapped needs >= 100 GiB available; 90 is not enough.
    expect(runGate({ ...SAFE, swapUsedGiB: 200, memAvailGiB: 90 })).toBe(GATE_CLOSED);
  });

  it('refuses when the staging volume cannot hold the migrated swap', () => {
    expect(
      runGate({ ...SAFE, swapUsedGiB: 200, memAvailGiB: 200, stagingFreeGiB: 50 }),
    ).toBe(GATE_CLOSED);
  });

  it('refuses when the box is already thrashing', () => {
    expect(runGate({ ...SAFE, psiFullAvg60: 77 })).toBe(GATE_CLOSED);
  });

  // Synthetic measurements must never be able to drive a destructive run, or
  // this very test file could migrate the host's swap.
  it('refuses --execute whenever test overrides are present', () => {
    expect(runGate(SAFE, ['--execute'])).toBe(MISUSE);
  });
});
