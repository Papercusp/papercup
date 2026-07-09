/**
 * hive-256-scale.test.ts — P-009 (harden-shared-hive-to-256-peers): synthetic
 * DATA-PLANE soak at the 256-peer ceiling.
 *
 * A real 256-Swarm mesh is INFEASIBLE in-process (the cross-peer rig stalls at
 * ~5 swarms per worker; same-host hyperswarm holepunch never completes — the
 * genuine cross-machine 256 soak is owner-gated paid infra). So this validates,
 * over SEEDED data (no real swarms — safe on a loaded box), the two sharpest
 * sub-256 walls this plan hardened, at M = 256:
 *
 *   • P-001 epoch-key gap-gate — a membership apply where all 256 members
 *     already hold the current epoch key does ZERO crypto. Without the gate this
 *     is O(E·M) sealed-box ops PER apply (here 50 × 256 = 12,800) and O(E·M²)
 *     across an onboarding wave — the owner-box wedge that bit in the hundreds.
 *   • P-006 authority election — argmin(device_pubkey) over 256 presence rows is
 *     correct and the loose staleness pre-filter never changes the winner.
 *
 * The real cross-machine 256-Swarm mesh soak (merge throughput + connection mesh
 * over the wire) remains a separate owner-gated infra run.
 */
import { describe, it, expect, vi } from 'vitest';
import { reconcileEpochKeysForCurrentMembers } from '../hive-epoch-boundary-wiring';
import { lockAuthorityForHive, DEFAULT_AUTHORITY_STALE_MS } from '../../../authority/lock-authority';

const M = 256;
const pk = (i: number) => `dev-${String(i).padStart(4, '0')}`;
const member = (devicePubkeys: string[], revoked: string[] = []) =>
  ({
    deviceAttestations: devicePubkeys.map((device_pubkey) => ({ device_pubkey })),
    revokedPubkeys: revoked,
  }) as never;

describe('P-009 — 256-peer scale (synthetic data-plane soak)', () => {
  it('P-001 @256: all 256 members already hold the current key ⇒ ZERO crypto (no O(E·M²) owner wedge)', async () => {
    const members = Array.from({ length: M }, (_, i) => member([pk(i)]));
    const haveAll = Array.from({ length: M }, (_, i) => pk(i)); // every device already holds the current key
    const wrap = vi.fn(async () => new Uint8Array([1]));
    const derive = vi.fn(async () => 'K' as never);
    const persist = vi.fn(async () => 1);
    const r = await reconcileEpochKeysForCurrentMembers(
      { workspaceId: 'w', potHomeSlug: 'h', enabled: true },
      {
        loadMembers: async () => members,
        getCurrentEpoch: async () => 50, // E = 50 epochs; un-gated this would wrap 50 × 256 keys
        loadEpochKeyDevices: async () => haveAll,
        resolveCrypto: async () => ({ deriveEpochKey: derive, wrapKeyToMember: wrap }) as never,
        resolveAuthorPubkey: async () => 'owner',
        persistWrappedKeys: persist,
      },
    );
    expect(r).toEqual({ applied: false, reason: 'no-gap' });
    expect(wrap).not.toHaveBeenCalled(); // the whole point: 0, not 12,800
    expect(derive).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('P-001 @256: a single missing device among 256 still grants (a real gap is bounded work, not skipped)', async () => {
    const members = Array.from({ length: M }, (_, i) => member([pk(i)]));
    const haveAllButOne = Array.from({ length: M - 1 }, (_, i) => pk(i)); // pk(0255) is missing
    const wrap = vi.fn(async () => new Uint8Array([1]));
    const r = await reconcileEpochKeysForCurrentMembers(
      { workspaceId: 'w', potHomeSlug: 'h', enabled: true },
      {
        loadMembers: async () => members,
        getCurrentEpoch: async () => 0,
        loadEpochKeyDevices: async () => haveAllButOne,
        resolveCrypto: async () =>
          ({ deriveEpochKey: async () => 'K' as never, wrapKeyToMember: wrap }) as never,
        resolveAuthorPubkey: async () => 'owner',
        persistWrappedKeys: async () => M,
      },
    );
    expect(r.applied).toBe(true);
    expect(wrap).toHaveBeenCalled();
  });

  it('P-006 @256: argmin authority over 256 fresh presence rows is correct + counts all 256', async () => {
    const T = 1_000_000_000_000;
    const rows = Array.from({ length: M }, (_, i) => ({
      device_pubkey: pk(i),
      github_user_id: 1000 + i,
      machine_label: `m${i}`,
      last_seen_ms: T, // all fresh
    }));
    rows.reverse(); // ensure the winner isn't trivially the first row by insertion order
    const a = await lockAuthorityForHive('hive', {
      fetchHivePresenceRows: async () => rows,
      resolveSelf: async () => null, // this box has no swarm identity ⇒ pick the argmin peer
      now: () => T,
      staleMs: DEFAULT_AUTHORITY_STALE_MS,
    });
    expect(a.liveCount).toBe(M);
    const winner = a.isSelf ? null : a.peer?.devicePubkey;
    expect(winner).toBe(pk(0)); // argmin(device_pubkey) over dev-0000..dev-0255
  });

  it('P-006 @256: a long-dead row among 256 fresh ones never hijacks the argmin (loose pre-filter is safe)', async () => {
    const T = 1_000_000_000_000;
    const fresh = Array.from({ length: M }, (_, i) => ({
      device_pubkey: pk(i + 1), // dev-0001..dev-0256, all fresh
      github_user_id: 1000 + i,
      machine_label: `m${i}`,
      last_seen_ms: T,
    }));
    // A long-dead row with the LOWEST pubkey — would hijack argmin if freshness were ignored.
    const dead = { device_pubkey: pk(0), github_user_id: 999, machine_label: 'dead', last_seen_ms: T - 10 * 60_000 };
    const a = await lockAuthorityForHive('hive', {
      fetchHivePresenceRows: async () => [dead, ...fresh],
      resolveSelf: async () => null,
      now: () => T,
      staleMs: DEFAULT_AUTHORITY_STALE_MS,
    });
    const winner = a.isSelf ? null : a.peer?.devicePubkey;
    expect(winner).toBe(pk(1)); // dead dev-0000 excluded by the freshness cut; lowest LIVE wins
  });
});
