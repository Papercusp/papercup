/**
 * `runHiveEvalGen` — the SHARED Hive-evaluation cadence orchestration (build the live cadence deps
 * → `runHiveEvalCadenceTick`), the single source of truth the `hive-eval:gen` deterministic
 * blueprint step runs (HE-07, P-050). The SIBLING of `runIqBatteryGen` (iq-battery/gen-loop.ts) —
 * same gated-tick discipline, its own slice + tables (D-006/D-011).
 *
 * Per cadence: REFUSE without an owner-set `payload.budgetUsd` (a whole-Hive generation is real LLM
 * spend — the gym's unattended-spend precedent), REFUSE on an unknowable code SHA, SKIP when a
 * generation already exists at the current (workspace, SHA) — the durable-replay / double-spend
 * guard — else run + score ONE generation of the seeded scenario corpus.
 *
 * ⚠ THE LIVE RUNNER IS OWNER-GATED P-051. The default `runBattery` REFUSES until the live whole-Hive
 * ports + score extractor are bound (D-011 — the live `HiveRunPorts` boot + the ground-truth /
 * behavior / timing extraction are the one remaining unbuilt leaf). Inject a bound `runBattery`
 * (the live `runHiveEvalGeneration` over those ports) once `live-ports.ts` lands; arming is then the
 * owner's budget + routine-active. The cadence MECHANISM (schedule / budget-gate / SHA-dedupe /
 * refuse-safely) is complete and armable today.
 *
 * Deps are injectable PARAMETERS (the op's test seam passes fakes — no PG/git/LLM).
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  runHiveEvalCadenceTick,
  type HiveEvalCadenceDeps,
  type HiveEvalCadenceOutcome,
  type HiveEvalRunFn,
} from './cadence-tick';

/**
 * The default runner REFUSES: a real Hive-eval generation needs the owner-gated live whole-Hive
 * ports + score extractor (P-051 / D-011), not yet bound. Throwing surfaces as a clean `failed` tick
 * outcome (the tick never re-throws → no durable-step replay / double spend); the cadence's other
 * gates (budget, SHA-dedupe) still do their job. Bind the live runner via the `runBattery` dep.
 */
const defaultRunBattery: HiveEvalRunFn = async () => {
  throw new Error(
    'hive-eval live generation not bound: the owner-gated live whole-Hive ports + score extractor ' +
      '(P-051 / D-011) are not yet wired. Inject a bound runBattery (live runHiveEvalGeneration) once live-ports.ts lands.',
  );
};

export interface HiveEvalGenDeps {
  /** Generation runner (default: the gated live runner — refuses until P-051 ports are bound). */
  runBattery?: HiveEvalRunFn;
  /** Short code SHA (default: buildManifest's exact form — keeps dedupe byte-identical). */
  currentCodeSha?: () => string;
  /** Does a baseline instance already exist at (workspace, sha)? (default: live PG query.) */
  generationExists?: (codeSha: string) => Promise<boolean>;
  log?: (msg: string) => void;
}

export async function runHiveEvalGen(
  input: { workspaceId: string; installSlug: string; payload?: Record<string, unknown> | null },
  deps: HiveEvalGenDeps = {},
): Promise<HiveEvalCadenceOutcome> {
  let currentCodeSha = deps.currentCodeSha;
  if (!currentCodeSha) {
    // buildManifest is the runner's own identity derivation — using it keeps the dedupe SHA
    // byte-identical to what the generation stamps on the hive_eval instance.
    const { buildManifest } = await import('../iq-battery/beekeeper-gen0-runner');
    currentCodeSha = () => buildManifest(input.workspaceId).manifest.codeSha;
  }
  const generationExists =
    deps.generationExists ??
    (async (codeSha: string) => {
      const { sql } = getOrgPg();
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM harness_shared.hive_eval_instances
         WHERE workspace_id = ${input.workspaceId} AND code_sha = ${codeSha} AND genome_id IS NULL
         LIMIT 1`;
      return rows.length > 0;
    });

  const cadenceDeps: HiveEvalCadenceDeps = {
    currentCodeSha,
    generationExists,
    runBattery: deps.runBattery ?? defaultRunBattery,
    log: deps.log ?? ((m) => console.log(m)),
  };
  return runHiveEvalCadenceTick(cadenceDeps, { installSlug: input.installSlug, payload: input.payload ?? null });
}
