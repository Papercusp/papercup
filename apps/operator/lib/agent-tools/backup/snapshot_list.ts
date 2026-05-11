import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { workspaceBackupFor } from '@/lib/backup';
import { activeWorkspaceId } from '@/lib/workspace-registry';

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator',
  'reviewer', 'debugger', 'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'backup:snapshot_list',
  description: 'List recent kopia snapshots for the active workspace.',
  capability: 'backup:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
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
