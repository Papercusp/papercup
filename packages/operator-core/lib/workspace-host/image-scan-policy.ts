import { SEVERITY_RANK as ARTIFACT_TRUST_SEVERITY_RANK, type VulnerabilitySeverity } from './artifact-trust';

/**
 * Policy evaluation for the workspace-host IMAGE scan, shared by every provider
 * release path (GCP, AWS, Azure).
 *
 * ## Why this module exists
 *
 * There are two different security controls in this subsystem, on two different
 * SUBJECTS, and they were being held to the same bar:
 *
 *  - The RELEASE BUNDLE — papercusp-authored content — is evaluated by
 *    `artifact-trust.ts` under an `ArtifactTrustPolicy`. Zero secrets and a
 *    severity-ranked vulnerability threshold are exactly right there, because we
 *    author every byte of it.
 *  - The VM IMAGE — that same bundle PLUS an entire Ubuntu userland — was gated by
 *    four hand-rolled copies of `vulnerabilityFindings !== 0 || secretFindings !== 0`.
 *
 * Demanding zero grype matches at ANY severity across a whole distribution is
 * unsatisfiable by construction: the first honest scan of a stock Ubuntu 24.04
 * workspace-host image measured 3922 vulnerability matches (EI-21770579023793724).
 *
 * The reason that went unnoticed for so long is the part worth remembering: the gate
 * had never once evaluated real numbers. The scanner installed gitleaks from a URL
 * that has never existed, so it always died before any evidence reached the gate.
 * **The only state in which that pipeline could publish an image was one in which its
 * own scanner was dead.** Every guard below is written to make that shape impossible
 * to reach again — each one fails CLOSED, and `severity-breakdown-mismatch` exists
 * specifically so that a missing or empty measurement can never read as a clean one.
 *
 * ## What this module does NOT do
 *
 * It does not loosen the secret bar. `maxSecretFindings: 0` is the established
 * policy and `publication-manifest.ts` hard-requires it. If an image scan reports
 * secret findings, this module fails — the open question there is the scan's SCOPE
 * (gitleaks currently reads the entire mounted userland, so its count says nothing
 * about papercusp-authored content), and scope is fixed in the scanner, not here.
 */
export const WORKSPACE_HOST_IMAGE_SCAN_POLICY_VERSION = 'workspace-host-image-scan-policy-v1';

export interface ImageScanPolicy {
  /** Findings at or above this severity are denied. Mirrors `ArtifactTrustPolicy`. */
  denyVulnerabilitiesAtOrAbove: Exclude<VulnerabilitySeverity, 'unknown'>;
  /** Maximum tolerated secret findings. */
  maxSecretFindings: number;
}

/**
 * The ratified workspace-host release security policy: deny vulnerabilities at or
 * above HIGH, allow ZERO secrets.
 *
 * This is not a new threshold scheme. It is the policy every `ArtifactTrustPolicy`
 * call site in this repository already instantiates — including this very release
 * path — lifted into one exported constant so the image gate consults the same
 * numbers instead of a fifth hand-rolled copy.
 */
export const WORKSPACE_HOST_IMAGE_SCAN_POLICY: ImageScanPolicy = Object.freeze({
  denyVulnerabilitiesAtOrAbove: 'high',
  maxSecretFindings: 0,
});

/**
 * Severity ordering, DERIVED from `artifact-trust.ts` rather than restated here, so
 * the image gate and the bundle gate cannot drift into ranking the same word
 * differently. `unknown` therefore sits BELOW `low`, exactly as the ratified policy
 * already has it — this module reuses that ordering rather than inventing a
 * stricter one.
 *
 * The single addition is `negligible`: grype's own bottom rung, which has no
 * `ArtifactTrustPolicy` equivalent because that policy never sees raw scanner
 * labels. It ranks below `unknown`, and no policy can deny it, since
 * `denyVulnerabilitiesAtOrAbove` cannot be set lower than `low`.
 */
const SEVERITY_RANK: Readonly<Record<string, number>> = Object.freeze({
  ...ARTIFACT_TRUST_SEVERITY_RANK,
  negligible: ARTIFACT_TRUST_SEVERITY_RANK.unknown - 1,
});

export type ImageScanPolicyFailureCode =
  | 'invalid-policy'
  | 'malformed-severity-breakdown'
  | 'secret-threshold'
  | 'severity-breakdown-mismatch'
  | 'unrecognized-severity'
  | 'vulnerability-threshold';

export interface ImageScanPolicyFailure {
  code: ImageScanPolicyFailureCode;
  message: string;
}

export interface ImageScanPolicyInput {
  /** Total grype matches at any severity, as reported by the scanner. */
  vulnerabilityFindings: number;
  /** Per-severity counts keyed by grype's own severity labels. */
  vulnerabilityBySeverity: Readonly<Record<string, unknown>>;
  /** Total gitleaks findings, as reported by the scanner. */
  secretFindings: number;
}

export interface ImageScanPolicyVerdict {
  version: typeof WORKSPACE_HOST_IMAGE_SCAN_POLICY_VERSION;
  accepted: boolean;
  /** Findings at or above the denied severity. This is what the gate acts on. */
  policyViolatingVulnerabilities: number;
  /** Everything below the threshold: recorded as evidence, never a pass/fail input. */
  toleratedVulnerabilities: number;
  totalVulnerabilities: number;
  secretFindings: number;
  failures: readonly ImageScanPolicyFailure[];
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Evaluate a scanner measurement against the ratified image policy.
 *
 * Every failure mode below is fail-CLOSED: a measurement this function cannot fully
 * account for is rejected, never tolerated. In particular the sum of
 * `vulnerabilityBySeverity` must reconcile exactly against `vulnerabilityFindings`,
 * so a breakdown that is empty, partial, or silently dropped cannot present itself
 * as "zero findings at or above the threshold".
 */
export function evaluateImageScanPolicy(
  input: ImageScanPolicyInput,
  policy: ImageScanPolicy = WORKSPACE_HOST_IMAGE_SCAN_POLICY,
): ImageScanPolicyVerdict {
  const failures: ImageScanPolicyFailure[] = [];
  const verdict = (accepted: boolean, violating: number, tolerated: number): ImageScanPolicyVerdict => ({
    version: WORKSPACE_HOST_IMAGE_SCAN_POLICY_VERSION,
    accepted,
    policyViolatingVulnerabilities: violating,
    toleratedVulnerabilities: tolerated,
    totalVulnerabilities: isSafeCount(input.vulnerabilityFindings) ? input.vulnerabilityFindings : -1,
    secretFindings: isSafeCount(input.secretFindings) ? input.secretFindings : -1,
    failures,
  });

  const threshold = SEVERITY_RANK[policy.denyVulnerabilitiesAtOrAbove];
  if (typeof threshold !== 'number' || !isSafeCount(policy.maxSecretFindings)) {
    failures.push({
      code: 'invalid-policy',
      message:
        `Policy is unusable: denyVulnerabilitiesAtOrAbove '${policy.denyVulnerabilitiesAtOrAbove}' ` +
        `must be a known severity and maxSecretFindings '${policy.maxSecretFindings}' a non-negative integer.`,
    });
    return verdict(false, -1, -1);
  }

  if (!isSafeCount(input.vulnerabilityFindings) || !isSafeCount(input.secretFindings)) {
    failures.push({
      code: 'malformed-severity-breakdown',
      message: 'Scanner counts must be non-negative safe integers.',
    });
    return verdict(false, -1, -1);
  }

  const breakdown = input.vulnerabilityBySeverity;
  if (typeof breakdown !== 'object' || breakdown === null || Array.isArray(breakdown)) {
    failures.push({
      code: 'malformed-severity-breakdown',
      message: 'vulnerabilityBySeverity must be an object keyed by severity.',
    });
    return verdict(false, -1, -1);
  }

  let violating = 0;
  let tolerated = 0;
  let counted = 0;
  for (const [label, rawCount] of Object.entries(breakdown)) {
    if (!isSafeCount(rawCount)) {
      failures.push({
        code: 'malformed-severity-breakdown',
        message: `Severity '${label}' has a non-integer count.`,
      });
      return verdict(false, -1, -1);
    }
    counted += rawCount;
    const rank = SEVERITY_RANK[label.trim().toLowerCase()];
    if (typeof rank !== 'number') {
      // An unrecognised label is not evidence of safety. A severity this build does
      // not know about counts as violating, so a scanner that starts emitting a new
      // label turns the gate RED and gets a human's attention — rather than silently
      // widening what passes.
      failures.push({
        code: 'unrecognized-severity',
        message: `Severity '${label}' is not a known severity; counting its ${rawCount} finding(s) as policy-violating.`,
      });
      violating += rawCount;
      continue;
    }
    if (rank >= threshold) violating += rawCount;
    else tolerated += rawCount;
  }

  // The reconciliation that makes an absent measurement impossible to misread as a
  // clean one. Without it, `vulnerabilityBySeverity: {}` reports zero violations
  // while `vulnerabilityFindings` is in the thousands — precisely the shape of the
  // original defect, where a dead instrument was indistinguishable from a pass.
  if (counted !== input.vulnerabilityFindings) {
    failures.push({
      code: 'severity-breakdown-mismatch',
      message:
        `vulnerabilityBySeverity sums to ${counted} but vulnerabilityFindings is ` +
        `${input.vulnerabilityFindings}; the measurement does not account for every finding.`,
    });
    return verdict(false, -1, -1);
  }

  if (violating > 0) {
    failures.push({
      code: 'vulnerability-threshold',
      message:
        `${violating} vulnerability finding(s) at or above '${policy.denyVulnerabilitiesAtOrAbove}' ` +
        `(${tolerated} below the threshold, recorded as evidence).`,
    });
  }

  if (input.secretFindings > policy.maxSecretFindings) {
    failures.push({
      code: 'secret-threshold',
      message: `Secret scan found ${input.secretFindings}; policy allows ${policy.maxSecretFindings}.`,
    });
  }

  return verdict(failures.length === 0, violating, tolerated);
}
