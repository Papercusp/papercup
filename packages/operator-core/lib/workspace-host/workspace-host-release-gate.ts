import {
  WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
  evaluateWorkspaceHostImageCompatibility,
  validateWorkspaceHostImageArtifact,
  verifyWorkspaceHostBuildManifest,
  type WorkspaceHostBuildManifestVerification,
  type WorkspaceHostCleanRoomAcceptanceCheck,
  type WorkspaceHostCleanRoomAcceptanceReport,
  type WorkspaceHostImageArtifact,
  type WorkspaceHostImageCompatibilityRequest,
  type WorkspaceHostImageCompatibilityResult,
} from '@papercusp/deployment-driver';

import type { ArtifactTrustReport } from './artifact-trust';

export const WORKSPACE_HOST_RELEASE_GATE_VERSION = 'workspace-host-release-gate-v1';

const REQUIRED_CLEAN_ROOM_CHECKS = [
  'artifact-identity',
  'compatibility-matrix',
  'deterministic-bootstrap-fixture',
  'exact-bootstrap-attestation',
] as const satisfies readonly WorkspaceHostCleanRoomAcceptanceCheck[];

const SHA256 = /^[a-f0-9]{64}$/;

export type WorkspaceHostReleaseGateFailureCode =
  | 'clean-room-rejected'
  | 'clean-room-subject-mismatch'
  | 'incompatible-image'
  | 'invalid-build-manifest'
  | 'invalid-image-artifact'
  | 'trust-subject-mismatch'
  | 'untrusted-release';

export interface WorkspaceHostReleaseGateFailure {
  code: WorkspaceHostReleaseGateFailureCode;
  message: string;
}

export interface WorkspaceHostReleaseGateInput {
  artifact: WorkspaceHostImageArtifact;
  trustReport: ArtifactTrustReport;
  compatibilityRequest: WorkspaceHostImageCompatibilityRequest;
  cleanRoomReport: WorkspaceHostCleanRoomAcceptanceReport;
}

export interface WorkspaceHostReleaseGateVerdict {
  version: typeof WORKSPACE_HOST_RELEASE_GATE_VERSION;
  accepted: boolean;
  manifest: WorkspaceHostBuildManifestVerification;
  compatibility: WorkspaceHostImageCompatibilityResult;
  failures: readonly WorkspaceHostReleaseGateFailure[];
}

function sameImage(
  left: WorkspaceHostCleanRoomAcceptanceReport['image'],
  right: WorkspaceHostImageArtifact['image'],
): boolean {
  return left.id === right.id && left.version === right.version;
}

function issueSummary(issues: WorkspaceHostImageCompatibilityResult['issues']): string {
  return issues.map((issue) => `${issue.code}: ${issue.message}`).join('; ');
}

/**
 * Join the independently-tested build, trust, image-compatibility, and
 * clean-room contracts at the one point where a workspace-host release is
 * admitted. Every verdict is recomputed or bound to the exact immutable image
 * and release digest supplied here; callers cannot combine green evidence from
 * different artifacts.
 */
export function evaluateWorkspaceHostReleaseGate(
  input: WorkspaceHostReleaseGateInput,
): WorkspaceHostReleaseGateVerdict {
  const failures: WorkspaceHostReleaseGateFailure[] = [];
  const manifest = verifyWorkspaceHostBuildManifest(input.artifact.buildManifest);
  if (!manifest.ok) {
    failures.push({
      code: 'invalid-build-manifest',
      message: manifest.errors.join('; '),
    });
  } else {
    const artifactErrors = validateWorkspaceHostImageArtifact(input.artifact);
    if (artifactErrors.length > 0) {
      failures.push({
        code: 'invalid-image-artifact',
        message: artifactErrors.join('; '),
      });
    }
  }

  if (!input.trustReport.trusted || input.trustReport.failures.length > 0) {
    failures.push({
      code: 'untrusted-release',
      message:
        input.trustReport.failures.map((failure) => failure.message).join('; ') ||
        'Artifact trust report is not trusted',
    });
  }

  const trustDigest = input.trustReport.subject.sha256;
  const releaseDigest = input.artifact.release.bundleSha256;
  const manifestDigest = input.artifact.buildManifest.releaseArtifact.sha256;
  if (trustDigest !== releaseDigest || trustDigest !== manifestDigest) {
    failures.push({
      code: 'trust-subject-mismatch',
      message:
        `Trust subject ${trustDigest} must equal release.bundleSha256 ` +
        `${releaseDigest} and buildManifest.releaseArtifact.sha256 ${manifestDigest}`,
    });
  }

  const compatibility = evaluateWorkspaceHostImageCompatibility(input.artifact, input.compatibilityRequest);
  if (!compatibility.compatible) {
    failures.push({
      code: 'incompatible-image',
      message: issueSummary(compatibility.issues),
    });
  }

  const cleanRoom = input.cleanRoomReport;
  if (!sameImage(cleanRoom.image, input.artifact.image)) {
    failures.push({
      code: 'clean-room-subject-mismatch',
      message:
        `Clean-room report for ${cleanRoom.image.id}@${cleanRoom.image.version} ` +
        `does not match ${input.artifact.image.id}@${input.artifact.image.version}`,
    });
  }

  const missingChecks = REQUIRED_CLEAN_ROOM_CHECKS.filter((check) => !cleanRoom.checks.includes(check));
  const cleanRoomErrors: string[] = [];
  if (cleanRoom.contractVersion !== WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION) {
    cleanRoomErrors.push('clean-room contract version is unsupported');
  }
  if (!cleanRoom.passed) cleanRoomErrors.push('clean-room report did not pass');
  if (cleanRoom.issues.length > 0) {
    cleanRoomErrors.push(issueSummary(cleanRoom.issues));
  }
  if (missingChecks.length > 0) {
    cleanRoomErrors.push(`missing checks: ${missingChecks.join(', ')}`);
  }
  if (!cleanRoom.bootstrapScriptSha256 || !SHA256.test(cleanRoom.bootstrapScriptSha256)) {
    cleanRoomErrors.push('bootstrap script digest is missing or invalid');
  }
  if (!cleanRoom.attestation) {
    cleanRoomErrors.push('exact bootstrap attestation is missing');
  } else {
    if (
      cleanRoom.attestation.release.version !== input.artifact.release.version ||
      cleanRoom.attestation.release.bundleSha256 !== releaseDigest ||
      cleanRoom.attestation.release.signingKeySha256 !== input.artifact.release.signingKeySha256
    ) {
      cleanRoomErrors.push('bootstrap attestation release identity does not match');
    }
    if (!cleanRoom.attestation.release.signatureVerified) {
      cleanRoomErrors.push('bootstrap attestation did not verify the release signature');
    }
  }
  if (cleanRoomErrors.length > 0) {
    failures.push({
      code: 'clean-room-rejected',
      message: cleanRoomErrors.join('; '),
    });
  }

  return {
    version: WORKSPACE_HOST_RELEASE_GATE_VERSION,
    accepted: failures.length === 0,
    manifest,
    compatibility,
    failures,
  };
}
