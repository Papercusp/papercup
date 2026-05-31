/**
 * Terminal finalization for the durable feature pipeline
 * (`dbos-retire-legacy-orchestrator-2026-05-31` P-001/P-002).
 *
 * Ports the legacy main-loop's `handleDone` + `handleEscalate` so the durable
 * pipeline is a COMPLETE replacement: on DONE it distills run memory (curator),
 * writes docs (documenter), optionally archives, and fires the `afterDone` hook;
 * on ESCALATE it fires `on-escalate` and runs the curator with TRIGGER=escalate.
 *
 * `planFinalization` is the PURE core (ordered step list + done-gate decision) —
 * unit-tested directly. `finalizeFeaturePipeline` is the side-effectful executor
 * (resolve project → run gates → invoke curator/documenter → archive → hooks),
 * wired into the workflow's terminal branch via `setPipelineFinalizer` and into
 * the operator at boot (orchestrator-runner). Splitting the two keeps the
 * behavior (what runs, in what order, under which gates) testable without I/O.
 */

export type FinalizationStep =
  | { kind: 'invoke'; role: string; extras: string[] }
  | { kind: 'postCuratorOutputs' }
  | { kind: 'archive' }
  | { kind: 'hook'; hook: string };

export interface FinalizationPlanInput {
  outcome: 'done' | 'escalate';
  /** Escalation reason (escalate only). */
  reason?: string;
  /** DONE gate: an open needs-human plan item blocks completion. */
  needsHumanOpen: boolean;
  /** Whether the smoke-test gate is configured to run on DONE. */
  smokeEnabled: boolean;
  /** Smoke result: true=passed, false=failed, null=not run. */
  smokePassed: boolean | null;
  /** Whether to archive the state dir on DONE (config.archiveOnDone). */
  archiveOnDone: boolean;
}

export interface FinalizationPlan {
  /** True → do NOT finalize (a DONE gate rejected completion). */
  blocked: boolean;
  /** Ordered steps the executor runs (empty when blocked). */
  steps: FinalizationStep[];
}

/**
 * Pure: decide the finalization steps for a terminal outcome.
 *  - ESCALATE → on-escalate hook, then curator(TRIGGER=escalate, REASON=…).
 *    Memory is always distilled; done-only gates never apply.
 *  - DONE → blocked if an open needs-human item exists or the smoke gate failed;
 *    otherwise curator(TRIGGER=done) → postCuratorOutputs → documenter →
 *    [archive] → afterDone hook.
 */
export function planFinalization(input: FinalizationPlanInput): FinalizationPlan {
  if (input.outcome === 'escalate') {
    return {
      blocked: false,
      steps: [
        { kind: 'hook', hook: 'on-escalate' },
        { kind: 'invoke', role: 'curator', extras: ['TRIGGER=escalate', `REASON=${input.reason ?? ''}`] },
      ],
    };
  }

  // DONE gates.
  if (input.needsHumanOpen) return { blocked: true, steps: [] };
  if (input.smokeEnabled && input.smokePassed === false) return { blocked: true, steps: [] };

  const steps: FinalizationStep[] = [
    { kind: 'invoke', role: 'curator', extras: ['TRIGGER=done'] },
    { kind: 'postCuratorOutputs' },
    { kind: 'invoke', role: 'documenter', extras: ['TRIGGER=done', 'FEATURE_ID=-'] },
  ];
  if (input.archiveOnDone) steps.push({ kind: 'archive' });
  steps.push({ kind: 'hook', hook: 'afterDone' });
  return { blocked: false, steps };
}
