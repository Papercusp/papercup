/**
 * presence-announce — the WRITE side of Phase 0.3
 * (distributed-coordination-shared-harness-2026-06-04): publishing THIS machine's
 * presence into the harness swarm so peers see it (the read side,
 * federated-presence.ts, surfaces peers; this makes us a peer).
 *
 * Two pure pieces (the testable core) + a thin append integration (the gated
 * wire):
 *
 *  1. shouldAnnounce — the D-007 cadence rule: federate presence as a
 *     STATE-CHANGE-with-TTL, NOT every heartbeat. A per-heartbeat presence write
 *     would flood the peer-log (the plan's "presence firehose" risk). So announce
 *     only when (a) the declared state changed (intent / current_view / harness),
 *     or (b) the last announce is older than the refresh interval (a keep-alive
 *     before the staleness window expires).
 *  2. buildPresenceAnnounceOp — the op the local Hypercore log carries; its value
 *     is exactly the SharedPresenceRow the presence projection materializes on
 *     every peer (and on us, so we see ourselves).
 *
 * The integration — calling `handle.append(op)` on the booted per-harness
 * substrate handle on a timer — is environment-gated (needs a booted swarm + a gh
 * device identity, neither present on a single gh-unauthenticated dev box). It is
 * a thin wire over these pure pieces: resolve the device identity
 * (resolveUsageActor), build the op, and append it whenever shouldAnnounce is
 * true. {@link announceLocalPresence} packages that with an injected `append` so
 * the decision + op are tested without a live swarm.
 */

import type { SharedPresenceRow } from './projections/presence';
import { CURRENT_SCHEMA_VERSION } from './schema-version';
import type { LocalWriteOp } from './boot';
import { isSessionClosedError } from './own-log-fork-guard';

/** The presence schema version (presence rows carry schema_version). */
const PRESENCE_SCHEMA_VERSION = 1;

/** The mutable presence state a machine declares. */
export interface PresenceState {
  intent: string | null;
  currentView: string | null;
  harnessSlug: string;
}

/** What was last announced (for the state-change decision). */
export interface LastAnnounce {
  state: PresenceState;
  /** epoch ms of the last announce. */
  atMs: number;
}

export interface AnnounceCadenceOpts {
  /** Re-announce (keep-alive) once the last announce is older than this, even
   *  with no state change. Default: 1/3 of the staleness window so a peer never
   *  ages out a still-present machine. */
  refreshMs?: number;
}

const DEFAULT_REFRESH_MS = 30_000;

function stateChanged(a: PresenceState, b: PresenceState): boolean {
  return a.intent !== b.intent || a.currentView !== b.currentView || a.harnessSlug !== b.harnessSlug;
}

/**
 * The D-007 cadence rule: announce iff the state changed OR the last announce is
 * stale (keep-alive). `prev === null` (never announced) → always announce.
 */
export function shouldAnnounce(
  prev: LastAnnounce | null,
  next: PresenceState,
  nowMs: number,
  opts: AnnounceCadenceOpts = {},
): boolean {
  if (!prev) return true;
  if (stateChanged(prev.state, next)) return true;
  const refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
  return nowMs - prev.atMs >= refreshMs;
}

/** This machine's swarm identity for a presence announce. */
export interface PresenceIdentity {
  githubUserId: number;
  machineLabel: string;
  devicePubkey: string;
}

/**
 * Build the SharedPresenceRow value for an announce.
 *
 * `potSlug` (shared-hive-federation P-008/P-009) is the harness's home Hive slug
 * — the publisher resolves it once via potHomeSlugForHarness and threads it here
 * so each federated presence row carries it for the per-Hive lock authority.
 * Defaults null (a non-Hive harness, or a caller that hasn't wired Hive scope yet)
 * — additive + back-compat.
 */
export function buildPresenceAnnounceRow(
  identity: PresenceIdentity,
  state: PresenceState,
  nowMs: number,
  potSlug: string | null = null,
): SharedPresenceRow {
  return {
    harness_slug: state.harnessSlug,
    github_user_id: identity.githubUserId,
    machine_label: identity.machineLabel,
    device_pubkey: identity.devicePubkey,
    intent: state.intent,
    current_view: state.currentView,
    last_seen_at: nowMs,
    schema_version: PRESENCE_SCHEMA_VERSION,
    hive_slug: potSlug,
  };
}

/** Build the local-log op the substrate appends (federates to peers, and the
 *  local projection materializes back so we see ourselves). The Hyperbee key
 *  mirrors the presence projection's composeKey: `<github_user_id>/<machine>`. */
export function buildPresenceAnnounceOp(
  identity: PresenceIdentity,
  state: PresenceState,
  nowMs: number,
  potSlug: string | null = null,
): LocalWriteOp {
  const value = buildPresenceAnnounceRow(identity, state, nowMs, potSlug);
  return {
    type: 'put',
    table: 'presence',
    hbKey: `${identity.githubUserId}/${identity.machineLabel}`,
    value,
    ts: nowMs,
    schema_version: CURRENT_SCHEMA_VERSION,
  };
}

/**
 * Build the presence TOMBSTONE op — a `del` on this device's presence key
 * (shared-hive-hardening-2026-06-13 EI-469). Published when a peer LEAVES a hive
 * (pot:leave) so OTHER peers delete the leaver's `shared_presence` row at once
 * (the projection's ts-guarded deleteFromPg) instead of waiting out the ~90s
 * staleness TTL — which also drops one stale vote from the per-Hive lock-authority
 * election.
 *
 * Deliberately NOT published on graceful shutdown: going offline is TRANSIENT
 * (you'll reappear on next boot, and a quick restart should not blink out of
 * peers' rosters) — the TTL models that correctly. A tombstone means "I LEFT",
 * not "I'm briefly offline". Key mirrors buildPresenceAnnounceOp /
 * the projection composeKey: `<github_user_id>/<machine_label>`.
 */
export function buildPresenceTombstoneOp(
  identity: Pick<PresenceIdentity, 'githubUserId' | 'machineLabel'>,
  nowMs: number,
): LocalWriteOp {
  return {
    type: 'del',
    table: 'presence',
    hbKey: `${identity.githubUserId}/${identity.machineLabel}`,
    ts: nowMs,
    schema_version: CURRENT_SCHEMA_VERSION,
  };
}

export interface AnnounceLocalPresenceDeps {
  /** Append the op to this machine's Hypercore log (the booted substrate handle).
   *  Injected so the decision + op are tested without a live swarm. */
  append: (op: LocalWriteOp) => Promise<void>;
  /** The last announce (for the cadence decision); null = never announced. */
  prev: LastAnnounce | null;
  now?: () => number;
  cadence?: AnnounceCadenceOpts;
  /** The harness's home Hive slug (shared-hive-federation P-008/P-009), stamped on
   *  each announce so the FEDERATED presence row carries it — the per-Hive lock
   *  authority scopes by it (lockAuthorityForHive's `WHERE hive_slug`). Null = a
   *  non-Hive harness. Additive: omitted → null (back-compat). */
  potSlug?: string | null;
}

export interface AnnounceResult {
  announced: boolean;
  /** The new LastAnnounce when announced (feed back as `prev` next tick). */
  last?: LastAnnounce;
}

/**
 * Announce this machine's presence IFF the cadence rule fires. Returns whether it
 * announced + the new LastAnnounce to thread into the next tick. Pure but for the
 * injected `append`.
 */
export async function announceLocalPresence(
  identity: PresenceIdentity,
  state: PresenceState,
  deps: AnnounceLocalPresenceDeps,
): Promise<AnnounceResult> {
  const now = (deps.now ?? Date.now)();
  if (!shouldAnnounce(deps.prev, state, now, deps.cadence)) {
    return { announced: false };
  }
  await deps.append(buildPresenceAnnounceOp(identity, state, now, deps.potSlug ?? null));
  return { announced: true, last: { state: { ...state }, atMs: now } };
}

export interface PresenceAnnounceLoopDeps {
  /** Resolve this machine's swarm identity, or null when gh is unauthenticated
   *  (then the loop ticks but never announces). Called lazily + cached. */
  resolveIdentity: () => Promise<PresenceIdentity | null>;
  /** The current declared presence state at tick time. */
  getState: () => PresenceState;
  /** Append the announce op to the booted substrate handle's own log. */
  append: (op: LocalWriteOp) => Promise<void>;
  /** The harness's home Hive slug (P-008/P-009) — resolved ONCE by the publisher
   *  (potHomeSlugForHarness) and stamped on every announce. Null = non-Hive. */
  potSlug?: string | null;
  /** Tick rate (the decision cadence is shouldAnnounce's; the loop just polls). */
  intervalMs: number;
  cadence?: AnnounceCadenceOpts;
  now?: () => number;
  /** Injected timer (tests use fake timers; default global setInterval). */
  setIntervalFn?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (h: ReturnType<typeof setInterval>) => void;
  /** Surface a tick error (a failed announce must NOT kill the loop). */
  onError?: (err: unknown) => void;
  /**
   * WI-3684 send-side twin (outbox-drain.ts's `onSessionClosed` sibling):
   * fired instead of `onError` when a tick's `append` fails with a Hypercore
   * `SESSION_CLOSED` error — the own-log session is permanently dead, so this
   * loop self-stops (clears its interval) rather than blind-retrying every
   * `intervalMs` forever. The caller (wire-presence.ts → boot-all.ts's
   * `ensureSendSideWired`) uses this to re-wire a fresh loop on the next boot
   * pass, mirroring the receive side's repair-on-detect posture.
   */
  onSessionClosed?: () => void;
}

export interface PresenceAnnounceLoopHandle {
  stop: () => void;
  /** Run one tick now (also the unit of work the interval calls). */
  tickOnce: () => Promise<void>;
}

/**
 * Start the periodic presence-announce loop (Phase 0.3 write-side driver). Each
 * tick resolves the identity (lazily, cached), reads the current state, and calls
 * announceLocalPresence — which only actually appends on a state-change or TTL
 * refresh (D-007, no firehose). Identity-null (gh unauthed) ticks are no-ops. A
 * tick error is reported via onError and swallowed so one failure can't kill the
 * loop. The handle.append integration is the only gated bit — everything else
 * (cadence, identity gating, error resilience, threading prev) is exercised here
 * with injected timer/append.
 */
export function startPresenceAnnounceLoop(deps: PresenceAnnounceLoopDeps): PresenceAnnounceLoopHandle {
  const setIv = deps.setIntervalFn ?? setInterval;
  const clearIv = deps.clearIntervalFn ?? clearInterval;
  let identity: PresenceIdentity | null | undefined;
  let prev: LastAnnounce | null = null;
  let stopped = false;
  // Assigned right after creation, below — `tickOnce`'s SESSION_CLOSED
  // self-stop path needs to clear the SAME interval `stop()` clears.
  let intervalHandle: ReturnType<typeof setInterval> | undefined;

  async function tickOnce(): Promise<void> {
    if (stopped) return;
    try {
      if (identity === undefined) identity = await deps.resolveIdentity();
      if (!identity) return; // no swarm identity → nothing to announce
      const result = await announceLocalPresence(identity, deps.getState(), {
        append: deps.append,
        prev,
        now: deps.now,
        cadence: deps.cadence,
        potSlug: deps.potSlug,
      });
      if (result.last) prev = result.last;
    } catch (err) {
      if (isSessionClosedError(err)) {
        // WI-3684 send-side twin: the own-log session is permanently closed —
        // every future tick's append would throw the same error, so stop
        // ticking (rather than blind-retrying every `intervalMs` forever) and
        // signal the caller to re-wire once a live handle is available again.
        stopped = true;
        if (intervalHandle !== undefined) clearIv(intervalHandle);
        try {
          deps.onSessionClosed?.();
        } catch {
          // best-effort — a throwing callback must never surface from here
        }
        return;
      }
      deps.onError?.(err);
    }
  }

  intervalHandle = setIv(() => void tickOnce(), deps.intervalMs);
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (intervalHandle !== undefined) clearIv(intervalHandle);
    },
    tickOnce,
  };
}
