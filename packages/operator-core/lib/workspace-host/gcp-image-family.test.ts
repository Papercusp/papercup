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
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';
import { describe, expect, it } from 'vitest';

import { ARTIFACT_TRUST_PIPELINE_VERSION, type ArtifactTrustReport } from './artifact-trust';
import {
  GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS,
  assertGcpImmutableImageId,
  executeGcpImageFamilyRelease,
  rollbackGcpImageFamily,
  type GcpImageCleanBootProof,
  type GcpImageFamilyPin,
  type GcpImageFamilyReleaseAdapter,
  type GcpImageFamilyReleaseRequest,
  type GcpImageInspection,
  type GcpImageScanEvidence,
} from './gcp-image-family';

const PROJECT = 'papercusp-images-123';
const FAMILY = 'papercusp-workspace-host';
const ZONE = 'us-central1-a';
const VERSION = '2026.8.23-1';
const IMAGE_NAME = 'papercusp-workspace-host-2026-8-23-1';
const IMAGE_ID = `projects/${PROJECT}/global/images/${IMAGE_NAME}`;
const CANDIDATE_ID = `projects/${PROJECT}/global/images/${IMAGE_NAME}-candidate`;
const PREVIOUS: GcpImageFamilyPin = {
  projectId: PROJECT,
  family: FAMILY,
  imageId: `projects/${PROJECT}/global/images/papercusp-workspace-host-2026-8-22-1`,
  version: '2026.8.22-1',
};
const OLDER: GcpImageFamilyPin = {
  projectId: PROJECT,
  family: FAMILY,
  imageId: `projects/${PROJECT}/global/images/papercusp-workspace-host-2026-8-21-1`,
  version: '2026.8.21-1',
};
const RELEASE_SHA = 'a'.repeat(64);
const SBOM_SHA = 'b'.repeat(64);
const SIGNING_PUBLIC_KEY = 'untrusted comment: Papercusp workspace-host release key\nRWQpublickey';
const SIGNING_KEY_SHA = createHash('sha256').update(SIGNING_PUBLIC_KEY, 'utf8').digest('hex');
const PUBLISHED_AT = '2026-08-23T01:00:00.000Z';

function artifact(): WorkspaceHostImageArtifact {
  const buildManifest = buildWorkspaceHostBuildManifest({
    contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
    distributionProfile: 'vm-release',
    source: { repository: 'https://github.com/Papercusp/papercusp.git', revision: '1'.repeat(40) },
    releaseArtifact: {
      name: `papercusp-server-${VERSION}.tgz`,
      version: VERSION,
      sha256: RELEASE_SHA,
      sizeBytes: 42_000,
    },
    baseImage: { reference: 'ubuntu-24.04-amd64', architecture: 'x86_64', sha256: 'd'.repeat(64) },
    builder: {
      strategy: 'shared',
      kind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
      version: '1.14.2',
      templatePath: 'infra/images/workspace-host.pkr.hcl',
      templateSha256: 'e'.repeat(64),
    },
    materials: [
      { path: 'dist/papercusp-server.tgz', sha256: RELEASE_SHA, sizeBytes: 42_000 },
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
    targets: [{ provider: 'gcp', locations: [PROJECT] }],
  });
  return {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: { id: IMAGE_ID, version: VERSION },
    buildManifest,
    release: {
      version: VERSION,
      // Derived from the digest, not hand-authored against a hostname that does not resolve:
      // the canonical publication path is content-addressed, so the address and the integrity
      // check are the same value.
      bundleUrl: deriveWorkspaceHostCanonicalArtifactUrls(RELEASE_SHA).bundleUrl,
      bundleSha256: RELEASE_SHA,
      signatureUrl: deriveWorkspaceHostCanonicalArtifactUrls(RELEASE_SHA).signatureUrl,
      signingPublicKey: SIGNING_PUBLIC_KEY,
      signingKeySha256: SIGNING_KEY_SHA,
    },
    lifecycle: { state: 'active', publishedAt: PUBLISHED_AT },
    compatibility: [
      {
        provider: 'gcp',
        architecture: 'x86_64',
        ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
        bootstrapContractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
        actions: ['install', 'upgrade', 'rollback'],
        maximumArtifactAgeDays: 30,
      },
    ],
  };
}

function trustReport(): ArtifactTrustReport {
  return {
    version: ARTIFACT_TRUST_PIPELINE_VERSION,
    subject: {
      path: '/release/papercusp-server.tgz',
      name: 'papercusp-server.tgz',
      bytes: 42_000,
      sha256: RELEASE_SHA,
      signed: true,
    },
    policy: { denyVulnerabilitiesAtOrAbove: 'high', maxSecretFindings: 0, maxAttestationAgeMs: 60 * 60 * 1_000 },
    trusted: true,
    failures: [],
    evidence: [
      { kind: 'signature', subjectSha256: RELEASE_SHA, tool: { name: 'minisign', version: '0.12' }, valid: true },
      {
        kind: 'sbom',
        subjectSha256: RELEASE_SHA,
        tool: { name: 'syft', version: '1.30' },
        format: 'cyclonedx-json',
        documentSha256: SBOM_SHA,
        componentCount: 42,
      },
      {
        kind: 'vulnerability-scan',
        subjectSha256: RELEASE_SHA,
        tool: { name: 'grype', version: '0.99' },
        sbomSha256: SBOM_SHA,
        findings: [],
      },
      { kind: 'secret-scan', subjectSha256: RELEASE_SHA, tool: { name: 'gitleaks', version: '8.28' }, findings: [] },
      {
        kind: 'provenance-attestation',
        subjectSha256: RELEASE_SHA,
        tool: { name: 'cosign', version: '2.5' },
        valid: true,
        predicateType: 'https://slsa.dev/provenance/v1',
        issuedAt: '2026-08-23T00:10:00.000Z',
        attestationSha256: 'f'.repeat(64),
      },
    ],
  };
}

function request(): GcpImageFamilyReleaseRequest {
  const candidate = artifact();
  const cleanSpec = {
    fixtureId: 'gcp-clean-room',
    action: 'install' as const,
    provider: 'gcp',
    architecture: 'x86_64',
    observedAt: '2026-08-23T01:20:00.000Z',
    hostId: 'gcp-clean-host-1',
    migrationId: 'schema-1042',
    minimumNodeMajor: 22,
    service: { name: 'papercusp-workspace', port: 3070 },
  };
  const fixture = buildWorkspaceHostCleanRoomInstallFixture(candidate, cleanSpec);
  const cleanRoomReport: WorkspaceHostCleanRoomAcceptanceReport = {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    fixtureId: cleanSpec.fixtureId,
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
    attestation: workspaceHostCleanRoomFixtureAttestation(fixture, cleanSpec.observedAt),
  };
  return {
    releaseGate: {
      artifact: candidate,
      trustReport: trustReport(),
      compatibilityRequest: {
        action: 'install',
        provider: 'gcp',
        architecture: 'x86_64',
        ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
        observedAt: cleanSpec.observedAt,
      },
      cleanRoomReport,
    },
    projectId: PROJECT,
    family: FAMILY,
    publishedAt: PUBLISHED_AT,
    previousVersion: PREVIOUS,
    retireVersions: [OLDER],
    cleanRoom: {
      zone: ZONE,
      serviceAccountEmail: `workspace-host@${PROJECT}.iam.gserviceaccount.com`,
      subnetwork: `projects/${PROJECT}/regions/us-central1/subnetworks/clean-room`,
    },
  };
}

function inspection(
  imageId: string,
  options: { family?: string; sourceCandidateImageId?: string; state?: GcpImageInspection['state'] } = {},
): GcpImageInspection {
  return {
    imageId,
    ...(options.family ? { family: options.family } : {}),
    state: options.state ?? 'ACTIVE',
    architecture: 'x86_64',
    buildManifestIdentity: artifact().buildManifest.manifestIdentity,
    releaseVersion: VERSION,
    releaseSha256: RELEASE_SHA,
    guestTools: GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS.map((name) => ({ name, version: '1' })),
    ...(options.sourceCandidateImageId ? { sourceCandidateImageId: options.sourceCandidateImageId } : {}),
  };
}

class FakeAdapter implements GcpImageFamilyReleaseAdapter {
  readonly calls: string[] = [];
  readonly inspections = new Map<string, GcpImageInspection>();
  readonly pins = new Map<string, GcpImageFamilyPin>();
  activePin: GcpImageFamilyPin = PREVIOUS;
  badMigration = false;
  badScan = false;

  constructor() {
    for (const pin of [PREVIOUS, OLDER]) {
      this.pins.set(pin.imageId, pin);
      this.inspections.set(pin.imageId, inspection(pin.imageId, { family: FAMILY }));
    }
  }

  async buildCandidate(input: Parameters<GcpImageFamilyReleaseAdapter['buildCandidate']>[0]) {
    this.calls.push('build-candidate');
    expect(input.candidateImageName).toBe(`${IMAGE_NAME}-candidate`);
    expect(input.requiredGuestTools).toEqual(GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS);
    this.inspections.set(CANDIDATE_ID, inspection(CANDIDATE_ID));
    return { imageId: CANDIDATE_ID };
  }

  async scanImage(input: Parameters<GcpImageFamilyReleaseAdapter['scanImage']>[0]): Promise<GcpImageScanEvidence> {
    this.calls.push('scan-candidate');
    return {
      imageId: input.imageId,
      buildManifestIdentity: input.buildManifestIdentity,
      releaseSha256: input.releaseSha256,
      trusted: !this.badScan,
      sbomSha256: SBOM_SHA,
      vulnerabilityFindings: 0,
      secretFindings: 0,
      evidenceRef: `gcp://scan/${input.imageId}`,
    };
  }

  async inspectImage(_projectId: string, imageId: string): Promise<GcpImageInspection> {
    this.calls.push(`inspect:${imageId}`);
    const result = this.inspections.get(imageId);
    if (!result) throw new Error(`missing fake inspection ${imageId}`);
    return result;
  }

  async launchCleanRoomCanary(
    input: Parameters<GcpImageFamilyReleaseAdapter['launchCleanRoomCanary']>[0],
  ): Promise<GcpImageCleanBootProof> {
    this.calls.push('clean-room-canary');
    const attestation = request().releaseGate.cleanRoomReport.attestation!;
    return {
      evidenceRef: `gcp://${input.projectId}/${input.zone}/clean-room`,
      projectId: input.projectId,
      zone: input.zone,
      imageId: input.imageId,
      buildManifestIdentity: input.buildManifestIdentity,
      computeRunning: true,
      osLoginReady: true,
      publicIpv4Assigned: false,
      attestation: this.badMigration
        ? { ...attestation, migration: { id: 'wrong-migration', applied: true } }
        : attestation,
      terminated: true,
      residualResourceIds: [],
      observedAt: '2026-08-23T01:30:00.000Z',
    };
  }

  async publishFamilyVersion(
    input: Parameters<GcpImageFamilyReleaseAdapter['publishFamilyVersion']>[0],
  ): Promise<GcpImageFamilyPin & { sourceCandidateImageId: string }> {
    this.calls.push('publish-family-version');
    const pin = { projectId: input.projectId, family: input.family, imageId: IMAGE_ID, version: VERSION };
    this.pins.set(pin.imageId, pin);
    this.inspections.set(
      pin.imageId,
      inspection(pin.imageId, { family: input.family, sourceCandidateImageId: input.sourceCandidateImageId }),
    );
    this.activePin = pin;
    return { ...pin, sourceCandidateImageId: input.sourceCandidateImageId };
  }

  async resolveFamily() {
    this.calls.push('resolve-family');
    return this.activePin;
  }

  async deprecateImage(input: Parameters<GcpImageFamilyReleaseAdapter['deprecateImage']>[0]) {
    this.calls.push(`deprecate:${input.imageId}->${input.replacementImageId}`);
    const current = this.inspections.get(input.imageId);
    if (current) this.inspections.set(input.imageId, { ...current, state: 'DEPRECATED' });
    if (this.activePin.imageId === input.imageId) {
      const replacement = this.pins.get(input.replacementImageId);
      if (!replacement) throw new Error(`missing replacement pin ${input.replacementImageId}`);
      this.activePin = replacement;
    }
  }
}

describe('GCP workspace-host image family release', () => {
  it('scans and boots outside the family, promotes only the green exact image, and preserves one active rollback target', async () => {
    const adapter = new FakeAdapter();
    const result = await executeGcpImageFamilyRelease(request(), adapter);

    expect(result.releaseGate.accepted).toBe(true);
    expect(result.candidateImageId).toBe(CANDIDATE_ID);
    expect(result.active).toEqual({ projectId: PROJECT, family: FAMILY, imageId: IMAGE_ID, version: VERSION });
    expect(result.rollbackTarget).toEqual(PREVIOUS);
    expect(result.retired).toEqual([OLDER]);
    expect(adapter.calls).toEqual([
      'build-candidate',
      'scan-candidate',
      `inspect:${CANDIDATE_ID}`,
      'clean-room-canary',
      'publish-family-version',
      `inspect:${IMAGE_ID}`,
      'resolve-family',
      `inspect:${OLDER.imageId}`,
      `deprecate:${OLDER.imageId}->${IMAGE_ID}`,
    ]);
    expect(adapter.inspections.get(CANDIDATE_ID)?.family).toBeUndefined();
    expect(adapter.inspections.get(PREVIOUS.imageId)?.state).toBe('ACTIVE');
    expect(adapter.inspections.get(OLDER.imageId)?.state).toBe('DEPRECATED');
  });

  it('fails closed before family publication when scan or exact migration evidence is not green', async () => {
    const badScan = new FakeAdapter();
    badScan.badScan = true;
    await expect(executeGcpImageFamilyRelease(request(), badScan)).rejects.toThrow(
      'scan must be trusted with zero policy-violating',
    );
    expect(badScan.calls).not.toContain('publish-family-version');

    const badMigration = new FakeAdapter();
    badMigration.badMigration = true;
    await expect(executeGcpImageFamilyRelease(request(), badMigration)).rejects.toThrow(
      'attestation must prove the exact signed release, migration, and healthy service',
    );
    expect(badMigration.calls).not.toContain('publish-family-version');
  });

  it('rolls back by deprecating only the current member and resolving the still-active predecessor', async () => {
    const adapter = new FakeAdapter();
    const current = { projectId: PROJECT, family: FAMILY, imageId: IMAGE_ID, version: VERSION };
    adapter.pins.set(current.imageId, current);
    adapter.inspections.set(current.imageId, inspection(current.imageId, { family: FAMILY }));
    adapter.activePin = current;

    const result = await rollbackGcpImageFamily(
      { projectId: PROJECT, family: FAMILY, current, rollbackTarget: PREVIOUS },
      adapter,
    );

    expect(result).toEqual({ active: PREVIOUS, deprecated: current });
    expect(adapter.inspections.get(current.imageId)?.state).toBe('DEPRECATED');
    expect(adapter.inspections.get(PREVIOUS.imageId)?.state).toBe('ACTIVE');
    expect(adapter.calls.at(-2)).toBe(`deprecate:${current.imageId}->${PREVIOUS.imageId}`);
    expect(adapter.calls.at(-1)).toBe('resolve-family');
  });

  it('rejects mutable family aliases wherever an immutable image id is required', () => {
    expect(assertGcpImmutableImageId(IMAGE_ID)).toBe(IMAGE_ID);
    expect(() =>
      assertGcpImmutableImageId(`projects/${PROJECT}/global/images/family/${FAMILY}`, 'desired.image.id'),
    ).toThrow('family aliases are forbidden');
  });
});
