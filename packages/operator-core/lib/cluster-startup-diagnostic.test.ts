import { describe, expect, it, vi } from 'vitest';
import { CLUSTER_BOOT_FAILURE_MESSAGE_TYPE, type ClusterBootFailureEvidence } from './cluster-fork';
import { describeClusterStartupFailures } from './cluster-startup-diagnostic';

const failure: ClusterBootFailureEvidence = {
  type: CLUSTER_BOOT_FAILURE_MESSAGE_TYPE,
  schemaVersion: 1,
  code: 'EADDRINUSE',
  address: '0.0.0.0',
  port: 3070,
  workerId: 3,
};

describe('describeClusterStartupFailures', () => {
  it('names the port, pid, and command for a visible EADDRINUSE listener', async () => {
    const readPort = vi.fn(async () => ({
      sockets: [{ port: 3070, pid: 4321, pids: [4321, 4322], command: 'node', ownerVisible: true }],
    }));

    await expect(describeClusterStartupFailures([failure], readPort)).resolves.toEqual([
      'port 3070 already in use by pid 4321 (node), pid 4322 (node)',
    ]);
    expect(readPort).toHaveBeenCalledWith({ port: 3070, limit: 16 });
  });

  it('does not claim a hidden listener is free or name an unreadable pid', async () => {
    const readPort = vi.fn(async () => ({
      sockets: [{ port: 3070, pid: null, pids: [], command: null, ownerVisible: false }],
    }));

    await expect(describeClusterStartupFailures([failure], readPort)).resolves.toEqual([
      'port 3070 is already in use, but its listener owner is not visible to this user',
    ]);
  });

  it('retains the worker error if the listener disappeared before the owner lookup', async () => {
    const readPort = vi.fn(async () => ({ sockets: [] }));

    await expect(describeClusterStartupFailures([failure], readPort)).resolves.toEqual([
      'EADDRINUSE was reported on port 3070, but no listener remained when the supervisor checked',
    ]);
  });

  it('skips the port table when no worker reported EADDRINUSE', async () => {
    const readPort = vi.fn();

    await expect(describeClusterStartupFailures([], readPort)).resolves.toEqual([]);
    expect(readPort).not.toHaveBeenCalled();
  });
});
