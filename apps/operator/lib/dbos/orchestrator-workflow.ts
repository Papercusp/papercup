/**
 * Phase 3 (P-004) of `dbos-durable-jobs-2026-05-31` — the agent pipeline as a
 * DBOS durable workflow (sub-plan `dbos-orchestrator-durability-2026-05-31`).
 *
 * A feature's pipeline is a **dynamic dispatch loop**: each turn an orchestrator
 * agent decides the next role (`NEXT_WORKER` / `NEXT_VALIDATOR` / … / `DONE`), and
 * that role runs. Each agent run is a checkpointed DBOS **step** (driven through
 * `invoke()`'s `idempotencyKey`), so a crash resumes mid-pipeline without
 * re-running completed roles (parent D-019). The dispatch is deterministic given
 * the checkpointed step outputs (`parseDecision` is pure), so workflow replay is
 * safe (D-004) — all agent spawning + the LLM decision live INSIDE steps.
 *
 * Flag-gated by `PAPERCUSP_DBOS_ORCHESTRATOR=1` (registered only when the DBOS
 * bootstrap loads this). The legacy main loop stays the default + A/B fallback
 * (D-006). This handles the COMMON sequential pipeline; parallel lanes / branch
 * isolation / the synthesizer (P-008/P-009) still route through the legacy loop.
 *
 * The agent runner is injected (`setPipelineInvokeRunner`): the operator wires
 * the real `invoke()` (building the InvokeContext via harness-invoke-once);
 * tests inject a stub. This keeps the workflow free of operator/orchestrator
 * ctx-building and directly testable.
 */
import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import { parseDecision } from '@papercusp/orchestrator';

export interface PipelineInput {
  harnessSlug: string;
  featureId: string;
  /** The primary/orchestrator role that decides the next action. Default 'director'. */
  orchestratorRole?: string;
}

/**
 * One agent run. Returns the agent's final text + exit code. The operator wires
 * the real runner (it builds the InvokeContext + calls `invoke()` with
 * `options.idempotencyKey = key`, so a re-run of a completed agent is reused, not
 * re-spawned — P-015); tests inject a stub.
 */
export type PipelineInvokeRunner = (
  role: string,
  featureId: string,
  idempotencyKey: string,
) => Promise<{ output: string; exitCode: number }>;

let _runner: PipelineInvokeRunner | null = null;
export function setPipelineInvokeRunner(fn: PipelineInvokeRunner): void {
  _runner = fn;
}
function runner(): PipelineInvokeRunner {
  if (!_runner) {
    throw new Error('[dbos-orchestrator] invoke runner not wired — call setPipelineInvokeRunner() first');
  }
  return _runner;
}

const MAX_TURNS = Number(process.env.PAPERCUSP_DBOS_PIPELINE_MAX_TURNS ?? 200);
const TERMINAL = new Set(['DONE', 'ESCALATE', 'IDLE']);

// The dispatch verbs this durable pipeline handles. Verbs outside this map
// (NEXT_HARNESS, NEXT_EXPERT, parallel NEXT_WORKER with N=, …) are left to the
// legacy main loop: the workflow stops and the caller falls back.
const VERB_TO_ROLE: Record<string, string> = {
  NEXT_WORKER: 'worker',
  NEXT_VALIDATOR: 'validator',
  NEXT_ARCHITECT: 'architect',
  NEXT_SCOPER: 'scoper',
  NEXT_TESTER: 'tester',
  NEXT_SECURITY: 'security',
};

const key = (slug: string, feature: string, role: string, turn: number): string =>
  `${slug}:${feature}:${role}:t${turn}`;

async function featurePipelineImpl(input: PipelineInput): Promise<string> {
  const orchestratorRole = input.orchestratorRole ?? 'director';
  let lastVerb = 'NONE';
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Step: the orchestrator agent decides the next action (checkpointed).
    const decision = await DBOS.runStep(
      () => runner()(orchestratorRole, input.featureId, key(input.harnessSlug, input.featureId, orchestratorRole, turn)),
      { name: `decide-${turn}` },
    );
    const parsed = parseDecision(decision.output);
    if (!parsed || TERMINAL.has(parsed.verb)) {
      lastVerb = parsed?.verb ?? 'NONE';
      break;
    }
    const role = VERB_TO_ROLE[parsed.verb];
    if (!role || parsed.n != null) {
      // Unsupported here (parallel-lane NEXT_WORKER N=k, NEXT_HARNESS, …) — stop;
      // the caller routes this feature through the legacy main loop.
      lastVerb = `UNSUPPORTED:${parsed.verb}`;
      break;
    }
    const feature = parsed.arg ?? input.featureId;
    // Step: run the dispatched role as an idempotent agent run (checkpointed).
    await DBOS.runStep(
      () => runner()(role, feature, key(input.harnessSlug, feature, role, turn)),
      { name: `invoke-${role}-${turn}` },
    );
    lastVerb = parsed.verb;
  }
  return `pipeline-complete (last=${lastVerb})`;
}

export const featurePipelineWorkflow = DBOS.registerWorkflow(featurePipelineImpl, {
  name: 'featurePipeline',
  maxRecoveryAttempts: 10,
});

export const pipelineQueue = new WorkflowQueue('feature-pipeline', { concurrency: 4 });

/**
 * Start (or resume) a feature's durable pipeline. The workflow ID is
 * deterministic per feature, so a re-dispatch resumes the same workflow rather
 * than starting a second one; the dedup ID guards concurrent double-dispatch.
 */
export async function startFeaturePipeline(input: PipelineInput): Promise<string> {
  const workflowID = `pipeline:${input.harnessSlug}:${input.featureId}`;
  await DBOS.startWorkflow(featurePipelineWorkflow, {
    workflowID,
    queueName: pipelineQueue.name,
    enqueueOptions: { deduplicationID: workflowID },
  })(input);
  return workflowID;
}
