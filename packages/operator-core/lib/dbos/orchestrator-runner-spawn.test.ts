/**
 * orchestrator-runner-spawn.test.ts — plan harness-test-coverage-for-launch P-012.
 *
 * Covers spawnInvokeOnce — the subprocess spawn + SIGTERM timeout-kill +
 * stdout/stderr capture that every DBOS agent run (realRunner / realFinalizer /
 * the debugger gate) goes through. Its pure helpers were tested; the actual
 * spawn path was not. We mock `buildInvokeOnce` to drive a fake `node -e`
 * process (deterministic, no real agent binary), and pin a short
 * INVOKE_TIMEOUT_MS via env BEFORE the module loads (it's read at module init).
 *
 * vitest-fail-on-console is active and spawnInvokeOnce console.error's on a
 * non-zero/spawn-error exit (the P-005 stderr surfacing) — so we spy+silence it
 * and assert it fired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execPath } from 'node:process';

// Set the invoke timeout BEFORE orchestrator-runner is imported (INVOKE_TIMEOUT_MS
// is a module-load const). 600ms is ample for the fast cases and bounds the kill.
vi.hoisted(() => {
  process.env.PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS = '600';
});

// buildInvokeOnce is the seam: tests set H.cmd to the {command,args,env} to spawn.
const H = vi.hoisted(() => ({ cmd: null as null | { command: string; args: string[]; env: NodeJS.ProcessEnv } }));
vi.mock('../harness-invoke-once', () => ({ buildInvokeOnce: () => H.cmd }));

import { spawnInvokeOnce } from './orchestrator-runner';

const node = (script: string) => ({ command: execPath, args: ['-e', script], env: process.env });

beforeEach(() => {
  // P-005 failLog / spawn-error log → console.error; silence (fail-on-console).
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('spawnInvokeOnce', () => {
  it('captures stdout and a clean exit (code 0)', async () => {
    H.cmd = node('process.stdout.write("DECISION\\nNEXT_WORKER F-1\\n")');
    const r = await spawnInvokeOnce(process.cwd(), 'director', [], {});
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('NEXT_WORKER F-1');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('strips [timestamp] log lines from the captured output', async () => {
    H.cmd = node('process.stdout.write("[2026-06-02T10:00:00.000Z] booting\\nDONE\\n")');
    const r = await spawnInvokeOnce(process.cwd(), 'director', [], {});
    expect(r.output).toBe('DONE'); // the timestamp line is filtered out
  });

  it('surfaces stderr + the non-zero exit code (P-005), and logs the fail line', async () => {
    H.cmd = node('process.stderr.write("kaboom");process.exit(3)');
    const r = await spawnInvokeOnce(process.cwd(), 'worker', [], {});
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('kaboom');
    expect(r.output).toBe('');
    expect(console.error).toHaveBeenCalled(); // failLog surfaced, not silent
  });

  it('SIGTERM-kills a hung child at the timeout and resolves (never hangs)', async () => {
    H.cmd = node('setInterval(() => {}, 1000)'); // never exits on its own
    const start = Date.now();
    const r = await spawnInvokeOnce(process.cwd(), 'worker', [], {});
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000); // killed at ~600ms, not hung to the test timeout
    expect(elapsed).toBeGreaterThanOrEqual(400); // it DID wait for the timeout, not exit early
    expect(r.exitCode).not.toBe(0); // terminated by signal (code null → 1)
  }, 10_000);

  it('resolves (never rejects) with exitCode 1 on a spawn error (bad command)', async () => {
    H.cmd = { command: 'papercusp-no-such-binary-zzz', args: [], env: process.env };
    const r = await spawnInvokeOnce(process.cwd(), 'worker', [], {});
    expect(r.exitCode).toBe(1);
    expect(r.output).toBe('');
    expect(r.stderr).toBeTruthy(); // the spawn-error message
    expect(console.error).toHaveBeenCalled();
  });
});
