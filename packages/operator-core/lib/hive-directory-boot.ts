/**
 * hive-directory-boot.ts — the substrate boot-join that makes the hive directory
 * FUNCTION live (p2p-hive-directory-2026-06-06 P-003).
 *
 * Composes the pieces shipped in P-001..P-005 into the live feed: on substrate
 * boot it creates ONE directory-gossip instance (createDirectoryGossip — one
 * connection handler, one Protomux channel per topic), joins the global
 * directory topic + each owned invite hive's invite-scoped topic, pipes inbound
 * announces to the directory service's verified-only ingest, wires the gossip
 * broadcast as the directory's transport, registers + announces this peer's
 * owned public/invite hives, and starts the re-announce timer. Returns a stop
 * handle.
 *
 * Called once per workspace boot from boot-all.ts (additive, best-effort — a
 * directory failure must NEVER break harness boot). The `dir` is injectable so
 * the composition unit-tests with a fake-deps directory + a fake swarm; the
 * LIVE proof (real Hyperswarm on a testnet) is
 * sync/hyperbee/__tests__/hive-directory-live-two-peer.test.ts.
 */

import { deriveDirectoryTopic, deriveInviteTopic } from './sync/hyperbee/derive-hive-topic';
import {
  createDirectoryGossip,
  type DirectoryGossipHandle,
} from './sync/hyperbee/directory-swarm';
import type { HyperswarmLike } from './sync/hyperbee/swarm';
import type { SignedHiveAnnounce } from './sync/hyperbee/hive-announce';
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
  /** Per-topic discovery-refresh cadence (ms) — see createDirectoryGossip. */
  refreshMs?: number;
  /** The directory service (default: the process singleton). Injected for tests. */
  dir?: HiveDirectory;
}

export interface HiveDirectoryWiring {
  /** The directory gossip (all topics — global + invite-scoped). */
  gossip: DirectoryGossipHandle;
  /** Join an invite-scoped directory topic from a received invite secret (the
   *  invitee side). Idempotent. */
  joinInviteTopic(inviteSecret: string): Promise<void>;
  /**
   * The topic-routing broadcast — the same closure handed to
   * setHiveDirectoryTransport. Exposed so an injected (non-singleton) directory
   * can route its `broadcast` dep through this wiring (tests, multi-instance).
   */
  transport(topicHex: string, frame: SignedHiveAnnounce): Promise<void>;
  stop(): Promise<void>;
}

export async function wireHiveDirectoryAtBoot(opts: WireHiveDirectoryOpts): Promise<HiveDirectoryWiring> {
  const dir = opts.dir ?? getHiveDirectory();

  // 0. Hydrate the discovered set from the PG offline cache FIRST, so the
  //    browse list answers "what did I last see" before the swarm reconnects
  //    (the cache is a cache, never the transport — live announces LWW over it).
  await dir.hydrateFromCache().catch(() => 0);

  // ONE gossip instance for every directory topic. `getOwnAnnounces` is SCOPED
  // per topic so a global-topic pair only ever receives PUBLIC hives and an
  // invite-topic pair only that invite's hive(s) — an invite hive never leaks
  // onto the global topic.
  const gossip = createDirectoryGossip({
    swarm: opts.swarm,
    onAnnounce: (frame) => dir.ingestAnnounce(frame),
    getOwnAnnounces: (topicHex) => dir.buildOwnedAnnounces({ topicHex }),
    refreshMs: opts.refreshMs,
  });

  // 1. The global directory topic (public hives).
  gossip.joinTopic(deriveDirectoryTopic());

  // 1b. Each owned INVITE hive's invite topic, so its announce has a transport
  //     AND we hear other announces on that invite topic.
  for (const hive of opts.ownedHives ?? []) {
    if (hive.visibility === 'invite' && hive.inviteSecret) {
      try {
        gossip.joinTopic(deriveInviteTopic(hive.inviteSecret));
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[hive-directory] failed to join invite topic for ${hive.hiveId}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // 2. Transport routes a frame to ITS topic's channels. An unknown topic (an
  //    invite hive added after boot) is lazily joined first — the hex is the
  //    32-byte topic, so it round-trips to a Buffer. Never silently dropped.
  const transport = async (topicHex: string, frame: SignedHiveAnnounce): Promise<void> => {
    try {
      gossip.joinTopic(Buffer.from(topicHex, 'hex')); // idempotent
    } catch {
      /* malformed hex / closed — fall through; broadcast is a no-op then */
    }
    gossip.broadcast(topicHex, frame);
  };
  setHiveDirectoryTransport(transport, opts.keychainId);

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
    gossip,
    /** Join an invite-scoped directory topic from a received invite secret (the
     *  invitee side — a "follow invite link" action calls this so the invite
     *  hive's announce is ingested + listed). Idempotent. */
    async joinInviteTopic(inviteSecret: string): Promise<void> {
      gossip.joinTopic(deriveInviteTopic(inviteSecret));
    },
    transport,
    async stop() {
      stopTimer();
      dir.stopReannounce();
      await gossip.close();
    },
  };
}

// ── Process-global boot entry (called from boot-all, best-effort) ──────────────

let _wiring: HiveDirectoryWiring | null = null;
let _lastWireAttemptMs = 0;

/**
 * LAZY wire — for surfaces that need the directory live but may run before (or
 * instead of) the boot-all join: `discovery:set_hive` (announcing needs the
 * transport) and the discovery list reads. The boot join is once-only and
 * skips on a gh-unauthenticated box; without this, a box that authenticates
 * AFTER boot has a dead directory until restart. Returns the existing wiring
 * instantly when already joined; otherwise re-attempts at most once per minute
 * (identity resolution is the expensive/failing part). Best-effort → null.
 */
export async function ensureHiveDirectoryWired(workspaceId: string): Promise<HiveDirectoryWiring | null> {
  if (_wiring) return _wiring;
  const now = Date.now();
  if (now - _lastWireAttemptMs < 60_000) return null;
  _lastWireAttemptMs = now;
  return wireHiveDirectoryForWorkspace(workspaceId);
}

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
    const { deriveHiveMemberRepoRefs } = await import('./hive-member-repos');
    const ownedHives = await Promise.all(
      ownedHivesRaw.map(async (h) => {
        const pk = await loadHivePubkey(workspaceId, h.hiveId).catch(() => null);
        // member_repos: the repo→Hive binding signal (P-003) — derived fresh at
        // publish time like the pubkey, never persisted in the registry meta.
        const memberRepos = await deriveHiveMemberRepoRefs(workspaceId, h.hiveId).catch(
          () => [] as string[],
        );
        return {
          ...h,
          ...(pk ? { hivePubkey: pk } : {}),
          ...(memberRepos.length ? { memberRepos } : {}),
        };
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
  _lastWireAttemptMs = 0;
}
