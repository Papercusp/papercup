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

import { configureMemory, memoryHost, pgClientFields } from '@papercusp/memory';
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
 * Create an isolated schema + the memory tables in migration 081's shape
 * (mirrored from the live `harness_shared` definitions). Idempotent.
 */
export async function ensureBenchSchema(client: Client, schema: string = BENCH_SCHEMA): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.memory_canonical (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      last_validated_at timestamptz,
      last_surfaced_at timestamptz,
      state text NOT NULL DEFAULT 'active'
        CHECK (state IN ('active','broken_anchor','superseded','contradicted','forgotten','archived'))
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS memory_canonical_user_id_idx
      ON ${schema}.memory_canonical ((payload->>'user_id'))
  `);
  // One vec table per embedding SPACE — must mirror the production set
  // (migration 534 added memory_vec_gemma). Omitting a space makes a bench run
  // in that mode fail on a missing relation instead of measuring it.
  for (const vec of ['memory_vec_openai', 'memory_vec_local', 'memory_vec_gemma']) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.${vec} (
        memory_id uuid PRIMARY KEY REFERENCES ${schema}.memory_canonical(id) ON DELETE CASCADE,
        vector vector(384) NOT NULL,
        embedded_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${vec}_hnsw_idx
        ON ${schema}.${vec} USING hnsw (vector vector_cosine_ops)
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
