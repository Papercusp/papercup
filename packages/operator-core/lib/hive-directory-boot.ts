/**
 * hive-directory-boot.ts — the substrate boot-join that makes the hive directory
 * FUNCTION live (p2p-hive-directory-2026-06-06 P-003).
 *
 * Composes the pieces shipped in P-001..P-005 into the live feed: on substrate
 * boot it joins the global directory topic, pipes inbound announces to the
 * directory service's verified-only ingest, wires the swarm broadcast as the
 * directory's transport, registers + announces this peer's owned public/invite
 * hives, and starts the re-announce timer. Returns a stop handle.
 *
 * Called once per workspace boot from boot-all.ts (additive, best-effort — a
 * directory failure must NEVER break harness boot). The `dir` is injectable so
 * the composition unit-tests with a fake-deps directory + a fake swarm; in
 * production it defaults to the process singleton (hive-directory-deps.ts).
 *
 * SCOPE (v1): wires the GLOBAL directory topic (public hives — the default +
 * primary path). Invite-scoped topics need their own per-secret swarm join; the
 * transport logs + skips an invite announce rather than silently dropping it
 * (follow-up: join an invite topic per owned invite hive).
 */

import { deriveDirectoryTopic, deriveInviteTopic, hiveTopicAsHex } from './sync/hyperbee/derive-hive-topic';
import { joinDirectorySwarm, type DirectorySwarmHandle } from './sync/hyperbee/directory-swarm';
import type { HyperswarmLike } from './sync/hyperbee/swarm';
import { getHiveDirectory, setHiveDirectoryTransport } from './hive-directory-deps';
import { publishHiveToDirectory, type HiveDirectoryMeta, type HiveOwnerIdentity } from './hive-publish';
import type { HiveDirectory } from './hive-directory';

/** Default re-announce cadence (5 min) — keeps a hive fresh under the TTL. */
export const DEFAULT_REANNOUNCE_MS = 5 * 60 * 1000;

export interface WireHiveDirectoryOpts {
  /** The shared process swarm (getSharedSwarm()); a fake in tests. */
  swarm: HyperswarmLike;
  /** Device keychain id — signs our hive announces (signWithDeviceKey). */
  keychainId: string;
  /** This peer's GitHub + device identity (owner of the hives we announce). */
  owner: HiveOwnerIdentity;
  /** The hives this workspace owns + wants to publish (public/invite/private). */
  ownedHives?: HiveDirectoryMeta[];
  /** Re-announce cadence (ms). Default DEFAULT_REANNOUNCE_MS. */
  reannounceMs?: number;
  /** The directory service (default: the process singleton). Injected for tests. */
  dir?: HiveDirectory;
}

export interface HiveDirectoryWiring {
  handle: DirectorySwarmHandle;
  stop(): Promise<void>;
}

export async function wireHiveDirectoryAtBoot(opts: WireHiveDirectoryOpts): Promise<HiveDirectoryWiring> {
  const dir = opts.dir ?? getHiveDirectory();
  const globalTopic = deriveDirectoryTopic();
  const globalTopicHex = hiveTopicAsHex(globalTopic);

  // 1. Join the global directory topic; inbound frames → verified-only ingest;
  //    a freshly-paired peer is sent our owned announces.
  const handle = await joinDirectorySwarm({
    swarm: opts.swarm,
    topic: globalTopic,
    onAnnounce: (frame) => dir.ingestAnnounce(frame),
    getOwnAnnounces: () => dir.buildOwnedAnnounces(),
  });

  // 2. Wire the swarm broadcast as the directory's transport. Global → broadcast;
  //    invite topics aren't joined yet → log + skip (never silently drop).
  setHiveDirectoryTransport(async (topicHex, frame) => {
    if (topicHex === globalTopicHex) {
      handle.broadcast(frame);
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[hive-directory] invite-topic transport not wired yet (topic ${topicHex.slice(0, 8)}…); ` +
          `announce for hive ${frame.hive_id} was not broadcast`,
      );
    }
  }, opts.keychainId);

  // 3. Register + announce owned hives (transport is set, so public hives go out).
  for (const hive of opts.ownedHives ?? []) {
    try {
      await publishHiveToDirectory(dir, hive, opts.owner);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[hive-directory] failed to publish hive ${hive.hiveId}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 4. Re-announce on a timer so our hives stay fresh under peers' TTLs.
  const stopTimer = dir.startReannounce(opts.reannounceMs ?? DEFAULT_REANNOUNCE_MS);

  return {
    handle,
    async stop() {
      stopTimer();
      dir.stopReannounce();
      await handle.close();
    },
  };
}

// ── Process-global boot entry (called from boot-all, best-effort) ──────────────

let _wiring: HiveDirectoryWiring | null = null;

/**
 * Boot the hive directory for a workspace (idempotent across the process). The
 * FIRST call joins the global topic + sets the transport + starts re-announce
 * (using this device's identity); a later call for another workspace just
 * publishes THAT workspace's owned hives onto the already-joined directory (the
 * directory is per-DEVICE — D-016 — so the topic join is shared).
 *
 * Fully best-effort: a gh-unauthenticated box (no announce identity) or any
 * failure SKIPS the directory and returns null — it must NEVER break harness
 * boot. Called from boot-all.bootAllHarnessesForActiveWorkspace.
 */
export async function wireHiveDirectoryForWorkspace(
  workspaceId: string,
  opts: { swarm?: HyperswarmLike; reannounceMs?: number } = {},
): Promise<HiveDirectoryWiring | null> {
  try {
    const { resolveLocalAnnounceIdentity } = await import('./sync/hyperbee/local-announce-identity');
    const { listOwnedHiveMeta } = await import('./hive-directory-meta');
    // The hive announce carries no log_core_key; resolveLocalAnnounceIdentity
    // only needs logCoreKeyHex non-empty (for a peer-announce body we don't use).
    const id = await resolveLocalAnnounceIdentity({ logCoreKeyHex: '0'.repeat(64) });
    const owner: HiveOwnerIdentity = {
      githubLogin: id.githubLogin,
      githubUserId: id.githubUserId,
      devicePubkey: id.devicePubkeyBase64,
      attestationGistId: id.attestationGistId,
    };
    const ownedHives = await listOwnedHiveMeta(workspaceId);

    if (!_wiring) {
      const { getSharedSwarm } = await import('./sync/hyperbee/swarm');
      const swarm = opts.swarm ?? (await getSharedSwarm());
      _wiring = await wireHiveDirectoryAtBoot({
        swarm,
        keychainId: id.keychainId,
        owner,
        ownedHives,
        reannounceMs: opts.reannounceMs,
      });
    } else {
      // Already joined — just publish this workspace's owned hives.
      const dir = getHiveDirectory();
      for (const hive of ownedHives) {
        try {
          await publishHiveToDirectory(dir, hive, owner);
        } catch {
          /* best-effort per hive */
        }
      }
    }
    return _wiring;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[hive-directory] boot-join skipped for workspace ${workspaceId}: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}

/** Test seam: drop the process wiring so the next call re-joins. */
export function __resetHiveDirectoryWiring(): void {
  _wiring = null;
}
