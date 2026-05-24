/**
 * backup:snapshot_create — take a snapshot of the active workspace.
 * Agents should call this before destructive ops (e.g. before applying
 * a large rewrite, before `git reset --hard`, before clobbering files).
 *
 * Returns the new kopia snapshot id so the same agent can hand it
 * back to backup:restore if its action goes wrong.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { workspaceBackupFor } from '@/lib/backup';
import { activeWorkspaceId } from '@/lib/workspace-registry';

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator',
  'reviewer', 'debugger', 'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'backup:snapshot_create',
  profile: 'engineer',
  description:
    'Create a kopia snapshot of the active workspace before a destructive op. ' +
    'Returns the snapshot id so the same agent can restore from it if needed.',
  capability: 'backup:write',
  guidance: {
    when: `Create a new backup snapshot of the workspace. Use before risky migrations or major state changes.`,
    notWhen: `For routine commits, this isn't needed — backup snapshots are heavyweight (whole-workspace). For per-harness portable snapshots, use the snapshots tools instead.`,
  },
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    reason: z.enum([
      'pre_destructive', 'post_run', 'plugin_install', 'secret_change', 'manual',
    ]).default('pre_destructive'),
    note: z.string().max(280).optional(),
  }),
  async handler(args) {
    const wb = workspaceBackupFor(activeWorkspaceId());
    const result = await wb.snapshot(args.reason, args.note ? { note: args.note } : undefined);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
});
