/**
 * Embed-backfill worker for Plan 2B+C.
 *
 * Walks the prose surfaces (operator_turns, harness_escalations,
 * harness_brainstorm, harness_decisions, session_turns) looking for rows
 * that lack a vector IN THE ACTIVE EMBEDDING SPACE, and fills them in
 * batches using the same OpenAI/local cascade mem0 uses (so embeddings
 * live in the same 384-D space as memories — future cross-pollination
 * becomes possible).
 *
 * Cadence: one sweep at boot (instrumentation-node.ts), then idle.
 * New rows after boot are backfilled by the next boot. We don't add
 * a trigger-on-insert path because embeddings need network calls and
 * the writer should never block on them.
 *
 * Resumable: state is "where the row's embedding is missing OR was produced by a
 * DIFFERENT embedder than the active one" (migration 530's `<embedCol>_mode`
 * discriminator). Restart picks up naturally. Failure on a single row counts as
 * an error and skips forward; we don't poison the whole sweep.
 *
 * WI-3616: that predicate used to be plain `IS NULL`, which silently assumed a
 * vector, once written, stayed valid forever. It doesn't. `memoryEmbedderMode`
 * chooses the embedder at runtime and ALSO drives the query vector, so flipping it
 * strands every stored vector in a foreign 384-D space — same width, no error, pure
 * noise at query time — and the NULL-only predicate never revisited them, so the
 * column could never self-heal. Tagging each vector with its space lets the sweep
 * converge a switched column back onto one space.
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { getResourceProfile } from '../resource-profile';
import { embedAdmission, headersToRecord, retryAfterMs } from '../memory/embed-admission';
import {
  resolveEmbedderWith,
  readEmbedderPreference,
  resolveOpenAiKey,
  localAvailable,
  isOpenAiEmbedInCooldown,
} from '../memory/configure';
import { buildGemmaEmbedder, type EmbedFn, type ResolvedEmbedder } from '@papercusp/memory';

// Exported for embed-space-self-check.ts (WI-3644): the expected vector width.
export const EMBEDDER_DIM = 384;
const OPENAI_EMBEDDER_MODEL = 'text-embedding-3-small';
const LOCAL_EMBEDDER_MODEL = 'Xenova/bge-small-en-v1.5';
// F-E5 (app-wide-load-traps § E): hardware-adaptive embed batch — a big host
// pushes bigger batches for throughput, a laptop keeps latency/memory down.
const BATCH_SIZE = getResourceProfile().embedBatchSize;

type ResolvedMode = 'openai' | 'local' | 'gemma' | 'disabled';

interface BackfillStats {
  table: string;
  scanned: number;
  embedded: number;
  errors: number;
  durationMs: number;
}

function buildAdmissionGovernedOpenAiEmbedder(key: string): EmbedFn {
  return async (text: string): Promise<number[]> => {
    // Route the backfill through the SHARED embed-admission governor (cost-audit-2026-06-29).
    // This sweep previously fired RAW, UNGOVERNED OpenAI embeds every 5 min — the one embed path
    // that bypassed the governor, so neither the org-TPM rate cap NOR the daily spend cap applied
    // to it. Use the 'bench' lane (lowest priority): under rate contention it sheds first, and the
    // daily-budget cap throws EmbedBudgetExhaustedError → the per-row catch in backfillTable counts
    // it as an error and skips, so a runaway can't drain the key. A bench-lane SHED (null slot)
    // likewise skips the row; the next sweep retries.
    const adm = embedAdmission();
    const slot = await adm.acquire(text, 'bench'); // throws EmbedBudgetExhaustedError when over the daily cap
    if (slot === null) throw new Error('openai_embed_admission_shed');
    try {
      const r = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: OPENAI_EMBEDDER_MODEL,
          input: text,
          dimensions: EMBEDDER_DIM,
        }),
      });
      adm.recordResponse(headersToRecord(r.headers));
      if (!r.ok) {
        if (r.status === 429) adm.penalize({ retryAfterMs: retryAfterMs(headersToRecord(r.headers)) });
        throw new Error(`openai_embed_${r.status}`);
      }
      const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
      return j.data[0].embedding;
    } finally {
      slot.release();
    }
  };
}

async function buildLocalTransformersEmbedder(): Promise<EmbedFn> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dynamicImport = new Function('s', 'return import(s)') as any;
  const transformers = await dynamicImport('@huggingface/transformers');
  const pipe = await transformers.pipeline('feature-extraction', LOCAL_EMBEDDER_MODEL);
  return async (text: string): Promise<number[]> => {
    const result = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(result.data) as number[];
  };
}

/**
 * Resolve BOTH which embedder to use AND build it, via the SAME cascade
 * mem0 uses (`memory/configure.ts`'s `resolveEmbedderWith`, EI-8913). This
 * sweep used to re-derive its own openai/local/disabled decision independently
 * (no OpenAI post-failure-cooldown awareness) — a desync here silently
 * strands freshly-backfilled rows in a DIFFERENT embedding space than a
 * concurrent memory:remember/search would pick, defeating the whole point of
 * migration 530's per-row mode discriminator. Only the embed-fn BODIES
 * (admission-governed OpenAI fetch, local-transformers pipeline) stay bespoke
 * to this backfill sweep.
 */
// Exported for embed-space-self-check.ts (WI-3644 / EI-8913 detector half):
// the self-check must resolve+build the embedder through the EXACT SAME
// governed cascade (admission-governed OpenAI fetch, cooldown-awareness) as
// the backfill sweep — duplicating buildAdmissionGovernedOpenAiEmbedder would
// recreate the ungoverned-OpenAI-call bug class this module's own comments
// already document being fixed once (cost-audit-2026-06-29).
export async function resolveBackfillEmbedder(): Promise<ResolvedEmbedder> {
  return resolveEmbedderWith({
    readPreference: readEmbedderPreference,
    resolveKey: resolveOpenAiKey,
    localInstalled: localAvailable,
    isOpenAiRecentlyExhausted: isOpenAiEmbedInCooldown,
    buildOpenAi: buildAdmissionGovernedOpenAiEmbedder,
    buildLocal: buildLocalTransformersEmbedder,
    // Prose backfill is STORAGE, so EmbeddingGemma gets the document prompt.
    buildGemma: async () => buildGemmaEmbedder({ kind: 'document' }),
  });
}

// Exported for embed-space-self-check.ts (WI-3644): the self-check picks a
// row from one of these SAME prose surfaces to re-embed and compare.
export interface BackfillTarget {
  table: string;
  embedCol: string;
  bodySql: string;
  /**
   * PRIMARY KEY column(s) used to target the row's UPDATE.
   *
   * cost-audit-2026-06-29: this was `idCol?: 'ctid'` for 3 of the 4 tables. `ctid` is a PHYSICAL
   * row pointer that CHANGES on any UPDATE or (auto)VACUUM, which caused two bugs: (1) if a row's
   * ctid drifted between the SELECT and the `UPDATE … WHERE ctid=$` the update matched NOTHING, the
   * embedding stayed NULL, and the row was RE-EMBEDDED every 5-min sweep forever (token burn); and
   * (2) a ctid reused by a different row could write one row's embedding onto another (corruption).
   * Keying by the real PRIMARY KEY (stable, unique) eliminates both. These are the actual PKs:
   * operator_turns(id) · harness_escalations(harness_slug,phase) · harness_brainstorm(harness_slug,
   * phase) · harness_decisions(harness_slug,line_hash).
   */
  keyCols: string[];
}

/** The column (migration 530) recording which embedder produced a row's vector. */
export function modeColOf(target: BackfillTarget): string {
  return `${target.embedCol}_mode`;
}

// Exported for embed-space-self-check.ts (WI-3644): the canonical set of
// embedded prose surfaces, reused rather than re-listed so the self-check
// never drifts from what the backfill sweep actually maintains.
export const TARGETS: BackfillTarget[] = [
  {
    table: 'harness_shared.harness_escalations',
    embedCol: 'body_embedding',
    bodySql: `COALESCE(escalation, '') || E'\\n' || COALESCE(supervisor_notes, '')`,
    keyCols: ['harness_slug', 'phase'],
  },
  {
    table: 'harness_shared.harness_brainstorm',
    embedCol: 'content_embedding',
    bodySql: 'content',
    keyCols: ['harness_slug', 'phase'],
  },
  {
    table: 'harness_shared.operator_turns',
    embedCol: 'text_embedding',
    bodySql: 'text',
    keyCols: ['id'],
  },
  {
    table: 'harness_shared.harness_decisions',
    embedCol: 'body_embedding',
    bodySql: `COALESCE(verb, '') || ' ' || COALESCE(args, '')`,
    keyCols: ['harness_slug', 'line_hash'],
  },
  // session-search-scope-2026-07-05: the episodic transcript index. Embed
  // SELECTIVELY — only turns >= 80 chars (short acks are noise for semantic
  // recall; they stay BM25-searchable via text_tsv), truncated to 2k chars for
  // the embed call. The CASE returns '' for skipped rows, which the
  // `length(bodySql) > 0` guard in backfillTable excludes from the sweep
  // entirely, so skipped turns are never re-scanned. Volume is governed by the
  // shared embed-admission bench lane — a big backlog fills progressively
  // across 5-min ticks, never in one burst.
  {
    table: 'harness_shared.session_turns',
    embedCol: 'text_embedding',
    bodySql: `CASE WHEN length(text) >= 80 THEN left(text, 2000) ELSE '' END`,
    keyCols: ['workspace_id', 'source_kind', 'session_id', 'turn_idx'],
  },
];

/**
 * WI-2905 fairness cap: max rows one table may consume in ONE sweep. Without it
 * the per-table `while(true)` drains until the DAILY budget exhausts, so the
 * first backlogged table in the order eats the whole day's tokens and every
 * later table gets 0 — session_turns' 70k-row backlog sat at 1 embedded row
 * while operator_turns burned the cap every day. 4 batches/table/sweep at a
 * 5-min cadence still clears ~48×BATCH_SIZE rows/table/day, but no table can
 * starve another; the daily cap now spreads across ALL targets.
 */
const MAX_ROWS_PER_TARGET_PER_SWEEP = BATCH_SIZE * 4;

/** Exported for unit tests (the WI-2905 per-sweep cap); production callers go
 *  through runBackfillSweep and never pass maxRows explicitly.
 *
 *  `mode` is the embedder that `embed` was built from. When the target carries a
 *  `<embedCol>_mode` column (migration 530), rows whose recorded space differs from
 *  `mode` are RE-EMBEDDED, not skipped — see the WI-3616 note on `spaceAware`.
 *  Pass `spaceAware: false` for a database where 530 hasn't been applied yet. */
export async function backfillTable(
  sql: Sql,
  target: BackfillTarget,
  embed: (t: string) => Promise<number[]>,
  maxRows: number = MAX_ROWS_PER_TARGET_PER_SWEEP,
  mode: ResolvedMode = 'openai',
  spaceAware = true,
): Promise<BackfillStats> {
  const started = Date.now();
  const stats: BackfillStats = {
    table: target.table,
    scanned: 0,
    embedded: 0,
    errors: 0,
    durationMs: 0,
  };
  const keyCols = target.keyCols;
  // Select each PK column as k0, k1, … so the UPDATE can target the exact row by PK (not ctid).
  const keySelect = keyCols.map((c, i) => `${c} AS k${i}`).join(', ');
  const modeCol = modeColOf(target);
  // Postgres derives a statement's parameter COUNT from the highest $n it references,
  // and rejects a Bind that supplies a parameter the statement never uses ("could not
  // determine data type of parameter $n"). So the mode placeholder — and therefore the
  // PK offset — exists only on the space-aware path. Never bind `mode` without using it.
  const updateKeyOffset = spaceAware ? 3 : 2;
  const whereKeys = keyCols.map((c, i) => `${c} = $${i + updateKeyOffset}`).join(' AND ');

  /**
   * WI-3616 — "which rows still need embedding?" is a question about the vector's
   * SPACE, not merely its presence.
   *
   * This predicate used to be `embedCol IS NULL`. But `memoryEmbedderMode` picks the
   * embedder at runtime, and the same pref drives the QUERY vector. Flip it and every
   * previously-stored vector silently belongs to a foreign space: still 384-D, still
   * non-null, so the old predicate skipped them forever while queries ranked against
   * them as noise. A column that went mixed could never self-heal.
   *
   * Selecting `mode IS DISTINCT FROM <active>` (NULL-safe: pre-530 rows have mode NULL
   * ⇒ unknown ⇒ stale ⇒ re-embed) makes the sweep converge the whole column onto the
   * active space, then go quiet. `IS DISTINCT FROM` — not `<> ` — because `NULL <> 'local'`
   * is NULL, which would silently match nothing and reintroduce the original bug.
   */
  const stale = spaceAware
    ? `(${target.embedCol} IS NULL OR ${modeCol} IS DISTINCT FROM $2)`
    : `${target.embedCol} IS NULL`;

  // Loop until nothing is stale — OR until a full batch makes ZERO progress (every row failed to
  // embed). Without the zero-progress break, a row whose embed PERSISTENTLY fails (e.g. every
  // request 429s during a quota outage, or an over-long body 400s) stays stale and is re-SELECTed
  // by the next `WHERE … LIMIT` pull, spinning this `while(true)` forever and re-burning
  // tokens. Breaking on no-progress bounds the sweep and lets the next 5-min tick retry. (cost-audit-2026-06-29.)
  while (stats.scanned < maxRows) {
    // All PK columns here are text/uuid and the body is text → every selected value is a string.
    const batch = await sql.unsafe<Array<Record<string, string>>>(
      `SELECT ${keySelect}, (${target.bodySql}) AS body
         FROM ${target.table}
        WHERE ${stale}
          AND length(${target.bodySql}) > 0
        LIMIT $1`,
      spaceAware
        ? [Math.min(BATCH_SIZE, maxRows - stats.scanned), mode]
        : [Math.min(BATCH_SIZE, maxRows - stats.scanned)],
    );
    if (!batch.length) break;

    let embeddedThisBatch = 0;
    for (const row of batch) {
      stats.scanned += 1;
      try {
        const vec = await embed(row.body);
        if (vec.length !== EMBEDDER_DIM) {
          stats.errors += 1;
          continue;
        }
        const keyVals = keyCols.map((_, i) => row[`k${i}`]);
        // Target by PRIMARY KEY + re-assert the staleness guard: a row a concurrent sweep
        // already brought into the active space is left alone, and we never clobber a row
        // that changed underneath us. The vector and its space are written together, so a
        // row can never claim a space it isn't in.
        await sql.unsafe(
          spaceAware
            ? `UPDATE ${target.table}
                  SET ${target.embedCol} = $1::vector, ${modeCol} = $2
                WHERE ${whereKeys}
                  AND (${target.embedCol} IS NULL OR ${modeCol} IS DISTINCT FROM $2)`
            : `UPDATE ${target.table}
                  SET ${target.embedCol} = $1::vector
                WHERE ${whereKeys}
                  AND ${target.embedCol} IS NULL`,
          spaceAware
            ? [`[${vec.join(',')}]`, mode, ...keyVals]
            : [`[${vec.join(',')}]`, ...keyVals],
        );
        stats.embedded += 1;
        embeddedThisBatch += 1;
      } catch {
        stats.errors += 1;
      }
    }
    // No row in this batch embedded → the remaining stale rows are persistent failures. Stop, else
    // we re-SELECT and re-attempt the same stuck rows forever (and re-spend on each).
    if (embeddedThisBatch === 0) break;
  }

  stats.durationMs = Date.now() - started;
  return stats;
}

// Sweep state pinned to globalThis (perf rule A18, audit P-010): under tsx /
// dual-path imports a module can be instantiated more than once, and a
// module-scoped `running` flag then no longer dedupes concurrent sweeps.
interface SweepState {
  running: boolean;
  lastResult: BackfillStats[] | null;
  /** WI-2905: per-sweep rotation offset — which target leads THIS sweep. */
  sweepCounter: number;
}
const __sweepStateKey = Symbol.for('papercusp.embedBackfillSweepState');
const __sweepState: SweepState = (() => {
  const g = globalThis as typeof globalThis & { [__sweepStateKey]?: SweepState };
  if (!g[__sweepStateKey]) g[__sweepStateKey] = { running: false, lastResult: null, sweepCounter: 0 };
  // Upgrade an older pinned shape (pre-WI-2905) in place.
  if (typeof g[__sweepStateKey]!.sweepCounter !== 'number') g[__sweepStateKey]!.sweepCounter = 0;
  return g[__sweepStateKey]!;
})();

export function getLastBackfillResult(): BackfillStats[] | null {
  return __sweepState.lastResult;
}

/**
 * Run a single sweep across all 3 surfaces.
 *
 * Returns per-table stats. Safe to call repeatedly — the second call
 * exits immediately if a sweep is already in flight.
 */
export async function runBackfillSweep(): Promise<BackfillStats[] | { skipped: string }> {
  if (__sweepState.running) return { skipped: 'already_running' };
  __sweepState.running = true;
  try {
    const resolved = await resolveBackfillEmbedder();
    if (resolved.mode === 'disabled') {
      __sweepState.lastResult = TARGETS.map((t) => ({
        table: t.table,
        scanned: 0,
        embedded: 0,
        errors: 0,
        durationMs: 0,
      }));
      return __sweepState.lastResult;
    }
    const mode: ResolvedMode = resolved.mode;
    const embed = resolved.embed;
    // Shared org pool (audit P-010, EI-119/EI-80): the old shape opened a
    // fresh `pg.Client` per sweep — connection churn every 5 minutes, and the
    // `pg` dependency was the "require is not defined" failure mode that
    // silently stopped embeddings.
    const { sql } = getOrgPg();
    // Probe vector extension; if missing, exit silently.
    const ext = await sql.unsafe<Array<{ extname: string }>>(
      `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
    );
    if (!ext.length) {
      __sweepState.lastResult = TARGETS.map((t) => ({
        table: t.table, scanned: 0, embedded: 0, errors: 0, durationMs: 0,
      }));
      return __sweepState.lastResult;
    }

    // WI-2905 fairness: ROTATE which target leads each sweep. Combined with the
    // per-target row cap, no single backlogged table can monopolize the shared
    // daily embed budget: if the budget exhausts mid-sweep, the table that paid
    // the price differs every tick, so every target drains over the day. Results
    // are re-ordered back to the canonical TARGETS order below for stable logs.
    const offset = __sweepState.sweepCounter % TARGETS.length;
    __sweepState.sweepCounter += 1;
    const rotated = [...TARGETS.slice(offset), ...TARGETS.slice(0, offset)];

    const byTable = new Map<string, BackfillStats>();
    for (const target of rotated) {
      try {
        // Column existence probe; skip if migration 061 hasn't run. The same probe
        // reports whether migration 530's `<embedCol>_mode` discriminator exists —
        // without it the sweep must fall back to the legacy NULL-only predicate
        // (an older DB still backfills; it just can't self-heal a space switch).
        const c = await sql.unsafe<Array<{ column_name: string }>>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = split_part($1, '.', 1)
              AND table_name   = split_part($1, '.', 2)
              AND column_name  IN ($2, $3)`,
          [target.table, target.embedCol, modeColOf(target)],
        );
        const cols = new Set(c.map((r) => r.column_name));
        if (!cols.has(target.embedCol)) {
          byTable.set(target.table, { table: target.table, scanned: 0, embedded: 0, errors: 0, durationMs: 0 });
          continue;
        }
        const spaceAware = cols.has(modeColOf(target));
        byTable.set(
          target.table,
          await backfillTable(sql, target, embed, MAX_ROWS_PER_TARGET_PER_SWEEP, mode, spaceAware),
        );
      } catch (err) {
        byTable.set(target.table, {
          table: target.table,
          scanned: 0,
          embedded: 0,
          errors: 1,
          durationMs: 0,
        });
        console.warn(`[embed-backfill] ${target.table} failed: ${(err as Error).message}`);
      }
    }
    // Canonical TARGETS order regardless of this sweep's rotation.
    const results: BackfillStats[] = TARGETS.map((t) => byTable.get(t.table)!);
    __sweepState.lastResult = results;
    return results;
  } finally {
    __sweepState.running = false;
  }
}

/**
 * Embed-backfill scheduling:
 *   - Initial sweep ~10s after boot (warm-up + catch any rows added
 *     while the process was down).
 *   - Periodic resweep on the DBOS schedule (periodic-workflows.ts,
 *     5 min). Each sweep scans `WHERE embedding IS NULL` so a write
 *     between sweeps is picked up on the next pass.
 *
 * We deliberately don't use LISTEN/NOTIFY for the streaming case: the
 * batch shape (BATCH_SIZE rows per pull) is hostile to per-row signals,
 * and the cadence here keeps embedder cost predictable.
 *
 * 5 min is fast enough that semantic search stays fresh for a
 * long-running server, slow enough that an empty sweep is cheap
 * (single SELECT per target table).
 */
async function _runSweepLogged(label: string): Promise<void> {
  // Step B2 (Tier-3 follow-up arc): battery-aware pause. Skip the
  // sweep when the device is on battery and below threshold; the
  // next periodic tick re-checks. Servers + AC-powered desktops
  // → always 'run'.
  try {
    const { shouldRun } = await import('./battery-policy');
    if (shouldRun() === 'pause') {
      console.log(
        `[embed-backfill] ${label} sweep skipped: on-battery + low-charge ` +
          `(set BATTERY_POLICY_OVERRIDE=always_run to disable, or lower ` +
          `BATTERY_POLICY_MIN_PCT)`,
      );
      return;
    }
  } catch {
    // battery-policy import failed — fall through to running the sweep.
  }

  try {
    const r = await runBackfillSweep();
    if (Array.isArray(r)) {
      const total = r.reduce((acc, s) => acc + s.embedded, 0);
      if (total > 0) {
        console.log(
          `[embed-backfill] ${label} sweep complete: ` +
            r.map((s) => `${s.table.split('.').pop()}=${s.embedded}/${s.scanned}`).join(' '),
        );
      }
    }
  } catch (err) {
    console.warn(`[embed-backfill] ${label} sweep failed:`, (err as Error).message);
  }
}

/**
 * One periodic embed-backfill sweep (battery-aware + logged). Exposed for the
 * DBOS scheduled-workflow migration (dbos-durable-jobs-2026-05-31 Phase 2).
 */
export async function runEmbedBackfillOnce(): Promise<void> {
  await _runSweepLogged('periodic');
}

// Legacy startEmbedBackfillWorker/stopEmbedBackfillWorker removed (consolidation
// P-005): DBOS owns the schedule (periodic-workflows.ts `embedBackfill`).
// `runEmbedBackfillOnce` above is the single-run tick that workflow calls.
