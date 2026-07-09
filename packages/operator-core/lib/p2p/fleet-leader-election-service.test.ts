/**
 * fleet-leader-election-service.test.ts — P-302 live-wiring layer (WI-1978).
 * Proves the I/O orchestration around the pure election: reads presence+roster+lease,
 * elects, persists the lease on change, announces on a leader-device change, and is a
 * cheap no-op in steady state. Uses the in-memory lease store + mocked reads.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  FleetLeaderElectionService,
  createInMemoryLeaderLeaseStore,
  toFleetMemberDevice,
  type FleetLeaderElectionDeps,
  type FleetRosterRead,
  type LeadershipAnnouncer,
} from './fleet-leader-election-service';
import type { FleetMemberDevice } from './fleet-leader-election';
import type { ScopeId } from '../sync/hive-git/scope-repo';
import type { LeadershipAnnouncement } from './fleet-leader-election';
import { PgFleetLeaderLeaseStore } from './fleet-leader-lease-store';

const NOW = 1_800_000_000_000;
const OWNER = 42;
const SCOPE: ScopeId = { kind: 'fleet', ownerGithubUserId: OWNER, slug: 'alpha' };

const dev = (pub: string, over?: Partial<FleetMemberDevice>): FleetMemberDevice => ({
  device_pubkey: pub,
  github_user_id: OWNER,
  machine_label: pub,
  last_seen_ms: NOW - 1_000,
  ...over,
});

function makeDeps(over: Partial<FleetLeaderElectionDeps> & { presence?: FleetMemberDevice[]; members?: number[]; epoch?: number } = {}) {
  const announced: { scope: ScopeId; ann: LeadershipAnnouncement }[] = [];
  const roster: FleetRosterRead = {
    members: vi.fn(async () => over.members ?? [OWNER]),
    currentEpoch: vi.fn(async () => over.epoch ?? 1),
  };
  const announce: LeadershipAnnouncer = vi.fn(async (scope, ann) => {
    announced.push({ scope, ann });
  });
  const leaseStore = over.leaseStore ?? createInMemoryLeaderLeaseStore();
  const listPresence = vi.fn(async () => over.presence ?? []);
  const deps: FleetLeaderElectionDeps = {
    listPresence,
    roster,
    leaseStore,
    announce,
    self: over.self ?? null,
    now: over.now ?? (() => NOW),
    staleMs: over.staleMs,
    leaseMs: over.leaseMs,
    excluded: over.excluded,
  };
  return { deps, announced, leaseStore, roster, announce, listPresence };
}

describe('FleetLeaderElectionService.recompute', () => {
  it('first election: elects, writes the lease, announces "elected"', async () => {
    const { deps, announced, leaseStore } = makeDeps({ presence: [dev('a-pub'), dev('b-pub'), dev('c-pub')] });
    const svc = new FleetLeaderElectionService(deps);
    const { decision, announced: ann, leaseWritten } = await svc.recompute(SCOPE);

    expect(decision.leaderDevicePubkey).not.toBeNull();
    expect(leaseWritten).toBe(true);
    expect(ann?.reason).toBe('elected');
    expect(announced).toHaveLength(1);
    const persisted = await leaseStore.read(SCOPE);
    expect(persisted?.devicePubkey).toBe(decision.leaderDevicePubkey);
    expect(persisted?.rosterEpoch).toBe(1);
  });

  it('steady state: same leader + epoch ⇒ no announce, no lease write', async () => {
    const presence = [dev('a-pub'), dev('b-pub'), dev('c-pub')];
    const { deps, leaseStore } = makeDeps({ presence });
    const svc = new FleetLeaderElectionService(deps);
    await svc.recompute(SCOPE); // first election
    const writeSpy = vi.spyOn(leaseStore, 'write');
    const { announced: ann, leaseWritten } = await svc.recompute(SCOPE); // steady state

    expect(ann).toBeNull();
    expect(leaseWritten).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('failover: a dead incumbent yields to a live leader, announces "failover", rewrites the lease', async () => {
    const presence = [dev('a-pub'), dev('b-pub'), dev('c-pub')];
    const leaseStore = createInMemoryLeaderLeaseStore();
    // Seed an incumbent that is NOT in the live presence set (dead).
    await leaseStore.write(SCOPE, { devicePubkey: 'dead-pub', githubUserId: OWNER, sinceMs: NOW - 1_000, rosterEpoch: 1 });
    const { deps, announced } = makeDeps({ presence, leaseStore });
    const svc = new FleetLeaderElectionService(deps);
    const { decision, announced: ann, leaseWritten } = await svc.recompute(SCOPE);

    expect(presence.map((d) => d.device_pubkey)).toContain(decision.leaderDevicePubkey);
    expect(decision.leaderDevicePubkey).not.toBe('dead-pub');
    expect(ann?.reason).toBe('failover');
    expect(leaseWritten).toBe(true);
    expect(announced).toHaveLength(1);
  });

  it('vacate: no live members ⇒ leader null, lease cleared, announces "vacated"', async () => {
    const leaseStore = createInMemoryLeaderLeaseStore();
    await leaseStore.write(SCOPE, { devicePubkey: 'gone-pub', githubUserId: OWNER, sinceMs: NOW - 1_000, rosterEpoch: 1 });
    const { deps, announced } = makeDeps({ presence: [], leaseStore });
    const svc = new FleetLeaderElectionService(deps);
    const { decision, announced: ann } = await svc.recompute(SCOPE);

    expect(decision.leaderDevicePubkey).toBeNull();
    expect(ann?.reason).toBe('vacated');
    expect(await leaseStore.read(SCOPE)).toBeNull(); // cleared
    expect(announced).toHaveLength(1);
  });

  it('epoch advance rewrites the lease epoch even when the same device re-wins', async () => {
    const presence = [dev('solo-pub')];
    const leaseStore = createInMemoryLeaderLeaseStore();
    await leaseStore.write(SCOPE, { devicePubkey: 'solo-pub', githubUserId: OWNER, sinceMs: NOW - 5_000, rosterEpoch: 1 });
    const { deps } = makeDeps({ presence, leaseStore, epoch: 2 });
    const svc = new FleetLeaderElectionService(deps);
    const { decision, leaseWritten } = await svc.recompute(SCOPE);

    expect(decision.leaderDevicePubkey).toBe('solo-pub');
    expect(leaseWritten).toBe(true);
    expect((await leaseStore.read(SCOPE))?.rosterEpoch).toBe(2);
  });

  it('reads every dependency for the scope', async () => {
    const { deps, roster, listPresence } = makeDeps({ presence: [dev('a-pub')] });
    const svc = new FleetLeaderElectionService(deps);
    await svc.recompute(SCOPE);
    expect(listPresence).toHaveBeenCalledWith(SCOPE);
    expect(roster.members).toHaveBeenCalledWith(SCOPE);
    expect(roster.currentEpoch).toHaveBeenCalledWith(SCOPE);
  });
});

describe('createInMemoryLeaderLeaseStore', () => {
  it('round-trips + clears per scope', async () => {
    const store = createInMemoryLeaderLeaseStore();
    expect(await store.read(SCOPE)).toBeNull();
    await store.write(SCOPE, { devicePubkey: 'x', githubUserId: OWNER, sinceMs: NOW, rosterEpoch: 3 });
    expect((await store.read(SCOPE))?.devicePubkey).toBe('x');
    const other: ScopeId = { kind: 'fleet', ownerGithubUserId: OWNER, slug: 'beta' };
    expect(await store.read(other)).toBeNull(); // scoped independently
    await store.write(SCOPE, null);
    expect(await store.read(SCOPE)).toBeNull();
  });
});

function fakeTemplateSql(results: unknown[][] = []) {
  const calls: { text: string; vals: unknown[] }[] = [];
  const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push({ text: strings.join('?'), vals });
    return Promise.resolve(results.shift() ?? []);
  }) as never;
  return { sql, calls };
}

describe('PgFleetLeaderLeaseStore', () => {
  it('reads and maps the persisted lease row for a fleet scope', async () => {
    const { sql, calls } = fakeTemplateSql([
      [{ device_pubkey: 'leader-pub', leader_github_user_id: String(OWNER), since_ms: String(NOW), roster_epoch: '7' }],
    ]);
    const store = new PgFleetLeaderLeaseStore({ workspaceId: 'ws-test', potSlug: 'hive-home', sqlOverride: sql });
    await expect(store.read(SCOPE)).resolves.toEqual({
      devicePubkey: 'leader-pub',
      githubUserId: OWNER,
      sinceMs: NOW,
      rosterEpoch: 7,
    });
    expect(calls[0]!.text).toMatch(/SELECT device_pubkey, leader_github_user_id, since_ms, roster_epoch/);
    expect(calls[0]!.vals).toEqual(expect.arrayContaining(['ws-test', 'hive-home', OWNER, 'alpha']));
  });

  it('upserts and clears a lease row', async () => {
    const { sql, calls } = fakeTemplateSql();
    const store = new PgFleetLeaderLeaseStore({ workspaceId: 'ws-test', potSlug: 'hive-home', sqlOverride: sql });
    await store.write(SCOPE, { devicePubkey: 'leader-pub', githubUserId: OWNER, sinceMs: NOW, rosterEpoch: 2 });
    await store.write(SCOPE, null);

    expect(calls[0]!.text).toMatch(/INSERT INTO harness_shared\.p2p_fleet_leader_leases/);
    expect(calls[0]!.text).toMatch(/ON CONFLICT/);
    expect(calls[0]!.vals).toEqual(expect.arrayContaining(['ws-test', 'hive-home', OWNER, 'alpha', 'leader-pub', 2]));
    expect(calls[1]!.text).toMatch(/DELETE FROM harness_shared\.p2p_fleet_leader_leases/);
    expect(calls[1]!.vals).toEqual(expect.arrayContaining(['ws-test', 'hive-home', OWNER, 'alpha']));
  });

  it('fails visibly when workspace or hive scope is missing', async () => {
    const { sql, calls } = fakeTemplateSql();
    await expect(new PgFleetLeaderLeaseStore({ workspaceId: null, potSlug: 'hive-home', sqlOverride: sql }).read(SCOPE)).rejects.toThrow(/workspaceId required/);
    await expect(new PgFleetLeaderLeaseStore({ workspaceId: 'ws-test', potSlug: '', sqlOverride: sql }).write(SCOPE, null)).rejects.toThrow(/potSlug required/);
    expect(calls.length).toBe(0);
  });
});

describe('toFleetMemberDevice', () => {
  it('maps a shared_presence row to the election shape', () => {
    expect(
      toFleetMemberDevice({ github_user_id: 7, machine_label: 'tower', device_pubkey: 'pk', last_seen_ms: NOW, /* extra cols ignored */ } as never),
    ).toEqual({ device_pubkey: 'pk', github_user_id: 7, machine_label: 'tower', last_seen_ms: NOW });
  });
});
