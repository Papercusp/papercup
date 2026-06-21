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

import { readdir, readFile } from 'node:fs/promises';
import { STALE_MS } from './liveness';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { getOrgPg } from '@papercusp/db-org';
import { markAdvSessionEnded } from './adv-sessions';
import { interruptViaPty, findLiveHost } from './events/await/psu-pty-discovery';

/** Liveness/grace window. Matches work-items-stale-claims STALE_CLAIM_GRACE_MS
 *  and the fleet_assignment view (10 min): a live psu session's supervisor beat
 *  (every 60s) refreshes presence well inside it, so a briefly-quiet but alive
 *  session is never reaped. Also the floor on `started_at` so a just-launched
 *  session (presence not yet written in its first seconds) is never reaped. */
export const IDLE_SESSION_GRACE_MS = STALE_MS;

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

// ───────────────────────────────────────────────────────────────────────────
// Slice 2 (WRITE half): live-but-idle session TERMINATION — the actual D-007
// event-loop-saturation fix. DOUBLE-GATED + busy-excluding + best-effort.
// ───────────────────────────────────────────────────────────────────────────

/** How long to wait after the graceful Ctrl-C before escalating to SIGKILL. A
 *  Ctrl-C ends the current turn; a healthy psu host then idles (we still kill it
 *  — the goal is to free its operator/LISTEN/MCP footprint, not just end a turn),
 *  but the brief pause lets a co-operating host exit cleanly first so the SIGKILL
 *  is the exception, not the rule. */
export const TERMINATE_GRACE_MS = 3000;

export interface IdleLiveTerminateResult {
  /** False when EITHER flag is off (a no-op). */
  enabled: boolean;
  /** Genuinely-idle live sessions the sweep tried to terminate. */
  targeted: number;
  /** Sessions marked ended (or that WOULD be, when dryRun). */
  terminated: number;
  terminatedIds: number[];
  /** Sessions whose termination threw / failed (counted, never fatal). */
  failed: number;
  dryRun: boolean;
}

/** Injectable side-effects so the sweep unit-tests without real PG / pty / pids
 *  (mirrors turn/interrupt.ts deps + the slice-1 pure-function seam). Production
 *  defaults wire the live psu-pty + adv_sessions helpers. */
export interface TerminateDeps {
  /** Flag read; defaults to the real getFlag. */
  isFlagOn: (flag: (typeof FLAGS)[keyof typeof FLAGS]) => Promise<boolean>;
  /** The live-but-idle target list; defaults to findIdleLiveSessions. */
  listIdle: (opts: { livenessMs?: number; idleMs?: number }) => Promise<IdleLiveSession[]>;
  /** Graceful Ctrl-C into the owner's live psu-pty host; true on a clean write. */
  gracefulInterrupt: (ownerId: string) => Promise<boolean>;
  /** Resolve the owner's live host pid (for the SIGKILL escalation), or null. */
  resolvePid: (ownerId: string) => number | null;
  /** True iff the pid is still alive. */
  pidAlive: (pid: number) => boolean;
  /** Hard-kill the pid; true on success. */
  sigkill: (pid: number) => boolean;
  /** Mark the adv_session row ended in PG. */
  markEnded: (advSessionId: number) => Promise<void>;
  /** Pause between the Ctrl-C and the liveness re-check. */
  wait: (ms: number) => Promise<void>;
}

function defaultPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = alive but not ours to signal; ESRCH = gone.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

const defaultTerminateDeps: TerminateDeps = {
  isFlagOn: (flag) => getFlag(flag, 'system').catch(() => false),
  listIdle: (opts) => findIdleLiveSessions(opts),
  gracefulInterrupt: (ownerId) => interruptViaPty(ownerId, 'sigint').catch(() => false),
  resolvePid: (ownerId) => findLiveHost(ownerId)?.pid ?? null,
  pidAlive: defaultPidAlive,
  sigkill: (pid) => {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  },
  markEnded: (advSessionId) => markAdvSessionEnded(advSessionId, null),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * The WRITE half: terminate every genuinely LIVE-but-IDLE session (the D-007
 * cohort that actually saturates the :3070 event loop). For each target:
 *   1. send a graceful Ctrl-C over its managed-pty control socket (ends its turn),
 *   2. wait TERMINATE_GRACE_MS, and if its host pid is STILL alive, SIGKILL it,
 *   3. mark its adv_session row ended in PG (frees session-dir-gc + the roster).
 *
 * DOUBLE-GATED DEFAULT-OFF: a pure no-op unless BOTH IDLE_SESSION_REAPER (the
 * slice-1 master switch) AND IDLE_SESSION_REAPER_TERMINATE (this destructive
 * write half) are on. The target list (findIdleLiveSessions) ALREADY excludes
 * busy owners via gatherBusyOwners (claim holders / in-flight wakes / running
 * bees) and dead-process sessions — so this never touches a session holding a
 * claim, mid-resume, or a fresh-but-quiet human. dryRun = plan + log, no kills /
 * no PG writes. Best-effort: a per-session failure is counted (`failed`) and the
 * sweep continues; the whole sweep never throws (it must not wedge the routine).
 */
export async function terminateIdleLiveSessions(
  opts: { dryRun?: boolean; livenessMs?: number; idleMs?: number; deps?: Partial<TerminateDeps> } = {},
): Promise<IdleLiveTerminateResult> {
  const dryRun = !!opts.dryRun;
  const deps: TerminateDeps = { ...defaultTerminateDeps, ...opts.deps };
  const empty: IdleLiveTerminateResult = {
    enabled: false,
    targeted: 0,
    terminated: 0,
    terminatedIds: [],
    failed: 0,
    dryRun,
  };

  // Double-gate: both the master switch AND the destructive-write flag.
  const [master, terminate] = await Promise.all([
    deps.isFlagOn(FLAGS.IDLE_SESSION_REAPER).catch(() => false),
    deps.isFlagOn(FLAGS.IDLE_SESSION_REAPER_TERMINATE).catch(() => false),
  ]);
  if (!master || !terminate) return empty;

  let targets: IdleLiveSession[] = [];
  try {
    // findIdleLiveSessions already excludes busy owners + dead processes.
    targets = await deps.listIdle({ livenessMs: opts.livenessMs, idleMs: opts.idleMs });
  } catch (e) {
    console.warn('[idle-session-reaper] terminate: target gather failed (non-fatal):', (e as Error)?.message ?? e);
    return { ...empty, enabled: true };
  }

  const result: IdleLiveTerminateResult = { ...empty, enabled: true, targeted: targets.length };

  for (const t of targets) {
    try {
      if (dryRun) {
        // Plan only — no Ctrl-C, no kill, no PG write.
        result.terminated += 1;
        result.terminatedIds.push(t.advSessionId);
        continue;
      }
      // 1. graceful Ctrl-C over the managed-pty control socket (ends the turn).
      await deps.gracefulInterrupt(t.coordOwnerId);
      // 2. give it a moment to exit, then SIGKILL the host pid if still alive.
      await deps.wait(TERMINATE_GRACE_MS);
      const pid = deps.resolvePid(t.coordOwnerId);
      if (pid != null && deps.pidAlive(pid)) deps.sigkill(pid);
      // 3. mark the row ended (re-checks ended_at IS NULL inside markAdvSessionEnded).
      await deps.markEnded(t.advSessionId);
      result.terminated += 1;
      result.terminatedIds.push(t.advSessionId);
    } catch (e) {
      // Per-session isolation: count + continue, never break the sweep.
      result.failed += 1;
      console.warn(
        `[idle-session-reaper] terminate failed for session ${t.advSessionId} (owner ${t.coordOwnerId}), non-fatal:`,
        (e as Error)?.message ?? e,
      );
    }
  }

  return result;
}

// ───────────────────────────────────────────────────────────────────────────
// Slice 3: ZOMBIE-PROC reap — a `claude --resume <uuid>` OS process whose
// adv_session is ENDED (exit recorded) but the process never exited (EI-1873).
//
// The dominant fleet session-leak: 32 such zombies (sessions ended 16–18h prior,
// exit_code=0) accumulated PAST the bg-host wedge point, each holding LISTEN conns
// + polling on the :3070 event loop. No DB-roster reaper saw them — they are
// CLOSED in the DB (ended_at set) yet ALIVE as OS procs, so slices 1/2 (which scan
// OPEN sessions) reap 0 (verified live: a non-starved reaper run still reaped 0).
// The signal here is DETERMINISTIC + zero-heuristic: ended session + live proc =
// zombie. It is STARVATION-INDEPENDENT — it does NOT rely on the per-60s
// supervisor heartbeat that the very overload starves (the feedback loop that
// defeated the presence-based slices). DOUBLE-GATED like slice 2 (a process kill);
// best-effort; Linux /proc enumeration (a no-op where /proc is absent).
// ───────────────────────────────────────────────────────────────────────────

/** A live `claude --resume <uuid>` OS process. */
export interface ResumeProc {
  pid: number;
  sessionId: string;
}

/** PURE: the resume-procs whose session is ENDED → the zombies to kill. The
 *  ended-set is injected so the keep/kill boundary unit-tests without OS/PG. */
export function planZombieReap(procs: ResumeProc[], endedSessionIds: ReadonlySet<string>): ResumeProc[] {
  return procs.filter((p) => endedSessionIds.has(p.sessionId));
}

const RESUME_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Discover live `claude --resume <uuid>` procs via /proc (Linux). Best-effort: a
 * non-Linux host (no /proc) or a per-pid read error yields [] (the slice no-ops).
 * A proc qualifies only when its cmdline references `claude` AND carries
 * `--resume <uuid>` — so a node/tsx wrapper around the CLI still matches.
 */
export async function discoverResumeProcs(): Promise<ResumeProc[]> {
  const out: ResumeProc[] = [];
  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    return out; // not Linux / no /proc → no-op
  }
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue;
    let raw = '';
    try {
      raw = await readFile(`/proc/${ent}/cmdline`, 'utf8');
    } catch {
      continue; // proc vanished / unreadable
    }
    if (!raw || !raw.includes('claude')) continue;
    const args = raw.split('\0').filter(Boolean);
    const i = args.indexOf('--resume');
    if (i >= 0 && args[i + 1] && RESUME_UUID_RE.test(args[i + 1])) {
      const pid = Number(ent);
      // Defense-in-depth: a FOREGROUND/TTY-attached proc is a live interactive
      // session (a human), never a backgrounded leaked agent zombie — never a
      // reap candidate, regardless of its adv_session rows.
      if (await isForegroundTty(pid)) continue;
      out.push({ pid, sessionId: args[i + 1] });
    }
  }
  return out;
}

export interface ZombieReapResult {
  /** False when EITHER flag is off (a no-op). */
  enabled: boolean;
  /** Live `claude --resume` procs discovered. */
  scannedProcs: number;
  /** Procs whose session is ended (zombies). */
  zombies: number;
  /** Pids signalled (or that WOULD be, when dryRun). */
  killedPids: number[];
  dryRun: boolean;
}

/** Injectable side-effects so the sweep unit-tests without OS/PG (mirrors the
 *  slice-2 TerminateDeps seam). */
export interface ZombieReapDeps {
  isFlagOn: (flag: (typeof FLAGS)[keyof typeof FLAGS]) => Promise<boolean>;
  listResumeProcs: () => Promise<ResumeProc[]>;
  /** The subset of `sessionIds` whose adv_session is ENDED (ended_at NOT NULL). */
  endedSessionIds: (sessionIds: string[]) => Promise<Set<string>>;
  sigterm: (pid: number) => boolean;
  pidAlive: (pid: number) => boolean;
  sigkill: (pid: number) => boolean;
  /** PID-recycle guard: true iff pid's cmdline still carries `--resume <sessionId>`. */
  stillTheProc: (pid: number, sessionId: string) => Promise<boolean>;
  /** Pause between SIGTERM and the SIGKILL re-check. */
  wait: (ms: number) => Promise<void>;
}

async function defaultEndedSessionIds(sessionIds: string[]): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const { sql } = getOrgPg();
  // A uuid is a zombie ONLY when EVERY adv_session row for it is ended — i.e. it
  // has NO open row. CRITICAL (the collateral that killed the operator's live
  // session): a LIVE resumed session REUSES its session_id, so an OLD ended row can
  // coexist with the CURRENT OPEN row for the same uuid. The earlier `AND ended_at
  // IS NOT NULL` matched the old ended row and killed the live session in a
  // kill→--resume→kill loop. `HAVING` no open row makes the live (open) row veto.
  const rows = await sql<Array<{ session_id: string }>>`
    SELECT session_id
      FROM harness_shared.adv_sessions
     WHERE session_id = ANY(${sessionIds})
     GROUP BY session_id
    HAVING COUNT(*) FILTER (WHERE ended_at IS NULL) = 0`;
  return new Set(rows.map((r) => r.session_id));
}

/**
 * True iff `pid` is a FOREGROUND, TTY-attached process (ps `+`) — a live
 * interactive session (e.g. a human at a terminal), NEVER a backgrounded leaked
 * agent proc. Defense-in-depth atop the all-ended query: even a stale-stamped row
 * can't make us kill a live foreground session. Reads `/proc/<pid>/stat`: comm
 * (field 2) is parenthesised + may contain spaces, so we slice after the LAST ')';
 * the remaining 0-indexed fields are 0=state 1=ppid 2=pgrp 3=session 4=tty_nr
 * 5=tpgid. Foreground ⇔ a controlling tty (tty_nr≠0) AND this pgrp owns it
 * (pgrp===tpgid). Best-effort: a read/parse failure → false (never over-spare).
 */
/** PURE: parse a /proc/<pid>/stat line → is the process FOREGROUND + TTY-attached?
 *  Exported so the field-offset + comm-with-parens parsing (the error-prone bit
 *  that the EI-1873 collateral turned on) is unit-covered without /proc. */
export function parseForegroundFromStat(stat: string): boolean {
  const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  const pgrp = Number(after[2]);
  const ttyNr = Number(after[4]);
  const tpgid = Number(after[5]);
  return Number.isFinite(ttyNr) && ttyNr !== 0 && Number.isFinite(pgrp) && Number.isFinite(tpgid) && pgrp === tpgid;
}

async function isForegroundTty(pid: number): Promise<boolean> {
  try {
    return parseForegroundFromStat(await readFile(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false; // gone/unreadable → never over-spare
  }
}

async function defaultStillTheProc(pid: number, sessionId: string): Promise<boolean> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    return raw.includes('--resume') && raw.includes(sessionId);
  } catch {
    return false; // gone → never signal a recycled pid
  }
}

const defaultZombieDeps: ZombieReapDeps = {
  isFlagOn: (flag) => getFlag(flag, 'system').catch(() => false),
  listResumeProcs: () => discoverResumeProcs(),
  endedSessionIds: (ids) => defaultEndedSessionIds(ids),
  sigterm: (pid) => {
    try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
  },
  pidAlive: defaultPidAlive,
  sigkill: (pid) => {
    try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
  },
  stillTheProc: (pid, sessionId) => defaultStillTheProc(pid, sessionId),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Slice 3: reap ZOMBIE `claude --resume` procs — sessions already ENDED whose OS
 * process never exited (EI-1873). Discovers the live resume-procs, asks PG which
 * of their sessions are ended, and SIGTERM→(wait)→SIGKILLs the zombies. Re-verifies
 * each pid's cmdline immediately before EACH signal (PID-recycle guard). The
 * adv_session is already ended, so no PG write is needed. DOUBLE-GATED DEFAULT-OFF
 * (both IDLE_SESSION_REAPER + IDLE_SESSION_REAPER_TERMINATE); dryRun plans only;
 * best-effort — a per-proc failure is isolated and the sweep never throws.
 */
export async function reapZombieResumeProcs(
  opts: { dryRun?: boolean; deps?: Partial<ZombieReapDeps> } = {},
): Promise<ZombieReapResult> {
  const dryRun = !!opts.dryRun;
  const deps: ZombieReapDeps = { ...defaultZombieDeps, ...opts.deps };
  const empty: ZombieReapResult = { enabled: false, scannedProcs: 0, zombies: 0, killedPids: [], dryRun };

  const [master, terminate] = await Promise.all([
    deps.isFlagOn(FLAGS.IDLE_SESSION_REAPER).catch(() => false),
    deps.isFlagOn(FLAGS.IDLE_SESSION_REAPER_TERMINATE).catch(() => false),
  ]);
  if (!master || !terminate) return empty;

  let procs: ResumeProc[] = [];
  try {
    procs = await deps.listResumeProcs();
  } catch {
    return { ...empty, enabled: true };
  }
  let ended: Set<string>;
  try {
    ended = await deps.endedSessionIds([...new Set(procs.map((p) => p.sessionId))]);
  } catch {
    return { ...empty, enabled: true, scannedProcs: procs.length };
  }
  const zombies = planZombieReap(procs, ended);
  const result: ZombieReapResult = {
    enabled: true,
    scannedProcs: procs.length,
    zombies: zombies.length,
    killedPids: [],
    dryRun,
  };

  for (const z of zombies) {
    try {
      if (dryRun) {
        result.killedPids.push(z.pid);
        continue;
      }
      if (!(await deps.stillTheProc(z.pid, z.sessionId))) continue; // recycle guard (pre-SIGTERM)
      deps.sigterm(z.pid);
      await deps.wait(TERMINATE_GRACE_MS);
      // SIGKILL survivors — re-verify the cmdline again so a pid recycled during
      // the grace pause into an unrelated process is never signalled.
      if (deps.pidAlive(z.pid) && (await deps.stillTheProc(z.pid, z.sessionId))) deps.sigkill(z.pid);
      result.killedPids.push(z.pid);
    } catch {
      // per-proc isolation — never break the sweep.
    }
  }
  return result;
}
