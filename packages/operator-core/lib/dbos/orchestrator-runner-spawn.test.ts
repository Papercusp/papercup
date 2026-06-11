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
// Inputs are recorded so the display-lease wiring (extraEnv.DISPLAY) is assertable.
const H = vi.hoisted(() => ({
  cmd: null as null | { command: string; args: string[]; env: NodeJS.ProcessEnv },
  inputs: [] as Array<{ extraEnv: Record<string, string> }>,
}));
vi.mock('../harness-invoke-once', () => ({
  buildInvokeOnce: (input: { extraEnv: Record<string, string> }) => {
    H.inputs.push(input);
    return H.cmd;
  },
  // orchestrator-runner ALSO imports resolveSpawnBackendModel from this module
  // (the AGENT_GOVERNOR bucket-keying path). The mock must mirror the module's
  // FULL named-export surface or Vitest 4's module-evaluator throws "No
  // resolveSpawnBackendModel export is defined on the mock" when the importer
  // is linked — load-order-dependent, so it passed isolated but flaked under
  // the full operator-core suite (2026-06-11).
  resolveSpawnBackendModel: () => ({ backend: 'omp', model: '' }),
}));

import { spawnInvokeOnce } from './orchestrator-runner';
import { _resetDisplayPoolForTests } from '../deployment/display-allocator';

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

  // EI-286 leg (b): a child spawned by a port-aware host (PAPERCUSP_HONO_PORT
  // set, e.g. staging :3170) must get its SPAWNER's MCP base — the child
  // inherits process.env, where .env.local pins PAPERCUSP_OPERATOR_URL to the
  // green :3070, so without the override the P-071 Queen handshook the WRONG
  // host (stale role catalog; placement tools never appeared).
  it('pins the child MCP base to the spawning host, overriding the inherited host env', async () => {
    vi.stubEnv('PAPERCUSP_HONO_PORT', '3170');
    // The poison case: the HOST's own env points elsewhere (.env.local).
    vi.stubEnv('PAPERCUSP_OPERATOR_URL', 'http://localhost:3070/api/mcp');
    H.cmd = node('process.stdout.write("ok")');
    await spawnInvokeOnce(process.cwd(), 'queen', [], {});
    expect(H.inputs.at(-1)?.extraEnv.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:3170/api/mcp');
    vi.unstubAllEnvs();
  });

  it('respects a caller-pinned PAPERCUSP_OPERATOR_URL (no override)', async () => {
    vi.stubEnv('PAPERCUSP_HONO_PORT', '3170');
    vi.stubEnv('PAPERCUSP_OPERATOR_URL', '');
    H.cmd = node('process.stdout.write("ok")');
    await spawnInvokeOnce(process.cwd(), 'queen', [], {
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9999/api/mcp',
    });
    expect(H.inputs.at(-1)?.extraEnv.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:9999/api/mcp');
    vi.unstubAllEnvs();
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

// ── per-agent DISPLAY leasing (hive-frame-desktops-live-view P-002) ─────────
describe('spawnInvokeOnce display leasing', () => {
  beforeEach(() => {
    H.inputs = [];
    process.env.PAPERCUSP_DESKTOP_DISPLAYS = '1';
    process.env.PAPERCUSP_DESKTOP_STATE_DIR = '/tmp/pc-display-spawn-test';
    _resetDisplayPoolForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.PAPERCUSP_DESKTOP_DISPLAYS;
    delete process.env.PAPERCUSP_DESKTOP_STATE_DIR;
    _resetDisplayPoolForTests();
  });

  it('on a desktop frame the agent env carries the leased DISPLAY, released on exit', async () => {
    H.cmd = node('process.exit(0)');
    const r1 = await spawnInvokeOnce(process.cwd(), 'worker', [], {});
    expect(r1.exitCode).toBe(0);
    expect(H.inputs[0].extraEnv.DISPLAY).toBe(':99');
    expect(H.inputs[0].extraEnv.PAPERCUSP_AGENT_DISPLAY).toBe(':99');
    // lease released after the child exited → next spawn re-leases :99
    await spawnInvokeOnce(process.cwd(), 'worker', [], {});
    expect(H.inputs[1].extraEnv.DISPLAY).toBe(':99');
  });

  it('pool exhausted → headless spawn (no DISPLAY) + a warn, never queued', async () => {
    H.cmd = node('setTimeout(() => process.exit(0), 250)');
    const slow = spawnInvokeOnce(process.cwd(), 'worker', [], {}); // holds :99
    await new Promise((r) => setTimeout(r, 50));
    H.cmd = node('process.exit(0)');
    const r2 = await spawnInvokeOnce(process.cwd(), 'validator', [], {});
    expect(r2.exitCode).toBe(0);
    expect(H.inputs[1].extraEnv.DISPLAY).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('display pool exhausted'));
    await slow;
  });

  it('off-frame (no pool env) nothing is injected', async () => {
    delete process.env.PAPERCUSP_DESKTOP_DISPLAYS;
    _resetDisplayPoolForTests();
    H.cmd = node('process.exit(0)');
    await spawnInvokeOnce(process.cwd(), 'worker', [], {});
    expect(H.inputs[0].extraEnv.DISPLAY).toBeUndefined();
    expect(H.inputs[0].extraEnv.PAPERCUSP_AGENT_DISPLAY).toBeUndefined();
  });
});
