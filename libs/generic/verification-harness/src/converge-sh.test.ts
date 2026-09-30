import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * bin/converge.sh (vh_converge): the shell twin of waitForConvergence. The observation
 * command's exit code is the protocol: 0 converged, 3 not yet, anything else a broken read.
 * The clock and the sleep are faked through a file, so no test waits in real time and no
 * wall-clock second boundary can shift a deadline (bash's SECONDS ticks on those).
 */
const binDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../bin');
const converge = path.join(binDir, 'converge.sh');
const vh = path.join(binDir, 'vh.sh');

const PRELUDE = `
echo 0 >"$ROOT/clock"
fake_now() { VH_CONVERGE_T=$(cat "$ROOT/clock"); }
fake_sleep() { echo "sleep $1" >>"$ROOT/sleeps"; echo $(( $(cat "$ROOT/clock") + $1 )) >"$ROOT/clock"; }
VH_CONVERGE_SLEEP=fake_sleep
VH_CONVERGE_NOW=fake_now
# observe: serve the exit codes in $ROOT/codes one per read (the last repeats), print the read number.
observe() {
  local n; n=$(( $(cat "$ROOT/count" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$ROOT/count"
  local code; code=$(sed -n "\${n}p" "$ROOT/codes"); [ -n "$code" ] || code=$(tail -n 1 "$ROOT/codes")
  echo "{\\"read\\":$n}"; echo "read $n lagging: ref behind" >&2
  return "$code"
}
nudge() { echo "nudge $1" >>"$ROOT/nudges"; echo "nudged"; }
`;

function run(codes: number[], body: string, source = converge) {
  const root = mkdtempSync(path.join(tmpdir(), 'vh-converge-'));
  writeFileSync(path.join(root, 'codes'), `${codes.join('\n')}\n`);
  const file = path.join(root, 'h.sh');
  writeFileSync(
    file,
    `set -uo pipefail\nsource ${JSON.stringify(source)}\n${PRELUDE.replaceAll('$ROOT', root)}\n${body.replaceAll('$ROOT', root)}`,
  );
  const r = spawnSync('bash', [file], { encoding: 'utf8' });
  const read = (name: string) => (existsSync(path.join(root, name)) ? readFileSync(path.join(root, name), 'utf8') : '');
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    root,
    sleeps: read('sleeps').trim().split('\n').filter(Boolean),
    nudges: read('nudges').trim().split('\n').filter(Boolean),
    out: read('obs.json'),
    err: read('obs.err'),
  };
}

const call = (extra = '', budget = 30, poll = 10) =>
  `vh_converge --budget ${budget} --poll ${poll} --what 'vm mirror' --out "$ROOT/obs.json" ${extra} -- observe; rc=$?; echo "rc=$rc reads=$VH_CONVERGE_READS"`;

describe('vh_converge', () => {
  it('reads immediately and returns 0 on the first converged read', () => {
    const r = run([0], call());
    expect(r.stdout).toContain('rc=0 reads=1');
    expect(r.sleeps).toEqual([]);
    expect(r.out).toBe('{"read":1}\n');
  });

  it('re-reads after exit 3 until converged, keeping only the last observation', () => {
    const r = run([3, 3, 0], call());
    expect(r.stdout).toContain('rc=0 reads=3');
    expect(r.sleeps).toEqual(['sleep 10', 'sleep 10']);
    expect(r.out).toBe('{"read":3}\n');
  });

  it('times out with rc 3, a CONVERGENCE_TIMEOUT line, and the last observation kept as evidence', () => {
    const r = run([3], call('', 25, 10));
    // reads at 0, 10, 20, 25 (last sleep clipped to the remaining 5 s)
    expect(r.stdout).toContain('rc=3 reads=4');
    expect(r.sleeps).toEqual(['sleep 10', 'sleep 10', 'sleep 5']);
    expect(r.stderr).toContain('CONVERGENCE_TIMEOUT: vm mirror did not converge within 25s (4 read(s)); last: read 4 lagging: ref behind');
    expect(r.out).toBe('{"read":4}\n');
    expect(r.err).toContain('read 4 lagging');
  });

  it('--budget 0 is an explicit single read', () => {
    const r = run([3, 0], call('', 0));
    expect(r.stdout).toContain('rc=3 reads=1');
    expect(r.sleeps).toEqual([]);
  });

  it('returns a broken read (exit other than 0/3) at once: a broken read is not lag', () => {
    const r = run([3, 255, 0], call());
    expect(r.stdout).toContain('rc=255 reads=2');
    expect(r.stderr).toContain('vm mirror observation failed (exit 255)');
  });

  it('runs --between only between reads, with the read count, never past the deadline', () => {
    const r = run([3], call('--between nudge', 20, 10));
    // reads at 0, 10, 20; a nudge after read 1 (t=10 < 20), none at t=20
    expect(r.stdout).toContain('rc=3 reads=3');
    expect(r.nudges).toEqual(['nudge 1']);
    expect(readFileSync(path.join(r.root, 'obs-between-1.log'), 'utf8')).toBe('nudged\n');
  });

  it.each([
    ['a missing budget', `vh_converge --poll 10 --what x --out "$ROOT/obs.json" -- observe`],
    ['a zero poll', `vh_converge --budget 10 --poll 0 --what x --out "$ROOT/obs.json" -- observe`],
    ['a missing command', `vh_converge --budget 10 --poll 1 --what x --out "$ROOT/obs.json" --`],
    ['an unknown flag', `vh_converge --budget 10 --poll 1 --wat x --out "$ROOT/obs.json" -- observe`],
  ])('rejects %s with rc 2 before reading', (_label, body) => {
    const r = run([0], `${body}; echo "rc=$?"`);
    expect(r.stdout).toContain('rc=2');
    expect(existsSync(path.join(r.root, 'count'))).toBe(false);
  });

  it('is available to every harness that sources vh.sh', () => {
    const r = run([3, 0], call(), vh);
    expect(r.stdout).toContain('rc=0 reads=2');
  });
});
