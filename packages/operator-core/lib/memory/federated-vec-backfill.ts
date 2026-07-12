/**
 * federated-vec-backfill.ts — give FEDERATED memory rows a LOCAL vector, so a
 * memory a peer shared with us is actually RECALLABLE here (EI-10405).
 *
 * WHY THIS EXISTS. mem0-cross-machine-federation-2026-07-10 federates memory
 * TEXT only: the wire deliberately carries no vectors (EI-9308 — "federate the
 * memory TEXT ... and let each peer RE-EMBED LOCALLY", because two hives can run
 * different embedder modes and their vector spaces aren't comparable). The
 * receive side never built that re-embed leg: `projections/p2p-memories.ts`
 * writeToPg upserts `memory_canonical` with raw SQL, bypassing
 * `CanonicalVectorStore.insert` — the ONLY writer of `memory_vec_*` rows. So a
 * projected row arrives with canonical text and NO vector in any mode, while
 * recall's primary path (`CanonicalVectorStore.search`) JOINs
 * `memory_vec_<active>` and therefore can never return it. Before this sweep, a
 * shared memory was listed on the settings page and returned by the EMBED-FREE
 * lexical fallback (which only runs when the embedder is DOWN) — and was
 * invisible to every normal recall. This closes that gap.
 *
 * SHAPE — mirrors the memory write-journal drain, which rides the same 5-min
 * embed-backfill tick (`search/embed-backfill.ts` runEmbedBackfillOnce):
 * bounded per pass, non-fatal, and SELF-HEALING — a row without a vector is
 * simply picked up again next tick, so an embedder outage (sidecar down, quota
 * cooldown) delays recall instead of losing it permanently.
 *
 * WHY NOT EMBED INLINE IN THE PROJECTION: writeToPg runs inside the hyperbee
 * apply loop. A per-row network embed (~100ms–6s, and the sidecar can be
 * down/quota-cooled) would stall the apply pipeline for EVERY federated table,
 * and a failed inline embed would leave that row permanently unrecallable with
 * nothing to retry it. The cost of doing it here instead: recall lags federation
 * by at most one tick.
 *
 * SCOPE — federated rows ONLY (`source_hive IS NOT NULL`). Local rows missing a
 * vector in the active mode are the residue of embedder-MODE SWITCHES, and those
 * belong to the user-initiated re-embed pass (POST /api/user/memory/reembed):
 * auto-embedding them in the background would silently change the embed-quota
 * profile. Federated rows have no such path — nothing else will ever embed them.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeVecTable, embedAndUpsertVector } from '@papercusp/memory';

type Sql = ReturnType<typeof getOrgPg>['sql'];

/** Rows embedded per pass — bounds embedder pressure (this sweep competes with
 *  live traffic for the embedder), mirroring the journal drain's DRAIN_BATCH. */
const BATCH = (() => {
  const v = Number(process.env.PAPERCUSP_MEMORY_FED_VEC_BATCH);
  return Number.isFinite(v) && v > 0 ? v : 25;
})();

export interface FederatedMemoryRow {
  id: string;
  data: string;
}

export interface FederatedVecBackfillResult {
  scanned: number;
  embedded: number;
  failed: number;
  /** Set when the pass did no work BY CONSTRUCTION (embedding is off) — distinct
   *  from an honest empty sweep, which reports scanned:0 with no `skipped`. */
  skipped?: 'embedder-disabled';
}

export interface FederatedVecBackfillDeps {
  sql?: Sql;
  resolveVecTable?: typeof activeVecTable;
  selectRows?: (sql: Sql, schema: string, vecTable: string, limit: number) => Promise<FederatedMemoryRow[]>;
  embed?: (memoryId: string, text: string) => Promise<boolean>;
  limit?: number;
}

/**
 * Federated memory rows with no vector in the ACTIVE mode's vec table — i.e. the
 * rows semantic recall currently cannot see. Guards mirror the canonical store's
 * own reads (`canonical-store.ts` search/list): entity rows (mem0's linking rows,
 * identified by `entityType`) and archived rows are never memories to recall, and
 * a row with empty text has nothing to embed.
 *
 * `vecTable` comes from the memory lib's FIXED mode→table lookup (never caller
 * input), so interpolating it as an identifier is safe; `limit` is bound.
 */
export async function selectFederatedRowsMissingVectors(
  sql: Sql,
  schema: string,
  vecTable: string,
  limit: number,
): Promise<FederatedMemoryRow[]> {
  const rows = await sql.unsafe(
    `SELECT c.id::text AS id, c.payload->>'data' AS data
       FROM ${schema}.memory_canonical c
      WHERE c.source_hive IS NOT NULL
        AND NOT (c.payload ? 'entityType')
        AND c.state != 'archived'
        AND coalesce(c.payload->>'data', '') != ''
        AND NOT EXISTS (
              SELECT 1 FROM ${schema}.${vecTable} v WHERE v.memory_id = c.id)
      ORDER BY c.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows as unknown as FederatedMemoryRow[];
}

/**
 * One bounded pass: embed federated memories that recall can't see yet.
 *
 * Sequential by design — the embedder sidecar is a shared, saturable resource
 * (a parallel burst is what starved it in the WI-4196 incident), and this is a
 * background pass with no latency budget.
 */
export async function backfillFederatedMemoryVectors(
  deps: FederatedVecBackfillDeps = {},
): Promise<FederatedVecBackfillResult> {
  const resolveVecTable = deps.resolveVecTable ?? activeVecTable;
  const selectRows = deps.selectRows ?? selectFederatedRowsMissingVectors;
  const embed = deps.embed ?? embedAndUpsertVector;
  const limit = deps.limit ?? BATCH;

  // No active vec table = embedding is off. Recall reads no vector space at all,
  // so there is nothing to backfill INTO — skip rather than guess a table.
  const active = await resolveVecTable();
  if (!active) return { scanned: 0, embedded: 0, failed: 0, skipped: 'embedder-disabled' };

  const sql = deps.sql ?? getOrgPg().sql;
  const rows = await selectRows(sql, active.schema, active.table, limit);

  let embedded = 0;
  let failed = 0;
  for (const row of rows) {
    // embedAndUpsertVector is non-fatal BY CONTRACT (returns false, never
    // throws), but the seam is injectable — a throwing impl must not abort the
    // pass and strand the remaining rows. A failed row keeps its missing vector
    // and is retried on the next tick.
    let ok = false;
    try {
      ok = await embed(row.id, row.data);
    } catch {
      ok = false;
    }
    if (ok) embedded++;
    else failed++;
  }

  return { scanned: rows.length, embedded, failed };
}
