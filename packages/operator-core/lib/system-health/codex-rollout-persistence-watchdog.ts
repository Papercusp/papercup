/**
 * Codex rollout-persistence watchdog (WI-4663).
 *
 * Codex 0.144+ can keep accepting prompts in a managed CODEX_HOME while
 * updating history.jsonl but stop appending the rollout JSONL. That leaves the
 * live session invisible to session search and makes turn provenance
 * unverifiable. This process-level watchdog compares the two files while the
 * recorded Codex process is alive and raises one deduplicated escalation per
 * affected session.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';

const DEFAULT_HISTORY_FRESH_MS = 5 * 60_000;
const DEFAULT_ROLLOUT_LAG_MS = 15 * 60_000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 5 * 60_000;
const PHASE_PREFIX = 'codex-rollout-stall:';

export interface CodexRolloutPersistenceThresholds {
  historyFreshMs?: number;
  rolloutLagMs?: number;
}

export interface CodexRolloutPersistenceSnapshot {
  sessionId: string;
  ownerId: string;
  pidAlive: boolean;
  historyMtimeMs: number | null;
  rolloutMtimeMs: number | null;
}

export interface CodexRolloutPersistenceVerdict {
  stalled: boolean;
  reason: string | null;
}

const mins = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

/** Pure recurrence guard: only a live process with fresh history can alarm. */
export function evaluateCodexRolloutPersistence(
  snapshot: CodexRolloutPersistenceSnapshot,
  nowMs: number,
  opts: CodexRolloutPersistenceThresholds = {},
): CodexRolloutPersistenceVerdict {
  const historyFreshMs = opts.historyFreshMs ?? DEFAULT_HISTORY_FRESH_MS;
  const rolloutLagMs = opts.rolloutLagMs ?? DEFAULT_ROLLOUT_LAG_MS;
  if (!snapshot.pidAlive || snapshot.historyMtimeMs == null) return { stalled: false, reason: null };

  const historyAgeMs = nowMs - snapshot.historyMtimeMs;
  if (historyAgeMs > historyFreshMs) return { stalled: false, reason: null };

  const lagMs = snapshot.rolloutMtimeMs == null
    ? Number.POSITIVE_INFINITY
    : snapshot.historyMtimeMs - snapshot.rolloutMtimeMs;
  if (lagMs <= rolloutLagMs) return { stalled: false, reason: null };

  const rollout = snapshot.rolloutMtimeMs == null
    ? 'no rollout JSONL exists'
    : `rollout JSONL is ~${mins(lagMs)}m behind history.jsonl`;
  return {
    stalled: true,
    reason:
      `Codex process ${snapshot.ownerId} (session ${snapshot.sessionId}) is alive and wrote ` +
      `history.jsonl ~${mins(historyAgeMs)}m ago, but ${rollout}. ` +
      'Recent prompts may exist only in Codex process memory; relaunch or inspect the native session before it exits.',
  };
}

async function statMtime(path: string): Promise<number | null> {
  try {
    return (await fs.stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

async function latestRolloutMtime(codexHome: string): Promise<number | null> {
  const root = join(codexHome, 'sessions');
  let best: number | null = null;
  let years: string[];
  try { years = await fs.readdir(root); } catch { return null; }
  for (const year of years) {
    let months: string[];
    try { months = await fs.readdir(join(root, year)); } catch { continue; }
    for (const month of months) {
      let days: string[];
      try { days = await fs.readdir(join(root, year, month)); } catch { continue; }
      for (const day of days) {
        let files: string[];
        try { files = await fs.readdir(join(root, year, month, day)); } catch { continue; }
        for (const file of files) {
          if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
          const mtime = await statMtime(join(root, year, month, day, file));
          if (mtime != null && (best == null || mtime > best)) best = mtime;
        }
      }
    }
  }
  return best;
}

async function readSnapshot(
  row: { id: number; owner_id: string; pid: number | null },
  pidAlive: (pid: number) => boolean,
): Promise<CodexRolloutPersistenceSnapshot> {
  const codexHome = codexHomeForSessionKey(row.id);
  const [historyMtimeMs, rolloutMtimeMs] = await Promise.all([
    statMtime(join(codexHome, 'history.jsonl')),
    latestRolloutMtime(codexHome),
  ]);
  return {
    sessionId: String(row.id),
    ownerId: row.owner_id,
    pidAlive: row.pid != null && pidAlive(row.pid),
    historyMtimeMs,
    rolloutMtimeMs,
  };
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function escalationBody(snapshot: CodexRolloutPersistenceSnapshot, reason: string, nowMs: number): string {
  return JSON.stringify({
    kind: 'codex-rollout-persistence-watchdog',
    owner_id: snapshot.ownerId,
    session_id: snapshot.sessionId,
    emitted_at: nowMs,
    detail: reason,
  });
}

export interface CodexRolloutPersistenceWatchdogResult {
  stalledSessionIds: string[];
  alarmed: string[];
  recovered: string[];
}

/** One cross-process-safe watchdog pass. Never throws to its scheduler. */
export async function checkCodexRolloutPersistence(
  sql: Sql,
  opts: CodexRolloutPersistenceThresholds & { pidAlive?: (pid: number) => boolean } = {},
): Promise<CodexRolloutPersistenceWatchdogResult> {
  const out: CodexRolloutPersistenceWatchdogResult = { stalledSessionIds: [], alarmed: [], recovered: [] };
  try {
    const rows = await sql<Array<{ id: number; owner_id: string; pid: number | null; workspace_id: string | null }>>`
      SELECT id, coord_owner_id AS owner_id, pid, workspace_id
        FROM harness_shared.adv_sessions
       WHERE agent = 'codex' AND ended_at IS NULL AND coord_owner_id IS NOT NULL
    `;
    const now = Date.now();
    const alive = opts.pidAlive ?? defaultPidAlive;
    const stalled: Array<{
      snapshot: CodexRolloutPersistenceSnapshot;
      reason: string;
      workspaceId: string | null;
    }> = [];
    for (const row of rows) {
      const snapshot = await readSnapshot(row, alive);
      const verdict = evaluateCodexRolloutPersistence(snapshot, now, opts);
      if (verdict.stalled && verdict.reason) {
        stalled.push({ snapshot, reason: verdict.reason, workspaceId: row.workspace_id });
      }
    }
    out.stalledSessionIds = stalled.map((item) => item.snapshot.sessionId);

    const newly: typeof stalled = [];
    for (const item of stalled) {
      const phase = PHASE_PREFIX + item.snapshot.sessionId;
      const claimed = await sql`
        INSERT INTO harness_shared.harness_escalations
          (harness_slug, phase, escalation, mtime_ms, workspace_id)
        VALUES ('papercusp', ${phase}, ${escalationBody(item.snapshot, item.reason, now)}, ${now}, ${item.workspaceId})
        ON CONFLICT (harness_slug, phase) DO NOTHING
        RETURNING phase
      `;
      if (claimed.length === 1) newly.push(item);
    }
    if (newly.length > 0) {
      out.alarmed = newly.map((item) => item.snapshot.sessionId);
      const list = newly.map((item) => `${item.snapshot.ownerId} (session ${item.snapshot.sessionId})`).join(', ');
      try {
        const { notifyAttention } = await import('../attention-notify');
        await notifyAttention({
          kind: 'intervention',
          title: 'Codex rollout persistence stalled',
          body: `Live Codex session(s) are writing history.jsonl without a fresh rollout: ${list}. ${newly[0].reason}`,
          importance: 'high',
          workspaceId: newly[0].workspaceId ?? undefined,
          data: { sessionIds: newly.map((item) => item.snapshot.sessionId), owners: newly.map((item) => item.snapshot.ownerId) },
        });
      } catch (e) {
        console.warn(`[codex-rollout-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
      }
      console.warn(`[codex-rollout-watchdog] ALARM: ${list}`);
    }

    const alertedRows = await sql<Array<{ phase: string }>>`
      SELECT phase FROM harness_shared.harness_escalations
       WHERE harness_slug = 'papercusp' AND phase LIKE ${PHASE_PREFIX + '%'} AND escalation IS NOT NULL
    `;
    const activePhases = new Set(stalled.map((item) => PHASE_PREFIX + item.snapshot.sessionId));
    const toRecover = alertedRows.map((row) => row.phase).filter((phase) => !activePhases.has(phase));
    if (toRecover.length > 0) {
      await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = NULL, mtime_ms = ${now}
         WHERE harness_slug = 'papercusp' AND phase = ANY(${toRecover}) AND escalation IS NOT NULL
      `;
      out.recovered = toRecover.map((phase) => phase.slice(PHASE_PREFIX.length));
    }
  } catch (e) {
    console.warn(`[codex-rollout-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}

let watchdogTimer: ManagedHandle | null = null;

/** Start the process-level watchdog; idempotent and kill-switchable. */
export function startCodexRolloutPersistenceWatchdog(
  sql: Sql,
  opts: CodexRolloutPersistenceThresholds & { intervalMs?: number } = {},
): void {
  if (process.env.PAPERCUSP_CODEX_ROLLOUT_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
  const run = (): void => {
    void checkCodexRolloutPersistence(sql, opts).then((result) => {
      if (result.alarmed.length > 0 || result.recovered.length > 0) {
        console.warn(
          `[codex-rollout-watchdog] alarmed=${result.alarmed.length} recovered=${result.recovered.length}`,
        );
      }
    });
  };
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = managedSetInterval('codex-rollout-persistence-watchdog', intervalMs, run, { category: 'watchdog' });
}
