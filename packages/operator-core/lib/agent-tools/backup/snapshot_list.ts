import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { workspaceBackupFor } from '../../backup';
import { activeWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'backup:snapshot_list',
  profile: 'engineer',
  description: 'List recent kopia snapshots for the active workspace.',
  capability: 'backup:read',
  guidance: {
    when: `List backup snapshots — point-in-time captures of the workspace's PG + filesystem state.`,
    notWhen: `For publishable per-harness artifacts — this surface lists only full-workspace recovery snapshots, so use the artifact/catalog surface that owns the harness payload instead.`,
    seeAlso: [
      'backup:snapshot_create (create a new snapshot)',
      'backup:restore (apply a snapshot from the list)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    limit: z.number().int().min(1).max(500).default(50),
  }),
  async handler(args) {
    const wb = workspaceBackupFor(activeWorkspaceId());
    const snapshots = await wb.list(args.limit);
    return { data: { snapshots } };
  },
});
