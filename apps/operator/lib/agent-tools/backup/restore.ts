/**
 * backup:restore — restore-to-clone only. Never overwrites live files.
 * Restores into <workspace>/.restored/<snapshotId>/. Agent (or user)
 * diffs the clone against live and promotes manually.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { workspaceBackupFor } from '@/lib/backup';
import { activeWorkspaceId } from '@/lib/workspace-registry';

const RESTORE_ROLES = ['operator', 'debugger', 'reviewer'] as const;

export default defineTool({
  name: 'backup:restore',
  description:
    'Restore a kopia snapshot to a sibling clone path (never overwrites). ' +
    'Returns the absolute restore path; caller diffs + promotes manually.',
  capability: 'backup:write',
  requirePrincipal: false,
  roles: [...RESTORE_ROLES],
  args: z.object({
    kopiaSnapshotId: z.string().min(1),
    source: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
  }),
  async handler(args) {
    const wb = workspaceBackupFor(activeWorkspaceId());
    const result = await wb.restoreToClone(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
});
