/**
 * lane-health.ts — the fleet's LIVE authoritative claimable count, as a shared oracle.
 *
 * EI-18681259560385029: IO shell for the idle-with-claimable alert — the fleet's live
 * authoritative claimable count, or `null` when it genuinely could not be read.
 *
 * Uses `aggregateIssueClaimExclusions` (the SAME oracle behind work_items:claimable and
 * scheduler:get_next) resolved through the SAME `resolveFleetClaimSpec` path that
 * `work_items:claimable { spec: <fleetSlug> }` uses, so the number a fleet surface acts on
 * and the number an agent sees when they check by hand structurally cannot disagree. Note
 * `claimable` is POST-floor, unlike `matchedByFilter` and previewSpecPoolEffect's `matched`
 * — those are pre-floor filter counts (~113 vs 4 on one real fleet), which is why the
 * spec-starved alert cannot stand in for this one.
 *
 * EI-18689489507862177: this used to `return breakdown.claimable` and DISCARD the rest of
 * the breakdown it had already paid for. That single lost field is what made the whole
 * "gated vs drained" distinction unavailable to the leader — `matchedByFilter` and the
 * per-floor `excluded` buckets were fetched on every brief and thrown away one line before
 * the code that needed them. Return the whole shape; the extra fields cost nothing.
 *
 * Fails soft to `null`, never to `0`: a read error must not manufacture "the lane is
 * drained" — that synthesised zero-state would silently disable every guard built on this
 * number rather than announcing itself. Every CALLER must therefore branch on `null` as
 * UNKNOWN and fail OPEN, never treat it as a drained lane.
 *
 * WHY THIS LIVES HERE (WI-5938): it was private to `agent-tools/fleet/leader-brief.ts`,
 * which reported the invariant as PROSE ("DO NOT fleet:bench it either — the lane is not
 * drained") while `fleet:bench` had no way to reach the number that prose was derived
 * from. Extracted rather than re-implemented on purpose: a second claimable count is
 * exactly the EI-19313376980892266 failure — two honest counts under different scopings
 * read as an oracle contradiction (348 vs 1698 was observed, and nearly got the claim
 * oracle reported as broken). One oracle, one number, provenance attached.
 */
import { formatSpecRef } from '../scheduler/claim-spec';

export interface FleetLaneHealth {
  /**
   * Legacy ISSUE-family alias. Kept for existing callers and payload compatibility;
   * new decisions must consume `effective` below.
   */
  claimable: number;
  /** Legacy ISSUE-family alias; see `claimable`. */
  matchedByFilter: number;
  /** Legacy ISSUE-family alias; see `claimable`. */
  excluded: Record<string, number>;
  /** The issue-family oracle behind the legacy aliases above. */
  issueFamily: {
    claimable: number;
    matchedByFilter: number;
    excluded: Record<string, number>;
  };
  /**
   * Feature-family post-floor count when the issue-family zero is not authoritative
   * for this spec. The feature helper cannot produce a pre-floor match count or an
   * exclusion breakdown, so those fields stay null rather than being fabricated.
   * Null for `featureFamily` means the feature leg was structurally unnecessary.
   */
  featureFamily: {
    claimable: number | null;
    matchedByFilter: null;
    excluded: null;
  } | null;
  /**
   * The counts callers may safely make queue/drain decisions from. A failed required
   * feature read makes these values UNKNOWN (null), never an issue-only false zero.
   */
  effective: {
    claimable: number | null;
    matchedByFilter: number | null;
    excluded: Record<string, number> | null;
    basis: 'issue-family' | 'issue+feature-family';
  };
  /** EI-19313376980892266 fix B: the scoping that PRODUCED `claimable`/`matchedByFilter`.
   *  Without it the count is not comparable to any other claimable count. */
  spec: {
    /** Human-legible `<specId> (spec rev N)` — never the bare `@` form (see formatSpecRef). */
    ref: string;
    specId: string;
    revision: number | null;
    /** How the fleet's spec row was found ('fleet-slug' | 'spec-id' | …). */
    matchedBy: string;
    /** The harness the exclusion aggregate was scoped to. */
    harness: string;
    /** The assignee the floors were evaluated for (own-claims are not self-excluded). */
    assigneeScoped: string | null;
  };
}

export async function readFleetLaneHealth(args: {
  fleet: string;
  harness?: string;
  workspaceId?: string | null;
  assignee?: string;
  rigAvailable?: boolean;
}): Promise<FleetLaneHealth | null> {
  try {
    const { resolveFleetClaimSpec, resolveClaimSpecWorkspace } = await import('../scheduler/claim-spec-store');
    const { aggregateIssueClaimExclusions } = await import('../scheduler/get-next');
    const { specIsIssueFamilyOnly } = await import('../agent-tools/scheduler/get_next');
    const ws = resolveClaimSpecWorkspace(args.workspaceId ?? undefined);
    const resolved = await resolveFleetClaimSpec({ spec: args.fleet, workspaceId: ws });
    if (!resolved) return null;
    // aggregateIssueClaimExclusions requires a harness to scope by. Prefer the caller's,
    // else the one the spec record itself rides — without either we cannot produce a
    // trustworthy number, and null (unknown) is the honest answer.
    const harness = args.harness ?? resolved.record.harnessSlug ?? null;
    if (!harness) return null;
    const breakdown = await aggregateIssueClaimExclusions(resolved.record.spec.view.filter, {
      harness,
      states: resolved.record.spec.states,
      assignee: args.assignee,
      rigAvailable: args.rigAvailable,
    });
    const issueFamily = {
      claimable: breakdown.claimable,
      matchedByFilter: breakdown.matchedByFilter,
      excluded: breakdown.excluded as unknown as Record<string, number>,
    };
    const featureProbeRequired = issueFamily.matchedByFilter === 0 && !specIsIssueFamilyOnly(resolved.record.spec);
    let featureFamily: FleetLaneHealth['featureFamily'] = null;
    let effective: FleetLaneHealth['effective'] = {
      ...issueFamily,
      basis: 'issue-family',
    };
    if (featureProbeRequired) {
      const featureWorkspaceId = ws;
      const featureAssignee = args.assignee;
      const featureClaimable =
        featureAssignee && featureWorkspaceId
          ? await (async (): Promise<number | null> => {
              const { diagnoseFleetScopeFeatureFamilyMatch } = await import('../scheduler/fleet-scope-admission');
              return diagnoseFleetScopeFeatureFamilyMatch({
                scope: {
                  ownerId: featureAssignee,
                  fleetSlug: resolved.fleetSlug,
                  fleetRole: 'member',
                  record: resolved.record,
                  workspaceId: featureWorkspaceId,
                },
                harness,
                workspaceId: featureWorkspaceId,
                states: resolved.record.spec.states,
                rigAvailable: args.rigAvailable,
              });
            })()
          : null;
      featureFamily = {
        claimable: featureClaimable,
        matchedByFilter: null,
        excluded: null,
      };
      effective = {
        claimable: featureClaimable == null ? null : issueFamily.claimable + featureClaimable,
        // The feature oracle is post-floor only. Do not fabricate a pre-floor count:
        // positive proves nonempty, while zero cannot distinguish empty from gated.
        matchedByFilter: null,
        excluded: null,
        basis: 'issue+feature-family',
      };
    }
    return {
      claimable: issueFamily.claimable,
      matchedByFilter: issueFamily.matchedByFilter,
      excluded: issueFamily.excluded,
      issueFamily,
      featureFamily,
      effective,
      // EI-19313376980892266 fix B — PROVENANCE ON A DERIVED NUMBER. `claimable` is
      // produced under THIS spec, THIS harness and THIS assignee scoping; the same
      // question asked under the default spec legitimately returns a different number
      // (observed: 348 here beside work_items:claimable's 1698, which reads as an oracle
      // contradiction and nearly got the claim oracle reported as broken). Naming the
      // scoping makes the two comparable instead of apparently conflicting.
      spec: {
        ref: formatSpecRef(resolved.record.spec.specId, resolved.record.spec.revision ?? resolved.record.revision),
        specId: resolved.record.spec.specId,
        revision: resolved.record.spec.revision ?? resolved.record.revision,
        matchedBy: resolved.matchedBy,
        harness,
        assigneeScoped: args.assignee ?? null,
      },
    };
  } catch {
    return null;
  }
}
