/** Family-complete fleet claim-lane health, shared by runtime and preflight callers. */
import { formatSpecRef, type ClaimSpec, type FilterNode } from '../scheduler/claim-spec';
import { matchesClaimSpecFilter, type ClaimSpecSubject } from '../scheduler/claim-spec-match';
import type { ClaimSpecRecord } from '../scheduler/claim-spec-store';

export interface ClaimSpecFamilyReachability { issue: boolean; feature: boolean }

export interface FleetLaneHealth {
  /** Legacy issue-family aliases. New decisions must consume `effective`. */
  claimable: number;
  matchedByFilter: number;
  excluded: Record<string, number>;
  issueFamily: { claimable: number; matchedByFilter: number; excluded: Record<string, number> };
  featureFamily: {
    claimable: number | null;
    matchedByFilter: number | null;
    excluded: Record<string, number> | null;
  } | null;
  effective: {
    claimable: number | null;
    matchedByFilter: number | null;
    excluded: Record<string, number> | null;
    basis: 'issue-family' | 'feature-family' | 'issue+feature-family' | 'no-family';
  };
  familyReachability: ClaimSpecFamilyReachability;
  spec: {
    ref: string; specId: string; revision: number | null; matchedBy: string;
    harness: string; assigneeScoped: string | null;
  };
}

type Possible = { yes: boolean; no: boolean };
const SUBJECT: ClaimSpecSubject = {
  id: null, title: null, summary: null, kind: null, priority: null, tags: [], paths: [], plan: null,
  planItem: [], fleet: null, triageGate: null, age: null, riskTier: null, redundancy: null, estCost: null,
  assignee: null, severity: null, goal: null,
};

function kindLiterals(node: FilterNode | undefined, out = new Set<string>()): Set<string> {
  if (!node) return out;
  if ('field' in node) {
    if (node.field === 'kind') {
      for (const value of Array.isArray(node.value) ? node.value : [node.value]) {
        if (typeof value === 'string') out.add(value);
      }
    }
  } else if ('all' in node) node.all.forEach((child) => kindLiterals(child, out));
  else if ('any' in node) node.any.forEach((child) => kindLiterals(child, out));
  else kindLiterals(node.not, out);
  return out;
}

/** Possible-boolean evaluation: non-kind leaves are unknown, kind leaves are exact. */
function possible(node: FilterNode | undefined, kind: string): Possible {
  if (!node) return { yes: true, no: false };
  if ('field' in node) {
    if (node.field !== 'kind') return { yes: true, no: true };
    const yes = matchesClaimSpecFilter({ ...SUBJECT, kind }, node);
    return { yes, no: !yes };
  }
  if ('all' in node) {
    const children = node.all.map((child) => possible(child, kind));
    return { yes: children.every((child) => child.yes), no: children.some((child) => child.no) };
  }
  if ('any' in node) {
    const children = node.any.map((child) => possible(child, kind));
    return { yes: children.some((child) => child.yes), no: children.every((child) => child.no) };
  }
  const child = possible(node.not, kind);
  return { yes: child.no, no: child.yes };
}

/** Add overlapping family buckets; object spread would silently discard one family's count. */
function sumExcluded(issue: Record<string, number>, feature: Record<string, number>): Record<string, number> {
  const combined = { ...issue };
  for (const [key, count] of Object.entries(feature)) combined[key] = (combined[key] ?? 0) + count;
  return combined;
}

/** PURE: which storage families can this validated claim-spec possibly admit? */
export function claimSpecFamilyReachability(spec: ClaimSpec): ClaimSpecFamilyReachability {
  const issueKinds = ['bug', 'change', 'task'];
  const featureKinds = [...new Set([
    'feature', 'chunk', '__non_issue_kind__',
    ...[...kindLiterals(spec.view.filter)].filter((kind) => !issueKinds.includes(kind)),
  ])];
  return {
    issue: issueKinds.some((kind) => possible(spec.view.filter, kind).yes),
    feature: featureKinds.some((kind) => possible(spec.view.filter, kind).yes),
  };
}

/** Read every structurally reachable family for a supplied, already-validated spec. */
export async function readClaimSpecLaneHealth(args: {
  spec: ClaimSpec; record: ClaimSpecRecord; fleet: string; harness: string;
  /** Omit for a caller-neutral population read; pass an owner id for a per-member claim verdict. */
  workspaceId?: string | null; assignee?: string; rigAvailable?: boolean; matchedBy?: string;
}): Promise<FleetLaneHealth | null> {
  try {
    const { resolveClaimSpecWorkspace } = await import('../scheduler/claim-spec-store');
    const { aggregateIssueClaimExclusions } = await import('../scheduler/get-next');
    const ws = resolveClaimSpecWorkspace(args.workspaceId ?? undefined);
    const familyReachability = claimSpecFamilyReachability(args.spec);
    const issueFamily = familyReachability.issue
      ? await aggregateIssueClaimExclusions(args.spec.view.filter, {
          harness: args.harness, workspaceId: ws, states: args.spec.states,
          assignee: args.assignee, rigAvailable: args.rigAvailable,
        }).then((value) => ({
          claimable: value.claimable,
          matchedByFilter: value.matchedByFilter,
          excluded: value.excluded as unknown as Record<string, number>,
        }))
      : { claimable: 0, matchedByFilter: 0, excluded: {} };

    let featureFamily: FleetLaneHealth['featureFamily'] = null;
    if (familyReachability.feature) {
      const featureBreakdown = ws
        ? await import('../scheduler/fleet-scope-admission').then(({ diagnoseFleetScopeFeatureFamilyExclusions }) =>
            diagnoseFleetScopeFeatureFamilyExclusions({
              scope: {
                // Population reads deliberately carry no claimant. The diagnostic's
                // explicit null override below keeps caller-relative floors out of the
                // fleet-wide total.
                ownerId: args.assignee ?? '', fleetSlug: args.fleet, fleetRole: 'member',
                record: args.record, workspaceId: ws,
              },
              harness: args.harness, workspaceId: ws, states: args.spec.states,
              rigAvailable: args.rigAvailable, cooldownAssignee: args.assignee ?? null,
            }),
          )
        : null;
      featureFamily = featureBreakdown ?? { claimable: null, matchedByFilter: null, excluded: null };
    }

    const effective: FleetLaneHealth['effective'] = familyReachability.issue && familyReachability.feature
      ? featureFamily?.claimable == null || featureFamily.matchedByFilter == null || featureFamily.excluded == null
        ? { claimable: null, matchedByFilter: null, excluded: null, basis: 'issue+feature-family' }
        : {
            claimable: issueFamily.claimable + featureFamily.claimable,
            matchedByFilter: issueFamily.matchedByFilter + featureFamily.matchedByFilter,
            excluded: sumExcluded(issueFamily.excluded, featureFamily.excluded),
            basis: 'issue+feature-family',
          }
      : familyReachability.feature
        ? {
            claimable: featureFamily?.claimable ?? null,
            matchedByFilter: featureFamily?.matchedByFilter ?? null,
            excluded: featureFamily?.excluded ?? null,
            basis: 'feature-family',
          }
        : familyReachability.issue
          ? { ...issueFamily, basis: 'issue-family' }
          : { claimable: 0, matchedByFilter: 0, excluded: {}, basis: 'no-family' };

    return {
      claimable: issueFamily.claimable, matchedByFilter: issueFamily.matchedByFilter,
      excluded: issueFamily.excluded, issueFamily, featureFamily, effective, familyReachability,
      spec: {
        ref: formatSpecRef(args.spec.specId, args.spec.revision ?? args.record.revision),
        specId: args.spec.specId, revision: args.spec.revision ?? args.record.revision,
        matchedBy: args.matchedBy ?? 'supplied', harness: args.harness,
        assigneeScoped: args.assignee ?? null,
      },
    };
  } catch {
    return null;
  }
}

/** Resolve a persisted fleet spec, then delegate to the family-complete raw reader. */
export async function readFleetLaneHealth(args: {
  fleet: string; harness?: string; workspaceId?: string | null;
  assignee?: string; rigAvailable?: boolean;
}): Promise<FleetLaneHealth | null> {
  try {
    const { resolveFleetClaimSpec, resolveClaimSpecWorkspace } = await import('../scheduler/claim-spec-store');
    const ws = resolveClaimSpecWorkspace(args.workspaceId ?? undefined);
    const resolved = await resolveFleetClaimSpec({ spec: args.fleet, workspaceId: ws });
    if (!resolved) return null;
    const harness = args.harness ?? resolved.record.harnessSlug ?? null;
    if (!harness) return null;
    return readClaimSpecLaneHealth({
      spec: resolved.record.spec, record: resolved.record, fleet: resolved.fleetSlug,
      harness, workspaceId: ws, assignee: args.assignee, rigAvailable: args.rigAvailable,
      matchedBy: resolved.matchedBy,
    });
  } catch {
    return null;
  }
}
