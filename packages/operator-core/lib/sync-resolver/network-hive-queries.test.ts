// The three per-hive Network queries (hive-network-surface-2026-06-11 P-014 —
// the D-007 follow-on endpoints): network.hive.beacons (tier-4 dossier beacon
// history), network.hive.asks (the full C-1 ask log), network.hive.wakes (the
// hive-scoped staged-wake board, GAP 1). Verifies registration, flat-row
// projection, and arg threading — compositions mocked at their module
// boundaries so no PG/fleet IO runs (mirrors network-board.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownQueryNamesV2 } from './index';

describe('network.hive.* resolvers', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.resetModules());

  it('registers all three per-hive queries in the v2 registry', () => {
    const names = knownQueryNamesV2();
    expect(names).toContain('network.hive.beacons');
    expect(names).toContain('network.hive.asks');
    expect(names).toContain('network.hive.wakes');
  });

  it('network.hive.beacons projects listBeaconHistory flat and threads hiveKey + limit', async () => {
    const rows = [{ id: 'b1', potId: 'hid', hivePubkey: 'pk', beacon: { v: 1 }, capturedAt: 't' }];
    const listBeaconHistory = vi.fn(async () => rows);
    vi.doMock('../network-board/beacon-history-pg', () => ({ listBeaconHistory }));
    const { resolveNamedQueryV2: r } = await import('./index');

    const out = await r('network.hive.beacons', { hiveKey: 'pk', limit: 7 });
    expect(out).toEqual(rows); // flat, not wrapped
    expect(listBeaconHistory).toHaveBeenCalledWith('pk', 7);
    vi.doUnmock('../network-board/beacon-history-pg');
  });

  it('network.hive.asks lists via the home-slug ledger, threading peerPubkey + limit', async () => {
    const rows = [{ id: 'a1', state: 'answered' }];
    const list = vi.fn(async () => rows);
    const ctor = vi.fn(function (this: unknown) {
      return { list };
    });
    vi.doMock('../cross-hive-asks-pg', () => ({ PgCrossHiveAsks: ctor }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-1' }));
    vi.doMock('../hive/wake', () => ({ resolveHiveHomeSlug: () => 'home-hive' }));
    const { resolveNamedQueryV2: r } = await import('./index');

    const out = await r('network.hive.asks', { peerPubkey: 'pk-9', limit: 25 });
    expect(out).toEqual(rows);
    expect(ctor).toHaveBeenCalledWith('ws-1', 'home-hive');
    expect(list).toHaveBeenCalledWith({ peerPubkey: 'pk-9', limit: 25 });
    vi.doUnmock('../cross-hive-asks-pg');
    vi.doUnmock('../workspace-registry');
    vi.doUnmock('../hive/wake');
  });

  it('network.hive.asks returns [] when no home hive is resolvable (no ledger to read)', async () => {
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-1' }));
    vi.doMock('../hive/wake', () => ({ resolveHiveHomeSlug: () => null }));
    const { resolveNamedQueryV2: r } = await import('./index');

    expect(await r('network.hive.asks', {})).toEqual([]);
    vi.doUnmock('../workspace-registry');
    vi.doUnmock('../hive/wake');
  });

  it('network.hive.wakes projects listHiveWakes flat and threads hive + workspace', async () => {
    const rows = [{ id: 1, ownerId: 'su-a' }];
    const listHiveWakes = vi.fn(async () => rows);
    vi.doMock('../network-board/hive-wakes', () => ({ listHiveWakes }));
    const { resolveNamedQueryV2: r } = await import('./index');

    const out = await r('network.hive.wakes', { hive: 'hive-x', workspace: 'ws-7' });
    expect(out).toEqual(rows);
    expect(listHiveWakes).toHaveBeenCalledWith('hive-x', { workspaceId: 'ws-7' });
    vi.doUnmock('../network-board/hive-wakes');
  });

  it('network.fleet.wakes is registered + projects listAllPendingWakes flat (EI-597 Step B)', async () => {
    expect(knownQueryNamesV2()).toContain('network.fleet.wakes');
    const rows = [
      { id: 1, ownerId: 'su-a' },
      { id: 2, ownerId: 'su-b' },
    ];
    const listAllPendingWakes = vi.fn(async () => rows);
    vi.doMock('../agent-tools/coordination/pending-wakes', () => ({ listAllPendingWakes }));
    const { resolveNamedQueryV2: r } = await import('./index');

    // The fleet-wide board is the full unfiltered queue (the pui narrows it
    // client-side); no per-scope arg, workspace is ambient (activeWorkspaceId).
    const out = await r('network.fleet.wakes', {});
    expect(out).toEqual(rows); // flat, not wrapped
    expect(listAllPendingWakes).toHaveBeenCalledTimes(1);
    vi.doUnmock('../agent-tools/coordination/pending-wakes');
  });
});
