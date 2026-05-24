/**
 * backup:rollback — undo a previous backup:promote. Brings the
 * .broken-<ts>-<name>/ dir back to live, stashing the current live as
 * .rolled-back-<ts>-<name>/.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { workspaceBackupFor } from '@/lib/backup';
import { activeWorkspaceId } from '@/lib/workspace-registry';

const ROLLBACK_ROLES = ['operator', 'debugger'] as const;

export default defineTool({
  name: 'backup:rollback',
  profile: 'engineer',
  description:
    'Undo a previous backup:promote. Renames the .broken-<ts>-<name>/ dir ' +
    'back to live; current live becomes .rolled-back-<ts>-<name>/.',
  capability: 'backup:write',
  guidance: {
    when: `Roll back to the immediately-prior backup. Reversible only by re-applying via restore.`,
    notWhen: `For applying a SPECIFIC backup, use \`backup:restore\` with the id.`,
  },
  requirePrincipal: false,
  roles: [...ROLLBACK_ROLES],
  args: z.object({ brokenPath: z.string().min(1) }),
  async handler(args) {
    const wb = workspaceBackupFor(activeWorkspaceId());
    const result = await wb.rollbackPromote(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
});
