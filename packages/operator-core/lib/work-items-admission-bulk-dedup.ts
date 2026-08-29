/**
 * Staged bulk work-item deduplication (work-queue-admission-and-bulk-dedup P-006).
 *
 * The census owns corpus selection, >=0.90 hard components, 0.85–0.90 ghost
 * context, and deterministic shard packing. This runner consumes that exact
 * pinned shard map, applies the promoter's duplication-only charter/code set,
 * and commits each stage only when a fresh census satisfies the monotone
 * non-increase ratchet. A rise rolls the whole stage back and leaves a failed
 * `bulk-stage` ledger row outside the transaction.
 */
import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { admissionIdentity } from './harness/improvements/digest';
import { isTransientNetworkError } from './harness/routines/hetzner-orphan-frame-reaper';
import { LEARNING_MODEL_SPEC } from './learning/model-policy';
import {
  ADMISSION_COMPONENT_FLOOR,
  runWorkItemAdmissionCensus,
  type AdmissionCensusRunOptions,
  type AdmissionCensusRunResult,
} from './work-items-admission-census';
import {
  admissionPairKey,
  buildPromoterPrompt,
  parsePromoterJudgements,
  persistAdmissionPlan,
  planPromoterDispositions,
  responsePayload,
  type PromoterItem,
  type PromoterJudgement,
  type PromoterLlmCall,
  type PromoterPair,
} from './work-items-admission-promoter';
import type { OrgSql } from './work-items';

export const WORK_ITEM_ADMISSION_BULK_DEDUP = 'work-item-admission-bulk-dedup';
export const BULK_DEDUP_ACTOR = `system:${WORK_ITEM_ADMISSION_BULK_DEDUP}`;
export const DEFAULT_BULK_MAX_STAGES = 12;
export const DEFAULT_BULK_PAIRS_PER_CALL = 150;
/**
 * Output-token budget for ONE judge batch, and the per-pair/overhead rates the
 * batch size is derived from.
 *
 * These three numbers and `pairsPerCall` are ONE constraint, not four settings.
 * Before 2026-08-29 they disagreed: the call site asked for
 * `Math.min(8_000, 500 + batch.length * 180)`, so a default 150-pair batch
 * computed a 27,500-token need and was silently clamped to 8,000 — a 3.4x
 * shortfall. The model then ran out of output mid-JSON, `responsePayload`
 * returned null, and `parsePromoterJudgements` threw
 * `expected object, received null`. Because the truncation is DETERMINISTIC in
 * the batch size, every retry re-sent the same oversized batch and failed
 * identically, so the bounded retry could only burn the budget, never recover.
 *
 * Measured on run wi882767-opus5-20260829-stage-1 (claude-opus-5:xhigh, 1770
 * pairs): modelCalls 12, modelRetries 36 (= 12 batches x the 3-retry maximum,
 * i.e. EVERY batch exhausted), protocolFailures 46, exhaustedBatches 10 of 12,
 * merged 0. tokens_out averaged 7,974 across 48 calls — flush against the 8,000
 * ceiling, which is the signature of truncation rather than a model that cannot
 * follow the schema. Only the two batches small enough to fit survived.
 *
 * The fix is to DERIVE the batch size from the budget (see
 * {@link maxPairsForOutputBudget}) so a batch can never be issued that its own
 * token budget cannot hold. Raising the ceiling instead would trade a known-
 * workable limit for a guess about a specific model's maximum output.
 */
export const BULK_JUDGE_MAX_OUTPUT_TOKENS = 8_000;
export const BULK_JUDGE_TOKENS_PER_PAIR = 180;
export const BULK_JUDGE_TOKEN_OVERHEAD = 500;

/**
 * The largest pair batch whose judgements fit in `maxOutputTokens`. This is the
 * single place the batch/budget relationship is expressed; the clamp on
 * `pairsPerCall` and the `maxTokens` passed to the model both read from it, so
 * they cannot drift apart again.
 */
export function maxPairsForOutputBudget(
  maxOutputTokens: number = BULK_JUDGE_MAX_OUTPUT_TOKENS,
): number {
  return Math.max(
    1,
    Math.floor((maxOutputTokens - BULK_JUDGE_TOKEN_OVERHEAD) / BULK_JUDGE_TOKENS_PER_PAIR),
  );
}

/** Output tokens a batch of `pairs` judgements needs. Never exceeds the ceiling
 * for a batch sized by {@link maxPairsForOutputBudget}. */
export function bulkJudgeMaxTokens(pairs: number): number {
  return BULK_JUDGE_TOKEN_OVERHEAD + pairs * BULK_JUDGE_TOKENS_PER_PAIR;
}
export const DEFAULT_BULK_SHARD_CONCURRENCY = 4;
/** Bounded retries for a single model batch. A successful earlier batch stays
 * in memory, so only the failed batch is replayed. */
export const DEFAULT_BULK_BATCH_RETRY_BACKOFFS_MS = [500, 1_500, 4_000] as const;

export type BulkDedupScope = 'full-corpus' | 'machine-emitter-targeted';

interface BulkMapRow {
  shard_id: number;
  item_id: string;
  role: 'member' | 'ghost';
  title: string | null;
  summary: string | null;
  status: string | null;
  item_kind: string | null;
  admission: string | null;
  condition_key: string | null;
  created_ts: string | number | null;
}

interface BulkEdgeRow {
  a: string;
  b: string;
  cos: string | number;
  a_shard: number;
  b_shard: number;
}

interface BulkInput {
  items: Map<string, PromoterItem>;
  pairs: PromoterPair[];
  pairShard: Map<string, number>;
  ghostIdsByShard: Map<number, string[]>;
  memberCount: number;
}

export interface BulkDedupStageResult {
  runId: string;
  sourceCensusRunId: string;
  resultCensusRunId: string;
  scope: BulkDedupScope;
  pairs: number;
  merged: number;
  held: number;
  modelCalls: number;
  tokensIn: number;
  tokensOut: number;
  modelRetries: number;
  modelProtocolFailures: number;
  modelProtocolExhaustedBatches: number;
  ignoredUnknownJudgements: number;
  omittedExpectedJudgements: number;
  censusBefore: number;
  censusAfter: number;
  scopedPairsAfter: number;
}

export interface BulkDedupRunResult {
  runId: string;
  scope: BulkDedupScope;
  converged: boolean;
  convergenceReason: 'global-zero' | 'scope-zero';
  initialCensus: number;
  finalCensus: number;
  finalScopedPairs: number;
  stages: BulkDedupStageResult[];
}

type CensusRunner = (opts: AdmissionCensusRunOptions) => Promise<AdmissionCensusRunResult>;

export interface BulkDedupRunOptions {
  workspaceId: string;
  harnessSlug: string;
  llmCall: PromoterLlmCall;
  sql?: OrgSql;
  runId?: string;
  maxStages?: number;
  pairsPerCall?: number;
  shardConcurrency?: number;
  census?: Omit<AdmissionCensusRunOptions, 'workspaceId' | 'harnessSlug' | 'sql' | 'runId' | 'withinTransaction'>;
  now?: () => number;
  /** Stable owner identity for gateway attribution across retries/replays. */
  ownerId?: string;
  /** Dependency seam used by the real-PG recurrence guard to inject a census rise. */
  beforePostStageCensus?: (sql: OrgSql, stageIndex: number) => Promise<void>;
  /**
   * Model spec for this run's judging calls. Defaults to {@link LEARNING_MODEL_SPEC}.
   *
   * The default is the owner-directed learning policy and stays that way; this
   * override exists so ONE run can be driven onto a different backend without
   * re-pointing every learning path at it — the case that matters here is the
   * canonical Sol model being unreachable (codex pool usage-walled, or the
   * ChatGPT-account rejection `The 'gpt-5.6-sol:xhigh' model is not supported
   * when using Codex with a ChatGPT account`), which failed three of the four
   * bulk-stage attempts on 2026-08-27/28.
   *
   * Whatever is resolved here is what gets WRITTEN to `admission_runs.model_id`,
   * so the ledger reports the model that actually ran rather than the policy
   * constant. A ledger that names a model the run did not use is worse than an
   * empty column: it reads as evidence.
   */
  model?: string;
  /** Injectable bounded backoff for transient model transport failures. */
  batchRetryBackoffsMs?: readonly number[];
  /** Injectable sleep seam for retry tests; production uses setTimeout. */
  batchRetryDelay?: (ms: number) => Promise<void>;
  runCensus?: CensusRunner;
}

function finiteMs(value: string | number | null): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function itemFromRow(row: BulkMapRow): PromoterItem {
  return {
    id: row.item_id,
    title: row.title ?? '',
    summary: row.summary ?? '',
    state: row.status ?? 'open',
    kind: row.item_kind ?? 'task',
    admission: row.admission,
    conditionKey: row.condition_key,
    createdAtMs: finiteMs(row.created_ts),
  };
}

function signalsForBulk(a: PromoterItem, b: PromoterItem): PromoterPair['signals'] {
  const signals: PromoterPair['signals'] = ['cosine'];
  if (a.conditionKey && a.conditionKey === b.conditionKey) signals.unshift('condition-key');
  if (admissionIdentity(a.title).titleKey === admissionIdentity(b.title).titleKey) signals.unshift('title-key');
  return [...new Set(signals)];
}

async function readBulkInput(
  sql: OrgSql,
  input: {
    workspaceId: string;
    harnessSlug: string;
    censusRunId: string;
    expectedMembers: number;
    scope: BulkDedupScope;
  },
): Promise<BulkInput> {
  const mapRows = await sql<BulkMapRow[]>`
    SELECT sm.shard_id, sm.item_id, sm.role,
           wi.title, wi.summary, wi.status, wi.item_kind, wi.admission,
           wi.condition_key, wi.created_ts
      FROM harness_shared.dedup_shard_map sm
      JOIN harness_shared.work_items wi
        ON wi.workspace_id = sm.workspace_id
       AND wi.harness_slug = sm.harness_slug
       AND wi.feature_id = sm.item_id
     WHERE sm.workspace_id = ${input.workspaceId}
       AND sm.harness_slug = ${input.harnessSlug}
       AND sm.run_id = ${input.censusRunId}
     ORDER BY sm.shard_id, sm.role, sm.item_id`;

  const memberRows = mapRows.filter((row) => row.role === 'member');
  const memberIds = new Set(memberRows.map((row) => row.item_id));
  if (memberRows.length !== input.expectedMembers || memberIds.size !== input.expectedMembers) {
    throw new Error(
      `bulk snapshot member coverage mismatch: rows=${memberRows.length}, unique=${memberIds.size}, expected=${input.expectedMembers}`,
    );
  }

  const items = new Map<string, PromoterItem>();
  for (const row of mapRows) if (!items.has(row.item_id)) items.set(row.item_id, itemFromRow(row));
  const edgeRows = await sql<BulkEdgeRow[]>`
    WITH homes AS MATERIALIZED (
      SELECT item_id, shard_id
        FROM harness_shared.dedup_shard_map
       WHERE workspace_id = ${input.workspaceId}
         AND harness_slug = ${input.harnessSlug}
         AND run_id = ${input.censusRunId}
         AND role = 'member'
    )
    SELECT e.a, e.b, e.cos, ha.shard_id AS a_shard, hb.shard_id AS b_shard
      FROM harness_shared.dedup_edges e
      JOIN homes ha ON ha.item_id = e.a
      JOIN homes hb ON hb.item_id = e.b
      LEFT JOIN harness_shared.dedup_adjudications d
        ON d.workspace_id = e.workspace_id
       AND d.harness_slug = e.harness_slug
       AND d.a = e.a AND d.b = e.b
     WHERE e.workspace_id = ${input.workspaceId}
       AND e.harness_slug = ${input.harnessSlug}
       AND e.cos >= ${ADMISSION_COMPONENT_FLOOR}
       AND d.a IS NULL
     ORDER BY e.a, e.b`;

  const pairs: PromoterPair[] = [];
  const pairShard = new Map<string, number>();
  for (const row of edgeRows) {
    const a = items.get(row.a);
    const b = items.get(row.b);
    if (!a || !b) throw new Error(`bulk snapshot edge endpoint missing from pinned map: ${row.a}::${row.b}`);
    if (input.scope === 'machine-emitter-targeted' && (!a.conditionKey || !b.conditionKey)) continue;
    const pairKey = admissionPairKey(a.id, b.id);
    pairs.push({
      pairKey,
      a,
      b,
      pendingIds: [a.id, b.id].sort(),
      signals: signalsForBulk(a, b),
      cosine: Number(row.cos),
    });
    pairShard.set(pairKey, Math.min(Number(row.a_shard), Number(row.b_shard)));
  }

  const ghostIdsByShard = new Map<number, string[]>();
  for (const row of mapRows) {
    if (row.role !== 'ghost') continue;
    ghostIdsByShard.set(row.shard_id, [...(ghostIdsByShard.get(row.shard_id) ?? []), row.item_id]);
  }
  for (const [shard, ids] of ghostIdsByShard) ghostIdsByShard.set(shard, [...new Set(ids)].sort());

  return { items, pairs, pairShard, ghostIdsByShard, memberCount: memberRows.length };
}

export function buildBulkDedupPrompt(
  pairs: readonly PromoterPair[],
  ghostItems: readonly PromoterItem[],
): { system: string; user: string } {
  const system = buildPromoterPrompt([]).system;
  const endpointItems = new Map<string, PromoterItem>();
  for (const pair of pairs) {
    endpointItems.set(pair.a.id, pair.a);
    endpointItems.set(pair.b.id, pair.b);
  }
  const codeSet = [...endpointItems.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) =>
      [
        `## item ${item.id} state=${item.state} admission=${item.admission ?? 'legacy'} kind=${item.kind}`,
        `<title>${item.title.slice(0, 1_000)}</title>`,
        `<summary>${item.summary.slice(0, 4_000)}</summary>`,
      ].join('\n'),
    )
    .join('\n\n');
  const pairSet = pairs
    .map((pair) => `${pair.pairKey} | signals=${pair.signals.join(',')} | cosine=${pair.cosine?.toFixed(4) ?? 'n/a'}`)
    .join('\n');
  const ghosts = ghostItems
    .filter((item) => !endpointItems.has(item.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (item) =>
        `${item.id} | <title>${item.title.slice(0, 500)}</title> | <summary>${item.summary.slice(0, 1_500)}</summary>`,
    )
    .join('\n');
  const user = [
    '# CODE SET — authoritative pair endpoints',
    codeSet,
    '# PAIRS TO JUDGE',
    pairSet,
    '# READ-ONLY GHOST CONTEXT — context only; never emit a judgement for an unlisted pair',
    ghosts || '(none)',
  ].join('\n\n');
  return { system, user };
}

export function assertAdmissionCensusRatchet(before: number, after: number): void {
  if (!Number.isInteger(before) || before < 0 || !Number.isInteger(after) || after < 0) {
    throw new Error(`admission census ratchet requires non-negative integers: before=${before}, after=${after}`);
  }
  if (after > before) {
    throw new Error(`admission census ratchet violated: ${before} -> ${after} (+${after - before})`);
  }
}

async function beginBulkStage(
  sql: OrgSql,
  input: {
    runId: string;
    workspaceId: string;
    harnessSlug: string;
    scope: BulkDedupScope;
    sourceCensusRunId: string;
    pairs: number;
  },
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.admission_runs
      (id, workspace_id, harness_slug, run_kind, started_at, batch_size, detail)
    VALUES (${input.runId}, ${input.workspaceId}, ${input.harnessSlug}, 'bulk-stage', now(), ${input.pairs},
            ${JSON.stringify({
              schemaVersion: 'work-item-admission-bulk-stage-v1',
              status: 'running',
              mode: 'bulk-dedup',
              scope: input.scope,
              sourceCensusRunId: input.sourceCensusRunId,
            })}::text::jsonb)
    ON CONFLICT (id) DO NOTHING`;
}

const MAX_BULK_ERROR_CAUSE_DEPTH = 8;

/** Convert an Error.cause chain into JSON-safe evidence without losing the
 * transport code/message nested under undici's generic `fetch failed`. */
export function serializeBulkErrorCause(error: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth >= MAX_BULK_ERROR_CAUSE_DEPTH) return '[cause chain truncated]';
  if (error === null || typeof error !== 'object') return error;
  if (seen.has(error)) return '[circular cause]';
  seen.add(error);
  if (error instanceof Error) {
    const out: Record<string, unknown> = { name: error.name, message: error.message };
    const source = error as Error & {
      cause?: unknown;
      code?: unknown;
      status?: unknown;
      errno?: unknown;
      type?: unknown;
    };
    for (const key of ['code', 'status', 'errno', 'type'] as const) {
      if (source[key] !== undefined) out[key] = source[key];
    }
    if (source.cause !== undefined) out.cause = serializeBulkErrorCause(source.cause, depth + 1, seen);
    return out;
  }
  if (Array.isArray(error)) return error.slice(0, 32).map((entry) => serializeBulkErrorCause(entry, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(error).slice(0, 32)) {
    out[key] = serializeBulkErrorCause((error as Record<string, unknown>)[key], depth + 1, seen);
  }
  return out;
}

async function failBulkStage(sql: OrgSql, runId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
  await sql`
    UPDATE harness_shared.admission_runs
       SET finished_at = now(),
           detail = (COALESCE(detail, '{}'::jsonb) - 'errorCause') ||
                    ${JSON.stringify({
                      status: 'failed',
                      error: message,
                      ...(cause !== undefined ? { errorCause: serializeBulkErrorCause(cause) } : {}),
                    })}::text::jsonb
     WHERE id = ${runId}`.catch(() => undefined);
}

type BulkModelResponse = Awaited<ReturnType<PromoterLlmCall>>;

async function callBulkModelBatchWithRetry<T>(
  call: () => Promise<BulkModelResponse>,
  validate: (response: BulkModelResponse) => T,
  opts: { backoffsMs: readonly number[]; delay: (ms: number) => Promise<void> },
): Promise<{
  response: BulkModelResponse;
  value: T | null;
  retries: number;
  protocolFailures: number;
  protocolError: string | null;
  tokensIn: number;
  tokensOut: number;
}> {
  let retries = 0;
  let protocolFailures = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (;;) {
    let response: BulkModelResponse;
    try {
      response = await call();
    } catch (error) {
      if (!isTransientNetworkError(error) || retries >= opts.backoffsMs.length) throw error;
      await opts.delay(opts.backoffsMs[retries]!);
      retries += 1;
      continue;
    }
    tokensIn += response.inputTokens;
    tokensOut += response.outputTokens;
    try {
      return {
        response,
        value: validate(response),
        retries,
        protocolFailures,
        protocolError: null,
        tokensIn,
        tokensOut,
      };
    } catch (error) {
      protocolFailures += 1;
      const protocolError = error instanceof Error ? error.message : String(error);
      if (retries >= opts.backoffsMs.length) {
        return {
          response,
          value: null,
          retries,
          protocolFailures,
          protocolError,
          tokensIn,
          tokensOut,
        };
      }
      await opts.delay(opts.backoffsMs[retries]!);
      retries += 1;
    }
  }
}

async function judgeBulkPairs(
  input: BulkInput,
  opts: {
    llmCall: PromoterLlmCall;
    model: string;
    pairsPerCall: number;
    shardConcurrency: number;
    ownerId?: string;
    batchRetryBackoffsMs: readonly number[];
    batchRetryDelay: (ms: number) => Promise<void>;
  },
): Promise<{
  judgements: PromoterJudgement[];
  modelCalls: number;
  modelRetries: number;
  modelProtocolFailures: number;
  modelProtocolExhaustedBatches: number;
  modelProtocolLastError: string | null;
  ignoredUnknownJudgements: number;
  omittedExpectedJudgements: number;
  tokensIn: number;
  tokensOut: number;
}> {
  const byShard = new Map<number, PromoterPair[]>();
  for (const pair of input.pairs) {
    const shard = input.pairShard.get(pair.pairKey);
    if (shard === undefined) throw new Error(`pair ${pair.pairKey} has no authoritative shard`);
    byShard.set(shard, [...(byShard.get(shard) ?? []), pair]);
  }

  const shardEntries = [...byShard.entries()].sort((a, b) => a[0] - b[0]);
  const results = new Array<{
    judgements: PromoterJudgement[];
    modelCalls: number;
    modelRetries: number;
    modelProtocolFailures: number;
    modelProtocolExhaustedBatches: number;
    modelProtocolLastError: string | null;
    ignoredUnknownJudgements: number;
    omittedExpectedJudgements: number;
    tokensIn: number;
    tokensOut: number;
  }>(shardEntries.length);
  let nextShardIndex = 0;
  const judgeShard = async (shard: number, shardPairs: PromoterPair[]) => {
    const judgements: PromoterJudgement[] = [];
    let modelCalls = 0;
    let modelRetries = 0;
    let modelProtocolFailures = 0;
    let modelProtocolExhaustedBatches = 0;
    let modelProtocolLastError: string | null = null;
    let ignoredUnknownJudgements = 0;
    let omittedExpectedJudgements = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    const ghostItems = (input.ghostIdsByShard.get(shard) ?? [])
      .map((id) => input.items.get(id))
      .filter((item): item is PromoterItem => Boolean(item));
    for (let offset = 0; offset < shardPairs.length; offset += opts.pairsPerCall) {
      const batch = shardPairs.slice(offset, offset + opts.pairsPerCall);
      const prompt = buildBulkDedupPrompt(batch, ghostItems);
      const attempted = await callBulkModelBatchWithRetry(
        () =>
          opts.llmCall({
            model: opts.model,
            system: prompt.system,
            messages: [{ role: 'user', content: prompt.user }],
            responseFormat: 'json',
            maxTokens: bulkJudgeMaxTokens(batch.length),
            ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
          }),
        (response) => parsePromoterJudgements(responsePayload(response)),
        { backoffsMs: opts.batchRetryBackoffsMs, delay: opts.batchRetryDelay },
      );
      modelRetries += attempted.retries;
      modelProtocolFailures += attempted.protocolFailures;
      if (attempted.protocolError) modelProtocolLastError = attempted.protocolError;
      const expected = new Set(batch.map((pair) => pair.pairKey));
      const parsed = attempted.value ?? [];
      if (attempted.value === null) modelProtocolExhaustedBatches += 1;
      const accepted = parsed.filter((judgement) => expected.has(judgement.pairKey));
      ignoredUnknownJudgements += parsed.length - accepted.length;
      const returned = new Set(accepted.map((judgement) => judgement.pairKey));
      const missing = batch.map((pair) => pair.pairKey).filter((key) => !returned.has(key));
      omittedExpectedJudgements += missing.length;
      // Model text is untrusted evidence. Extra cross-pairs are ignored, while
      // omitted expected pairs flow into planPromoterDispositions' existing
      // fail-open hold path and are reconsidered in the next shrinking stage.
      judgements.push(...accepted);
      modelCalls += 1;
      tokensIn += attempted.tokensIn;
      tokensOut += attempted.tokensOut;
    }
    return {
      judgements,
      modelCalls,
      modelRetries,
      modelProtocolFailures,
      modelProtocolExhaustedBatches,
      modelProtocolLastError,
      ignoredUnknownJudgements,
      omittedExpectedJudgements,
      tokensIn,
      tokensOut,
    };
  };
  const workers = Array.from({ length: Math.min(opts.shardConcurrency, shardEntries.length) }, async () => {
    while (nextShardIndex < shardEntries.length) {
      const index = nextShardIndex;
      nextShardIndex += 1;
      const [shard, shardPairs] = shardEntries[index]!;
      results[index] = await judgeShard(shard, shardPairs);
    }
  });
  await Promise.all(workers);
  return {
    judgements: results.flatMap((result) => result.judgements),
    modelCalls: results.reduce((sum, result) => sum + result.modelCalls, 0),
    modelRetries: results.reduce((sum, result) => sum + result.modelRetries, 0),
    modelProtocolFailures: results.reduce((sum, result) => sum + result.modelProtocolFailures, 0),
    modelProtocolExhaustedBatches: results.reduce((sum, result) => sum + result.modelProtocolExhaustedBatches, 0),
    modelProtocolLastError:
      results
        .map((result) => result.modelProtocolLastError)
        .filter((error): error is string => Boolean(error))
        .at(-1) ?? null,
    ignoredUnknownJudgements: results.reduce((sum, result) => sum + result.ignoredUnknownJudgements, 0),
    omittedExpectedJudgements: results.reduce((sum, result) => sum + result.omittedExpectedJudgements, 0),
    tokensIn: results.reduce((sum, result) => sum + result.tokensIn, 0),
    tokensOut: results.reduce((sum, result) => sum + result.tokensOut, 0),
  };
}

export async function runWorkItemAdmissionBulkDedup(opts: BulkDedupRunOptions): Promise<BulkDedupRunResult> {
  const sql = opts.sql ?? getOrgPg().sql;
  const now = opts.now ?? Date.now;
  const rootRunId = opts.runId ?? `bulk-dedup-${now()}-${randomUUID().slice(0, 8)}`;
  const maxStages = Math.max(1, Math.floor(opts.maxStages ?? DEFAULT_BULK_MAX_STAGES));
  // Clamp to what ONE batch's output budget can actually hold. A larger request
  // does not produce a bigger answer, it produces a TRUNCATED one that fails
  // parsing identically on every retry (see BULK_JUDGE_MAX_OUTPUT_TOKENS).
  const pairsPerCall = Math.max(
    1,
    Math.min(
      maxPairsForOutputBudget(),
      Math.min(200, Math.floor(opts.pairsPerCall ?? DEFAULT_BULK_PAIRS_PER_CALL)),
    ),
  );
  const shardConcurrency = Math.max(
    1,
    Math.min(16, Math.floor(opts.shardConcurrency ?? DEFAULT_BULK_SHARD_CONCURRENCY)),
  );
  const batchRetryBackoffsMs = (opts.batchRetryBackoffsMs ?? DEFAULT_BULK_BATCH_RETRY_BACKOFFS_MS).filter(
    (delayMs) => Number.isFinite(delayMs) && delayMs >= 0,
  );
  const batchRetryDelay =
    opts.batchRetryDelay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const runCensus = opts.runCensus ?? runWorkItemAdmissionCensus;
  // Resolved ONCE and used for both the model calls and the ledger write, so
  // `admission_runs.model_id` can never disagree with the model that ran.
  const model = opts.model?.trim() || LEARNING_MODEL_SPEC;
  const censusBase = {
    ...(opts.census ?? {}),
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
  };

  let census = await runCensus({ ...censusBase, sql, runId: `${rootRunId}-census-0` });
  const initialCensus = census.censusAfter;
  const scope = census.projection.recommendedBulkScope;
  const stageLimit = scope === 'machine-emitter-targeted' ? 1 : maxStages;
  const stages: BulkDedupStageResult[] = [];

  for (let stageIndex = 1; stageIndex <= stageLimit; stageIndex += 1) {
    const input = await readBulkInput(sql, {
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      censusRunId: census.runId,
      expectedMembers: census.corpusSize,
      scope,
    });
    const stageRunId = `${rootRunId}-stage-${stageIndex}`;
    await beginBulkStage(sql, {
      runId: stageRunId,
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      scope,
      sourceCensusRunId: census.runId,
      pairs: input.pairs.length,
    });

    if (input.pairs.length === 0) {
      const convergenceReason = census.censusAfter === 0 ? 'global-zero' : 'scope-zero';
      await sql`
        UPDATE harness_shared.admission_runs
           SET finished_at = now(), promoted = 0, merged = 0, held = 0,
               census_before = ${census.censusAfter}, census_after = ${census.censusAfter},
               model_id = NULL, tokens_in = 0, tokens_out = 0, latency_ms = 0,
               detail = detail || ${JSON.stringify({
                 status: 'complete',
                 convergence: convergenceReason,
                 resultCensusRunId: census.runId,
                 scopedPairsAfter: 0,
               })}::text::jsonb
         WHERE id = ${stageRunId}`;
      stages.push({
        runId: stageRunId,
        sourceCensusRunId: census.runId,
        resultCensusRunId: census.runId,
        scope,
        pairs: 0,
        merged: 0,
        held: 0,
        modelCalls: 0,
        modelRetries: 0,
        modelProtocolFailures: 0,
        modelProtocolExhaustedBatches: 0,
        ignoredUnknownJudgements: 0,
        omittedExpectedJudgements: 0,
        tokensIn: 0,
        tokensOut: 0,
        censusBefore: census.censusAfter,
        censusAfter: census.censusAfter,
        scopedPairsAfter: 0,
      });
      return {
        runId: rootRunId,
        scope,
        converged: true,
        convergenceReason,
        initialCensus,
        finalCensus: census.censusAfter,
        finalScopedPairs: 0,
        stages,
      };
    }

    const startedAt = now();
    try {
      const judged = await judgeBulkPairs(input, {
        llmCall: opts.llmCall,
        model,
        pairsPerCall,
        shardConcurrency,
        ownerId: opts.ownerId,
        batchRetryBackoffsMs,
        batchRetryDelay,
      });
      const itemIds = new Set(input.pairs.flatMap((pair) => [pair.a.id, pair.b.id]));
      const stageItems = [...itemIds].map((id) => input.items.get(id)!).filter(Boolean);
      const plan = planPromoterDispositions(stageItems, input.pairs, judged.judgements);
      const merged = plan.dispositions.filter((disposition) => disposition.action === 'merge').length;
      const held = plan.dispositions.filter((disposition) => disposition.action === 'hold').length;
      let committed:
        | { census: AdmissionCensusRunResult; scopedPairsAfter: number; stage: BulkDedupStageResult }
        | undefined;

      await sql.begin(async (rawTx) => {
        const tx = rawTx as unknown as OrgSql;
        await persistAdmissionPlan(tx, {
          workspaceId: opts.workspaceId,
          harnessSlug: opts.harnessSlug,
          runId: stageRunId,
          modelId: model,
          nowMs: now(),
          pending: stageItems,
          plan,
          promoteUnmerged: false,
          mergeAnyAdmission: true,
          actor: BULK_DEDUP_ACTOR,
        });
        await opts.beforePostStageCensus?.(tx, stageIndex);
        const nextCensus = await runCensus({
          ...censusBase,
          sql: tx,
          withinTransaction: true,
          runId: `${stageRunId}-census-after`,
        });
        assertAdmissionCensusRatchet(census.censusAfter, nextCensus.censusAfter);
        const nextInput = await readBulkInput(tx, {
          workspaceId: opts.workspaceId,
          harnessSlug: opts.harnessSlug,
          censusRunId: nextCensus.runId,
          expectedMembers: nextCensus.corpusSize,
          scope,
        });
        const stage: BulkDedupStageResult = {
          runId: stageRunId,
          sourceCensusRunId: census.runId,
          resultCensusRunId: nextCensus.runId,
          scope,
          pairs: input.pairs.length,
          merged,
          held,
          modelCalls: judged.modelCalls,
          modelRetries: judged.modelRetries,
          modelProtocolFailures: judged.modelProtocolFailures,
          modelProtocolExhaustedBatches: judged.modelProtocolExhaustedBatches,
          ignoredUnknownJudgements: judged.ignoredUnknownJudgements,
          omittedExpectedJudgements: judged.omittedExpectedJudgements,
          tokensIn: judged.tokensIn,
          tokensOut: judged.tokensOut,
          censusBefore: census.censusAfter,
          censusAfter: nextCensus.censusAfter,
          scopedPairsAfter: nextInput.pairs.length,
        };
        const verdicts = plan.adjudications.reduce<Record<string, number>>((acc, row) => {
          acc[row.verdict] = (acc[row.verdict] ?? 0) + 1;
          return acc;
        }, {});
        await tx`
          UPDATE harness_shared.admission_runs
             SET finished_at = now(), promoted = 0, merged = ${merged}, held = ${held},
                 census_before = ${census.censusAfter}, census_after = ${nextCensus.censusAfter},
                 model_id = ${model}, tokens_in = ${judged.tokensIn}, tokens_out = ${judged.tokensOut},
                 latency_ms = ${Math.max(0, now() - startedAt)},
                 detail = detail || ${JSON.stringify({
                   status: 'complete',
                   resultCensusRunId: nextCensus.runId,
                   scopedPairsBefore: input.pairs.length,
                   scopedPairsAfter: nextInput.pairs.length,
                   convergence:
                     nextInput.pairs.length === 0
                       ? nextCensus.censusAfter === 0
                         ? 'global-zero'
                         : 'scope-zero'
                       : null,
                   modelCalls: judged.modelCalls,
                   modelRetries: judged.modelRetries,
                   modelProtocol: {
                     failures: judged.modelProtocolFailures,
                     exhaustedBatches: judged.modelProtocolExhaustedBatches,
                     lastError: judged.modelProtocolLastError,
                     ignoredUnknownJudgements: judged.ignoredUnknownJudgements,
                     omittedExpectedJudgements: judged.omittedExpectedJudgements,
                   },
                   verdicts,
                   ratchet: { before: census.censusAfter, after: nextCensus.censusAfter, ok: true },
                 })}::text::jsonb
           WHERE id = ${stageRunId}`;
        committed = { census: nextCensus, scopedPairsAfter: nextInput.pairs.length, stage };
      });

      if (!committed) throw new Error(`bulk stage ${stageRunId} committed without a result`);
      stages.push(committed.stage);
      if (committed.scopedPairsAfter === 0) {
        const convergenceReason = committed.census.censusAfter === 0 ? 'global-zero' : 'scope-zero';
        return {
          runId: rootRunId,
          scope,
          converged: true,
          convergenceReason,
          initialCensus,
          finalCensus: committed.census.censusAfter,
          finalScopedPairs: 0,
          stages,
        };
      }
      if (committed.scopedPairsAfter >= input.pairs.length) {
        throw new Error(
          `bulk dedup made no scoped progress: ${input.pairs.length} -> ${committed.scopedPairsAfter} pair(s)`,
        );
      }
      census = committed.census;
    } catch (error) {
      await failBulkStage(sql, stageRunId, error);
      throw error;
    }
  }

  throw new Error(`bulk dedup did not converge within ${stageLimit} stage(s)`);
}
