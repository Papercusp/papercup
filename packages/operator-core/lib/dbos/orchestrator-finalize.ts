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

/**
 * Build the harness-scoped needs-human DONE-gate URL (P-008 fix). The plans:items
 * tool scopes by the `harness` param (defaulting to 'all' = operator plans); the
 * old `harness_slugs` param was silently ignored, so the gate over-returned
 * operator-level needs-human items and blocked EVERY harness's finalization.
 * Using `harness=<slug>` returns only THIS harness's own plans' needs-human items.
 */
export function needsHumanGateUrl(substrateBase: string, harnessSlug: string): string {
  return `${substrateBase}/api/admin/plans/items?needsHuman=true&harness=${encodeURIComponent(harnessSlug)}`;
}

export type FinalizationStep =
  | { kind: 'invoke'; role: string; extras: string[] }
  | { kind: 'postCuratorOutputs' }
  | { kind: 'archive' }
  | { kind: 'hook'; hook: string };

/**
 * The finalize recipe — the ordered role/step names a blueprint declares in
 * `gates.finalize` (`onDone` / `onEscalate`). `archive` + `postCuratorOutputs` are
 * non-role finalize STEPS (validate.ts's FINALIZE_STEPS); everything else is a role
 * dispatched with the outcome-derived extras. unify-agent-launches-as-blueprints
 * P-007: the recipe is now DECLARATIVE (resolved from the harness blueprint), not a
 * hardcoded constant — a fork that adds/removes/reorders finalize roles is honored.
 */
export interface FinalizeRecipe {
  onDone: string[];
  onEscalate: string[];
}

/**
 * The DEFAULT recipe (the `coding` blueprint's `gates.finalize`) — used when no
 * blueprint recipe is supplied, so the pure planner stays callable without I/O and
 * every pre-blueprint harness keeps the exact legacy step order:
 * DONE = curator → postCuratorOutputs → documenter → [archive]; ESCALATE = curator.
 */
export const DEFAULT_FINALIZE_RECIPE: FinalizeRecipe = {
  onDone: ['curator', 'postCuratorOutputs', 'documenter', 'archive'],
  onEscalate: ['curator'],
};

const FINALIZE_STEP_NAMES = new Set(['archive', 'postCuratorOutputs']);

export interface FinalizationPlanInput {
  outcome: 'done' | 'escalate';
  /** The feature reaching this terminal outcome — threaded to the documenter
   *  (P-023: the DONE call previously passed `FEATURE_ID=-`, a no-op). */
  featureId: string;
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
  /** The blueprint's `gates.finalize` recipe; defaults to the coding recipe. */
  finalize?: FinalizeRecipe;
  /** The blueprint's `acceptance` model (hive-blueprint-generalization P-009) — decouples
   *  "done" from "tests pass": `human-gate` blocks DONE until approved; `judge` inserts an
   *  acceptance-judge step before the onDone recipe; `tests` (the coding default) relies on
   *  the pipeline's validator/smoke gates; `none`/undefined ⇒ today's straight-through
   *  finalize, so existing harnesses are unchanged. */
  acceptanceKind?: 'tests' | 'judge' | 'human-gate' | 'none';
  /** human-gate only: whether the human acceptance approval has been granted. */
  acceptanceApproved?: boolean;
  /** The blueprint's `output.kind` (hive-blueprint-generalization P-010) — where a finished
   *  deliverable LANDS. `repo-commit` (the coding default) / undefined ⇒ unchanged (no extra);
   *  `artifacts` / `external-action` / `work-item-payload` ⇒ the output-producing finalize
   *  roles get an `OUTPUT_KIND=<kind>` extra so the documenter routes to that sink. */
  outputKind?: 'repo-commit' | 'artifacts' | 'external-action' | 'work-item-payload';
}

export interface FinalizationPlan {
  /** True → do NOT finalize (a DONE gate rejected completion). */
  blocked: boolean;
  /** Ordered steps the executor runs (empty when blocked). */
  steps: FinalizationStep[];
}

/**
 * The outcome-derived extras for a finalize role invoke. Preserves the legacy
 * shape: curator gets `TRIGGER` only (+ `REASON` on escalate); every other role
 * also gets `FEATURE_ID` (the documenter needs it; P-023).
 */
function finalizeRoleExtras(
  role: string,
  outcome: 'done' | 'escalate',
  featureId: string,
  reason?: string,
  outputKind?: FinalizationPlanInput['outputKind'],
): string[] {
  const extras = [`TRIGGER=${outcome}`];
  if (role !== 'curator') extras.push(`FEATURE_ID=${featureId}`);
  if (outcome === 'escalate') extras.push(`REASON=${reason ?? ''}`);
  // P-010: a non-repo-commit output sink is announced to the output-producing roles (the
  // documenter) so they route the deliverable to artifacts / external-action / the work-item
  // payload instead of a repo commit. repo-commit / undefined ⇒ no extra (legacy unchanged).
  if (role !== 'curator' && outputKind && outputKind !== 'repo-commit') {
    extras.push(`OUTPUT_KIND=${outputKind}`);
  }
  return extras;
}

/** Map one recipe entry → a finalization step (or null to skip, e.g. archive when off). */
function recipeEntryToStep(
  entry: string,
  outcome: 'done' | 'escalate',
  input: FinalizationPlanInput,
): FinalizationStep | null {
  if (entry === 'archive') return input.archiveOnDone ? { kind: 'archive' } : null;
  if (entry === 'postCuratorOutputs') return { kind: 'postCuratorOutputs' };
  if (FINALIZE_STEP_NAMES.has(entry)) return null; // unknown finalize-step name → skip
  return {
    kind: 'invoke',
    role: entry,
    extras: finalizeRoleExtras(entry, outcome, input.featureId, input.reason, input.outputKind),
  };
}

/**
 * Pure: decide the finalization steps for a terminal outcome, driven by the
 * blueprint's `gates.finalize` recipe (P-007). The hooks (`on-escalate` prepended
 * to escalate, `afterDone` appended to done) are executor glue around the
 * recipe's agent roles + finalize steps.
 *  - ESCALATE → on-escalate hook, then the `onEscalate` recipe (default: curator).
 *    Memory is always distilled; done-only gates never apply.
 *  - DONE → blocked if an open needs-human item exists or the smoke gate failed;
 *    otherwise the `onDone` recipe (default: curator → postCuratorOutputs →
 *    documenter → [archive]) then the afterDone hook.
 */
export function planFinalization(input: FinalizationPlanInput): FinalizationPlan {
  const recipe = input.finalize ?? DEFAULT_FINALIZE_RECIPE;

  if (input.outcome === 'escalate') {
    const steps: FinalizationStep[] = [{ kind: 'hook', hook: 'on-escalate' }];
    for (const entry of recipe.onEscalate) {
      const s = recipeEntryToStep(entry, 'escalate', input);
      if (s) steps.push(s);
    }
    return { blocked: false, steps };
  }

  // DONE gates.
  if (input.needsHumanOpen) return { blocked: true, steps: [] };
  if (input.smokeEnabled && input.smokePassed === false) return { blocked: true, steps: [] };
  // Acceptance gate (P-009): a human-gate hive blocks DONE until the human approves —
  // the pluggable-done equivalent of needsHumanOpen for a non-test-verified hive.
  if (input.acceptanceKind === 'human-gate' && !input.acceptanceApproved) {
    return { blocked: true, steps: [] };
  }

  const steps: FinalizationStep[] = [];
  // A judge-acceptance hive runs an acceptance judge before the onDone recipe (P-009) —
  // the generic-hive analogue of the coding pipeline's validator/tests gate.
  if (input.acceptanceKind === 'judge') {
    steps.push({
      kind: 'invoke',
      role: 'acceptance-judge',
      extras: finalizeRoleExtras('acceptance-judge', 'done', input.featureId, input.reason, input.outputKind),
    });
  }
  for (const entry of recipe.onDone) {
    const s = recipeEntryToStep(entry, 'done', input);
    if (s) steps.push(s);
  }
  steps.push({ kind: 'hook', hook: 'afterDone' });
  return { blocked: false, steps };
}

// ─── DONE status reconcile ────────────────────────────────────────────

/** Minimal legacy-client surface the reconcile needs (injected for tests). */
export interface ReconcileDbClient {
  prepare(sql: string): {
    get(...params: unknown[]): unknown | Promise<unknown>;
    run(...params: unknown[]): unknown | Promise<unknown>;
  };
}

/**
 * Reconcile a feature's status on an unblocked DONE: `validating` → `passed`.
 *
 * The validator agent OWNS the validating→passed PG write (validator.md "Status
 * update"), but an LLM can simply omit it — live on frame 138838461 (2026-06-09,
 * work-on-frame run #3): the validator printed "round 1: passed — 3 pass, 0 fail"
 * and exited without writing, leaving the feature `validating` forever while the
 * pipeline finalized DONE. An unblocked DONE is the pipeline's own terminal
 * verdict, so the finalizer closes the loop deterministically — but ONLY from
 * `validating` (the worker→validator handoff state awaiting that verdict write);
 * any other status (failing/todo/passed/…) is left untouched, so a hallucinated
 * DONE over a recorded failure can never force-pass.
 *
 * Returns true when the flip was applied.
 */
export async function reconcileDoneStatus(
  harnessSlug: string,
  featureId: string,
  dbc: ReconcileDbClient,
  log: (msg: string) => void = () => {},
): Promise<boolean> {
  const existing = (await dbc
    .prepare('SELECT status FROM harness_shared.harness_features_consolidated WHERE harness_slug = ? AND feature_id = ?')
    .get(harnessSlug, featureId)) as { status?: string } | undefined;
  if (existing?.status !== 'validating') return false;
  await dbc
    .prepare(
      "UPDATE harness_shared.harness_features_consolidated SET status = 'passed', updated_ts = ? WHERE harness_slug = ? AND feature_id = ? AND status = 'validating'",
    )
    .run(Date.now(), harnessSlug, featureId);
  log(
    `[dbos-finalize] ${harnessSlug}/${featureId} status reconciled validating→passed (validator omitted the PG write)`,
  );
  return true;
}
