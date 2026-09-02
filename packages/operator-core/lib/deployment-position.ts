/**
 * Read-time deployment position for a set of repo-relative paths.
 *
 * `gitPipelinePosition` answers, per path, whether that code reached the callers
 * that need it. TWO consumers need the same join over a LIST of paths:
 *
 *   - terminal completion evidence (`work_items:get` → `deploymentPositionForEvidence`)
 *   - acceptance-audit citations (the plan ship gate → `deploymentPositionForCitations`)
 *
 * so the fan-out, its cap, and its fail-soft contract live here ONCE instead of
 * being reimplemented per consumer. Adding a third consumer means calling this,
 * not copying it.
 *
 * FAIL-SOFT IS THE LOAD-BEARING PROPERTY: a broken pipeline probe must make the
 * deployment dimension UNKNOWN, never make its caller fail. A caller that reports
 * "not deployed" because the probe threw would be manufacturing exactly the
 * confident-but-wrong verdict this join exists to prevent.
 */
import { gitPipelinePosition, type PipelinePosition } from './git-pipeline-position';

/**
 * Callers may name many paths (completion evidence accepts up to 60); do not fan
 * out that many hot reads. Each probe forks git and may probe systemd/health.
 */
export const MAX_DEPLOYMENT_POSITION_PATHS = 12;

export type DeploymentPath = {
  path: string;
  targetSha: string | null;
  deployedSha: string | null;
  positions: PipelinePosition['positions'] | null;
  blockedOn: PipelinePosition['blockedOn'] | null;
  positionsUnknown?: string[];
};

export interface DeploymentPositionForPaths {
  paths: DeploymentPath[];
  /** Paths whose probe failed or whose position contains an unknown leg. */
  unknownPaths: string[];
  /** Number of distinct usable paths the caller supplied. */
  totalPaths: number;
  /** True when the caller named more paths than this read probes. */
  truncated: boolean;
}

/**
 * Deployment position of the code/test citations backing a plan's code-truth audit,
 * plus the one derived conclusion a reader actually needs (`undeployedPaths`).
 */
export interface CitationDeployment extends DeploymentPositionForPaths {
  /**
   * Cited paths MEASURED as not live on the serving runtime — the acceptance blind
   * spot, stated positively.
   *
   * A path qualifies only when its `deployed` leg was genuinely measured false. A
   * path whose `deployed` leg is in `positionsUnknown` is UNKNOWN and stays out of
   * this list (it appears in `unknownPaths` instead), because a `false` produced by
   * a degraded git read is not evidence the stage was not reached — the same rule
   * `positionsUnknown` exists to enforce upstream.
   */
  undeployedPaths: string[];
}

export function compactPosition(path: string, result: PipelinePosition): DeploymentPath {
  return {
    path,
    targetSha: result.targetSha ?? null,
    deployedSha: result.deployedSha ?? null,
    positions: result.positions ?? null,
    blockedOn: result.blockedOn ?? null,
    ...(result.positionsUnknown?.length ? { positionsUnknown: result.positionsUnknown } : {}),
  };
}

/**
 * Resolve the supplied paths in parallel, capped and fail-soft.
 *
 * The per-path catch is intentional: one malformed/stale path must not hide the
 * deployment state of every other path the caller asked about.
 */
export async function deploymentPositionForPaths(
  paths: readonly string[],
): Promise<DeploymentPositionForPaths> {
  const distinct = [...new Set(paths.map((entry) => entry.trim()).filter(Boolean))];
  const selected = distinct.slice(0, MAX_DEPLOYMENT_POSITION_PATHS);

  const resolved = await Promise.all(
    selected.map(async (path) => {
      try {
        const result = await gitPipelinePosition({ path });
        return { path, result };
      } catch {
        return { path, result: null };
      }
    }),
  );

  const unknownPaths: string[] = [];
  const compact = resolved
    .map(({ path, result }) => {
      if (!result) {
        unknownPaths.push(path);
        return null;
      }
      if (result.positionsUnknown?.length) unknownPaths.push(path);
      return compactPosition(path, result);
    })
    .filter((entry): entry is DeploymentPath => entry !== null);

  return {
    paths: compact,
    unknownPaths,
    totalPaths: distinct.length,
    truncated: distinct.length > selected.length,
  };
}

/**
 * EI-22181490624100467 — resolve deployment position for an audit's cited evidence
 * and derive the one conclusion a reader needs from it.
 *
 * The load-bearing rule is that an UNKNOWN `deployed` leg is never reported as
 * UNDEPLOYED. Getting that backwards would make a degraded git read look like proof
 * the code is not live — the same confident-wrong-answer defect, one level down from
 * the one this record exists to expose.
 */
export async function citationDeploymentForPaths(
  paths: readonly string[],
): Promise<CitationDeployment> {
  const position = await deploymentPositionForPaths(paths);
  const undeployedPaths = position.paths
    .filter(
      (entry) =>
        entry.positions?.deployed === false && !(entry.positionsUnknown ?? []).includes('deployed'),
    )
    .map((entry) => entry.path);
  return { ...position, undeployedPaths };
}
