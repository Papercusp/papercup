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
import { markAdvSessionEnded } from '../adv-sessions';
import {
  cancelClaimableAwaits,
  cancelInboxWakeAwaits,
  retireLifecycleBoundWatchesForOwners,
} from '../events/await/store';
import { releaseAllWorkItemLeasesForOwner } from '../work-item-lease-release';

const DEFAULT_HISTORY_FRESH_MS = 5 * 60_000;
const DEFAULT_ROLLOUT_LAG_MS = 15 * 60_000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 5 * 60_000;
const DEFAULT_PROVIDER_FAILURE_CONSECUTIVE = 3;
export const CODEX_PROVIDER_ERROR_TAIL_BYTES = 512 * 1024;
const PHASE_PREFIX = 'codex-rollout-stall:';
const PROVIDER_FAILURE_PHASE_PREFIX = 'codex-provider-failure:';
const PROVIDER_ERROR_EVIDENCE_LIMIT = 6;
const PROVIDER_ERROR_TEXT_LIMIT = 500;

export type CodexProviderErrorSource = 'event_msg:error' | 'event_msg:task_complete';

export interface CodexProviderError {
  source: CodexProviderErrorSource;
  code: string;
  rawCode: string;
  message: string | null;
  retryAt: string | null;
  account: string | null;
  timestamp: string | null;
  turnKey: string | null;
}

export interface CodexProviderFailureRecurrence {
  consecutiveFailures: number;
  threshold: number;
  dead: boolean;
  latest: CodexProviderError | null;
  failures: CodexProviderError[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function clipProviderText(value: string | null): string | null {
  if (!value) return null;
  return value.length <= PROVIDER_ERROR_TEXT_LIMIT
    ? value
    : value.slice(0, PROVIDER_ERROR_TEXT_LIMIT) + '…';
}

function normalizeProviderErrorCode(rawCode: string): string {
  const normalized = rawCode
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[.\s-]+/g, '_')
    .toLowerCase();
  if (normalized === 'usagelimitexceeded') return 'usage_limit_exceeded';
  if (normalized === 'ratelimitexceeded') return 'rate_limit_exceeded';
  return normalized || 'provider_error';
}

function retryAtFromMessage(message: string | null): string | null {
  if (!message) return null;
  const match = message.match(/\b(?:try again|retry|resets?|reset)\s+(?:again\s+)?(?:at|on)?\s*([^.!?\n]{2,160})/i);
  return match?.[1]?.trim() || null;
}

/**
 * Classify the native Codex terminal records that the session-ingest text
 * parser intentionally skips. A task_complete error is one failed turn even
 * when an earlier event_msg:error described the same failure.
 */
export function classifyCodexProviderError(line: string): CodexProviderError | null {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (record.type !== 'event_msg') return null;
  const payload = asRecord(record.payload);
  if (!payload) return null;
  const payloadType = typeof payload.type === 'string' ? payload.type : '';
  if (payloadType !== 'error' && payloadType !== 'task_complete') return null;
  const error = asRecord(payload.error);
  const hasError = payloadType === 'error' || payload.error != null || payload.codex_error_info != null;
  if (!hasError) return null;

  const rawCode =
    firstString(
      payload.codex_error_info,
      error?.codex_error_info,
      payload.error_code,
      error?.code,
      payload.code,
    ) ?? 'provider_error';
  const message = clipProviderText(
    firstString(payload.message, error?.message, error?.detail, error?.error, payload.error),
  );
  const account = firstString(
    payload.account,
    payload.account_id,
    payload.provider_account,
    error?.account,
    error?.account_id,
  );
  const turnKey = firstString(
    payload.turn_id,
    payload.turnId,
    error?.turn_id,
    error?.turnId,
  );
  const source: CodexProviderErrorSource =
    payloadType === 'task_complete' ? 'event_msg:task_complete' : 'event_msg:error';
  return {
    source,
    code: normalizeProviderErrorCode(rawCode),
    rawCode,
    message,
    retryAt: retryAtFromMessage(message),
    account,
    timestamp: firstString(record.timestamp, payload.timestamp),
    turnKey,
  };
}

function isCodexSuccessfulTerminal(line: string): boolean {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (record.type !== 'event_msg') return false;
  const payload = asRecord(record.payload);
  if (!payload) return false;
  const payloadType = typeof payload.type === 'string' ? payload.type : '';
  if (payloadType !== 'task_complete' && payloadType !== 'turn_completed') return false;
  return payload.error == null && payload.codex_error_info == null && payload.status !== 'error';
}

/**
 * Evaluate the trailing provider-failure streak in rollout lines. Native
 * Codex commonly writes both event_msg:error and task_complete.error for one
 * failed turn; those adjacent records are collapsed so the threshold counts
 * turns, not wire records. Any successful task/turn completion resets it.
 */
export function evaluateCodexProviderFailureRecurrence(
  lines: readonly string[],
  opts: { consecutiveFailures?: number } = {},
): CodexProviderFailureRecurrence {
  const threshold = Math.max(1, Math.floor(opts.consecutiveFailures ?? DEFAULT_PROVIDER_FAILURE_CONSECUTIVE));
  type Terminal =
    | { kind: 'failure'; error: CodexProviderError; lineIndex: number }
    | { kind: 'success' };
  const terminals: Terminal[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const error = classifyCodexProviderError(lines[lineIndex] ?? '');
    if (error) {
      const previous = terminals[terminals.length - 1];
      const duplicateTaskError =
        error.source === 'event_msg:task_complete' &&
        previous?.kind === 'failure' &&
        previous.error.source === 'event_msg:error' &&
        (
          (error.turnKey != null && error.turnKey === previous.error.turnKey) ||
          (
            error.turnKey == null &&
            previous.error.turnKey == null &&
            error.code === previous.error.code &&
            error.message === previous.error.message &&
            lineIndex - previous.lineIndex <= 3
          )
        );
      if (duplicateTaskError) {
        terminals[terminals.length - 1] = { kind: 'failure', error, lineIndex };
      } else {
        terminals.push({ kind: 'failure', error, lineIndex });
      }
      continue;
    }
    if (isCodexSuccessfulTerminal(lines[lineIndex] ?? '')) terminals.push({ kind: 'success' });
  }

  const failures: CodexProviderError[] = [];
  for (let index = terminals.length - 1; index >= 0; index -= 1) {
    const terminal = terminals[index];
    if (!terminal || terminal.kind === 'success') break;
    failures.unshift(terminal.error);
  }
  return {
    consecutiveFailures: failures.length,
    threshold,
    dead: failures.length >= threshold,
    latest: failures[failures.length - 1] ?? null,
    failures,
  };
}

/** Pure bounded-tail parser seam used by the filesystem reader and tests. */
export function scanCodexProviderFailureTail(
  tailText: string,
  opts: { consecutiveFailures?: number } = {},
): CodexProviderFailureRecurrence {
  return evaluateCodexProviderFailureRecurrence(tailText.split(/\r?\n/), opts);
}

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
