#!/usr/bin/env node
/**
 * One-shot bulk refill driver for migration 727 (prose vectors 384 -> 768).
 *
 * WHY THIS EXISTS. 727 necessarily DROPPED every stored prose vector (pgvector
 * cannot cast between widths), so ~399k rows now have `embedding IS NULL` and
 * the affected surfaces run LEXICAL-ONLY until they are refilled. The periodic
 * sweep alone cannot close that gap in reasonable time: `runBackfillSweep()`
 * defaults to MAX_ROWS_PER_TARGET_PER_SWEEP (BATCH_SIZE*4) on a 5-minute
 * cadence, which is ~2-5 DAYS for session_turns' 331k rows on its own
 * (EI-19375205903428632). That per-sweep ceiling is a FAIRNESS cap, not a
 * safety limit — its whole purpose is to stop one big table starving the
 * others on a routine tick.
 *
 * So this raises the ceiling rather than forking the sweep. Calling
 * `runBackfillSweep({ maxRowsPerTarget })` keeps every property the audited
 * path already provides — embedder resolution, the dims-fit guard, the org
 * pool, liveness probes, spaceAware routing, per-target error isolation and
 * the overlap guard — none of which a hand-rolled `backfillTable` loop would
 * inherit.
 *
 * COST: gemma runs LOCALLY on the :3384 sidecar, so this is wall time only —
 * no API tokens, and the daily spend governor (OpenAI-only) does not bind.
 *
 * Idempotent and safely re-runnable: the sweep selects on "vector missing OR
 * produced by a different embedder than the active one", so an interrupted run
 * simply resumes. Re-running after completion is a no-op.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// Drain-to-empty ceiling. Far above the largest target (session_turns ~331k)
// so a pass is bounded by "no rows left", never by the cap.
const MAX_ROWS_PER_TARGET = Number(process.env.REFILL_MAX_ROWS ?? 2_000_000);
// A pass can still end early (embedder hiccup, a target erroring in isolation),
// so loop until a pass does no work at all.
const MAX_PASSES = Number(process.env.REFILL_MAX_PASSES ?? 40);

const ts = () => new Date().toISOString().slice(11, 19) + 'Z';
const log = (...a) => console.log(`[refill-727 ${ts()}]`, ...a);

async function main() {
  process.env.PAPERCUSP_REPO_ROOT ??= REPO;
  const { runBackfillSweep } = await import(
    path.join(REPO, 'packages/operator-core/lib/search/embed-backfill.ts')
  );

  log(`starting — maxRowsPerTarget=${MAX_ROWS_PER_TARGET}, maxPasses=${MAX_PASSES}`);

  let grandTotal = 0;
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const t0 = Date.now();
    let result;
    try {
      result = await runBackfillSweep({ maxRowsPerTarget: MAX_ROWS_PER_TARGET });
    } catch (err) {
      log(`pass ${pass} THREW: ${err?.message ?? err}`);
      log('aborting — a throw here is not per-target isolated, so retrying blind would spin');
      process.exitCode = 1;
      return;
    }

    if (result && !Array.isArray(result) && result.skipped) {
      // 'already_running' = another sweep holds the in-process guard;
      // anything else (disabled / dims mismatch) is terminal for this run.
      log(`pass ${pass} SKIPPED: ${result.skipped}`);
      if (result.skipped === 'already_running') {
        await new Promise((r) => setTimeout(r, 15_000));
        continue;
      }
      log('terminal skip — nothing this driver can do; investigate the embedder/dims guard');
      process.exitCode = 2;
      return;
    }

    const stats = Array.isArray(result) ? result : [];
    const embedded = stats.reduce((n, s) => n + (s.embedded ?? 0), 0);
    const failed = stats.reduce((n, s) => n + (s.failed ?? 0), 0);
    grandTotal += embedded;
    const secs = ((Date.now() - t0) / 1000).toFixed(0);

    const perTable = stats
      .filter((s) => (s.embedded ?? 0) > 0 || (s.failed ?? 0) > 0)
      .map((s) => `${s.table ?? s.name ?? '?'}=${s.embedded ?? 0}${s.failed ? `/!${s.failed}` : ''}`)
      .join(' ');
    log(`pass ${pass}: embedded=${embedded} failed=${failed} in ${secs}s  ${perTable}`);

    if (embedded === 0) {
      log(`DONE — a full pass embedded nothing. total embedded this run = ${grandTotal}`);
      return;
    }
  }
  log(`stopped at MAX_PASSES=${MAX_PASSES}; total embedded this run = ${grandTotal} (re-run to continue)`);
}

main().catch((e) => {
  log('fatal:', e?.stack ?? e);
  process.exitCode = 1;
});
