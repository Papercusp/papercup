/**
 * `system:hive-git-gc` — the ephemeral cadence that bounds a hive-git bare
 * store's namespace-ref growth (G-9, p2p-git-live-activation-2026-07-09 /
 * P-205). Config (routine `trigger_config`, from hive-git-gc-routine.ts):
 *   - `hive_home_slug` / `repo_key` — storage.ts's `hiveGitRepoPath` inputs.
 *   - `keep_published_refs_per_namespace` — optional (default gc.ts's own).
 *
 * SELF-GATES on the hive's `hiveGit.mode` (hive-git-mode.ts): a `legacy` hive
 * has no multi-namespace hive-git store worth gc'ing (git-sync-action.ts
 * never engages the p2p plane for it) — the tick no-ops rather than running
 * `git gc --prune=now` against a store nothing publishes into. This mirrors
 * the established "self-gates on hive-specific state" idiom used by
 * `system:scout-cycle` / `system:wake-brain` etc., so the ROW can be armed
 * platform-wide without a bespoke reconcile sweep: activation is still owned
 * by upsertHiveGitGcRoutine's caller (the mode-flip path), the self-gate is a
 * defense-in-depth no-op, not the primary gate.
 *
 * Runs as ONE durable-ish step (best-effort by construction — gcHiveGitRepo
 * itself never throws on a bad ref/gc failure, folding errors into its result
 * instead) — safe to re-run from the top.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { gcHiveGitRepo } from '../../sync/hive-git/gc';
import { hiveGitRepoPath } from '../../sync/hive-git/storage';
import { getHiveGitMode } from '../git-sync/hive-git-mode';

registerSystemAction('hive-git-gc', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const potHomeSlug = typeof cfg.hive_home_slug === 'string' ? cfg.hive_home_slug : ctx.installSlug;
  const repoKey = typeof cfg.repo_key === 'string' ? cfg.repo_key : null;
  if (!repoKey) {
    console.warn(`[hive-git-gc] ${potHomeSlug}: missing trigger_config.repo_key — skipping tick`);
    return;
  }

  const mode = await getHiveGitMode(ctx.workspaceId, potHomeSlug);
  if (mode === 'legacy') {
    // Self-gate: nothing publishes into the hive-git namespace tree for a legacy hive.
    return;
  }

  const keepPublishedRefsPerNamespace = Number(cfg.keep_published_refs_per_namespace);
  const repoPath = hiveGitRepoPath(potHomeSlug, repoKey);
  const result = await gcHiveGitRepo(repoPath, {
    ...(Number.isFinite(keepPublishedRefsPerNamespace) && keepPublishedRefsPerNamespace > 0
      ? { keepPublishedRefsPerNamespace }
      : {}),
  });
  console.log(
    `[hive-git-gc] ${potHomeSlug}/${repoKey} (mode=${mode}): ` +
      `deleted ${result.deletedRefs.length} ref(s), archived ${result.archivedNamespaces.length} namespace(s), ` +
      `kept ${result.keptRefs.length}` +
      (result.errors.length ? `, ${result.errors.length} error(s)` : ''),
  );
  if (result.errors.length) {
    for (const e of result.errors) console.warn(`[hive-git-gc]   ! ${e}`);
  }
});
