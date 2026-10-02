import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pcHeavyFixtureOptions } from './testing/pc-heavy-fixture';

const SCRIPT = process.env.PROBE_SCRIPT ?? resolve(__dirname, '../../../scripts/pc-heavy.sh');
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pc-heavy-stdin-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function throughPreemption(args: string[], input: string) {
  // Exercise the actual asynchronous supervisor without joining the host's
  // admission queue or inheriting a parent's admission/retry controls.
  return spawnSync('bash', [SCRIPT, '--pc-heavy-internal-preempt-run',
    String(process.pid), join(dir, 'exclusive-intent'), process.execPath, ...args], {
    ...pcHeavyFixtureOptions(dir, {
      PATH: process.env.PATH ?? '',
      PC_HEAVY_NO_SELF_COPY: '1',
      PC_HEAVY_PREEMPT_PID_DIR: dir,
      PC_HEAVY_PREEMPT_POLL_SEC: '0.02',
      PC_HEAVY_PREEMPT_EXCLUSIVE: '0',
      PC_HEAVY_PSI_ADMISSION: '0',
    }), input, encoding: 'utf8', timeout: 10_000,
  });
}

describe('pc-heavy preserves caller stdin across asynchronous supervision (EI-24829343157624859)', () => {
  it('executes a program supplied on stdin rather than silently evaluating EOF', () => {
    const program = "process.stdout.write('EVALUATOR_STARTED\\n');\n";
    const direct = spawnSync(process.execPath, ['--input-type=module'], {
      input: program, encoding: 'utf8', timeout: 10_000,
    });
    expect(direct.status, direct.stderr).toBe(0);
    expect(direct.stdout).toBe('EVALUATOR_STARTED\n');
    const wrapped = throughPreemption(['--input-type=module'], program);
    expect(wrapped.status, wrapped.stderr).toBe(0);
    expect(wrapped.stdout).toBe(direct.stdout);
  });

  it('passes data bytes unchanged to a command that reads fd 0', () => {
    const payload = 'first line\n{"literal":"$HOME `whoami`"}\n';
    const wrapped = throughPreemption(['--input-type=module', '-e',
      "import fs from 'node:fs'; process.stdout.write(fs.readFileSync(0));"], payload);
    expect(wrapped.status, wrapped.stderr).toBe(0);
    expect(wrapped.stdout).toBe(payload);
  });
});
