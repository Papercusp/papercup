/**
 * backup:snapshot_create — take a snapshot of the active workspace.
 * Agents should call this before destructive ops (e.g. before applying
 * a large rewrite, before `git reset --hard`, before clobbering files).
 *
 * Returns the new kopia snapshot id so the same agent can hand it
 * back to backup:restore if its action goes wrong.
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { workspaceBackupFor } from '../../backup';
import { activeWorkspaceId } from '../../workspace-registry';
import { dbosBackupActive } from '../../dbos/dbos-flags';
import { dbosStarted } from '../../dbos/bootstrap';

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
  agentRoles: [...ALL_ROLES],
  args: z.object({
    reason: z.enum([
      'pre_destructive', 'post_run', 'plugin_install', 'secret_change', 'manual',
    ]).default('pre_destructive'),
    note: z.string().max(280).optional(),
  }),
  async handler(args) {
    const ws = activeWorkspaceId();
    const context = args.note ? { note: args.note } : undefined;
    // A/B (dbos-flows P-011): when the backup flag is opted-in AND DBOS actually
    // launched, run the snapshot as a durable workflow (crash-resume via the
    // StepRunner seam); otherwise call snapshot() directly. `getResult` is
    // awaited so the tool keeps its synchronous request→result contract.
    let result;
    if (dbosBackupActive() && dbosStarted()) {
      const { startBackupSnapshotWorkflow } = await import('../../dbos/backup-workflow');
      const nonce = Date.now().toString(36) + randomBytes(4).toString('hex');
      result = await startBackupSnapshotWorkflow({ workspaceId: ws, reason: args.reason, context }, nonce);
    } else {
      result = await workspaceBackupFor(ws).snapshot(args.reason, context);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
});
