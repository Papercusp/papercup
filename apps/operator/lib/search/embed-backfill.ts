/**
 * Embed-backfill worker for Plan 2B+C.
 *
 * Walks the 3 prose surfaces (operator_turns, harness_escalations,
 * harness_brainstorm) looking for rows where the embedding column is
 * NULL, and fills it in batches using the same OpenAI/local cascade
 * mem0 uses (so embeddings live in the same 384-D space as memories
 * — future cross-pollination becomes possible).
 *
 * Cadence: one sweep at boot (instrumentation-node.ts), then idle.
 * New rows after boot are backfilled by the next boot. We don't add
 * a trigger-on-insert path because embeddings need network calls and
 * the writer should never block on them.
 *
 * Resumable: state is "where embedding IS NULL". Restart picks up
 * naturally. Failure on a single row counts as an error and skips
 * forward; we don't poison the whole sweep.
 */

const EMBEDDER_DIM = 384;
const OPENAI_EMBEDDER_MODEL = 'text-embedding-3-small';
const LOCAL_EMBEDDER_MODEL = 'Xenova/bge-small-en-v1.5';
const BATCH_SIZE = 32;

type ResolvedMode = 'openai' | 'local' | 'disabled';

interface PgFields {
  host: string;
  port: number;
  user: string;
  password: string;
  dbname: string;
}

interface BackfillStats {
  table: string;
  scanned: number;
  embedded: number;
  errors: number;
  durationMs: number;
}

async function loadPgFields(): Promise<PgFields> {
  const { pgFields } = await import('../memory/mem0-connection');
  return pgFields();
}

async function resolveEmbedderMode(): Promise<ResolvedMode> {
  let mode: 'auto' | ResolvedMode = 'auto';
  try {
    const { loadVoicePrefs } = await import('../voice-prefs');
    const prefs = await loadVoicePrefs();
    const m = (prefs as Record<string, unknown>).memoryEmbedderMode;
    if (m === 'auto' || m === 'openai' || m === 'local' || m === 'disabled') mode = m;
  } catch {
    /* fall through */
  }
  if (mode === 'disabled') return 'disabled';

  // Try openai first (auto + openai both).
  let key = process.env.OPENAI_API_KEY ?? '';
  try {
    const { readCredentials } = await import('../credentials');
    const creds = await readCredentials();
    if (creds.openai_api_key) key = creds.openai_api_key;
  } catch {
    /* env fallback */
  }
  if (key && (mode === 'auto' || mode === 'openai')) return 'openai';
  if (mode === 'openai') return 'disabled';

  // Try local.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dynamicImport = new Function('s', 'return import(s)') as any;
    await dynamicImport('@huggingface/transformers');
    return 'local';
  } catch {
    return 'disabled';
  }
}

async function buildEmbedder(mode: ResolvedMode): Promise<(t: string) => Promise<number[]>> {
  if (mode === 'disabled') {
    throw new Error('embedder_disabled');
  }
  if (mode === 'openai') {
    let key = process.env.OPENAI_API_KEY ?? '';
    try {
      const { readCredentials } = await import('../credentials');
      const creds = await readCredentials();
      if (creds.openai_api_key) key = creds.openai_api_key;
    } catch {
      /* env fallback */
    }
    if (!key) throw new Error('openai_api_key_missing');
    return async (text: string): Promise<number[]> => {
      const r = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: OPENAI_EMBEDDER_MODEL,
          input: text,
          dimensions: EMBEDDER_DIM,
        }),
      });
      if (!r.ok) throw new Error(`openai_embed_${r.status}`);
      const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
      return j.data[0].embedding;
    };
  }
  // local
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dynamicImport = new Function('s', 'return import(s)') as any;
  const transformers = await dynamicImport('@huggingface/transformers');
  const pipe = await transformers.pipeline('feature-extraction', LOCAL_EMBEDDER_MODEL);
  return async (text: string): Promise<number[]> => {
    const result = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(result.data) as number[];
  };
}

interface BackfillTarget {
  table: string;
  embedCol: string;
  bodySql: string;
  idCol?: string;
}

const TARGETS: BackfillTarget[] = [
  {
    table: 'harness_shared.harness_escalations',
    embedCol: 'body_embedding',
    bodySql: `COALESCE(escalation, '') || E'\\n' || COALESCE(supervisor_notes, '')`,
    idCol: 'ctid',
  },
  {
    table: 'harness_shared.harness_brainstorm',
    embedCol: 'content_embedding',
    bodySql: 'content',
    idCol: 'ctid',
  },
  {
    table: 'harness_shared.operator_turns',
    embedCol: 'text_embedding',
    bodySql: 'text',
    idCol: 'id',
  },
  {
    table: 'harness_shared.harness_decisions',
    embedCol: 'body_embedding',
    bodySql: `COALESCE(verb, '') || ' ' || COALESCE(args, '')`,
    idCol: 'ctid',
  },
];

async function backfillTable(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  target: BackfillTarget,
  embed: (t: string) => Promise<number[]>,
): Promise<BackfillStats> {
  const started = Date.now();
  const stats: BackfillStats = {
    table: target.table,
    scanned: 0,
    embedded: 0,
    errors: 0,
    durationMs: 0,
  };
  const idCol = target.idCol ?? 'ctid';

  // Loop until no more NULLs.
  while (true) {
    const batch = await client.query<{ id: string; body: string }>(
      `SELECT ${idCol} AS id, (${target.bodySql}) AS body
         FROM ${target.table}
        WHERE ${target.embedCol} IS NULL
          AND length(${target.bodySql}) > 0
        LIMIT $1`,
      [BATCH_SIZE],
    );
    if (!batch.rows.length) break;

    for (const row of batch.rows) {
      stats.scanned += 1;
      try {
        const vec = await embed(row.body);
        if (vec.length !== EMBEDDER_DIM) {
          stats.errors += 1;
          continue;
        }
        await client.query(
          `UPDATE ${target.table}
              SET ${target.embedCol} = $1::vector
            WHERE ${idCol} = $2`,
          [`[${vec.join(',')}]`, row.id],
        );
        stats.embedded += 1;
      } catch {
        stats.errors += 1;
      }
    }
  }

  stats.durationMs = Date.now() - started;
  return stats;
}

let _sweepRunning = false;
let _lastResult: BackfillStats[] | null = null;

export function getLastBackfillResult(): BackfillStats[] | null {
  return _lastResult;
}

/**
 * Run a single sweep across all 3 surfaces.
 *
 * Returns per-table stats. Safe to call repeatedly — the second call
 * exits immediately if a sweep is already in flight.
 */
export async function runBackfillSweep(): Promise<BackfillStats[] | { skipped: string }> {
  if (_sweepRunning) return { skipped: 'already_running' };
  _sweepRunning = true;
  try {
    const mode = await resolveEmbedderMode();
    if (mode === 'disabled') {
      _lastResult = TARGETS.map((t) => ({
        table: t.table,
        scanned: 0,
        embedded: 0,
        errors: 0,
        durationMs: 0,
      }));
      return _lastResult;
    }

    const embed = await buildEmbedder(mode);
    const pg = await loadPgFields();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const client = new Client({
      host: pg.host,
      port: pg.port,
      user: pg.user,
      password: pg.password,
      database: pg.dbname,
    });
    await client.connect();
    try {
      // Probe vector extension; if missing, exit silently.
      const r = await client.query<{ extname: string }>(
        `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
      );
      if (!r.rowCount) {
        _lastResult = TARGETS.map((t) => ({
          table: t.table, scanned: 0, embedded: 0, errors: 0, durationMs: 0,
        }));
        return _lastResult;
      }

      const results: BackfillStats[] = [];
      for (const target of TARGETS) {
        try {
          // Column existence probe; skip if migration 061 hasn't run.
          const c = await client.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = split_part($1, '.', 1)
                AND table_name   = split_part($1, '.', 2)
                AND column_name  = $2`,
            [target.table, target.embedCol],
          );
          if (!c.rowCount) {
            results.push({ table: target.table, scanned: 0, embedded: 0, errors: 0, durationMs: 0 });
            continue;
          }
          results.push(await backfillTable(client, target, embed));
        } catch (err) {
          results.push({
            table: target.table,
            scanned: 0,
            embedded: 0,
            errors: 1,
            durationMs: 0,
          });
          console.warn(`[embed-backfill] ${target.table} failed: ${(err as Error).message}`);
        }
      }
      _lastResult = results;
      return results;
    } finally {
      try { await client.end(); } catch { /* ignore */ }
    }
  } finally {
    _sweepRunning = false;
  }
}

/**
 * Embed-backfill scheduling:
 *   - Initial sweep ~10s after boot (warm-up + catch any rows added
 *     while the process was down).
 *   - Periodic resweep every CADENCE_MS thereafter. Each sweep scans
 *     `WHERE embedding IS NULL` so a write between sweeps is picked
 *     up on the next pass.
 *
 * We deliberately don't use LISTEN/NOTIFY for the streaming case: the
 * batch shape (BATCH_SIZE rows per pull) is hostile to per-row signals,
 * and the cadence here keeps embedder cost predictable.
 *
 * CADENCE_MS: 5 min — fast enough that semantic search stays fresh for
 * a long-running server, slow enough that an empty sweep is cheap
 * (single SELECT COUNT per target table).
 */
const CADENCE_MS = 5 * 60 * 1000;

let _bootTimer: NodeJS.Timeout | null = null;
let _periodicTimer: NodeJS.Timeout | null = null;

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
