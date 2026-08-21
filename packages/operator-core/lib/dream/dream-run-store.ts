/**
 * Durable dream-attempt ledger (REM dreaming P-005, migration 862).
 *
 * A row is begun before source selection/model work, selection is persisted
 * before the dreamer call, and a terminal finalize is write-once.  The stable
 * run id is derived from the DBOS routine-fire workflow id plus the bounded
 * dream index, so a crash replay reuses the same row and accepted sinks retain
 * their existing `dream:<runId>` idempotency key.
 */
import type { Sql } from 'postgres';
import type { DreamPassUsage } from './dream-pass';
import type { DreamReviewUsage } from './dream-review';
import type { DreamFragmentKind } from './dream-config';
import type { DreamFragmentPair } from './fragment-sampler';

export const DREAM_RUN_MODES = ['manual', 'auto'] as const;
export type DreamRunMode = (typeof DREAM_RUN_MODES)[number];

export const DREAM_RUN_TERMINAL_STATUSES = [
  'no-pair',
  'abstained',
  'malformed',
  'duplicate',
  'rejected',
  'accepted',
  'error',
] as const;
export type DreamRunTerminalStatus = (typeof DREAM_RUN_TERMINAL_STATUSES)[number];
export type DreamRunStatus = 'running' | DreamRunTerminalStatus;

export interface DreamRun {
  workspaceId: string;
  runId: string;
  cycleId: string;
  potSlug: string;
  mode: DreamRunMode;
  status: DreamRunStatus;
  fragmentRefs: string[];
  fragmentKinds: DreamFragmentKind[];
  pairing: DreamFragmentPair['pairing'] | null;
  similarity: number | null;
  dreamerModel: string | null;
  reviewerModel: string | null;
  dreamUsage: DreamPassUsage | null;
  reviewUsage: DreamReviewUsage | null;
  outcome: Record<string, unknown> | null;
  review: Record<string, unknown> | null;
  routedRef: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  spendRecordedAt: string | null;
  updatedAt: string;
}

type Row = Record<string, unknown>;

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new RangeError(`${name} must be a non-empty string`);
  return normalized;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`dream-run-store: invalid timestamp ${String(value)}`);
  return date.toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function mapRun(row: Row): DreamRun {
  return {
    workspaceId: String(row.workspace_id),
    runId: String(row.run_id),
    cycleId: String(row.cycle_id),
    potSlug: String(row.pot_slug),
    mode: String(row.mode) as DreamRunMode,
    status: String(row.status) as DreamRunStatus,
    fragmentRefs: stringArray(row.fragment_refs),
    fragmentKinds: stringArray(row.fragment_kinds) as DreamFragmentKind[],
    pairing: row.pairing == null ? null : (String(row.pairing) as DreamFragmentPair['pairing']),
    similarity: row.similarity == null ? null : Number(row.similarity),
    dreamerModel: row.dreamer_model == null ? null : String(row.dreamer_model),
    reviewerModel: row.reviewer_model == null ? null : String(row.reviewer_model),
    dreamUsage: objectOrNull(row.dream_usage) as DreamPassUsage | null,
    reviewUsage: objectOrNull(row.review_usage) as DreamReviewUsage | null,
    outcome: objectOrNull(row.outcome),
    review: objectOrNull(row.review),
    routedRef: row.routed_ref == null ? null : String(row.routed_ref),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    costUsd: Number(row.cost_usd ?? 0),
    error: row.error == null ? null : String(row.error),
    startedAt: iso(row.started_at),
    completedAt: isoOrNull(row.completed_at),
    spendRecordedAt: isoOrNull(row.spend_recorded_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function getDreamRun(sql: Sql, input: { workspaceId: string; runId: string }): Promise<DreamRun | null> {
  const workspaceId = required(input.workspaceId, 'workspaceId');
  const runId = required(input.runId, 'runId');
  const rows = (await sql`
    SELECT * FROM harness_shared.dream_runs
     WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
     LIMIT 1`) as Row[];
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function beginDreamRun(
  sql: Sql,
  input: {
    workspaceId: string;
    runId: string;
    cycleId: string;
    potSlug: string;
    mode: DreamRunMode;
  },
): Promise<{ created: boolean; run: DreamRun }> {
  const workspaceId = required(input.workspaceId, 'workspaceId');
  const runId = required(input.runId, 'runId');
  const cycleId = required(input.cycleId, 'cycleId');
  const potSlug = required(input.potSlug, 'potSlug');
  if (!DREAM_RUN_MODES.includes(input.mode)) throw new RangeError(`unsupported dream mode ${input.mode}`);

  const inserted = (await sql`
    INSERT INTO harness_shared.dream_runs
      (workspace_id, run_id, cycle_id, pot_slug, mode)
    VALUES (${workspaceId}, ${runId}, ${cycleId}, ${potSlug}, ${input.mode})
    ON CONFLICT (workspace_id, run_id) DO NOTHING
    RETURNING *`) as Row[];
  const run = inserted[0] ? mapRun(inserted[0]) : await getDreamRun(sql, { workspaceId, runId });
  if (!run) throw new Error(`dream-run-store: begin lost row ${workspaceId}/${runId}`);
  if (run.cycleId !== cycleId || run.potSlug !== potSlug || run.mode !== input.mode) {
    throw new Error(`dream-run-store: stable run id ${runId} was reused with different provenance`);
  }
  return { created: inserted.length > 0, run };
}

/** Persist the chosen pair before the first model call. */
export async function recordDreamRunSelection(
  sql: Sql,
  input: { workspaceId: string; runId: string; pair: DreamFragmentPair; dreamerModel: string },
): Promise<DreamRun> {
  const workspaceId = required(input.workspaceId, 'workspaceId');
  const runId = required(input.runId, 'runId');
  const dreamerModel = required(input.dreamerModel, 'dreamerModel');
  const fragments = [input.pair.anchor, input.pair.partner];
  const refs = fragments.map((fragment) => required(fragment.ref, 'fragment ref'));
  if (new Set(refs).size !== refs.length) throw new RangeError('dream selection requires distinct fragment refs');
  const kinds = fragments.map((fragment) => fragment.kind);
  const rows = (await sql`
    UPDATE harness_shared.dream_runs
       SET fragment_refs = ${JSON.stringify(refs)}::text::jsonb,
           fragment_kinds = ${JSON.stringify(kinds)}::text::jsonb,
           pairing = ${input.pair.pairing},
           similarity = ${input.pair.similarity},
           dreamer_model = ${dreamerModel},
           updated_at = now()
     WHERE workspace_id = ${workspaceId} AND run_id = ${runId} AND status = 'running'
     RETURNING *`) as Row[];
  const run = rows[0] ? mapRun(rows[0]) : await getDreamRun(sql, { workspaceId, runId });
  if (!run) throw new Error(`dream-run-store: selection target not found ${workspaceId}/${runId}`);
  return run;
}

export interface FinalizeDreamRunInput {
  workspaceId: string;
  runId: string;
  status: DreamRunTerminalStatus;
  dreamUsage?: DreamPassUsage | null;
  reviewUsage?: DreamReviewUsage | null;
  outcome?: Record<string, unknown> | null;
  review?: Record<string, unknown> | null;
  routedRef?: string | null;
  error?: string | null;
}

/** Terminal, write-once finalize. A replay returns the existing terminal row unchanged. */
export async function finalizeDreamRun(sql: Sql, input: FinalizeDreamRunInput): Promise<DreamRun> {
  const workspaceId = required(input.workspaceId, 'workspaceId');
  const runId = required(input.runId, 'runId');
  if (!DREAM_RUN_TERMINAL_STATUSES.includes(input.status)) {
    throw new RangeError(`unsupported terminal dream status ${input.status}`);
  }
  const usages = [input.dreamUsage, input.reviewUsage].filter(
    (usage): usage is DreamPassUsage | DreamReviewUsage => usage != null,
  );
  for (const usage of usages) {
    if (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)
      throw new RangeError('dream usage cost must be non-negative');
    if (!Number.isInteger(usage.inputTokens) || usage.inputTokens < 0)
      throw new RangeError('dream input tokens must be non-negative integers');
    if (!Number.isInteger(usage.outputTokens) || usage.outputTokens < 0)
      throw new RangeError('dream output tokens must be non-negative integers');
  }
  const inputTokens = usages.reduce((sum, usage) => sum + usage.inputTokens, 0);
  const outputTokens = usages.reduce((sum, usage) => sum + usage.outputTokens, 0);
  const costUsd = usages.reduce((sum, usage) => sum + usage.costUsd, 0);
  const reviewerModel = input.reviewUsage?.model ?? null;
  const error = input.error?.trim().slice(0, 4_000) || null;

  const rows = (await sql`
    UPDATE harness_shared.dream_runs
       SET status = ${input.status},
           reviewer_model = COALESCE(${reviewerModel}, reviewer_model),
           dream_usage = ${JSON.stringify(input.dreamUsage ?? null)}::text::jsonb,
           review_usage = ${JSON.stringify(input.reviewUsage ?? null)}::text::jsonb,
           outcome = ${JSON.stringify(input.outcome ?? null)}::text::jsonb,
           review = ${JSON.stringify(input.review ?? null)}::text::jsonb,
           routed_ref = ${input.routedRef ?? null},
           input_tokens = ${inputTokens},
           output_tokens = ${outputTokens},
           cost_usd = ${costUsd},
           error = ${error},
           completed_at = now(),
           updated_at = now()
     WHERE workspace_id = ${workspaceId} AND run_id = ${runId} AND status = 'running'
     RETURNING *`) as Row[];
  const run = rows[0] ? mapRun(rows[0]) : await getDreamRun(sql, { workspaceId, runId });
  if (!run) throw new Error(`dream-run-store: finalize target not found ${workspaceId}/${runId}`);
  return run;
}

export async function listDreamRuns(
  sql: Sql,
  input: { workspaceId: string; potSlug?: string; cycleId?: string; limit?: number },
): Promise<DreamRun[]> {
  const workspaceId = required(input.workspaceId, 'workspaceId');
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 500);
  const rows = (await sql`
    SELECT * FROM harness_shared.dream_runs
     WHERE workspace_id = ${workspaceId}
       ${input.potSlug ? sql`AND pot_slug = ${input.potSlug}` : sql``}
       ${input.cycleId ? sql`AND cycle_id = ${input.cycleId}` : sql``}
     ORDER BY started_at DESC, run_id DESC
     LIMIT ${limit}`) as Row[];
  return rows.map(mapRun);
}
