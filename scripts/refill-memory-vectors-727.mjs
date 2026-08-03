#!/usr/bin/env node
/**
 * Cold-start driver for the CANONICAL MEMORY vector space after migration 727.
 *
 * WHY THIS IS SEPARATE FROM refill-prose-vectors-727.mjs. 727 had to DELETE the
 * memory_vec_* rows rather than null them (the vector column is NOT NULL, and
 * both refill paths select on row ABSENCE), so the entire memory corpus —
 * 32,641 rows, not a trickle — is unvectored at once. Until it is refilled,
 * `memory:search` / the recall fold in `coord:orient` return NOTHING. Unlike the
 * prose surfaces there is no lexical leg to fall back to, which makes this the
 * highest-value surface to restore and the reason it does not simply ride the
 * ordinary sweep.
 *
 * TWO THINGS MAKE THE ORDINARY SWEEP FAR TOO SLOW HERE:
 *   1. canonical-vec-backfill's BATCH is 100 rows per invocation. Its own
 *      comment sizes that against a 3,854-row backlog (~3.2h at a 300s tick);
 *      against a FULL 32,641-row corpus reset the same arithmetic is ~27h.
 *   2. runBackfillSweep() invokes it ONCE at the very end of a pass, and a
 *      cold-start prose pass drains session_turns' ~419k rows first — so in
 *      practice it advances 100 rows every several HOURS, not every tick.
 *
 * So this calls backfillCanonicalMemoryVectors({ limit }) directly, in a loop,
 * until a call embeds nothing. That is the same audited function the sweep
 * uses — only the cadence changes, and `limit` is a first-class dep on it.
 *
 * ⚠ DELIBERATELY SEQUENTIAL — do NOT parallelise. The embedder sidecar is a
 * shared saturable resource and a parallel burst is exactly what starved it in
 * the WI-4196 incident. This keeps one in-flight embed at a time; the per-call
 * `limit` raises throughput by cutting round-trips, not by adding concurrency.
 *
 * Idempotent and resumable: the selection predicate is "canonical memory with
 * NO row in the active vec table", so an interrupted run resumes and a re-run
 * after completion is a no-op.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const LIMIT = Number(process.env.MEMVEC_LIMIT ?? 500);
const MAX_CALLS = Number(process.env.MEMVEC_MAX_CALLS ?? 500);

const ts = () => new Date().toISOString().slice(11, 19) + 'Z';
const log = (...a) => console.log(`[memvec-727 ${ts()}]`, ...a);

async function main() {
  process.env.PAPERCUSP_REPO_ROOT ??= REPO;

  // MUST come first, and it is imported for its SIDE EFFECT, not its exports.
  // `memory/configure.ts` calls configureMemory({...}) at module top level, and
  // that injection is what gives `@papercusp/memory` its vec-table resolver.
  // Without it activeVecTable() returns null and the backfill reports
  // `skipped: 'embedder-disabled'` — which reads exactly like "embedding is
  // turned off" rather than "this process never configured the subsystem".
  // The operator gets this for free because its boot path imports configure.ts;
  // a standalone driver does not.
  await import(path.join(REPO, 'packages/operator-core/lib/memory/configure.ts'));

  const { backfillCanonicalMemoryVectors } = await import(
    path.join(REPO, 'packages/operator-core/lib/memory/canonical-vec-backfill.ts')
  );

  log(`starting — limit=${LIMIT}/call, maxCalls=${MAX_CALLS}`);
  let total = 0;
  let totalFailed = 0;

  for (let i = 1; i <= MAX_CALLS; i++) {
    const t0 = Date.now();
    let r;
    try {
      r = await backfillCanonicalMemoryVectors({ limit: LIMIT });
    } catch (err) {
      log(`call ${i} THREW: ${err?.message ?? err}`);
      process.exitCode = 1;
      return;
    }

    if (r?.skipped) {
      log(`call ${i} SKIPPED: ${r.skipped} — terminal (embedding is off); nothing this driver can do`);
      process.exitCode = 2;
      return;
    }

    total += r.embedded ?? 0;
    totalFailed += r.failed ?? 0;
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    log(
      `call ${i}: scanned=${r.scanned} embedded=${r.embedded} failed=${r.failed} in ${secs}s ` +
        `(running total ${total} embedded, ${totalFailed} failed)`,
    );

    // scanned===0 is the true terminal condition. embedded===0 with scanned>0
    // means every row in this batch FAILED — looping on that would spin, so
    // stop and say so rather than burn the sidecar.
    if ((r.scanned ?? 0) === 0) {
      log(`DONE — no rows left missing a vector. total embedded this run = ${total}`);
      return;
    }
    if ((r.embedded ?? 0) === 0) {
      log(`STALLED — scanned ${r.scanned} but embedded 0; every row failed. Investigate the embedder before re-running.`);
      process.exitCode = 3;
      return;
    }
  }
  log(`stopped at MAX_CALLS=${MAX_CALLS}; total embedded = ${total} (re-run to continue)`);
}

main().catch((e) => {
  log('fatal:', e?.stack ?? e);
  process.exitCode = 1;
});
