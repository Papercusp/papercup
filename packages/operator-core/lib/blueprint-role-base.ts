/** Installed custom-role aliases affect only dispatch's agentRoles check. */
import { getOrgPg } from '@papercusp/db-org';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { AGENT_ROLES } from '@papercusp/agent-mcp/role-config';
import { getEffectiveBlueprint } from './blueprint/project-to-pg';
import { canonicalHiveHomeSlug } from './hive-federation';
import { canonicalCoordRole } from './agent-tools/coordination/roles';

const canonicalRoles: ReadonlySet<string> = new Set(AGENT_ROLES);

export async function resolveInstalledRoleForAllowlist(
  ctx: Pick<UnifiedToolContext, 'role' | 'workspaceId' | 'harnessSlug'>,
): Promise<string | null> {
  const { role, workspaceId, harnessSlug } = ctx;
  if (!role || canonicalRoles.has(role) || !workspaceId || !harnessSlug || harnessSlug === '*') return null;
  try {
    const pot = await canonicalHiveHomeSlug(workspaceId, harnessSlug);
    const scopes = [...new Set([harnessSlug, ...(pot ? [pot] : [])])];
    for (const scope of scopes) {
      // No blueprintPath: an uninstalled source file cannot grant a role alias.
      const blueprint = await getEffectiveBlueprint(getOrgPg().sql, { workspaceId, harnessSlug: scope });
      if (!blueprint) continue;
      const declarations = blueprint.roles.filter(declaration => declaration.id === role);
      if (declarations.length !== 1) continue;
      const base = declarations[0]!.baseRole;
      const canonicalBase = base ? canonicalCoordRole(base) : null;
      return canonicalBase && canonicalRoles.has(canonicalBase) ? canonicalBase : null;
    }
  } catch {
    // The dispatch role gate remains closed if installation evidence is unavailable.
  }
  return null;
}
