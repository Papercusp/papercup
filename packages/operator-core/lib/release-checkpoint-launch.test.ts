/**
 * release-checkpoint-launch — the detached green-checkpoint fire-now primitive (WI-1320 follow-up).
 * Asserts the systemd-run argv construction (pure) + the launch/refuse resolution with an injected
 * spawn seam — no real suite fires.
 *
 * Run: cd packages/operator-core && npx vitest run lib/release-checkpoint-launch.test.ts
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCheckpointSystemdArgv,
  launchDetachedCheckpoint,
  CHECKPOINT_UNIT,
  CHECKPOINT_MAX_RUNTIME_SEC,
} from './release-checkpoint-launch';

describe('buildCheckpointSystemdArgv', () => {
  it('targets the manual unit, bounds runtime, and runs the green-checkpoint CLI in the tree root', () => {
    const argv = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin:/bin');
    expect(argv).toContain(`--unit=${CHECKPOINT_UNIT}`);
    expect(argv).toContain(`--property=RuntimeMaxSec=${CHECKPOINT_MAX_RUNTIME_SEC}`);
    expect(argv).toContain('--working-directory=/tree');
    expect(argv).toContain('--setenv=PATH=/usr/bin:/bin');
    const inner = argv[argv.length - 1]!;
    expect(inner).toContain('apps/operator/lib/release/green-checkpoint.ts');
    expect(inner).toContain("PAPERCUSP_INTEGRATION_ROOT='/tree'");
    expect(inner).toContain('> /tmp/cp.log 2>&1');
  });
});

/** A fake ChildProcess whose close/error we drive. */
function fakeChild() {
  const ee = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  ee.stderr = new EventEmitter();
  return ee;
}

describe('launchDetachedCheckpoint', () => {
  it('resolves launched:true when systemd-run exits 0', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn);
    child.emit('close', 0);
    const r = await p;
    expect(r.launched).toBe(true);
    expect(r.unit).toBe(CHECKPOINT_UNIT);
    expect(spawnFn).toHaveBeenCalledWith('systemd-run', expect.arrayContaining([`--unit=${CHECKPOINT_UNIT}`]));
  });

  it('resolves launched:false with a reason when the unit already exists (non-zero exit)', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn);
    child.stderr.emit('data', 'Unit papercup-green-checkpoint-manual.service already exists.');
    child.emit('close', 1);
    const r = await p;
    expect(r.launched).toBe(false);
    expect(r.reason).toMatch(/already/i);
  });

  it('resolves launched:false on a spawn error', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn);
    child.emit('error', new Error('systemd-run not found'));
    const r = await p;
    expect(r.launched).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });
});
