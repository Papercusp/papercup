/**
 * session-search-index-build.ts — the deferred, online build of the session transcript
 * search indexes + term vocabulary (plan session-transcript-exact-fuzzy-search-2026-09-14
 * P-002; design authority: plan D-003 / D-004 / D-005).
 *
 * WHY THIS IS NOT A MIGRATION
 * ---------------------------
 * Measured on a 1,355,857-row copy of harness_shared.session_turns (D-004): the exact-tier
 * trigram GIN is 744 MB / 358.5 s to build, the vocabulary's first full ts_stat build is
 * 351.9 s. The migration runner wraps every file in ONE transaction, so
 * CREATE INDEX CONCURRENTLY is illegal there, and a plain CREATE INDEX would hold a
 * write-blocking lock on the live transcript table for six minutes. Migration 1273
 * therefore creates the two small tables (and the indexes only on a small/fresh table);
 * THIS module builds everything else online from a durable scheduled workflow
 * (lib/dbos/periodic-workflows.ts → sessionSearchIndexBuild), mirroring the shape of
 * db-index-bloat-reindex.ts:
 *   - CREATE INDEX CONCURRENTLY IF NOT EXISTS, autocommit via sql.unsafe (never inside a
 *     transaction block);
 *   - skips under a long-open transaction (CONCURRENTLY would merely park behind it) and
 *     when disk headroom is short (the GIN needs room for itself + WAL);
 *   - an INTERRUPTED concurrent build leaves an INVALID index under the final name that
 *     `CREATE INDEX IF NOT EXISTS` would silently keep forever (present, maintained on
 *     every write, never used) — so invalid leftovers with no live build behind them are
 *     dropped before each attempt;
 *   - never throws for a per-step failure: the failure is recorded on its entry and the
 *     run continues, so one bad step cannot strand the rest.
 *
 * WHAT THE READ PATH MAY RELY ON (D-005 rule 3)
 * ---------------------------------------------
 * `readSessionSearchReadiness` + `sessionSearchTierAvailability` answer, from catalog truth
 * (pg_index.indisvalid/indisready) and the per-workspace vocabulary state row, whether the
 * exact tier and the fuzzy tier can run RIGHT NOW. A tier that cannot is reported as skipped
 * with a reason — it must never fall back to a sequential scan (that is the >15 s
 * whole-corpus scan D-003 forbids).
 *
 * VOCABULARY SEMANTICS
 * --------------------
 * One row per (workspace_id, word) for tokens of length 4-40 produced by
 * to_tsvector('simple', lower(text)); `ndoc` is the number of turns containing the word. A full
 * build is exact; an incremental refresh adds the newly ingested rows' counts, so a re-ingested
 * turn can over-count — `ndoc` only orders equally-similar neighbours and is reset by the
 * periodic full rebuild (which also removes words whose last turn retention deleted).
 *
 * Server-only.
 */
import type postgres from 'postgres';

export const SESSION_TURNS_TABLE = 'harness_shared.session_turns';
export const SESSION_TURN_VOCAB_TABLE = 'harness_shared.session_turn_vocab';
export const SESSION_TURN_VOCAB_STATE_TABLE = 'harness_shared.session_turn_vocab_state';

/**
 * The exact-tier expression. The read path's predicate must contain this text byte-for-byte
 * (`lower(text) LIKE '%…%'`) or PostgreSQL cannot match it to the index.
 */
export const SESSION_TURN_TRGM_EXPR = 'lower(text)';

/** Vocabulary token length window (D-004: shorter tokens are not expanded, longer are noise). */
export const SESSION_TURN_VOCAB_MIN_WORD_LEN = 4;
export const SESSION_TURN_VOCAB_MAX_WORD_LEN = 40;

export type SessionSearchIndexStage = 'corpus' | 'vocab';

export interface SessionSearchIndexSpec {
  name: string;
  table: string;
  /** Everything after `ON <table>`. */
  definition: string;
  /** `corpus` indexes build first; `vocab` indexes build after the vocabulary is loaded. */
  stage: SessionSearchIndexStage;
}

/** Names + definitions are mirrored by migration 1273's size-guarded inline block. */
export const SESSION_SEARCH_INDEXES = [
  {
    name: 'session_turns_text_trgm_idx',
    table: SESSION_TURNS_TABLE,
    definition: `USING gin (${SESSION_TURN_TRGM_EXPR} gin_trgm_ops)`,
    stage: 'corpus',
  },
  {
    name: 'session_turns_ts_desc_idx',
    table: SESSION_TURNS_TABLE,
    definition: '(ts DESC NULLS LAST)',
    stage: 'corpus',
  },
  {
    name: 'session_turn_vocab_word_trgm_idx',
    table: SESSION_TURN_VOCAB_TABLE,
    definition: 'USING gin (word gin_trgm_ops)',
    stage: 'vocab',
  },
] as const satisfies readonly SessionSearchIndexSpec[];

export type SessionSearchIndexName = (typeof SESSION_SEARCH_INDEXES)[number]['name'];

export function createIndexConcurrentlySql(spec: SessionSearchIndexSpec): string {
  return `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${spec.name} ON ${spec.table} ${spec.definition}`;
}

// ─────────────────────────────── readiness (read path) ───────────────────────────────

export type IndexReadiness = 'ready' | 'absent' | 'invalid';
export type VocabStatus = 'absent' | 'building' | 'ready' | 'failed';
/**
 * What the read path sees for one workspace: the persisted status, or `empty` — a DERIVED verdict
 * (never written to the state table) meaning the workspace has NO state row AND NO transcript rows.
 * The build only iterates workspaces that have rows, so such a workspace can never acquire a state
 * row; reading it as `absent` would leave the fuzzy tier skipped forever for it (and the fuzzy tier
 * always asks for the host-global 'default' workspace too, which a fresh install may not populate).
 * "Nothing to build" is not "not ready": an empty vocabulary expands to nothing, which is correct.
 */
export type VocabReadiness = VocabStatus | 'empty';

export interface SessionSearchReadiness {
  indexes: Record<SessionSearchIndexName, IndexReadiness>;
  /** workspace_id → vocabulary readiness (a workspace with no state row but transcript rows is `absent`). */
  vocab: Record<string, VocabReadiness>;
}

export interface TierAvailability {
  available: boolean;
  /** Present when `available` is false: why the tier must be skipped (for the policy receipt). */
  skipReason?: string;
}

export interface SessionSearchTierAvailability {
  /** lower(text) LIKE tier — needs the trigram GIN. */
  exact: TierAvailability;
  /** Vocabulary-expansion tier — needs the vocabulary, its trigram GIN, AND the exact tier. */
  fuzzy: TierAvailability;
}

/** Catalog-truth readiness of the indexes and the requested workspaces' vocabularies. */
export async function readSessionSearchReadiness(
  sql: postgres.Sql,
  workspaceIds: readonly string[],
): Promise<SessionSearchReadiness> {
  const names = SESSION_SEARCH_INDEXES.map((i) => i.name);
  const rows = await sql<Array<{ name: string; valid: boolean; ready: boolean }>>`
    SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND c.relname = ANY(${names as unknown as string[]})
  `;
  const indexes = Object.fromEntries(names.map((n) => [n, 'absent' as IndexReadiness])) as Record<
    SessionSearchIndexName,
    IndexReadiness
  >;
  for (const r of rows) {
    indexes[r.name as SessionSearchIndexName] = r.valid && r.ready ? 'ready' : 'invalid';
  }

  const vocab: Record<string, VocabReadiness> = Object.fromEntries(
    workspaceIds.map((w) => [w, 'absent' as VocabReadiness]),
  );
  if (workspaceIds.length > 0) {
    const states = await sql<Array<{ workspace_id: string; status: VocabStatus }>>`
      SELECT workspace_id, status
        FROM harness_shared.session_turn_vocab_state
       WHERE workspace_id = ANY(${workspaceIds as unknown as string[]})
    `;
    for (const s of states) vocab[s.workspace_id] = s.status;

    // A workspace with no state row is `absent` only if it has transcript rows the build still owes a
    // vocabulary for; with none, there is nothing to build and the build will never create a row.
    // The primary key leads with workspace_id, so each EXISTS is a single index probe.
    const stateless = workspaceIds.filter((w) => vocab[w] === 'absent');
    if (stateless.length > 0) {
      const empty = await sql<Array<{ workspace_id: string }>>`
        SELECT w AS workspace_id
          FROM unnest(${stateless as unknown as string[]}::text[]) AS w
         WHERE NOT EXISTS (
           SELECT 1 FROM harness_shared.session_turns t WHERE t.workspace_id = w
         )
      `;
      for (const e of empty) vocab[e.workspace_id] = 'empty';
    }
  }
  return { indexes, vocab };
}

/**
 * Pure: which tiers may run given a readiness snapshot. `workspaceIds` are the workspaces the
 * search will read vocabulary for (the requested workspace and, per the session_turns
 * convention, 'default').
 */
export function sessionSearchTierAvailability(
  readiness: SessionSearchReadiness,
  workspaceIds: readonly string[],
): SessionSearchTierAvailability {
  const trgm = readiness.indexes.session_turns_text_trgm_idx;
  const exact: TierAvailability =
    trgm === 'ready'
      ? { available: true }
      : { available: false, skipReason: `exact-index-${trgm}` };

  let fuzzy: TierAvailability;
  if (!exact.available) {
    fuzzy = { available: false, skipReason: `exact-index-${trgm}` };
  } else if (readiness.indexes.session_turn_vocab_word_trgm_idx !== 'ready') {
    fuzzy = {
      available: false,
      skipReason: `vocab-index-${readiness.indexes.session_turn_vocab_word_trgm_idx}`,
    };
  } else {
    const notReady = workspaceIds.filter((w) => {
      const v = readiness.vocab[w] ?? 'absent';
      return v !== 'ready' && v !== 'empty';
    });
    fuzzy =
      notReady.length === 0
        ? { available: true }
        : {
            available: false,
            skipReason: `vocab-${notReady.map((w) => `${w}:${readiness.vocab[w] ?? 'absent'}`).join(',')}`,
          };
  }
  return { exact, fuzzy };
}

// ───────────────────────────────── the deferred build ─────────────────────────────────

export interface SessionSearchIndexBuildOpts {
  /** Wall-clock budget checked BETWEEN steps (a step itself is not interruptible). Default 45 min. */
  timeBudgetMs?: number;
  /** Refuse to run when a transaction has been open longer than this. Default 60 s. */
  maxOpenTxnSeconds?: number;
  /** Refuse to run below this much free disk on the data directory. Default 4 GiB. */
  minFreeDiskBytes?: number;
  /** Rebuild a vocabulary from scratch once its last full build is older than this. Default 7 d. */
  vocabFullRebuildAfterMs?: number;
  /** A vocabulary build whose lease is older than this is presumed dead and reclaimed. Default 60 min. */
  vocabLeaseStaleMs?: number;
  /** Report what would be done without touching anything. */
  dryRun?: boolean;
}

const DEFAULTS = {
  timeBudgetMs: 45 * 60_000,
  maxOpenTxnSeconds: 60,
  minFreeDiskBytes: 4 * 1024 * 1024 * 1024,
  vocabFullRebuildAfterMs: 7 * 24 * 3600_000,
  vocabLeaseStaleMs: 60 * 60_000,
};

export interface IndexBuildEntry {
  name: string;
  action: 'built' | 'present' | 'would-build' | 'failed' | 'deferred-budget';
  elapsedMs: number;
  error?: string;
}

export interface VocabBuildEntry {
  workspaceId: string;
  action: 'full' | 'incremental' | 'current' | 'in-flight' | 'would-build' | 'failed' | 'deferred-budget';
  words?: number;
  elapsedMs: number;
  error?: string;
}

export interface SessionSearchIndexBuildResult {
  skipped?: 'tables-missing' | 'long-running-transaction' | 'low-disk';
  /** Invalid leftovers (interrupted CONCURRENTLY builds) dropped this run. */
  invalidDropped: string[];
  indexes: IndexBuildEntry[];
  vocab: VocabBuildEntry[];
  /** True when the time budget cut the run short. */
  truncated: boolean;
}

interface VocabStateRow {
  status: VocabStatus;
  /**
   * Read as TEXT (`watermark_ingested_at::text`), never as a JS Date: session_turns.ingested_at has
   * microsecond precision and a Date truncates to milliseconds, which would leave rows whose
   * sub-millisecond part sorts above the truncated bound out of a full build and re-count them in
   * the next incremental (the watermark would never read "current").
   *
   * ⚠ And it must go BACK to the server as `${x}::text::timestamptz`, never `${x}::timestamptz`:
   * postgres.js serializes a parameter the server types as timestamptz through `new Date(x)`, which
   * truncates a text value to milliseconds exactly as a Date would. Casting through `::text` keeps the
   * parameter text-typed so the conversion happens server-side at full precision.
   */
  watermark_ingested_at: string | null;
  last_full_build_at: string | Date | null;
  build_started_at: string | Date | null;
  build_finished_at: string | Date | null;
}

const toMs = (v: string | Date | null | undefined): number | null =>
  v == null ? null : new Date(v).getTime();

/**
 * Run one build pass: clean invalid leftovers, build missing corpus indexes, build/refresh each
 * workspace's vocabulary, then build the vocabulary's own trigram index. Idempotent — every step
 * is a no-op when its target is already current, so the scheduled workflow can fire it on a short
 * cadence and a crashed pass is simply resumed by the next one.
 */
export async function runSessionSearchIndexBuildOnce(
  sql: postgres.Sql,
  opts: SessionSearchIndexBuildOpts = {},
): Promise<SessionSearchIndexBuildResult> {
  const o = { ...DEFAULTS, ...opts };
  const result: SessionSearchIndexBuildResult = {
    invalidDropped: [],
    indexes: [],
    vocab: [],
    truncated: false,
  };
  const deadline = Date.now() + o.timeBudgetMs;
  const overBudget = () => Date.now() > deadline;

  // --- Guard 0: the migration may not have reached this database yet. ---
  const [present] = await sql<Array<{ turns: string | null; vocab: string | null; state: string | null }>>`
    SELECT to_regclass(${SESSION_TURNS_TABLE})::text AS turns,
           to_regclass(${SESSION_TURN_VOCAB_TABLE})::text AS vocab,
           to_regclass(${SESSION_TURN_VOCAB_STATE_TABLE})::text AS state
  `;
  if (!present?.turns || !present.vocab || !present.state) {
    result.skipped = 'tables-missing';
    return result;
  }

  // --- Guard 1: CONCURRENTLY waits on old snapshots; a long txn would just park the build. ---
  const [{ max_open_seconds: maxOpen } = { max_open_seconds: 0 }] = await sql<
    Array<{ max_open_seconds: number }>
  >`
    SELECT COALESCE(EXTRACT(EPOCH FROM max(now() - xact_start)), 0)::float8 AS max_open_seconds
      FROM pg_stat_activity
     WHERE xact_start IS NOT NULL
       AND backend_type = 'client backend'
       AND pid <> pg_backend_pid()
  `;
  if (Number(maxOpen) > o.maxOpenTxnSeconds) {
    result.skipped = 'long-running-transaction';
    return result;
  }

  // --- Guard 2: a concurrent GIN build needs room for the index and its WAL. ---
  // A probe failure is non-fatal: we would rather build than skip on an unreadable stat.
  try {
    const [{ data_directory: dataDir } = { data_directory: '' }] = await sql<
      Array<{ data_directory: string }>
    >`SELECT setting AS data_directory FROM pg_settings WHERE name = 'data_directory'`;
    if (dataDir) {
      const { statfs } = await import('node:fs/promises');
      const st = await statfs(dataDir);
      if (Number(st.bavail) * Number(st.bsize) < o.minFreeDiskBytes) {
        result.skipped = 'low-disk';
        return result;
      }
    }
  } catch {
    // unreadable data_directory / statfs unsupported — fall through and build.
  }

  const names = SESSION_SEARCH_INDEXES.map((i) => i.name) as string[];

  // --- Drop invalid leftovers that have NO live build behind them. An in-flight concurrent build
  // also shows indisvalid=false, so exclude indexes that pg_stat_progress_create_index reports. ---
  const invalid = await sql<Array<{ name: string }>>`
    SELECT c.relname AS name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND c.relname = ANY(${names})
       AND (NOT i.indisvalid OR NOT i.indisready)
       AND NOT EXISTS (
         SELECT 1 FROM pg_stat_progress_create_index p WHERE p.index_relid = c.oid
       )
  `;
  for (const row of invalid) {
    if (o.dryRun) {
      result.invalidDropped.push(row.name);
      continue;
    }
    try {
      await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS harness_shared.${row.name}`);
      result.invalidDropped.push(row.name);
    } catch {
      // A leftover we cannot drop is retried next pass; it must not fail this one.
    }
  }

  const ensureIndexes = async (stage: SessionSearchIndexStage): Promise<void> => {
    for (const spec of SESSION_SEARCH_INDEXES.filter((i) => i.stage === stage)) {
      const started = Date.now();
      const [have] = await sql<Array<{ valid: boolean }>>`
        SELECT i.indisvalid AS valid
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'harness_shared' AND c.relname = ${spec.name}
      `;
      if (have?.valid) {
        result.indexes.push({ name: spec.name, action: 'present', elapsedMs: 0 });
        continue;
      }
      if (overBudget()) {
        result.truncated = true;
        result.indexes.push({ name: spec.name, action: 'deferred-budget', elapsedMs: 0 });
        continue;
      }
      if (o.dryRun) {
        result.indexes.push({ name: spec.name, action: 'would-build', elapsedMs: 0 });
        continue;
      }
      try {
        // CONCURRENTLY cannot run inside a transaction block — sql.unsafe() on the pooled
        // connection issues it autocommit, which is what we want.
        await sql.unsafe(createIndexConcurrentlySql(spec));
        result.indexes.push({ name: spec.name, action: 'built', elapsedMs: Date.now() - started });
      } catch (err) {
        result.indexes.push({
          name: spec.name,
          action: 'failed',
          elapsedMs: Date.now() - started,
          error: (err as Error).message,
        });
      }
    }
  };

  await ensureIndexes('corpus');
  await refreshVocabularies(sql, o, result, overBudget);
  await ensureIndexes('vocab');
  return result;
}

/** Build/refresh the vocabulary of every workspace that has transcript rows. */
async function refreshVocabularies(
  sql: postgres.Sql,
  o: typeof DEFAULTS & SessionSearchIndexBuildOpts,
  result: SessionSearchIndexBuildResult,
  overBudget: () => boolean,
): Promise<void> {
  // Global watermark, taken BEFORE any corpus read: every row with ingested_at <= W is covered by
  // a build that starts now; later rows are the next incremental's. max() is index-backed.
  const [{ w } = { w: null }] = await sql<Array<{ w: string | null }>>`
    SELECT max(ingested_at)::text AS w FROM harness_shared.session_turns
  `;
  if (w == null) return; // empty corpus — nothing to tokenize.

  const workspaces = await sql<Array<{ workspace_id: string }>>`
    SELECT DISTINCT workspace_id FROM harness_shared.session_turns
  `;

  for (const { workspace_id: ws } of workspaces) {
    const started = Date.now();
    const [state] = await sql<VocabStateRow[]>`
      SELECT status, watermark_ingested_at::text AS watermark_ingested_at,
             last_full_build_at, build_started_at, build_finished_at
        FROM harness_shared.session_turn_vocab_state WHERE workspace_id = ${ws}
    `;

    const mode = await decideVocabMode(sql, ws, state, o);
    if (mode === 'current' || mode === 'in-flight') {
      result.vocab.push({ workspaceId: ws, action: mode, elapsedMs: 0 });
      continue;
    }
    if (overBudget()) {
      result.truncated = true;
      result.vocab.push({ workspaceId: ws, action: 'deferred-budget', elapsedMs: 0 });
      continue;
    }
    if (o.dryRun) {
      result.vocab.push({ workspaceId: ws, action: 'would-build', elapsedMs: 0 });
      continue;
    }

    // Claim the lease atomically so two passes never build one workspace at once. A build in
    // flight is one whose lease is newer than its last finish and not stale. A READY vocabulary
    // keeps status='ready' during a rebuild (readers keep the old words until the swap commits).
    const staleAt = new Date(Date.now() - o.vocabLeaseStaleMs);
    const claimed = await sql<Array<{ workspace_id: string }>>`
      INSERT INTO harness_shared.session_turn_vocab_state AS st
             (workspace_id, status, build_started_at, updated_at)
      VALUES (${ws}, 'building', now(), now())
      ON CONFLICT (workspace_id) DO UPDATE
         SET status = CASE WHEN st.status = 'ready' THEN 'ready' ELSE 'building' END,
             build_started_at = now(),
             updated_at = now()
       WHERE st.build_started_at IS NULL
          OR (st.build_finished_at IS NOT NULL AND st.build_finished_at >= st.build_started_at)
          OR st.build_started_at < ${staleAt}::timestamptz
      RETURNING workspace_id
    `;
    if (claimed.length === 0) {
      result.vocab.push({ workspaceId: ws, action: 'in-flight', elapsedMs: 0 });
      continue;
    }

    try {
      const words = await buildVocabulary(sql, ws, mode, w, state);
      result.vocab.push({ workspaceId: ws, action: mode, words, elapsedMs: Date.now() - started });
    } catch (err) {
      const message = (err as Error).message;
      await sql`
        UPDATE harness_shared.session_turn_vocab_state
           SET status = CASE WHEN status = 'ready' THEN 'ready' ELSE 'failed' END,
               last_error = ${message.slice(0, 2000)},
               build_finished_at = now(),
               updated_at = now()
         WHERE workspace_id = ${ws}
      `.catch(() => {});
      result.vocab.push({
        workspaceId: ws,
        action: 'failed',
        elapsedMs: Date.now() - started,
        error: message,
      });
    }
  }
}

async function decideVocabMode(
  sql: postgres.Sql,
  ws: string,
  state: VocabStateRow | undefined,
  o: typeof DEFAULTS & SessionSearchIndexBuildOpts,
): Promise<'full' | 'incremental' | 'current' | 'in-flight'> {
  if (!state || state.status === 'absent' || state.status === 'failed') {
    return inFlight(state, o) ? 'in-flight' : 'full';
  }
  if (inFlight(state, o)) return 'in-flight';
  if (state.status === 'building') return 'full'; // a dead build's stale lease
  // status === 'ready'
  const fullAt = toMs(state.last_full_build_at);
  if (fullAt == null || Date.now() - fullAt > o.vocabFullRebuildAfterMs) return 'full';
  if (state.watermark_ingested_at == null) return 'full';
  const [fresh] = await sql<Array<{ has_new: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM harness_shared.session_turns
       WHERE workspace_id = ${ws} AND ingested_at > ${state.watermark_ingested_at}::text::timestamptz
    ) AS has_new
  `;
  return fresh?.has_new ? 'incremental' : 'current';
}

function inFlight(state: VocabStateRow | undefined, o: { vocabLeaseStaleMs: number }): boolean {
  const started = toMs(state?.build_started_at);
  if (started == null) return false;
  const finished = toMs(state?.build_finished_at);
  if (finished != null && finished >= started) return false;
  return Date.now() - started < o.vocabLeaseStaleMs;
}

/** One workspace's vocabulary build in a single transaction: readers never see a half-swapped set. */
async function buildVocabulary(
  sql: postgres.Sql,
  ws: string,
  mode: 'full' | 'incremental',
  /** Full-precision timestamptz text — see VocabStateRow.watermark_ingested_at. */
  upTo: string,
  state: VocabStateRow | undefined,
): Promise<number> {
  const minLen = SESSION_TURN_VOCAB_MIN_WORD_LEN;
  const maxLen = SESSION_TURN_VOCAB_MAX_WORD_LEN;
  const prev = mode === 'incremental' ? state?.watermark_ingested_at ?? null : null;

  return sql.begin(async (tx) => {
    // A full build is one multi-minute statement; do not let a session statement_timeout kill it.
    await tx`SET LOCAL statement_timeout = 0`;
    // `mode` and the bounds are interpolated through format(%L), never string-concatenated.
    if (mode === 'full') {
      await tx`
        INSERT INTO harness_shared.session_turn_vocab AS v (workspace_id, word, ndoc, refreshed_at)
        SELECT ${ws}::text, s.word, s.ndoc, ${upTo}::text::timestamptz
          FROM ts_stat(format(
                 'SELECT to_tsvector(''simple'', lower(text)) FROM harness_shared.session_turns '
                 || 'WHERE workspace_id = %L AND ingested_at <= %L',
                 ${ws}::text, ${upTo}::text)) s
         WHERE length(s.word) BETWEEN ${minLen} AND ${maxLen}
        ON CONFLICT (workspace_id, word) DO UPDATE
           SET ndoc = EXCLUDED.ndoc, refreshed_at = EXCLUDED.refreshed_at
      `;
      // Words whose last turn retention deleted were not re-stamped by this build.
      await tx`
        DELETE FROM harness_shared.session_turn_vocab
         WHERE workspace_id = ${ws} AND refreshed_at < ${upTo}::text::timestamptz
      `;
    } else {
      await tx`
        INSERT INTO harness_shared.session_turn_vocab AS v (workspace_id, word, ndoc, refreshed_at)
        SELECT ${ws}::text, s.word, s.ndoc, ${upTo}::text::timestamptz
          FROM ts_stat(format(
                 'SELECT to_tsvector(''simple'', lower(text)) FROM harness_shared.session_turns '
                 || 'WHERE workspace_id = %L AND ingested_at > %L AND ingested_at <= %L',
                 ${ws}::text, ${prev}::text, ${upTo}::text)) s
         WHERE length(s.word) BETWEEN ${minLen} AND ${maxLen}
        ON CONFLICT (workspace_id, word) DO UPDATE
           SET ndoc = v.ndoc + EXCLUDED.ndoc, refreshed_at = EXCLUDED.refreshed_at
      `;
    }
    const [{ n } = { n: 0 }] = await tx<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.session_turn_vocab WHERE workspace_id = ${ws}
    `;
    await tx`
      UPDATE harness_shared.session_turn_vocab_state
         SET status = 'ready',
             watermark_ingested_at = ${upTo}::text::timestamptz,
             word_count = ${n},
             build_finished_at = now(),
             last_full_build_at = CASE WHEN ${mode === 'full'} THEN now() ELSE last_full_build_at END,
             last_error = NULL,
             updated_at = now()
       WHERE workspace_id = ${ws}
    `;
    return n;
  });
}
