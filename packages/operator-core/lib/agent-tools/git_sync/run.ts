/**
 * git-sync:run — fire the git-sync routine action ONCE, on demand (WI-1320).
 *
 * Closes the force-deploy-ships-stale-staging asymmetry: a (force-)deploy ships
 * whatever is COMMITTED on staging, so if git-sync is lagging or wedged, the deploy
 * ships a STALE tree (the 2026-06-30 incident — I had to hand-commit to land work).
 * git-sync otherwise has NO manual lever (only routines:set cron/pause), unlike the
 * deploy (release:deploy op:trigger/force). This invokes the SAME `system:git-sync`
 * action a cron tick runs (lock, content-guard, attribution, commit + push) via the
 * shared fireGitSyncNow, so an agent OR the deploy/gate process can make staging
 * current immediately rather than waiting for the next (≤3-min) tick.
 */
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { projectDirForSlug } from '../../operator-notes';
import { fireGitSyncNow } from '../../harness/git-sync/git-sync-action';

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
    "FIRE git-sync NOW — run the git-sync routine action once on demand (commit + push the current install's dirty tree) instead of waiting for the ≤3-min cron tick. The manual lever git-sync otherwise lacks (only routines:set cron/pause exists): makes a (force-)deploy ship CURRENT staging, not stale. Same action a cron tick runs (lock, content-guard, attribution). release:deploy now fires this FIRST so it ships the latest agents' work.",
  capability: 'operator:write',
  guidance: {
    when: 'You need the latest work COMMITTED right now — before a (force-)deploy or gate run, or to recover when git-sync is lagging/wedged. (git-sync also auto-runs every ~3 min; this just fires it on demand.)',
    notWhen: 'To retune the cadence or pause git-sync, use routines:set. To deploy, release:deploy (which already fires git-sync first).',
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
    const slug = args.installSlug ?? operatorHomeHarnessSlug();
    const workspaceId = activeWorkspaceId();

    const repoDir = await projectDirForSlug(slug);
    const before = repoDir ? await headSha(repoDir) : null;

    await fireGitSyncNow(slug, workspaceId);

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
