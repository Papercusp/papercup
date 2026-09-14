/**
 * backup:restore — restore-to-clone only. Never overwrites live files.
 * Restores into <workspace>/.restored/<snapshotId>/. Agent (or user)
 * diffs the clone against live and promotes manually.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { workspaceBackupFor } from '../../backup';
import { durableRestoreInPlace } from '../../backup/durable-ops';
import { activeWorkspaceId } from '../../workspace-registry';
import { restoreCloneWithDeadline } from './restore-clone';

const RESTORE_ROLES = ['operator', 'debugger', 'reviewer'] as const;

export default defineTool({
  name: 'backup:restore',
  profile: 'engineer',
  description:
    'Restore a kopia snapshot. mode="clone" (default) writes to .restored/<id>/ ' +
    'and never overwrites live state; mode="in_place" overwrites the target ' +
    'after taking a safety snapshot first.',
  capability: 'backup:write',
  guidance: {
    when: `Restore a backup snapshot — replay PG dump + filesystem into the workspace. Destructive: replaces current state.`,
    notWhen: `For ROLLING BACK without changing the snapshot list, use \`backup:rollback\`. restore is the full apply.`,
    seeAlso: [
      'backup:diff (preview the change before applying)',
      'backup:rollback (roll back without changing the snapshot list)',
    ],
  },
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...RESTORE_ROLES],
  args: z.object({
    kopiaSnapshotId: z.string().min(1),
    source: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
    mode: z.enum(['clone', 'in_place']).default('clone'),
  }),
  async handler(args) {
    const ws = activeWorkspaceId();
    if (args.mode === 'in_place') {
      const result = await durableRestoreInPlace(ws, {
        kopiaSnapshotId: args.kopiaSnapshotId,
        target: args.target,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    const result = await restoreCloneWithDeadline(workspaceBackupFor(ws), {
      kopiaSnapshotId: args.kopiaSnapshotId,
      source: args.source,
      target: args.target,
      mode: 'clone',
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
});
