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
  type PresenceAnnounceLoopHandle,
  type PresenceIdentity,
  type PresenceState,
} from './presence-announce';
import { resolveLocalAnnounceIdentity } from './local-announce-identity';
import { machineFingerprint } from '../../identity/device-keychain-id';
import { hiveHomeSlugForHarness } from '../../hive-federation';

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
    opts.resolveIdentity ??
    (async (): Promise<PresenceIdentity | null> => {
      try {
        const id = await resolveLocalAnnounceIdentity({ logCoreKeyHex: handle.ownLog.keyHex });
        return {
          githubUserId: id.githubUserId,
          devicePubkey: id.devicePubkeyBase64,
          machineLabel: machineFingerprint(),
        };
      } catch {
        return null; // gh unauthenticated → the loop ticks but never announces (no-op)
      }
    });

  const getState =
    opts.getState ??
    ((): PresenceState => ({ intent: null, currentView: null, harnessSlug: handle.harnessSlug }));

  const loop = startPresenceAnnounceLoop({
    resolveIdentity,
    getState,
    append: (op) => handle.append(op),
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
  return loop;
}
