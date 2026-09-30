/**
 * WI-10004195: the VM git-sync:run client deadline must cover the server's own
 * git-sync:run budget, and an unknown outcome must be replayed under the call's
 * idempotency key instead of failing the phase.
 *
 * Same-box run 9 lost phase A because vmcall.sh bounds every MCP call at 30s by
 * default while git-sync:run is allowed 60s server-side (a 45s fire, two 5s HEAD
 * reads, 5s MCP settlement). The bootstrap fire's result file was empty; the VM
 * owner answered every other call in about 1s. These tests pin the deadline to the
 * server constant and drive the real run_vm_git_sync body against a stub ssh.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'vm-rig', 'hive-git-physical-scenario.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate papercusp-desktop/bin/vm-rig/hive-git-physical-scenario.sh');
}

const vmRig = join(repoRoot(), 'papercusp-desktop', 'bin', 'vm-rig');
const scenario = readFileSync(join(vmRig, 'hive-git-physical-scenario.sh'), 'utf8');
const sameBoxRig = readFileSync(join(vmRig, 'same-box-rig.sh'), 'utf8');
const vmcall = readFileSync(join(vmRig, 'vmcall.sh'), 'utf8');

// The server-side git-sync:run budget, read from the tool's source (importing the tool
// module would pull its whole runtime graph into a unit test): the bounded fire plus two
// bounded HEAD reads plus MCP settlement (5s).
const runSource = readFileSync(join(repoRoot(), 'packages', 'operator-core', 'lib', 'agent-tools', 'git_sync', 'run.ts'), 'utf8');
function msConstant(name: string): number {
  const m = new RegExp(`const ${name} = ([\\d_]+);`).exec(runSource);
  if (!m) throw new Error(`${name} not found in git_sync/run.ts`);
  return Number(m[1].replace(/_/g, ''));
}
const SERVER_BUDGET_SEC = (msConstant('GIT_SYNC_RUN_BUDGET_MS') + 2 * msConstant('HEAD_SHA_TIMEOUT_MS') + 5_000) / 1000;

function scenarioDeadlineSec(): number {
  const m = /^VM_GIT_SYNC_CALL_TIMEOUT_SEC=(\d+)$/m.exec(scenario);
  expect(m, 'VM_GIT_SYNC_CALL_TIMEOUT_SEC assignment').not.toBeNull();
  return Number(m![1]);
}

describe('VM git-sync:run client deadline (WI-10004195)', () => {
  it('vmcall still defaults below the server budget, which is why the caller must override it', () => {
    const m = /MCP_TIMEOUT_SEC="\$\{PCUSP_VM_CALL_TIMEOUT_SEC:-(\d+)\}"/.exec(vmcall);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(SERVER_BUDGET_SEC);
  });

  it('the scenario gives the VM fire more than the server budget', () => {
    expect(scenarioDeadlineSec()).toBeGreaterThan(SERVER_BUDGET_SEC);
  });

  it('the same-box converge fire uses the same deadline', () => {
    const fire = sameBoxRig.split('\n').find((line) => line.includes("git-sync:run '{") && line.includes('$VM_CALL'));
    expect(fire, 'same-box converge VM git-sync:run line').toBeDefined();
    const m = /PCUSP_VM_CALL_TIMEOUT_SEC=(\d+)/.exec(fire!);
    expect(m, fire).not.toBeNull();
    expect(Number(m![1])).toBe(scenarioDeadlineSec());
  });

  describe('run_vm_git_sync against a stub ssh', () => {
    const start = scenario.indexOf('VM_GIT_SYNC_CALL_TIMEOUT_SEC=');
    const fnStart = scenario.indexOf('run_vm_git_sync() {');
    const body = scenario.slice(start, scenario.indexOf('\n}\n', fnStart) + 3);
    const fired = JSON.stringify({ ok: true, fired: true, status: 'nothing', success: true });
    const refused = JSON.stringify({ ok: false, fired: false, status: 'refused', success: false });

    type Mode = 'answer' | 'timeout-once' | 'timeout-always' | 'refused' | 'transport';
    function run(mode: Mode) {
      const root = mkdtempSync(join(tmpdir(), 'vm-git-sync-deadline-'));
      try {
        const log = join(root, 'ssh.log');
        const once = join(root, 'timed-out-once');
        const out = join(root, 'out.json');
        const script = [
          'set -euo pipefail',
          'VM=same-box-vm',
          "VM_CALL='/tmp/vmcall.sh'",
          'VM_GIT_SYNC_SLUG=hello-world',
          'PHASE_A_POT_HOME=hello-world-pot',
          'SSH_OPTS=(-o BatchMode=yes)',
          // The stub receives exactly the remote command string the scenario sends.
          'ssh() {',
          '  local cmd="${@: -1}"',
          `  printf '%s\\n' "$cmd" >> '${log}'`,
          '  case "$STUB_MODE" in',
          `    answer) printf '%s\\n' '${fired}' ;;`,
          `    timeout-once) if [ -e '${once}' ]; then printf '%s\\n' '${fired}'; else : > '${once}'; echo 'MCP_RESULT_TIMEOUT: MCP call did not complete within 75s' >&2; return 124; fi ;;`,
          `    timeout-always) echo 'MCP_RESULT_TIMEOUT: MCP call did not complete within 75s' >&2; return 124 ;;`,
          `    refused) printf '%s\\n' '${refused}'; return 5 ;;`,
          `    transport) echo 'ssh: connect to host same-box-vm: Connection refused' >&2; return 255 ;;`,
          '  esac',
          '}',
          body,
          `rc=0; run_vm_git_sync > '${out}' || rc=$?`,
          'echo "RC=$rc"',
        ].join('\n');
        const result = spawnSync('bash', ['-c', script], {
          encoding: 'utf8',
          timeout: 30_000,
          killSignal: 'SIGKILL',
          env: { ...process.env, STUB_MODE: mode, VM_GIT_SYNC_REPLAY_WAIT_SEC: '0' },
        });
        const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
        const rc = Number(/RC=(\d+)/.exec(result.stdout)?.[1] ?? NaN);
        return { ...result, rc, calls, output: existsSync(out) ? readFileSync(out, 'utf8') : '' };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    const keyOf = (call: string) => /--idempotency-key '([^']+)'/.exec(call)?.[1];

    it('carries the long deadline and an idempotency key on the first call', () => {
      const r = run('answer');
      expect(r.rc, r.stderr).toBe(0);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]).toContain(`PCUSP_VM_CALL_TIMEOUT_SEC='${scenarioDeadlineSec()}' '/tmp/vmcall.sh' git-sync:run`);
      expect(keyOf(r.calls[0])).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse(r.output).fired).toBe(true);
    });

    it('replays a client-deadline miss under the SAME key and records the replayed answer', () => {
      const r = run('timeout-once');
      expect(r.rc, r.stderr).toBe(0);
      expect(r.calls).toHaveLength(2);
      expect(keyOf(r.calls[1])).toBe(keyOf(r.calls[0]));
      expect(r.stderr).toContain('replaying idempotency key');
      expect(JSON.parse(r.output).fired).toBe(true);
    });

    it('gives up after two replays and returns the deadline exit, not success', () => {
      const r = run('timeout-always');
      expect(r.calls).toHaveLength(3);
      expect(r.rc).toBe(124);
      expect(new Set(r.calls.map(keyOf)).size).toBe(1);
    });

    it('does not replay an answered refusal (exit 5 is judged by require_git_sync_fired)', () => {
      const r = run('refused');
      expect(r.calls).toHaveLength(1);
      expect(r.rc).toBe(0);
      expect(JSON.parse(r.output).fired).toBe(false);
    });

    it('does not replay a transport failure', () => {
      const r = run('transport');
      expect(r.calls).toHaveLength(1);
      expect(r.rc).toBe(255);
    });
  });
});
