import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  GYM_CYCLE_MAX_RUNTIME_SEC,
  GYM_CYCLE_RUNNER_REL,
  buildGymCycleSystemdArgv,
  gymCycleUnitForWorkspace,
  launchDetachedGymCycle,
  type SpawnLike,
} from './gym-cycle-launch';
import { parseGymCycleRunArgs } from './gym-cycle-run';

function fakeSpawn(opts: { code?: number | null; stderr?: string; error?: NodeJS.ErrnoException }): SpawnLike {
  return vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { stderr: PassThrough };
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      if (opts.stderr) child.stderr.write(opts.stderr);
      if (opts.error) child.emit('error', opts.error);
      else child.emit('close', opts.code ?? 0);
    });
    return child as never;
  }) as unknown as SpawnLike;
}

describe('gym-cycle detached launcher', () => {
  it('uses a stable per-workspace unit as the admission-time dedup key', () => {
    expect(gymCycleUnitForWorkspace('ws-a')).toBe(gymCycleUnitForWorkspace('ws-a'));
    expect(gymCycleUnitForWorkspace('ws-a')).not.toBe(gymCycleUnitForWorkspace('ws-b'));
    expect(gymCycleUnitForWorkspace('ws-a')).toMatch(/^papercup-gym-cycle-[0-9a-f]{12}$/);
  });

  it('builds a no-block transient service with the exact operator payload env', () => {
    const argv = buildGymCycleSystemdArgv({
      workspaceId: 'ws-7',
      root: '/repo',
      env: { PATH: '/bin', DATABASE_URL: 'postgres://example/db', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/host-bus' },
    });

    expect(argv).toEqual(expect.arrayContaining([
      '--user',
      '--no-block',
      '--collect',
      `--unit=${gymCycleUnitForWorkspace('ws-7')}`,
      `--property=RuntimeMaxSec=${GYM_CYCLE_MAX_RUNTIME_SEC}`,
      '--working-directory=/repo',
      '/usr/bin/env',
      '-i',
      'DATABASE_URL=postgres://example/db',
      'PAPERCUSP_INTEGRATION_ROOT=/repo',
      '/repo/node_modules/.bin/tsx',
      GYM_CYCLE_RUNNER_REL,
      '--workspace-id',
      'ws-7',
    ]));
    expect(argv).not.toContain('--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/host-bus');
  });

  it('accepts a launch and recognizes a same-unit race without inline ambiguity', async () => {
    await expect(
      launchDetachedGymCycle(
        { workspaceId: 'ws', root: '/repo', env: {}, platform: 'linux' },
        fakeSpawn({ code: 0 }),
      ),
    ).resolves.toMatchObject({ status: 'launched' });

    await expect(
      launchDetachedGymCycle(
        { workspaceId: 'ws', root: '/repo', env: {}, platform: 'linux' },
        fakeSpawn({ code: 1, stderr: 'Failed to start transient service unit: Unit already exists.' }),
      ),
    ).resolves.toMatchObject({ status: 'already_running' });
  });

  it('distinguishes proved-unavailable systemd from an ambiguous refusal', async () => {
    await expect(
      launchDetachedGymCycle(
        { workspaceId: 'ws', root: '/repo', env: {}, platform: 'darwin' },
        fakeSpawn({ code: 0 }),
      ),
    ).resolves.toMatchObject({ status: 'unavailable', argv: [] });

    await expect(
      launchDetachedGymCycle(
        { workspaceId: 'ws', root: '/repo', env: {}, platform: 'linux' },
        fakeSpawn({ error: Object.assign(new Error('spawn systemd-run ENOENT'), { code: 'ENOENT' }) }),
      ),
    ).resolves.toMatchObject({ status: 'unavailable' });

    await expect(
      launchDetachedGymCycle(
        { workspaceId: 'ws', root: '/repo', env: {}, platform: 'linux' },
        fakeSpawn({ code: 1, stderr: 'Failed to connect to bus: No medium found' }),
      ),
    ).resolves.toMatchObject({ status: 'unavailable' });

    await expect(
      launchDetachedGymCycle(
        { workspaceId: 'ws', root: '/repo', env: {}, platform: 'linux' },
        fakeSpawn({ code: 1, stderr: 'transport closed after request submission' }),
      ),
    ).resolves.toMatchObject({ status: 'refused' });
  });
});

describe('gym-cycle CLI argv', () => {
  it('parses both supported workspace-id forms and rejects a missing value', () => {
    expect(parseGymCycleRunArgs(['--workspace-id', 'ws-a'])).toEqual({ workspaceId: 'ws-a' });
    expect(parseGymCycleRunArgs(['--workspace-id=ws-b'])).toEqual({ workspaceId: 'ws-b' });
    expect(() => parseGymCycleRunArgs([])).toThrow(/requires --workspace-id/);
  });
});
