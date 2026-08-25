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
