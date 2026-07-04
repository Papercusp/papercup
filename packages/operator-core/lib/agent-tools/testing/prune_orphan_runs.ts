/**
 * testing:prune-orphan-runs — clear harness_shared.test_runs rows for test
 * files that were later deleted or relocated (EI-5366).
 *
 * Dry-run by default (no `confirm`) — reports the orphaned (harness_slug,
 * file_path) groups + row counts without deleting anything. Pass
 * confirm:true to actually DELETE exactly the groups the SAME scan finds
 * (re-scanned at delete time, not a stale list from an earlier call — a
 * file recreated between dry-run and confirm is correctly skipped).
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { findOrphanTestRunGroups, pruneOrphanTestRunGroups } from '../../testing-orphan-runs';

export default defineTool({
  name: 'testing:prune-orphan-runs',
  description:
    'Find (dry-run default) or DELETE (confirm:true) harness_shared.test_runs rows whose file no longer exists in that harness\'s staging worktree — the frozen "phantom red/green" rows a deleted/relocated test file leaves behind. Groups by (harness_slug, file_path); returns row counts. Runs on the live operator\'s own DB connection (the only safe write path — the papercusp-workspace DB has no external psql/dev:pg_query write access).',
  guidance: {
    when: 'A latest-status-per-file / raw test_runs diagnostic shows a red or green for a file that no longer exists on disk (moved/renamed/deleted in a refactor).',
    notWhen: 'The Tests-tab UI itself — it already glob-walks the filesystem and never shows a deleted file; this tool is for the raw test_runs table\'s own hygiene, not a user-facing symptom.',
    chaining: 'Dry-run (omit confirm) → review the groups → confirm:true to delete.',
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    confirm: z.boolean().optional().describe('Actually delete the orphaned groups. Omit/false = dry run (report only).'),
  }),
  async handler(args) {
    const workspaceId = activeWorkspaceId();
    const orphans = await findOrphanTestRunGroups({ workspaceId });
    const totalRows = orphans.reduce((s, o) => s + o.rowCount, 0);
    if (!args.confirm) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              dry_run: true,
              orphan_groups: orphans.length,
              orphan_rows: totalRows,
              groups: orphans,
              note: orphans.length > 0
                ? 'Pass confirm:true to DELETE exactly these groups (re-scanned at delete time).'
                : 'No orphaned test_runs rows found.',
            }),
          },
        ],
      };
    }
    const deleted = await pruneOrphanTestRunGroups(orphans);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            dry_run: false,
            orphan_groups: orphans.length,
            rows_deleted: deleted,
            groups: orphans,
          }),
        },
      ],
    };
  },
});
