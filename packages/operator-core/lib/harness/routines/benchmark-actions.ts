/**
 * Benchmark system action (self-improvement-consume-edges-2026-06-12 P-033 / B-12)
 * — `system:iq-battery-gen`, the monthly cadence that gives the benchmark a
 * PULSE: each new code generation gets one budget-capped IQ-battery run, so
 * "is the system improving" has a yardstick over time (the Learning tab's
 * Benchmark trend reads the resulting beekeeper instances).
 *
 * Thin glue over the pure tick core (`lib/iq-battery/cadence-tick.ts` — budget
 * refusal, SHA identity, generation dedupe, never-throw; all unit-tested with
 * injected deps). The battery itself is the UNCHANGED gen-0 runner
 * (`runGen0Battery` — solver bees + eval-battery judge + BeekeeperStorePg), so
 * gen-N results persist beside gen-0 in the same beekeeper_* tables and the
 * existing `learning.apiary` read rolls them into the trend untouched.
 *
 * Safety (the gym precedent, D-002-adjacent): an unattended run with no
 * owner-set `payload_template.budgetUsd` REFUSES — never a defaulted spend.
 * The handler runs as ONE durable step and never throws (a thrown step invites
 * an engine replay = a second paid battery); the tick core's generation-exists
 * gate also makes a replayed tick a clean skip. Seeded by
 * `lib/iq-battery/seed-benchmark-routine.ts` (monthly, INACTIVE by default —
 * activation only makes sense once the deploy carries this action).
 */
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { runBenchmarkCadenceTick, type BenchmarkRunFn } from '../../iq-battery/cadence-tick';

/** The battery-runner seam — injectable for tests (mirrors setGymCycleRunner). */
let _runBattery: BenchmarkRunFn | null = null;
/** Override the battery runner (tests). Pass null to restore the live gen-0 runner. */
export function setBenchmarkBatteryRunner(fn: BenchmarkRunFn | null): void {
  _runBattery = fn;
}

/**
 * Default: the live gen-0 runner, imported lazily so the routines boot path
 * never loads the bee/judge graph. parseGen0Args([]) supplies the committed
 * defaults (timeouts, rate-retry policy); only the cadence-owned knobs are set.
 */
const defaultRunBattery: BenchmarkRunFn = async (req) => {
  const { runGen0Battery, parseGen0Args } = await import('../../iq-battery/beekeeper-gen0-runner');
  await runGen0Battery({
    ...parseGen0Args([]),
    harness: req.harness,
    capUsd: req.capUsd,
    casesPerVariant: req.casesPerVariant,
    repeats: req.repeats,
    dryRun: req.dryRun,
  });
};

registerSystemAction('iq-battery-gen', async (ctx: SystemActionCtx) => {
  const { sql } = getOrgPg();
  const { buildManifest } = await import('../../iq-battery/beekeeper-gen0-runner');

  const outcome = await runBenchmarkCadenceTick(
    {
      // buildManifest is the runner's own identity derivation — using it here keeps
      // the dedupe SHA byte-identical to what the battery will stamp on the instance.
      currentCodeSha: () => buildManifest(ctx.workspaceId).manifest.codeSha,
      generationExists: async (codeSha) => {
        const rows = await sql<{ one: number }[]>`
          SELECT 1 AS one FROM harness_shared.beekeeper_instances
           WHERE workspace_id = ${ctx.workspaceId} AND code_sha = ${codeSha} AND genome_id IS NULL
           LIMIT 1`;
        return rows.length > 0;
      },
      runBattery: _runBattery ?? defaultRunBattery,
      log: (m) => console.log(m),
    },
    { installSlug: ctx.installSlug, payload: ctx.payloadTemplate },
  );

  if (outcome.action === 'ran') {
    // New generation landed — nudge the Benchmark view (learning.apiary is not
    // table-backed for PG-trigger invalidation). Lazy + fire-and-forget.
    try {
      const { notifySyncInvalidate } = await import('../../sync-sse');
      void notifySyncInvalidate('learning.apiary');
    } catch {
      /* best-effort — the view refreshes on mount regardless */
    }
  }
});
