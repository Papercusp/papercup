import type { WorkspaceHostBootstrapAttestation, WorkspaceHostImageArtifact } from '@papercusp/deployment-driver';

import {
  evaluateWorkspaceHostReleaseGate,
  type WorkspaceHostReleaseGateInput,
  type WorkspaceHostReleaseGateVerdict,
} from './workspace-host-release-gate';

export const GCP_IMAGE_FAMILY_RELEASE_CONTRACT_VERSION = 'papercusp-gcp-image-family-release-v1';

/** Guest capabilities that must survive the provider-specific image build. */
export const GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS = [
  'acl',
  'ca-certificates',
  'curl',
  'google-guest-agent',
  'jq',
  'minisign',
  'openssh-server',
  'ufw',
  'unattended-upgrades',
] as const;

export interface GcpImmutableImageCoordinates {
  projectId: string;
  imageName: string;
  imageId: string;
}

export interface GcpImageFamilyPin {
  projectId: string;
  family: string;
  imageId: string;
  version: string;
}

export interface GcpImageScanEvidence {
  imageId: string;
  buildManifestIdentity: string;
  releaseSha256: string;
  trusted: boolean;
  sbomSha256: string;
  vulnerabilityFindings: number;
  secretFindings: number;
  evidenceRef: string;
}

export interface GcpImageInspection {
  imageId: string;
  family?: string;
  state: 'ACTIVE' | 'DEPRECATED' | 'OBSOLETE' | 'DELETED';
  architecture: string;
  buildManifestIdentity: string;
  releaseVersion: string;
  releaseSha256: string;
  guestTools: readonly { name: string; version: string }[];
  /** The quarantined candidate from which the family member was published. */
  sourceCandidateImageId?: string;
}

export interface GcpImageCleanBootProof {
  evidenceRef: string;
  projectId: string;
  zone: string;
  imageId: string;
  buildManifestIdentity: string;
  computeRunning: boolean;
  osLoginReady: boolean;
  publicIpv4Assigned: boolean;
  attestation: WorkspaceHostBootstrapAttestation;
  terminated: boolean;
  residualResourceIds: readonly string[];
  observedAt: string;
}

export interface GcpImageFamilyReleaseRequest {
  releaseGate: WorkspaceHostReleaseGateInput;
  projectId: string;
  family: string;
  publishedAt: string;
  previousVersion?: GcpImageFamilyPin;
  /** Older family members to deprecate after promotion. The immediate rollback target is forbidden here. */
  retireVersions?: readonly GcpImageFamilyPin[];
  cleanRoom: {
    zone: string;
    serviceAccountEmail: string;
    subnetwork: string;
  };
}

export interface GcpImageFamilyReleaseAdapter {
  /** Build outside the production family so a candidate cannot be selected before it is green. */
  buildCandidate(input: {
    projectId: string;
    candidateImageName: string;
    templatePath: string;
    buildManifestIdentity: string;
    releaseVersion: string;
    releaseSha256: string;
    architecture: string;
    requiredGuestTools: readonly string[];
  }): Promise<{ imageId: string }>;
  scanImage(input: {
    projectId: string;
    imageId: string;
    buildManifestIdentity: string;
    releaseSha256: string;
  }): Promise<GcpImageScanEvidence>;
  inspectImage(projectId: string, imageId: string): Promise<GcpImageInspection>;
  launchCleanRoomCanary(input: {
    projectId: string;
    zone: string;
    serviceAccountEmail: string;
    subnetwork: string;
    imageId: string;
    buildManifestIdentity: string;
    releaseVersion: string;
    releaseSha256: string;
  }): Promise<GcpImageCleanBootProof>;
  /** Publish the already-green candidate as a new immutable member of the production family. */
  publishFamilyVersion(input: {
    projectId: string;
    family: string;
    imageName: string;
    sourceCandidateImageId: string;
    buildManifestIdentity: string;
    releaseVersion: string;
    releaseSha256: string;
  }): Promise<GcpImageFamilyPin & { sourceCandidateImageId: string }>;
  resolveFamily(projectId: string, family: string): Promise<GcpImageFamilyPin>;
  /** GCP deprecation keeps exact image references bootable; this contract intentionally has no delete operation. */
  deprecateImage(input: {
    projectId: string;
    imageId: string;
    replacementImageId: string;
    state: 'DEPRECATED';
  }): Promise<void>;
}

export interface GcpImageFamilyReleaseResult {
  contractVersion: typeof GCP_IMAGE_FAMILY_RELEASE_CONTRACT_VERSION;
  releaseGate: WorkspaceHostReleaseGateVerdict;
  candidateImageId: string;
  scan: GcpImageScanEvidence;
  cleanBootProof: GcpImageCleanBootProof;
  active: GcpImageFamilyPin;
  rollbackTarget?: GcpImageFamilyPin;
  retired: readonly GcpImageFamilyPin[];
}

export interface GcpImageFamilyRollbackRequest {
  projectId: string;
  family: string;
  current: GcpImageFamilyPin;
  rollbackTarget: GcpImageFamilyPin;
}

export interface GcpImageFamilyRollbackResult {
  active: GcpImageFamilyPin;
  deprecated: GcpImageFamilyPin;
}

export class GcpImageFamilyReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GcpImageFamilyReleaseError';
  }
}

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const RESOURCE_NAME = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const IMMUTABLE_IMAGE_ID = /^projects\/([^/]+)\/global\/images\/([^/]+)$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(message: string): never {
  throw new GcpImageFamilyReleaseError(message);
}

function requireText(value: string, path: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${path} must be a non-empty string`);
  return value.trim();
}

function requireProjectId(value: string, path: string): string {
  const projectId = requireText(value, path);
  if (!PROJECT_ID.test(projectId)) fail(`${path} must be a GCP project id`);
  return projectId;
}

function requireResourceName(value: string, path: string): string {
  const name = requireText(value, path);
  if (!RESOURCE_NAME.test(name)) fail(`${path} must be a GCP resource name`);
  return name;
}

function requireTimestamp(value: string, path: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${path} must be an ISO timestamp`);
  return parsed;
}

/** Parse and normalize the only image reference accepted by workspace operations. */
export function parseGcpImmutableImageId(value: string, path = 'imageId'): GcpImmutableImageCoordinates {
  const imageId = requireText(value, path);
  const match = imageId.match(IMMUTABLE_IMAGE_ID);
  if (!match) {
    fail(
      `${path} must be an immutable projects/{project}/global/images/{name} reference; family aliases are forbidden`,
    );
  }
  const projectId = requireProjectId(match[1], `${path}.project`);
  const imageName = requireResourceName(match[2], `${path}.name`);
  return { projectId, imageName, imageId: `projects/${projectId}/global/images/${imageName}` };
}

export function assertGcpImmutableImageId(value: string, path = 'imageId'): string {
  return parseGcpImmutableImageId(value, path).imageId;
}

function normalizePin(pin: GcpImageFamilyPin, path: string, projectId: string, family: string): GcpImageFamilyPin {
  const pinProject = requireProjectId(pin.projectId, `${path}.projectId`);
  const pinFamily = requireResourceName(pin.family, `${path}.family`);
  const image = parseGcpImmutableImageId(pin.imageId, `${path}.imageId`);
  const version = requireText(pin.version, `${path}.version`);
  if (pinProject !== projectId || image.projectId !== projectId || pinFamily !== family) {
    fail(`${path} must belong to ${projectId}/${family}`);
  }
  return { projectId, family, imageId: image.imageId, version };
}

function candidateName(imageName: string): string {
  const prefix = imageName.slice(0, 53).replace(/-+$/g, '') || 'image';
  return `${prefix}-candidate`;
}

function validateScan(scan: GcpImageScanEvidence, artifact: WorkspaceHostImageArtifact, imageId: string): void {
  if (
    scan.imageId !== imageId ||
    scan.buildManifestIdentity !== artifact.buildManifest.manifestIdentity ||
    scan.releaseSha256 !== artifact.release.bundleSha256
  ) {
    fail('GCP image scan is not bound to the exact candidate, build manifest, and release digest');
  }
  if (!scan.trusted || scan.vulnerabilityFindings !== 0 || scan.secretFindings !== 0) {
    fail('GCP image scan must be trusted with zero policy-violating vulnerability and secret findings');
  }
  if (!SHA256.test(scan.sbomSha256) || !scan.evidenceRef.trim()) {
    fail('GCP image scan must carry an immutable SBOM digest and evidence reference');
  }
}

function validateInspection(
  inspection: GcpImageInspection,
  artifact: WorkspaceHostImageArtifact,
  expectedImageId: string,
  expectedFamily: string | undefined,
  sourceCandidateImageId?: string,
): void {
  if (
    inspection.imageId !== expectedImageId ||
    inspection.state !== 'ACTIVE' ||
    inspection.architecture !== artifact.buildManifest.baseImage.architecture ||
    inspection.buildManifestIdentity !== artifact.buildManifest.manifestIdentity ||
    inspection.releaseVersion !== artifact.image.version ||
    inspection.releaseSha256 !== artifact.release.bundleSha256
  ) {
    fail(`${expectedImageId} is not an active image bound to the canonical build and release`);
  }
  if (inspection.family !== expectedFamily) {
    fail(
      expectedFamily
        ? `${expectedImageId} is not an active member of family ${expectedFamily}`
        : `${expectedImageId} candidate must not be discoverable through an image family`,
    );
  }
  if (sourceCandidateImageId && inspection.sourceCandidateImageId !== sourceCandidateImageId) {
    fail(`${expectedImageId} is not derived from the green candidate ${sourceCandidateImageId}`);
  }
  const installed = new Map(inspection.guestTools.map((tool) => [tool.name, tool.version]));
  for (const tool of GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS) {
    if (!installed.get(tool)?.trim()) fail(`${expectedImageId} is missing guest tool ${tool}`);
  }
}

function validateCleanBootProof(
  proof: GcpImageCleanBootProof,
  request: GcpImageFamilyReleaseRequest,
  artifact: WorkspaceHostImageArtifact,
  candidateImageId: string,
): void {
  const expectedAttestation = request.releaseGate.cleanRoomReport.attestation;
  if (
    proof.projectId !== request.projectId ||
    proof.zone !== request.cleanRoom.zone ||
    proof.imageId !== candidateImageId ||
    proof.buildManifestIdentity !== artifact.buildManifest.manifestIdentity
  ) {
    fail('GCP clean-room boot proof is not bound to the exact project, zone, candidate, and manifest');
  }
  if (
    !proof.computeRunning ||
    !proof.osLoginReady ||
    proof.publicIpv4Assigned ||
    !proof.terminated ||
    proof.residualResourceIds.length > 0 ||
    !proof.evidenceRef.trim()
  ) {
    fail('GCP clean-room boot must prove private boot, OS Login, confirmed teardown, and zero residue');
  }
  if (
    !expectedAttestation ||
    proof.attestation.status !== 'healthy' ||
    !proof.attestation.release.signatureVerified ||
    proof.attestation.release.version !== artifact.image.version ||
    proof.attestation.release.bundleSha256 !== artifact.release.bundleSha256 ||
    proof.attestation.migration.applied !== true ||
    proof.attestation.migration.id !== expectedAttestation.migration.id ||
    proof.attestation.service.active !== true
  ) {
    fail('GCP clean-room attestation must prove the exact signed release, migration, and healthy service');
  }
  requireTimestamp(proof.observedAt, 'cleanBootProof.observedAt');
}

function samePin(left: GcpImageFamilyPin, right: GcpImageFamilyPin): boolean {
  return (
    left.projectId === right.projectId &&
    left.family === right.family &&
    left.imageId === right.imageId &&
    left.version === right.version
  );
}

function validateResolvedPin(
  resolved: GcpImageFamilyPin,
  expected: GcpImageFamilyPin,
  projectId: string,
  family: string,
): GcpImageFamilyPin {
  const normalized = normalizePin(resolved, 'resolvedFamily', projectId, family);
  if (!samePin(normalized, expected)) {
    fail(`GCP family ${projectId}/${family} did not resolve to the expected immutable image ${expected.imageId}`);
  }
  return normalized;
}

/**
 * Build and test a quarantined candidate, then make it family-discoverable.
 * The irreversible family mutation is deliberately after scan, inspection,
 * exact boot attestation, migration proof, and teardown.
 */
export async function executeGcpImageFamilyRelease(
  request: GcpImageFamilyReleaseRequest,
  adapter: GcpImageFamilyReleaseAdapter,
): Promise<GcpImageFamilyReleaseResult> {
  const gate = evaluateWorkspaceHostReleaseGate(request.releaseGate);
  if (!gate.accepted) {
    fail(`workspace-host release gate rejected: ${gate.failures.map((item) => item.message).join('; ')}`);
  }
  if (request.releaseGate.compatibilityRequest.provider !== 'gcp') {
    fail('GCP image-family publication requires a GCP compatibility verdict');
  }

  const projectId = requireProjectId(request.projectId, 'projectId');
  const family = requireResourceName(request.family, 'family');
  requireTimestamp(request.publishedAt, 'publishedAt');
  const artifact = request.releaseGate.artifact;
  if (artifact.lifecycle.state !== 'active' || artifact.lifecycle.publishedAt !== request.publishedAt) {
    fail('GCP image-family publication requires an active artifact whose publishedAt matches the request');
  }
  const artifactImage = parseGcpImmutableImageId(artifact.image.id, 'releaseGate.artifact.image.id');
  if (artifactImage.projectId !== projectId) fail('artifact image project must match projectId');
  const gcpTarget = artifact.buildManifest.targets.find((target) => target.provider === 'gcp');
  if (!gcpTarget) fail('canonical build manifest does not contain a GCP target');
  if (gcpTarget.locations.length > 0 && !gcpTarget.locations.includes(projectId)) {
    fail(`GCP project ${projectId} is absent from the canonical build manifest`);
  }

  const previous = request.previousVersion
    ? normalizePin(request.previousVersion, 'previousVersion', projectId, family)
    : undefined;
  if (previous?.imageId === artifactImage.imageId) fail('previousVersion must differ from the candidate version');
  const retired = (request.retireVersions ?? []).map((pin, index) =>
    normalizePin(pin, `retireVersions[${index}]`, projectId, family),
  );
  if (new Set(retired.map((pin) => pin.imageId)).size !== retired.length) {
    fail('retireVersions must not contain duplicate image ids');
  }
  if (retired.some((pin) => pin.imageId === artifactImage.imageId || pin.imageId === previous?.imageId)) {
    fail('retireVersions cannot include the new active image or its immediate rollback target');
  }

  const built = await adapter.buildCandidate({
    projectId,
    candidateImageName: candidateName(artifactImage.imageName),
    templatePath: artifact.buildManifest.builder.templatePath,
    buildManifestIdentity: artifact.buildManifest.manifestIdentity,
    releaseVersion: artifact.image.version,
    releaseSha256: artifact.release.bundleSha256,
    architecture: artifact.buildManifest.baseImage.architecture,
    requiredGuestTools: GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS,
  });
  const candidate = parseGcpImmutableImageId(built.imageId, 'buildCandidate.imageId');
  if (candidate.projectId !== projectId || candidate.imageId === artifactImage.imageId) {
    fail('buildCandidate must return a distinct immutable image in the publication project');
  }
  const scan = await adapter.scanImage({
    projectId,
    imageId: candidate.imageId,
    buildManifestIdentity: artifact.buildManifest.manifestIdentity,
    releaseSha256: artifact.release.bundleSha256,
  });
  validateScan(scan, artifact, candidate.imageId);
  validateInspection(await adapter.inspectImage(projectId, candidate.imageId), artifact, candidate.imageId, undefined);

  const cleanBootProof = await adapter.launchCleanRoomCanary({
    projectId,
    ...request.cleanRoom,
    imageId: candidate.imageId,
    buildManifestIdentity: artifact.buildManifest.manifestIdentity,
    releaseVersion: artifact.image.version,
    releaseSha256: artifact.release.bundleSha256,
  });
  validateCleanBootProof(cleanBootProof, request, artifact, candidate.imageId);

  const published = await adapter.publishFamilyVersion({
    projectId,
    family,
    imageName: artifactImage.imageName,
    sourceCandidateImageId: candidate.imageId,
    buildManifestIdentity: artifact.buildManifest.manifestIdentity,
    releaseVersion: artifact.image.version,
    releaseSha256: artifact.release.bundleSha256,
  });
  const active = normalizePin(published, 'publishFamilyVersion', projectId, family);
  if (
    active.imageId !== artifactImage.imageId ||
    active.version !== artifact.image.version ||
    published.sourceCandidateImageId !== candidate.imageId
  ) {
    fail('published family receipt is not bound to the exact artifact and green candidate');
  }
  validateInspection(
    await adapter.inspectImage(projectId, active.imageId),
    artifact,
    active.imageId,
    family,
    candidate.imageId,
  );
  validateResolvedPin(await adapter.resolveFamily(projectId, family), active, projectId, family);

  for (const pin of retired) {
    const inspection = await adapter.inspectImage(projectId, pin.imageId);
    if (inspection.imageId !== pin.imageId || inspection.family !== family || inspection.state !== 'ACTIVE') {
      fail(`retireVersions image ${pin.imageId} is not an active member of family ${family}`);
    }
    await adapter.deprecateImage({
      projectId,
      imageId: pin.imageId,
      replacementImageId: active.imageId,
      state: 'DEPRECATED',
    });
  }

  return {
    contractVersion: GCP_IMAGE_FAMILY_RELEASE_CONTRACT_VERSION,
    releaseGate: gate,
    candidateImageId: candidate.imageId,
    scan,
    cleanBootProof,
    active,
    ...(previous ? { rollbackTarget: previous } : {}),
    retired,
  };
}

/**
 * Roll back a family without mutating the previous image. GCP deprecation is
 * irreversible, so the target must still be ACTIVE; deprecating the current
 * member makes the family resolve to that already-green predecessor while
 * exact references to the deprecated image continue to boot.
 */
export async function rollbackGcpImageFamily(
  request: GcpImageFamilyRollbackRequest,
  adapter: GcpImageFamilyReleaseAdapter,
): Promise<GcpImageFamilyRollbackResult> {
  const projectId = requireProjectId(request.projectId, 'projectId');
  const family = requireResourceName(request.family, 'family');
  const current = normalizePin(request.current, 'current', projectId, family);
  const rollbackTarget = normalizePin(request.rollbackTarget, 'rollbackTarget', projectId, family);
  if (current.imageId === rollbackTarget.imageId) fail('rollbackTarget must differ from current');

  validateResolvedPin(await adapter.resolveFamily(projectId, family), current, projectId, family);
  for (const [path, pin] of [
    ['current', current],
    ['rollbackTarget', rollbackTarget],
  ] as const) {
    const inspection = await adapter.inspectImage(projectId, pin.imageId);
    if (inspection.imageId !== pin.imageId || inspection.family !== family || inspection.state !== 'ACTIVE') {
      fail(`${path} must be an ACTIVE member of family ${family}`);
    }
  }
  await adapter.deprecateImage({
    projectId,
    imageId: current.imageId,
    replacementImageId: rollbackTarget.imageId,
    state: 'DEPRECATED',
  });
  const active = validateResolvedPin(await adapter.resolveFamily(projectId, family), rollbackTarget, projectId, family);
  return { active, deprecated: current };
}
