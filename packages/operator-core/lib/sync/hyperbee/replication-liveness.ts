/**
 * replication-liveness — per-peer replication-liveness registry + stall episodes.
 *
 * Plan: shared-hive-p2p-release-readiness-2026-07-03 P-004 (WI-1840). Closes the
 * WI-183 CLASS: connected-but-dead replication is SILENT — the substrate logs
 * "booted", `peer_connected` fires both ways, and no signal distinguishes a
 * healthy peer from a dead-replication one (the exact live failure of P-059:
 * tower↔VM fed_event replication delivering NOTHING both directions despite
 * healthy network + swarm connects).
 *
 * Relationship to the EXISTING WI-183 detector (`checkReplicationStall` in
 * boot.ts): that detector is peers-count-only and its `replication_stalled`
 * event lands ONLY in the process-local boot-history ring — invisible to the
 * health verdict, to every status surface, and to the durable issue ledger.
 * This module is the SIGNAL + SURFACE + ESCALATION layer on top:
 *
 *   - `sampleReplicationLiveness()` — fed once per admitted REMOTE log per
 *     merge pass (boot.ts `mergeOnePass`, same call site as
 *     `checkReplicationStall`). Tracks peers-count, the writer's known length,
 *     and the MERGE-CURSOR position (how far we've actually ingested).
 *   - `getReplicationLiveness()` — read-time per-log verdicts for status
 *     surfaces (in-process-status → federation-status → health verdict).
 *   - Edge-triggered STALL EPISODES (once per episode, cleared on recovery)
 *     routed to a reporter — production default files a durable EI
 *     (replication-stall-ei.ts), so a stall escalates even if nobody is
 *     watching a status page.
 *
 * Why merge-position (not `contiguousLength`) is the progress signal: a
 * snapshot-seeded joiner NEVER requests blocks before its snapshot index, so
 * `contiguousLength` legitimately stays 0 forever on a healthy sparse replica
 * (see peer-log.ts). The merge cursor's per-log position is seeded from the
 * snapshot index and advances exactly when ops are actually ingested — writer
 * ahead + no position advance for a sustained window IS a genuine freeze,
 * regardless of compaction/sparseness.
 *
 * Verdict ladder (per admitted remote log, derived at READ time):
 *   - 'live'            — replicator attached; caught up OR still ingesting.
 *   - 'never_connected' — never seen a live replicator peer (ordinary churn /
 *                          offline peer; NEVER alarms — mirrors WI-183 gating).
 *   - 'no_replicator'   — WAS replicating, has held 0 replicator peers past the
 *                          grace window (the WI-183 symptom).
 *   - 'frozen'          — replicator attached AND writer is ahead AND merge
 *                          position has not advanced past the grace window
 *                          (attached-but-dead: blocks/ingest not flowing).
 *   - 'sampling_stale'  — the registry itself hasn't been fed for this log
 *                          recently: the merge loop is dead/wedged — the
 *                          detector's own dead-man switch.
 *
 * Pure in-process state: no PG, no timers, no fetch. The registry lives in
 * whichever process runs the substrate merge loop (main process by default;
 * the sidecar when `papercusp-substrate-sidecar` is ON — surfaced there via
 * the additive `getReplicationLiveness` RPC method).
 */

import { recordBootEvent } from './boot-history';

/** One merge-pass observation of an admitted remote log. */
export interface ReplicationLogSample {
  /** 64-char hex hypercore key of the admitted remote log. */
  keyHex: string;
  /** Writer's advertised length as known to our replica (`core.length` after update()). */
  knownLength: number;
  /**
   * Merge-cursor position for this log — the next index the read-merge will
   * ingest (seeded from the snapshot index on a sparse joiner). `undefined`
   * when the caller can't resolve it (defensive; disables frozen-detection
   * for the sample, never alarms).
   */
  mergedPosition?: number;
  /**
   * Live replicator-peer count for THIS core (`RemoteLog.peersCount()`), or
   * `undefined` when the underlying core doesn't expose `.peers` (fakes in
   * tests) — disables no_replicator detection for the sample.
   */
  peersCount?: number;
  /**
   * Live swarm-connection count for the HARNESS TOPIC at sample time
   * (`SwarmHandle.liveConnectionCount`), or `undefined` when the caller has no
   * swarm handle — disables connected_never_replicated detection.
   *
   * This is the WI-183 ROOT-CAUSE axis (rig run m1783114921): after a restart
   * every re-admitted log is `never_connected` this process lifetime, and the
   * original never-alarms gating made the exact failure class SILENT — swarm
   * says peer_connected (zombie connections via a stale DHT announce record)
   * while the core never attaches a replicator. Swarm-connected + core
   * never-replicated held past grace IS the zombie signature; swarm 0 stays
   * the never-alarms churn case (peer genuinely offline).
   */
  swarmConnections?: number;
}

/** An edge-triggered stall episode (fires ONCE per episode, per kind). */
export interface ReplicationStallEpisode {
  workspaceId: string;
  harnessSlug: string;
  logKeyHex: string;
  kind: 'no_replicator' | 'frozen' | 'connected_never_replicated';
  /** How long the stall condition had been held when the episode fired (ms). */
  stalledForMs: number;
  /** Human-readable one-liner for the boot event / EI body. */
  detail: string;
}

export type ReplicationLogVerdict =
  | 'live'
  | 'never_connected'
  | 'no_replicator'
  | 'frozen'
  | 'sampling_stale';

/** Read-time view of one tracked log. */
export interface ReplicationLogLiveness {
  keyHex: string;
  verdict: ReplicationLogVerdict;
  knownLength: number;
  mergedPosition: number | null;
  peersCount: number | null;
  /** ms since the log last showed a live replicator peer; null = never. */
  msSinceReplicatorSeen: number | null;
  /** ms since the merge position last advanced (or since first sample). */
  msSinceIngestProgress: number | null;
  /** ms since this log was last sampled (merge-loop dead-man input). */
  msSinceSampled: number;
  /**
   * The swarmConnections value the LAST sample carried — what the
   * connected_never_replicated axis actually sees. null = the sampler never
   * passed one (axis disabled at the source). Diagnostics: the m1783120511
   * silent-detector incident was only diagnosable by rebuilding with this
   * field — keep it so the next "axis never fired" is one RPC read.
   */
  lastSwarmConnections: number | null;
}

/** Read-time view of one harness's replication liveness. */
export interface HarnessReplicationLiveness {
  workspaceId: string;
  harnessSlug: string;
  logs: ReplicationLogLiveness[];
  /** Rollup counts the health verdict consumes. */
  counts: {
    live: number;
    neverConnected: number;
    noReplicator: number;
    frozen: number;
    samplingStale: number;
  };
}

interface LogState {
  keyHex: string;
  lastSampleMs: number;
  knownLength: number;
  mergedPosition: number | null;
  peersCount: number | null;
  /** Last time peersCount was observed > 0; null = never (never alarms). */
  lastNonZeroPeersMs: number | null;
  /** Last time mergedPosition advanced (seeded at first sample with a position). */
  lastIngestProgressMs: number | null;
  /**
   * Start of the current swarm-connected-while-never-replicated window; null
   * when the condition doesn't hold (sustained-offline, or the log has
   * replicated at least once this lifetime). WI-183 zombie axis.
   */
  connectedNeverReplSinceMs: number | null;
  /**
   * Last sample time with swarmConnections > 0. Zombie connections CHURN
   * (rig run m1783114921: ~10s lifetimes with reconnect gaps), so a swarm=0
   * sample resets the window only after a SUSTAINED offline stretch
   * (SWARM_CHURN_TOLERANCE_MS) — otherwise churn gaps would eternally reset
   * the clock and the detector would stay silent in exactly the zombie case.
   */
  lastSwarmSeenMs: number | null;
  /** Verbatim swarmConnections from the last sample (null = not passed). */
  lastSwarmConnections: number | null;
  alarmedNoReplicator: boolean;
  alarmedFrozen: boolean;
  alarmedConnectedNever: boolean;
}

/** Registry: `${workspaceId}::${harnessSlug}` → keyHex → state. */
const registry = new Map<string, Map<string, LogState>>();

const hKey = (workspaceId: string, harnessSlug: string): string =>
  `${workspaceId}::${harnessSlug}`;

/**
 * Default grace (ms) a stall condition must hold before an episode fires.
 * Mirrors boot.ts's DEFAULT_REPLICATION_STALL_GRACE_MS rationale (3 min
 * comfortably exceeds the two-speed swarm re-peer cadence).
 */
export const DEFAULT_LIVENESS_GRACE_MS = 3 * 60 * 1000;

/**
 * Read-time dead-man threshold: a log not sampled for this long means the
 * merge loop itself is dead/wedged (the sampler rides the ~1s merge poll, so
 * 60s is ~60 missed passes). Not configurable per-sample — it's a property of
 * the READ, and reads pass `nowMs` in tests.
 */
export const SAMPLING_STALE_AFTER_MS = 60 * 1000;

/**
 * How long the swarm may sample 0 connections before the zombie-window clock
 * resets. Zombie connections churn (~10s lifetimes + reconnect gaps on rig run
 * m1783114921); a genuinely-offline peer shows a SUSTAINED zero stretch.
 */
export const SWARM_CHURN_TOLERANCE_MS = 60 * 1000;

export interface SampleReplicationLivenessOpts {
  /** Stall grace window (ms). Default DEFAULT_LIVENESS_GRACE_MS. */
  graceMs?: number;
  /** Test seam — clock override. */
  nowMs?: number;
  /**
   * Episode sink override. Omit for the module default (boot event +
   * durable-EI reporter). Pass explicitly in unit tests.
   */
  onStallEpisode?: (episode: ReplicationStallEpisode) => void;
}

/**
 * Module-level episode reporter seam. Production default: record a boot event
 * (`replication_stalled` / `replication_frozen`) AND file a durable EI via a
 * LAZY dynamic import (never at module load — keeps this module pure for unit
 * tests and avoids dragging PG into every importer). Both legs are
 * fire-and-forget + swallow-all: a reporter hiccup must never wedge the merge
 * pass the sampler rides.
 */
let episodeReporter: ((episode: ReplicationStallEpisode) => void) | null = null;

export function setReplicationStallEpisodeReporterForTests(
  fn: ((episode: ReplicationStallEpisode) => void) | null,
): void {
  episodeReporter = fn;
}

function defaultEpisodeReporter(episode: ReplicationStallEpisode): void {
  // Leg 0 — a LOUD process-log line carrying the grep-able event token. The b8
  // matrix scenario's detector-assert (and any live witness) greps serve.log
  // for `replication_stalled` / `replication_frozen`; the boot-history ring and
  // the EI are both invisible to a log grep, so without this line a firing
  // detector is indistinguishable from a silent one on the rig (the exact gap
  // rig run m1783114921 exposed).
  const eventName =
    episode.kind === 'frozen' ? 'replication_frozen' : 'replication_stalled';
  try {
     
    console.error(
      `[replication-liveness] ${eventName} (${episode.kind}) harness=${episode.harnessSlug} ${episode.detail}`,
    );
  } catch {
    /* diagnostic-only */
  }
  // Leg 1 — boot-history event (in-process timeline; same ring the legacy
  // WI-183 detector writes to). The legacy `checkReplicationStall` already
  // records `replication_stalled` for the no_replicator kind, so to avoid a
  // duplicate ring entry it is skipped here; the NEW `frozen` and
  // `connected_never_replicated` kinds are this module's own (the legacy
  // peers-only detector shares the never-was-replicating blind spot, so it
  // can never duplicate the zombie kind).
  if (episode.kind === 'frozen' || episode.kind === 'connected_never_replicated') {
    try {
      recordBootEvent(
        episode.workspaceId,
        episode.harnessSlug,
        eventName,
        episode.detail,
      );
    } catch {
      /* diagnostic-only */
    }
  }
  // Leg 2 — durable EI (the escalation P-004 requires: visible fleet-wide even
  // if nobody reads this process's status). Lazy import so the pure module
  // never statically links PG.
  void import('./replication-stall-ei')
    .then((m) => m.fileReplicationStallEi(episode))
    .catch(() => {
      /* escalation is best-effort; the registry verdict still surfaces it */
    });
}

function reportEpisode(episode: ReplicationStallEpisode): void {
  try {
    (episodeReporter ?? defaultEpisodeReporter)(episode);
  } catch {
    /* never let a reporter throw back into the merge pass */
  }
}

/**
 * Feed one merge-pass observation of an admitted REMOTE log. Call once per
 * remote log per pass (boot.ts mergeOnePass). Never throws.
 */
export function sampleReplicationLiveness(
  workspaceId: string,
  harnessSlug: string,
  sample: ReplicationLogSample,
  opts: SampleReplicationLivenessOpts = {},
): void {
  const now = opts.nowMs ?? Date.now();
  const graceMs = opts.graceMs ?? DEFAULT_LIVENESS_GRACE_MS;
  const onEpisode = opts.onStallEpisode ?? reportEpisode;

  let logs = registry.get(hKey(workspaceId, harnessSlug));
  if (!logs) {
    logs = new Map();
    registry.set(hKey(workspaceId, harnessSlug), logs);
  }
  let st = logs.get(sample.keyHex);
  if (!st) {
    st = {
      keyHex: sample.keyHex,
      lastSampleMs: now,
      knownLength: sample.knownLength,
      mergedPosition: sample.mergedPosition ?? null,
      peersCount: sample.peersCount ?? null,
      lastNonZeroPeersMs: null,
      // Seed progress clock at first sight so a pre-existing backlog doesn't
      // instantly alarm — it gets a full grace window from first observation.
      lastIngestProgressMs: sample.mergedPosition !== undefined ? now : null,
      connectedNeverReplSinceMs: null,
      lastSwarmSeenMs: null,
      lastSwarmConnections: null,
      alarmedNoReplicator: false,
      alarmedFrozen: false,
      alarmedConnectedNever: false,
    };
    logs.set(sample.keyHex, st);
  }

  // Was this log ALREADY behind at the previous sample? Computed BEFORE the
  // overwrite: a caught-up→behind transition starts a FRESH grace window from
  // this observation (between samples we cannot know when the backlog
  // appeared, and an idle stretch must never pre-age the freeze clock).
  const wasBehind =
    st.mergedPosition !== null && st.knownLength > st.mergedPosition;
  st.lastSampleMs = now;
  st.knownLength = sample.knownLength;
  st.lastSwarmConnections = sample.swarmConnections ?? null;

  // ── peers-count axis (no_replicator) ──
  if (sample.peersCount !== undefined) {
    st.peersCount = sample.peersCount;
    if (sample.peersCount > 0) {
      st.lastNonZeroPeersMs = now;
      st.alarmedNoReplicator = false; // recovered — a future stall re-fires
    } else if (
      st.lastNonZeroPeersMs !== null &&
      !st.alarmedNoReplicator &&
      now - st.lastNonZeroPeersMs >= graceMs
    ) {
      st.alarmedNoReplicator = true;
      onEpisode({
        workspaceId,
        harnessSlug,
        logKeyHex: sample.keyHex,
        kind: 'no_replicator',
        stalledForMs: now - st.lastNonZeroPeersMs,
        detail:
          `log=${sample.keyHex.slice(0, 12)}… has had 0 live replicator peers for ` +
          `${Math.round((now - st.lastNonZeroPeersMs) / 1000)}s (was previously replicating)`,
      });
    }
  }

  // ── swarm-connected-but-never-replicated axis (WI-183 zombie connections) ──
  // Fires when the harness topic HAS live swarm connections yet this admitted
  // log has NEVER attached a replicator this process lifetime, held ≥ grace.
  // Discriminates the zombie-connection class (stale DHT announce record →
  // relay handshake connects, data path dead — rig run m1783114921: 18min
  // silent window) from ordinary churn (swarm 0 → peer offline → never alarm).
  if (sample.swarmConnections !== undefined && st.lastNonZeroPeersMs === null) {
    if (sample.swarmConnections > 0) {
      st.lastSwarmSeenMs = now;
      if (st.connectedNeverReplSinceMs === null) st.connectedNeverReplSinceMs = now;
      if (
        !st.alarmedConnectedNever &&
        now - st.connectedNeverReplSinceMs >= graceMs
      ) {
        st.alarmedConnectedNever = true;
        onEpisode({
          workspaceId,
          harnessSlug,
          logKeyHex: sample.keyHex,
          kind: 'connected_never_replicated',
          stalledForMs: now - st.connectedNeverReplSinceMs,
          detail:
            `log=${sample.keyHex.slice(0, 12)}… swarm has ${sample.swarmConnections} live ` +
            `connection(s) but this log has NEVER attached a replicator ` +
            `(${Math.round((now - st.connectedNeverReplSinceMs) / 1000)}s connected-but-dead — ` +
            `WI-183 zombie-connection class)`,
        });
      }
    } else if (
      st.connectedNeverReplSinceMs !== null &&
      st.lastSwarmSeenMs !== null &&
      now - st.lastSwarmSeenMs > SWARM_CHURN_TOLERANCE_MS
    ) {
      // SUSTAINED offline (past churn tolerance) → genuinely-offline peer;
      // reset the window. A transient zero (zombie reconnect gap) keeps it.
      st.connectedNeverReplSinceMs = null;
    }
  } else if (st.lastNonZeroPeersMs !== null && st.connectedNeverReplSinceMs !== null) {
    // Replication established — recovered; a future zombie window re-fires.
    st.connectedNeverReplSinceMs = null;
    st.alarmedConnectedNever = false;
  }

  // ── ingest-progress axis (frozen) ──
  if (sample.mergedPosition !== undefined) {
    const prev = st.mergedPosition;
    st.mergedPosition = sample.mergedPosition;
    if (prev === null || sample.mergedPosition > prev) {
      st.lastIngestProgressMs = now;
      st.alarmedFrozen = false; // ingesting — recovered
    } else if (st.knownLength <= sample.mergedPosition) {
      // Caught up: nothing to ingest. Healthy idle — keep the clock fresh so a
      // later backlog gets a full grace window.
      st.lastIngestProgressMs = now;
      st.alarmedFrozen = false;
    } else if (!wasBehind) {
      // Just BECAME behind (caught-up → behind between samples): the freeze
      // window starts at this observation, not at the last idle refresh.
      st.lastIngestProgressMs = now;
      st.alarmedFrozen = false;
    } else if (
      (st.peersCount ?? 0) > 0 &&
      st.lastIngestProgressMs !== null &&
      !st.alarmedFrozen &&
      now - st.lastIngestProgressMs >= graceMs
    ) {
      // Replicator attached, writer is ahead, and we have ingested NOTHING for
      // the whole grace window — attached-but-dead (blocks not flowing). Gated
      // on peers>0 so a plainly-disconnected peer alarms on the peers axis
      // (or never, if it was never connected), not twice.
      st.alarmedFrozen = true;
      onEpisode({
        workspaceId,
        harnessSlug,
        logKeyHex: sample.keyHex,
        kind: 'frozen',
        stalledForMs: now - st.lastIngestProgressMs,
        detail:
          `log=${sample.keyHex.slice(0, 12)}… replicator attached but ingest frozen: ` +
          `writer at ${st.knownLength}, merged to ${sample.mergedPosition}, ` +
          `no progress for ${Math.round((now - st.lastIngestProgressMs) / 1000)}s`,
      });
    }
  }
}

function deriveVerdict(st: LogState, now: number, graceMs: number): ReplicationLogVerdict {
  if (now - st.lastSampleMs >= SAMPLING_STALE_AFTER_MS) return 'sampling_stale';
  // Alarm states (edge-latched) OR live-derived equivalents — read-time truth
  // even between samples.
  if (
    st.alarmedNoReplicator ||
    (st.peersCount === 0 &&
      st.lastNonZeroPeersMs !== null &&
      now - st.lastNonZeroPeersMs >= graceMs)
  ) {
    return 'no_replicator';
  }
  // WI-183 zombie axis: swarm-connected + never-replicated past grace reads as
  // no_replicator (the symptom bucket every consumer already treats as red) —
  // the episode kind carries the precise diagnosis for triage.
  if (
    st.alarmedConnectedNever ||
    (st.lastNonZeroPeersMs === null &&
      st.connectedNeverReplSinceMs !== null &&
      now - st.connectedNeverReplSinceMs >= graceMs)
  ) {
    return 'no_replicator';
  }
  if (
    st.alarmedFrozen ||
    ((st.peersCount ?? 0) > 0 &&
      st.mergedPosition !== null &&
      st.knownLength > st.mergedPosition &&
      st.lastIngestProgressMs !== null &&
      now - st.lastIngestProgressMs >= graceMs)
  ) {
    return 'frozen';
  }
  if (st.lastNonZeroPeersMs === null) return 'never_connected';
  return 'live';
}

export interface GetReplicationLivenessOpts {
  workspaceId?: string;
  harnessSlug?: string;
  /** Test seam — clock override. */
  nowMs?: number;
  /** Grace used for read-time derivation. Default DEFAULT_LIVENESS_GRACE_MS. */
  graceMs?: number;
}

/** Read-time snapshot of every tracked (workspace, harness)'s per-log liveness. */
export function getReplicationLiveness(
  opts: GetReplicationLivenessOpts = {},
): HarnessReplicationLiveness[] {
  const now = opts.nowMs ?? Date.now();
  const graceMs = opts.graceMs ?? DEFAULT_LIVENESS_GRACE_MS;
  const out: HarnessReplicationLiveness[] = [];
  for (const [key, logs] of registry) {
    const sep = key.indexOf('::');
    const workspaceId = key.slice(0, sep);
    const harnessSlug = key.slice(sep + 2);
    if (opts.workspaceId && workspaceId !== opts.workspaceId) continue;
    if (opts.harnessSlug && harnessSlug !== opts.harnessSlug) continue;
    const rows: ReplicationLogLiveness[] = [];
    const counts = { live: 0, neverConnected: 0, noReplicator: 0, frozen: 0, samplingStale: 0 };
    for (const st of logs.values()) {
      const verdict = deriveVerdict(st, now, graceMs);
      if (verdict === 'live') counts.live += 1;
      else if (verdict === 'never_connected') counts.neverConnected += 1;
      else if (verdict === 'no_replicator') counts.noReplicator += 1;
      else if (verdict === 'frozen') counts.frozen += 1;
      else counts.samplingStale += 1;
      rows.push({
        keyHex: st.keyHex,
        verdict,
        knownLength: st.knownLength,
        mergedPosition: st.mergedPosition,
        peersCount: st.peersCount,
        msSinceReplicatorSeen:
          st.lastNonZeroPeersMs === null ? null : now - st.lastNonZeroPeersMs,
        msSinceIngestProgress:
          st.lastIngestProgressMs === null ? null : now - st.lastIngestProgressMs,
        msSinceSampled: now - st.lastSampleMs,
        lastSwarmConnections: st.lastSwarmConnections,
      });
    }
    out.push({ workspaceId, harnessSlug, logs: rows, counts });
  }
  return out;
}

/** Drop one log's tracking state (revoked / re-verify-dropped / removed from the admitted set). */
export function dropReplicationLogState(
  workspaceId: string,
  harnessSlug: string,
  keyHex: string,
): void {
  registry.get(hKey(workspaceId, harnessSlug))?.delete(keyHex);
}

/** Drop a whole harness's tracking state (handle close). */
export function dropReplicationLiveness(workspaceId: string, harnessSlug: string): void {
  registry.delete(hKey(workspaceId, harnessSlug));
}

/** Test seam — wipe the registry between tests. */
export function _resetReplicationLivenessForTests(): void {
  registry.clear();
  episodeReporter = null;
}
