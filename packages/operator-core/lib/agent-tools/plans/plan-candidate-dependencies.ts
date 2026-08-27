/**
 * Pure dependency admission for one candidate plan body.
 *
 * Plan-item `blocked-by` edges are adapted onto the shared typed dependency
 * analyser rather than maintaining a second cycle/ref implementation here.
 * Policy is intentionally small and lifecycle-aware:
 *
 *   - structural cycles are rejected in every lifecycle;
 *   - a missing blocker is an allowed, explicit `invalid-draft` diagnostic only
 *     while the plan is a non-started draft;
 *   - every other endpoint defect is rejected, and ready/active/operationally
 *     started plans therefore require a fully resolved graph.
 */

import type { ParsedPlan, PlanItem } from '@papercusp/plan-parser';
import {
  analyzeDependencyGraph,
  type DependencyEndpointDefect,
  type DependencyGraphEdgeInput,
  type DependencyIdentity,
} from '../../scheduler/dependency-graph-analysis';

const PLAN_ITEM_KIND = 'plan-item';
const EXECUTABLE_LIFECYCLE_STATUSES = new Set(['ready', 'active']);
const EXECUTABLE_OPERATIONAL_STATUSES = new Set(['started', 'paused']);

export type PlanCandidateDependencyCode =
  | 'dependency_cycle'
  | 'dependency_endpoint_missing'
  | 'dependency_endpoint_mismatched'
  | 'dependency_endpoint_ambiguous';

export type PlanCandidateDependencyDisposition = 'reject' | 'invalid-draft';

/** Exact, serializable evidence for one candidate-graph defect. */
export interface PlanCandidateDependencyDiagnostic {
  code: PlanCandidateDependencyCode;
  disposition: PlanCandidateDependencyDisposition;
  message: string;
  /** Dependant item whose edge produced this finding (cycle entry for cycles). */
  itemId: string | null;
  /** Declared endpoint ref for endpoint defects. */
  ref: string | null;
  endpointRole: DependencyEndpointDefect['role'] | null;
  /** Closed for a cycle; dependant -> declared endpoint for a ref defect. */
  path: string[];
  /** Full SCC membership for a cycle. */
  members?: string[];
  /** Competing canonical refs when endpoint resolution is ambiguous. */
  candidates?: string[];
  /** Canonical ref actually resolved when the declaration is mismatched. */
  resolvedAs?: string;
}

export interface PlanCandidateDependencyVerdict {
  state: 'valid' | 'invalid-draft' | 'rejected';
  executable: boolean;
  lifecycleStatus: string | null;
  opStatus: string | null;
  diagnostics: PlanCandidateDependencyDiagnostic[];
}

export interface InvalidPlanDependenciesValue {
  ok: false;
  code: 'invalid_plan_dependencies';
  message: string;
  dependencyDiagnostics: PlanCandidateDependencyDiagnostic[];
}

function identity(ref: string): DependencyIdentity {
  return { kind: PLAN_ITEM_KIND, ref };
}

function isTerminalItem(item: PlanItem): boolean {
  return item.storedStatus === 'done' || item.storedStatus === 'dropped';
}

/** True when this post-write candidate may be executed or resumed. */
export function isExecutablePlanCandidate(
  lifecycleStatus: string | null | undefined,
  opStatus: string | null | undefined,
): boolean {
  return (
    EXECUTABLE_LIFECYCLE_STATUSES.has(lifecycleStatus ?? '') ||
    EXECUTABLE_OPERATIONAL_STATUSES.has(opStatus ?? '')
  );
}

function endpointCode(code: DependencyEndpointDefect['code']): PlanCandidateDependencyCode {
  if (code === 'missing') return 'dependency_endpoint_missing';
  if (code === 'mismatched') return 'dependency_endpoint_mismatched';
  return 'dependency_endpoint_ambiguous';
}

function endpointDiagnostic(args: {
  defect: DependencyEndpointDefect;
  edge: DependencyGraphEdgeInput | undefined;
  draftForwardRefsAllowed: boolean;
}): PlanCandidateDependencyDiagnostic {
  const { defect, edge } = args;
  const itemId = edge?.blocked.ref ?? null;
  const ref = defect.declared.ref;
  const isAllowedDraftForwardRef =
    args.draftForwardRefsAllowed && defect.code === 'missing' && defect.role === 'blocker';
  const disposition: PlanCandidateDependencyDisposition = isAllowedDraftForwardRef
    ? 'invalid-draft'
    : 'reject';
  const path = itemId && defect.role === 'blocker' ? [itemId, ref] : [ref];
  const evidence = path.join(' -> ');
  const prefix = isAllowedDraftForwardRef
    ? 'Invalid draft forward reference'
    : 'Invalid plan dependency endpoint';

  return {
    code: endpointCode(defect.code),
    disposition,
    message: `${prefix}: ${defect.message}; path ${evidence}`,
    itemId,
    ref,
    endpointRole: defect.role,
    path,
    ...(defect.candidates?.length
      ? { candidates: defect.candidates.map((candidate) => candidate.ref) }
      : {}),
    ...(defect.resolvedAs ? { resolvedAs: defect.resolvedAs.ref } : {}),
  };
}

/**
 * Validate the complete post-write plan snapshot. Pure: no storage reads and no
 * mutation of the parsed candidate. Arrays are emitted in analyzer-stable order.
 */
export function validatePlanCandidateDependencies(
  candidate: Pick<ParsedPlan, 'frontmatter' | 'items'>,
  opStatus: string | null | undefined,
): PlanCandidateDependencyVerdict {
  const lifecycleStatus = candidate.frontmatter.status ?? null;
  const normalizedOpStatus = opStatus ?? null;
  const executable = isExecutablePlanCandidate(lifecycleStatus, normalizedOpStatus);
  const draftForwardRefsAllowed = lifecycleStatus === 'draft' && !executable;

  const edges: DependencyGraphEdgeInput[] = candidate.items.flatMap((item) =>
    item.blockedBy.map((blockerRef) => ({
      blocked: identity(item.id),
      blocker: identity(blockerRef),
      provenance: `${item.id}.blocked-by`,
    })),
  );
  const analysis = analyzeDependencyGraph({
    nodes: candidate.items.map((item) => ({
      id: identity(item.id),
      terminal: isTerminalItem(item),
    })),
    edges,
  });

  const diagnostics: PlanCandidateDependencyDiagnostic[] = [];
  for (const component of analysis.stronglyConnectedComponents) {
    const path = component.cyclePath.map((member) => member.ref);
    diagnostics.push({
      code: 'dependency_cycle',
      disposition: 'reject',
      message: `Plan dependency cycle: ${path.join(' -> ')}`,
      itemId: path[0] ?? null,
      ref: null,
      endpointRole: null,
      path,
      members: component.members.map((member) => member.ref),
    });
  }
  for (const defect of analysis.endpointDefects) {
    diagnostics.push(
      endpointDiagnostic({
        defect,
        edge: edges[defect.edgeIndex],
        draftForwardRefsAllowed,
      }),
    );
  }

  const state = diagnostics.some((diagnostic) => diagnostic.disposition === 'reject')
    ? 'rejected'
    : diagnostics.length > 0
      ? 'invalid-draft'
      : 'valid';
  return {
    state,
    executable,
    lifecycleStatus,
    opStatus: normalizedOpStatus,
    diagnostics,
  };
}

/** Non-throwing domain refusal used by the generic locked write seam. */
export function invalidPlanDependenciesValue(
  planSlug: string,
  verdict: PlanCandidateDependencyVerdict,
): InvalidPlanDependenciesValue {
  const rejected = verdict.diagnostics.filter((diagnostic) => diagnostic.disposition === 'reject');
  return {
    ok: false,
    code: 'invalid_plan_dependencies',
    message:
      `Plan '${planSlug}' dependency candidate was rejected before write: ` +
      rejected.map((diagnostic) => diagnostic.message).join('; '),
    dependencyDiagnostics: verdict.diagnostics,
  };
}
