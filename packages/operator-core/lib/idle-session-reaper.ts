/**
 * idle-session-reaper.ts — reap DEAD-process SU CLI sessions.
 *
 * Plan: operator-memory-and-psu-resilience-2026-06-14 P-011 (D-007).
 *
 * D-007 (su-4b005/su-36a0c): the single :3070 operator event loop is the
 * chokepoint — ~52 long-lived SU sessions each hold LISTEN conns + polling on
 * top of the eager all-harness substrate, so new spawns crawl. Idle/done SU
 * sessions persist for hours, never freeing their operator/LISTEN/MCP footprint.
 *
 * THIS MODULE (P-011 slice 1) is the SAFE foundation: a periodic sweep that
 * marks an OPEN `adv_sessions` row (`ended_at IS NULL`) ENDED once its owning
 * process is DEAD — i.e. its `coord_owner_id` has dropped out of the liveness
 * set (no fresh `coord_presence` heartbeat, no running `spawned_agents` alias,
 * no registered wake, holds no work-item claim) for longer than the grace
 * window. A LIVE psu session heartbeats its presence row every 60s (the
 * supervisor beat, psu-launcher.startSupervisorBeat) regardless of activity, so
 * a present owner is ALWAYS protected — this can only ever reap a session whose
 * process has already exited without stamping `ended_at` (the best-effort
 * reportSessionEnded didn't run). Reaping such a ghost reclaims the live roster
 * and unblocks `session-dir-gc` (which protects every `ended_at IS NULL` row).
 *
 * What this slice deliberately does NOT do: terminate a LIVE-but-idle session
 * (the actual event-loop-saturation fix). That needs an activity-based idle
 * signal + safe termination via the managed-pty control socket
 * (turn-lifecycle-control) and is the follow-on slice — see the plan.
 *
 * Liveness rule is deliberately identical to work-items-stale-claims.ts /
 * the mig-225 fleet_assignment view (EI-311) so the reapers can never disagree.
 *
 * The keep/reap decision is a PURE function (`planIdleSessionReap`, injected
 * clock + protected set) so it unit-tests without PG; the sweep wraps it with
 * the PG gather + the `markAdvSessionEnded` write. Flag-gated DEFAULT-OFF
 * (FLAGS.IDLE_SESSION_REAPER) — off ⇒ a no-op. Server-only.
 */

import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { getOrgPg } from '@papercusp/db-org';
import { markAdvSessionEnded } from './adv-sessions';

/** Liveness/grace window. Matches work-items-stale-claims STALE_CLAIM_GRACE_MS
 *  and the fleet_assignment view (10 min): a live psu session's supervisor beat
 *  (every 60s) refreshes presence well inside it, so a briefly-quiet but alive
 *  session is never reaped. Also the floor on `started_at` so a just-launched
 *  session (presence not yet written in its first seconds) is never reaped. */
export const IDLE_SESSION_GRACE_MS = 10 * 60 * 1000;

/** One open adv_session considered for reaping. */
export interface ReapableSession {
  id: number;
  coordOwnerId: string | null;
  startedAtMs: number;
}

export interface IdleSessionReapPlan {
  /** Dead owner (not protected) AND older than the grace floor → reap. */
  reap: ReapableSession[];
  /** Owner is live/claim/wake-protected → keep. */
  keptLive: ReapableSession[];
  /** Within the grace floor (too new to judge) → keep. */
  keptFresh: ReapableSession[];
  /** No coord_owner_id → can't liveness-check → never reap (kept). */
  keptNoOwner: ReapableSession[];
}

/**
 * PURE keep/reap decision. A session is reaped ONLY when it has a
 * coord_owner_id, that owner is NOT in the protected (live) set, AND it started
 * longer ago than the grace floor. No I/O — `nowMs` + `protectedOwners`
 * injected so the boundary is unit-tested deterministically.
 */
export function planIdleSessionReap(opts: {
  sessions: ReapableSession[];
  protectedOwners: Set<string>;
  nowMs: number;
  graceMs?: number;
}): IdleSessionReapPlan {
  const graceMs = opts.graceMs ?? IDLE_SESSION_GRACE_MS;
  const plan: IdleSessionReapPlan = { reap: [], keptLive: [], keptFresh: [], keptNoOwner: [] };
  for (const s of opts.sessions) {
    if (!s.coordOwnerId) {
      plan.keptNoOwner.push(s); // no liveness key → never reap (can't prove it's dead)
    } else if (opts.protectedOwners.has(s.coordOwnerId)) {
      plan.keptLive.push(s); // fresh presence / running bee / registered wake / open claim
    } else if (opts.nowMs - s.startedAtMs < graceMs) {
      plan.keptFresh.push(s); // too new — its first presence beat may not have landed yet
    } else {
      plan.reap.push(s); // dead owner, past grace → ghost row, end it
    }
  }
  return plan;
}

/**
 * The set of coord owner ids that are ALIVE / must never be reaped — the same
 * alias-aware liveness as work-items-stale-claims (presence + running nursery
 * aliases) UNION registered wakes (the wake-executor will resume them) UNION
 * any work-item claim holder (never reap a session mid-claim). One read.
 */
export async function gatherProtectedSessionOwners(
  sql: Awaited<ReturnType<typeof getOrgPg>>['sql'],
  opts: { graceMs?: number } = {},
): Promise<Set<string>> {
  const graceSec = Math.max(1, Math.round((opts.graceMs ?? IDLE_SESSION_GRACE_MS) / 1000));
  const rows = await sql<Array<{ alias: string }>>`
    WITH owners AS (
      SELECT owner_id AS alias
        FROM harness_shared.coord_presence
       WHERE heartbeat_at IS NOT NULL
         AND (now() - heartbeat_at) < make_interval(secs => ${graceSec})
      UNION
      SELECT a.alias
        FROM harness_shared.spawned_agents n
        CROSS JOIN LATERAL (VALUES (n.spawn_id), (n.session_owner), (n.run_id)) AS a(alias)
       WHERE n.status IN ('running', 'restarting')
         AND n.heartbeat_at IS NOT NULL
         AND (now() - n.heartbeat_at) < make_interval(secs => ${graceSec})
      UNION
      SELECT subscriber_id AS alias
        FROM harness_shared.event_awaits
       WHERE fired_at IS NULL AND cancelled_at IS NULL
      UNION
      SELECT subscriber_id AS alias
        FROM harness_shared.event_wake_deliveries
       WHERE status IN ('pending', 'parked', 'delivering')
      UNION
      SELECT taken_by AS alias
        FROM harness_shared.harness_features_consolidated
       WHERE taken_by IS NOT NULL
    )
    SELECT DISTINCT alias FROM owners WHERE alias IS NOT NULL AND alias <> ''`;
  return new Set(rows.map((r) => r.alias));
}

export interface IdleSessionReapResult {
  /** False when the flag is off (a no-op). */
  enabled: boolean;
  /** Open adv_sessions considered. */
  scanned: number;
  /** Rows marked ended (or that WOULD be, when dryRun). */
  reaped: number;
  reapedIds: number[];
  /** Owners kept because live/claim/wake-protected. */
  keptLive: number;
  dryRun: boolean;
}

/**
 * The top-level sweep the `system:idle-session-reaper` routine fires. Gathers
 * the protected set + the open sessions from PG, plans, then marks the reapable
 * ghosts ended (unless dryRun). FLAG-GATED DEFAULT-OFF — a no-op when off.
 * Best-effort: a PG failure returns a zero result rather than throwing (it must
 * never wedge the routine engine).
 */
export async function runIdleSessionReap(
  opts: { dryRun?: boolean; graceMs?: number } = {},
): Promise<IdleSessionReapResult> {
  const dryRun = !!opts.dryRun;
  const empty: IdleSessionReapResult = {
    enabled: false,
    scanned: 0,
    reaped: 0,
    reapedIds: [],
    keptLive: 0,
    dryRun,
  };
  const enabled = await getFlag(FLAGS.IDLE_SESSION_REAPER, 'system').catch(() => false);
  if (!enabled) return empty;

  try {
    const { sql } = getOrgPg();
    const protectedOwners = await gatherProtectedSessionOwners(sql, { graceMs: opts.graceMs });
    const open = await sql<Array<{ id: number; coord_owner_id: string | null; started_at: string | Date }>>`
      SELECT id, coord_owner_id, started_at
        FROM harness_shared.adv_sessions
       WHERE ended_at IS NULL`;
    const sessions: ReapableSession[] = open.map((r) => ({
      id: r.id,
      coordOwnerId: r.coord_owner_id,
      startedAtMs: new Date(r.started_at).getTime(),
    }));
    const plan = planIdleSessionReap({
      sessions,
      protectedOwners,
      nowMs: Date.now(),
      graceMs: opts.graceMs,
    });
    if (!dryRun) {
      // markAdvSessionEnded re-checks `ended_at IS NULL`, so a row that ended
      // (or was reaped by a racing sweep) between the read and here is left alone.
      for (const s of plan.reap) await markAdvSessionEnded(s.id, null);
    }
    return {
      enabled: true,
      scanned: sessions.length,
      reaped: plan.reap.length,
      reapedIds: plan.reap.map((s) => s.id),
      keptLive: plan.keptLive.length,
      dryRun,
    };
  } catch (e) {
    console.warn('[idle-session-reaper] sweep failed (non-fatal):', (e as Error)?.message ?? e);
    return { ...empty, enabled: true };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Slice 2 (read-only half): LIVE-but-IDLE detection — the actual D-007
// event-loop-saturation cohort (~52 sessions holding LISTEN conns + polling).
// This half only IDENTIFIES + COUNTS them; safely TERMINATING a live session
// (via the managed-pty control socket / pid) is the flag-gated follow-on.
// ───────────────────────────────────────────────────────────────────────────

/** Default "idle" threshold. A session is idle when it has done no GENUINE
 *  activity for this long — `coord_presence.last_active_at` (mig 277) is bumped
 *  ONLY by real activity, NOT by the per-60s supervisor heartbeat — while its
 *  process is still alive (fresh `heartbeat_at`). 4h: long enough that a human
 *  between tasks isn't flagged, short enough to catch abandoned-but-alive
 *  sessions. */
export const IDLE_ACTIVITY_THRESHOLD_MS = 4 * 60 * 60 * 1000;

export interface LiveIdleCandidate {
  coordOwnerId: string;
  /** Process-aliveness clock (the supervisor beat). */
  heartbeatAtMs: number;
  /** Genuine-activity clock (mig 277); null = never recorded activity. */
  lastActiveAtMs: number | null;
}

/**
 * PURE: a session is LIVE-but-IDLE when its process is alive (heartbeat within
 * `livenessMs`) AND it has done no genuine activity for `idleMs` AND it is NOT
 * busy (holds no claim / has no registered wake / is not a running bee). NOTE the
 * asymmetry vs the dead-ghost reaper: presence-alive is the PRECONDITION here, so
 * the "busy" set must EXCLUDE presence (else every alive session looks protected
 * and nothing is ever idle). A null lastActiveAt = never active → idle. Injected
 * clock so the boundary unit-tests deterministically.
 */
export function classifyLiveIdle(opts: {
  candidates: LiveIdleCandidate[];
  busyOwners: Set<string>;
  nowMs: number;
  livenessMs?: number;
  idleMs?: number;
}): LiveIdleCandidate[] {
  const livenessMs = opts.livenessMs ?? IDLE_SESSION_GRACE_MS;
  const idleMs = opts.idleMs ?? IDLE_ACTIVITY_THRESHOLD_MS;
  return opts.candidates.filter((c) => {
    if (opts.nowMs - c.heartbeatAtMs >= livenessMs) return false; // dead process → dead-ghost reaper's job
    if (opts.busyOwners.has(c.coordOwnerId)) return false; // holds a claim / wake / running bee
    return opts.nowMs - (c.lastActiveAtMs ?? 0) >= idleMs; // no genuine activity for idleMs
  });
}

/**
 * Owners that are BUSY (must never be counted live-idle / terminated): work-item
 * claim holders + running nursery aliases + IN-FLIGHT wake deliveries (a session
 * mid-resume).
 *
 * CRITICAL — does NOT exclude STANDING `event_awaits`: every idle SU session is
 * parked on an always-armed inbox-wake (a standing await), so excluding those
 * made the detector silently always-0 and HID the entire D-007 cohort (verified
 * live: 24 alive-idle sessions → 0). A wake-armed idle session IS the cohort —
 * terminating it is safe BECAUSE the wake-executor `--resume`s it on its next
 * wake (and session-dir-gc keeps its dir for exactly that). Only a wake mid-
 * DELIVERY (event_wake_deliveries) must be spared. Also EXCLUDES coord_presence
 * (a fresh heartbeat is the live-idle precondition, not a protection). One read.
 */
export async function gatherBusyOwners(
  sql: Awaited<ReturnType<typeof getOrgPg>>['sql'],
  opts: { graceMs?: number } = {},
): Promise<Set<string>> {
  const graceSec = Math.max(1, Math.round((opts.graceMs ?? IDLE_SESSION_GRACE_MS) / 1000));
  const rows = await sql<Array<{ alias: string }>>`
    WITH busy AS (
      SELECT taken_by AS alias
        FROM harness_shared.harness_features_consolidated
       WHERE taken_by IS NOT NULL
      UNION
      -- in-flight wake delivery only (mid-resume) — NOT standing event_awaits.
      SELECT subscriber_id AS alias
        FROM harness_shared.event_wake_deliveries
       WHERE status IN ('pending', 'parked', 'delivering')
      UNION
      SELECT a.alias
        FROM harness_shared.spawned_agents n
        CROSS JOIN LATERAL (VALUES (n.spawn_id), (n.session_owner), (n.run_id)) AS a(alias)
       WHERE n.status IN ('running', 'restarting')
         AND n.heartbeat_at IS NOT NULL
         AND (now() - n.heartbeat_at) < make_interval(secs => ${graceSec})
    )
    SELECT DISTINCT alias FROM busy WHERE alias IS NOT NULL AND alias <> ''`;
  return new Set(rows.map((r) => r.alias));
}

export interface IdleLiveSession {
  advSessionId: number;
  coordOwnerId: string;
  idleMs: number;
}

/**
 * READ-ONLY: the live-but-idle sessions right now — the D-007 saturation cohort.
 * Joins fresh-heartbeat presence rows (process alive) to their OPEN adv_sessions,
 * keeps those with stale `last_active_at` and a non-busy owner. Surfaced as a
 * metric + the future termination target list; this slice TERMINATES nothing.
 */
export async function findIdleLiveSessions(
  opts: { livenessMs?: number; idleMs?: number } = {},
): Promise<IdleLiveSession[]> {
  try {
    const { sql } = getOrgPg();
    const busyOwners = await gatherBusyOwners(sql, { graceMs: opts.livenessMs });
    const rows = await sql<
      Array<{ id: number; coord_owner_id: string; heartbeat_at: string | Date; last_active_at: string | Date | null }>
    >`
      SELECT s.id, p.owner_id AS coord_owner_id, p.heartbeat_at, p.last_active_at
        FROM harness_shared.coord_presence p
        JOIN harness_shared.adv_sessions s ON s.coord_owner_id = p.owner_id AND s.ended_at IS NULL
       WHERE p.heartbeat_at IS NOT NULL`;
    const nowMs = Date.now();
    const candidates: Array<LiveIdleCandidate & { advSessionId: number }> = rows.map((r) => ({
      advSessionId: r.id,
      coordOwnerId: r.coord_owner_id,
      heartbeatAtMs: new Date(r.heartbeat_at).getTime(),
      lastActiveAtMs: r.last_active_at ? new Date(r.last_active_at).getTime() : null,
    }));
    const idle = classifyLiveIdle({ candidates, busyOwners, nowMs, livenessMs: opts.livenessMs, idleMs: opts.idleMs });
    const idleKeys = new Set(idle.map((c) => c.coordOwnerId));
    return candidates
      .filter((c) => idleKeys.has(c.coordOwnerId))
      .map((c) => ({
        advSessionId: c.advSessionId,
        coordOwnerId: c.coordOwnerId,
        idleMs: nowMs - (c.lastActiveAtMs ?? 0),
      }));
  } catch (e) {
    console.warn('[idle-session-reaper] findIdleLiveSessions failed (non-fatal):', (e as Error)?.message ?? e);
    return [];
  }
}
