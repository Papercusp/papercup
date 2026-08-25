import { createHash } from 'node:crypto';

import {
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
  WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
  WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
  WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT,
  WORKSPACE_HOST_SHARED_BUILDER_KIND,
  buildWorkspaceHostBuildManifest,
  deriveWorkspaceHostCanonicalArtifactUrls,
  buildWorkspaceHostCleanRoomInstallFixture,
  workspaceHostCleanRoomFixtureAttestation,
  type WorkspaceHostCleanRoomAcceptanceReport,
  type WorkspaceHostCleanRoomInstallSpec,
  type WorkspaceHostImageArtifact,
  type WorkspaceHostImageCompatibilityRequest,
} from '@papercusp/deployment-driver';
import { describe, expect, it } from 'vitest';

import { ARTIFACT_TRUST_PIPELINE_VERSION, type ArtifactTrustReport } from './artifact-trust';
import { evaluateWorkspaceHostReleaseGate } from './workspace-host-release-gate';

const RELEASE_DIGEST = 'a'.repeat(64);
const SIGNING_PUBLIC_KEY = 'untrusted comment: Papercusp workspace-host release key\nRWQpublickey';
const SIGNING_KEY_DIGEST = createHash('sha256').update(SIGNING_PUBLIC_KEY, 'utf8').digest('hex');
const SBOM_DIGEST = 'b'.repeat(64);

function artifact(version = '2026.8.22-1'): WorkspaceHostImageArtifact {
  const buildManifest = buildWorkspaceHostBuildManifest({
    contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
    distributionProfile: 'vm-release',
    source: {
      repository: 'https://github.com/Papercusp/papercusp.git',
      revision: '1'.repeat(40),
    },
    releaseArtifact: {
      name: `papercusp-server-${version}.tgz`,
      version,
      sha256: RELEASE_DIGEST,
      sizeBytes: 42_000,
    },
    baseImage: {
      reference: 'ubuntu-2404-minimal',
      architecture: 'x86_64',
      sha256: 'c'.repeat(64),
    },
    builder: {
      strategy: 'shared',
      kind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
      version: '1.14.2',
      templatePath: 'infra/images/workspace-host.pkr.hcl',
      templateSha256: 'd'.repeat(64),
    },
    materials: [
      {
        path: 'dist/papercusp-server.tgz',
        sha256: RELEASE_DIGEST,
        sizeBytes: 42_000,
      },
      // A shippable bundle must carry the remote initializer as an executable, or the image
      // installs and reports healthy and then fails every initialization at the far end.
      {
        path: WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT,
        sha256: 'e'.repeat(64),
        sizeBytes: 2_048,
        executable: true,
      },
    ],
    parameters: [{ name: 'distribution_profile', value: 'vm-release' }],
    targets: [{ provider: 'gcp', locations: ['us-central1'] }],
  });
  return {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: { id: 'papercusp-workspace-host', version },
    buildManifest,
    release: {
      version,
      // Derived from the digest, not hand-authored against a hostname that does not resolve:
      // the canonical publication path is content-addressed, so the address and the integrity
      // check are the same value.
      bundleUrl: deriveWorkspaceHostCanonicalArtifactUrls(RELEASE_DIGEST).bundleUrl,
      bundleSha256: RELEASE_DIGEST,
      signatureUrl: deriveWorkspaceHostCanonicalArtifactUrls(RELEASE_DIGEST).signatureUrl,
      signingPublicKey: SIGNING_PUBLIC_KEY,
      signingKeySha256: SIGNING_KEY_DIGEST,
    },
    lifecycle: { state: 'active', publishedAt: '2026-08-22T00:00:00Z' },
    compatibility: [
      {
        provider: 'gcp',
        architecture: 'x86_64',
        ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
        bootstrapContractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
        actions: ['install'],
        maximumArtifactAgeDays: 30,
      },
    ],
  };
}

function compatibilityRequest(): WorkspaceHostImageCompatibilityRequest {
  return {
    action: 'install',
    provider: 'gcp',
    architecture: 'x86_64',
    ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
    observedAt: '2026-08-23T00:00:00Z',
  };
}

function cleanRoomSpec(): WorkspaceHostCleanRoomInstallSpec {
  return {
    fixtureId: 'gcp-x86_64-install-1',
    action: 'install',
    provider: 'gcp',
    architecture: 'x86_64',
    observedAt: '2026-08-23T00:00:00Z',
    hostId: 'clean-room-host-1',
    migrationId: 'schema-1042',
    minimumNodeMajor: 22,
    service: { name: 'papercusp-workspace', port: 3070 },
  };
}

function trustReport(sha256 = RELEASE_DIGEST): ArtifactTrustReport {
  return {
    version: ARTIFACT_TRUST_PIPELINE_VERSION,
    subject: {
      path: '/release/papercusp-server.tgz',
      name: 'papercusp-server.tgz',
      bytes: 42_000,
      sha256,
      signed: true,
    },
    policy: {
      denyVulnerabilitiesAtOrAbove: 'high',
      maxSecretFindings: 0,
      maxAttestationAgeMs: 60 * 60 * 1_000,
    },
    trusted: true,
    evidence: [
      {
        kind: 'signature',
        subjectSha256: sha256,
        tool: { name: 'minisign', version: '0.12' },
        valid: true,
      },
      {
        kind: 'sbom',
        subjectSha256: sha256,
        tool: { name: 'syft', version: '1.30' },
        format: 'cyclonedx-json',
        documentSha256: SBOM_DIGEST,
        componentCount: 42,
      },
      {
        kind: 'vulnerability-scan',
        subjectSha256: sha256,
        tool: { name: 'grype', version: '0.99' },
        sbomSha256: SBOM_DIGEST,
        findings: [],
      },
      {
        kind: 'secret-scan',
        subjectSha256: sha256,
        tool: { name: 'gitleaks', version: '8.28' },
        findings: [],
      },
      {
        kind: 'provenance-attestation',
        subjectSha256: sha256,
        tool: { name: 'cosign', version: '2.5' },
        valid: true,
        predicateType: 'https://slsa.dev/provenance/v1',
        issuedAt: '2026-08-22T23:59:00Z',
        attestationSha256: 'e'.repeat(64),
      },
    ],
    failures: [],
  };
}

function cleanRoomReport(candidate: WorkspaceHostImageArtifact): WorkspaceHostCleanRoomAcceptanceReport {
  const spec = cleanRoomSpec();
  const fixture = buildWorkspaceHostCleanRoomInstallFixture(candidate, spec);
  return {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    fixtureId: spec.fixtureId,
    image: candidate.image,
    passed: true,
    checks: [
      'artifact-identity',
      'compatibility-matrix',
      'deterministic-bootstrap-fixture',
      'exact-bootstrap-attestation',
    ],
    issues: [],
    bootstrapScriptSha256: fixture.bootstrapScriptSha256,
    attestation: workspaceHostCleanRoomFixtureAttestation(fixture, spec.observedAt),
  };
}

describe('evaluateWorkspaceHostReleaseGate', () => {
  it('accepts one exact manifest, release, trust subject, compatibility row, and clean-room report', () => {
    const candidate = artifact();
    const verdict = evaluateWorkspaceHostReleaseGate({
      artifact: candidate,
      trustReport: trustReport(),
      compatibilityRequest: compatibilityRequest(),
      cleanRoomReport: cleanRoomReport(candidate),
    });

    expect(verdict).toMatchObject({
      accepted: true,
      manifest: { ok: true },
      compatibility: { compatible: true, issues: [] },
      failures: [],
    });
  });

  it('rejects a trust report for different release bytes', () => {
    const candidate = artifact();
    const verdict = evaluateWorkspaceHostReleaseGate({
      artifact: candidate,
      trustReport: trustReport('f'.repeat(64)),
      compatibilityRequest: compatibilityRequest(),
      cleanRoomReport: cleanRoomReport(candidate),
    });

    expect(verdict.accepted).toBe(false);
    expect(verdict.failures).toContainEqual(expect.objectContaining({ code: 'trust-subject-mismatch' }));
  });

  it('rejects a tampered canonical manifest identity', () => {
    const valid = artifact();
    const candidate: WorkspaceHostImageArtifact = {
      ...valid,
      buildManifest: {
        ...valid.buildManifest,
        manifestIdentity: `sha256:${'f'.repeat(64)}`,
      },
    };
    const verdict = evaluateWorkspaceHostReleaseGate({
      artifact: candidate,
      trustReport: trustReport(),
      compatibilityRequest: compatibilityRequest(),
      cleanRoomReport: cleanRoomReport(valid),
    });

    expect(verdict.accepted).toBe(false);
    expect(verdict.failures).toContainEqual(expect.objectContaining({ code: 'invalid-build-manifest' }));
  });

  it('recomputes compatibility and rejects incomplete clean-room evidence', () => {
    const candidate = artifact();
    const cleanRoom = cleanRoomReport(candidate);
    const verdict = evaluateWorkspaceHostReleaseGate({
      artifact: candidate,
      trustReport: trustReport(),
      compatibilityRequest: {
        ...compatibilityRequest(),
        provider: 'aws',
      },
      cleanRoomReport: {
        ...cleanRoom,
        passed: false,
        checks: ['artifact-identity'],
        attestation: undefined,
      },
    });

    expect(verdict.accepted).toBe(false);
    expect(verdict.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining(['incompatible-image', 'clean-room-rejected']),
    );
  });

  it('rejects a green clean-room report issued for another image version', () => {
    const candidate = artifact();
    const verdict = evaluateWorkspaceHostReleaseGate({
      artifact: candidate,
      trustReport: trustReport(),
      compatibilityRequest: compatibilityRequest(),
      cleanRoomReport: cleanRoomReport(artifact('2026.8.23-1')),
    });

    expect(verdict.accepted).toBe(false);
    expect(verdict.failures).toContainEqual(expect.objectContaining({ code: 'clean-room-subject-mismatch' }));
  });
});
