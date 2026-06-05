import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { workspaceBackupFor } from '../../backup';
import { activeWorkspaceId } from '../../workspace-registry';

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator',
  'reviewer', 'debugger', 'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'backup:settings_get',
  profile: 'engineer',
  description: 'Read backup settings + repo stats for the active workspace.',
  capability: 'backup:read',
  guidance: {
    when: `Read backup configuration — schedule, retention, destinations.`,
    notWhen: `For runtime BACKUP state (last run, next run), check the destinations directly.`,
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({}),
  async handler() {
    const wb = workspaceBackupFor(activeWorkspaceId());
    const [settings, stats] = await Promise.all([wb.getSettings(), wb.stats()]);
    return {
      content: [{ type: 'text', text: JSON.stringify({ settings, stats }) }],
    };
  },
});
