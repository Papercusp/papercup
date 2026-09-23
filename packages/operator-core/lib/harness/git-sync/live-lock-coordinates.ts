/**
 * live-lock-coordinates: pure, dependency-free mapping of lock-plane paths into one git
 * repository's own coordinate space.
 *
 * Split out of run-git-sync.ts (P-009 / WI-10002596) so that consumers which mock
 * run-git-sync wholesale (git-sync-action.test.ts) still exercise the REAL mapping. A
 * mocked mapping is exactly how a coordinate mismatch passes every test while git-sync
 * commits a locked file.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Structurally identical to run-git-sync's GitSyncLockHolding. */
export interface LockHoldingCoordinates {
  path: string;
  owner: string;
  intent: string;
  goalRef?: string;
}

/**
 * Map root-relative live-lock holdings into one repository's coordinate space.
 *
 * The lock plane speaks in superproject-root-relative paths, while `git add`
 * inside a submodule speaks from that submodule's own root. Keep the mapping
 * beside the exclusion logic so commit-time refreshes cannot accidentally
 * reintroduce the old root/submodule path mismatch.
 */
export function mapLiveLockHoldingsForRepo(
  holdings: readonly LockHoldingCoordinates[],
  repoRelPrefix: string,
  submodulePaths: readonly string[] = [],
): LockHoldingCoordinates[] {
  const normalizedPrefix = repoRelPrefix.trim().replace(/^\.\/+|\/+$/g, '');
  const prefix = normalizedPrefix ? `${normalizedPrefix}/` : '';
  const normalizedSubmodulePaths = submodulePaths
    .map((path) => path.trim().replace(/^\.\/+|\/+$/g, ''))
    .filter(Boolean);
  const normalized = holdings
    .map((holding) => ({
      path: holding.path.trim().replace(/^\.\/+|\/+$/g, ''),
      owner: holding.owner,
      intent: holding.intent,
      ...(holding.goalRef?.trim() ? { goalRef: holding.goalRef.trim() } : {}),
    }))
    .filter((holding) => holding.path.length > 0);

  if (prefix) {
    return normalized
      .filter((holding) => holding.path.startsWith(prefix))
      .map((holding) => ({ ...holding, path: holding.path.slice(prefix.length) }))
      .filter((holding) => holding.path.length > 0);
  }

  return normalized.filter(
    (holding) =>
      !normalizedSubmodulePaths.some(
        (submodulePath) => holding.path === submodulePath || holding.path.startsWith(`${submodulePath}/`),
      ),
  );
}

/**
 * P-009 / WI-10002596: the repo-relative prefix of a NESTED git-sync install inside its
 * parent's tree ('' when the install is not nested).
 *
 * Nested installs (slug `<parent>/<rel>`, e.g. `papercusp/libs/agent-chat`) sync a
 * submodule as their own repo root. The lock plane still speaks in the PARENT's root
 * coordinates (`libs/agent-chat/src/x.ts`), so an unmapped holding never matches a path
 * inside the nested repo. Exclusion then silently becomes a no-op, and git-sync can commit
 * a peer's locked, mid-edit file (observed: a mutation-probe mutant, libs/papercusp
 * 1e553ccd). Derived from the filesystem (`parentRoot` is the parent install's project
 * dir) rather than trusted from the slug. The slug tail is only a fallback when the
 * parent root is unknown, and only when the repo path actually ends with it.
 */
export function nestedInstallRepoPrefix(
  slug: string,
  repoPath: string | null | undefined,
  parentRoot?: string | null,
): string {
  const slash = slug.indexOf('/');
  if (slash <= 0 || !repoPath) return '';
  const repo = resolve(repoPath);
  if (parentRoot) {
    const rel = relative(resolve(parentRoot), repo).split(sep).join('/');
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : '';
  }
  const tail = slug.slice(slash + 1).replace(/^\/+|\/+$/g, '');
  return tail && repo.split(sep).join('/').endsWith(`/${tail}`) ? tail : '';
}
