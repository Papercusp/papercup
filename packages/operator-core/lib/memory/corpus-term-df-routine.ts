/**
 * corpus-term-df-routine — the refresh cadence for the P-018 / D-064 corpus
 * document-frequency table.
 *
 * A `harness_shared.routines` row with `target_role='system:corpus-term-df'`,
 * `tier='ephemeral'` — a bounded in-process sweep armed by the per-host
 * ephemeral executor (`lib/dbos/ephemeral-executor.ts`), NEVER a bare
 * `setInterval` (`lint:no-raw-setinterval`). Mirrors `hive-git-gc-routine.ts`'s
 * seed/read shape.
 *
 * The row carries no cron / next_fire_at: ephemeral rows are excluded from the
 * DBOS `routinesTick`'s `tier='durable'` filter, and `trigger_config.interval_sec`
 * is the cadence the ephemeral executor reads directly.
 *
 * ⚠ CADENCE IS DELIBERATELY SLOW, and slower than it "could" be. The refresh
 * folds tens of thousands of documents through `corpusTerms`, but that is not
 * why — what matters is that DF only feeds a RANKING among ~100 candidate terms.
 * A term's position in that ordering does not turn over on the timescale the
 * corpus grows, so a faster cadence would buy no ranking change and spend real
 * CPU on a shared box. Staleness here is bounded, not eliminated, on purpose.
 */
import type { Sql } from 'postgres';

export const CORPUS_TERM_DF_ROUTINE_NAME = 'corpus-term-df';
export const CORPUS_TERM_DF_TARGET = 'system:corpus-term-df';

/** Every 6 hours. See the cadence note above — this is a ranking signal, not a
 *  freshness-critical one. */
export const DEFAULT_CORPUS_TERM_DF_INTERVAL_SEC = 6 * 60 * 60;

export interface CorpusTermDfRoutineInput {
  /** Owning workspace_id (routines.workspace_id is NOT NULL, no default). */
  workspaceId: string;
  /** The harness install slug this row belongs to. */
  installSlug: string;
  intervalSec?: number;
  sampleDocs?: number;
  /** Defaults ACTIVE: the table is additive — until it is first populated the
   *  lookup returns null and the leg keeps its original length ordering, so
   *  there is nothing to stage dark. */
  active?: boolean;
}

function routineId(installSlug: string, name: string): string {
  return `rt_${installSlug}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

/**
 * Upsert the workspace's `system:corpus-term-df` ephemeral routine. Idempotent
 * on (install_slug, name) — a bare re-materialize never clobbers a human-edited
 * `active` toggle; pass `active` explicitly to change it.
 */
export async function upsertCorpusTermDfRoutine(
  sql: Sql,
  input: CorpusTermDfRoutineInput,
): Promise<{ id: string }> {
  const id = routineId(input.installSlug, CORPUS_TERM_DF_ROUTINE_NAME);
  const triggerConfig = JSON.stringify({
    interval_sec: input.intervalSec ?? DEFAULT_CORPUS_TERM_DF_INTERVAL_SEC,
    ...(input.sampleDocs != null ? { sample_docs: input.sampleDocs } : {}),
  });

  // `trigger_kind` is NOT NULL and stays 'cron' even for an ephemeral row —
  // the column describes the row's SHAPE, while `tier='ephemeral'` is what
  // routes it to the per-host executor instead of the DBOS `routinesTick`
  // (which filters `tier='durable'`). `next_fire_at` is NULL for the same
  // reason: schedule-next computation is meaningless here, the executor reads
  // `trigger_config.interval_sec` directly. Mirrors hive-git-gc-routine.ts.
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, tier, next_fire_at, workspace_id)
    VALUES (
      ${id}, ${input.installSlug}, ${CORPUS_TERM_DF_ROUTINE_NAME}, 'cron',
      ${triggerConfig}::text::jsonb, ${CORPUS_TERM_DF_TARGET},
      'skip', 'skip-old', ${input.active ?? true}, 'ephemeral', NULL, ${input.workspaceId}
    )
    ON CONFLICT (install_slug, name) DO UPDATE SET
      trigger_kind   = EXCLUDED.trigger_kind,
      trigger_config = EXCLUDED.trigger_config,
      target_role    = EXCLUDED.target_role,
      tier           = EXCLUDED.tier,
      -- active is deliberately NOT re-applied: a bare re-seed must never clobber
      -- an operator's runtime pause of this routine (EI-19301170070808928).
      updated_at     = now()
  `;

  return { id };
}
