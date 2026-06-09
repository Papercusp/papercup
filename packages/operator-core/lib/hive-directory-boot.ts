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
  /** The global directory-topic swarm handle. */
  handle: DirectorySwarmHandle;
  /** Join an invite-scoped directory topic from a received invite secret (the
   *  invitee side). Idempotent. */
  joinInviteTopic(inviteSecret: string): Promise<void>;
  stop(): Promise<void>;
}

export async function wireHiveDirectoryAtBoot(opts: WireHiveDirectoryOpts): Promise<HiveDirectoryWiring> {
  const dir = opts.dir ?? getHiveDirectory();
  const globalTopic = deriveDirectoryTopic();

  // One DirectorySwarm handle per joined topic (the global directory topic + one
  // per owned invite hive's invite-secret topic). Keyed by topic hex so the
  // transport can route an announce to exactly its topic.
  const handles = new Map<string, DirectorySwarmHandle>();

  // Join a topic idempotently. `getOwnAnnounces` is SCOPED to this topic so a
  // global-topic peer only ever sees PUBLIC hives and an invite-topic peer only
  // that invite's hive(s) — an invite hive never leaks onto the global topic.
  const joinTopic = async (topic: Buffer): Promise<DirectorySwarmHandle> => {
    const hex = hiveTopicAsHex(topic);
    const existing = handles.get(hex);
    if (existing) return existing;
    const h = await joinDirectorySwarm({
      swarm: opts.swarm,
      topic,
      onAnnounce: (frame) => dir.ingestAnnounce(frame),
      getOwnAnnounces: () => dir.buildOwnedAnnounces({ topicHex: hex }),
    });
    handles.set(hex, h);
    return h;
  };

  // 1. The global directory topic (public hives).
  const handle = await joinTopic(globalTopic);

  // 1b. Each owned INVITE hive's invite topic, so its announce has a transport
  //     AND we hear other announces on that invite topic.
  for (const hive of opts.ownedHives ?? []) {
    if (hive.visibility === 'invite' && hive.inviteSecret) {
      try {
        await joinTopic(deriveInviteTopic(hive.inviteSecret));
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[hive-directory] failed to join invite topic for ${hive.hiveId}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // 2. Transport routes a frame to ITS topic's handle. An unknown topic (an
  //    invite hive added after boot) is lazily joined first — the hex is the
  //    32-byte topic, so it round-trips to a Buffer. Never silently dropped.
  setHiveDirectoryTransport(async (topicHex, frame) => {
    let h = handles.get(topicHex);
    if (!h) {
      try {
        h = await joinTopic(Buffer.from(topicHex, 'hex'));
      } catch {
        /* fall through — h stays undefined */
      }
    }
    if (h) h.broadcast(frame);
  }, opts.keychainId);

  // 3. Register + announce owned hives (transport is set, so public + invite go out).
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
    /** Join an invite-scoped directory topic from a received invite secret (the
     *  invitee side — a "follow invite link" action calls this so the invite
     *  hive's announce is ingested + listed). Idempotent. */
    async joinInviteTopic(inviteSecret: string): Promise<void> {
      await joinTopic(deriveInviteTopic(inviteSecret));
    },
    async stop() {
      stopTimer();
      dir.stopReannounce();
      await Promise.all([...handles.values()].map((h) => h.close().catch(() => {})));
      handles.clear();
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
    const ownedHivesRaw = await listOwnedHiveMeta(workspaceId);
    // Enrich each owned hive with its Ed25519 IDENTITY pubkey (the cross-Hive dial
    // address, P-006) sourced from the keychain/hives table — only the owning Swarm
    // holds it, and publish only runs for owned hives. Not persisted in the registry
    // meta (it lives in hives.public_key); attached fresh at publish time.
    const { loadHivePubkey } = await import('./identity/hive-keypair');
    const ownedHives = await Promise.all(
      ownedHivesRaw.map(async (h) => {
        const pk = await loadHivePubkey(workspaceId, h.hiveId).catch(() => null);
        return pk ? { ...h, hivePubkey: pk } : h;
      }),
    );

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
