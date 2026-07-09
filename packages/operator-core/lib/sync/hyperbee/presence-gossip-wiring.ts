/**
 * presence-gossip-wiring — bind presence-gossip to the live system
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-004, D-008).
 *
 * ONE gossip instance per process (the chassis rule: Hyperswarm dedupes
 * connections per peer, so per-topic instances are wrong — see topic-gossip.ts).
 * Per shared hive, boot registers its federation TOPIC here with the bindings
 * the inbound pipeline needs:
 *
 *   - isMemberDevice(topicHex) — attested device pubkeys of the topic's hive
 *     (`hive_members` union) MINUS the revoked union (loadRevokedHivePubkeys
 *     semantics), TTL-cached ~30s (a presence beat must not hit PG per frame).
 *     FAIL-CLOSED: an unregistered topic or a membership-read error drops the
 *     frame (the pipeline treats a gate error as not-member).
 *   - applyPut/applyDel — the shared_presence projection's writeToPg /
 *     deleteFromPg for the frame row's OWN harness slug (same LWW/fed_ts guards
 *     as the log path: one writer shape, two transports). fed_ts = frame.ts.
 *   - hello — the late-joiner snapshot: each registered topic's provider
 *     re-signs this machine's CURRENT presence at pair time (so the freshness
 *     window holds), replacing the log-replay catch-up.
 *
 * READER-FIRST CUTOVER (the PRESENCE_GOSSIP flag's safety argument): this
 * reader wiring is UNCONDITIONAL — with no gossip writers it idles at zero
 * cost — while the WRITER (wire-presence.ts announce loop → broadcast) is
 * flag-gated. Every peer therefore carries the reader as soon as it updates,
 * and the owner flips writers only after that.
 *
 * Best-effort everywhere: wiring/broadcast failures degrade to today's
 * behavior (log-path presence when the flag is off; a missed beat when on).
 */

import type { SharedPresenceRow } from './projections/presence';
import { buildPresenceProjection } from './projections/presence';
import {
  createPresenceGossip,
  buildPresencePutFrame,
  buildPresenceDelFrame,
  buildSessionsFrame,
  type PresenceGossipHandle,
  type PresenceDelKey,
  type SessionPresenceEntry,
} from './presence-gossip';
import { getSharedSwarm } from './swarm';
import { applySessionPresenceSet } from './session-presence-store';
import { listHiveMembers, loadRevokedHivePubkeys } from '../../hive-membership-store';

/** Membership-set cache TTL — a beat must not hit PG per frame. */
const MEMBER_CACHE_TTL_MS = Number(process.env.PAPERCUSP_PRESENCE_MEMBER_CACHE_MS) || 30_000;

/** The writer half a caller registers when the PRESENCE_GOSSIP flag is on:
 *  this machine's current row + its device signer (the caller owns the
 *  identity — wire-presence resolves it off the booted handle's own log). */
export interface PresenceGossipWriter {
  getOwnRow: () => Promise<SharedPresenceRow | null>;
  /** Sign frame bytes with THIS device's key. */
  sign: (bytes: Buffer) => Promise<Buffer>;
  /** This device's raw-32 base64 pubkey (frame identity for del frames). */
  devicePubkey: string;
  /** Identity legs for SESSIONS frames (P-005). */
  githubUserId: number;
  machineLabel: string;
  potSlug: string | null;
}

interface TopicBinding {
  workspaceId: string;
  /** The hive HOME slug whose hive_members gate this topic. */
  potHomeSlug: string;
  /** Writer half (flag-gated by the caller; null = reader-only registration). */
  writer: PresenceGossipWriter | null;
  /** Cached admitted-device → attested-github_user_id map (audit D-013 root fix:
   *  the binding, not a bare Set, so the pipeline can validate sender-declared
   *  identity fields against the signer's attestation). */
  members?: { at: number; admitted: Map<string, number> };
}

interface WiringState {
  gossip: PresenceGossipHandle;
  bindings: Map<string, TopicBinding>; // topicHex → binding
}

let state: WiringState | null = null;
let creating: Promise<WiringState> | null = null;

/** Injectable seams (tests swap the swarm/PG/identity reads). */
export interface PresenceGossipWiringDeps {
  listHiveMembers: typeof listHiveMembers;
  loadRevokedHivePubkeys: typeof loadRevokedHivePubkeys;
  /** The swarm the gossip rides (default: the shared process swarm). */
  getSwarm: () => Promise<import('./swarm').HyperswarmLike>;
  /** PG client for the apply bindings (default: getOrgPg().sql at call time). */
  sql?: import('postgres').Sql;
}
let deps: PresenceGossipWiringDeps = {
  listHiveMembers,
  loadRevokedHivePubkeys,
  getSwarm: () => getSharedSwarm(),
};

async function admittedDeviceMap(binding: TopicBinding): Promise<Map<string, number>> {
  const now = Date.now();
  if (binding.members && now - binding.members.at < MEMBER_CACHE_TTL_MS) {
    return binding.members.admitted;
  }
  const [members, revoked] = await Promise.all([
    deps.listHiveMembers(binding.workspaceId, binding.potHomeSlug),
    deps.loadRevokedHivePubkeys(binding.workspaceId, binding.potHomeSlug),
  ]);
  const revokedSet = new Set(revoked);
  // Root fix (audit D-013): keep the device_pubkey → attested github_user_id
  // binding (not a bare Set), so the pipeline can validate every sender-declared
  // identity field against the signer's attestation (H1/H3).
  const admitted = new Map<string, number>();
  for (const m of members) {
    for (const a of m.deviceAttestations ?? []) {
      if (a?.device_pubkey && !revokedSet.has(a.device_pubkey)) {
        admitted.set(a.device_pubkey, m.githubUserId);
      }
    }
  }
  binding.members = { at: now, admitted };
  return admitted;
}

async function ensureState(): Promise<WiringState> {
  if (state) return state;
  if (creating) return creating;
  creating = (async () => {
    const swarm = await deps.getSwarm();
    const bindings = new Map<string, TopicBinding>();
    const gossip = createPresenceGossip({
      swarm,
      // Riding already-joined substrate topics: the substrate's own discovery
      // drives connections; no extra DHT refresh loop from this instance.
      refreshMs: 0,
      resolveMemberIdentity: async (devicePubkey, topicHex) => {
        const binding = bindings.get(topicHex);
        if (!binding) return null; // unregistered topic → fail closed
        const admitted = await admittedDeviceMap(binding);
        return admitted.get(devicePubkey) ?? null; // non-member ⇒ null ⇒ dropped
      },
      applyPut: async (row, frameTs, topicHex) => {
        const binding = bindings.get(topicHex);
        if (!binding) return; // unregistered topic → nothing to apply under
        const proj = buildPresenceProjection({
          workspaceId: binding.workspaceId,
          harnessSlug: row.harness_slug,
          ...(deps.sql ? { sql: deps.sql } : {}),
        });
        // L9 (audit D-013): PIN the stored hive scope to the RECEIVER's registered
        // binding — never the sender-declared row.hive_slug. This is exactly the
        // pin the sessions path already applies (applySessions → potSlug:
        // binding.potHomeSlug); the put path was trusting the sender, so an
        // admitted member could plant a presence row under a FOREIGN hive scope —
        // and the per-hive lock authority scopes by this column
        // (lockAuthorityForHive's `WHERE hive_slug=?`, mig 187), so a spoofed
        // hive_slug could inject a phantom authority candidate into another hive.
        // harness_slug stays the sender-declared within-hive demux (D-006) — the
        // sessions path likewise keeps per-session harness_slug sender-declared.
        await proj.writeToPg(
          { ...row, hive_slug: binding.potHomeSlug },
          { authorPubkey: row.device_pubkey, origin: 'remote', ts: frameTs },
        );
      },
      applyDel: async (del, frameTs, topicHex) => {
        const binding = bindings.get(topicHex);
        if (!binding) return;
        const proj = buildPresenceProjection({
          workspaceId: binding.workspaceId,
          harnessSlug: del.harness_slug,
          ...(deps.sql ? { sql: deps.sql } : {}),
        });
        // H2 (audit D-013): scope the delete to the SIGNER's own row via the
        // deleteFromPg author-provenance seam (D-012 author-scoped tombstone):
        // del.device_pubkey is the verified signer (pinned in verifyPresenceFrame),
        // so passing it as the provenance authorPubkey makes the delete match only
        // rows this device owns — a member can never evict a peer's presence row.
        await proj.deleteFromPg(
          `${del.github_user_id}/${del.machine_label}`,
          frameTs,
          undefined,
          { authorPubkey: del.device_pubkey, origin: 'remote' },
        );
      },
      applySessions: async (input, frameTs, topicHex) => {
        const binding = bindings.get(topicHex);
        if (!binding) return;
        await applySessionPresenceSet(
          {
            workspaceId: binding.workspaceId,
            devicePubkey: input.devicePubkey,
            githubUserId: input.githubUserId,
            machineLabel: input.machineLabel,
            // Pin the stored hive scope to the RECEIVER's registered binding —
            // never the sender-declared hive_slug (an admitted member could
            // otherwise plant rows under a foreign hive scope).
            potSlug: binding.potHomeSlug,
            sessions: input.sessions,
            frameTs,
          },
          deps.sql,
        );
      },
      getHelloFrames: async (topicHex) => {
        const binding = bindings.get(topicHex);
        const writer = binding?.writer;
        if (!writer) return [];
        try {
          const row = await writer.getOwnRow();
          if (!row) return [];
          // Re-sign at pair time so the freshness window holds.
          return [await buildPresencePutFrame(row, Date.now(), writer.sign)];
        } catch {
          return [];
        }
      },
    });
    state = { gossip, bindings };
    creating = null;
    return state;
  })();
  return creating;
}

/**
 * Register a shared hive's federation topic with the presence-gossip READER
 * (unconditional at boot — reader-first cutover) and join its gossip channel.
 * Idempotent per topic; a later call can attach/replace the writer half.
 * Best-effort: returns false on any failure (boot never blocks on presence).
 */
export async function registerPresenceGossipTopic(input: {
  topicHex: string;
  workspaceId: string;
  potHomeSlug: string;
  /** Writer half — flag-gated by the caller; omit for reader-only. */
  writer?: PresenceGossipWriter;
}): Promise<boolean> {
  try {
    const s = await ensureState();
    const existing = s.bindings.get(input.topicHex);
    if (existing) {
      if (input.writer) existing.writer = input.writer;
      return true;
    }
    s.bindings.set(input.topicHex, {
      workspaceId: input.workspaceId,
      potHomeSlug: input.potHomeSlug,
      writer: input.writer ?? null,
    });
    s.gossip.joinTopic(Buffer.from(input.topicHex, 'hex'));
    return true;
  } catch (e) {
     
    console.warn(
      `[presence-gossip] topic registration failed for ${input.topicHex.slice(0, 12)}… (presence stays log-path):`,
      e instanceof Error ? e.message : String(e),
    );
    return false;
  }
}

/**
 * Broadcast THIS machine's presence row as a signed gossip frame (the writer
 * path — callers gate on FLAGS.PRESENCE_GOSSIP; the topic's registered writer
 * signs). Returns false when the gossip/writer is unavailable (caller treats
 * it as a skipped beat — the TTL absorbs it).
 */
export async function broadcastPresencePut(topicHex: string, row: SharedPresenceRow): Promise<boolean> {
  try {
    const s = await ensureState();
    const writer = s.bindings.get(topicHex)?.writer;
    if (!writer) return false;
    const frame = await buildPresencePutFrame(row, Date.now(), writer.sign);
    s.gossip.broadcast(topicHex, frame);
    return true;
  } catch {
    return false;
  }
}

/**
 * Broadcast THIS machine's full current session set (P-005 — the session-grain
 * roster beat). Receivers replace the device's previous set. Returns false when
 * the gossip/writer is unavailable (a skipped beat; the TTL absorbs it).
 */
export async function broadcastSessions(
  topicHex: string,
  sessions: SessionPresenceEntry[],
): Promise<boolean> {
  try {
    const s = await ensureState();
    const writer = s.bindings.get(topicHex)?.writer;
    if (!writer) return false;
    const frame = await buildSessionsFrame(
      {
        devicePubkey: writer.devicePubkey,
        githubUserId: writer.githubUserId,
        machineLabel: writer.machineLabel,
        potSlug: writer.potSlug,
      },
      sessions,
      Date.now(),
      writer.sign,
    );
    s.gossip.broadcast(topicHex, frame);
    return true;
  } catch {
    return false;
  }
}

/** Broadcast this machine's presence LEAVE tombstone (pot:leave semantics —
 *  peers drop the row at once; the TTL is the backstop). */
export async function broadcastPresenceDel(
  topicHex: string,
  del: Omit<PresenceDelKey, 'device_pubkey'>,
): Promise<boolean> {
  try {
    const s = await ensureState();
    const writer = s.bindings.get(topicHex)?.writer;
    if (!writer) return false;
    const frame = await buildPresenceDelFrame(writer.devicePubkey, del, Date.now(), writer.sign);
    s.gossip.broadcast(topicHex, frame);
    return true;
  } catch {
    return false;
  }
}

/** Test seams. */
export function __setPresenceGossipWiringDeps(d: Partial<PresenceGossipWiringDeps>): void {
  deps = { ...deps, ...d };
}
export async function __resetPresenceGossipWiring(): Promise<void> {
  const s = state;
  state = null;
  creating = null;
  deps = { listHiveMembers, loadRevokedHivePubkeys, getSwarm: () => getSharedSwarm() };
  if (s) await s.gossip.close().catch(() => {});
}
