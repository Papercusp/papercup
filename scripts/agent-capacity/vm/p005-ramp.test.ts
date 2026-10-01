import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point the test at a mutated copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? path.join(__dirname, 'p005-ramp.sh');

describe('vm/p005-ramp.sh (faked systemd-run/systemctl/npx and the sampler)', () => {
  let home: string;
  const bin = () => path.join(home, 'bin');
  const slice = () => path.join(home, 'slice');
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin(), name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path.join(bin(), name), 0o755);
  };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'p005-ramp-'));
    mkdirSync(bin());
    mkdirSync(slice());
    mkdirSync(path.join(home, 'capacity'));
    writeFileSync(path.join(slice(), 'memory.events'), 'oom 0\noom_kill 0\n');
    stub('systemd-run', `echo "$@" >> "${home}/systemd-run.log"`);
    stub('systemctl', `echo "$@" >> "${home}/systemctl.log"`);
    // The sampler would run for the whole window; the verdict step needs the real python3.
    stub('python3', `case "$1" in *sample-footprint.py) exec sleep 120 ;; *) exec /usr/bin/python3 "$@" ;; esac`);
    // load-driver: `--check` (the preflight) is logged to check.log and passes unless FAKE_CHECK_FAIL
    // is set; a step writes summary.json for the run (every slot held, so not UNDERDRIVEN);
    // FAKE_SLOW_AT / FAKE_OOM_AT pick the bad step.
    stub(
      'npx',
      `case " $* " in *" --check "*)
  echo "$@" >> "${home}/check.log"
  [ -n "\${FAKE_CHECK_FAIL:-}" ] && { echo "Error: Cannot find module '@papercusp/operator-core/lib/child-output'" >&2; exit 1; }
  echo "DRIVER_CHECK_OK sessions=6 corpus=x tasks=6"; exit 0 ;;
esac
echo "$@" >> "${home}/npx.log"
n=""; run=""
while [ $# -gt 0 ]; do case "$1" in --agents) n=$2; shift;; --run-id) run=$2; shift;; esac; shift; done
slow=1.05
[ -n "\${FAKE_SLOW_AT:-}" ] && [ "$n" -ge "$FAKE_SLOW_AT" ] && slow=2.4
[ -n "\${FAKE_OOM_AT:-}" ] && [ "$n" -ge "$FAKE_OOM_AT" ] && printf 'oom 1\\noom_kill 1\\n' > "${slice()}/memory.events"
d="$HOME/.cache/agent-capacity/runs/$run"; mkdir -p "$d"
printf '{"runs":%s,"failed":0,"diverged":0,"toolDiverged":0,"wallSlowdown":%s,"achievedConcurrency":{"mean":%s,"target":%s,"fraction":1}}' "$n" "$slow" "$n" "$n" > "$d/summary.json"`,
    );
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const run = (env: Record<string, string>, ...args: string[]) =>
    spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: home, PATH: `${bin()}:${process.env.PATH}`, CAPDRV_SLICE_DIR: slice(), ...env },
    });

  it('runs every step with N agents for the window and the selection, when nothing saturates', () => {
    const r = run({}, 'claude-normal', 'cli=claude,profile=light', '1 2 4', '300');
    expect(r.status, r.stderr).toBe(0);
    const calls = readFileSync(path.join(home, 'npx.log'), 'utf8').trim().split('\n');
    expect(calls).toEqual(
      [1, 2, 4].map(
        (n) =>
          `tsx scripts/agent-capacity/load-driver.ts --agents ${n} --duration-sec 300 --stagger-ms 1000 --select cli=claude,profile=light --run-id p005-claude-normal-n${n} --isolation systemd --workdir overlay`,
      ),
    );
    // One preflight, with the same selection, before the first step.
    expect(readFileSync(path.join(home, 'check.log'), 'utf8').trim().split('\n')).toEqual([
      'tsx scripts/agent-capacity/load-driver.ts --check --select cli=claude,profile=light --workdir overlay',
    ]);
    expect(r.stdout).toMatch(/RAMP_PREFLIGHT_OK claude-normal DRIVER_CHECK_OK sessions=6/);
    expect(r.stdout).toMatch(/RAMP_STEP_END p005-claude-normal-n4 n=4 rc=0 OK runs=4 wallSlowdown=1.05/);
    expect(r.stdout).not.toMatch(/RAMP_SATURATED/);
    expect(r.stdout).toMatch(/RAMP_DONE claude-normal/);
  });

  it('"all" passes no --select, and the ramp stops at the first step past the slowdown limit', () => {
    const r = run({ FAKE_SLOW_AT: '4' }, 'mixed', 'all', '1 2 4 8 16');
    expect(r.status, r.stderr).toBe(0);
    const calls = readFileSync(path.join(home, 'npx.log'), 'utf8').trim().split('\n');
    expect(calls).toHaveLength(3);
    expect(calls[0]).not.toMatch(/--select/);
    expect(calls[0]).toMatch(/--duration-sec 600 /);
    expect(r.stdout).toMatch(/RAMP_STEP_END p005-mixed-n4 n=4 rc=0 SATURATED reason=wallSlowdown=2.40/);
    expect(r.stdout).toMatch(/RAMP_SATURATED mixed n=4/);
  });

  it('an OOM kill in the slice during a step saturates it', () => {
    const r = run({ FAKE_OOM_AT: '2' }, 'codex-heavy', 'cli=codex,profile=heavy', '1 2 4');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/RAMP_STEP_END p005-codex-heavy-n1 n=1 rc=0 OK/);
    expect(r.stdout).toMatch(/RAMP_STEP_END p005-codex-heavy-n2 n=2 rc=0 SATURATED reason=oom_kill=1/);
    expect(r.stdout).toMatch(/RAMP_SATURATED codex-heavy n=2/);
  });

  it('a driver that dies late with no summary saturates the step, not silently passed', () => {
    stub('npx', `case " $* " in *" --check "*) echo DRIVER_CHECK_OK; exit 0 ;; esac; exit 7`);
    const r = run({ RAMP_ERROR_SEC: '0' }, 'mixed', 'all', '1 2');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/RAMP_STEP_END p005-mixed-n1 n=1 rc=7 SATURATED reason=no-summary,driver-rc=7/);
    expect(r.stdout).toMatch(/RAMP_SATURATED mixed n=1/);
    expect(r.stdout).not.toMatch(/p005-mixed-n2/);
  });

  it('a driver that dies at once with no summary is a DRIVER_ERROR, not a saturation, and fails the ramp', () => {
    // P-529, 2026-10-01: a missing module ended both arms at n=12 in one second as "SATURATED".
    stub('npx', `case " $* " in *" --check "*) echo DRIVER_CHECK_OK; exit 0 ;; esac; exit 1`);
    const r = run({}, 'mixed', 'all', '1 2');
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/RAMP_STEP_END p005-mixed-n1 n=1 rc=1 DRIVER_ERROR reason=no-summary,driver-rc=1,elapsed=\d+s/);
    expect(r.stdout).toMatch(/RAMP_DRIVER_ERROR mixed n=1/);
    expect(r.stdout).not.toMatch(/RAMP_SATURATED/);
    expect(r.stdout).not.toMatch(/p005-mixed-n2/);
  });

  it('a driver that fails its preflight stops the ramp before any step, with the real error', () => {
    const r = run({ FAKE_CHECK_FAIL: '1' }, 'mixed', 'all', '1 2');
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/RAMP_PREFLIGHT_FAILED mixed Error: Cannot find module '@papercusp\/operator-core\/lib\/child-output'/);
    expect(r.stdout).not.toMatch(/RAMP_STEP_START/);
    expect(() => readFileSync(path.join(home, 'npx.log'), 'utf8')).toThrow();
  });

  it('TASKS_FILE reaches the preflight and every step as --tasks-file', () => {
    const r = run({ TASKS_FILE: '/corpus/tasks.json' }, 'p529-a', 'all', '12');
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(path.join(home, 'check.log'), 'utf8')).toContain('--check --tasks-file /corpus/tasks.json --workdir overlay');
    expect(readFileSync(path.join(home, 'npx.log'), 'utf8')).toContain('--duration-sec 600 --stagger-ms 1000 --tasks-file /corpus/tasks.json --run-id p005-p529-a-n12');
  });
});
