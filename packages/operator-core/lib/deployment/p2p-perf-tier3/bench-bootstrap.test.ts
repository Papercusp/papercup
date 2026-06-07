/**
 * Unit tests for the Tier-3 bench bootstrap + remote peer command (P-010).
 * Pure-function contracts — no frame, no SSH.
 */

import { describe, it, expect } from 'vitest';
import { buildBenchBootstrap, benchRuntimeDir, remotePeerChildPath } from './bench-bootstrap';
import { buildRemotePeerCommand } from './remote-peer';
import type { PeerChildConfig } from '../../sync/hyperbee/perf/peer-child';

describe('buildBenchBootstrap', () => {
  it('emits the minimal bench steps — NO harness machinery', () => {
    const { script, steps } = buildBenchBootstrap({ runtimeTarballRemotePath: '/tmp/rt.tgz' });
    expect(steps).toEqual(['preflight', 'node', 'timesync', 'runtime']);
    // The harness bootstrap's heavy/wrong-for-a-bench sections must NOT appear.
    expect(script).not.toContain('meridian');
    expect(script).not.toContain('embedded-pg');
    expect(script).not.toContain('dev:operator');
    expect(script).not.toContain('claude');
    // Native-build deps for sodium/rocksdb/udx are present.
    expect(script).toContain('build-essential');
    // NTP is forced (cross-machine wall-ms latency needs disciplined clocks).
    expect(script).toContain('set-ntp true');
    // Tarball delivery + dep resolution, no build step (tsx runs TS directly).
    expect(script).toContain("tar xzf '/tmp/rt.tgz'");
    expect(script).toContain('npm ci');
    expect(script).not.toContain('npm run build');
  });

  it('arms the NAT-like firewall only when asked', () => {
    const off = buildBenchBootstrap({ runtimeTarballRemotePath: '/tmp/rt.tgz' });
    expect(off.steps).not.toContain('firewall');
    expect(off.script).not.toContain('nftables');

    const on = buildBenchBootstrap({ runtimeTarballRemotePath: '/tmp/rt.tgz', firewall: true });
    expect(on.steps).toContain('firewall');
    // Stateful drop + the two allowances that keep control/holepunch viable.
    expect(on.script).toContain('policy drop');
    expect(on.script).toContain('ct state established,related accept');
    expect(on.script).toContain('tcp dport 22 accept');
  });

  it('respects a custom install root in script + path helpers', () => {
    const { script } = buildBenchBootstrap({
      runtimeTarballRemotePath: '/tmp/rt.tgz',
      installRoot: '/srv/bench/',
    });
    expect(script).toContain("'/srv/bench/runtime'");
    expect(benchRuntimeDir('/srv/bench/')).toBe('/srv/bench/runtime');
    expect(remotePeerChildPath('/srv/bench/')).toBe(
      '/srv/bench/runtime/packages/operator-core/lib/sync/hyperbee/perf/peer-child.ts',
    );
  });
});

describe('buildRemotePeerCommand', () => {
  const cfg: PeerChildConfig = {
    role: 'writer',
    workspaceId: 'ws',
    harnessSlug: 'p2p-perf-x',
    root: '',
    peerIndex: 0,
    rate: 10,
    count: 100,
    // A local-testnet bootstrap must be DROPPED — frames ride the public DHT.
    bootstrap: [{ host: '127.0.0.1', port: 49737 }],
  };

  it('drops the testnet bootstrap (public DHT) and assigns a remote root', () => {
    const { remoteCommand, childCfg } = buildRemotePeerCommand(cfg, { label: 'NYC' });
    expect(childCfg.bootstrap).toBeUndefined();
    expect(childCfg.root).toBe('/tmp/p2p-perf-NYC-0-writer');
    expect(remoteCommand).toContain("mkdir -p '/tmp/p2p-perf-NYC-0-writer'");
    expect(remoteCommand).toContain("cd '/opt/papercusp/runtime'");
    expect(remoteCommand).toContain('exec node --import tsx');
    // The embedded config JSON must not leak the testnet bootstrap either.
    expect(remoteCommand).not.toContain('49737');
  });

  it('shell-quotes the embedded JSON config (single quotes survive)', () => {
    const { remoteCommand } = buildRemotePeerCommand(
      { ...cfg, harnessSlug: "weird'slug" },
      { label: 'NYC' },
    );
    // The shq escape for a single quote inside a single-quoted string.
    expect(remoteCommand).toContain(`'\\''`);
  });
});
