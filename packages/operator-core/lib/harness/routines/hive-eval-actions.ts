/**
 * Hive-evaluation battery system action (hive-run-evaluation-2026-06-13 HE-07, P-050) —
 * `system:hive-eval-battery`, the monthly cadence that gives the Hive-RUN benchmark a PULSE: each
 * new code generation gets one budget-capped SCORED run of the seeded scenario corpus, so "is the
 * Hive getting better at good/efficient/fast" has a yardstick over time (the Learning tab's
 * Benchmark trend reads the resulting hive_eval scores — the acceptance yardstick for the queen
 * plans, D-007). The SIBLING of `system:iq-battery-gen` (benchmark-actions.ts) — same cadence
 * discipline, its own slice + tables (D-006/D-011), never contaminating the apiary instance trend.
 *
 * Thin glue over the pure tick core (`lib/hive-eval/cadence-tick.ts` — budget refusal, SHA identity,
 * generation dedupe, never-throw; all unit-tested with injected deps). The generation itself is
 * `runHiveEvalGeneration` (battery → HE-06 score → persist).
 *
 * Safety (the gym/IQ-battery precedent): an unattended run with no owner-set
 * `payload_template.budgetUsd` REFUSES — a whole-Hive generation is real LLM spend (owner-gated
 * P-051). The handler runs as ONE durable step and never throws (a thrown step invites an engine
 * replay = a second paid generation); the tick's generation-exists gate also makes a replayed tick
 * a clean skip. Seeded by `lib/hive-eval/seed-hive-eval-routine.ts` (monthly, INACTIVE by default).
 *
 * ⚠ THE LIVE RUNNER IS OWNER-GATED P-051. The default runBattery REFUSES until the live whole-Hive
 * ports + score extractor are bound (D-011 — the live `HiveRunPorts` boot + `collectRunData`
 * ground-truth/behavior/timing extraction are the one remaining unbuilt leaf). Bind the live runner
 * via {@link setHiveEvalBatteryRunner} once `live-ports.ts` lands; then arming = owner budget +
 * routine active. The cadence MECHANISM (schedule / budget-gate / SHA-dedupe / refuse-safely) is
 * complete and armable today.
 */
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { runHiveEvalCadenceTick, type HiveEvalRunFn } from '../../hive-eval/cadence-tick';

/** The generation-runner seam — injectable for tests + for binding the live runner at P-051. */
let _runBattery: HiveEvalRunFn | null = null;
/** Bind the generation runner (the live whole-Hive runner at P-051, or a test fake). null restores the gated default. */
export function setHiveEvalBatteryRunner(fn: HiveEvalRunFn | null): void {
  _runBattery = fn;
}

/**
 * The default runner REFUSES: a real Hive-eval generation needs the owner-gated live whole-Hive
 * ports + score extractor (P-051 / D-011), which are not yet bound. Throwing here surfaces as a
 * clean `failed` tick outcome (the tick never re-throws → no durable-step replay / double spend),
 * and the cadence's other gates (budget, SHA-dedupe) still do their job. Bind the live runner via
 * setHiveEvalBatteryRunner once live-ports.ts lands.
 */
const defaultRunBattery: HiveEvalRunFn = async () => {
  throw new Error(
    'hive-eval live generation not bound: the owner-gated live whole-Hive ports + score extractor ' +
      '(P-051 / D-011) are not yet wired. Bind via setHiveEvalBatteryRunner once live-ports.ts lands.',
  );
};

registerSystemAction('hive-eval-battery', async (ctx: SystemActionCtx) => {
  const { sql } = getOrgPg();
  const { buildManifest } = await import('../../iq-battery/beekeeper-gen0-runner');

  const outcome = await runHiveEvalCadenceTick(
    {
      // Reuse the runner's own identity derivation so the dedupe SHA is byte-identical to the
      // SHA the generation stamps on the hive_eval instance.
      currentCodeSha: () => buildManifest(ctx.workspaceId).manifest.codeSha,
      generationExists: async (codeSha) => {
        const rows = await sql<{ one: number }[]>`
          SELECT 1 AS one FROM harness_shared.hive_eval_instances
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
    // A new scored generation landed — nudge the Benchmark view's Hive-orchestration trend.
    try {
      const { notifySyncInvalidate } = await import('../../sync-sse');
      void notifySyncInvalidate('learning.hiveEvalTrend');
    } catch {
      /* best-effort — the view refreshes on mount regardless */
    }
  }
});
