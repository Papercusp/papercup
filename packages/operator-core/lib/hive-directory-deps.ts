/**
 * hive-directory-deps.ts — the production WIRING of the HiveDirectory service
 * (p2p-hive-directory-2026-06-06 P-003/P-005).
 *
 * Mirrors change-feed-deps.ts: the core `hive-directory.ts` stays pure over
 * injected seams; this module binds those seams to the real subsystems and owns
 * the process singleton the operator endpoint (`discovery:hives`, P-005) reads:
 *
 *   - `sign`             → `signWithDeviceKey(keychainId, …)` (the device key
 *                          that signs our own hive announces). Throws until the
 *                          boot wiring supplies the keychain id.
 *   - `verifyAttestation`→ `attest.verifyAttestation(...).valid` (channel-2 — the
 *                          spam floor: only GitHub-attested announces render).
 *   - `broadcast`        → the swarm transport set by the boot wiring
 *                          (`setHiveDirectoryTransport`). A no-op until wired, so
 *                          the endpoint serves a read-only list before the
 *                          substrate join exists.
 *   - cache              → omitted for now (in-memory only). The PG offline cache
 *                          (a `hive_directory_cache` state table) lands with its
 *                          migration; until then the discovered set is rebuilt
 *                          from the live topic on each boot.
 *
 * Boot integration (the live join, deferred to the substrate boot path): on
 * substrate boot, call `setHiveDirectoryTransport(send, keychainId)`, join
 * `deriveDirectoryTopic()` (+ any invite topics for owned invite hives), pipe
 * inbound frames to `getHiveDirectory().ingestAnnounce`, `registerLocalHive` the
 * workspace's public/invite hives, and `startReannounce(...)`.
 */

import { verifyAttestation } from './identity/attest';
import { signWithDeviceKey } from './identity/sign-with-device-key';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { HiveDirectory, type DiscoveredHive, type HiveDirectoryDeps, type SignedHiveAnnounce } from './hive-directory';

let _singleton: HiveDirectory | null = null;
let _transport: ((topicHex: string, frame: SignedHiveAnnounce) => Promise<void>) | null = null;
let _keychainId: string | null = null;

/**
 * Wire the live swarm transport + device keychain id (called by the substrate
 * boot path). Until this runs, `broadcast` is a no-op and `sign` throws — the
 * endpoint still serves the (empty) discovered list without crashing.
 */
export function setHiveDirectoryTransport(
  broadcast: (topicHex: string, frame: SignedHiveAnnounce) => Promise<void>,
  keychainId: string,
): void {
  _transport = broadcast;
  _keychainId = keychainId;
}

function productionDeps(): HiveDirectoryDeps {
  return {
    sign: async (bytes) => {
      if (!_keychainId) {
        throw new Error('hive-directory: device keychain not wired (call setHiveDirectoryTransport at boot)');
      }
      return signWithDeviceKey(_keychainId, bytes);
    },
    verifyAttestation: async ({ attestationGistId, devicePubkey, githubUserId }) => {
      const res = await verifyAttestation(attestationGistId, devicePubkey, githubUserId);
      return res.valid;
    },
    broadcast: async (topicHex, frame) => {
      if (_transport) await _transport(topicHex, frame);
    },
    // PG offline cache (migration 182, hive_directory_cache state table). Reads/
    // writes via getOrgPg (admin, RLS-bypass) like the rest of operator-state.
    // Best-effort — a cache failure must never break ingest/listing.
    loadCache: async () => {
      const row = await readOperatorState<{ hives: DiscoveredHive[] }>('hive_directory_cache').catch(
        () => null,
      );
      return row?.hives ?? [];
    },
    saveCache: async (hives) => {
      await writeOperatorState('hive_directory_cache', { hives }).catch(() => {});
    },
    // P-004 (hardening): fresh members/links on every announce build. Lazy
    // import keeps this module light; the enricher is best-effort internally.
    enrichDescriptor: async (desc) =>
      (await import('./hive-descriptor-enrich')).enrichLocalHiveDescriptor(desc),
    // P-005 (hardening): withdrawal tombstones persist beside the offline
    // cache so a reboot can't resurrect a withdrawn hive from it.
    loadTombstones: async () => {
      const row = await readOperatorState<{ tombstones: Record<string, number> }>(
        'hive_directory_tombstones',
      ).catch(() => null);
      return row?.tombstones ?? {};
    },
    saveTombstones: async (tombstones) => {
      await writeOperatorState('hive_directory_tombstones', { tombstones }).catch(() => {});
    },
    // P-014 item 2: capture beacon history for the tier-4 dossier. Lazy-import
    // keeps this module from pulling in PG at startup; the capture itself is
    // already best-effort (the directory wraps it in a catch).
    onBeaconAccepted: async (hiveId, hivePubkey, beacon) => {
      const { captureBeaconSnapshot } = await import('./network-board/beacon-history-pg');
      await captureBeaconSnapshot(hiveId, hivePubkey, beacon);
    },
  };
}

/** The process singleton the operator endpoint reads + the boot path feeds. */
export function getHiveDirectory(): HiveDirectory {
  if (!_singleton) _singleton = new HiveDirectory(productionDeps());
  return _singleton;
}

/** Test seam: install a directory built over fake deps + clear the transport. */
export function configureHiveDirectoryForTest(deps: HiveDirectoryDeps): HiveDirectory {
  _singleton = new HiveDirectory(deps);
  _transport = null;
  _keychainId = null;
  return _singleton;
}

/** Test seam: drop the singleton so the next getHiveDirectory rebuilds it. */
export function __resetHiveDirectorySingleton(): void {
  _singleton = null;
  _transport = null;
  _keychainId = null;
}
