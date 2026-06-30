/**
 * git-sync:run — fire the git-sync routine action ONCE, on demand (WI-1320).
 *
 * Closes the force-deploy-ships-stale-staging asymmetry: a (force-)deploy ships
 * whatever is COMMITTED on staging, so if git-sync is lagging or wedged, the deploy
 * ships a STALE tree (the 2026-06-30 incident — I had to hand-commit to land work).
 * git-sync otherwise has NO manual lever (only routines:set cron/pause), unlike the
 * deploy (release:deploy op:trigger/force). This invokes the SAME registered
 * `system:git-sync` action a cron tick runs — lock, content-guard, attribution,
 * commit + push — so an agent OR the deploy/gate process can make staging current
 * immediately rather than waiting for the next (≤3-min) tick.
 */
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { getSystemAction } from '../../harness/routines/system-actions';
import { projectDirForSlug } from '../../operator-notes';
// Side-effect: ensure registerSystemAction('git-sync', handleGitSync) has run so
// getSystemAction('git-sync') resolves even if nothing else imported it this process.
import '../../harness/git-sync/git-sync-action';

const execFileP = promisify(execFile);

async function headSha(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
    return stdout.trim();
  } catch {
    return null;
  }
}

export default defineTool({
  name: 'git-sync:run',
  profile: 'engineer',
  description:
    "FIRE git-sync NOW — run the git-sync routine action once on demand (commit + push the current install's dirty tree) instead of waiting for the ≤3-min cron tick. The manual lever git-sync otherwise lacks (only routines:set cron/pause exists): makes a (force-)deploy ship CURRENT staging, not stale. Same action a cron tick runs (lock, content-guard, attribution). The deploy/gate process should fire this FIRST so it tests/ships the latest agents' work.",
  capability: 'operator:write',
  guidance: {
    when: 'You need the latest work COMMITTED right now — before a (force-)deploy or gate run, or to recover when git-sync is lagging/wedged. (git-sync also auto-runs every ~3 min; this just fires it on demand.)',
    notWhen: 'To retune the cadence or pause git-sync, use routines:set. To deploy, release:deploy.',
    chaining: 'git-sync:run → release:deploy { op:status } → op:trigger / op:force (now shipping current staging).',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    installSlug: z
      .string()
      .max(120)
      .optional()
      .describe('Install slug whose git-sync to fire (default: the operator home harness).'),
  }),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('git-sync:run requires operator, architect, or queen role');
    }
    const action = getSystemAction('git-sync');
    if (!action) throw new Error('git-sync system action not registered');

    const { sql } = getOrgPg();
    const slug = args.installSlug ?? operatorHomeHarnessSlug();
    const workspaceId = activeWorkspaceId();

    // Use the routine row's own trigger_config so the on-demand fire behaves EXACTLY
    // like a cron tick (same remote/branch/push/submodule settings).
    const rows = (await sql`
      SELECT trigger_config
        FROM harness_shared.routines
       WHERE workspace_id = ${workspaceId} AND install_slug = ${slug} AND name = 'git-sync'
       LIMIT 1`) as Array<{ trigger_config: Record<string, unknown> | null }>;
    const triggerConfig = rows[0]?.trigger_config ?? {};

    const repoDir = await projectDirForSlug(slug);
    const before = repoDir ? await headSha(repoDir) : null;

    // Fire the SAME action a cron tick runs. It manages its own lock (so it won't race
    // a concurrent tick) and is safe to re-run from the top. A conflict path returns
    // durableSpawns we don't drain here (the next tick / the routine engine handles it).
    await action({ installSlug: slug, workspaceId, triggerConfig, payloadTemplate: null });

    const after = repoDir ? await headSha(repoDir) : null;
    const committed = !!(before && after && before !== after);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            fired: true,
            slug,
            committed,
            head_before: before,
            head_after: after,
            note: committed
              ? 'git-sync fired — new commit(s) on staging (pushed if the push leg succeeded).'
              : 'git-sync fired — nothing to commit (clean tree), OR this tick skipped (ineligible / lock held by a concurrent tick). See the operator log.',
          }),
        },
      ],
    };
  },
});
