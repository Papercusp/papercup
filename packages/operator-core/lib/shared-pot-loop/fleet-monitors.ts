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
       SET taken_by = NULL, taken_at = NULL, updated_ts = ${nowMs}
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
  kind: 'double-completion' | 'outbox-health' | 'presence-ghost' | 'orphaned-taken-by';
  title: string;
  detail: unknown;
}

export interface MonitorPassReport {
  incidents: MonitorIncident[];
  sweptOrphans: number;
  outbox: OutboxHealth;
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
  slo?: { outboxMaxDepth?: number; outboxMaxAgeMs?: number; presenceStaleMs?: number; orphanGraceMs?: number };
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
  return { incidents, sweptOrphans, outbox };
}
