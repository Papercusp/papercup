/**
 * fleet-monitors.ts — the Phase-3 LIVE-FLEET invariants of
 * `shared-hive-loop-e2e-testing-2026-06-10` (P-012 + P-013): the scheduled
 * monitor family that watches the multi-swarm loop in production, built from
 * the failure modes the hermetic Phase-1 rig proved are real.
 *
 *  - `scanDoubleCompletionSignals` (P-012) — cross-swarm double-completion
 *    detector. The per-swarm detectable shape (claims are LOCAL per swarm;
 *    the loser's claim row is not globally visible): an item THIS swarm holds
 *    a LIVE lease on whose TERMINAL status arrived from a REMOTE author
 *    (origin='remote'), without a redundancy declaration ⇒ another swarm
 *    completed an item we believe is ours. Forensics carry both sides (the
 *    local claim + the remote author/fed_ts).
 *
 *  - `sweepOrphanedTakenBy` (P-013; the P-003 starvation fix) — a dead
 *    swarm's `taken_by` federates but never lapses, so `claim_next` can never
 *    steal its in-flight items. The sweep returns to the backlog every
 *    non-terminal item that is marked taken but has NO live lease row and no
 *    recent activity (grace window). Run it on the AUTHORITY swarm — the
 *    lease table consulted is authoritative there; elsewhere it would clear
 *    rows whose lease lives across the RPC boundary.
 *
 *  - `scanOutboxHealth` (P-013) — `substrate_outbox` depth/age vs SLO (the
 *    102GB lesson: alert BEFORE bloat).
 *
 *  - `detectPresenceGhosts` (P-013, pure) — presence rows stale beyond the
 *    window that still anchor live leases: a ghost holds work nobody is doing.
 *
 *  - `measureConvergenceLag` (P-013) — the write-on-A/arrive-on-B probe with
 *    an SLO verdict (the hermetic P-006 measured ~16s for a 2.5k storm; the
 *    production probe writes one marker row per pass).
 *
 * All scans are read-only except the sweep; every function takes its PG
 * client explicitly (no getOrgPg — monitor passes run against a CHOSEN swarm
 * DB). Scheduling/wiring: one routine home shared with the coord-system
 * monitor family (coord-system-e2e-testing P-013) — `runSharedHiveMonitorPass`
 * is the routine body; issue-filing is injected.
 */
import type postgres from 'postgres';

/** Feature-family terminal states (work-items.ts settled list). */
export const TERMINAL_STATUSES = ['passed', 'deprecated'] as const;

// ── P-012: cross-swarm double-completion detector ────────────────────────────

export interface DoubleCompletionSignal {
  workItemId: string;
  harnessSlug: string;
  /** The LOCAL side: the live lease this swarm holds. */
  localClaim: { owner: string; holderPubkey: string | null; acquiredTs: string; expiresTs: string };
  /** The REMOTE side: who authored the terminal write and when (CDC provenance). */
  remote: { authorPubkey: string | null; fedTs: number | null; status: string };
}

export async function scanDoubleCompletionSignals(
  sql: postgres.Sql,
  opts: { workspaceId: string; harness: string; terminalStatuses?: readonly string[] },
): Promise<DoubleCompletionSignal[]> {
  const terminal = [...(opts.terminalStatuses ?? TERMINAL_STATUSES)];
  const rows = await sql<
    Array<{
      work_item_id: string;
      owner: string;
      holder_pubkey: string | null;
      acquired_ts: string;
      expires_ts: string;
      author_pubkey: string | null;
      fed_ts: number | null;
      status: string;
    }>
  >`
    SELECT c.work_item_id, c.owner, c.holder_pubkey, c.acquired_ts, c.expires_ts,
           f.author_pubkey, f.fed_ts, f.status
      FROM harness_shared.work_item_claims c
      JOIN harness_shared.harness_features_consolidated f
        ON f.harness_slug = c.harness_slug AND f.feature_id = c.work_item_id
     WHERE c.workspace_id = ${opts.workspaceId} AND c.harness_slug = ${opts.harness}
       AND c.expires_ts > clock_timestamp()              -- our lease is LIVE
       AND f.status = ANY(${terminal}::text[])           -- yet the item is settled…
       AND f.origin = 'remote'                           -- …by a REMOTE author
       AND (f.redundancy IS NULL OR f.redundancy <= 1)   -- and not a declared fan-out
     ORDER BY c.work_item_id`;
  return rows.map((r) => ({
    workItemId: r.work_item_id,
    harnessSlug: opts.harness,
    localClaim: { owner: r.owner, holderPubkey: r.holder_pubkey, acquiredTs: r.acquired_ts, expiresTs: r.expires_ts },
    remote: { authorPubkey: r.author_pubkey, fedTs: r.fed_ts == null ? null : Number(r.fed_ts), status: r.status },
  }));
}

// ── P-013: orphaned-taken_by sweep (the P-003 starvation fix) ────────────────

export interface OrphanSweepResult {
  /** Items returned to the backlog (taken_by cleared). */
  cleared: Array<{ workItemId: string; takenBy: string; updatedTs: number }>;
}

/**
 * Return to the backlog every NON-terminal item marked taken whose lease row
 * is absent/lapsed and whose last write is older than `graceMs`. Run on the
 * AUTHORITY swarm (see module header). The grace window keeps a just-claimed
 * item (lease write in flight) out of the sweep.
 */
export async function sweepOrphanedTakenBy(
  sql: postgres.Sql,
  opts: {
    workspaceId: string;
    harness: string;
    graceMs?: number;
    nowMs?: number;
    terminalStatuses?: readonly string[];
  },
): Promise<OrphanSweepResult> {
  const terminal = [...(opts.terminalStatuses ?? TERMINAL_STATUSES)];
  const graceMs = opts.graceMs ?? 5 * 60_000;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - graceMs;
  // CTE captures the OLD taken_by (RETURNING alone reflects the NEW row).
  const rows = await sql<Array<{ feature_id: string; taken_by: string; updated_ts: number }>>`
    WITH victims AS (
      SELECT f.harness_slug, f.feature_id, f.taken_by, f.updated_ts
        FROM harness_shared.harness_features_consolidated f
       WHERE f.workspace_id = ${opts.workspaceId} AND f.harness_slug = ${opts.harness}
         AND f.taken_by IS NOT NULL AND f.taken_by <> ''
         AND NOT (f.status = ANY(${terminal}::text[]))
         AND f.updated_ts < ${cutoff}
         AND NOT EXISTS (
               SELECT 1 FROM harness_shared.work_item_claims c
                WHERE c.workspace_id = ${opts.workspaceId}
                  AND c.harness_slug = f.harness_slug
                  AND c.work_item_id = f.feature_id
                  AND c.expires_ts > clock_timestamp())
         FOR UPDATE
    )
    UPDATE harness_shared.harness_features_consolidated f
       -- WI-6303: clear last_progress_at with the claim — an orphaned reclaim must
       -- not leave a stale progress stamp that later reads as genuinely in-flight
       -- work (see work-items-stale-claims.ts's identical WI-6303 fix for the
       -- live-verified root-cause writeup).
       SET taken_by = NULL, taken_at = NULL, last_progress_at = NULL, updated_ts = ${nowMs}
      FROM victims v
     WHERE f.harness_slug = v.harness_slug AND f.feature_id = v.feature_id
    RETURNING v.feature_id, v.taken_by, v.updated_ts`;
  return { cleared: rows.map((r) => ({ workItemId: r.feature_id, takenBy: r.taken_by, updatedTs: Number(r.updated_ts) })) };
}

// ── P-013: outbox health ─────────────────────────────────────────────────────

export interface OutboxHealth {
  undrainedDepth: number;
  oldestUndrainedAgeMs: number | null;
  breaches: string[];
}

export async function scanOutboxHealth(
  sql: postgres.Sql,
  opts: { maxDepth: number; maxAgeMs: number; nowMs?: number; workspaceId?: string; harness?: string },
): Promise<OutboxHealth> {
  const nowMs = opts.nowMs ?? Date.now();
  const rows = await sql<Array<{ depth: number; oldest_ts: number | null }>>`
    SELECT COUNT(*)::int AS depth, MIN(ts) AS oldest_ts
      FROM harness_shared.substrate_outbox
     WHERE drained_at IS NULL
       AND (${opts.workspaceId ?? null}::text IS NULL OR workspace_id = ${opts.workspaceId ?? null})
       AND (${opts.harness ?? null}::text IS NULL OR harness_slug = ${opts.harness ?? null})`;
  const depth = Number(rows[0]?.depth ?? 0);
  const oldest = rows[0]?.oldest_ts == null ? null : Number(rows[0].oldest_ts);
  const age = oldest == null ? null : Math.max(0, nowMs - oldest);
  const breaches: string[] = [];
  if (depth > opts.maxDepth) breaches.push(`outbox depth ${depth} > SLO ${opts.maxDepth}`);
  if (age != null && age > opts.maxAgeMs) breaches.push(`oldest undrained row age ${age}ms > SLO ${opts.maxAgeMs}ms`);
  return { undrainedDepth: depth, oldestUndrainedAgeMs: age, breaches };
}

// ── EI-20579195481991931: per-peer federation silence ────────────────────────
//
// `scanOutboxHealth` above is HOST-LOCAL BY CONSTRUCTION: `substrate_outbox`
// holds only THIS host's undrained writes, so the one failure a p2p system must
// never miss — a PEER that stops federating — is exactly the failure it cannot
// see. Measured 2026-08-16: peer machine B sat 100% undrained (5,832 rows,
// oldest 48h) while host A read 0 undrained and filed nothing.
//
// The locally-observable proxy is `substrate_merge_cursor`: one row per log
// (`log_keyhex`) recording how far we have folded it, re-stamped on every
// ADVANCE (pg-merge-cursor-store.ts `save`). ⚠ It holds a row for OUR OWN log
// as well as for remote ones — this comment claimed "one row per REMOTE log" for
// three weeks and the judge believed it, which is the whole of the false
// "N of M peers silent" reading described at the own-log split below. The judge
// therefore resolves the own key and excludes it rather than trusting the shape.
// A peer that stops producing — or
// that we can no longer reach — stops advancing ITS cursor while other peers'
// keep moving. Verified discriminating on host A: harness `papercusp` held 21
// logs spanning 0.00h to 509.71h since last advance.
//
// ⚠ THE ALL-SILENT CASE IS A DIFFERENT VERDICT, AND CONFLATING THE TWO IS THE
// WHOLE POINT. One silent log among live ones ⇒ that PEER went quiet. EVERY log
// silent ⇒ our own fold is wedged and we must not blame peers for it. That is a
// positive control expressed in code: the still-advancing logs are what license
// the per-peer reading, so when they vanish the reading is withdrawn rather than
// amplified into N false peer alarms.
//
// ⚠ WHAT THIS CANNOT DISTINGUISH, stated rather than hidden: from this host, a
// peer that is DOWN, a peer that is UNREACHABLE, and a peer that is merely IDLE
// all present identically as "no new ops from that log". The scan reports the
// observable (no inbound progress for N ms) and leaves the cause open; a
// retired/departed peer's log therefore goes silent forever, which is why the
// SLO wants to be generous and why `position` rides along in the forensics.

/** One remote log's fold progress, as `substrate_merge_cursor` records it. */
export interface MergeCursorRow {
  logKeyHex: string;
  position: number;
  updatedAtMs: number;
  /**
   * The pot-home projection scope this row was folded under (migration 685).
   * REQUIRED because it decides whether the row is live at all: the fold only
   * ever loads cursors matching the binding it is currently running with, so a
   * row under any other binding is unreachable by construction.
   */
  applyBinding: string | null;
}

export interface PeerSilence {
  logKeyHex: string;
  /** How long since we last folded anything new from this log. */
  silentForMs: number;
  /** Fold position reached before it went quiet (0 ⇒ we never folded it at all). */
  position: number;
}

export interface PeerFederationHealth {
  /** Remote logs considered. 0 ⇒ UNMEASURED — never read it as healthy. */
  totalLogs: number;
  /** False when there is nothing to judge; the caller must not infer health. */
  measured: boolean;
  /** Why we could not judge — so `measured:false` is never a bare shrug. */
  unmeasuredReason:
    | 'no-remote-logs'
    | 'scope-dormant'
    | 'scan-failed'
    | 'own-log-only'
    | 'own-log-unknown'
    | null;
  /** Set with `scan-failed`: the error, kept so a broken scan is diagnosable. */
  scanError?: string;
  silent: PeerSilence[];
  /** Age of the MOST RECENTLY advanced log — the liveness of our own fold. */
  freshestAdvanceMs: number | null;
  /** Every known log is silent ⇒ suspect the LOCAL fold, not the peers. */
  allSilent: boolean;
  breaches: string[];
  /**
   * Cursors EXCLUDED from the judgement because they sit under a superseded
   * `apply_binding` (see the judge). Reported rather than silently dropped: they
   * are unreachable by the fold and will never advance, so a non-zero count is
   * schema residue to clean up, not peers to chase.
   */
  strandedCursors: number;
  /** The binding the judged population shares — null is a legitimate value. */
  liveApplyBinding: string | null;
  /**
   * Our OWN log's cursor, excluded from the peer population (see the judge).
   * Reported because it is a genuine LOCAL-liveness reading — just not a peer
   * one — and because a reader who sees `own-log-only` needs to know we were
   * still folding our own writes while no remote log was admitted.
   */
  ownLogSilentForMs: number | null;
  /**
   * How many of the JUDGED (remote) logs are actually in this scope's live
   * ADMITTED set. `null` ⇒ we could not read the admitted set — deliberately
   * distinct from `0`, which is a determined "no peer is admitted here".
   *
   * WI-39489: a merge cursor OUTLIVES admission. The cursor table is durable PG
   * state; `handle.admitted` is rebuilt in memory each boot and only re-populated
   * when a peer RE-ANNOUNCES. So a host whose peers went away keeps their cursors
   * forever, and judging cursors alone cannot tell "the fold is wedged" from
   * "there is nothing to fold". This is the number that separates them.
   */
  admittedRemoteLogs: number | null;
}

/**
 * Pure verdict over merge-cursor rows (the SQL lives in
 * `scanPeerFederationSilence`). Split out so the judgement — which is where the
 * all-silent/some-silent distinction lives — is unit-testable without PG.
 */
export function judgePeerFederationSilence(
  rows: readonly MergeCursorRow[],
  opts: {
    silentAfterMs: number;
    nowMs: number;
    /** Age of OUR OWN newest write in this scope; null = unknown, so judge anyway. */
    localActivityAgeMs?: number | null;
    /**
     * OUR OWN log's key in this scope. REQUIRED to judge: `substrate_merge_cursor`
     * holds a row for the own log too, and it is not a peer (see the judge).
     * `undefined` ⇒ we could not identify it, which is UNMEASURED, never "judge
     * anyway" — judging anyway is exactly the false-peer-alarm this prevents.
     */
    ownLogKeyHex?: string | null;
    /**
     * Every log key in this scope's LIVE ADMITTED set (own log included — the
     * judge already knows which one that is). `undefined` ⇒ we could not read it,
     * which is reported as `admittedRemoteLogs: null` and changes no verdict:
     * ignorance must not be spelled the same as a determined zero (WI-39489).
     */
    admittedLogKeysHex?: readonly string[];
  },
): PeerFederationHealth {
  const admittedSet = opts.admittedLogKeysHex ? new Set(opts.admittedLogKeysHex) : null;
  if (rows.length === 0) {
    return {
      totalLogs: 0,
      measured: false,
      unmeasuredReason: 'no-remote-logs',
      silent: [],
      freshestAdvanceMs: null,
      allSilent: false,
      strandedCursors: 0,
      liveApplyBinding: null,
      ownLogSilentForMs: null,
      admittedRemoteLogs: admittedSet ? 0 : null,
      // Deliberately NOT a breach: "no remote logs" is the honest shape of a
      // host that has never federated. It is reported as UNMEASURED so a caller
      // that knows federation IS in use (outbox rows exist) can escalate it,
      // and one that does not cannot mistake it for a clean bill of health.
      breaches: [],
    };
  }
  // EI-20617273180156712: a cursor only means anything under the `apply_binding`
  // the fold is CURRENTLY running with. `pg-merge-cursor-store.load` selects with
  // `apply_binding IS NOT DISTINCT FROM <binding>`, so a row written under a
  // SUPERSEDED binding is never loaded, never advanced, and never can be — dead
  // schema residue, not a silent peer. Counting those rows fabricated a
  // "20 of 21 logs silent, oldest 21.4 days" major on host A entirely out of 15
  // cursors stranded by migration 685, an alert no peer could ever clear.
  //
  // The live binding is read from the DATA (whichever binding owns the freshest
  // row), deliberately NOT re-derived: boot.ts resolves it through
  // `hiveHomeProjectionSlug ?? ownPotHomeSlug ?? memberHomeRebindSlug`, and a
  // second copy of that chain here would be free to drift out of agreement with
  // the fold — which is this very defect, one level up. Reading it from the data
  // cannot drift, because the fold is what writes the data.
  //
  // ⚠ A null binding is a LEGITIMATE live value (a non-hive harness folds with
  // applyBinding=null), so this must compare bindings, never truthiness.
  const freshestRow = rows.reduce((a, b) => (b.updatedAtMs > a.updatedAtMs ? b : a));
  const liveApplyBinding = freshestRow.applyBinding;
  const underLiveBinding = rows.filter((r) => r.applyBinding === liveApplyBinding);
  const strandedCursors = rows.length - underLiveBinding.length;

  // OUR OWN LOG IS NOT A PEER. `substrate_merge_cursor` holds a row for it too,
  // and it is re-stamped by our own writes — so while this host is active it is
  // an ETERNALLY-ADVANCING row. The comment at the top of this section says the
  // still-advancing logs are the positive control that "licenses the per-peer
  // reading"; our own log licenses that reading unconditionally, which means the
  // all-silent branch — the whole point of the discrimination — can never fire on
  // a host that is still writing. Measured 2026-08-16: this host had admitted ZERO
  // remote logs in all 95 booted scopes, yet `papercusp` reported "5 of 6 remote
  // logs silent while 1 keeps advancing" (the 1 was us) instead of LOCAL FOLD
  // SUSPECT, while `hive-canary` — where our own log was ALSO stale because we
  // stopped writing there — did reach the local verdict. Same condition, two
  // different verdicts, neither naming the cause.
  //
  // ⚠ An UNKNOWN own-log key is UNMEASURED, never "judge anyway": judging anyway
  // is precisely the false-peer-alarm above, and this module's rule is to degrade
  // to unmeasured rather than to a confident wrong reading.
  if (opts.ownLogKeyHex === undefined) {
    return {
      totalLogs: underLiveBinding.length,
      measured: false,
      unmeasuredReason: 'own-log-unknown',
      silent: [],
      freshestAdvanceMs: null,
      allSilent: false,
      breaches: [],
      strandedCursors,
      liveApplyBinding,
      ownLogSilentForMs: null,
      admittedRemoteLogs: null,
    };
  }
  const ownRow = underLiveBinding.find((r) => r.logKeyHex === opts.ownLogKeyHex);
  const ownLogSilentForMs = ownRow ? Math.max(0, opts.nowMs - ownRow.updatedAtMs) : null;
  const judged = underLiveBinding.filter((r) => r.logKeyHex !== opts.ownLogKeyHex);
  // WI-39489: how many of the judged logs the fold could ACTUALLY advance. A
  // cursor is durable PG state and outlives admission, so a peer that went away
  // leaves a row that can never move again — indistinguishable, from the cursor
  // table alone, from a peer we are failing to fold. `null` (unknown) is kept
  // distinct from `0` (determined): only a determined zero may change a verdict.
  const admittedRemoteLogs = admittedSet
    ? judged.filter((r) => admittedSet.has(r.logKeyHex)).length
    : null;

  // No REMOTE log at all under the live binding. This is the honest shape of "we
  // have admitted no peers here" and it is the reading that was missing today —
  // it is deliberately NOT a peer breach (there are no peers to breach) and
  // deliberately NOT healthy. A caller that knows peers are expected escalates it.
  if (judged.length === 0) {
    return {
      totalLogs: 0,
      measured: false,
      unmeasuredReason: 'own-log-only',
      silent: [],
      freshestAdvanceMs: null,
      allSilent: false,
      breaches: [],
      strandedCursors,
      liveApplyBinding,
      ownLogSilentForMs,
      admittedRemoteLogs,
    };
  }

  // A scope WE stopped writing to is one we are no longer federating. Every
  // remote log there is silent for the mundane reason that the whole scope is
  // retired — measured on host A, harness `sheets` held 75/75 logs silent while
  // our own newest write was ~44h old. Judging it would report a dead harness as
  // a wedged fold, forever, in a dedup bucket that never closes. Silence is only
  // evidence of a FAULT when we ourselves are still live in the scope.
  if (opts.localActivityAgeMs != null && opts.localActivityAgeMs > opts.silentAfterMs) {
    return {
      totalLogs: judged.length,
      measured: false,
      unmeasuredReason: 'scope-dormant',
      silent: [],
      freshestAdvanceMs: null,
      allSilent: false,
      breaches: [],
      strandedCursors,
      liveApplyBinding,
      ownLogSilentForMs,
      admittedRemoteLogs,
    };
  }
  const ages = judged.map((r) => Math.max(0, opts.nowMs - r.updatedAtMs));
  const freshestAdvanceMs = Math.min(...ages);
  const silent = judged
    .map((r, i) => ({ logKeyHex: r.logKeyHex, silentForMs: ages[i]!, position: r.position }))
    .filter((s) => s.silentForMs > opts.silentAfterMs)
    .sort((a, b) => b.silentForMs - a.silentForMs);
  const allSilent = silent.length === judged.length;
  const breaches: string[] = [];
  // Only the live-binding population is described. `strandedCursors` rides on the
  // result instead so residue stays visible without inflating a peer verdict.
  const strandedNote =
    strandedCursors > 0
      ? ` (${strandedCursors} further cursor(s) ignored: stranded under a superseded apply_binding — schema residue, not peers)`
      : '';
  if (allSilent && admittedRemoteLogs === 0) {
    // WI-39489: all silent AND not one of them is admitted. "Suspect this host's
    // merge loop" is the WRONG SUBJECT here — the fold is fine, there is simply
    // nothing to fold. Measured 2026-08-16: this host held 0 admitted peer logs
    // in all 95 booted scopes and no peer had announced into ANY papercusp scope
    // since 2026-08-15T22:36:39Z (73,420 `announce_admitted` across 41 scopes,
    // all stopping at that instant), with ZERO rejections/errors/skew in two days
    // — while the same admission code path on the same box kept admitting for 12
    // OTHER workspaces. Cursors persist; admission does not. Reported as a breach
    // rather than swallowed, because "we are not federating at all" is precisely
    // what an operator needs told — just told about the right subject.
    breaches.push(
      `NO PEER ADMITTED: ${judged.length} remote log(s) have merge cursors here but NONE is in this scope's admitted set (freshest advance ${freshestAdvanceMs}ms ago > SLO ${opts.silentAfterMs}ms). The peers are ABSENT, not slow — nothing is being folded because nothing is announced. Suspect the announce/admission path or peer liveness, NOT this host's merge loop.${strandedNote}`,
    );
  } else if (allSilent) {
    // Every log silent while at least one IS admitted (or admission is unknown —
    // ignorance never upgrades to the confident reading above). Withhold the
    // per-peer reading: with no advancing log left as a control, the evidence
    // points at our own fold, and N peer alarms would be N false positives
    // dressed as corroboration.
    breaches.push(
      `LOCAL FOLD SUSPECT: all ${judged.length} remote log(s) silent — freshest advance ${freshestAdvanceMs}ms ago > SLO ${opts.silentAfterMs}ms. Suspect this host's merge loop, NOT the peers.${strandedNote}`,
    );
  } else if (silent.length > 0) {
    breaches.push(
      `${silent.length} of ${judged.length} remote log(s) have federated nothing for > SLO ${opts.silentAfterMs}ms (oldest ${silent[0]!.silentForMs}ms, log ${silent[0]!.logKeyHex.slice(0, 12)}…) while ${judged.length - silent.length} log(s) keep advancing.${strandedNote}`,
    );
  }
  return {
    totalLogs: judged.length,
    measured: true,
    unmeasuredReason: null,
    silent,
    freshestAdvanceMs,
    allSilent,
    breaches,
    strandedCursors,
    liveApplyBinding,
    ownLogSilentForMs,
    admittedRemoteLogs,
  };
}

/** Read one scope's remote-log fold progress and judge it. */
export async function scanPeerFederationSilence(
  sql: postgres.Sql,
  opts: { workspaceId: string; harness: string; silentAfterMs: number; nowMs?: number },
): Promise<PeerFederationHealth> {
  const nowMs = opts.nowMs ?? Date.now();
  try {
    return await readAndJudgePeerSilence(sql, opts, nowMs);
  } catch (err) {
    // FAIL SOFT, NEVER SILENT. This leg was ADDED to a pass whose other scans
    // (outbox health, double-completion, orphan sweep) already worked, and
    // `runSharedHiveLeg` wraps the whole pass in one try/catch — so a throw here
    // would take those working scans down with it and the scope would report
    // nothing at all. That is the very failure mode this work exists to remove,
    // so the new leg degrades to UNMEASURED (never to "healthy") and the rest of
    // the pass proceeds. Found the hard way: the composition rig's sliced schema
    // lacked substrate_merge_cursor and killed the entire pass with 42P01.
    return {
      totalLogs: 0,
      measured: false,
      unmeasuredReason: 'scan-failed',
      scanError: err instanceof Error ? err.message : String(err),
      silent: [],
      freshestAdvanceMs: null,
      allSilent: false,
      breaches: [],
      strandedCursors: 0,
      liveApplyBinding: null,
      ownLogSilentForMs: null,
      admittedRemoteLogs: null,
    };
  }
}

async function readAndJudgePeerSilence(
  sql: postgres.Sql,
  opts: { workspaceId: string; harness: string; silentAfterMs: number },
  nowMs: number,
): Promise<PeerFederationHealth> {
  // `apply_binding` is SELECTed, never filtered on here: the judge decides which
  // binding is live from the data and reports the rest as stranded, so a scope
  // whose binding changed is measured rather than silently half-read
  // (EI-20617273180156712).
  const rows = await sql<
    Array<{
      log_keyhex: string;
      position: string | number;
      updated_at_ms: string;
      apply_binding: string | null;
    }>
  >`
    SELECT log_keyhex, position, apply_binding,
           (extract(epoch FROM updated_at) * 1000)::bigint::text AS updated_at_ms
      FROM harness_shared.substrate_merge_cursor
     WHERE workspace_id = ${opts.workspaceId} AND harness_slug = ${opts.harness}`;
  // OUR OWN newest write in this scope — the dormancy control (see the judge).
  // `substrate_outbox.ts` is this host's write clock regardless of drain state,
  // so it answers "are WE still live here?" without depending on the peers we
  // are about to judge.
  const [local] = await sql<Array<{ newest_ts: string | null }>>`
    SELECT MAX(ts)::text AS newest_ts FROM harness_shared.substrate_outbox
     WHERE workspace_id = ${opts.workspaceId} AND harness_slug = ${opts.harness}`;
  // NO local rows at all is the STRONGEST dormancy evidence, not "unknown": we
  // have never written in this scope, so we are not a participant in it. Passing
  // null here would mean "no evidence, judge anyway" and — measured on host A —
  // filed ~10 false `local-fold-suspect` majors for scopes we never joined
  // (`sheets` 75/75 silent, `papercup` last advance 984h). Infinity says exactly
  // what is true: our last local write was infinitely long ago.
  // ⚠ LIMITATION, stated rather than hidden: a scope we only ever READ from
  // (consume without writing) is indistinguishable from one we never joined, so
  // a genuine stall there reads as dormant. Every scope we actively federate
  // does write, so this trades an unreachable case for ~10 standing false majors.
  const newestLocal =
    local?.newest_ts == null ? Number.POSITIVE_INFINITY : Number(local.newest_ts);
  // OUR OWN log's key in this scope, so the judge can take it out of the peer
  // population. `substrate_booted_handles_status` is this host publishing its own
  // boot registry (`log-stats.ts` walks `handle.admitted`, stamping `isOwn`
  // against `handle.ownLog.keyHex`), so this reads the SAME authority the fold
  // boots from rather than re-deriving the identity here and being free to drift
  // from it — the failure mode that produced EI-20617273180156712.
  //
  // `undefined` when we cannot find it: the judge treats that as UNMEASURED, so a
  // missing/never-written status row can never silently reinstate the own log as
  // a phantom peer.
  //
  // WI-39489: the SAME row also carries the whole ADMITTED set for the scope
  // (`log-stats.ts` emits one `perLog` entry per member of `handle.admitted`), so
  // the admitted keys are read here rather than from a second source that would
  // be free to disagree with the own key. Selecting every entry and picking the
  // own one out in JS — instead of two queries, or one query with an `isOwn`
  // predicate plus another without — keeps both readings from the SAME snapshot;
  // two reads could straddle a boot and report an own log that is not in the
  // admitted set they are compared against.
  const admittedRows = await sql<Array<{ key_hex: string; is_own: boolean | null }>>`
    SELECT pl->>'keyHex' AS key_hex, (pl->>'isOwn')::boolean AS is_own
      FROM harness_shared.substrate_booted_handles_status s,
           LATERAL jsonb_array_elements(s.payload->'healthInputs'->'logStats') ls,
           LATERAL jsonb_array_elements(ls->'perLog') pl
     WHERE s.workspace_id = ${opts.workspaceId}
       AND ls->>'workspaceId' = ${opts.workspaceId}
       AND ls->>'harnessSlug' = ${opts.harness}`;
  const ownLog = admittedRows.find((r) => r.is_own === true);
  // NO rows at all ⇒ this scope has no published boot status, so the admitted set
  // is UNKNOWN, not empty. Passing [] here would assert a determined "no peer is
  // admitted" from an absent measurement — the exact ignorance-as-fact error the
  // `null` reading exists to prevent. (The own-key branch of the judge already
  // returns `own-log-unknown` in this case; this keeps the two consistent if that
  // ever changes.)
  const admittedLogKeysHex = admittedRows.length > 0 ? admittedRows.map((r) => r.key_hex) : undefined;
  return judgePeerFederationSilence(
    rows.map((r) => ({
      logKeyHex: r.log_keyhex,
      position: Number(r.position),
      updatedAtMs: Number(r.updated_at_ms),
      applyBinding: r.apply_binding,
    })),
    {
      silentAfterMs: opts.silentAfterMs,
      nowMs,
      localActivityAgeMs: newestLocal == null ? null : Math.max(0, nowMs - newestLocal),
      ownLogKeyHex: ownLog?.key_hex,
      admittedLogKeysHex,
    },
  );
}

// ── P-013: presence ghosts (pure) ────────────────────────────────────────────

export interface PresenceRow {
  devicePubkey: string;
  lastSeenMs: number;
}

export interface LeaseHolderRow {
  workItemId: string;
  holderPubkey: string | null;
  expiresTsMs: number;
}

export interface PresenceGhost {
  devicePubkey: string;
  staleForMs: number;
  /** Live leases the ghost still anchors — work nobody is doing. */
  heldItems: string[];
}

export function detectPresenceGhosts(
  presence: readonly PresenceRow[],
  liveLeases: readonly LeaseHolderRow[],
  opts: { staleMs: number; nowMs: number },
): PresenceGhost[] {
  const ghosts: PresenceGhost[] = [];
  for (const p of presence) {
    const staleFor = opts.nowMs - p.lastSeenMs;
    if (staleFor <= opts.staleMs) continue;
    const held = liveLeases
      .filter((l) => l.holderPubkey === p.devicePubkey && l.expiresTsMs > opts.nowMs)
      .map((l) => l.workItemId)
      .sort();
    if (held.length > 0) ghosts.push({ devicePubkey: p.devicePubkey, staleForMs: staleFor, heldItems: held });
  }
  return ghosts.sort((a, b) => (a.devicePubkey < b.devicePubkey ? -1 : 1));
}

// ── P-013: convergence-lag probe ─────────────────────────────────────────────

export interface ConvergenceLagResult {
  lagMs: number;
  arrived: boolean;
  breach: boolean;
}

/**
 * The write-on-A / measure-arrival-on-B probe. `write` performs the marker
 * write on the source swarm; `arrived` polls the destination swarm (and may
 * drive a merge pass). SLO verdict in the result; never throws on timeout —
 * the non-arrival IS the signal.
 */
export async function measureConvergenceLag(opts: {
  write: () => Promise<void>;
  arrived: () => Promise<boolean>;
  sloMs: number;
  pollMs?: number;
  timeoutMs?: number;
  nowFn?: () => number;
}): Promise<ConvergenceLagResult> {
  const now = opts.nowFn ?? Date.now;
  const pollMs = opts.pollMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? Math.max(opts.sloMs * 4, 10_000);
  const t0 = now();
  await opts.write();
  for (;;) {
    if (await opts.arrived()) {
      const lagMs = now() - t0;
      return { lagMs, arrived: true, breach: lagMs > opts.sloMs };
    }
    if (now() - t0 >= timeoutMs) return { lagMs: now() - t0, arrived: false, breach: true };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ── The monitor pass (the routine body) ──────────────────────────────────────

export interface MonitorIncident {
  kind:
    | 'double-completion'
    | 'outbox-health'
    | 'presence-ghost'
    | 'orphaned-taken-by'
    // EI-20579195481991931: a PEER stopped federating to us (or our own fold
    // wedged — the report says which).
    | 'peer-federation-silence'
    // EI-20579195481991931: the monitor resolved ZERO scopes on a host that is
    // demonstrably federating — i.e. it did not actually run. Filed LOUDLY,
    // because the failure mode being closed is a monitor whose silence was
    // indistinguishable from health.
    | 'monitor-scope-empty';
  title: string;
  detail: unknown;
}

export interface MonitorPassReport {
  incidents: MonitorIncident[];
  sweptOrphans: number;
  outbox: OutboxHealth;
  /** EI-20579195481991931 — `measured:false` means UNMEASURED, not healthy. */
  peers: PeerFederationHealth;
}

/**
 * One scheduled monitor pass over one swarm's PG. Issue-filing is INJECTED
 * (`fileIncident`) so the scheduling home (shared with the coord-system
 * monitor family) decides dedup/severity; the pass itself stays pure-ish.
 * The orphan sweep only runs when `isAuthority` (see sweepOrphanedTakenBy).
 */
export async function runSharedHiveMonitorPass(opts: {
  sql: postgres.Sql;
  workspaceId: string;
  harness: string;
  isAuthority: boolean;
  presence?: readonly PresenceRow[];
  liveLeases?: readonly LeaseHolderRow[];
  slo?: {
    outboxMaxDepth?: number;
    outboxMaxAgeMs?: number;
    presenceStaleMs?: number;
    orphanGraceMs?: number;
    /** EI-20579195481991931: inbound silence from ONE remote log before we call
     *  it a stall. Generous by design — an idle peer is indistinguishable from a
     *  stalled one from here, so a tight SLO buys false alarms, not sensitivity. */
    peerSilentAfterMs?: number;
  };
  nowMs?: number;
  fileIncident?: (incident: MonitorIncident) => Promise<void>;
}): Promise<MonitorPassReport> {
  const nowMs = opts.nowMs ?? Date.now();
  const incidents: MonitorIncident[] = [];

  const doubles = await scanDoubleCompletionSignals(opts.sql, {
    workspaceId: opts.workspaceId,
    harness: opts.harness,
  });
  for (const d of doubles) {
    incidents.push({
      kind: 'double-completion',
      title: `cross-swarm double completion: ${d.workItemId} settled remotely (${d.remote.authorPubkey?.slice(0, 12) ?? 'unknown'}…) while ${d.localClaim.owner} holds the live lease`,
      detail: d,
    });
  }

  const outbox = await scanOutboxHealth(opts.sql, {
    maxDepth: opts.slo?.outboxMaxDepth ?? 10_000,
    maxAgeMs: opts.slo?.outboxMaxAgeMs ?? 30 * 60_000,
    nowMs,
    workspaceId: opts.workspaceId,
    harness: opts.harness,
  });
  for (const b of outbox.breaches) {
    incidents.push({ kind: 'outbox-health', title: b, detail: outbox });
  }

  // EI-20579195481991931 — the leg `scanOutboxHealth` structurally cannot cover:
  // a PEER that stopped federating to us. See the block above this function's
  // `judgePeerFederationSilence` for why the all-silent case is a different
  // verdict rather than N peer alarms.
  const peers = await scanPeerFederationSilence(opts.sql, {
    workspaceId: opts.workspaceId,
    harness: opts.harness,
    silentAfterMs: opts.slo?.peerSilentAfterMs ?? 6 * 60 * 60_000,
    nowMs,
  });
  for (const b of peers.breaches) {
    incidents.push({ kind: 'peer-federation-silence', title: b, detail: peers });
  }

  if (opts.presence && opts.liveLeases) {
    for (const g of detectPresenceGhosts(opts.presence, opts.liveLeases, {
      staleMs: opts.slo?.presenceStaleMs ?? 10 * 60_000,
      nowMs,
    })) {
      incidents.push({
        kind: 'presence-ghost',
        title: `presence ghost ${g.devicePubkey.slice(0, 12)}… still anchors ${g.heldItems.length} live lease(s)`,
        detail: g,
      });
    }
  }

  let sweptOrphans = 0;
  if (opts.isAuthority) {
    const swept = await sweepOrphanedTakenBy(opts.sql, {
      workspaceId: opts.workspaceId,
      harness: opts.harness,
      graceMs: opts.slo?.orphanGraceMs,
      nowMs,
    });
    sweptOrphans = swept.cleared.length;
    if (sweptOrphans > 0) {
      incidents.push({
        kind: 'orphaned-taken-by',
        title: `${sweptOrphans} orphaned item(s) returned to the backlog (dead holder, no live lease)`,
        detail: swept.cleared,
      });
    }
  }

  if (opts.fileIncident) {
    for (const i of incidents) await opts.fileIncident(i);
  }
  return { incidents, sweptOrphans, outbox, peers };
}
