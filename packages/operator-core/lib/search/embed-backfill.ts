/**
 * Embed-backfill worker for Plan 2B+C.
 *
 * Walks the prose surfaces (operator_turns, harness_escalations,
 * harness_brainstorm, harness_decisions, session_turns) and the work-item
 * ledger's base table (work_items — P-008,
 * shared-embedding-sidecar-and-enrichment-2026-07-10) looking for rows
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
  proseSurfacePreference,
  resolveOpenAiKey,
  localAvailable,
  isOpenAiEmbedInCooldown,
} from '../memory/configure';
import type { EmbedFn, ResolvedEmbedder } from '@papercusp/memory';
import { buildSidecarAwareEmbedder } from '../memory/embed-sidecar-wiring';
// The prose column width contract — ONE source, not a restated `384`
// (D-005 §5). `fitsProseColumns` is the dims guard; `modeTargetDims` is what a
// mode declares it emits. A test asserts the two agree.
import { PROSE_VECTOR_DIMS, fitsProseColumns, modeTargetDims } from './prose-vector-dims';

const OPENAI_EMBEDDER_MODEL = 'text-embedding-3-small';
// F-E5 (app-wide-load-traps § E): hardware-adaptive embed batch — a big host
// pushes bigger batches for throughput, a laptop keeps latency/memory down.
const BATCH_SIZE = getResourceProfile().embedBatchSize;

/**
 * WI-7327: per-row embed deadline.
 *
 * A single embed is ~0.3-1.5s against the local :3384 sidecar even on a loaded
 * box, so 90s cannot fire on a merely-slow call — it fires only on a call that
 * is never coming back. Without it one wedged request pins the sweep's `running`
 * latch and silently disables ALL future backfill.
 */
const EMBED_ROW_TIMEOUT_MS = 90_000;

function withEmbedTimeout<T>(p: Promise<T>, ms = EMBED_ROW_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`embed_timeout_after_${ms}ms`)), ms);
      // Never hold the process open on this timer alone.
      (timer as unknown as { unref?: () => void }).unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

type ResolvedMode = 'openai' | 'local' | 'gemma' | 'harrier' | 'disabled';

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
          // What the openai mode DECLARES it emits. The prose-column contract
          // test asserts this equals PROSE_VECTOR_DIMS, so asking for the
          // declared width can never write a vector the column cannot hold.
          dimensions: modeTargetDims('openai'),
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
    // P-015 harrier default flip: prose surfaces stay in the gemma space —
    // see proseSurfacePreference (memory/configure.ts) for the full rationale.
    readPreference: async () => proseSurfacePreference(await readEmbedderPreference()),
    resolveKey: resolveOpenAiKey,
    localInstalled: localAvailable,
    isOpenAiRecentlyExhausted: isOpenAiEmbedInCooldown,
    buildOpenAi: buildAdmissionGovernedOpenAiEmbedder,
    // Sidecar-first local legs (P-004): shared warm model when the host runs
    // the embed sidecar, bit-identical in-process fallback otherwise.
    buildLocal: () => buildSidecarAwareEmbedder('local', 'document'),
    // Prose backfill is STORAGE, so EmbeddingGemma gets the document prompt.
    buildGemma: () => buildSidecarAwareEmbedder('gemma', 'document'),
    // Required by the cascade seam since P-014 made harrier selectable; the
    // sweep itself never STORES harrier vectors (native 1024 ≠ PROSE_VECTOR_DIMS
    // — the dims guard in runBackfillSweep skips the whole sweep), but an
    // unresolvable preference must not throw and kill the periodic tick.
    // Stated as the CONSTANT, not a literal width: migration 727 moves the prose
    // columns 384 → 768 and this comment used to name 384, which would have read
    // as "harrier is excluded because it is not 384" — true of the old width and
    // wrong about the reason. Harrier is excluded because 1024 ≠ the prose width,
    // whatever that width currently is.
    buildHarrier: () => buildSidecarAwareEmbedder('harrier', 'document'),
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
  // EI-12967: these first four targets had NO char cap on their embed input — unlike
  // every other target below (session_turns/work_items/doc_sections/harness_plans all
  // `left(…, 2000)`). The sidecar hard-rejects any single text over 32000 chars
  // (sidecar_embed_400), and the deterministic 400 is UNRETRYABLE: the row stays
  // `embedCol IS NULL` forever, so the next 5-min sweep tick re-SELECTs and re-fails the
  // SAME oversized row again — a permanent retry-forever loop for that one row (live:
  // 392 operator_turns rows + 9 harness_escalations rows over 32000 chars, one re-failing
  // every ~5min since 2026-07-16). Capping the embed INPUT at the same 2000-char
  // convention used everywhere else in this file fixes it at the root — the embed call
  // never again submits more than the sidecar accepts, so the row succeeds and stops
  // being re-selected. The stored column itself is untouched; only what's HANDED to
  // embed() is capped.
  {
    table: 'harness_shared.harness_escalations',
    embedCol: 'body_embedding',
    bodySql: `left(COALESCE(escalation, ''), 2000) || E'\\n' || left(COALESCE(supervisor_notes, ''), 2000)`,
    keyCols: ['harness_slug', 'phase'],
  },
  {
    table: 'harness_shared.harness_brainstorm',
    embedCol: 'content_embedding',
    bodySql: `left(content, 2000)`,
    keyCols: ['harness_slug', 'phase'],
  },
  {
    table: 'harness_shared.operator_turns',
    embedCol: 'text_embedding',
    bodySql: `left(text, 2000)`,
    keyCols: ['id'],
  },
  {
    table: 'harness_shared.harness_decisions',
    embedCol: 'body_embedding',
    // args is free-form (a tool call's JSON args) — cap it too (EI-12967 belt-and-braces;
    // observed max is small today, but nothing bounds it going forward).
    bodySql: `COALESCE(verb, '') || ' ' || left(COALESCE(args, ''), 2000)`,
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
  // P-008 (shared-embedding-sidecar-and-enrichment-2026-07-10): the work-item
  // ledger — ONE base table (migration 374 unified issue + feature families
  // into harness_shared.work_items; engineer_issues / harness_features_
  // consolidated are compat views over it, so the migration-551 embedding
  // columns live HERE and one sweep covers every kind). Embeds title +
  // body/summary (truncated to 2k chars, mirroring session_turns) so
  // work_items:search gains a semantic leg and work_items:create can prescreen
  // a new title against OPEN items by cosine similarity — the 2026-07-10
  // 30-dupe bug-storm class (WI-3358..WI-3477) that lexical dedup missed.
  {
    table: 'harness_shared.work_items',
    embedCol: 'embedding',
    bodySql: `COALESCE(title, '') || E'\\n' || left(COALESCE(summary, ''), 2000)`,
    keyCols: ['harness_slug', 'feature_id'],
  },
  // P-009 (shared-embedding-sidecar-and-enrichment-2026-07-10): documentation
  // sections. docs:search is filesystem-backed, so doc-embed-sync.ts mirrors
  // DocSource pages (the engineering tree incl. agent-insights runbooks,
  // project docs, harness docs) into migration 552's doc_sections — heading-
  // split, sha-keyed — and THIS entry vectorizes them so docs:search gains a
  // semantic leg. title carries "Page › Heading"; content is pre-capped at
  // sync time (the left() here is belt-and-braces).
  {
    table: 'harness_shared.doc_sections',
    embedCol: 'embedding',
    bodySql: `COALESCE(title, '') || E'\\n' || left(COALESCE(content, ''), 2000)`,
    keyCols: ['source_key', 'slug', 'anchor'],
  },
  // P-010 (shared-embedding-sidecar-and-enrichment-2026-07-10): the plan
  // store (migration 553). plans:search gains a semantic leg and plans:new's
  // similar_exists token guard gains cosine confirmation — the token matcher
  // false-flagged topically-adjacent but distinct efforts.
  {
    table: 'harness_shared.harness_plans',
    embedCol: 'embedding',
    bodySql: `COALESCE(title, '') || E'\\n' || left(COALESCE(content, ''), 2000)`,
    keyCols: ['workspace_id', 'harness_slug', 'plan_slug'],
  },
  // EI-19374072666153095: code_recipes and datatype_registry are BOTH in
  // PROSE_VECTOR_COLUMNS — so a width migration wipes them (`USING NULL`) — but
  // neither had a sweep entry here, and neither has any other re-embed path:
  // their only writers are UPSERTs using `COALESCE(EXCLUDED.embedding, <existing>)`
  // (code-recipes-store.ts / datatype-registry-store.ts), which store a vector
  // only when a caller supplies one. So the plan's "surfaces run lexical-only
  // until the sweep refills them" reasoning did NOT hold for these two: measured
  // 2026-08-02, migration 727 would have stranded 8,165 code_recipes vectors and
  // 8 datatype_registry vectors PERMANENTLY, degrading recipes:search's semantic
  // leg across its whole existing corpus rather than for the planned ~1h.
  //
  // Neither table has migration 530's `<embedCol>_mode` discriminator column.
  // That is handled, not ignored: runBackfillSweep probes information_schema per
  // target and passes `spaceAware: false` when the column is absent, so these
  // sweep correctly today. The cost is only that a FUTURE embedder-space change
  // cannot selectively re-embed them (WI-3616's concern) — tracked separately on
  // EI-19374072666153095 rather than bundled into a width migration.
  {
    table: 'harness_shared.code_recipes',
    embedCol: 'embedding',
    bodySql: `COALESCE(title, '') || E'\\n' || left(COALESCE(description, ''), 2000)`,
    keyCols: ['id'],
  },
  {
    table: 'harness_shared.datatype_registry',
    embedCol: 'embedding',
    bodySql: `COALESCE(title, '') || E'\\n' || left(COALESCE(description, ''), 2000)`,
    keyCols: ['workspace_id', 'id'],
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
 *  through runBackfillSweep, which supplies this from its own
 *  `maxRowsPerTarget` option — the fairness cap by default, or a bulk-refill
 *  ceiling when a width/model change has dropped every stored vector. Do not
 *  call this directly from production code just to raise the cap: going through
 *  the sweep is what applies the embedder-eligibility guard, the column probes
 *  and the overlap guard.
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
        // WI-7327: BOUND the embed. This await is the one place a sweep can hang
        // forever — the embedder cascade ends in a `fetch` to the :3384 sidecar or an
        // HTTP API, and neither carries its own deadline here. A hang holds the
        // `running` latch (see runBackfillSweep) and wedges ALL future sweeps, which
        // is exactly how 451k rows sat unembedded for hours. Rejecting instead lets
        // the existing per-row catch count it as an error and move on.
        const vec = await withEmbedTimeout(embed(row.body));
        if (!fitsProseColumns(vec.length)) {
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
  /**
   * WI-7327: when the in-flight sweep took the `running` latch, or null when idle.
   *
   * The latch used to be a bare boolean reset only in a `finally`. A sweep that
   * THROWS reaches that finally; a sweep that HANGS never does — and because the
   * state is pinned to globalThis, nothing would ever clear it. Stamping the start
   * time lets a later tick decide the holder is dead and take over.
   *
   * Calibrate against SWEEP_LATCH_STALE_MS's note: healthy sweeps really do run
   * 14-15 minutes, so "still running" is the normal case, not a fault.
   */
  startedAt: number | null;
}
/**
 * How long a sweep may hold the latch before another tick treats it as dead.
 *
 * ⚠ CALIBRATION MATTERS MORE THAN IT LOOKS — set this too low and the "recovery"
 * runs a SECOND sweep concurrently with a perfectly healthy one, which is the
 * exact double-embedding the latch exists to prevent. A HEALTHY full sweep here
 * is minutes, not seconds: measured 2026-08-03 on the real backlog, consecutive
 * successful sweeps took 873s (14.5min) and 918s (15.3min) — ten targets × up to
 * MAX_ROWS_PER_TARGET_PER_SWEEP rows × a ~0.3-4s local embed each. A 15-minute
 * ceiling would have fired on BOTH of those.
 *
 * So this is deliberately ~4× the slowest observed healthy sweep. It is a
 * dead-holder backstop, not a performance ceiling: a sweep still running at 60
 * minutes is not slow, it is gone.
 */
const SWEEP_LATCH_STALE_MS = 60 * 60 * 1000;
const __sweepStateKey = Symbol.for('papercusp.embedBackfillSweepState');
const __sweepState: SweepState = (() => {
  const g = globalThis as typeof globalThis & { [__sweepStateKey]?: SweepState };
  if (!g[__sweepStateKey]) {
    g[__sweepStateKey] = { running: false, lastResult: null, sweepCounter: 0, startedAt: null };
  }
  // Upgrade an older pinned shape (pre-WI-2905) in place.
  if (typeof g[__sweepStateKey]!.sweepCounter !== 'number') g[__sweepStateKey]!.sweepCounter = 0;
  // Upgrade a pre-WI-7327 pinned shape: an already-held latch has no start stamp,
  // so date it now rather than leaving it immortal.
  if (g[__sweepStateKey]!.startedAt === undefined) {
    g[__sweepStateKey]!.startedAt = g[__sweepStateKey]!.running ? Date.now() : null;
  }
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
/**
 * Options for a NON-ROUTINE sweep. The periodic scheduler always calls
 * `runBackfillSweep()` with no arguments and therefore keeps the WI-2905
 * fairness cap — nothing about the routine path changes.
 *
 * `maxRowsPerTarget` exists for BULK REFILL after a width/model change, which is
 * a fundamentally different job from the steady-state trickle. A migration that
 * changes the prose vector width necessarily drops every stored vector (pgvector
 * cannot cast between widths), so ~500k rows must be re-embedded ONCE, as fast as
 * the embedder allows — whereas the fairness cap is tuned to dribble a backlog out
 * over days without letting one table monopolize the shared budget. Applying the
 * routine cap to a refill makes it cap-bound at 2-5 DAYS for session_turns alone
 * (~413k rows at 4 batches/sweep on a 5-min cadence — EI-19375205903428632), with
 * semantic search degraded to lexical-only for the whole window.
 *
 * This is deliberately an OPTION on the existing sweep rather than a separate
 * bulk-refill driver: a standalone driver would have to re-implement embedder
 * resolution, the org pool, the vector-extension probe, the per-target column
 * probes, `spaceAware` detection and the per-target error isolation — i.e. fork
 * the whole sweep. Threading one number inherits all of it, including the
 * `__sweepState.running` guard that keeps a refill from overlapping the periodic
 * sweep, and the rotation that keeps progress fair across targets when a refill
 * is run as repeated passes.
 */
export interface BackfillSweepOptions {
  /**
   * Per-target row ceiling for THIS sweep. Defaults to the WI-2905 fairness cap.
   * The daily token budget still applies and is still shared, so this raises the
   * per-sweep ceiling — it does not buy extra budget. Safe for a LOCAL embedder
   * space (gemma on the :3384 sidecar), which costs wall time but no API tokens.
   */
  maxRowsPerTarget?: number;
}

export async function runBackfillSweep(
  opts: BackfillSweepOptions = {},
): Promise<BackfillStats[] | { skipped: string }> {
  const maxRowsPerTarget = opts.maxRowsPerTarget ?? MAX_ROWS_PER_TARGET_PER_SWEEP;
  // WI-7327: the latch is TIME-BOXED, and every refusal is LOUD.
  //
  // The LOUD half is the one that was actually costing us, and the story is
  // worth keeping because it burned an investigation. A healthy sweep here runs
  // for MINUTES (measured 14.5min and 15.3min on 2026-08-03), so the 5-min tick
  // legitimately finds one in flight and skips — correct, intended behaviour.
  // But the skip returned a non-array that `_runSweepLogged` could not log, so
  // it printed NOTHING. A healthy mid-sweep skip and a genuinely wedged latch
  // were therefore indistinguishable from the outside: both just silence and a
  // ~265ms tick. That ambiguity led to a wrong "the backfill is wedged"
  // diagnosis and an unnecessary bg-host restart. Saying which one is happening
  // costs one log line.
  //
  // The TIME-BOX is a backstop for the case that diagnosis wrongly assumed: a
  // sweep that hangs never reaches the `finally` that clears `running`, and the
  // state is pinned to globalThis, so nothing else would ever clear it.
  if (__sweepState.running) {
    const heldMs = __sweepState.startedAt === null ? 0 : Date.now() - __sweepState.startedAt;
    if (heldMs < SWEEP_LATCH_STALE_MS) {
      console.log(
        `[embed-backfill] skipped: a sweep has held the latch for ${Math.round(heldMs / 1000)}s ` +
          `(stale at ${SWEEP_LATCH_STALE_MS / 1000}s)`,
      );
      return { skipped: 'already_running' };
    }
    // Past the ceiling the holder is not slow, it is gone: no sweep legitimately
    // runs this long. Take the latch rather than defer to a corpse forever.
    console.warn(
      `[embed-backfill] STALE LATCH: previous sweep has held it for ${Math.round(heldMs / 1000)}s ` +
        `(> ${SWEEP_LATCH_STALE_MS / 1000}s) and is presumed hung — taking over. ` +
        `If this repeats, the per-row embed is hanging (WI-7327).`,
    );
  }
  __sweepState.running = true;
  __sweepState.startedAt = Date.now();
  try {
    const resolved = await resolveBackfillEmbedder();
    // Skip entirely when disabled OR when the active embedder's dims don't fit
    // the prose columns. Without this guard an ineligible preference would burn
    // a full batch of embeds per table per tick just to count every row as a
    // dims-mismatch error.
    //
    // Who is ineligible (PROSE_ELIGIBLE_MODES): harrier, native 1024 with no
    // MRL — the long-standing case; and since D-005, `local` too — bge-small is
    // natively 384 and cannot emit the 768 the columns now hold. A `local`
    // preference therefore leaves prose lexical-only rather than re-embedding
    // the whole column into a weaker space, which is what used to happen.
    if (resolved.mode === 'disabled' || !fitsProseColumns(resolved.dims)) {
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
          await backfillTable(sql, target, embed, maxRowsPerTarget, mode, spaceAware),
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
    __sweepState.startedAt = null;
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
      const scanned = r.reduce((acc, s) => acc + s.scanned, 0);
      const errors = r.reduce((acc, s) => acc + s.errors, 0);
      if (total > 0) {
        console.log(
          `[embed-backfill] ${label} sweep complete: ` +
            r.map((s) => `${s.table.split('.').pop()}=${s.embedded}/${s.scanned}`).join(' '),
        );
      } else if (scanned > 0 || errors > 0) {
        // WI-7327: a sweep that looked at rows and embedded NONE is a fault, not a
        // quiet success — it is what a code/schema width skew looks like (every
        // UPDATE rejected into the per-row catch). This used to print nothing, so
        // "healthy" and "totally broken" were byte-identical: silence.
        console.warn(
          `[embed-backfill] ${label} sweep embedded NOTHING (scanned=${scanned} errors=${errors}) — ` +
            r.filter((s) => s.scanned > 0 || s.errors > 0)
              .map((s) => `${s.table.split('.').pop()}=${s.embedded}/${s.scanned}(err${s.errors})`)
              .join(' '),
        );
      }
    } else if (r && typeof r === 'object' && 'skipped' in r) {
      // The skip path returns a non-array, which the branch above cannot log at all.
      console.log(`[embed-backfill] ${label} sweep skipped: ${r.skipped}`);
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
  // P-009: mirror doc sections into PG before the sweep so the doc_sections
  // target has rows to embed (once per process — see doc-embed-sync.ts).
  // Dynamic import keeps docs-engine out of this module's static graph.
  try {
    const { runDocSectionsSyncOnce } = await import('./doc-embed-sync');
    await runDocSectionsSyncOnce();
  } catch (err) {
    console.warn('[embed-backfill] doc-sections sync failed:', (err as Error).message);
  }
  await _runSweepLogged('periodic');

  // Memory write-journal drain (memory-write-journal-auto-recovery P-003):
  // replay memory writes parked during an embedder outage. Rides this tick
  // (plan D-002 — both drains want the embedder back). An on-battery pause
  // above only skips the SWEEP; the journal drain is small (≤25 rows/tick)
  // and deferring recovered facts is worse than the marginal battery cost.
  // Dynamic import keeps memory/ out of this module's static graph.
  try {
    const { drainMemoryWriteJournal } = await import('../memory/write-journal');
    const r = await drainMemoryWriteJournal();
    if (r.recovered > 0 || r.deduped > 0 || r.retriesExhausted > 0) {
      console.log(
        `[memory-journal] drain: recovered=${r.recovered} deduped=${r.deduped} ` +
          `exhausted=${r.retriesExhausted} stillPending=${r.stillPending}`,
      );
      // P-006 surfacing — recovery nudge + live settings-page refresh.
      const { notifyJournalRecovery } = await import('../memory/journal-surfacing');
      await notifyJournalRecovery(r);
    }
  } catch (err) {
    console.warn('[memory-journal] drain failed:', (err as Error).message);
  }

  // Canonical-memory vector backfill: a memory row with no vector in the ACTIVE
  // mode's table is invisible to semantic recall, and this is the only sweep that
  // can re-INSERT one from canonical text alone. Two ways a row gets here — a
  // memory projected from a peer hive lands as canonical TEXT with NO vector (the
  // wire carries none by design, EI-9308: "let each peer re-embed locally", and
  // the projection's raw-SQL upsert bypasses the only code that writes
  // memory_vec_* rows), and a vector WIPE — a width migration or a mode switch —
  // empties the active table for every row at once (WI-7326; the TARGETS sweep
  // above cannot help, it only UPDATEs rows that still exist). Rides this tick for
  // the same reason the journal drain does (both want the embedder back), with
  // the same bounded + non-fatal shape.
  try {
    const { backfillCanonicalMemoryVectors } = await import('../memory/canonical-vec-backfill');
    const r = await backfillCanonicalMemoryVectors();
    if (r.embedded > 0 || r.failed > 0) {
      console.log(
        `[memory-vec] backfill: embedded=${r.embedded} failed=${r.failed} ` +
          `scanned=${r.scanned} (failed rows retry next tick)`,
      );
    }
  } catch (err) {
    console.warn('[memory-vec] backfill failed:', (err as Error).message);
  }
}

// Legacy startEmbedBackfillWorker/stopEmbedBackfillWorker removed (consolidation
// P-005): DBOS owns the schedule (periodic-workflows.ts `embedBackfill`).
// `runEmbedBackfillOnce` above is the single-run tick that workflow calls.
