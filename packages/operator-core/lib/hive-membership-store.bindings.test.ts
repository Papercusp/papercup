/**
 * hive-membership-store.bindings.test.ts — UNIT (no PG) for the owner-device
 * binding loader used by the WI-797/D-053 owner-log BOOTSTRAP-ADMIT.
 *
 * Guards the A→B cross-machine receive-side fix (hive-federation-cross-machine-merge
 * D-007): `loadHiveOwnerDeviceBindings` must read the LIVE in-process hive directory
 * (`getHiveDirectory().listDiscoveredHives`) IN ADDITION TO the PG offline cache, so a
 * from-repo / direct-link joiner whose `hive_directory_cache` ROW never landed (the PG
 * write is workspace-scoped + best-effort + races the boot, and directory ingest rides
 * the separate slow global-directory topic) can still resolve the owner device the moment
 * the owner's fresh announce is HEARD. Reading the PG cache ALONE returned [] → no
 * bootstrap-admit → the joiner applied nothing from the owner (the live A→B failure).
 *
 * Both sources carry the SAME guarantee (only `verifyHiveAnnounce`-passed descriptors),
 * so the merge widens availability without weakening trust. These tests mock BOTH
 * dynamically-imported sources; no testcontainer PG needed.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';

const listDiscoveredHives = vi.fn();
const readOperatorState = vi.fn();

vi.mock('./hive-directory-deps', () => ({
  getHiveDirectory: () => ({ listDiscoveredHives }),
}));
vi.mock('./operator-state-pg', () => ({
  readOperatorState: (...a: unknown[]) => readOperatorState(...a),
}));

import {
  loadHiveOwnerDeviceBindings,
  loadHiveOwnerDevicePubkey,
} from './hive-membership-store';

const WS = 'ws-1';
// A DiscoveredHive is much wider than the binding; only hivePubkey + ownerDevicePubkey
// are read. Cast through unknown so the fixtures stay minimal.
const disco = (hivePubkey: string, ownerDevicePubkey: string): unknown => ({
  hiveId: `hive:${hivePubkey}`,
  title: 't',
  ownerDevicePubkey,
  hivePubkey,
});

afterEach(() => {
  listDiscoveredHives.mockReset();
  readOperatorState.mockReset();
});

describe('loadHiveOwnerDeviceBindings — live directory + PG cache merge (D-007)', () => {
  it('THE A→B FIX: resolves the owner binding from the in-process directory when the PG cache row is absent', async () => {
    listDiscoveredHives.mockReturnValue([disco('HP_owner', 'OD_owner')]);
    readOperatorState.mockResolvedValue(null); // cache row never landed (the live bug)

    const bindings = await loadHiveOwnerDeviceBindings(WS);

    expect(bindings).toEqual([{ hivePubkey: 'HP_owner', ownerDevicePubkey: 'OD_owner' }]);
    // and the by-pubkey lookup the bootstrap-admit calls resolves too
    expect(await loadHiveOwnerDevicePubkey(WS, 'HP_owner')).toBe('OD_owner');
  });

  it('still reads the PG offline cache when the live directory is empty (backward compat)', async () => {
    listDiscoveredHives.mockReturnValue([]);
    readOperatorState.mockResolvedValue({
      hives: [{ hivePubkey: 'HP_cache', ownerDevicePubkey: 'OD_cache' }],
    });

    expect(await loadHiveOwnerDeviceBindings(WS)).toEqual([
      { hivePubkey: 'HP_cache', ownerDevicePubkey: 'OD_cache' },
    ]);
  });

  it('merges both sources and DEDUPES by hivePubkey (live directory wins)', async () => {
    listDiscoveredHives.mockReturnValue([disco('HP_shared', 'OD_live')]);
    readOperatorState.mockResolvedValue({
      hives: [
        { hivePubkey: 'HP_shared', ownerDevicePubkey: 'OD_stale' }, // dup → dropped
        { hivePubkey: 'HP_cacheonly', ownerDevicePubkey: 'OD_cacheonly' },
      ],
    });

    const bindings = await loadHiveOwnerDeviceBindings(WS);

    expect(bindings).toEqual([
      { hivePubkey: 'HP_shared', ownerDevicePubkey: 'OD_live' }, // live wins (added first)
      { hivePubkey: 'HP_cacheonly', ownerDevicePubkey: 'OD_cacheonly' },
    ]);
  });

  it('skips incomplete entries from either source (missing hivePubkey / ownerDevicePubkey)', async () => {
    listDiscoveredHives.mockReturnValue([
      { hiveId: 'x', title: 't', ownerDevicePubkey: 'OD_no_pubkey' }, // no hivePubkey
      disco('HP_ok', 'OD_ok'),
    ]);
    readOperatorState.mockResolvedValue({
      hives: [{ hivePubkey: 'HP_no_owner' }], // no ownerDevicePubkey
    });

    expect(await loadHiveOwnerDeviceBindings(WS)).toEqual([
      { hivePubkey: 'HP_ok', ownerDevicePubkey: 'OD_ok' },
    ]);
  });

  it('fail-closed per source: a throwing directory still returns the PG cache', async () => {
    listDiscoveredHives.mockImplementation(() => {
      throw new Error('directory unwired');
    });
    readOperatorState.mockResolvedValue({
      hives: [{ hivePubkey: 'HP_cache', ownerDevicePubkey: 'OD_cache' }],
    });

    expect(await loadHiveOwnerDeviceBindings(WS)).toEqual([
      { hivePubkey: 'HP_cache', ownerDevicePubkey: 'OD_cache' },
    ]);
  });

  it('returns [] when both sources are empty (no false bootstrap)', async () => {
    listDiscoveredHives.mockReturnValue([]);
    readOperatorState.mockResolvedValue(null);

    expect(await loadHiveOwnerDeviceBindings(WS)).toEqual([]);
    expect(await loadHiveOwnerDevicePubkey(WS, 'HP_missing')).toBeNull();
  });
});

describe('registry-view leg (2026-07-01 Brief-3 live finding: join-time stamped coords)', () => {
  const regRow = (extra: object) => ({
    projects: [
      { slug: 'shop', path: '/m/shop' }, // member — never contributes
      { slug: 'shop-hive', path: '/rh/shop-hive', harness_kind: 'hive', remote_hive: true, ...extra },
    ],
  });

  it('THE DETERMINISTIC LEG: resolves the binding from a remote-hive view entry when BOTH directory legs are empty', async () => {
    listDiscoveredHives.mockReturnValue([]);
    readOperatorState.mockImplementation(async (table: unknown) =>
      table === 'harness_registry'
        ? regRow({ hive_pubkey: 'HP_reg', owner_device_pubkey: 'OD_reg' })
        : null,
    );

    expect(await loadHiveOwnerDeviceBindings(WS)).toEqual([
      { hivePubkey: 'HP_reg', ownerDevicePubkey: 'OD_reg' },
    ]);
    expect(await loadHiveOwnerDevicePubkey(WS, 'HP_reg')).toBe('OD_reg');
  });

  it('a view without the stamped coords contributes nothing (pre-stamp registries)', async () => {
    listDiscoveredHives.mockReturnValue([]);
    readOperatorState.mockImplementation(async (table: unknown) =>
      table === 'harness_registry' ? regRow({}) : null,
    );

    expect(await loadHiveOwnerDeviceBindings(WS)).toEqual([]);
  });

  it('a LOCAL owned hive entry (not remote_hive) never contributes, even with stray coords', async () => {
    listDiscoveredHives.mockReturnValue([]);
    readOperatorState.mockImplementation(async (table: unknown) =>
      table === 'harness_registry'
        ? {
            projects: [
              {
                slug: 'own-hive', path: '/own', harness_kind: 'hive',
                hive_pubkey: 'HP_own', owner_device_pubkey: 'OD_own',
              },
            ],
          }
        : null,
    );

    expect(await loadHiveOwnerDeviceBindings(WS)).toEqual([]);
  });

  it('dedup: the registry leg wins over a later directory descriptor for the same hive', async () => {
    listDiscoveredHives.mockReturnValue([disco('HP_reg', 'OD_directory_stale')]);
    readOperatorState.mockImplementation(async (table: unknown) =>
      table === 'harness_registry'
        ? regRow({ hive_pubkey: 'HP_reg', owner_device_pubkey: 'OD_reg' })
        : null,
    );

    expect(await loadHiveOwnerDeviceBindings(WS)).toEqual([
      { hivePubkey: 'HP_reg', ownerDevicePubkey: 'OD_reg' },
    ]);
  });
});
