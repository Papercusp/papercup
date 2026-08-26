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
  census?: Omit<AdmissionCensusRunOptions, 'workspaceId' | 'harnessSlug' | 'sql' | 'runId' | 'withinTransaction'>;
  now?: () => number;
  /** Dependency seam used by the real-PG recurrence guard to inject a census rise. */
  beforePostStageCensus?: (sql: OrgSql, stageIndex: number) => Promise<void>;
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

async function failBulkStage(sql: OrgSql, runId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await sql`
    UPDATE harness_shared.admission_runs
       SET finished_at = now(),
           detail = COALESCE(detail, '{}'::jsonb) ||
                    ${JSON.stringify({ status: 'failed', error: message })}::text::jsonb
     WHERE id = ${runId}`.catch(() => undefined);
}

async function judgeBulkPairs(
  input: BulkInput,
  opts: { llmCall: PromoterLlmCall; pairsPerCall: number },
): Promise<{ judgements: PromoterJudgement[]; modelCalls: number; tokensIn: number; tokensOut: number }> {
  const byShard = new Map<number, PromoterPair[]>();
  for (const pair of input.pairs) {
    const shard = input.pairShard.get(pair.pairKey);
    if (shard === undefined) throw new Error(`pair ${pair.pairKey} has no authoritative shard`);
    byShard.set(shard, [...(byShard.get(shard) ?? []), pair]);
  }

  const judgements: PromoterJudgement[] = [];
  let modelCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const [shard, shardPairs] of [...byShard.entries()].sort((a, b) => a[0] - b[0])) {
    const ghostItems = (input.ghostIdsByShard.get(shard) ?? [])
      .map((id) => input.items.get(id))
      .filter((item): item is PromoterItem => Boolean(item));
    for (let offset = 0; offset < shardPairs.length; offset += opts.pairsPerCall) {
      const batch = shardPairs.slice(offset, offset + opts.pairsPerCall);
      const prompt = buildBulkDedupPrompt(batch, ghostItems);
      const response = await opts.llmCall({
        model: LEARNING_MODEL_SPEC,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        responseFormat: 'json',
        maxTokens: Math.min(8_000, 500 + batch.length * 180),
      });
      const parsed = parsePromoterJudgements(responsePayload(response));
      const expected = new Set(batch.map((pair) => pair.pairKey));
      const unknown = parsed.find((judgement) => !expected.has(judgement.pairKey));
      if (unknown) throw new Error(`bulk model returned unknown pairKey ${unknown.pairKey}`);
      const returned = new Set(parsed.map((judgement) => judgement.pairKey));
      const missing = batch.map((pair) => pair.pairKey).filter((key) => !returned.has(key));
      if (missing.length > 0) throw new Error(`bulk model omitted pairKey(s): ${missing.join(', ')}`);
      judgements.push(...parsed);
      modelCalls += 1;
      tokensIn += response.inputTokens;
      tokensOut += response.outputTokens;
    }
  }
  return { judgements, modelCalls, tokensIn, tokensOut };
}

export async function runWorkItemAdmissionBulkDedup(opts: BulkDedupRunOptions): Promise<BulkDedupRunResult> {
  const sql = opts.sql ?? getOrgPg().sql;
  const now = opts.now ?? Date.now;
  const rootRunId = opts.runId ?? `bulk-dedup-${now()}-${randomUUID().slice(0, 8)}`;
  const maxStages = Math.max(1, Math.floor(opts.maxStages ?? DEFAULT_BULK_MAX_STAGES));
  const pairsPerCall = Math.max(1, Math.min(200, Math.floor(opts.pairsPerCall ?? DEFAULT_BULK_PAIRS_PER_CALL)));
  const runCensus = opts.runCensus ?? runWorkItemAdmissionCensus;
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
      const judged = await judgeBulkPairs(input, { llmCall: opts.llmCall, pairsPerCall });
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
          modelId: LEARNING_MODEL_SPEC,
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
                 model_id = ${LEARNING_MODEL_SPEC}, tokens_in = ${judged.tokensIn}, tokens_out = ${judged.tokensOut},
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
