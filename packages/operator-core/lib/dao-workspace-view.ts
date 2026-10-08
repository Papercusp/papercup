/** Read composition for the DAO UI; existing stores remain authoritative. */
import type { HiveDirectoryBrowseRow } from './discovery-hive-rows';
import type { ProjectEntry } from './harness-registry';
import type { HiveRecord } from './hive-store';
import type { HiveMemberRecord } from './hive-membership-store';
import type { ResolvedHivePolicy } from './hive-policy-store';
import type { PlanAdmissionGovernanceSnapshot } from './agent-tools/plans/plan-admission-governance-store';
import type { PlanIndexRow } from './agent-tools/plans/source';
import type { DaoRead, DaoWorkspaceView } from './dao-workspace-types';
export type { DaoRead, DaoWorkspaceView } from './dao-workspace-types';

export interface DaoWorkspaceDeps {
  projects(workspaceId: string): Promise<ProjectEntry[]>;
  hive(workspaceId: string, slug: string): Promise<HiveRecord | null>;
  members(workspaceId: string, slug: string): Promise<HiveMemberRecord[]>;
  policy(workspaceId: string, slug: string): Promise<ResolvedHivePolicy | null>;
  governance(workspaceId: string, slug: string): Promise<PlanAdmissionGovernanceSnapshot>;
  plans(workspaceId: string, slug: string): Promise<PlanIndexRow[]>;
}

const stores: DaoWorkspaceDeps = {
  projects: async workspace => (await (await import('./harness-registry')).loadHarnessRegistry(workspace)).projects,
  hive: async (workspace, slug) => (await import('./hive-store')).getHiveBySlug(workspace, slug),
  // Resolve the owner-authored federated scope; a joiner's local slug can differ.
  members: async (workspace, slug) => (await import('./federated-pot-scope')).listHiveMembersForLocalPot(workspace, slug),
  policy: async (workspace, slug) => (await import('./hive-policy-store')).getHivePolicy(workspace, slug),
  governance: async (workspaceId, potHomeSlug) => (await import('./agent-tools/plans/plan-admission-governance-store')).readPlanAdmissionGovernanceSnapshot({ workspaceId, potHomeSlug }),
  plans: async (workspaceId, harnessSlug) => (await import('./agent-tools/plans/source')).listPlanIndexRows({ workspaceId, harnessSlug, includeArchived: false, heavyFields: true }),
};

async function read<T>(operation: () => Promise<T>): Promise<DaoRead<T>> {
  try { return { status: 'ready', value: await operation() }; }
  catch { return { status: 'error', message: 'These records could not be read. Refresh to retry.' }; }
}

export async function buildDaoWorkspaceView(
  workspaceId: string,
  directory: HiveDirectoryBrowseRow,
  deps: DaoWorkspaceDeps = stores,
): Promise<DaoWorkspaceView> {
  const projects = await deps.projects(workspaceId);
  const homes = projects.filter(project => project.harness_kind === 'hive');
  // A discovered ID is not automatically a local home slug. Bind by identity.
  const bindings = await Promise.all(homes.map(async project => ({ project, hive: await deps.hive(workspaceId, project.slug) })));
  const binding = directory.hivePubkey ? bindings.find(({ project, hive }) =>
    (hive?.pubkeyBase64 ?? project.hive_pubkey) === directory.hivePubkey) : undefined;
  if (!binding) return { directoryId: directory.potId, localHomeSlug: null, status: 'not-joined' };
  const slug = binding.project.slug;
  const children = projects.filter(project => project.slug === slug || project.hive_slug === slug);
  const [members, policy, governance, work] = await Promise.all([
    read(async () => (await deps.members(workspaceId, slug)).map(member => ({ id: member.githubUserId, username: member.githubUsername, displayName: member.displayName, bindingStatus: member.bindingStatus, devices: member.deviceAttestations.length }))),
    read(async () => {
      const signed = await deps.policy(workspaceId, slug);
      return { version: signed?.policyVersion ?? 0, membership: signed?.policy.membership ?? null, admission: signed?.policy.governance?.planAdmission ?? null, delegations: signed?.policy.governance?.signingAuthority?.delegations ?? [] };
    }),
    read(async () => {
      const snapshot = await deps.governance(workspaceId, slug);
      return { events: snapshot.events.map(event => ({ eventId: event.eventId, roundId: event.roundId, kind: event.body.kind, body: event.body })), integrityErrors: snapshot.integrityErrors, conflictedRoundIds: [...snapshot.conflictedRoundIds] };
    }),
    read(async () => Promise.all(children.map(async project => ({
      slug: project.slug, title: project.slug === slug ? directory.title : project.slug,
      plans: (await deps.plans(workspaceId, project.slug)).map(plan => ({ slug: plan.planSlug, title: plan.title ?? plan.planSlug, status: plan.status ?? 'draft', owner: plan.owner ?? null, itemCount: plan.items.length })),
    })))),
  ]);
  return { directoryId: directory.potId, localHomeSlug: slug, status: 'connected', members, policy, governance, projects: work };
}
