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
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';
import { describe, expect, it } from 'vitest';

import { ARTIFACT_TRUST_PIPELINE_VERSION, type ArtifactTrustReport } from './artifact-trust';
import {
  WORKSPACE_HOST_PUBLICATION_MANIFEST_KEYS,
  WORKSPACE_HOST_PUBLICATION_MANIFEST_VERSION,
  WorkspaceHostPublicationManifestError,
  buildWorkspaceHostPublicationManifest,
  serializeWorkspaceHostPublicationManifest,
  workspaceHostPublicationManifestFailures,
  type WorkspaceHostPublicationFailureCode,
  type WorkspaceHostPublicationManifestInput,
} from './publication-manifest';

const VERSION = '2026.8.22-1';
const RELEASE_DIGEST = 'a'.repeat(64);
const SIGNATURE_DIGEST = 'f'.repeat(64);
const SBOM_DIGEST = 'b'.repeat(64);
const ATTESTATION_DIGEST = 'd'.repeat(64);
const BUNDLE_BYTES = 42_000;
const SIGNATURE_BYTES = 512;

const SIGNING_PUBLIC_KEY = 'untrusted comment: Papercusp workspace-host release key\nRWQpublickey';
const SIGNING_KEY_DIGEST = createHash('sha256').update(SIGNING_PUBLIC_KEY, 'utf8').digest('hex');

/**
 * Assembled at runtime, never written as a literal: a contiguous PEM header in a tree file trips
 * the repo secrets guard and, worse, the pot-git publish guard, which then refuses every later
 * publish because its baseline cannot advance past a refused blob.
 */
const PEM_PRIVATE_KEY_HEADER = ['-----', 'BEGIN', ' OPENSSH ', 'PRIVATE', ' KEY', '-----'].join('');

function artifact(): WorkspaceHostImageArtifact {
  const buildManifest = buildWorkspaceHostBuildManifest({
    contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
    distributionProfile: 'vm-release',
    source: {
      repository: 'https://github.com/Papercusp/papercusp.git',
      revision: '1'.repeat(40),
    },
    releaseArtifact: {
      name: `papercusp-server-${VERSION}.tgz`,
      version: VERSION,
      sha256: RELEASE_DIGEST,
      sizeBytes: BUNDLE_BYTES,
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
      { path: 'dist/papercusp-server.tgz', sha256: RELEASE_DIGEST, sizeBytes: BUNDLE_BYTES },
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

  const canonical = deriveWorkspaceHostCanonicalArtifactUrls(RELEASE_DIGEST);
  return {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: { id: 'papercusp-workspace-host', version: VERSION },
    buildManifest,
    release: {
      version: VERSION,
      bundleUrl: canonical.bundleUrl,
      bundleSha256: RELEASE_DIGEST,
      signatureUrl: canonical.signatureUrl,
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

function trustReport(): ArtifactTrustReport {
  return {
    version: ARTIFACT_TRUST_PIPELINE_VERSION,
    subject: {
      path: `dist/papercusp-server-${VERSION}.tgz`,
      name: `papercusp-server-${VERSION}.tgz`,
      bytes: BUNDLE_BYTES,
      sha256: RELEASE_DIGEST,
      signed: true,
    },
    policy: {
      denyVulnerabilitiesAtOrAbove: 'high',
      maxSecretFindings: 0,
      maxAttestationAgeMs: 86_400_000,
    },
    trusted: true,
    evidence: [
      {
        kind: 'signature',
        subjectSha256: RELEASE_DIGEST,
        tool: { name: 'minisign', version: '0.11' },
        valid: true,
        signatureSha256: SIGNATURE_DIGEST,
        signingKeySha256: SIGNING_KEY_DIGEST,
      },
      {
        kind: 'sbom',
        subjectSha256: RELEASE_DIGEST,
        tool: { name: 'syft', version: '1.4.1' },
        format: 'spdx-json',
        documentSha256: SBOM_DIGEST,
        componentCount: 128,
      },
      {
        kind: 'vulnerability-scan',
        subjectSha256: RELEASE_DIGEST,
        tool: { name: 'grype', version: '0.79.0' },
        sbomSha256: SBOM_DIGEST,
        findings: [],
      },
      {
        kind: 'secret-scan',
        subjectSha256: RELEASE_DIGEST,
        tool: { name: 'gitleaks', version: '8.18.0' },
        findings: [],
      },
      {
        kind: 'provenance-attestation',
        subjectSha256: RELEASE_DIGEST,
        tool: { name: 'cosign', version: '2.2.4' },
        valid: true,
        predicateType: 'https://slsa.dev/provenance/v1',
        issuedAt: '2026-08-22T00:00:00Z',
        attestationSha256: ATTESTATION_DIGEST,
      },
    ],
    failures: [],
  };
}

function input(): WorkspaceHostPublicationManifestInput {
  return {
    artifact: artifact(),
    trustReport: trustReport(),
    bundle: { sha256: RELEASE_DIGEST, bytes: BUNDLE_BYTES },
    signature: { sha256: SIGNATURE_DIGEST, bytes: SIGNATURE_BYTES },
  };
}

function codes(
  candidate: WorkspaceHostPublicationManifestInput,
): WorkspaceHostPublicationFailureCode[] {
  return workspaceHostPublicationManifestFailures(candidate).map((failure) => failure.code);
}

describe('workspace-host publication manifest', () => {
  it('assembles the closed D-107 envelope from a complete, digest-bound release', () => {
    const manifest = buildWorkspaceHostPublicationManifest(input());

    expect(manifest.version).toBe(WORKSPACE_HOST_PUBLICATION_MANIFEST_VERSION);
    expect(manifest.objects.bundle).toEqual({
      name: 'server.tgz',
      sha256: RELEASE_DIGEST,
      bytes: BUNDLE_BYTES,
    });
    expect(manifest.objects.signature).toEqual({
      name: 'server.tgz.minisig',
      sha256: SIGNATURE_DIGEST,
      bytes: SIGNATURE_BYTES,
    });
    expect(manifest.trust.version).toBe(ARTIFACT_TRUST_PIPELINE_VERSION);
  });

  it('publishes exactly the closed key set, so widening the contract cannot pass unnoticed', () => {
    const manifest = buildWorkspaceHostPublicationManifest(input());
    const serialized = JSON.parse(serializeWorkspaceHostPublicationManifest(manifest)) as Record<
      string,
      unknown
    >;

    expect(Object.keys(serialized).sort()).toEqual(
      [...WORKSPACE_HOST_PUBLICATION_MANIFEST_KEYS].sort(),
    );
  });

  it('serializes deterministically: the same manifest always produces the same published bytes', () => {
    const first = serializeWorkspaceHostPublicationManifest(
      buildWorkspaceHostPublicationManifest(input()),
    );
    const second = serializeWorkspaceHostPublicationManifest(
      buildWorkspaceHostPublicationManifest(input()),
    );

    expect(second).toBe(first);
    // Key order is normalized rather than inherited from construction order.
    expect(first.indexOf('"artifact"')).toBeLessThan(first.indexOf('"version"'));
  });

  it('throws with every reason rather than returning a partially-valid manifest', () => {
    const broken = input();
    broken.bundle = { sha256: 'c'.repeat(64), bytes: BUNDLE_BYTES };

    expect(() => buildWorkspaceHostPublicationManifest(broken)).toThrow(
      WorkspaceHostPublicationManifestError,
    );
  });

  describe('rejects a bundle that is not immutably addressed', () => {
    it('fails on a fixture host that never resolves', () => {
      const candidate = input();
      candidate.artifact = {
        ...candidate.artifact,
        release: {
          ...candidate.artifact.release,
          bundleUrl: `https://releases.papercusp.com/server/${VERSION}.tgz`,
          signatureUrl: `https://releases.papercusp.com/server/${VERSION}.tgz.minisig`,
        },
      };

      expect(codes(candidate)).toContain('non-canonical-artifact-url');
    });

    it('fails on a mutable latest path', () => {
      const candidate = input();
      const origin = new URL(candidate.artifact.release.bundleUrl).origin;
      candidate.artifact = {
        ...candidate.artifact,
        release: {
          ...candidate.artifact.release,
          bundleUrl: `${origin}/artifacts/workspace-host/latest/server.tgz`,
          signatureUrl: `${origin}/artifacts/workspace-host/latest/server.tgz.minisig`,
        },
      };

      expect(codes(candidate)).toContain('non-canonical-artifact-url');
    });

    it('fails when the stored bundle is not the artifact the release pins', () => {
      const candidate = input();
      candidate.bundle = { sha256: '9'.repeat(64), bytes: BUNDLE_BYTES };

      expect(codes(candidate)).toContain('object-digest-mismatch');
    });

    it('fails on a malformed object descriptor instead of publishing it', () => {
      const candidate = input();
      candidate.signature = { sha256: 'not-a-digest', bytes: 0 };

      expect(codes(candidate)).toContain('invalid-object-descriptor');
    });
  });

  describe('rejects a trust report that does not vouch for this exact bundle', () => {
    it('fails when the trust subject is a different artifact', () => {
      const candidate = input();
      candidate.trustReport = {
        ...candidate.trustReport,
        subject: { ...candidate.trustReport.subject, sha256: '7'.repeat(64) },
      };

      expect(codes(candidate)).toContain('trust-subject-mismatch');
    });

    it('fails when the trust subject size disagrees with the stored bytes', () => {
      const candidate = input();
      candidate.trustReport = {
        ...candidate.trustReport,
        subject: { ...candidate.trustReport.subject, bytes: BUNDLE_BYTES + 1 },
      };

      expect(codes(candidate)).toContain('trust-subject-mismatch');
    });

    it('fails when an evidence class is missing', () => {
      const candidate = input();
      candidate.trustReport = {
        ...candidate.trustReport,
        evidence: candidate.trustReport.evidence.filter((entry) => entry.kind !== 'sbom'),
      };

      expect(codes(candidate)).toContain('missing-trust-evidence');
    });

    it('fails when evidence was gathered over a different artifact', () => {
      const candidate = input();
      candidate.trustReport = {
        ...candidate.trustReport,
        evidence: candidate.trustReport.evidence.map((entry) =>
          entry.kind === 'vulnerability-scan' ? { ...entry, subjectSha256: '8'.repeat(64) } : entry,
        ),
      };

      expect(codes(candidate)).toContain('evidence-subject-mismatch');
    });

    it('fails on an untrusted report even when every other field agrees', () => {
      const candidate = input();
      candidate.trustReport = { ...candidate.trustReport, trusted: false };

      expect(codes(candidate)).toContain('untrusted-release');
    });

    it('fails on an unsupported trust pipeline version', () => {
      const candidate = input();
      candidate.trustReport = {
        ...candidate.trustReport,
        version: 'artifact-trust-v2',
      } as unknown as ArtifactTrustReport;

      expect(codes(candidate)).toContain('unsupported-trust-version');
    });
  });

  describe('rejects a signature that is not bound to the published signature and key', () => {
    it('fails when the evidence verified a different detached signature', () => {
      const candidate = input();
      candidate.signature = { sha256: '3'.repeat(64), bytes: SIGNATURE_BYTES };

      expect(codes(candidate)).toContain('signature-binding-mismatch');
    });

    it('fails when the evidence verified under a key the release does not pin', () => {
      const candidate = input();
      candidate.trustReport = {
        ...candidate.trustReport,
        evidence: candidate.trustReport.evidence.map((entry) =>
          entry.kind === 'signature' ? { ...entry, signingKeySha256: '4'.repeat(64) } : entry,
        ),
      };

      expect(codes(candidate)).toContain('signature-binding-mismatch');
    });

    it('fails when the signature binding is absent entirely', () => {
      const candidate = input();
      candidate.trustReport = {
        ...candidate.trustReport,
        evidence: candidate.trustReport.evidence.map((entry) => {
          if (entry.kind !== 'signature') return entry;
          const { signatureSha256: _signature, signingKeySha256: _key, ...rest } = entry;
          return rest;
        }),
      };

      expect(codes(candidate)).toContain('signature-binding-mismatch');
    });

    it('fails when the signature is reported invalid', () => {
      const candidate = input();
      candidate.trustReport = {
        ...candidate.trustReport,
        evidence: candidate.trustReport.evidence.map((entry) =>
          entry.kind === 'signature' ? { ...entry, valid: false } : entry,
        ),
      };

      expect(codes(candidate)).toContain('signature-binding-mismatch');
    });
  });

  describe('rejects weak secret and provenance posture', () => {
    it('fails when the policy tolerates secret findings, even with zero found', () => {
      const candidate = input();
      candidate.trustReport = {
        ...candidate.trustReport,
        policy: { ...candidate.trustReport.policy, maxSecretFindings: 1 },
      };

      expect(codes(candidate)).toContain('secret-scan-policy');
    });

    it('fails when the secret scan reported a finding', () => {
      const candidate = input();
      candidate.trustReport = {
        ...candidate.trustReport,
        evidence: candidate.trustReport.evidence.map((entry) =>
          entry.kind === 'secret-scan'
            ? { ...entry, findings: [{ ruleId: 'aws-access-key' }] }
            : entry,
        ),
      };

      expect(codes(candidate)).toContain('secret-scan-policy');
    });

    it('fails on invalid provenance attestation evidence', () => {
      const candidate = input();
      candidate.trustReport = {
        ...candidate.trustReport,
        evidence: candidate.trustReport.evidence.map((entry) =>
          entry.kind === 'provenance-attestation' ? { ...entry, valid: false } : entry,
        ),
      };

      expect(codes(candidate)).toContain('provenance-invalid');
    });
  });

  describe('refuses to publish secret material in a world-readable document', () => {
    it('rejects private key material reaching the assembled envelope', () => {
      const candidate = input();
      candidate.artifact = {
        ...candidate.artifact,
        lifecycle: {
          ...candidate.artifact.lifecycle,
          notes: `${PEM_PRIVATE_KEY_HEADER}\nabc\n`,
        } as WorkspaceHostImageArtifact['lifecycle'],
      };

      expect(() => buildWorkspaceHostPublicationManifest(candidate)).toThrow(/[Ss]ecret material/);
    });

    it('still scans trust policy VALUES, so narrowing the key-name check there did not disable it', () => {
      const candidate = input();
      candidate.trustReport = {
        ...candidate.trustReport,
        policy: {
          ...candidate.trustReport.policy,
          denyVulnerabilitiesAtOrAbove: `${PEM_PRIVATE_KEY_HEADER}\nabc\n`,
        },
      } as unknown as ArtifactTrustReport;

      expect(() => buildWorkspaceHostPublicationManifest(candidate)).toThrow(/[Ss]ecret material/);
    });

    it('rejects a secret-shaped field even when its value looks harmless', () => {
      const candidate = input();
      candidate.artifact = {
        ...candidate.artifact,
        lifecycle: {
          ...candidate.artifact.lifecycle,
          privateKey: 'redacted',
        } as WorkspaceHostImageArtifact['lifecycle'],
      };

      expect(() => buildWorkspaceHostPublicationManifest(candidate)).toThrow(/forbidden/);
    });
  });

  it('delegates to the canonical image validator: a bundle without the executable remote initializer cannot publish', () => {
    const candidate = input();
    const stripped = buildWorkspaceHostBuildManifest({
      contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
      distributionProfile: 'vm-release',
      source: {
        repository: 'https://github.com/Papercusp/papercusp.git',
        revision: '1'.repeat(40),
      },
      releaseArtifact: {
        name: `papercusp-server-${VERSION}.tgz`,
        version: VERSION,
        sha256: RELEASE_DIGEST,
        sizeBytes: BUNDLE_BYTES,
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
      // The remote initializer material is absent: the image would install, report healthy, and
      // then fail every initialization at the far end.
      materials: [
        { path: 'dist/papercusp-server.tgz', sha256: RELEASE_DIGEST, sizeBytes: BUNDLE_BYTES },
      ],
      parameters: [{ name: 'distribution_profile', value: 'vm-release' }],
      targets: [{ provider: 'gcp', locations: ['us-central1'] }],
    });
    candidate.artifact = { ...candidate.artifact, buildManifest: stripped };

    expect(codes(candidate)).toContain('invalid-image-artifact');
  });
});
