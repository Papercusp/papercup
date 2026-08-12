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
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { projectDirForSlug } from '../../operator-notes';
import { fireGitSyncNow, type GitSyncFireOutcome } from '../../harness/git-sync/git-sync-action';
import { withBoundedTimeout } from '../../bounded-timeout';

const execFileP = promisify(execFile);

/**
 * EI-9425: fireGitSyncNow runs the FULL commit+push across the superproject + every
 * submodule (lock, content-guard, attribution) — under PG/lock pressure (the same class
 * as WI-3818's fleet:status legs) this routinely exceeds the ~60s MCP transport budget,
 * so the tool watchdog saw a 94% timeout/error rate (tool_invocations, 2026-07-10) even
 * though the underlying commit/push frequently still lands moments later. Bound the fire
 * call so a slow tick degrades to an honest "still running" response well before the hard
 * transport cutoff, instead of the caller getting an opaque aborted-signal timeout.
 */
export const GIT_SYNC_RUN_BUDGET_MS = 45_000;

/**
 * WI-4940: `git rev-parse HEAD` itself has NO bound — the ~120s hang the reporter
 * observed (a WI-4938 caller had to terminate its wait) happened AFTER the
 * commit had already landed (headSha's `after` call, run unconditionally once
 * `fireGitSyncNow` resolves, degraded or not — the EI-9425 GIT_SYNC_RUN_BUDGET_MS
 * wrap only bounds the fire itself, never this trailing `git rev-parse`). Under
 * disk/IO stall or fleet-wide git-process contention a bare `execFile` can hang
 * indefinitely with no signal back to the caller — an ambiguous-write response-loss
 * class exactly like the one GIT_SYNC_RUN_BUDGET_MS exists to prevent for the fire
 * itself. Bound it the same way: a slow/hung `git rev-parse` degrades to `null`
 * (the function's existing catch-all outcome) instead of hanging the whole tool call.
 */
const HEAD_SHA_TIMEOUT_MS = 5_000;

async function headSha(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: repoDir, timeout: HEAD_SHA_TIMEOUT_MS });
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
  // The COMMIT lever of the three-part release pipeline (COMMIT → git-sync:run,
  // VERDICT → release:checkpoint-run, DEPLOY → release:deploy) — see this file's
  // header comment. checkpoint-run and deploy already widened their invoke
  // allowlist to the full red-fix cohort + dropped the operator-config-write
  // in-handler gate (EI-7426: that gate is for tools that MUTATE fleet-wide
  // config; firing an already-scheduled, idempotent action is not that). This
  // tool is the same shape — it just fires the SAME `system:git-sync` action a
  // cron tick already runs on its own ≤3-min cycle — but was missed when
  // EI-7426 fixed its two siblings, so release-fixer (told by its own persona
  // to poll for its fix landing on staging HEAD before firing checkpoint-run)
  // kept hitting a structural role-reject trying to speed that up
  // (repeated-tool-error watchdog, EI-18117741153424215). Mirror the sibling
  // tools' allowlist exactly.
  agentRoles: [...SU_ROLES, 'cup', 'release-fixer', 'release-manager'],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    installSlug: z
      .string()
      .max(120)
      .optional()
      .describe('Install slug whose git-sync to fire (default: the operator home harness).'),
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Alias for installSlug when using the standard per-call harness scope argument.'),
  }),
  async handler(args, _ctx) {
    // No in-handler role gate: firing git-sync is a SAFE, idempotent op — it runs
    // the same commit+push action a cron tick already fires on its own ≤3-min
    // cycle, self-locks against a concurrent tick, and mutates no config (see the
    // agentRoles note above). Access control is the invoke allowlist.
    // `harness` is the standard per-call scope spelling used by the operator
    // tools and by ptool's --harness convenience flag. Keep installSlug as the
    // canonical name for existing callers, but accept the alias so a caller
    // does not have to learn this tool's internal routine vocabulary.
    const slug = args.installSlug ?? args.harness ?? operatorHomeHarnessSlug();
    const workspaceId = activeWorkspaceId();

    const repoDir = await projectDirForSlug(slug);
    const before = repoDir ? await headSha(repoDir) : null;

    const fired = await withBoundedTimeout<GitSyncFireOutcome | undefined>(() => fireGitSyncNow(slug, workspaceId), {
      fallback: undefined,
      timeoutMs: GIT_SYNC_RUN_BUDGET_MS,
      label: 'git-sync:run fireGitSyncNow',
    });

    const after = repoDir ? await headSha(repoDir) : null;
    const outcome = fired.value;
    const status = fired.degraded
      ? fired.reason === 'error'
        ? 'error'
        : 'in_progress'
      : outcome?.status ?? 'unknown';
    const committed = Boolean(before && after && before !== after) || outcome?.status === 'synced';
    const success = outcome?.status === 'synced' || outcome?.status === 'nothing';
    const note = fired.degraded
      ? fired.reason === 'error'
        ? `git-sync fire failed before it returned an outcome: ${fired.errorMessage ?? 'unknown error'}.`
        : `git-sync fired but did not finish within ${GIT_SYNC_RUN_BUDGET_MS}ms — status is in_progress; ` +
          'the action may still commit/push or self-skip. Re-check the routine outcome before re-firing.'
      : outcome?.status === 'synced'
        ? 'git-sync completed with status synced; commit/push details are in outcome.'
        : outcome?.status === 'nothing'
          ? 'git-sync completed with status nothing; no repo changes were committed.'
          : outcome?.status === 'skipped'
            ? `git-sync completed with status skipped (${outcome.reason}).`
            : outcome?.status === 'conflict' || outcome?.status === 'error'
              ? `git-sync completed with status ${outcome.status}; inspect outcome errors/conflicts.`
              : 'git-sync returned no structured outcome; treat the result as unknown and inspect the routine log.';
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: !(fired.degraded && fired.reason === 'error'),
            fired: true,
            slug,
            status,
            success,
            committed,
            head_before: before,
            head_after: after,
            ...(outcome ? { outcome } : {}),
            ...(fired.degraded ? { degraded: true } : {}),
            ...(fired.errorMessage ? { error: fired.errorMessage } : {}),
            note,
          }),
        },
      ],
    };
  },
});
