/**
 * plans:census — the plan-portfolio census on demand, and the recorder of its labelled runs
 * (plan-portfolio-flow-and-weight-2026-11-13 P-001).
 *
 * Reuses the census and its registered instruments (plan-portfolio/) and the results ledger;
 * it adds no table. No existing verb fit: a registered instrument is otherwise measured only
 * through a rubric criterion bound to it, and a labelled run belongs to no rubric.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import type { RubricCheckResult } from '../../check-results-ledger';
import {
  DEFAULT_CENSUS_POPULATION, resolveCensusManifest, runPlanPortfolioCensus,
  type CensusPlanStore, type CensusRun,
} from '../../plan-portfolio/census';
import {
  CENSUS_RUN_LABELS, PLAN_PORTFOLIO_INSTRUMENT_MAX_BATCHES,
  measuresWithoutPairedRuns, readCensusRunRows, recordPlanPortfolioCensusRun,
  type CensusRunLabel, type CensusRunRow, type CensusPopulationSnapshotRef, type SaveCensusPopulationSnapshot,
} from '../../plan-portfolio/census-instruments';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';

/** Seams for the unit test; production reads Postgres and writes the results ledger. */
export interface PlanCensusDeps {
  store?: CensusPlanStore;
  now?: () => number;
  saveSnapshot?: SaveCensusPopulationSnapshot;
  readRunRows?: (label: CensusRunLabel) => Promise<Map<string, CensusRunRow>>;
  recordResults?: (
    results: RubricCheckResult[],
    scope: { workspaceId: string; harnessSlug: string; runGroupId: string },
  ) => Promise<number[]>;
}

export type PlanCensusRefusal =
  | 'exact_workspace_required' | 'census_harness_only' | 'label_already_recorded' | 'no_baseline_run' | 'census_incomplete';

function refuse(error: PlanCensusRefusal, hint: string) {
  return { ok: false as const, error, hint };
}

function latestFinishedAt(rows: ReadonlyMap<string, CensusRunRow>): string | null {
  let latest: string | null = null;
  for (const row of rows.values()) {
    if (latest === null || Date.parse(row.finishedAt) > Date.parse(latest)) latest = row.finishedAt;
  }
  return latest;
}

function populationSnapshots(rows: ReadonlyMap<string, CensusRunRow>) {
  const refs = new Map<string, CensusPopulationSnapshotRef>();
  const missing: string[] = [];
  for (const [id, row] of rows) {
    if (!row.populationSnapshot) missing.push(id);
    else refs.set(JSON.stringify(row.populationSnapshot), row.populationSnapshot);
  }
  return { refs: [...refs.values()], missing };
}

/**
 * Read the census, or record it under a label. A label that already has a run is refused
 * unless `replace` is set, so a baseline never moves by accident; earlier rows always stay in
 * the ledger. An incomplete run is refused with its omission count and cursor: no partial
 * value is returned or recorded.
 */
export async function planCensus(
  input: { workspaceId: string | null | undefined; harnessSlug: string; record?: CensusRunLabel; replace?: boolean },
  deps: PlanCensusDeps = {},
) {
  const workspaceId = (input.workspaceId ?? '').trim();
  if (!workspaceId || workspaceId === '*') {
    return refuse('exact_workspace_required', 'The census reads one workspace; none was resolved for this call.');
  }
  if (input.harnessSlug !== DEFAULT_CENSUS_POPULATION.harness) {
    return refuse('census_harness_only', `The census manifest records the ${DEFAULT_CENSUS_POPULATION.harness} harness only.`);
  }
  const manifest = resolveCensusManifest();
  const measureIds = manifest.measures.map((entry) => entry.id);
  const readRows = deps.readRunRows ?? ((label: CensusRunLabel) => readCensusRunRows({ label, workspaceId, measureIds }));

  let run: CensusRun;
  let recorded: { label: CensusRunLabel; runGroupId: string; testRunIds: number[];
    populationSnapshot: CensusPopulationSnapshotRef } | null = null;
  if (input.record) {
    const label = input.record;
    const [baseline, existing] = await Promise.all([readRows('baseline'), readRows(label)]);
    if (label === 'final' && baseline.size === 0) {
      return refuse('no_baseline_run', 'Record the baseline run first; a final run is compared with it.');
    }
    if (existing.size > 0 && !input.replace) {
      return {
        ...refuse('label_already_recorded',
          `A ${label} run is already recorded. Pass replace:true to record a newer one; the earlier rows stay in the ledger.`),
        label, recordedMeasures: existing.size, recordedAt: latestFinishedAt(existing),
        testRunIds: [...existing.values()].map((row) => row.testRunId),
      };
    }
    try {
      const out = await recordPlanPortfolioCensusRun({
        label, workspaceId,
        ...(deps.store ? { store: deps.store } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.recordResults ? { record: deps.recordResults } : {}),
        ...(deps.saveSnapshot ? { saveSnapshot: deps.saveSnapshot } : {}),
      });
      run = out.run;
      recorded = { label, runGroupId: out.runGroupId, testRunIds: out.testRunIds, populationSnapshot: out.populationSnapshot };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith('census_run_incomplete')) throw error;
      return refuse('census_incomplete', `${message}; nothing was recorded.`);
    }
  } else {
    const store = deps.store ?? (await import('../../plan-portfolio/census-store')).createPgCensusPlanStore({ workspaceId });
    run = await runPlanPortfolioCensus({
      store, manifest, maxBatches: PLAN_PORTFOLIO_INSTRUMENT_MAX_BATCHES,
      ...(deps.now ? { now: deps.now() } : {}),
    });
    if (!run.complete) {
      return {
        ...refuse('census_incomplete', 'The run reached its work bound before reading every plan; no value is returned.'),
        omitted: run.omitted, cursor: run.cursor?.after ?? null, plansRead: run.plansRead,
      };
    }
  }

  const [baseline, final] = await Promise.all([readRows('baseline'), readRows('final')]);
  const pairing = measuresWithoutPairedRuns({ measureIds, baseline, final });
  return {
    ok: true as const,
    mode: recorded ? 'recorded' as const : 'read' as const,
    ...(recorded ?? {}),
    runAt: run.runAt, plansRead: run.plansRead, omitted: run.omitted,
    manifest: { version: run.manifestVersion, fingerprint: run.manifestFingerprint },
    population: run.population,
    measures: Object.values(run.measures).map((measure) => ({
      id: measure.id, title: measure.title, unit: measure.unit, value: measure.value, components: measure.components,
    })),
    // `sample` is a labelled preview; `count` is exact.
    heldOnlyWorkableItems: run.heldOnlyWorkableItems,
    populationSnapshots: { baseline: populationSnapshots(baseline), final: populationSnapshots(final) },
    pairing: {
      lacking: pairing.lacking, paired: pairing.paired.length,
      baselineMeasures: baseline.size, finalMeasures: final.size,
    },
  };
}

const argsSchema = z.object({
  harness: harnessArg,
  record: z.enum(CENSUS_RUN_LABELS).optional()
    .describe('Record this run in the results ledger under the label. Omit to read only.'),
  replace: z.boolean().optional()
    .describe('Record a newer run of a label that already has one. Earlier rows stay in the ledger.'),
});

export default defineTool({
  name: 'plans:census',
  description:
    'Read the plan-portfolio census: nine measures of the open plans (created vs shipped, held and blocked items, idle and unshipped plans, plan size, decisions, near-twin pairs), the workable items only the plan-line hold blocks, and whether a baseline and a final run share one definition. `record` writes a labelled run to the results ledger.',
  guidance: {
    when: 'Re-reading the portfolio measures, or recording the baseline or final run of a before/after comparison.',
    notWhen: 'Counting plans by status or day — plans:list { groupBy, aggregateOnly }.',
    chaining: 'plans:census { record:"baseline" } before the work → { record:"final" } after it; pairing.lacking is empty when both runs share one definition.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    return {
      data: await planCensus({
        workspaceId: sctx.workspaceId, harnessSlug: resolveEffectiveHarnessSlug(sctx),
        ...(args.record ? { record: args.record } : {}), ...(args.replace ? { replace: true } : {}),
      }),
    };
  },
});
