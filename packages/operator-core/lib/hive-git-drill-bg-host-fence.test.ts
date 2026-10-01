/**
 * WI-10004352: the physical hive-git drill holds a SHARED `bg-host` lease for the
 * scenario's lifetime (papercusp-desktop/bin/vm-rig/lib/bg-host-fence.sh), so a
 * peer's dev:restart { target:'bg-host' } drains against it and refuses instead
 * of bouncing the tower bg-host mid-phase (P-521 0.0.26 drill run 2 died that way).
 *
 * The behavioural cases source the real lib against a fake ptool that logs each
 * verb with its stdin args, and pretty-prints its JSON the way ptool does. No
 * real operator, lock, or process outside the temp dir is touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'vm-rig', 'lib', 'bg-host-fence.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate papercusp-desktop/bin/vm-rig/lib/bg-host-fence.sh');
}

const vmRig = join(repoRoot(), 'papercusp-desktop', 'bin', 'vm-rig');
const fenceLib = join(vmRig, 'lib', 'bg-host-fence.sh');
const physicalProbe = readFileSync(join(vmRig, 'hive-git-physical-probe.sh'), 'utf8');
const physicalScenario = readFileSync(join(vmRig, 'hive-git-physical-scenario.sh'), 'utf8');

const LOCK_ID = '11111111-2222-4333-8444-555555555555';

describe('physical drill bg-host fence (WI-10004352)', () => {
  let root: string;
  let ptool: string;
  let log: string;
  let refusals: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'bg-host-fence-'));
    log = join(root, 'calls.log');
    refusals = join(root, 'refusals');
    ptool = join(root, 'ptool');
    // One "<verb> <stdin JSON>" line per call. The first FENCE_REFUSE_N acquires
    // are refused the way a draining exclusive holder refuses them (ok:false,
    // ptool exit 5); later ones are granted.
    writeFileSync(
      ptool,
      [
        '#!/usr/bin/env bash',
        'verb="$1"',
        'args="$(cat)"',
        `printf '%s %s\\n' "$verb" "$args" >> '${log}'`,
        'case "$verb" in',
        '  locks:acquire_resource)',
        `    n=$(($(cat '${refusals}' 2>/dev/null || echo 0) + 1)); printf '%s\\n' "$n" > '${refusals}'`,
        '    if [ "$n" -le "${FENCE_REFUSE_N:-0}" ]; then',
        `      printf '{\\n  "ok": false,\\n  "reason": "drain_in_progress"\\n}\\n'; exit 5`,
        '    fi',
        `    printf '{\\n  "ok": true,\\n  "lock_id": "${LOCK_ID}",\\n  "mode": "shared"\\n}\\n' ;;`,
        `  *) printf '{\\n  "ok": true\\n}\\n' ;;`,
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(ptool, 0o755);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = (script: string, env: Record<string, string> = {}) => {
    rmSync(log, { force: true });
    rmSync(refusals, { force: true });
    return spawnSync(
      'bash',
      ['-c', ['set -euo pipefail', `. '${fenceLib}'`, `BG_HOST_FENCE_CALL='${ptool}'`, script].join('\n')],
      {
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
        env: { ...process.env, BG_HOST_FENCE_POLL_SEC: '0', BG_HOST_FENCE_TICK_SEC: '0.1', ...env },
      },
    );
  };
  const calls = (verb: string) =>
    (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : [])
      .filter((line) => line.startsWith(`${verb} `))
      .map((line) => JSON.parse(line.slice(verb.length + 1)) as Record<string, unknown>);

  it('takes a shared bg-host lease, heartbeats it, and releases it exactly once', () => {
    const result = run(
      ['bg_host_fence_acquire "drill run-1: do not restart"', 'sleep 2', 'bg_host_fence_release', 'bg_host_fence_release', 'sleep 0.5'].join('\n'),
      { BG_HOST_FENCE_HEARTBEAT_SEC: '1' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(calls('locks:acquire_resource')).toEqual([
      { resource: 'bg-host', mode: 'shared', ttl_sec: 900, reason: 'drill run-1: do not restart' },
    ]);
    const heartbeats = calls('locks:heartbeat_resource');
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(heartbeats[0]).toEqual({ lock_id: LOCK_ID, ttl_sec: 900 });
    // Called twice, released once; the watcher did not release it a second time.
    expect(calls('locks:release_resource')).toEqual([{ lock_id: LOCK_ID }]);
    expect(result.stderr).toContain(`BG_HOST_FENCE_ACQUIRED lock_id=${LOCK_ID}`);
    expect(result.stderr).toContain(`BG_HOST_FENCE_RELEASED lock_id=${LOCK_ID} by=caller`);
    expect(result.stderr).not.toContain('by=watcher');
  });

  it('stands the watcher down on release, so a released lease is never heartbeated', () => {
    const result = run(['bg_host_fence_acquire "drill run-2"', 'bg_host_fence_release', 'sleep 2'].join('\n'), {
      BG_HOST_FENCE_HEARTBEAT_SEC: '1',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(calls('locks:heartbeat_resource')).toEqual([]);
    expect(calls('locks:release_resource')).toEqual([{ lock_id: LOCK_ID }]);
  });

  it('releases the lease from the watcher when the caller is SIGKILLed before its EXIT handler can run', () => {
    const result = run(['bg_host_fence_acquire "drill run-3"', 'kill -KILL $$'].join('\n'), {
      BG_HOST_FENCE_HEARTBEAT_SEC: '60',
    });
    expect(result.signal).toBe('SIGKILL');
    expect(calls('locks:release_resource')).toEqual([{ lock_id: LOCK_ID }]);
    expect(result.stderr).toContain(`BG_HOST_FENCE_RELEASED lock_id=${LOCK_ID} by=watcher`);
  });

  it('waits out a restart drain: refused acquires are retried until the lease is granted', () => {
    const result = run(['bg_host_fence_acquire "drill run-4"', 'bg_host_fence_release'].join('\n'), {
      FENCE_REFUSE_N: '2',
      BG_HOST_FENCE_WAIT_SEC: '30',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(calls('locks:acquire_resource')).toHaveLength(3);
    expect(result.stderr).toContain('lease not granted (attempt 2');
    expect(result.stderr).toContain('attempts=3');
    expect(calls('locks:release_resource')).toEqual([{ lock_id: LOCK_ID }]);
  });

  it('refuses to fence (return 1, nothing to release) when the lease is not granted within the wait', () => {
    const result = run(
      [
        'if bg_host_fence_acquire "drill run-5"; then echo GOT; else echo "REFUSED rc=$?"; fi',
        'bg_host_fence_release',
      ].join('\n'),
      // The fence's deadline is bash's whole-second SECONDS counter, and the first attempt
      // runs two node processes (args JSON + the stubbed call). Under load a 1s wait could
      // expire before any retry, leaving 1 attempt where this case asserts >=2. Give it
      // several whole seconds of slack. The loop still exits on its own deadline.
      { FENCE_REFUSE_N: '1000', BG_HOST_FENCE_WAIT_SEC: '4', BG_HOST_FENCE_POLL_SEC: '0.3' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('REFUSED rc=1');
    expect(result.stdout).not.toContain('GOT');
    expect(calls('locks:acquire_resource').length).toBeGreaterThanOrEqual(2);
    expect(calls('locks:release_resource')).toEqual([]);
    expect(result.stderr).toContain('could not take a shared bg-host lease');
  });

  it('the probe holds the lease across exactly the scenario launch and releases it on every exit path', () => {
    expect(physicalProbe).toContain('. "$HERE/lib/bg-host-fence.sh"');
    // The fence and the scenario reach the tower through the same CLI.
    expect(physicalProbe).toMatch(/^BG_HOST_FENCE_CALL="\$HOME\/\.local\/bin\/ptool"$/m);
    expect(physicalScenario).toMatch(/^TOWER_CALL="\$HOME\/\.local\/bin\/ptool"$/m);

    const launchSite = '"$SCENARIO" "$unsigned_evidence" "$tower_identity" "$vm_identity"';
    const launch = physicalProbe.indexOf(launchSite);
    const acquire = physicalProbe.indexOf('bg_host_fence_acquire ');
    expect(launch).toBeGreaterThan(0);
    expect(acquire).toBeGreaterThan(0);
    expect(acquire).toBeLessThan(launch);
    // A refused lease fails the run before the scenario starts.
    expect(physicalProbe.slice(acquire, launch)).toMatch(/\|\| fail '/);
    // The lease ends as soon as the scenario returns.
    expect(physicalProbe.slice(launch + launchSite.length).split('\n')[1].trim()).toBe('bg_host_fence_release');

    const cleanupStart = physicalProbe.indexOf('\ncleanup() {');
    expect(cleanupStart).toBeGreaterThan(0);
    const cleanupBody = physicalProbe.slice(cleanupStart, physicalProbe.indexOf('\n}\n', cleanupStart));
    expect(cleanupBody).toContain('bg_host_fence_release');
    // cleanup is the EXIT handler, installed before the lease is taken.
    const trapAt = physicalProbe.indexOf('\ntrap cleanup EXIT\n');
    expect(trapAt).toBeGreaterThan(0);
    expect(trapAt).toBeLessThan(acquire);
  });
});
