/**
 * WI-10006397 — the stale-testvm reaper's /proc censuses must not fork per host process.
 *
 * Measured 2026-10-06: papercup-testvm-reaper.service consumed 36-57 s of CPU on every
 * 15-minute run. Both censuses (any_orchestrator_alive, candidate_vm_pids) did
 * `cmd=$(proc_cmdline "$pid")` for EVERY /proc entry, and each command substitution
 * forks a subshell: 10,127 + 9,817 subshells against 10,049 host processes, 24 s +
 * 33 s of CPU, mostly kernel time. Same class as WI-10006347 (webkit reaper, `cat`).
 *
 * The forks here are Bash SUBSHELLS, not external launches, so PATH shims (the webkit
 * reaper test's instrument) cannot see them. This guard counts subshells directly: the
 * driver sources the real script, enables `set -T` so a DEBUG trap is inherited by
 * every subshell, and records each new $BASHPID. Two calibrations keep it honest:
 *   - the counter must see a known 40-fork control (else a zero means a broken counter);
 *   - candidate_vm_pids must find a fake qemu-shaped testvm process by pid (else a low
 *     count could mean the scan read nothing).
 *
 * Safety: only the two census functions are called; main()/do_reap() never run.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point the suite at a historical copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? resolve(__dirname, '../../../../bin/reap-stale-testvms.sh');

// Sources the script, then runs one function with every subshell's BASHPID logged.
const DRIVER = `
src="$1"; fn="$2"; __log="$3"
source "$src"
set +e +u
__ctl() { local i x; for ((i = 0; i < 40; i++)); do x=$(:); done; }
__last=$BASHPID
set -T
trap '[[ $BASHPID != "$__last" ]] && { __last=$BASHPID; printf "%s\\n" "$BASHPID" >> "$__log"; }' DEBUG
"$fn"
trap - DEBUG
set +T
`;

let roots: string[] = [];
let children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children) c.kill('SIGKILL');
  children = [];
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

function hostProcessCount(): number {
  return readdirSync('/proc').filter((n) => /^\d+$/.test(n)).length;
}

function countSubshells(fn: string) {
  const root = mkdtempSync(join(tmpdir(), 'testvm-reaper-'));
  roots.push(root);
  const driver = join(root, 'driver.sh');
  const log = join(root, 'subshells.log');
  writeFileSync(driver, DRIVER);
  writeFileSync(log, '');
  const run = spawnSync('bash', [driver, SCRIPT, fn, log], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { PATH: '/usr/bin:/bin', HOME: root },
  });
  const subshells = new Set(readFileSync(log, 'utf8').split('\n').filter(Boolean)).size;
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', subshells };
}

describe('reap-stale-testvms.sh /proc censuses (WI-10006397)', () => {
  it('calibration: the subshell counter sees a known 40-fork control', () => {
    const r = countSubshells('__ctl');
    expect(r.status, r.stderr).toBe(0);
    expect(r.subshells).toBeGreaterThanOrEqual(40);
  });

  it('calibration: candidate_vm_pids finds a qemu-shaped testvm process by pid', () => {
    const fake = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 120000)', '--', '-name', `papercusp-testvm-reaper-selftest-${process.pid}`],
      { argv0: 'qemu-system-x86_64', stdio: 'ignore' },
    );
    children.push(fake);
    const r = countSubshells('candidate_vm_pids');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split('\n')).toContain(String(fake.pid));
  }, 120_000);

  it.each(['candidate_vm_pids', 'any_orchestrator_alive'])(
    '%s forks a bounded number of subshells, not one per host process',
    (fn) => {
      const procs = hostProcessCount();
      // Without this the bound below would be vacuous on a near-empty host.
      expect(procs).toBeGreaterThan(50);
      const r = countSubshells(fn);
      // any_orchestrator_alive exits 1 when no orchestrator is live; both are fine.
      expect([0, 1], r.stderr).toContain(r.status);
      // The self-ancestry walk forks once per ancestor (a handful); a per-entry
      // command substitution forks once per host process.
      expect(r.subshells).toBeLessThan(Math.floor(procs / 4));
    },
    120_000,
  );
});
