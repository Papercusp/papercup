/**
 * fallback-observations — the durable record of fail-open / fallback decisions
 * (degradation-signals-on-condition-rail-2026-10-11 P-002, BAR R-1, D-001;
 * table: migration 1458 `harness_shared.fallback_observations`).
 *
 * A mechanism that can quietly fall back — the gate's pass-reuse selector, a
 * retrieval leg, a transport, a self-healing watchdog — calls
 * `observeFallback(mechanism, { eligible, applied, reason })` once per decision
 * batch: how many units COULD have taken the primary path, how many DID, and
 * why. The generic degradation watchdog (P-003) reads a trailing window with
 * `readFallbackWindow` and raises `degraded:<mechanism>:<reason>` when the
 * applied rate collapses.
 *
 * Why Postgres and not the per-process leg-health ring (D-001): the gate's
 * reuse decisions run in CHILD processes, so an in-memory ring there is
 * invisible to the watchdog. Gate run 762a13a6 reused 0 of ~7,689 eligible
 * tasks and nothing alarmed, because the only signal was a log line.
 *
 * Writes are best-effort and batched: `observeFallback` only enqueues, never
 * throws and never awaits, so a hot path is not slowed and a database outage
 * cannot fail the caller. A short-lived process (a script, a gate child) must
 * `await flushFallbackObservations()` before it exits; a `beforeExit` hook
 * covers processes that end by draining their event loop.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { pinModuleState } from '@papercusp/module-singleton';

/** One decision batch, as reported by the mechanism. */
export interface FallbackDecision {
  /** Units that could have taken the primary (non-fallback) path. */
  eligible: number;
  /** Units that actually took it. `eligible - applied` units fell back. */
  applied: number;
  /** Why the batch went the way it did (e.g. `applied`, `proofs-unavailable`). */
  reason: string;
  /** Optional sub-scope (a gate run id, a pool name) for drill-down. */
  scope?: string | null;
}

export interface ObserveFallbackOptions {
  /** Postgres handle; defaults to the operator admin pool at flush time. */
  sql?: Sql;
  /** Defaults to `PAPERCUSP_WORKSPACE_ID`, else `'default'`. */
  workspaceId?: string;
  /** Free-form tag naming the writing process (e.g. `gate-cli`). */
  processTag?: string;
  /** Event time; defaults to now. */
  observedAt?: Date;
}

/** Per-reason aggregate over a window — the reader's row shape. */
export interface FallbackReasonAggregate {
  reason: string;
  samples: number;
  eligible: number;
  applied: number;
}

export interface FallbackReasonSummary extends FallbackReasonAggregate {
  /** Units that fell back under this reason (`eligible - applied`). */
  fellBack: number;
}

export interface FallbackWindow {
  mechanism: string;
  windowMs: number;
  /** Decision batches in the window. */
  samples: number;
  eligible: number;
  applied: number;
  /** `applied / eligible`; null when nothing was eligible (no evidence either way). */
  appliedRate: number | null;
  /** Sorted by fallen-back units, then samples, then reason. */
  reasons: FallbackReasonSummary[];
  /** The reason that accounts for the most fallen-back units; null when none fell back. */
  dominantReason: string | null;
  /** That reason's share of all fallen-back units; null when none fell back. */
  dominantShare: number | null;
}

export const FALLBACK_NAME_MAX_CHARS = 200;
export const FALLBACK_SCOPE_MAX_CHARS = 500;
/** Rows per INSERT; also the buffer length that triggers an immediate flush. */
export const FALLBACK_FLUSH_BATCH = 50;
/** Debounce before a partial batch is flushed. */
export const FALLBACK_FLUSH_DELAY_MS = 2_000;
/** Hard cap on unflushed rows; beyond it the OLDEST are dropped and counted. */
export const FALLBACK_BUFFER_MAX = 2_000;
/** Default retention for {@link pruneFallbackObservations}. */
export const FALLBACK_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const WARN_WINDOW_MS = 10 * 60 * 1000;

interface PendingRow {
  sql: Sql | undefined;
  workspace_id: string;
  mechanism: string;
  eligible: number;
  applied: number;
  reason: string;
  scope: string | null;
  process_tag: string | null;
  observed_at: Date;
}

interface WriterState {
  pending: PendingRow[];
  /** Rows dropped since the last flush report (buffer overflow). */
  dropped: number;
  /** Rows refused at observe time since the last flush report (invalid input). */
  rejected: number;
  totalDropped: number;
  totalRejected: number;
  /** Rows lost to a failed write (no handle, or the INSERT rejected). */
  totalFailed: number;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: Promise<FlushResult> | null;
  exitHookInstalled: boolean;
  lastWarnedAt: number;
  suppressedSinceWarn: number;
}

const state = pinModuleState<WriterState>('@papercusp/operator-core.fallback-observations', () => ({
  pending: [],
  dropped: 0,
  rejected: 0,
  totalDropped: 0,
  totalRejected: 0,
  totalFailed: 0,
  timer: null,
  flushing: null,
  exitHookInstalled: false,
  lastWarnedAt: 0,
  suppressedSinceWarn: 0,
}));

export interface FlushResult {
  written: number;
  failed: number;
  dropped: number;
  rejected: number;
}

function warnThrottled(message: string, err?: unknown): void {
  state.suppressedSinceWarn += 1;
  const now = Date.now();
  if (now - state.lastWarnedAt < WARN_WINDOW_MS) return;
  const also = state.suppressedSinceWarn - 1;
  console.warn(
    `[fallback-observations] ${message}` +
      (also > 0 ? ` (+${also} more since last warn)` : '') +
      (err ? `: ${(err as Error)?.message ?? String(err)}` : ''),
  );
  state.lastWarnedAt = now;
  state.suppressedSinceWarn = 0;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t.length === 0 || t.length > FALLBACK_NAME_MAX_CHARS) return null;
  return t;
}

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/**
 * Validate one decision. Returns a reason string when it is refused, else null.
 * Exported for tests and for callers that want to assert their own inputs.
 */
export function fallbackDecisionProblem(mechanism: unknown, d: Partial<FallbackDecision> | null | undefined): string | null {
  if (!cleanName(mechanism)) return `mechanism must be a non-empty string of at most ${FALLBACK_NAME_MAX_CHARS} chars`;
  if (!d || typeof d !== 'object') return 'decision must be an object';
  if (!isCount(d.eligible)) return 'eligible must be a non-negative integer';
  if (!isCount(d.applied)) return 'applied must be a non-negative integer';
  if (d.applied > d.eligible) return `applied (${d.applied}) exceeds eligible (${d.eligible})`;
  if (!cleanName(d.reason)) return `reason must be a non-empty string of at most ${FALLBACK_NAME_MAX_CHARS} chars`;
  if (d.scope != null && (typeof d.scope !== 'string' || d.scope.length > FALLBACK_SCOPE_MAX_CHARS)) {
    return `scope must be a string of at most ${FALLBACK_SCOPE_MAX_CHARS} chars`;
  }
  return null;
}

function installExitHook(): void {
  if (state.exitHookInstalled || typeof process === 'undefined' || typeof process.once !== 'function') return;
  state.exitHookInstalled = true;
  process.once('beforeExit', () => {
    if (state.pending.length > 0) void flushFallbackObservations();
  });
}

function scheduleFlush(): void {
  if (state.pending.length >= FALLBACK_FLUSH_BATCH) {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    // One flush at a time: an in-flight flush re-checks the buffer when it
    // finishes, so a burst never queues one waiting flush per observation.
    if (!state.flushing) void flushFallbackObservations();
    return;
  }
  if (state.timer || state.flushing) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void flushFallbackObservations();
  }, FALLBACK_FLUSH_DELAY_MS);
  // Never keep a process alive just to flush telemetry; beforeExit covers drain.
  (state.timer as { unref?: () => void }).unref?.();
}

/**
 * Record one fallback decision batch. Enqueue-only: never throws, never awaits.
 * Returns false when the input was refused (it is counted and warned, not raised).
 */
export function observeFallback(mechanism: string, decision: FallbackDecision, opts: ObserveFallbackOptions = {}): boolean {
  const problem = fallbackDecisionProblem(mechanism, decision);
  if (problem) {
    state.rejected += 1;
    state.totalRejected += 1;
    warnThrottled(`refused observation for '${String(mechanism).slice(0, 80)}': ${problem}`);
    return false;
  }
  if (state.pending.length >= FALLBACK_BUFFER_MAX) {
    state.pending.shift();
    state.dropped += 1;
    state.totalDropped += 1;
    warnThrottled(`buffer full (${FALLBACK_BUFFER_MAX}); dropped the oldest unflushed observation`);
  }
  state.pending.push({
    sql: opts.sql,
    workspace_id: opts.workspaceId?.trim() || process.env.PAPERCUSP_WORKSPACE_ID?.trim() || 'default',
    mechanism: mechanism.trim(),
    eligible: decision.eligible,
    applied: decision.applied,
    reason: decision.reason.trim(),
    scope: decision.scope ?? null,
    process_tag: opts.processTag ?? null,
    observed_at: opts.observedAt ?? new Date(),
  });
  installExitHook();
  scheduleFlush();
  return true;
}

async function writeBatch(sql: Sql, rows: PendingRow[]): Promise<void> {
  const values = rows.map(({ sql: _ignored, ...r }) => r);
  await sql`
    INSERT INTO harness_shared.fallback_observations
      ${sql(values, 'workspace_id', 'mechanism', 'eligible', 'applied', 'reason', 'scope', 'process_tag', 'observed_at')}
  `;
}

async function flushOnce(defaultSql: Sql | undefined): Promise<FlushResult> {
  const batch = state.pending.splice(0, state.pending.length);
  const result: FlushResult = { written: 0, failed: 0, dropped: state.dropped, rejected: state.rejected };
  state.dropped = 0;
  state.rejected = 0;
  if (batch.length === 0) return result;
  // Group by handle so an explicit per-call `sql` is honoured.
  const groups = new Map<Sql | undefined, PendingRow[]>();
  for (const row of batch) {
    const key = row.sql ?? defaultSql;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  for (const [handle, rows] of groups) {
    let sql: Sql;
    try {
      sql = handle ?? getOrgPg().sql;
    } catch (err) {
      result.failed += rows.length;
      state.totalFailed += rows.length;
      warnThrottled(`no Postgres handle; ${rows.length} observation(s) lost`, err);
      continue;
    }
    for (let i = 0; i < rows.length; i += FALLBACK_FLUSH_BATCH) {
      const chunk = rows.slice(i, i + FALLBACK_FLUSH_BATCH);
      try {
        await writeBatch(sql, chunk);
        result.written += chunk.length;
      } catch (err) {
        result.failed += chunk.length;
        state.totalFailed += chunk.length;
        warnThrottled(`write failed; ${chunk.length} observation(s) lost`, err);
      }
    }
  }
  return result;
}

/**
 * Write every buffered observation now. Never throws; reports what happened.
 * Concurrent callers share one in-flight flush, then a follow-up flush picks up
 * anything enqueued meanwhile.
 */
export async function flushFallbackObservations(opts: { sql?: Sql } = {}): Promise<FlushResult> {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  while (state.flushing) await state.flushing;
  const p = flushOnce(opts.sql);
  state.flushing = p;
  try {
    return await p;
  } finally {
    state.flushing = null;
    // Pick up whatever was enqueued while this flush was writing.
    if (state.pending.length > 0) scheduleFlush();
  }
}

/** Lifetime counters since process start (or the last test reset). */
export function fallbackObservationCounters(): { dropped: number; rejected: number; failed: number } {
  return { dropped: state.totalDropped, rejected: state.totalRejected, failed: state.totalFailed };
}

/** Pure: fold per-reason aggregates into a window summary. */
export function summarizeFallbackWindow(
  mechanism: string,
  windowMs: number,
  aggregates: readonly FallbackReasonAggregate[],
): FallbackWindow {
  const byReason = new Map<string, FallbackReasonAggregate>();
  for (const a of aggregates) {
    const prev = byReason.get(a.reason);
    if (prev) {
      prev.samples += a.samples;
      prev.eligible += a.eligible;
      prev.applied += a.applied;
    } else {
      byReason.set(a.reason, { reason: a.reason, samples: a.samples, eligible: a.eligible, applied: a.applied });
    }
  }
  const reasons: FallbackReasonSummary[] = [...byReason.values()]
    .map((r) => ({ ...r, fellBack: Math.max(0, r.eligible - r.applied) }))
    .sort((a, b) => b.fellBack - a.fellBack || b.samples - a.samples || a.reason.localeCompare(b.reason));
  let samples = 0;
  let eligible = 0;
  let applied = 0;
  let fellBack = 0;
  for (const r of reasons) {
    samples += r.samples;
    eligible += r.eligible;
    applied += r.applied;
    fellBack += r.fellBack;
  }
  const top = fellBack > 0 ? reasons[0] : undefined;
  return {
    mechanism,
    windowMs,
    samples,
    eligible,
    applied,
    appliedRate: eligible > 0 ? applied / eligible : null,
    reasons,
    dominantReason: top ? top.reason : null,
    dominantShare: top ? top.fellBack / fellBack : null,
  };
}

/**
 * Aggregate one mechanism's observations over the trailing `windowMs`.
 * Without `workspaceId`, every workspace's rows are included.
 */
export async function readFallbackWindow(
  mechanism: string,
  windowMs: number,
  opts: { sql?: Sql; workspaceId?: string; now?: Date } = {},
): Promise<FallbackWindow> {
  const sql = opts.sql ?? getOrgPg().sql;
  const since = new Date((opts.now ?? new Date()).getTime() - windowMs);
  const ws = opts.workspaceId ?? null;
  const rows = await sql<Array<{ reason: string; samples: number | string; eligible: number | string; applied: number | string }>>`
    SELECT reason,
           count(*)::bigint      AS samples,
           sum(eligible)::bigint AS eligible,
           sum(applied)::bigint  AS applied
      FROM harness_shared.fallback_observations
     WHERE mechanism = ${mechanism.trim()}
       AND observed_at >= ${since}
       AND (${ws}::text IS NULL OR workspace_id = ${ws}::text)
     GROUP BY reason
  `;
  return summarizeFallbackWindow(
    mechanism.trim(),
    windowMs,
    rows.map((r) => ({ reason: r.reason, samples: Number(r.samples), eligible: Number(r.eligible), applied: Number(r.applied) })),
  );
}

/**
 * Delete observations older than `retentionMs`, in bounded batches so a large
 * backlog never becomes one long-running DELETE. Returns rows deleted.
 */
export async function pruneFallbackObservations(
  opts: { sql?: Sql; retentionMs?: number; batchSize?: number; maxBatches?: number; now?: Date } = {},
): Promise<number> {
  const sql = opts.sql ?? getOrgPg().sql;
  const cutoff = new Date((opts.now ?? new Date()).getTime() - (opts.retentionMs ?? FALLBACK_RETENTION_MS));
  const batchSize = Math.max(1, opts.batchSize ?? 5_000);
  const maxBatches = Math.max(1, opts.maxBatches ?? 20);
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const res = await sql`
      DELETE FROM harness_shared.fallback_observations
       WHERE id IN (
         SELECT id FROM harness_shared.fallback_observations
          WHERE observed_at < ${cutoff}
          ORDER BY observed_at
          LIMIT ${batchSize}
       )
    `;
    const n = res.count ?? 0;
    total += n;
    if (n < batchSize) break;
  }
  return total;
}

/** Test hook: number of buffered, unflushed observations. */
export function _pendingFallbackObservationCount(): number {
  return state.pending.length;
}

/** Test hook: clear the buffer, counters, timer and warn throttle. */
export function _resetFallbackObservationsForTests(): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.pending = [];
  state.dropped = 0;
  state.rejected = 0;
  state.totalDropped = 0;
  state.totalRejected = 0;
  state.totalFailed = 0;
  state.flushing = null;
  state.lastWarnedAt = 0;
  state.suppressedSinceWarn = 0;
}
