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
  checkpointUnitForRoot,
  CHECKPOINT_MAX_RUNTIME_SEC,
} from './release-checkpoint-launch';

describe('buildCheckpointSystemdArgv', () => {
  it('targets the manual unit, bounds runtime, and runs the green-checkpoint CLI in the tree root', () => {
    const argv = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin:/bin');
    expect(argv).toContain(`--unit=${checkpointUnitForRoot('/tree')}`); // per-root (2026-07-01): cross-root manual gates no longer serialize
    expect(argv).toContain(`--property=RuntimeMaxSec=${CHECKPOINT_MAX_RUNTIME_SEC}`);
    expect(argv).toContain('--working-directory=/tree');
    expect(argv).toContain('--setenv=PATH=/usr/bin:/bin');
    const inner = argv[argv.length - 1]!;
    expect(inner).toContain('apps/operator/lib/release/green-checkpoint.ts');
    expect(inner).toContain("PAPERCUSP_INTEGRATION_ROOT='/tree'");
    expect(inner).toContain('> /tmp/cp.log 2>&1');
  });

  it('does NOT forward the partial-green-gate flag by default (whole-batch, back-compat)', () => {
    const inner = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin:/bin').at(-1)!;
    expect(inner).not.toContain('PAPERCUSP_PARTIAL_GREEN_GATE');
  });

  it('forwards PAPERCUSP_PARTIAL_GREEN_GATE when armed — a manual checkpoint then uses the same longest-green-prefix FF as the periodic gate', () => {
    const inner = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin:/bin', true).at(-1)!;
    expect(inner).toContain("PAPERCUSP_PARTIAL_GREEN_GATE='1'");
    expect(inner).toContain('apps/operator/lib/release/green-checkpoint.ts');
    expect(inner).toContain("PAPERCUSP_INTEGRATION_ROOT='/tree'");
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
    expect(r.unit).toBe(checkpointUnitForRoot('/tree'));
    expect(spawnFn).toHaveBeenCalledWith('systemd-run', expect.arrayContaining([`--unit=${checkpointUnitForRoot('/tree')}`]));
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

describe('checkpointUnitForRoot (per-root manual gates, 2026-07-01)', () => {
  it('DIFFERENT roots get DIFFERENT units (no cross-repo serialization); same root is stable (duplicate guard intact)', () => {
    const a = checkpointUnitForRoot('/home/x/papercusp');
    const b = checkpointUnitForRoot('/home/x/papercup');
    expect(a).not.toBe(b);
    expect(a).toBe(checkpointUnitForRoot('/home/x/papercusp'));
    expect(a.startsWith(`${CHECKPOINT_UNIT}-`)).toBe(true);
    // systemd unit-name-safe suffix (base36 of a u32 — no dots/slashes/spaces).
    expect(a).toMatch(/^[a-z0-9-]+$/);
  });
});
