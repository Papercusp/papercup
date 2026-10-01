import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const VM = __dirname;

describe('vm/p529-admission.sh (faked p005-ramp.sh, real shim installer)', () => {
  let home: string;
  const vmDir = () => path.join(home, 'capacity', 'scripts', 'agent-capacity', 'vm');
  const bin = () => path.join(home, '.cache', 'agent-capacity', 'prepared', 'papercusp', 'node_modules', '.bin');
  const tmp = () => path.join(home, 'p529tmp');

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'p529-'));
    mkdirSync(vmDir(), { recursive: true });
    mkdirSync(path.join(home, 'capacity', 'fp'));
    for (const f of ['p529-admission.sh', 'install-heavy-shim.sh', 'heavy-shim.sh']) copyFileSync(path.join(VM, f), path.join(vmDir(), f));
    mkdirSync(path.join(bin(), '..', 'vitest'), { recursive: true });
    mkdirSync(bin());
    writeFileSync(path.join(bin(), '..', 'vitest', 'vitest.mjs'), '#!/usr/bin/env bash\n');
    symlinkSync('../vitest/vitest.mjs', path.join(bin(), 'vitest'));
    // Stand-in pc-heavy in the prepared checkout: creates the pool dir and admits at once.
    const pch = path.join(bin(), '..', '..', 'scripts', 'pc-heavy.sh');
    mkdirSync(path.dirname(pch));
    writeFileSync(pch, '#!/usr/bin/env bash\n[ "$1" = -- ] && shift\nmkdir -p "$PC_HEAVY_DIR"\nPC_HEAVY_BYPASS=1 exec "$@"\n');
    // Fake `codex sandbox -c … -- <cmd>`; FAKE_PRIVATE_TMP simulates a sandbox with its own /tmp.
    mkdirSync(path.join(home, 'bin'));
    writeFileSync(
      path.join(home, 'bin', 'codex'),
      '#!/usr/bin/env bash\nwhile [ "$1" != "--" ]; do shift; done; shift\n' +
        '[ -n "${FAKE_PRIVATE_TMP:-}" ] && export PC_HEAVY_DIR="$FAKE_PRIVATE_TMP/slots" PC_HEAVY_SHIM_LOG="$FAKE_PRIVATE_TMP/shim.jsonl"\nexec "$@"\n',
    );
    chmodSync(path.join(home, 'bin', 'codex'), 0o755);
    // The P-019 recordings' own tasks.json, placed beside them in the corpus.
    mkdirSync(path.join(home, '.cache', 'agent-capacity', 'corpus'), { recursive: true });
    writeFileSync(path.join(home, '.cache', 'agent-capacity', 'corpus', 'tasks.json'), '{"version":1,"tasks":[]}\n');
    // The fake ramp records, per arm, the tasks file and PC_HEAVY_* env it saw and whether
    // .bin/vitest was the shim; arm B also writes two request/admit pairs (waits 0.5 and 4) into
    // the shim log. FAKE_ARM_A_RC makes arm A exit with that code (3 = the driver could not run).
    const ramp = path.join(vmDir(), 'p005-ramp.sh');
    writeFileSync(
      ramp,
      [
        '#!/usr/bin/env bash',
        `shim=$(grep -c PC_HEAVY_SHIM_V1 "${bin()}/vitest" 2>/dev/null || true)`,
        'echo "ARM $1 sel=$2 steps=$3 dur=$4 shim=${shim:-0} tasks=${TASKS_FILE:-} env=$(env | grep ^PC_HEAVY_ | sort | tr \'\\n\' \' \')" >> "$HOME/ramp.log"',
        '[ "$1" = p529-a ] && [ -n "${FAKE_ARM_A_RC:-}" ] && exit "$FAKE_ARM_A_RC"',
        'if [ -n "${PC_HEAVY_SHIM_LOG:-}" ]; then',
        '  printf \'%s\\n\' \'{"ev":"request","bin":"vitest","id":"a","t":1}\' \'{"ev":"admit","bin":"vitest","id":"a","t":1.5,"waitSec":0.500}\' \\',
        '    \'{"ev":"request","bin":"tsc","id":"b","t":2}\' \'{"ev":"admit","bin":"tsc","id":"b","t":6,"waitSec":4.000}\' \\',
        '    \'{"ev":"request","bin":"tsc","id":"c","t":7}\' >> "$PC_HEAVY_SHIM_LOG"',
        'fi',
      ].join('\n') + '\n',
    );
    chmodSync(ramp, 0o755);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('ramps arm A without the shim or any pc-heavy env, then arm B with the shim and a fixed K pool, and cleans up', () => {
    const out = execFileSync('bash', [path.join(vmDir(), 'p529-admission.sh'), '3', '12 18', '300'], {
      encoding: 'utf8',
      cwd: home,
      env: { ...process.env, PATH: `${home}/bin:${process.env.PATH}`, HOME: home, P529_TMP: tmp(), PC_HEAVY_BYPASS: '1', PC_HEAVY_SLOTS: '99' },
    });
    expect(out).toMatch(/^P529_PREFLIGHT_OK pool=\S+\/slots-k3$/m);
    const arms = readFileSync(path.join(home, 'ramp.log'), 'utf8').trim().split('\n');
    expect(arms).toHaveLength(2);
    const tasks = path.join(home, '.cache', 'agent-capacity', 'corpus', 'tasks.json');
    expect(arms[0]).toBe(`ARM p529-a sel=all steps=12 18 dur=300 shim=0 tasks=${tasks} env=`);
    expect(arms[1]).toMatch(new RegExp(`^ARM p529-k3 sel=all steps=12 18 dur=300 shim=1 tasks=${tasks.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} env=`));
    for (const kv of [
      'PC_HEAVY_SLOTS=3 ',
      `PC_HEAVY_DIR=${tmp()}/slots-k3 `,
      'PC_HEAVY_MEM_CLAMP=0 ',
      'PC_HEAVY_PSI_ADMISSION=0 ',
      'PC_HEAVY_COALESCE=0 ',
      'PC_HEAVY_TIMEOUT_SEC=7200 ',
      `PC_HEAVY_SHIM_LOG=${tmp()}/shim-k3.jsonl `,
    ])
      expect(`${arms[1]} `).toContain(kv); // the log's trim() ate the last var's trailing space
    expect(arms[1]).not.toContain('PC_HEAVY_BYPASS');

    expect(out).toMatch(/^P529_SHIM requests=3 admitted=2 unadmitted=1 wait_p50=4\.0 wait_p90=4\.0 wait_max=4\.0$/m);
    expect(out).toMatch(/^P529_DONE /m);
    // The shim is gone afterwards: the prepared checkout is back to its original symlink.
    expect(out).toMatch(/^HEAVY_SHIM_REMOVED name=vitest$/m);
    expect(readFileSync(path.join(bin(), 'vitest'), 'utf8')).not.toContain('PC_HEAVY_SHIM_V1');
    expect(readFileSync(path.join(home, 'capacity', 'fp', 'p529-shim-k3.jsonl'), 'utf8').trim().split('\n')).toHaveLength(5);
  });

  it('aborts before arm B, and removes the shim, when the Codex sandbox cannot reach the shared pool', () => {
    let code = 0;
    let stderr = '';
    try {
      execFileSync('bash', [path.join(vmDir(), 'p529-admission.sh'), '3', '12', '300'], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, PATH: `${home}/bin:${process.env.PATH}`, HOME: home, P529_TMP: tmp(), FAKE_PRIVATE_TMP: path.join(home, 'private-tmp') },
      });
    } catch (e) {
      code = (e as { status: number }).status;
      stderr = String((e as { stderr: string }).stderr);
    }
    expect(code).toBe(4);
    expect(stderr).toMatch(/P529_ERROR codex sandbox does not share the admission pool: out="pch-ok"/);
    expect(readFileSync(path.join(home, 'ramp.log'), 'utf8').trim().split('\n')).toHaveLength(1); // arm A only
    expect(readFileSync(path.join(bin(), 'vitest'), 'utf8')).not.toContain('PC_HEAVY_SHIM_V1');
  });

  it('stops before arm B, with the shim never installed, when arm A’s driver could not run', () => {
    let code = 0;
    let stderr = '';
    try {
      execFileSync('bash', [path.join(vmDir(), 'p529-admission.sh'), '3', '12', '300'], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, PATH: `${home}/bin:${process.env.PATH}`, HOME: home, P529_TMP: tmp(), FAKE_ARM_A_RC: '3' },
      });
    } catch (e) {
      code = (e as { status: number }).status;
      stderr = String((e as { stderr: string }).stderr);
    }
    expect(code).toBe(5);
    expect(stderr).toMatch(/P529_ERROR arm=a driver did not run, stopping before arm B/);
    expect(readFileSync(path.join(home, 'ramp.log'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(path.join(bin(), 'vitest'), 'utf8')).not.toContain('PC_HEAVY_SHIM_V1');
  });

  it('refuses to start without the recordings’ tasks file', () => {
    rmSync(path.join(home, '.cache', 'agent-capacity', 'corpus'), { recursive: true, force: true });
    let code = 0;
    let stderr = '';
    try {
      execFileSync('bash', [path.join(vmDir(), 'p529-admission.sh'), '3', '12'], { encoding: 'utf8', env: { ...process.env, HOME: home, P529_TMP: tmp() }, stdio: 'pipe' });
    } catch (e) {
      code = (e as { status: number }).status;
      stderr = String((e as { stderr: string }).stderr);
    }
    expect(code).toBe(2);
    expect(stderr).toMatch(/P529_ERROR no tasks file at \S+\/corpus\/tasks\.json/);
  });

  it('refuses to start without a prepared checkout', () => {
    rmSync(path.join(home, '.cache'), { recursive: true, force: true });
    let code = 0;
    try {
      execFileSync('bash', [path.join(vmDir(), 'p529-admission.sh'), '3', '12'], { encoding: 'utf8', env: { ...process.env, HOME: home, P529_TMP: tmp() }, stdio: 'pipe' });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(2);
  });
});
