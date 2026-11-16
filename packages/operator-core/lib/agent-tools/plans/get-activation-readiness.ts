import { getBuildInfo } from '../../build-info';
import { recordExpertiseRoutingInvocation } from '../../endpoint-route/telemetry';
import { CONSULT_DEFAULT_POLICY } from '../../consult/selection-policies';
import { previewProductShaping } from './product-shaping';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';
import { conformanceActivationVerdict } from '../../spec-conformance/activation-gate';
import {
  evaluateActivationDeclarations,
  type ActivationDeclarationBlocker,
  type DeclarationStatus,
  type PlanDeclarationDiagnostic,
} from './plan-declarations';

export interface ActivationDeclarationReadiness {
  /** False only when the activation audit would refuse plan_declarations_invalid. */
  ready: boolean;
  /** False for an active/shipped plan, which the gate does not retrofit. */
  applies: boolean;
  reuse: DeclarationStatus;
  libraries: DeclarationStatus;
  blockers: ActivationDeclarationBlocker[];
  diagnostics: PlanDeclarationDiagnostic[];
}

/**
 * Readiness view of the declaration gate (R-3): the same verdict plans:audit
 * phase:activation enforces, so a missing section shows up as a blocker before
 * the audit is attempted. Pure; no consult, no database.
 */
export function activationDeclarationReadiness(
  planContent: string,
  planStatus: string | null | undefined,
): ActivationDeclarationReadiness {
  const gate = evaluateActivationDeclarations(planContent, planStatus);
  return {
    ready: gate.ok,
    applies: gate.applies,
    reuse: gate.preview.reuse.status,
    libraries: gate.preview.libraries.status,
    blockers: gate.applies ? gate.blockers : [],
    diagnostics: gate.preview.diagnostics,
  };
}

/** The finite population is part of the existing activationReadiness contract. */
export const ACTIVATION_STAGE_IDS = [
  'source-discovery', 'declarations', 'conformance', 'inputs', 'anchors', 'dependencies',
  'bar-contract', 'spec-quality', 'quality-audit', 'contract-critique',
  'admission', 'lane', 'promotion', 'consult',
] as const;
export type ActivationStageId = (typeof ACTIVATION_STAGE_IDS)[number];
export type ActivationStageStatus = 'pass' | 'blocked' | 'waiting' | 'unknown' | 'not-applicable';
export interface ActivationStageObservation {
  status: ActivationStageStatus;
  codes: string[];
  nextAction: string;
  evidenceRefs?: string[];
  detail?: string;
}
/** Preview the same executable-requirement gate used by the activation audit. */
export function activationConformanceReadiness(planContent: string): ActivationStageObservation {
  const verdict = conformanceActivationVerdict(planContent);
  return {
    status: !verdict.ok ? 'blocked' : verdict.report.applicable ? 'pass' : 'not-applicable',
    codes: verdict.ok ? [verdict.report.applicable ? 'conformance_ready' : 'conformance_not_applicable']
      : [...new Set(verdict.problems.map(problem => problem.code))],
    nextAction: verdict.ok ? 'Retain executable requirement enforcement at the activation audit.'
      : 'Repair the named Conformance problems before requesting the activation audit.',
    evidenceRefs: [...new Set(verdict.problems.map(problem => problem.barKey)
      .filter((key): key is string => Boolean(key)))],
    ...(verdict.message ? { detail: verdict.message } : {}),
  };
}
export interface ActivationStage extends ActivationStageObservation {
  id: ActivationStageId;
  dependencies: ActivationStageId[];
  omittedDetail: { codes: number; evidenceRefs: number; characters: number };
}
/** Exact pre-effect observation identity, never an execution grant. */
export interface ActivationReadinessBasis {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  planRevision: number;
  planHash: string;
  requesterId: string;
  policyHash: string;
  specSetHash: string;
  evidenceHash: string;
}
export interface PlanActivationConsultReceipt {
  basis: ActivationReadinessBasis;
  consult: PlanActivationConsultPreview;
}
/** Only the advisory identity matters; promotion/evidence writes are not consult inputs. */
export function matchingActivationConsult(receipt: PlanActivationConsultReceipt | undefined,
  basis: ActivationReadinessBasis | undefined): PlanActivationConsultPreview | undefined {
  if (!receipt?.basis || !basis || !receipt.consult?.outcome) return undefined;
  const keys = ['workspaceId', 'harnessSlug', 'planSlug', 'planHash', 'requesterId', 'policyHash'] as const;
  return keys.every(key => typeof basis[key] === 'string' && basis[key].length > 0 &&
    receipt.basis[key] === basis[key]) ? receipt.consult : undefined;
}
export interface ActivationReadinessDiagnostic {
  schemaVersion: 1;
  advisory: true;
  ready: boolean;
  freshness: 'current' | 'changed' | 'unknown';
  basis: ActivationReadinessBasis | null;
  stages: ActivationStage[];
  counts: { total: number; returned: number; omitted: number };
}
export interface ActivationReadinessReaders {
  /** Re-read raw identities at the boundary; do not re-run expensive evaluators. */
  readBasis(signal?: AbortSignal): Promise<ActivationReadinessBasis>;
  stages: Partial<Record<ActivationStageId, (signal?: AbortSignal) => Promise<ActivationStageObservation>>>;
}

/** Preserve the complete stage population when adapter setup itself fails. */
export function unavailableActivationReadiness(error: unknown): ActivationReadinessDiagnostic & {
  consult: PlanActivationConsultPreview;
} {
  const message = error instanceof Error ? error.message : String(error);
  return { schemaVersion: 1, advisory: true, ready: false, freshness: 'unknown', basis: null,
    stages: ACTIVATION_STAGE_IDS.map(id => boundedStage(id, { status: 'unknown',
      codes: ['activation_stage_unavailable'], nextAction: `Restore the ${id} read and retry.`, detail: message })),
    counts: { total: ACTIVATION_STAGE_IDS.length, returned: ACTIVATION_STAGE_IDS.length, omitted: 0 },
    consult: { outcome: 'unavailable', error: 'consult_preview_unavailable', message } };
}

const STAGE_DEPENDENCIES: Record<ActivationStageId, ActivationStageId[]> = {
  'source-discovery': [], declarations: [], conformance: [], inputs: [], anchors: [], dependencies: [],
  'bar-contract': [], 'spec-quality': ['bar-contract'], 'quality-audit': ['spec-quality'],
  'contract-critique': ['spec-quality', 'quality-audit'], admission: [], lane: [],
  promotion: [], consult: [],
};
const settledStage = (status: ActivationStageStatus) => status === 'pass' || status === 'not-applicable';
function basisKey(basis: ActivationReadinessBasis): string {
  for (const key of ['workspaceId', 'harnessSlug', 'planSlug', 'planHash', 'requesterId',
    'policyHash', 'specSetHash', 'evidenceHash'] as const) {
    if (typeof basis[key] !== 'string' || !basis[key].trim()) throw new Error(`unmeasured ${key}`);
  }
  if (!Number.isSafeInteger(basis.planRevision) || basis.planRevision < 1) throw new Error('unmeasured planRevision');
  return JSON.stringify([basis.workspaceId, basis.harnessSlug, basis.planSlug, basis.planRevision,
    basis.planHash, basis.requesterId, basis.policyHash, basis.specSetHash, basis.evidenceHash]);
}
function boundedStage(id: ActivationStageId, value: ActivationStageObservation): ActivationStage {
  if (!['pass', 'blocked', 'waiting', 'unknown', 'not-applicable'].includes(value.status) ||
      !Array.isArray(value.codes) || !value.codes.length || value.codes.some(code => typeof code !== 'string' || !code) ||
      typeof value.nextAction !== 'string' || !value.nextAction.trim() ||
      (value.evidenceRefs !== undefined && (!Array.isArray(value.evidenceRefs) ||
        value.evidenceRefs.some(ref => typeof ref !== 'string')))) throw new Error('incomplete stage observation');
  const refs = value.evidenceRefs ?? [];
  const strings = [...value.codes.slice(0, 8), ...refs.slice(0, 8), value.nextAction, value.detail ?? ''];
  return { id, status: value.status, dependencies: [...STAGE_DEPENDENCIES[id]],
    codes: value.codes.slice(0, 8).map(s => s.slice(0, 160)),
    nextAction: value.nextAction.slice(0, 600), evidenceRefs: refs.slice(0, 8).map(s => s.slice(0, 200)),
    ...(value.detail ? { detail: value.detail.slice(0, 600) } : {}),
    omittedDetail: { codes: Math.max(0, value.codes.length - 8), evidenceRefs: Math.max(0, refs.length - 8),
      characters: strings.reduce((n, s, i) => n + Math.max(0, s.length -
        (i < Math.min(8, value.codes.length) ? 160 : i < strings.length - 2 ? 200 : 600)), 0) } };
}

/**
 * Collect independent reads even after an earlier failure. Only typed dependency
 * edges delay a stage. Callers supply read capabilities, never repairs or launchers.
 * A missing read or changed basis is explicit; neither can manufacture a pass.
 */
export async function collectActivationReadiness(readers: ActivationReadinessReaders,
  signal?: AbortSignal): Promise<ActivationReadinessDiagnostic> {
  signal?.throwIfAborted();
  let basis: ActivationReadinessBasis | null = null;
  let initialKey: string | null = null;
  try {
    const initial = await readers.readBasis(signal);
    signal?.throwIfAborted();
    initialKey = basisKey(initial);
    basis = { ...initial };
  } catch { /* The whole observation stays unknown without a measurable basis. */ }
  signal?.throwIfAborted();
  const stages: ActivationStage[] = [];
  for (const id of ACTIVATION_STAGE_IDS) {
    signal?.throwIfAborted();
    const dependencies = STAGE_DEPENDENCIES[id];
    const pending = dependencies.filter(dep => !settledStage(stages.find(stage => stage.id === dep)!.status));
    let observation: ActivationStageObservation;
    if (pending.length) observation = { status: 'waiting', codes: ['activation_dependencies_not_ready'],
      nextAction: `Resolve ${pending.join(', ')} before evaluating ${id}.` };
    else {
      try {
        const read = readers.stages[id];
        if (!read) throw new Error('stage reader unavailable');
        const value = await read(signal);
        signal?.throwIfAborted();
        stages.push(boundedStage(id, value));
        continue;
      } catch (error) {
        observation = { status: 'unknown', codes: ['activation_stage_unavailable'],
          nextAction: `Restore the ${id} read and retry.`, detail: error instanceof Error ? error.message : String(error) };
      }
    }
    stages.push(boundedStage(id, observation));
  }
  signal?.throwIfAborted();
  let freshness: ActivationReadinessDiagnostic['freshness'] = 'unknown';
  if (initialKey) {
    try { freshness = basisKey(await readers.readBasis(signal)) === initialKey ? 'current' : 'changed'; }
    catch { /* Failure is unknown, never a stable scope. */ }
  }
  signal?.throwIfAborted();
  if (freshness !== 'current') {
    for (const stage of stages) {
      if (settledStage(stage.status)) {
        stage.status = 'unknown';
        stage.codes = [freshness === 'changed' ? 'activation_basis_changed' : 'activation_basis_unavailable'];
        stage.nextAction = 'Reconcile the changed or unavailable plan, policy, spec or evidence basis and collect again.';
      }
    }
  }
  return { schemaVersion: 1, advisory: true, basis, freshness,
    ready: freshness === 'current' && stages.every(stage => settledStage(stage.status)), stages,
    counts: { total: ACTIVATION_STAGE_IDS.length, returned: stages.length, omitted: 0 } };
}

/** Per-collection options; the request itself stays deadline-free. */
export interface ActivationReadinessCollectOptions {
  /** Absolute epoch-ms deadline of a bounded caller (plans:start refusal
   *  diagnostics). The consult preview reserves time for its post-embedding
   *  work and bounds the query embedding to the rest, so a slow provider
   *  degrades in band instead of sinking the whole diagnostic. */
  deadlineMs?: number;
}

export async function createPlanActivationReadinessRequest(params: Parameters<typeof createPlanActivationReadinessRequestInWorkspace>[0]) {
  const request = await runWithWorkspaceIfConcrete(params.workspaceId,
    () => createPlanActivationReadinessRequestInWorkspace(params));
  return {
    quality: () => runWithWorkspaceIfConcrete(params.workspaceId, request.quality),
    collect: (signal?: AbortSignal, options?: ActivationReadinessCollectOptions) =>
      runWithWorkspaceIfConcrete(params.workspaceId, () => request.collect(signal, options)),
    recordQuality: request.recordQuality,
    recordCritique: request.recordCritique,
    recordConsult: request.recordConsult,
  };
}

export async function readPlanActivationReadiness(params: Parameters<typeof createPlanActivationReadinessRequest>[0]) {
  return (await createPlanActivationReadinessRequest(params)).collect();
}

/** Production adapter: every capability below is a canonical read/pure evaluator. */
async function createPlanActivationReadinessRequestInWorkspace(params: {
  workspaceId: string; harnessSlug: string; planSlug: string; requesterId: string;
  planRead?: Awaited<ReturnType<typeof import('./source').readPlanBySlug>>;
  /** An existing request's actual advice may be shared without recomputing it. */
  consult?: PlanActivationConsultPreview;
  consultReceipt?: PlanActivationConsultReceipt;
  signal?: AbortSignal;
}) {
  params.signal?.throwIfAborted();
  const [{ createHash }, { withWorkspace }, source, audits, activation, inputs, anchors, scope,
    dependencies, lifecycle, quality, critique, admission, lane, work, compiler] = await Promise.all([
    import('node:crypto'), import('@papercusp/db-org'), import('./source'), import('../../plan-audits'),
    import('./plan-activation-gate'), import('./plan-input-validation'), import('../../plan-items/anchor-store'),
    import('./initial-change-scope'), import('./plan-candidate-dependencies'),
    import('../../acceptance-bar-lifecycle-evaluator'), import('./plan-spec-quality-gate'),
    import('./plan-start-critique-gate'), import('./plan-admission-gate'), import('./plan-admission-preflight'),
    import('../../work-items'), import('./spec-clause-compiler'),
  ]);
  params.signal?.throwIfAborted();
  const opts = { workspaceId: params.workspaceId, harnessSlug: params.harnessSlug };
  const planScope = { ...opts, planSlug: params.planSlug };
  const { potHomeSlugForHarness } = await import('../../hive-federation');
  params.signal?.throwIfAborted();
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  let read: Awaited<ReturnType<typeof source.readPlanBySlug>> = params.planRead ?? null;
  let basisEstablished = false;
  const current = () => {
    if (!read?.row.content) throw new Error('canonical plan unavailable');
    return read;
  };
  let declaration: ActivationDeclarationReadiness | undefined;
  let consult: PlanActivationConsultPreview | undefined = params.consult;
  let adviceBasis: ActivationReadinessBasis | undefined;
  let critiqueResult: Awaited<ReturnType<typeof critique.evaluatePlanStartBarCritique>> | undefined;
  let qualityResult: Promise<Awaited<ReturnType<typeof quality.evaluatePlanSpecQualityGate>>> | undefined;
  const readQuality = () => qualityResult ??= quality.evaluatePlanSpecQualityGate({
    harnessSlug: params.harnessSlug, planSlug: params.planSlug,
    planItemIds: (current().row.items.length ? source.planItemsForRow(current().row) : current().parsed.items)
      .filter(i => i.storedStatus !== 'dropped').map(i => i.id),
    planItems: current().row.items.length ? current().row.items : current().parsed.items,
  });
  let discovery: Awaited<ReturnType<typeof audits.withCurrentDiscovery<string>>>;
  const observation = (ok: boolean, codes: string[], nextAction: string,
    status: ActivationStageStatus = 'blocked'): ActivationStageObservation => ({
    status: ok ? 'pass' : status, codes: codes.length ? [...new Set(codes)] : ['ready'], nextAction,
  });
  // `deadlineMs` arrives per collect() call, never at construction: a canonical
  // start may build this request early (to pin quality) and only learns its
  // refusal-diagnostics deadline once it actually refuses.
  const readConsult = async (signal?: AbortSignal, deadlineMs?: number) => {
    signal?.throwIfAborted();
    consult ??= matchingActivationConsult(params.consultReceipt, adviceBasis);
    consult ??= await previewPlanStartConsult({ workspaceId: params.workspaceId, requesterId: params.requesterId,
      planSlug: params.planSlug, planContent: current().row.content }, signal,
    deadlineMs === undefined ? {} : { deadlineMs });
    signal?.throwIfAborted();
    return observation(consult.outcome !== 'unavailable', [consult.outcome],
      consult.outcome === 'unavailable' ? 'Restore consult advice; keep its availability distinct from start authority.'
        : 'Review the actual advice and give a truthful consulted/reason disposition at start.', 'unknown');
  };
  const readers: ActivationReadinessReaders = {
    async readBasis(signal) {
      signal?.throwIfAborted();
      const next = await source.readPlanBySlug(params.planSlug, opts);
      signal?.throwIfAborted();
      if (!next) throw new Error('canonical plan unavailable');
      if (!basisEstablished && read && (read.row.version !== next.row.version || read.row.contentHash !== next.row.contentHash)) {
        throw new Error('plan changed since the request snapshot');
      }
      // Preserve the first snapshot for stage evaluations; later reads only fence it.
      read ??= next;
      const policyHarness = await potHomeSlugForHarness(params.workspaceId, params.harnessSlug);
      signal?.throwIfAborted();
      const { listSpecClauses } = await import('./spec-clauses-store');
      signal?.throwIfAborted();
      const [clauses, facts, discoveryNow] = await Promise.all([
        listSpecClauses(planScope),
        withWorkspace(params.workspaceId, async tx => {
          const [row] = await tx<{ policy: unknown; evidence: unknown }[]>`
            SELECT
              (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.harness_slug),'[]'::jsonb)
               FROM harness_shared.pot_policy p WHERE p.workspace_id=${params.workspaceId}
                 AND p.harness_slug=${policyHarness ?? params.harnessSlug}) AS policy,
              jsonb_build_object(
                'audits',(SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.audit_seq),'[]'::jsonb)
                  FROM harness_shared.plan_audits a WHERE a.workspace_id=${params.workspaceId}
                    AND a.harness_slug=${params.harnessSlug} AND a.plan_slug=${params.planSlug}),
                'work',(SELECT COALESCE(jsonb_agg(jsonb_build_array(w.feature_id,w.status,w.taken_by,w.payload)
                    ORDER BY w.feature_id),'[]'::jsonb) FROM harness_shared.work_items w
                  WHERE w.workspace_id=${params.workspaceId} AND
                    ((w.harness_slug=${params.harnessSlug} AND w.source_plan_slug=${params.planSlug}) OR
                     strpos(COALESCE(w.payload->'observation'->'subject'->>'ref',''),${params.planSlug})>0)),
                'rubrics',(SELECT COALESCE(jsonb_agg(jsonb_build_array(p.plan_slug,p.content_hash,p.version,p.template_data)
                    ORDER BY p.plan_slug),'[]'::jsonb) FROM harness_shared.harness_plans p
                  WHERE p.workspace_id=${params.workspaceId} AND p.harness_slug=${params.harnessSlug}
                    AND p.template='rubric' AND (p.template_data->>'subjectPlan'=${params.planSlug}
                      OR p.plan_slug=${'acceptance-' + params.planSlug})),
                'critiques',(SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.conversation_id),'[]'::jsonb)
                  FROM harness_shared.consult_state c WHERE c.workspace_id=${params.workspaceId}
                    AND c.origin_task_ref=${params.planSlug})) AS evidence`;
          if (!row) throw new Error('readiness evidence snapshot unavailable');
          return row;
        }),
        audits.withCurrentDiscovery({ ...planScope, createdBy: params.requesterId },
          async (_tx, subject) => subject.discovery.requestKey),
      ]);
      signal?.throwIfAborted();
      discovery ??= discoveryNow;
      const basis = { ...planScope, requesterId: params.requesterId, planRevision: next.row.version,
        planHash: next.row.contentHash, policyHash: hash([facts.policy, CONSULT_DEFAULT_POLICY]),
        specSetHash: compiler.computeSpecSetHash(clauses.filter(critique.isLiveBarCritiqueClause)),
        evidenceHash: hash([facts.evidence, discoveryNow.ok ? discoveryNow.result : discoveryNow]) };
      adviceBasis ??= basis;
      basisEstablished = true;
      return basis;
    },
    stages: {
      async 'source-discovery'() {
        const verdict = await withWorkspace(params.workspaceId, tx => activation.evaluateConversationActivationGate(tx as never, planScope));
        if (!discovery) throw new Error('discovery read unavailable');
        return observation(verdict.satisfied && discovery.ok,
          [...(!verdict.satisfied ? [verdict.code ?? 'conversation_audit_required'] : []),
            ...(!discovery.ok ? [discovery.error] : [])],
          verdict.satisfied && discovery.ok ? 'Continue with the current source/discovery provenance.'
            : 'Reconcile the source conversation audit and finalize current Discovery before start.');
      },
      async declarations() {
        declaration = activationDeclarationReadiness(current().row.content, current().row.status);
        return { ...observation(declaration.ready, declaration.blockers.map(b => b.code),
          declaration.ready ? 'Retain declaration provenance.' : 'Repair the reuse/library declaration sections.'),
          ...(!declaration.applies ? { status: 'not-applicable' as const } : {}) };
      },
      async conformance() {
        return activationConformanceReadiness(current().row.content);
      },
      async inputs() {
        const row = current().row;
        const verdict = inputs.evaluatePlanStartReadiness({ template: row.template, inputSchema: row.inputSchema }, row.templateData);
        return observation(verdict.ready, verdict.ready ? ['inputs_ready'] : [verdict.code],
          verdict.ready ? 'Use the validated inputs at canonical start.' : verdict.hint);
      },
      async anchors() {
        const row = current().row;
        if (!['draft', 'ready'].includes(row.status ?? '')) return { status: 'not-applicable', codes: ['initial_scope_not_retrofitted'], nextAction: 'Retain the admitted implementation scope.' };
        const problems = scope.initialChangeScopeProblems({ content: row.content, verificationProfile: row.verificationProfile,
          anchors: await anchors.readPlanItemAnchors(planScope) });
        return { ...observation(!problems.length, problems.length ? ['initial_change_scope_missing'] : ['initial_scope_ready'],
          problems.length ? 'Declare initial source/investigation targets using plans:edit anchors.' : 'Retain the declared code targets.'), detail: problems.join('; ') };
      },
      async dependencies() {
        const verdict = dependencies.validatePlanCandidateDependencies(current().parsed, 'started');
        return observation(verdict.executable, verdict.diagnostics.map(d => d.code),
          verdict.executable ? 'Preserve the admitted dependency graph.' : 'Repair the named dependency endpoints or cycle.');
      },
      async 'bar-contract'() {
        const verdict = await lifecycle.readAndEvaluateAcceptanceBarLifecycle(params.planSlug, 'pre-start',
          { harnessSlug: params.harnessSlug, requireCompleteContractBeforeProof: true, proofMode: 'metadata' });
        return { ...observation(verdict.satisfied, verdict.codes, verdict.message ?? 'Retain the complete BAR contract.'),
          ...(!verdict.applicable && verdict.satisfied ? { status: 'not-applicable' as const } : {}) };
      },
      async 'spec-quality'() {
        const q = await readQuality();
        const exact = q.satisfied || q.code === 'spec_quality_scorecard_grading_audit_pending' || q.code === 'spec_quality_scorecard_grading_audit_failed';
        return { ...observation(exact, exact ? ['spec_quality_current'] : [q.code ?? 'spec_quality_unavailable'],
          q.message ?? 'Retain the exact spec-quality card.', q.code === 'spec_quality_unavailable' ? 'unknown' : 'blocked'),
          ...(!q.applicable && q.satisfied ? { status: 'not-applicable' as const } : {}),
          evidenceRefs: [q.specSetHash, q.scorecardId].filter((s): s is string => Boolean(s)) };
      },
      async 'quality-audit'() {
        const q = await readQuality();
        return { ...observation(q.satisfied, [q.code ?? 'quality_audit_current'], q.message ?? 'Proceed to current contract critique.',
          q.code === 'spec_quality_scorecard_grading_audit_pending' ? 'waiting' : 'blocked'),
          ...(!q.applicable && q.satisfied ? { status: 'not-applicable' as const } : {}), evidenceRefs: q.scorecardId ? [q.scorecardId] : [] };
      },
      async 'contract-critique'() {
        const q = await readQuality();
        const c = critiqueResult ?? await critique.evaluatePlanStartBarCritique({ ...planScope, contractEnforced: q.mode === 'enforced',
          nonDroppedItemCount: current().parsed.items.filter(i => i.storedStatus !== 'dropped').length });
        if (!c || c.mode === 'report-only') return { status: 'not-applicable', codes: ['critique_report_only'], nextAction: 'Preserve the canonical exemption.' };
        return { ...observation(c.verdict.satisfied, [c.verdict.code ?? 'critique_current'],
          c.verdict.message ?? 'Retain closed current independent critique provenance.'), evidenceRefs: c.verdict.consultIds };
      },
      async admission() {
        const a = await admission.checkPlanAdmission({ slug: params.planSlug, door: 'start', opts, row: current().row, readOnly: true });
        return observation(a.admitted, [a.admitted ? 'admission_ready' : a.refusal.code],
          a.admitted ? 'Recheck live admission at actual start.' : a.refusal.hint);
      },
      async lane() {
        const health = await lane.preflightExactPlanLaneHealth({ ...planScope, actor: params.requesterId,
          claimant: params.requesterId, specId: 'activation-readiness:' + params.planSlug });
        if (!health || health.effective.claimable == null) throw new Error('lane read unavailable');
        return observation(health.effective.claimable > 0, [health.effective.claimable > 0 ? 'lane_ready' : 'floor-gated'],
          health.effective.claimable > 0 ? 'Use canonical start/assignment.' : 'Inspect current claim floors or the already assigned lane; use canonical start.');
      },
      async promotion() {
        const rows = await work.listWorkItems({ harness: params.harnessSlug, sourcePlanSlug: params.planSlug,
          includeChildren: true, limit: work.WORK_ITEMS_MAX_LIMIT });
        if (rows.length >= work.WORK_ITEMS_MAX_LIMIT) throw new Error('promotion census cap reached');
        const structural = lane.evaluateExactPlanAdmission({ planSlug: params.planSlug,
          planItems: current().parsed.items, workItems: rows, laneHealth: null });
        return observation(structural.promotion.missingActionableItemIds.length === 0,
          [structural.promotion.missingActionableItemIds.length ? 'waiting-for-promotion' : 'promotion_coverage_ready'],
          'Canonical plans:start promotes and rechecks the exact current lane; this preview grants no authority.', 'waiting');
      },
      consult: (signal) => readConsult(signal),
    },
  };
  // A canonical start may evaluate quality before it refuses. Pin the same
  // request before that evaluation and reuse its result only inside this
  // request; the final basis read still invalidates a changed observation.
  let initialBasis: ActivationReadinessBasis | undefined;
  return {
    recordQuality(value: Awaited<ReturnType<typeof quality.evaluatePlanSpecQualityGate>>) {
      qualityResult = Promise.resolve(value);
    },
    recordCritique(value: Awaited<ReturnType<typeof critique.evaluatePlanStartBarCritique>>) {
      critiqueResult = value;
    },
    recordConsult(value: PlanActivationConsultPreview): PlanActivationConsultReceipt | undefined {
      consult = value;
      return adviceBasis ? { basis: { ...adviceBasis }, consult: value } : undefined;
    },
    async quality() {
      try { initialBasis ??= await readers.readBasis(); } catch { /* Diagnostic availability is never a new start gate. */ }
      return readQuality();
    },
    async collect(signal: AbortSignal | undefined = params.signal,
      options: ActivationReadinessCollectOptions = {}): Promise<ActivationReadinessDiagnostic & {
      consult: PlanActivationConsultPreview; declarations?: ActivationDeclarationReadiness;
    }> {
      let first = true;
      const { deadlineMs } = options;
      const stages: ActivationReadinessReaders['stages'] = deadlineMs === undefined ? readers.stages
        : { ...readers.stages, consult: (stageSignal) => readConsult(stageSignal, deadlineMs) };
      const result = await collectActivationReadiness({ ...readers, stages, readBasis: async readSignal => {
        if (first) {
          first = false;
          if (initialBasis) return initialBasis;
        }
        return readers.readBasis(readSignal);
      } }, signal);
      return { ...result, consult: consult ?? { outcome: 'unavailable', error: 'consult_preview_unavailable',
        message: 'Consult advice was not measured.' }, ...(declaration ? { declarations: declaration } : {}) };
    },
  };
}

/**
 * Side-effect-free activation-readiness consult preview.
 *
 * `plans:start` keeps its existing nudge semantics, but callers need the same
 * candidate selection before they commit an activation audit or freeze
 * first-class clauses. The heavyweight embedder/liveness wiring lives here so
 * the read surfaces can opt in without opening a consult thread or changing
 * start's write path.
 */
import type { PlanStartConsultOutcome } from '../../consult/plan-start-consult';

export type PlanActivationConsultPreview = (
  | PlanStartConsultOutcome
  | {
      outcome: 'unavailable';
      error: 'consult_preview_unavailable';
      message: string;
    }) & { productShaping?: ReturnType<typeof previewProductShaping> };

/**
 * EI-28809268869086841: time a deadline-bounded caller keeps back for the work
 * AFTER the preview's query embedding: the router's lexical fallback, ranking,
 * evidence and liveness legs, then the collector's final basis re-read. The
 * embedding gets what remains before `deadlineMs - reserve`; past that the
 * embedder fails closed with ETIMEDOUT and the router degrades IN BAND to its
 * labelled lexical fallback (`embeddingFailure`, `degraded:'embed-unavailable'`)
 * instead of the whole diagnostic missing its deadline.
 */
export const PLAN_ACTIVATION_PREVIEW_POST_EMBED_RESERVE_MS = 400;

export async function previewPlanStartConsult(params: {
  workspaceId: string;
  requesterId: string;
  planSlug: string;
  planContent: string;
}, signal?: AbortSignal, options: ActivationReadinessCollectOptions = {}): Promise<PlanActivationConsultPreview> {
  try {
    signal?.throwIfAborted();
    const [
      { getOrgPg },
      { routeConsult },
      { buildQueryEmbedderResolved },
      { resolveProseProfileSelection },
      { resolveSessionStates },
      consult,
    ] = await Promise.all([
      import('@papercusp/db-org'),
      import('../../consult/relevance-router'),
      import('../search/embedder'),
      import('../../search/prose-vector-dims'),
      import('../coordination/liveness-oracle'),
      import('../../consult/plan-start-consult'),
    ]);
    signal?.throwIfAborted();
    // EI-28809268869086841: this preview is advisory and runs inside bounded
    // refusal diagnostics, so it must never be what loads a local model.
    // warmOnly lets a cold in-process engine degrade the router to its labelled
    // lexical fallback instead. Starting that engine blocked the event loop for
    // 4–11s in a measured run, firing every timer deadline late.
    // warmOnly bounds only WHO may be asked. A warm out-of-process provider can
    // still be slow: the measured miss was the host's shared embed sidecar
    // (reached via PAPERCUSP_EMBED_SIDECAR_URL) taking 1847ms for one query
    // under fleet load, which consumed the 2000ms refusal-diagnostics budget.
    // A bounded caller's deadline therefore also bounds the inference itself.
    const embeddingDeadlineMs = options.deadlineMs === undefined ? undefined
      : options.deadlineMs - PLAN_ACTIVATION_PREVIEW_POST_EMBED_RESERVE_MS;
    let embeddingAcquisition: import('../search/embedder').QueryEmbedderAcquisition | undefined;
    const resolved = await buildQueryEmbedderResolved({
      warmOnly: true,
      ...(embeddingDeadlineMs === undefined ? {} : { embeddingDeadlineMs }),
      onAcquisition: (outcome) => { embeddingAcquisition = outcome; },
    });
    signal?.throwIfAborted();
    const embeddingProfile = resolved
      ? resolveProseProfileSelection(resolved.mode, resolved.profile)
      : null;
    const outcome = await consult.planStartConsult(
      params,
      {
        route: (routeParams) => {
          signal?.throwIfAborted();
          return routeConsult({ ...routeParams, telemetry: {
            caller: 'plans:activation-preview', policy: CONSULT_DEFAULT_POLICY, buildSha: getBuildInfo().sha,
          } }, {
            recordTelemetry: receipt => recordExpertiseRoutingInvocation(receipt, getOrgPg().sql),
            getSql: () => getOrgPg().sql,
            // The caller's signal reaches inference and every stage boundary, so
            // a route abandoned at the diagnostic deadline stops instead of
            // running on after the fallback has already been returned.
            signal,
            embed: resolved ? (text: string) => resolved.embed(text, signal) : null,
            embeddingProfile,
            embeddingMode: embeddingProfile && resolved ? resolved.mode : null,
            ...(embeddingAcquisition ? { embeddingAcquisition } : {}),
            getLiveness: async (ownerIds) => {
              signal?.throwIfAborted();
              const verdicts = await resolveSessionStates(
                ownerIds.map((ownerId) => ({ ownerId })),
                { hydratePerId: true },
              );
              return Object.fromEntries([...verdicts.values()].map((v) => [v.ownerId, v.sessionState]));
            },
          });
        },
        getExcerpts: (refs) => {
          signal?.throwIfAborted();
          return consult.fetchTurnExcerpts(getOrgPg().sql, params.workspaceId, refs);
        },
      },
    );
    signal?.throwIfAborted();
    return { ...outcome, productShaping: previewProductShaping(params.planContent) };
  } catch (error) {
    // A preview is advisory. Preserve the distinction between an honest empty
    // route and an instrument failure, while never making activation depend on
    // the embedder or liveness service.
    return {
      outcome: 'unavailable',
      error: 'consult_preview_unavailable',
      message: `Consult candidate preview could not be evaluated (${error instanceof Error ? error.message : String(error)}).`,
      productShaping: previewProductShaping(params.planContent),
    };
  }
}
