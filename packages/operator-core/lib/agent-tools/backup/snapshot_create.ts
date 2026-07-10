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
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { workspaceBackupFor } from '../../backup';
import { activeWorkspaceId } from '../../workspace-registry';
import { dbosBackupActive } from '../../dbos/dbos-flags';
import { dbosStarted } from '../../dbos/bootstrap';
import { softText, clampText, LIMITS } from '../limits';

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
    seeAlso: [
      'backup:snapshot_list (list existing snapshots)',
      'backup:settings_set (schedule recurring backups instead of one-shot)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    reason: z.enum([
      'pre_destructive', 'post_run', 'plugin_install', 'secret_change', 'manual',
    ]).default('pre_destructive'),
    note: softText(LIMITS.ANNOTATION).optional(),
  }),
  async handler(args) {
    const ws = activeWorkspaceId();
    const note = clampText(args.note, LIMITS.ANNOTATION);
    const context = note ? { note } : undefined;
    // Deliberately does NOT route through `triggerSnapshotEvent`, so it bypasses the
    // per-workspace `eventTriggers` gate. That gate answers "should this AUTOMATIC
    // event snapshot?"; this tool is an EXPLICIT request to snapshot now, and `reason`
    // is only the label stamped on the record. Routing it through the gate would let a
    // user who unchecked e.g. "After plugin install" silently turn an agent's direct
    // backup:snapshot_create into a no-op — an explicit ask must never be swallowed by
    // a preference about automatic triggers. Reviewed in settings-audit 2026-07-09
    // while wiring the post_run / plugin_install / secret_change emitters.
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
