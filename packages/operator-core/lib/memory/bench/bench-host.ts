/**
 * Bench host wiring (memory-backend-benchmark-2026-06-05 P-006, D-009):
 * the live benchmark runs with its OWN `configureMemory` host — the
 * operator's seams (admin URL, credentials, embedder cascade) reused
 * verbatim, but the memory tables pointed at an isolated `bench_memory`
 * schema so `harness_shared.memory_*` is never touched, and the SQLite
 * event-history forced in-memory so nothing lands under ~/.papercusp.
 *
 * The bench is its OWN process — `configureMemory` is process-global,
 * so this never affects the running operator.
 *
 * Exported as reusable pieces (not just the runner's internals) so the
 * scale tier (P-010) and any future bench rides the same wiring.
 */
import { Client } from 'pg';

import { configureMemory, memoryHost, pgClientFields, VEC_TABLE } from '@papercusp/memory';
import type { ResolvedVecMode } from '@papercusp/memory';
// Side-effect import: wires the operator host (admin URL, credentials,
// embedder cascade) that we then override schema-wise below.
import '../configure';

export const BENCH_SCHEMA = 'bench_memory';

/**
 * Re-point the memory host at an isolated schema (default the bench's).
 * The operator seams (admin URL, credentials, embedder cascade, the
 * session-extraction rung) carry over verbatim. Also used by the live
 * session-extraction integration probe (`../session-extraction-live.ts`),
 * which runs in its own schema so concurrent bench runs can't collide.
 */
export function setupBenchMemoryHost(schema: string = BENCH_SCHEMA): void {
  const base = memoryHost(); // the operator host '../configure' just wired
  configureMemory({
    ...base,
    schema,
    localStoreDir: null, // in-memory mem0 history — nothing under ~/.papercusp
    backend: 'mem0', // the bench constructs backends directly; keep the default sane
  });
}

/** Open a pg client against the same DB the memory host resolves. */
export async function benchPgClient(): Promise<Client> {
  const fields = await pgClientFields();
  const client = new Client(fields);
  await client.connect();
  return client;
}

/**
 * Create an isolated schema + the memory tables CLONED from the live
 * `harness_shared` definitions via `CREATE TABLE (LIKE ... INCLUDING ALL)`
 * — columns, defaults, CHECK constraints, and indexes track production BY
 * CONSTRUCTION. Idempotent.
 *
 * WHY clone instead of hand-mirroring DDL: the previous hand-written copy
 * drifted from production TWICE in one day (2026-07-13, WI-4509) —
 * (1) migration 547's memory_vec_harrier (1024-dim) was missing, so every
 * PG-backed seed failed on a missing relation once the 07-10 embedder eval
 * made harrier the active mode (EI-10793); (2) migration 578's temporal-lite
 * columns (valid_at/invalid_at/superseded_by) were missing, so every
 * canonical search threw `column c.valid_at does not exist` and the whole
 * bench read as zero recall. A clone of the live table cannot drift.
 *
 * The vec-table set still derives from the shared VEC_TABLE map
 * (vec-write.ts) — the same single source the write path uses. NOTE: LIKE
 * does not copy FOREIGN KEYS, so the bench vec tables carry no FK to
 * memory_canonical — harmless here: recall JOINs canonical (an orphaned vec
 * row can never surface), and cleanup is a whole-schema DROP CASCADE.
 *
 * ⚠ It DROPS the schema first: a run's corpus MUST start empty. Idempotence
 * belongs at the START of a run, not to the politeness of the previous one's
 * cleanup (EI-10854). This used to be CREATE-IF-NOT-EXISTS, which silently
 * seeded ON TOP of whatever was already there — so a bench killed mid-flight
 * (its cleanup DROP never ran) left rows behind that contaminated the NEXT
 * run's corpus, and the numbers came out quietly wrong rather than failing.
 * Same hazard within a single `--keep` run, where backend B seeded on top of
 * backend A. Callers are sequential (one backend context at a time), so the
 * drop can never race a live sibling.
 */
export async function ensureBenchSchema(client: Client, schema: string = BENCH_SCHEMA): Promise<void> {
  await dropBenchSchema(client, schema);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`
    CREATE TABLE ${schema}.memory_canonical
      (LIKE harness_shared.memory_canonical INCLUDING ALL)
  `);
  for (const mode of Object.keys(VEC_TABLE) as ResolvedVecMode[]) {
    const vec = VEC_TABLE[mode];
    await client.query(`
      CREATE TABLE ${schema}.${vec}
        (LIKE harness_shared.${vec} INCLUDING ALL)
    `);
  }
}

/**
 * Drop an isolated schema entirely (the run's cleanup). Retries on a lock
 * timeout (55P03): the mem0 client's pooled connections can still be
 * releasing when the drop fires, and a blocked DROP once killed a whole
 * run's report — give stragglers a moment instead of failing the run.
 */
export async function dropBenchSchema(client: Client, schema: string = BENCH_SCHEMA): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.query(`SET lock_timeout = '10s'`);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== '55P03' || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
}
