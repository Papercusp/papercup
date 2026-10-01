import { withBoundedTimeout } from '../bounded-timeout';
import { lintRelativeScratchPaths } from '../carry-note';
import { loadHarnessRegistry, resolveHarnessContentPath, type HarnessRegistry } from '../harness-registry';
import { isGitTrackedPath, repoRelativePathUnderRoot, type GitTrackednessProbe } from '../git-trackedness';

const REGISTRY_ROOT_TIMEOUT_MS = 2_000;

export interface RelativeScratchPathScope {
  workspaceId?: string | null;
  harness?: string | null;
}

export interface RelativeScratchPathProbe {
  loadRegistry?: (workspaceId?: string) => Promise<HarnessRegistry>;
  isTracked?: GitTrackednessProbe;
}

/**
 * Keep the relative-scratch advisory for untracked and unknown paths, but suppress it
 * when the exact harness checkout definitely tracks the referenced repository path.
 * Registry and Git failures are advisory-only and therefore preserve the warning.
 */
export async function filterTrackedRelativeScratchPaths(
  prose: string,
  scope: RelativeScratchPathScope,
  probe: RelativeScratchPathProbe = {},
): Promise<string[]> {
  let refs: string[];
  try {
    refs = lintRelativeScratchPaths(prose);
  } catch {
    return [];
  }
  const harness = scope.harness?.trim();
  if (refs.length === 0 || !harness) return refs;

  try {
    const registryRead = await withBoundedTimeout(
      () => (probe.loadRegistry ?? loadHarnessRegistry)(scope.workspaceId ?? undefined),
      {
        fallback: null as HarnessRegistry | null,
        timeoutMs: REGISTRY_ROOT_TIMEOUT_MS,
        label: 'checkpoint:relative-scratch-path-root',
      },
    );
    if (registryRead.degraded || !registryRead.value) return refs;

    const repoRoot = resolveHarnessContentPath(registryRead.value, harness);
    if (!repoRoot) return refs;
    const isTracked = probe.isTracked ?? isGitTrackedPath;
    return refs.filter((reference) => {
      const relativePath = repoRelativePathUnderRoot(reference, repoRoot);
      if (!relativePath) return true;
      try {
        return isTracked(repoRoot, relativePath) !== true;
      } catch {
        return true;
      }
    });
  } catch {
    return refs;
  }
}
