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
  /**
   * Require the scanner to PROVE it covered the image before its findings are
   * believed: `mountedFilesystems >= 1` and a non-empty `candidateRootProof`.
   *
   * Deliberately REQUIRED rather than optional-defaulting-false. An optional flag is
   * exactly the shape that produced the defect this field closes — the coverage pair
   * was carried to this gate for a full day while nothing read it, because absence
   * read as acceptance. A required field forces every policy to STATE whether its
   * provider can prove coverage, so a new provider cannot inherit "no" by silence.
   *
   * Set FALSE only for a provider whose scanner does not measure coverage at all
   * (today: AWS and Azure — see `WORKSPACE_HOST_IMAGE_SCAN_POLICY`). Setting it TRUE
   * against such a provider fail-closes a release path that did nothing wrong.
   */
  requireCoverageProof: boolean;
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
  // FALSE because this shared constant still gates the AWS and Azure release paths,
  // whose scanners measure no coverage at all. Requiring the proof here would
  // fail-close two providers against a field neither has ever produced — a
  // hardening that lands as an outage. Measured 2026-08-30: `mountedFilesystems`
  // and `candidateRootProof` appear ZERO times in aws-ami-release.ts and
  // azure-compute-gallery-release.ts. Their real fix is scanner parity, tracked
  // separately; until then, silence about coverage is not a claim of coverage,
  // it is an absence this constant declines to interpret.
  requireCoverageProof: false,
});

/**
 * The GCP-scoped policy: identical thresholds, but the scanner MUST prove it
 * covered the image.
 *
 * Separate from the shared constant on purpose. The alternative — flipping
 * `requireCoverageProof` on the one shared object — would silently arm the
 * requirement for AWS and Azure too. The asymmetry is real (only the GCP scanner
 * measures coverage), so it is expressed as two policies rather than one policy
 * plus a comment asking the reader to remember which providers are safe.
 */
export const GCP_IMAGE_SCAN_POLICY: ImageScanPolicy = Object.freeze({
  ...WORKSPACE_HOST_IMAGE_SCAN_POLICY,
  requireCoverageProof: true,
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
  | 'coverage-proof-invalid'
  | 'coverage-proof-missing'
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
  /**
   * How many filesystems the guest actually mounted off the candidate disk.
   *
   * Typed `unknown` rather than `number | undefined` deliberately: this value
   * crosses a process boundary as JSON from a guest VM, so the type it is DECLARED
   * as here is a claim about a wire payload, not a compiler-checked fact. Narrowing
   * it is this module's job, not the caller's.
   */
  mountedFilesystems?: unknown;
  /**
   * Path to the file that proves an OS root was mounted (e.g. an `/etc/os-release`
   * under the candidate mount). Same `unknown` reasoning as above.
   */
  candidateRootProof?: unknown;
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
  if (
    typeof threshold !== 'number' ||
    !isSafeCount(policy.maxSecretFindings) ||
    typeof policy.requireCoverageProof !== 'boolean'
  ) {
    failures.push({
      code: 'invalid-policy',
      message:
        `Policy is unusable: denyVulnerabilitiesAtOrAbove '${policy.denyVulnerabilitiesAtOrAbove}' ` +
        `must be a known severity, maxSecretFindings '${policy.maxSecretFindings}' a non-negative integer, ` +
        `and requireCoverageProof '${policy.requireCoverageProof}' a boolean.`,
    });
    return verdict(false, -1, -1);
  }

  // ── Scan coverage ────────────────────────────────────────────────────────────
  // Checked BEFORE any finding count, because "did this scan cover the image" is
  // prior to "what did it find". A scan that mounted nothing reports zero findings,
  // and zero findings is the shape of a perfect result — the same dead-instrument
  // failure the severity reconciliation below already defends against, one level up.
  //
  // Two rules, and the second applies to EVERY provider:
  //   1. If the policy REQUIRES proof, absence is a denial.
  //   2. If a value is PRESENT, it is validated regardless of the policy — so a
  //      provider that starts emitting a malformed proof is caught the day it does,
  //      not the day someone remembers to flip the flag on.
  const hasMounted = input.mountedFilesystems !== undefined && input.mountedFilesystems !== null;
  const hasRootProof = input.candidateRootProof !== undefined && input.candidateRootProof !== null;

  if (policy.requireCoverageProof && (!hasMounted || !hasRootProof)) {
    const absent = [!hasMounted ? 'mountedFilesystems' : null, !hasRootProof ? 'candidateRootProof' : null]
      .filter(Boolean)
      .join(' and ');
    failures.push({
      code: 'coverage-proof-missing',
      message:
        `Policy requires proof the scanner covered the image, but ${absent} ` +
        `${absent.includes(' and ') ? 'are' : 'is'} absent. An unproven scan cannot be read as a clean one.`,
    });
    return verdict(false, -1, -1);
  }

  if (hasMounted && !(isSafeCount(input.mountedFilesystems) && (input.mountedFilesystems as number) >= 1)) {
    failures.push({
      code: 'coverage-proof-invalid',
      message:
        `mountedFilesystems must be a safe integer >= 1; received ${JSON.stringify(input.mountedFilesystems)}. ` +
        `A scan that mounted no filesystem has measured nothing.`,
    });
    return verdict(false, -1, -1);
  }

  if (hasRootProof && !(typeof input.candidateRootProof === 'string' && input.candidateRootProof.trim() !== '')) {
    failures.push({
      code: 'coverage-proof-invalid',
      message:
        `candidateRootProof must be a non-empty string; received ${JSON.stringify(input.candidateRootProof)}. ` +
        `Without it the scan cannot show it mounted an OS root rather than an empty or data-only partition.`,
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
