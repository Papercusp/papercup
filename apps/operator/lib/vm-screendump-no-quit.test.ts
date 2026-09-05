/**
 * vm-screendump-no-quit.test.ts — the RECURRENCE GUARD for EI-20093096699900811.
 *
 * The bug: there was no HMP-monitor screendump helper, so every agent hand-rolled
 * the raw form. The documented raw form has no timeout and appears to HANG on the
 * still-open monitor socket, and the obvious repair for that hang is to append
 * `quit` — which on the QEMU HMP monitor means "exit the EMULATOR", not "close my
 * connection". Measured 2026-08-10: the .ppm was written, exit was 0, the command's
 * own output said nothing was wrong, and the Windows VM had taken an unclean
 * power-off (state Zl, :2223 refusing, qcow2 overlay lock released mid-session).
 * The agent then misread the zombie as a failed boot and diagnosed a boot that had
 * actually succeeded.
 *
 * The fix: papercusp-desktop/bin/vm-screendump.sh, which sends EXACTLY ONE monitor
 * command (`screendump`) and bounds the exchange with socat's -T half-close plus an
 * outer `timeout`. Bounding is the load-bearing half — it removes the hang that made
 * `quit` attractive in the first place, so this file pins BOTH properties. A helper
 * that stopped being bounded would re-create the incentive even while still passing
 * a naive "does not contain quit" check.
 *
 * A `readFileSync` text guard is the right shape here, same rationale as the sibling
 * verify-tauri-headless-*.test.ts: exercising the real path needs a booted QEMU VM
 * with an HMP monitor socket, so the wiring can only be asserted at the wiring site.
 * The behaviour itself was verified live against the running papercusp-win11 VM when
 * the script landed (capture in 0.75s; VM still `Ssl` and its monitor still answering
 * `VM status: running` afterwards).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at a MUTATED COPY
// outside the tree, so falsifiability can be proven without ever mutating the shared
// checkout (where git-sync would happily commit the mutant mid-probe).
const SCRIPT =
  process.env.PROBE_SCRIPT ??
  resolve(__dirname, '../../../papercusp-desktop/bin/vm-screendump.sh');
const src = readFileSync(SCRIPT, 'utf8');

/**
 * The script's EXECUTABLE lines — full-line comments dropped.
 *
 * This is load-bearing, not tidiness: the header deliberately quotes the dangerous
 * `...\nquit\n...` form as the thing being prevented, so a guard run over the raw
 * file would fire on its own documentation and would have to be weakened to pass.
 */
const code = src
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

/** HMP verbs that CHANGE the VM. A capture is a read; none of these belong in it. */
const MUTATING_HMP_VERBS = [
  'quit',
  'cont',
  'stop',
  'system_reset',
  'system_powerdown',
  'savevm',
  'loadvm',
  'migrate',
];

describe('vm-screendump.sh — the monitor exchange cannot destroy the VM', () => {
  it('sends screendump, and sends nothing else', () => {
    // Every payload written into the monitor pipe. The helper composes it with
    // printf, which is what the hand-rolled form did too.
    const payloads = [...code.matchAll(/printf\s+'([^']*)'/g)].map((m) => m[1]);

    expect(payloads.length).toBeGreaterThan(0);

    const monitorPayloads = payloads.filter((p) => p.includes('screendump'));
    expect(monitorPayloads).toHaveLength(1);

    // One command, one trailing newline: 'screendump %s\n'. Anything chained after
    // it — the exact shape of the original incident — makes this fail.
    expect(monitorPayloads[0]).toBe('screendump %s\\n');
  });

  it('never names a mutating HMP verb in executable code', () => {
    for (const verb of MUTATING_HMP_VERBS) {
      expect(
        new RegExp(`\\b${verb}\\b`).test(code),
        `executable code names the mutating HMP verb "${verb}" — a screendump helper must only read`,
      ).toBe(false);
    }
  });

  it('bounds the monitor exchange, so no one has to reach for `quit` to stop it hanging', () => {
    const socatLine = code
      .split('\n')
      .find((line) => line.includes('UNIX-CONNECT:'));
    expect(socatLine, 'no socat UNIX-CONNECT invocation found').toBeTruthy();

    // -T: close the half-open connection N seconds after our stdin EOF. This is the
    // property that makes the safe form return promptly instead of appearing to hang.
    expect(socatLine).toMatch(/-T\s+"?\$/);

    // timeout: the hard backstop for a monitor that never answers at all.
    expect(code).toMatch(/timeout\s+"\$HARD_TIMEOUT"\s+"\$SOCAT_BIN"/);
  });

  it('treats the written image, not socat exit status, as proof of capture', () => {
    // Some QEMU builds hold the monitor connection open, so socat legitimately exits
    // non-zero on the -T half-close after a perfectly good capture. Trusting its
    // status would report a successful screendump as a failure.
    expect(code).toMatch(/-s\s+"\$TMP_PPM"/);
  });
});

describe('vm-screendump.sh — resolving the VM', () => {
  it('derives the monitor socket from the running qemu instead of hardcoding one path', () => {
    // The launcher opens "$PWD/qemu-monitor.sock", so the path is rig-specific and the
    // tree already spells it two ways (vm-preflight.sh hardcodes the /mnt/data/offload
    // form, the agent-insights doc the ~/windows-vm form). Reading it off the process
    // that owns it cannot drift with either.
    expect(code).toMatch(/\/proc\/\$qemu_pid\/cmdline/);
    expect(code).toMatch(/prev=="-monitor"/);
  });

  it('excludes its own process tree by IDENTITY, not by pid', () => {
    // pgrep -f matches the FULL command line and this script's argv contains the
    // pattern verbatim, so it can match itself. Excluding $$/$PPID is NOT enough:
    // measured 2026-09-05, a command-substitution subshell has its own pid, is
    // neither, and sailed through that guard — `--vm 'qemu-system.*no-such-vm-xyz'`
    // then "found" a VM that did not exist. Filtering on argv[0] being a qemu binary
    // cannot be fooled by any pid.
    expect(code).toMatch(/cand_argv0/);
    expect(code).toMatch(/== qemu-\*/);
  });
});
