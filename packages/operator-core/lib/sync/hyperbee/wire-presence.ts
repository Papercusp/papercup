/**
 * wire-presence — start THIS machine's presence-announce loop for a booted
 * harness (shared-hive-federation-2026-06-08 P-008 presence PUBLISHER). Mirrors
 * wire-outbox.ts: a thin per-harness wiring called from boot-all.ts AFTER
 * bootHarnessSubstrate returns the handle.
 *
 * Presence federates via the ANNOUNCE LOOP (not a capture trigger — presence is
 * ephemeral / high-frequency, and D-007's state-change-with-TTL cadence prevents a
 * firehose). Each tick appends a presence op to the own peer-log when the cadence
 * fires; peers project it into shared_presence, so a Hive's Swarms see each other —
 * which is exactly what the per-Hive lock authority (lockAuthorityForHive, P-009)
 * elects over (the lowest live device_pubkey across the Hive roster).
 *
 * GATED: only a SHARED harness (swarmBinding present + a joined swarm) announces —
 * a private/local harness has no peers. Best-effort: a wiring/tick failure never
 * blocks boot (mirrors wire-outbox). The harness's home Hive slug is resolved ONCE
 * (hiveHomeSlugForHarness) and stamped on every announce so the federated row
 * carries hive_slug for the authority's `WHERE hive_slug` (mig 187).
 */
import type { LocalWriteOp } from './boot';
import {
  startPresenceAnnounceLoop,
  buildPresenceTombstoneOp,
  buildPresenceAnnounceRow,
  type PresenceAnnounceLoopHandle,
  type PresenceIdentity,
  type PresenceState,
} from './presence-announce';
import { resolveLocalAnnounceIdentity } from './local-announce-identity';
import { signWithDeviceKey } from '../../identity/sign-with-device-key';
import { machineFingerprint } from '../../identity/device-keychain-id';
import { hiveHomeSlugForHarness } from '../../hive-federation';
import type { SharedPresenceRow } from './projections/presence';
import {
  registerPresenceGossipTopic,
  broadcastPresencePut,
  broadcastPresenceDel,
  type PresenceGossipWriter,
} from './presence-gossip-wiring';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

/** The booted-handle surface wire-presence needs — a structural subset of
 *  BootedHarnessHandle, so a test can pass a minimal mock. */
export interface PresenceWireHandle {
  workspaceId: string;
  harnessSlug: string;
  ownLog: { keyHex: string };
  append: (op: LocalWriteOp) => Promise<void>;
  /** Null when this boot didn't join a swarm (private harness). */
  swarm: unknown | null;
  registerCloseHook: (hook: () => void | Promise<void>) => () => void;
}

export interface WirePresenceOpts {
  /** Tick interval ms. Default 5000; <= 0 disables (the loop never starts). */
  intervalMs?: number;
  // ── test / wiring seams ──
  resolveIdentity?: () => Promise<PresenceIdentity | null>;
  resolveHiveSlug?: (workspaceId: string, harnessSlug: string) => Promise<string | null>;
  getState?: () => PresenceState;
  setIntervalFn?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (h: ReturnType<typeof setInterval>) => void;
  now?: () => number;
  onError?: (err: unknown) => void;
}

const DEFAULT_PRESENCE_INTERVAL_MS = 5_000;

/**
 * Wire + start the presence-announce loop for `handle`. Returns the loop handle
 * (its `stop` is also registered as a close-hook so teardown is automatic), or
 * null when not started (private harness / no swarm / disabled).
 */
export async function wirePresenceAnnounceForHarness(
  handle: PresenceWireHandle,
  opts: WirePresenceOpts = {},
): Promise<PresenceAnnounceLoopHandle | null> {
  // Only a harness that JOINED a swarm has peers to announce to (handle.swarm is
  // non-null exactly when a shared harness's swarm-join succeeded). A private /
  // local-only / gh-unauthenticated harness has no swarm → nothing to announce.
  if (!handle.swarm) return null;
  const intervalMs = opts.intervalMs ?? DEFAULT_PRESENCE_INTERVAL_MS;
  if (intervalMs <= 0) return null;

  // Resolve the harness's home Hive ONCE (stable for the boot session). Best-effort:
  // a failure → announce harness-scoped (hive_slug null), never blocks the loop.
  const resolveHive = opts.resolveHiveSlug ?? hiveHomeSlugForHarness;
  let hiveSlug: string | null = null;
  try {
    hiveSlug = await resolveHive(handle.workspaceId, handle.harnessSlug);
  } catch {
    hiveSlug = null;
  }

  const resolveIdentity =
    opts.resolveIdentity ?? (() => defaultResolvePresenceIdentity(handle));

  const getState =
    opts.getState ??
    ((): PresenceState => ({ intent: null, currentView: null, harnessSlug: handle.harnessSlug }));

  // ── P-004 (cross-machine-coord-parity D-002/D-008): presence off the log. ──
  // READER-FIRST: register this hive topic with the gossip reader UNCONDITIONALLY
  // (idles at zero cost with no gossip writers) so every updated peer can read
  // gossip presence before any writer flips. The WRITER cutover is flag-gated
  // (PRESENCE_GOSSIP, dark until the 2-machine verify): when ON, announce beats
  // BROADCAST signed frames instead of appending immortal ops to the peer-log.
  // Flag is read once at wire time (a cutover flag — flip applies on reboot).
  const topicHex = (handle.swarm as { topicHex?: unknown } | null)?.topicHex;
  const gossipTopicHex = typeof topicHex === 'string' && topicHex ? topicHex : null;
  let gossipWriterOn = false;
  if (gossipTopicHex && hiveSlug) {
    gossipWriterOn = await getFlag(FLAGS.PRESENCE_GOSSIP, 'system').catch(() => false);
    let writer: PresenceGossipWriter | undefined;
    if (gossipWriterOn) {
      writer = await buildGossipWriter(handle, getState, hiveSlug, opts);
      if (!writer) gossipWriterOn = false; // gh-unauthed → stay on the log path gate (no-op anyway)
    }
    await registerPresenceGossipTopic({
      topicHex: gossipTopicHex,
      workspaceId: handle.workspaceId,
      hiveHomeSlug: hiveSlug,
      ...(writer ? { writer } : {}),
    });
  }

  const loop = startPresenceAnnounceLoop({
    resolveIdentity,
    getState,
    // Writer cutover: gossip beats when ON (a put op's row broadcasts as a signed
    // frame; a skipped/failed broadcast is a missed beat the TTL absorbs) — the
    // log path stays byte-identical when OFF.
    append:
      gossipWriterOn && gossipTopicHex
        ? async (op) => {
            const row = (op as { value?: SharedPresenceRow }).value;
            if (op.type === 'put' && row) {
              await broadcastPresencePut(gossipTopicHex, row);
              return;
            }
            await handle.append(op); // non-put presence ops keep the log path
          }
        : (op) => handle.append(op),
    hiveSlug,
    intervalMs,
    now: opts.now,
    setIntervalFn: opts.setIntervalFn,
    clearIntervalFn: opts.clearIntervalFn,
    onError:
      opts.onError ??
      ((err) =>
        console.warn(
          `[wire-presence] announce tick error for ${handle.workspaceId}::${handle.harnessSlug}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )),
  });
  handle.registerCloseHook(() => loop.stop());

  // ── P-005: the SESSION-GRAIN announcer (gossip-only). Every tick reads this
  // machine's LOCAL live-session roster and broadcasts it as one signed
  // 'sessions' frame (full-set semantics — receivers replace our previous set).
  // A change-hash short-circuits identical sets so a quiet machine costs one
  // frame per SESSION_ANNOUNCE_REFRESH_MS keep-alive, not one per tick.
  // Gossip-writer-gated: no flag, no frames (log-path behavior byte-identical).
  if (gossipWriterOn && gossipTopicHex) {
    const setIv = opts.setIntervalFn ?? setInterval;
    const clearIv = opts.clearIntervalFn ?? clearInterval;
    let lastHash = '';
    let lastSentMs = 0;
    const tickSessions = async (): Promise<void> => {
      try {
        // Dynamic import (the EI-279 layering idiom): the local roster lives in
        // agent-tools/coordination; sync/hyperbee must not import it statically.
        const { listPresence } = await import('../../agent-tools/coordination/presence');
        const records = await listPresence({ workspaceId: handle.workspaceId });
        const nowMs = (opts.now ?? Date.now)();
        const sessions = (records ?? [])
          .filter((r) => typeof r?.ownerId === 'string' && r.ownerId.length > 0)
          .slice(0, 128)
          .map((r) => ({
            owner_id: r.ownerId,
            kind: r.ownerId.startsWith('su-') ? 'su' : r.ownerId.startsWith('s-') ? 'bee' : 'agent',
            intent: r.intent ?? null,
            plan_slug: (r as { currentPlanSlug?: string | null }).currentPlanSlug ?? null,
            harness_slug: handle.harnessSlug,
            last_active_ms: nowMs,
          }));
        const hash = JSON.stringify(sessions.map((s) => [s.owner_id, s.intent, s.plan_slug]));
        if (hash === lastHash && nowMs - lastSentMs < SESSION_ANNOUNCE_REFRESH_MS) return;
        const { broadcastSessions } = await import('./presence-gossip-wiring');
        if (await broadcastSessions(gossipTopicHex, sessions)) {
          lastHash = hash;
          lastSentMs = nowMs;
        }
      } catch (err) {
        opts.onError?.(err);
      }
    };
    const sessTimer = setIv(() => void tickSessions(), SESSION_ANNOUNCE_TICK_MS);
    handle.registerCloseHook(() => clearIv(sessTimer));
  }

  return loop;
}

/** Session-announcer cadence: tick (change-detect) + keep-alive refresh. The
 *  refresh must stay well under the roster's staleness window so a live remote
 *  session never ages out while its machine is up. */
const SESSION_ANNOUNCE_TICK_MS = Number(process.env.PAPERCUSP_SESSION_ANNOUNCE_TICK_MS) || 10_000;
const SESSION_ANNOUNCE_REFRESH_MS =
  Number(process.env.PAPERCUSP_SESSION_ANNOUNCE_REFRESH_MS) || 30_000;

/** Build the gossip WRITER half for this booted handle (P-004): the device
 *  signer + this machine's current-row provider (the hello snapshot + each
 *  broadcast beat). Undefined when gh is unauthenticated — then there is
 *  nothing to announce on either plane. */
async function buildGossipWriter(
  handle: PresenceWireHandle,
  getState: () => PresenceState,
  hiveSlug: string,
  opts: WirePresenceOpts,
): Promise<PresenceGossipWriter | undefined> {
  try {
    const id = await resolveLocalAnnounceIdentity({ logCoreKeyHex: handle.ownLog.keyHex });
    const now = opts.now ?? Date.now;
    const machineLabel = machineFingerprint();
    return {
      devicePubkey: id.devicePubkeyBase64,
      sign: (bytes) => signWithDeviceKey(id.keychainId, bytes),
      githubUserId: id.githubUserId,
      machineLabel,
      hiveSlug,
      getOwnRow: async () =>
        buildPresenceAnnounceRow(
          {
            githubUserId: id.githubUserId,
            devicePubkey: id.devicePubkeyBase64,
            machineLabel,
          },
          getState(),
          now(),
          hiveSlug,
        ),
    };
  } catch {
    return undefined; // gh unauthed → no writer (no-op on either plane)
  }
}

/** The default presence-identity resolver for a booted handle: this machine's
 *  github user + device pubkey + machine fingerprint, or null when gh is
 *  unauthenticated (then we never announce/tombstone — no-op). Shared by the
 *  announce loop and the leave tombstone. */
async function defaultResolvePresenceIdentity(
  handle: Pick<PresenceWireHandle, 'ownLog'>,
): Promise<PresenceIdentity | null> {
  try {
    const id = await resolveLocalAnnounceIdentity({ logCoreKeyHex: handle.ownLog.keyHex });
    return {
      githubUserId: id.githubUserId,
      devicePubkey: id.devicePubkeyBase64,
      machineLabel: machineFingerprint(),
    };
  } catch {
    return null; // gh unauthenticated → nothing to announce/retract
  }
}

export interface PublishPresenceTombstoneOpts {
  /** Resolve this machine's swarm identity (test seam; default the shared resolver). */
  resolveIdentity?: () => Promise<PresenceIdentity | null>;
  now?: () => number;
}

/**
 * Publish a presence TOMBSTONE (a `del` on this device's presence key) to a
 * booted harness's own log so peers drop the leaver's `shared_presence` row at
 * once rather than aging it out by TTL (shared-hive-hardening EI-469). The
 * caller (hive:leave) MUST invoke this BEFORE closing the harness handle — the
 * swarm must still be live for the del op to replicate.
 *
 * Best-effort + gated, mirroring the announce wiring: a private/local harness
 * (no swarm) or a gh-unauthenticated box (no identity) is a no-op (returns
 * false). Returns true when the tombstone was appended.
 *
 * ⚠ Cross-machine delivery is NOT guaranteed here: appending then immediately
 * closing the swarm can out-race live replication, so a peer that hasn't
 * replicated the block falls back to the TTL (today's behavior — safe). A
 * flush/await-replication-before-close is the real-hardware-gated refinement
 * (plan D-003) — the deterministic single-box piece (the publisher + the
 * before-close ordering) is what this builds.
 */
export async function publishPresenceTombstoneForHarness(
  handle: PresenceWireHandle,
  opts: PublishPresenceTombstoneOpts = {},
): Promise<boolean> {
  if (!handle.swarm) return false; // private/local → no peers to tell
  const resolveIdentity = opts.resolveIdentity ?? (() => defaultResolvePresenceIdentity(handle));
  let identity: PresenceIdentity | null;
  try {
    identity = await resolveIdentity();
  } catch {
    identity = null;
  }
  if (!identity) return false; // gh unauthed → nothing to retract
  const now = (opts.now ?? Date.now)();
  await handle.append(buildPresenceTombstoneOp(identity, now));
  // P-004: DUAL-publish the tombstone on the gossip plane when the writer flag
  // is on — a one-shot leave event (not a beat), so dual-write is cheap and
  // keeps log-readers AND gossip-readers dropping the row promptly during the
  // cutover window. Best-effort: a miss falls back to the TTL (safe).
  try {
    const topicHex = (handle.swarm as { topicHex?: unknown } | null)?.topicHex;
    if (typeof topicHex === 'string' && topicHex) {
      const on = await getFlag(FLAGS.PRESENCE_GOSSIP, 'system').catch(() => false);
      if (on) {
        await broadcastPresenceDel(topicHex, {
          github_user_id: identity.githubUserId,
          machine_label: identity.machineLabel,
          harness_slug: handle.harnessSlug,
        });
      }
    }
  } catch {
    /* best-effort — the log tombstone above already published */
  }
  return true;
}
