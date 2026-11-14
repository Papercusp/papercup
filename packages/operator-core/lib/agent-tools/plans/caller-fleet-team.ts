/**
 * Resolve the live members of the CALLER's fleet for exact-plan admission
 * (plans:start's member-held-lane rule, WI-6554700010048902).
 *
 * The caller's fleet comes from fleet MEMBERSHIP, never from the claim-spec
 * record: `getClaimSpecRecord` sets `fleetSlug` only for a fleet-INHERITED spec,
 * so a leader that authored its own per-cup claim-spec override read as
 * fleetless, `teamAssignees` collapsed to [] and plans:start refused
 * `floor-gated` while live members held every ready row (WI-6554700010049073).
 */
export interface CallerFleetTeamDeps {
  membership?: (workspaceId: string, ownerId: string) => Promise<{ fleetSlug: string | null } | null>;
  members?: (fleetSlug: string) => Promise<string[]>;
}

export async function resolveCallerFleetTeam(
  args: { workspaceId: string; ownerId: string },
  deps: CallerFleetTeamDeps = {},
): Promise<string[]> {
  const membership = deps.membership ?? (await import('../../fleet-membership-store')).latestFleetMembership;
  const fleetSlug = (await membership(args.workspaceId, args.ownerId))?.fleetSlug;
  if (!fleetSlug) return [];
  const members = deps.members ?? (await import('../coordination/audience-host')).listFleetControlMembers;
  return [...new Set((await members(fleetSlug)).filter((id) => Boolean(id) && id !== args.ownerId))];
}
