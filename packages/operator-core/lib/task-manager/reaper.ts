/**
 * task-manager/reaper — the ENFORCEMENT half the reconciler never had
 * (WI-41607, plan agent-session-scope-reaper-2026-08-25).
 *
 * D-010 of task-manager-no-escape-2026-07-27 made the reconciler REPORT-ONLY
 * while residue classification matured. That decision is now superseded by an
 * explicit owner directive, given twice: 2026-08-23 "If we launch an agent
 * session and end it there should be no process residue", and 2026-08-25
 * "investigate the issue and fix it once and for all" — after the third
 * accumulation incident (2026-08-25: 62 residue scopes / ~409 processes, on
 * top of a 5-day-old fleet that was never stood down). Detection without
 * enforcement measurably does not hold this box: every prior fix improved a
 * census and the residue regrew.
 *
 * TWO reap classes, both narrowly discriminated, both AGENT-SESSION-ONLY:
 *
 *   terminal-residue  — the task's ledger row is TERMINAL (exited/killed/…)
 *                       but its scope cgroup still holds processes past a
 *                       grace window. The session is over by its own record;
 *                       whatever survives is leftovers (MCP servers, bash
 *                       wrapper chains, codex children). This is the
 *                       "start and stop a session, processes remain" defect.
 *
 *   quiet-zombie      — the row is RUNNING but its log has not been written
 *                       for >= quietMs (default 6h, the census's validated
 *                       window) AND no fresh coord-presence heartbeat vouches
 *                       for its owner. These are sessions that will never take
 *                       another turn: forks/consult-revivals that never got
 *                       their question, fleet members whose fleet drained days
 *                       ago, booted-but-never-woken launches (WI-41044 class).
 *
 * WHAT IS DELIBERATELY NOT A SIGNAL: CPU. The 2026-08-25 autopsy measured the
 * codex CLI idle-spinning at a constant ~8% CPU in scopes whose logs had been
 * silent for 9–35 hours (EI-21417256075155406) — "CPU-active" is NOT evidence
 * of progress here, and a CPU gate would have spared 53 of 58 confirmed
 * zombies. Log mtime + presence are the instruments that survived
 * falsification (see agent-session-progress-census.ts's header for the three
 * instruments that did not).
 *
 * SAFETY RAILS, in order:
 *   - agent-session class only — no other task class is ever touched, so a
 *     payload that legitimately daemonizes (release cut, service launcher)
 *     cannot be collateral.
 *   - `isAutoReapExempt` rows are never reaped (terminal-psu-session-enrolment
 *     2026-08-24 D-001, owner ruling: enrolled terminal sessions opt out of
 *     AUTOMATED reaping; explicit kills still work).
 *   - a DEGRADED progress census (unreadable > measurable) disables the
 *     quiet-zombie class entirely for that tick — an unmeasurable census must
 *     never authorize a kill.
 *   - fresh presence heartbeat (when the owner is mapped) spares the row even
 *     when the log is quiet.
 *   - per-tick cap: a pathological tick reaps a bounded number of scopes and
 *     leaves the rest for the next tick, so a wrong discriminator can never
 *     take out a whole population before someone notices.
 *   - every reap archives the session's log tail FIRST (the 2026-08-23 hand
 *     reap's own protocol), and every decision — reaped or spared — is
 *     reported, so the audit trail exists before the process dies.
 *
 * The decision function is PURE (rows + census + sets in, verdicts out) so the
 * falsifiability tests can drive it with deliberately-wrong controls; all IO
 * (cgroup reads, systemctl, tail archiving, ledger closes) is injected.
 */

import { isAutoReapExempt, isTerminalState, type TaskRow } from './types';
import type { AgentSessionProgressCensus } from './agent-session-progress-census';

/** A terminal row's scope gets this long after `ended_at` before its survivors
 *  are considered leftovers. Long enough for any legitimate teardown; short
 *  enough that "stop a session" visibly clears the box. */
export const REAP_TERMINAL_GRACE_MS = 10 * 60_000;

/** Terminal-residue guard against the CARRY-RESPAWN edge: respawns re-enter the
 *  SAME scope (measured 2026-08-25 — two process generations in one scope), so a
 *  terminal row's scope can briefly hold a LIVE successor. A live session writes
 *  its log; leftovers do not. A terminal row whose log was written more recently
 *  than this is therefore spared as an anomaly, never reaped. */
export const REAP_TERMINAL_LOG_QUIET_MS = 30 * 60_000;

/** Bounded blast radius per tick. 12 covers the measured steady-state churn
 *  (5 stranded scopes on 2026-08-25) with headroom, while a false discriminator
 *  would need many ticks — each broadcasting its decisions — to do real damage. */
export const REAP_MAX_PER_TICK = 12;

/** Presence heartbeat younger than this vouches for a quiet session's owner. */
export const REAP_PRESENCE_FRESH_MS = 15 * 60_000;

export type ReapKind = 'terminal-residue' | 'quiet-zombie';

export interface ReapDecision {
  taskId: string;
  scopeUnit: string;
  logPath: string | null;
  kind: ReapKind;
  why: string;
}

export interface SpareDecision {
  taskId: string;
  why: string;
}

export interface ReaperInputs {
  /** Ledger rows to consider — the caller passes live AND recently-terminal rows. */
  rows: readonly TaskRow[];
  /** Progress census over the LIVE agent-session rows (log-mtime instrument). */
  census: AgentSessionProgressCensus;
  /** Live pid count for a row's scope cgroup; null = cgroup gone / unreadable
   *  (unreadable must never read as "has processes"). */
  scopePidCount: (row: TaskRow) => number | null;
  /** coord_presence owner_ids with a heartbeat fresher than REAP_PRESENCE_FRESH_MS. */
  freshOwners: ReadonlySet<string>;
  /** ms since the row's log was last written; null = unmeasurable. Consulted for
   *  TERMINAL rows only (live rows are judged by the census) — the carry-respawn
   *  guard above. */
  logQuietForMs: (row: TaskRow) => number | null;
  now: number;
  maxPerTick?: number;
}

export interface ReaperVerdict {
  reap: ReapDecision[];
  spared: SpareDecision[];
  /** True when the quiet-zombie class was skipped because the census degraded. */
  quietClassDisabled: boolean;
  /** Candidates beyond the per-tick cap — next tick's work, reported not lost. */
  deferred: number;
}

/** The owner id a ledger row maps to, when the spawner recorded one. */
export function rowOwnerId(row: Pick<TaskRow, 'detail'>): string | null {
  const d = row.detail ?? {};
  const v = d.ownerId ?? d.coordOwnerId ?? d.owner;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function decideReaps(inputs: ReaperInputs): ReaperVerdict {
  const cap = inputs.maxPerTick ?? REAP_MAX_PER_TICK;
  const reap: ReapDecision[] = [];
  const spared: SpareDecision[] = [];

  const quietByTask = new Map(inputs.census.quietRows.map((r) => [r.taskId, r]));
  const quietClassDisabled = inputs.census.degraded;

  for (const row of inputs.rows) {
    if (row.class !== 'agent-session') continue;
    if (!row.scopeUnit) continue;
    // An UNCONFINED spawn (scope-launch fallback to direct) records its
    // SPAWNER's cgroup in cgroup_path — e.g. papercup-dev-api.service, the
    // operator itself (measured live 2026-08-25: the first deployed pass chose
    // 12 such rows, counted the operator's own pids as "survivors", and failed
    // 0/12 stopping scopes that never existed). A row is only reap-addressable
    // when its cgroup path's LEAF is its own scope unit.
    if (!row.cgroupPath || !row.cgroupPath.endsWith(`/${row.scopeUnit}`)) continue;
    if (isAutoReapExempt(row)) {
      spared.push({ taskId: row.taskId, why: 'autoReapExempt (D-001 terminal-psu-session-enrolment)' });
      continue;
    }

    const terminal = isTerminalState(row.state) || row.endedAt != null;
    if (terminal) {
      const endedMs = row.endedAt ? Date.parse(row.endedAt) : NaN;
      if (!Number.isFinite(endedMs)) continue; // no trustworthy end time — not this pass's call
      if (inputs.now - endedMs < REAP_TERMINAL_GRACE_MS) continue; // within grace
      const pids = inputs.scopePidCount(row);
      if (pids === null) continue; // unreadable is not "has processes"
      if (pids <= 0) continue; // nothing survives — systemd will collect the empty scope
      const logQuiet = inputs.logQuietForMs(row);
      if (logQuiet !== null && logQuiet < REAP_TERMINAL_LOG_QUIET_MS) {
        // Terminal row, live log: a successor generation (carry-respawn) is in
        // this scope. Never reap it — surface the anomaly instead.
        spared.push({
          taskId: row.taskId,
          why: `ANOMALY: row ${row.state} but log written ${Math.round(logQuiet / 60_000)}min ago — live successor in scope, investigate`,
        });
        continue;
      }
      reap.push({
        taskId: row.taskId,
        scopeUnit: row.scopeUnit,
        logPath: row.logPath ?? null,
        kind: 'terminal-residue',
        why: `row ${row.state} ${Math.round((inputs.now - endedMs) / 60_000)}min ago, ${pids} process(es) survive`,
      });
      continue;
    }

    // Live row — quiet-zombie class.
    const quietRow = quietByTask.get(row.taskId);
    if (!quietRow) continue; // active / too-young / no-log / unreadable — never residue
    if (quietClassDisabled) {
      spared.push({ taskId: row.taskId, why: 'census degraded — quiet class disabled this tick' });
      continue;
    }
    const owner = rowOwnerId(row);
    if (owner && inputs.freshOwners.has(owner)) {
      spared.push({ taskId: row.taskId, why: `log quiet ${quietRow.quietMinutes}min but presence heartbeat fresh (${owner})` });
      continue;
    }
    const pids = inputs.scopePidCount(row);
    if (pids === null || pids <= 0) continue;
    reap.push({
      taskId: row.taskId,
      scopeUnit: row.scopeUnit,
      logPath: row.logPath ?? null,
      kind: 'quiet-zombie',
      why: `log quiet ${quietRow.quietMinutes}min, owner ${owner ? 'presence-stale' : 'unmapped'}, ${pids} process(es)`,
    });
  }

  // Longest-standing residue first, bounded per tick.
  reap.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'terminal-residue' ? -1 : 1));
  const deferred = Math.max(0, reap.length - cap);
  return { reap: reap.slice(0, cap), spared, quietClassDisabled, deferred };
}

// ── execution (all IO injected) ─────────────────────────────────────────────

export interface ReapEffects {
  /** Preserve the session's log tail BEFORE the kill. Must never throw. */
  archiveTail(decision: ReapDecision): Promise<string | null>;
  /** `systemctl --user stop <scopeUnit>` — the addressable subtree kill. */
  stopUnit(scopeUnit: string): Promise<boolean>;
  /** Close a still-running row as stranded with the reap reason. Idempotent. */
  closeAsReaped(taskId: string, why: string): Promise<void>;
}

export interface ReapOutcome {
  taskId: string;
  scopeUnit: string;
  kind: ReapKind;
  ok: boolean;
  archived: string | null;
  note?: string;
}

// ── the recurrence guard (P-006) ────────────────────────────────────────────
//
// Enforcement that silently stops working is the failure this whole work-item
// exists to end: every prior fix improved a census, nothing watched the fix, and
// the residue regrew. So the reaper measures ITSELF.
//
// The measured quantity is the residue that SURVIVED a pass. Its healthy value
// is ZERO — a working pass leaves nothing behind — which is what makes it a
// usable floor. A busy host does not raise it; only a reaper that cannot clear
// what it selected does.
//
// THE ALARM CONDITION IS "SUSTAINED NON-ZERO", NOT "GROWING" — and that choice
// is load-bearing, so here is the reasoning rather than the conclusion.
//
// The obvious detector to reach for is the dead-window census's
// `evaluateResidueTrend`: compare a recent floor against an earlier floor and
// alarm when it climbs. Checked against the REAL incident, it fails. On
// 2026-08-25 the first deployed pass failed 0/12 every five minutes for an hour:
// the survivor count sat at a FLAT 12, so recent floor 12, earlier floor 12,
// growth delta ZERO. A growth detector would have watched that entire hour in
// silence and reported steady.
//
// A growth term is also formally REDUNDANT here, which is why none is offered.
// `recentFloor > olderFloor >= 0` implies every recent sample is >= 1, which
// implies the last N samples are all non-zero — so `stuck` has already fired.
// Growth is only meaningful for a metric whose healthy value is non-zero (the
// dead-window census, where scopes legitimately exist and churn). THIS metric's
// healthy value is ZERO, so "still non-zero N passes later" already IS the
// accumulation signal. Adding a growth branch would be unreachable code carrying
// a test that could never fail — the exact shape of a detector that reassures
// without detecting.
//
// The alarm is an ESCALATION, not a message: the report-only era proved that a
// `message` about accumulating residue reads as weather and is actioned by no one.

/** Consecutive residue-leaving passes before the alarm fires. Three, per P-006. */
export const REAPER_FLOOR_MIN_CONSECUTIVE = 3;

export interface ReaperFloorSample {
  atMs: number;
  /** Residue that survived that pass. Named to match the persisted ring's shape. */
  scopesDead: number;
}

export interface ReaperFloorVerdict {
  alarm: boolean;
  kind: 'stuck' | 'growing' | null;
  consecutiveNonZero: number;
  recentFloor: number | null;
  olderFloor: number | null;
  summary: string;
}

/**
 * PURE: how much residue survived one pass.
 *
 * Deferred candidates (beyond the per-tick cap) plus attempted-but-failed stops.
 * A spared row is deliberately NOT counted: sparing is the rails working as
 * designed (exempt session, live successor in scope, degraded census), and
 * counting it would make correct caution indistinguishable from failure.
 */
export function residualAfterPass(
  verdict: Pick<ReaperVerdict, 'deferred'>,
  outcomes: readonly ReapOutcome[],
): number {
  const failed = outcomes.filter((o) => !o.ok).length;
  return verdict.deferred + failed;
}

/**
 * PURE: is the reaper failing to clear what it selects?
 *
 * Thin history answers `alarm:false` WITH a summary that says so — never a
 * reassuring "healthy". Same rule the dead-window trend follows: a detector that
 * cannot tell must say it cannot tell, or a storage failure launders as green.
 */
export function evaluateReaperFloor(
  samples: readonly ReaperFloorSample[],
  opts: {
    nowMs: number;
    minConsecutive?: number;
    recentWindowMs?: number;
    lookbackMs?: number;
  },
): ReaperFloorVerdict {
  const minConsecutive = opts.minConsecutive ?? REAPER_FLOOR_MIN_CONSECUTIVE;
  const recentWindowMs = opts.recentWindowMs ?? REAPER_FLOOR_RECENT_WINDOW_MS;
  const lookbackMs = opts.lookbackMs ?? REAPER_FLOOR_LOOKBACK_MS;

  const ordered = [...samples].sort((a, b) => a.atMs - b.atMs);

  // `stuck`: every one of the last N passes left something behind. Counted over
  // the tail regardless of wall-clock window — N consecutive failures matter
  // whatever the cadence.
  const tail = ordered.slice(-minConsecutive);
  let consecutiveNonZero = 0;
  for (let i = ordered.length - 1; i >= 0 && ordered[i]!.scopesDead > 0; i--) consecutiveNonZero++;
  const stuck = tail.length >= minConsecutive && tail.every((s) => s.scopesDead > 0);

  const recentFrom = opts.nowMs - recentWindowMs;
  const olderFrom = opts.nowMs - lookbackMs;
  const recent: number[] = [];
  const older: number[] = [];
  for (const s of ordered) {
    if (s.atMs >= recentFrom) recent.push(s.scopesDead);
    else if (s.atMs >= olderFrom) older.push(s.scopesDead);
  }
  const recentFloor = recent.length ? Math.min(...recent) : null;
  const olderFloor = older.length ? Math.min(...older) : null;
  const growing =
    recent.length >= minConsecutive &&
    older.length >= minConsecutive &&
    recentFloor !== null &&
    olderFloor !== null &&
    recentFloor > olderFloor;

  if (stuck) {
    return {
      alarm: true,
      kind: 'stuck',
      consecutiveNonZero,
      recentFloor,
      olderFloor,
      summary:
        `agent-session reaper has left residue behind on ${consecutiveNonZero} consecutive ` +
        `pass(es) (last ${tail.length} all non-zero: ${tail.map((s) => s.scopesDead).join(',')}) — ` +
        `enforcement is selecting scopes it cannot clear`,
    };
  }
  if (growing) {
    return {
      alarm: true,
      kind: 'growing',
      consecutiveNonZero,
      recentFloor,
      olderFloor,
      summary:
        `agent-session residue floor is CLIMBING (recent ${recentFloor} vs earlier ${olderFloor}) — ` +
        `scopes are arriving faster than the reaper clears them`,
    };
  }
  if (ordered.length < minConsecutive) {
    return {
      alarm: false,
      kind: null,
      consecutiveNonZero,
      recentFloor,
      olderFloor,
      summary: `only ${ordered.length} sample(s) — no verdict yet, which is not the same as healthy`,
    };
  }
  return {
    alarm: false,
    kind: null,
    consecutiveNonZero,
    recentFloor,
    olderFloor,
    summary: `reaper floor clear (last ${tail.length} pass(es) left ${tail.map((s) => s.scopesDead).join(',')})`,
  };
}

export async function executeReaps(
  decisions: readonly ReapDecision[],
  effects: ReapEffects,
): Promise<ReapOutcome[]> {
  const out: ReapOutcome[] = [];
  for (const d of decisions) {
    let archived: string | null = null;
    try {
      archived = await effects.archiveTail(d);
    } catch {
      archived = null; // archiving is best-effort; the reap decision stands
    }
    let ok = false;
    let note: string | undefined;
    try {
      ok = await effects.stopUnit(d.scopeUnit);
      if (ok && d.kind === 'quiet-zombie') {
        await effects.closeAsReaped(d.taskId, d.why);
      }
    } catch (err) {
      note = (err as Error).message?.slice(0, 200);
    }
    out.push({ taskId: d.taskId, scopeUnit: d.scopeUnit, kind: d.kind, ok, archived, note });
  }
  return out;
}
