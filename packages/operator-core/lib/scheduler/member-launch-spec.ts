import type { OrgSql } from '../work-items';
import { validateClaimSpec, type ClaimSpec, type FilterNode } from './claim-spec';
import { setClaimSpec } from './claim-spec-store';

/** Install dedicated lanes before ANY member process can take its first turn.
 * The fleet policy remains the parent fence, including its rank/states/limits.
 * ifAbsent preserves a leader's later steer when a launch transaction replays.
 */
export async function seedMemberLaunchClaimSpecs(args: {
  workspaceId: string;
  harness: string;
  updatedBy: string;
  parent: ClaimSpec;
  members: Array<{ ownerId: string; claimFilter?: FilterNode; claimKinds?: readonly string[] }>;
}, sqlOverride?: OrgSql): Promise<void> {
  const policies = args.members.flatMap((member) => {
    if (!member.claimFilter && !member.claimKinds?.length) return [];
    const filters: FilterNode[] = [];
    if (args.parent.view.filter) filters.push(args.parent.view.filter);
    if (member.claimFilter) filters.push(member.claimFilter);
    if (member.claimKinds?.length) filters.push({ field: 'kind', op: 'in', value: [...member.claimKinds] });
    const validated = validateClaimSpec({
      ...args.parent,
      specId: `member-${member.ownerId}`,
      revision: 1,
      view: { ...args.parent.view, filter: { all: filters } },
    });
    if (!validated.ok || !validated.spec) {
      throw new Error(`Invalid launch claim lane for ${member.ownerId}: ${validated.errors.join('; ')}`);
    }
    return [{ ownerId: member.ownerId, spec: validated.spec }];
  });
  // Validate the whole cohort first, then wait for EVERY write before spawning.
  // A failed write must never turn into inheritance of a broader fleet lane.
  const results = await Promise.allSettled(policies.map(async ({ ownerId, spec }) => {
    const result = await setClaimSpec({
      cupId: ownerId,
      workspaceId: args.workspaceId,
      spec,
      ifAbsent: true,
      updatedBy: args.updatedBy,
      potSlug: args.harness,
    }, sqlOverride);
    if (!result.ok) {
      // ifAbsent refuses an incumbent; confirm the member row before preserving it.
      // Inherited/default policies and unreadable state must still stop launch.
      const { getClaimSpecRecord } = await import('./claim-spec-store');
      const incumbent = await getClaimSpecRecord({ cupId: ownerId, workspaceId: args.workspaceId }, sqlOverride);
      if (incumbent.source === 'cup') return;
      throw new Error(`${ownerId}: ${result.errors.join('; ')}`);
    }
  }));
  const failures = results.flatMap((result) => result.status === 'rejected' ? [String(result.reason)] : []);
  if (failures.length) throw new Error(`Member claim-spec initialization failed: ${failures.join('; ')}`);
}
