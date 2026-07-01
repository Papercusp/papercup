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
    notWhen: `For HARNESS snapshots (portable artifacts you can publish), use \`snapshots:list\`. backup:snapshot_list is the full-workspace recovery view.`,
    seeAlso: [
      'backup:snapshot_create (create a new snapshot)',
      'backup:restore (apply a snapshot from the list)',
      'snapshots:list (portable per-harness snapshots — a different surface)',
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
    return {
      content: [{ type: 'text', text: JSON.stringify({ snapshots }) }],
    };
  },
});
