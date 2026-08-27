/**
 * Read-time deployment position for terminal completion evidence.
 *
 * A completion record proves what was verified, while `gitPipelinePosition`
 * answers whether the named paths reached the callers that need them. Keep
 * this join deliberately small and fail-soft: a broken pipeline probe must
 * make the deployment dimension unknown, never make `work_items:get` fail.
 */
import { gitPipelinePosition, type PipelinePosition } from '../../git-pipeline-position';

/** Completion evidence accepts up to 60 paths; do not fan out that many hot reads. */
export const MAX_DEPLOYMENT_POSITION_PATHS = 12;

type DeploymentPath = {
  path: string;
  targetSha: string | null;
  deployedSha: string | null;
  positions: PipelinePosition['positions'] | null;
  blockedOn: PipelinePosition['blockedOn'] | null;
  positionsUnknown?: string[];
};

export interface DeploymentPositionForEvidence {
  paths: DeploymentPath[];
  /** Paths whose probe failed or whose position contains an unknown leg. */
  unknownPaths: string[];
  /** Number of distinct usable paths present in the stored evidence. */
  totalPaths: number;
  /** True when the evidence named more paths than this read probes. */
  truncated: boolean;
  /** Present when evidence exists but contains no usable path to probe. */
  unknownReason?: 'no-filesChanged';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringPaths(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
    : [];
}

function evidencePaths(evidence: unknown): string[] {
  if (!isRecord(evidence)) return [];
  const nested = isRecord(evidence.verification) ? evidence.verification : undefined;
  return [...new Set([...stringPaths(evidence.filesChanged), ...stringPaths(nested?.filesChanged)])];
}

function compactPosition(path: string, result: PipelinePosition): DeploymentPath {
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
 * Resolve the paths recorded by a terminal completion in parallel. The
 * per-path catch is intentional: one malformed/stale path must not hide the
 * deployment state of every other path in the completion.
 */
export async function deploymentPositionForEvidence(
  evidence: unknown,
): Promise<DeploymentPositionForEvidence | undefined> {
  if (!isRecord(evidence)) return undefined;

  const paths = evidencePaths(evidence);
  if (paths.length === 0) {
    return { paths: [], unknownPaths: [], totalPaths: 0, truncated: false, unknownReason: 'no-filesChanged' };
  }

  const selected = paths.slice(0, MAX_DEPLOYMENT_POSITION_PATHS);
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
  const compact = resolved.map(({ path, result }) => {
    if (!result) {
      unknownPaths.push(path);
      return null;
    }
    if (result.positionsUnknown?.length) unknownPaths.push(path);
    return compactPosition(path, result);
  }).filter((entry): entry is DeploymentPath => entry !== null);

  return {
    paths: compact,
    unknownPaths,
    totalPaths: paths.length,
    truncated: paths.length > selected.length,
  };
}
