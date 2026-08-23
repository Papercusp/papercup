import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_TRUST_EVIDENCE_ORDER,
  ArtifactTrustError,
  assertArtifactTrusted,
  evaluateArtifactTrust,
  type ArtifactTrustAdapters,
  type ArtifactTrustPolicy,
  type ArtifactTrustSubject,
  type ProvenanceAttestationEvidence,
  type SbomEvidence,
  type SecretScanEvidence,
  type SignatureEvidence,
  type VulnerabilityEvidence,
} from './artifact-trust';

const ARTIFACT_SHA = 'a'.repeat(64);
const SBOM_SHA = 'b'.repeat(64);
const ATTESTATION_SHA = 'c'.repeat(64);
const NOW = Date.parse('2026-08-22T20:00:00.000Z');

const subject: ArtifactTrustSubject = {
  path: '/release/papercusp.AppImage',
  name: 'papercusp.AppImage',
  bytes: 1_024,
  sha256: ARTIFACT_SHA,
  signed: true,
};

const policy = {
  denyVulnerabilitiesAtOrAbove: 'high',
  maxSecretFindings: 0,
  maxAttestationAgeMs: 60 * 60 * 1_000,
} satisfies ArtifactTrustPolicy;

function signatureEvidence(): SignatureEvidence {
  return {
    kind: 'signature',
    subjectSha256: ARTIFACT_SHA,
    tool: { name: 'minisign', version: '0.12' },
    valid: true,
    signer: 'release-key-1',
  };
}

function sbomEvidence(): SbomEvidence {
  return {
    kind: 'sbom',
    subjectSha256: ARTIFACT_SHA,
    tool: { name: 'syft', version: '1.30.0' },
    format: 'cyclonedx-json',
    documentSha256: SBOM_SHA,
    componentCount: 42,
  };
}

function vulnerabilityEvidence(): VulnerabilityEvidence {
  return {
    kind: 'vulnerability-scan',
    subjectSha256: ARTIFACT_SHA,
    tool: { name: 'grype', version: '0.99.1' },
    sbomSha256: SBOM_SHA,
    findings: [],
  };
}

function secretEvidence(): SecretScanEvidence {
  return {
    kind: 'secret-scan',
    subjectSha256: ARTIFACT_SHA,
    tool: { name: 'gitleaks', version: '8.28.0' },
    findings: [],
  };
}

function attestationEvidence(): ProvenanceAttestationEvidence {
  return {
    kind: 'provenance-attestation',
    subjectSha256: ARTIFACT_SHA,
    tool: { name: 'cosign', version: '2.5.3' },
    valid: true,
    predicateType: 'https://slsa.dev/provenance/v1',
    issuedAt: new Date(NOW - 1_000).toISOString(),
    attestationSha256: ATTESTATION_SHA,
  };
}

function adapters(calls: string[] = [], overrides: Partial<ArtifactTrustAdapters> = {}): ArtifactTrustAdapters {
  return {
    verifySignature: async (artifact) => {
      calls.push('signature');
      return overrides.verifySignature?.(artifact) ?? signatureEvidence();
    },
    generateSbom: async (artifact) => {
      calls.push('sbom');
      return overrides.generateSbom?.(artifact) ?? sbomEvidence();
    },
    scanVulnerabilities: async (artifact, sbom) => {
      calls.push('vulnerability-scan');
      return overrides.scanVulnerabilities?.(artifact, sbom) ?? vulnerabilityEvidence();
    },
    scanSecrets: async (artifact) => {
      calls.push('secret-scan');
      return overrides.scanSecrets?.(artifact) ?? secretEvidence();
    },
    verifyProvenance: async (artifact) => {
      calls.push('provenance-attestation');
      return overrides.verifyProvenance?.(artifact) ?? attestationEvidence();
    },
  };
}

async function evaluate(customAdapters: ArtifactTrustAdapters = adapters()) {
  return evaluateArtifactTrust(subject, customAdapters, policy, { now: () => NOW });
}

describe('evaluateArtifactTrust', () => {
  it('binds deterministic evidence from every tool to one handoff artifact', async () => {
    const calls: string[] = [];

    const report = await evaluate(adapters(calls));

    expect(report.trusted).toBe(true);
    expect(report.failures).toEqual([]);
    expect(calls).toEqual(ARTIFACT_TRUST_EVIDENCE_ORDER);
    expect(report.evidence.map((item) => item.kind)).toEqual(ARTIFACT_TRUST_EVIDENCE_ORDER);
    expect(report.evidence.every((item) => item.subjectSha256 === ARTIFACT_SHA)).toBe(true);
    expect(report.evidence.map((item) => item.tool)).toEqual([
      { name: 'minisign', version: '0.12' },
      { name: 'syft', version: '1.30.0' },
      { name: 'grype', version: '0.99.1' },
      { name: 'gitleaks', version: '8.28.0' },
      { name: 'cosign', version: '2.5.3' },
    ]);
    expect(() => assertArtifactTrusted(report)).not.toThrow();
  });

  it.each([
    ['missing', ''],
    ['mismatched', 'd'.repeat(64)],
  ])('rejects %s evidence subject hashes', async (_label, subjectSha256) => {
    const report = await evaluate(
      adapters([], {
        scanSecrets: async () => ({ ...secretEvidence(), subjectSha256 }),
      }),
    );

    expect(report.trusted).toBe(false);
    expect(report.failures).toContainEqual(
      expect.objectContaining({ stage: 'secret-scan', code: 'evidence-subject-mismatch' }),
    );
  });

  it('rejects an invalid signature and exposes a throwing assertion', async () => {
    const report = await evaluate(
      adapters([], {
        verifySignature: async () => ({ ...signatureEvidence(), valid: false }),
      }),
    );

    expect(report.failures).toContainEqual(expect.objectContaining({ code: 'signature-invalid' }));
    expect(() => assertArtifactTrusted(report)).toThrow(ArtifactTrustError);
  });

  it('rejects absent SBOM evidence and does not scan a different implicit document', async () => {
    const calls: string[] = [];
    const report = await evaluate(
      adapters(calls, {
        generateSbom: async () => null,
      }),
    );

    expect(report.trusted).toBe(false);
    expect(report.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'sbom', code: 'missing-evidence' }),
        expect.objectContaining({ stage: 'vulnerability-scan', code: 'missing-evidence' }),
      ]),
    );
    expect(calls).toEqual(['signature', 'sbom', 'secret-scan', 'provenance-attestation']);
  });

  it('rejects a vulnerability at the configured severity threshold', async () => {
    const report = await evaluate(
      adapters([], {
        scanVulnerabilities: async () => ({
          ...vulnerabilityEvidence(),
          findings: [{ id: 'CVE-2026-1000', severity: 'high' }],
        }),
      }),
    );

    expect(report.failures).toContainEqual(expect.objectContaining({ code: 'vulnerability-threshold' }));
  });

  it('rejects secret findings over the configured maximum', async () => {
    const report = await evaluate(
      adapters([], {
        scanSecrets: async () => ({
          ...secretEvidence(),
          findings: [{ ruleId: 'cloud-api-key', location: 'payload:12' }],
        }),
      }),
    );

    expect(report.failures).toContainEqual(expect.objectContaining({ code: 'secret-threshold' }));
  });

  it.each([
    ['malformed', 'not-a-time', 'malformed-evidence'],
    ['stale', new Date(NOW - policy.maxAttestationAgeMs - 1).toISOString(), 'attestation-stale'],
  ])('rejects a %s provenance attestation', async (_label, issuedAt, code) => {
    const report = await evaluate(
      adapters([], {
        verifyProvenance: async () => ({ ...attestationEvidence(), issuedAt }),
      }),
    );

    expect(report.failures).toContainEqual(expect.objectContaining({ stage: 'provenance-attestation', code }));
  });

  it('fails closed when a tool adapter throws', async () => {
    const report = await evaluate(
      adapters([], {
        scanSecrets: async () => {
          throw new Error('scanner unavailable');
        },
      }),
    );

    expect(report.trusted).toBe(false);
    expect(report.failures).toContainEqual(
      expect.objectContaining({
        stage: 'secret-scan',
        code: 'adapter-error',
        message: expect.stringContaining('scanner unavailable'),
      }),
    );
  });
});
