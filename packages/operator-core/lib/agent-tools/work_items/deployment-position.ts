/**
 * Read-time deployment position for terminal completion evidence.
 *
 * A completion record proves what was verified, while `gitPipelinePosition`
 * answers whether the named paths reached the callers that need them. This
 * module owns only the COMPLETION-EVIDENCE shape (which keys hold paths); the
 * fan-out, its cap, and its fail-soft contract live in the shared
 * `lib/deployment-position` core so the plan ship gate can reuse them rather
 * than growing a second copy.
 */
import {
  deploymentPositionForPaths,
  MAX_DEPLOYMENT_POSITION_PATHS,
  type DeploymentPositionForPaths,
} from '../../deployment-position';

export { MAX_DEPLOYMENT_POSITION_PATHS };

export interface DeploymentPositionForEvidence extends DeploymentPositionForPaths {
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

/**
 * Resolve the paths recorded by a terminal completion. Absent evidence yields no
 * signal at all; evidence naming no path yields an EXPLICIT unknown, because
 * "nothing to probe" and "probed and found nothing deployed" are different facts.
 */
export async function deploymentPositionForEvidence(
  evidence: unknown,
): Promise<DeploymentPositionForEvidence | undefined> {
  if (!isRecord(evidence)) return undefined;

  const paths = evidencePaths(evidence);
  if (paths.length === 0) {
    return { paths: [], unknownPaths: [], totalPaths: 0, truncated: false, unknownReason: 'no-filesChanged' };
  }

  return deploymentPositionForPaths(paths);
}
