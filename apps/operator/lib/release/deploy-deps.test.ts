/**
 * deploy-deps.ts — parseDeployOwnerPid (EI-18674647773291145 Defect 1).
 *
 * The inverse of the `release-deploy:${process.pid}:${randomUUID()}` embedding
 * `DEPLOY_OWNER` does at module load: given a lock holder's owner string, pull
 * the pid back out so a blocked deploy acquire can check whether that holder
 * is still alive on this host before honoring a coalesce for the resource's
 * full 20-minute TTL. Must be conservative — any shape it doesn't recognize
 * returns null (a no-op for the reclaim path), never a wrong-but-plausible pid.
 */
import { describe, it, expect } from 'vitest';
import { parseDeployOwnerPid, systemdRestartCommand, systemdRestartCommands } from './deploy-deps';

describe('parseDeployOwnerPid', () => {
  it('extracts the pid from a well-formed release-deploy owner string', () => {
    expect(parseDeployOwnerPid('release-deploy:727220:c081d56a-f626-4014-8019-0dbececeeea6')).toBe(727220);
  });

  it('extracts the pid regardless of the uuid suffix shape', () => {
    expect(parseDeployOwnerPid('release-deploy:1:x')).toBe(1);
  });

  it('returns null for a differently-labelled resource holder', () => {
    expect(parseDeployOwnerPid('dev-server:12345:uuid')).toBeNull();
  });

  it('returns null for a legacy/malformed owner with no embedded pid', () => {
    expect(parseDeployOwnerPid('release-deploy')).toBeNull();
  });

  it('returns null for a non-numeric or non-finite "pid"', () => {
    expect(parseDeployOwnerPid('release-deploy:abc:uuid')).toBeNull();
    expect(parseDeployOwnerPid('release-deploy:NaN:uuid')).toBeNull();
  });

  it('returns null for pid 0 or negative (never a plausible real pid)', () => {
    expect(parseDeployOwnerPid('release-deploy:0:uuid')).toBeNull();
    expect(parseDeployOwnerPid('release-deploy:-5:uuid')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseDeployOwnerPid('')).toBeNull();
  });
});

describe('systemd restart command planning', () => {
  it('expands a unit name to the user-systemd restart command', () => {
    expect(systemdRestartCommand('papercup-bg-host.service')).toEqual({
      unit: 'papercup-bg-host.service',
      bin: 'systemctl',
      args: ['--user', 'restart', 'papercup-bg-host.service'],
    });
  });

  it('preserves an explicitly supplied command shape for wrappers and tests', () => {
    expect(systemdRestartCommand('systemctl --user restart papercup-bg-host-test.service')).toEqual({
      unit: 'systemctl --user restart papercup-bg-host-test.service',
      bin: 'systemctl',
      args: ['--user', 'restart', 'papercup-bg-host-test.service'],
    });
  });

  it('orders operator then background and skips an explicit empty background unit', () => {
    expect(
      systemdRestartCommands({
        systemdUnit: 'papercup-dev-api.service',
        backgroundSystemdUnit: '',
      }),
    ).toEqual([
      {
        unit: 'papercup-dev-api.service',
        bin: 'systemctl',
        args: ['--user', 'restart', 'papercup-dev-api.service'],
      },
    ]);

    expect(
      systemdRestartCommands({
        systemdUnit: 'papercup-dev-api.service',
        backgroundSystemdUnit: 'papercup-bg-host.service',
      }).map(({ unit }) => unit),
    ).toEqual(['papercup-dev-api.service', 'papercup-bg-host.service']);
  });
});
