import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
  WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
  WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
  WORKSPACE_HOST_SHARED_BUILDER_KIND,
  buildWorkspaceHostBuildManifest,
  deriveWorkspaceHostCanonicalArtifactUrls,
  workspaceHostRequiredReleaseMaterialFixtures,
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';
import tool, {
  probeByocPublication,
  publicationProbeInputFromJournal,
  evaluateByocReadiness,
  readByocReadiness,
  readByocReleaseSubject,
} from './byoc-readiness';
import { releaseStageInputHash } from '../../../../../scripts/lib/release-task-journal';
import type { TaskReleaseJournal } from '../../task-manager/store';
import { ARTIFACT_TRUST_PIPELINE_VERSION, type ArtifactTrustReport } from '../../workspace-host/artifact-trust';
import {
  buildWorkspaceHostPublicationManifest,
  serializeWorkspaceHostPublicationManifest,
} from '../../workspace-host/publication-manifest';
import type { ByocReleaseCarrySnapshot } from '../../byoc-release-carry';

const PUBLICATION_BUNDLE = new TextEncoder().encode('verified workspace-host bundle bytes');
const PUBLICATION_SIGNATURE = new TextEncoder().encode('verified detached signature bytes');
const PUBLICATION_BUNDLE_SHA256 = createHash('sha256').update(PUBLICATION_BUNDLE).digest('hex');
const PUBLICATION_SIGNATURE_SHA256 = createHash('sha256').update(PUBLICATION_SIGNATURE).digest('hex');
const PUBLICATION_VERSION = '2026.9.20-1';
const PUBLICATION_SIGNING_KEY = 'public signing key fixture';
const PUBLICATION_SIGNING_KEY_SHA256 = createHash('sha256').update(PUBLICATION_SIGNING_KEY).digest('hex');

function publicationArtifact(): WorkspaceHostImageArtifact {
  const buildManifest = buildWorkspaceHostBuildManifest({
    contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
    distributionProfile: 'vm-release',
    source: {
      repository: 'https://github.com/Papercusp/papercusp.git',
      revision: '1'.repeat(40),
    },
    releaseArtifact: {
      name: `papercusp-server-${PUBLICATION_VERSION}.tgz`,
      version: PUBLICATION_VERSION,
      sha256: PUBLICATION_BUNDLE_SHA256,
      sizeBytes: PUBLICATION_BUNDLE.byteLength,
    },
    baseImage: {
      reference: 'projects/papercusp-images-123/global/images/ubuntu-2404-minimal',
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
        sha256: PUBLICATION_BUNDLE_SHA256,
        sizeBytes: PUBLICATION_BUNDLE.byteLength,
      },
      ...workspaceHostRequiredReleaseMaterialFixtures(),
    ],
    parameters: [{ name: 'distribution_profile', value: 'vm-release' }],
    targets: [{ provider: 'gcp', locations: ['us-central1'] }],
  });
  const urls = deriveWorkspaceHostCanonicalArtifactUrls(PUBLICATION_BUNDLE_SHA256);
  return {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: { id: 'papercusp-workspace-host', version: PUBLICATION_VERSION },
    buildManifest,
    release: {
      version: PUBLICATION_VERSION,
      bundleUrl: urls.bundleUrl,
      bundleSha256: PUBLICATION_BUNDLE_SHA256,
      signatureUrl: urls.signatureUrl,
      signingPublicKey: PUBLICATION_SIGNING_KEY,
      signingKeySha256: PUBLICATION_SIGNING_KEY_SHA256,
    },
    lifecycle: { state: 'active', publishedAt: '2026-09-20T00:00:00Z' },
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

function publicationTrustReport(): ArtifactTrustReport {
  return {
    version: ARTIFACT_TRUST_PIPELINE_VERSION,
    subject: {
      path: `dist/papercusp-server-${PUBLICATION_VERSION}.tgz`,
      name: `papercusp-server-${PUBLICATION_VERSION}.tgz`,
      bytes: PUBLICATION_BUNDLE.byteLength,
      sha256: PUBLICATION_BUNDLE_SHA256,
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
        subjectSha256: PUBLICATION_BUNDLE_SHA256,
        tool: { name: 'minisign', version: '0.11' },
        valid: true,
        signatureSha256: PUBLICATION_SIGNATURE_SHA256,
        signingKeySha256: PUBLICATION_SIGNING_KEY_SHA256,
      },
      {
        kind: 'sbom',
        subjectSha256: PUBLICATION_BUNDLE_SHA256,
        tool: { name: 'syft', version: '1.4.1' },
        format: 'spdx-json',
        documentSha256: 'b'.repeat(64),
        componentCount: 1,
      },
      {
        kind: 'vulnerability-scan',
        subjectSha256: PUBLICATION_BUNDLE_SHA256,
        tool: { name: 'grype', version: '0.79.0' },
        sbomSha256: 'b'.repeat(64),
        findings: [],
      },
      {
        kind: 'secret-scan',
        subjectSha256: PUBLICATION_BUNDLE_SHA256,
        tool: { name: 'gitleaks', version: '8.18.0' },
        findings: [],
      },
      {
        kind: 'provenance-attestation',
        subjectSha256: PUBLICATION_BUNDLE_SHA256,
        tool: { name: 'cosign', version: '2.2.4' },
        valid: true,
        predicateType: 'https://slsa.dev/provenance/v1',
        issuedAt: '2026-09-20T00:00:00Z',
        attestationSha256: 'd'.repeat(64),
      },
    ],
    failures: [],
  };
}

function publicationFixture() {
  const objects = {
    bundle: PUBLICATION_BUNDLE.slice(),
    signature: PUBLICATION_SIGNATURE.slice(),
  };
  const manifest = buildWorkspaceHostPublicationManifest({
    artifact: publicationArtifact(),
    trustReport: publicationTrustReport(),
    bundle: { sha256: PUBLICATION_BUNDLE_SHA256, bytes: PUBLICATION_BUNDLE.byteLength },
    signature: { sha256: PUBLICATION_SIGNATURE_SHA256, bytes: PUBLICATION_SIGNATURE.byteLength },
  });
  const manifestBytes = new TextEncoder().encode(serializeWorkspaceHostPublicationManifest(manifest));
  const urls = deriveWorkspaceHostCanonicalArtifactUrls(PUBLICATION_BUNDLE_SHA256);
  const input = {
    bundleSha256: PUBLICATION_BUNDLE_SHA256,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  };
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    const body = url.endsWith('/manifest.json')
      ? manifestBytes
      : url.endsWith('.minisig')
        ? objects.signature
        : objects.bundle;
    return new Response(body, { headers: { 'content-length': String(body.byteLength) } });
  });
  return {
    input,
    fetcher,
    objects,
    urls,
    manifest,
    manifestBytes,
  };
}

function snapshot(
  overrides: Partial<ByocReleaseCarrySnapshot['milestoneProjection']> = {},
  artifactIdentity: unknown = { bundleSha256: 'bundle' },
): ByocReleaseCarrySnapshot {
  const keys = [
    ['build', 'build'],
    ['publication', 'publication'],
    ['root-bootstrap', 'root bootstrap'],
    ['fixed-agent-initialization', 'fixed-agent initialization'],
    ['customer-acceptance', 'customer acceptance'],
    ['soak-24h', '24-hour soak'],
    ['resource-census', 'resource census'],
    ['billing-closure', 'billing closure'],
    ['cleanup', 'cleanup'],
    ['shipment', 'shipment'],
  ] as const;
  const milestones = keys.map(([key, label]) => ({
    key,
    label,
    status: 'verified' as const,
    receiptState: 'committed' as const,
    receiptSequence: 1,
    evidenceRefs: [`evidence:${key}`],
  }));
  return {
    schemaVersion: 'byoc-release-carry-v1',
    taskId: 'task-1',
    workItemId: 'WI-10001532',
    operationId: 'op-1',
    cursor: 10,
    currentStage: 'release.shipment.green',
    currentState: 'committed',
    artifactIdentity,
    sourceIdentity: { sha: 'source' },
    credentialGeneration: 'cred-1',
    credentialExpiresAt: null,
    spentRequestIdentities: ['req-1'],
    evidenceRefs: milestones.flatMap((entry) => entry.evidenceRefs),
    milestoneProjection: {
      current: 'shipment',
      customerReady: true,
      shipped: true,
      milestones,
      contradictions: [],
      ...overrides,
    },
    nextAction: 'done',
    historyRef: 'task:task-1#release',
  };
}

describe('release:byoc_readiness', () => {
  it('does not treat receipt references or manifest declarations as executable archive proof', async () => {
    const bundleSha256 = 'a'.repeat(64);
    const manifestSha256 = 'b'.repeat(64);
    const manifest = JSON.stringify({
      schemaVersion: 1,
      kind: 'papercusp-workspace-host-release',
      artifact: { release: { bundleSha256 } },
      files: {
        bundle: { sha256: bundleSha256, sizeBytes: 10 },
        signature: { sha256: 'c'.repeat(64), sizeBytes: 5 },
      },
      trustReport: { failures: [] },
    });
    const fetcher = vi.fn(async () => new Response(manifest));
    const result = await probeByocPublication({ bundleSha256, manifestSha256 }, fetcher);
    expect(result.verdict).toBe('fail');
    expect(result.missing).toContain('executable-identity');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('accepts consistent fetched bytes, but does not confuse declarations with signature/SBOM/executable proof', async () => {
    const fixture = publicationFixture();
    const result = await probeByocPublication(fixture.input, fixture.fetcher);
    expect(result).toMatchObject({
      verdict: 'unknown',
      missing: ['signature', 'sbom', 'executable-identity'],
      verified: ['public-bytes', 'manifest-archive-digest'],
      failed: [],
    });
    expect(result.evidenceRefs).toEqual(expect.arrayContaining([
      `publication:manifest:${fixture.input.manifestSha256}`,
      `publication:bundle:${PUBLICATION_BUNDLE_SHA256}:${PUBLICATION_BUNDLE.byteLength}`,
      `publication:signature:${PUBLICATION_SIGNATURE_SHA256}:${PUBLICATION_SIGNATURE.byteLength}`,
    ]));
    expect(fixture.fetcher.mock.calls.map(([url]) => url)).toEqual([
      fixture.urls.manifestUrl, fixture.urls.bundleUrl, fixture.urls.signatureUrl,
    ]);
    for (const [, init] of fixture.fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([
    ['bundle', 'public-bytes:content-digest-mismatch'],
    ['signature', 'signature:content-digest-mismatch'],
  ] as const)('detects changed %s bytes with all other fixture inputs held constant', async (object, failure) => {
    const fixture = publicationFixture();
    fixture.objects[object] = fixture.objects[object].map((byte, index) => index === 0 ? byte ^ 1 : byte);
    const result = await probeByocPublication(fixture.input, fixture.fetcher);
    expect(result.verdict).toBe('fail');
    expect(result.failed).toContain(failure);
  });

  it('fails closed when the public manifest digest differs from the receipt identity', async () => {
    const result = await probeByocPublication(
      { bundleSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) },
      vi.fn(async () => new Response('{}')),
    );
    expect(result.verdict).toBe('fail');
    expect(result.failed).toContain('manifest-archive-digest:mismatch');
  });

  it.each(['null', '[]', 'true', '42', '"manifest"', '{', '{"files":null}'])(
    'returns a structured failure for malformed public manifest %s',
    async (body) => {
      const fetcher = vi.fn(async () => new Response(body));
      const result = await probeByocPublication({
        bundleSha256: PUBLICATION_BUNDLE_SHA256,
        manifestSha256: createHash('sha256').update(body).digest('hex'),
      }, fetcher);
      expect(result.verdict).toBe('fail');
      expect(result.verified).toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('catches nested malformed input rejected by the maintained publication validator', async () => {
    const fixture = publicationFixture();
    const body = JSON.stringify({
      ...fixture.manifest,
      trustReport: {
        ...fixture.manifest.trustReport,
        trusted: false,
        failures: [null],
      },
    });
    const fetcher = async (url: string) => url === fixture.urls.manifestUrl
      ? new Response(body)
      : fixture.fetcher(url);
    const result = await probeByocPublication({
      ...fixture.input,
      manifestSha256: createHash('sha256').update(body).digest('hex'),
    }, fetcher);
    expect(result.failed).toContain('publication:malformed-manifest');
    expect(result.verified).toEqual([]);
  });

  it.each(['sourceSha', 'version'] as const)('compares fetched manifest %s to the task identity', async (key) => {
    const fixture = publicationFixture();
    const result = await probeByocPublication({
      ...fixture.input,
      expectedArtifactIdentity: { [key]: key === 'sourceSha' ? '9'.repeat(40) : 'another-version' },
    }, fixture.fetcher);
    expect(result.verdict).toBe('fail');
    expect(result.failed).toContain(`publication:${key === 'sourceSha' ? 'source' : 'version'}-identity-mismatch`);
  });

  it.each([
    ['substituted key', { signingPublicKey: 'different public signing key' }, 'signature:key-pin-mismatch'],
    ['lost newline', { signingPublicKey: `${PUBLICATION_SIGNING_KEY}\n` }, 'signature:key-pin-mismatch'],
    ['malformed digest', { signingKeySha256: 'not-a-digest' }, 'signature:key-pin-mismatch'],
    ['absent digest', { signingKeySha256: undefined }, 'signature:key-pin-mismatch'],
    ['non-string key', { signingPublicKey: { key: PUBLICATION_SIGNING_KEY } }, 'signature:invalid-signing-key'],
    ['empty key', { signingPublicKey: ' \n' }, 'signature:invalid-signing-key'],
  ])('rejects a %s before fetching bundle bytes', async (_label, override, failure) => {
    const fixture = publicationFixture();
    const body = JSON.stringify({
      ...fixture.manifest,
      artifact: {
        ...fixture.manifest.artifact,
        release: { ...fixture.manifest.artifact.release, ...override },
      },
    });
    // Pin the modified manifest itself: rejection must come from measuring the
    // key bytes, not from an unrelated manifest-content digest mismatch.
    const fetcher = vi.fn(async () => new Response(body));
    const result = await probeByocPublication({
      ...fixture.input,
      manifestSha256: createHash('sha256').update(body).digest('hex'),
    }, fetcher);
    expect(result.verdict).toBe('fail');
    expect(result.failed).toEqual([failure]);
    expect(result.verified).toEqual([]);
    expect(result.missing).toContain('signature');
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(fixture.urls.manifestUrl, expect.any(Object));
  });

  it('measures the matching public-key pin without certifying the signature', async () => {
    const fixture = publicationFixture();
    const result = await probeByocPublication(fixture.input, fixture.fetcher);
    expect(result.failed).toEqual([]);
    expect(result.evidenceRefs).toContain(`publication:signing-key:${PUBLICATION_SIGNING_KEY_SHA256}`);
    expect(result.missing).toContain('signature');
    expect(result.verified).not.toContain('signature');
    expect(result.verdict).toBe('unknown');
  });

  it('leaves public-byte obligations unresolved on a failed manifest fetch', async () => {
    const fixture = publicationFixture();
    const result = await probeByocPublication(fixture.input, async () => new Response(null, { status: 404 }));
    expect(result).toMatchObject({ verdict: 'unknown', verified: [] });
    expect(result.missing).toEqual(expect.arrayContaining(['public-manifest', 'public-bytes', 'signature', 'sbom']));
  });

  it('does not make requests for malformed expected digests', async () => {
    const fetcher = vi.fn();
    const result = await probeByocPublication({ bundleSha256: '../mutable', manifestSha256: 'not-a-hash' }, fetcher);
    expect(result.verdict).toBe('fail');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('hashes chunked bodies without requiring Content-Length or a whole-body buffer', async () => {
    const fixture = publicationFixture();
    const fetcher = async (url: string) => {
      const bytes = url === fixture.urls.manifestUrl ? fixture.manifestBytes
        : url === fixture.urls.bundleUrl ? fixture.objects.bundle : fixture.objects.signature;
      let position = 0;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (position === bytes.length) { controller.close(); return; }
          const end = Math.min(position + 17, bytes.length);
          controller.enqueue(bytes.slice(position, end));
          position = end;
        },
      }));
    };
    expect(await probeByocPublication(fixture.input, fetcher)).toMatchObject({
      verified: ['public-bytes', 'manifest-archive-digest'], failed: [],
    });
  });

  it('cancels an oversized chunked manifest even when the header lies', async () => {
    const fixture = publicationFixture();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
      cancel,
    }), { headers: { 'content-length': '1' } });
    const result = await probeByocPublication(fixture.input, async () => response);
    expect(result.failed).toContain('public-manifest:bytes-exceed-bound');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels a signature exceeding the published-object size limit', async () => {
    const fixture = publicationFixture();
    const cancel = vi.fn();
    const fetcher = async (url: string) => url === fixture.urls.signatureUrl
      ? new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
        cancel,
      }))
      : fixture.fetcher(url);
    const result = await probeByocPublication(fixture.input, fetcher);
    expect(result.failed).toContain('signature:bytes-exceed-bound');
    expect(result.verified).toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('uses the multipart bundle ceiling rather than rejecting GB-sized releases at the small direct-PUT limit', async () => {
    const fixture = publicationFixture();
    const fetcher = async (url: string) => url === fixture.urls.bundleUrl
      ? new Response(fixture.objects.bundle, { headers: { 'content-length': String(2 * 1024 ** 3) } })
      : fixture.fetcher(url);
    const result = await probeByocPublication(fixture.input, fetcher);
    // This intentionally short body is read, then refused as incomplete (not refused by the size cap).
    expect(result.failed).toContain('public-bytes:content-length-mismatch');
    expect(result.failed).not.toContain('public-bytes:invalid-or-excessive-content-length');
  });

  it('cannot pass any BAR from committed receipts and evidence reference strings alone', () => {
    expect(evaluateByocReadiness('R-4', 'WI-10001532', [snapshot()], '2026-09-20T00:00:00.000Z')).toMatchObject({
      verdict: 'unknown',
      bar: 'R-4',
      artifactIdentityPresent: true,
      releaseTaskSelection: 'explicit',
      unverifiedEvidence: ['public-bytes', 'manifest-archive-digest', 'signature', 'sbom', 'executable-identity'],
    });
    expect(evaluateByocReadiness('R-5', 'WI-10001532', [snapshot()], '2026-09-20T00:00:00.000Z').verdict).toBe('unknown');
    expect(evaluateByocReadiness('R-6', 'WI-10001532', [snapshot()], '2026-09-20T00:00:00.000Z').verdict).toBe('unknown');
  });

  it('returns unknown for an absent or incomplete receipt chain, never a vacuous pass', () => {
    expect(evaluateByocReadiness('R-5', 'WI-10001532', [], '2026-09-20T00:00:00.000Z').verdict).toBe('unknown');
    const pending = snapshot({
      milestones: snapshot().milestoneProjection.milestones.map((entry) =>
        entry.key === 'customer-acceptance' ? { ...entry, status: 'pending' as const, receiptState: null, receiptSequence: null } : entry,
      ),
    });
    expect(evaluateByocReadiness('R-5', 'WI-10001532', [pending], '2026-09-20T00:00:00.000Z')).toMatchObject({
      verdict: 'unknown',
      missingMilestones: ['task-1:customer-acceptance'],
    });
  });

  it('fails closed on committed contradictions and missing artifact identity for R-4', () => {
    const contradictory = snapshot({ contradictions: ['publication has a committed receipt but an earlier prerequisite is not verified'] });
    expect(evaluateByocReadiness('R-4', 'WI-10001532', [contradictory], '2026-09-20T00:00:00.000Z').verdict).toBe('fail');
    expect(evaluateByocReadiness('R-4', 'WI-10001532', [snapshot({}, null)], '2026-09-20T00:00:00.000Z')).toMatchObject({
      verdict: 'unknown',
      missingMilestones: ['artifact-identity'],
    });
  });

  it('refuses an ambiguous historical release-task population instead of selecting a lucky receipt', () => {
    const first = snapshot();
    const second = { ...snapshot(), taskId: 'task-2' };
    expect(evaluateByocReadiness('R-4', 'WI-10001532', [first, second], '2026-09-20T00:00:00.000Z')).toMatchObject({
      verdict: 'unknown',
      missingMilestones: ['release-task-selection'],
      releaseTaskSelection: 'ambiguous',
    });
  });

  it('does not ask for final shipment as a prerequisite to R-6 acceptance', () => {
    const unshipped = snapshot({
      shipped: false,
      milestones: snapshot().milestoneProjection.milestones.filter(({ key }) => key !== 'shipment'),
    });
    const result = evaluateByocReadiness('R-6', 'WI-10001532', [unshipped]);
    expect(result.missingMilestones).toEqual([]);
    expect(result.verdict).toBe('unknown');
    expect(result.unverifiedEvidence).toContain('five-live-journeys');
  });

  it('does not let a different work item supply a successful receipt population', () => {
    expect(evaluateByocReadiness('R-4', 'WI-other', [snapshot()])).toMatchObject({
      verdict: 'fail',
      contradictions: ['task-1:work-item-identity-mismatch'],
    });
  });

  it('requires customer desktop source observations even with a committed acceptance receipt', () => {
    const result = evaluateByocReadiness('R-5', 'WI-10001532', [snapshot()]);
    expect(result.missingMilestones).toEqual([]);
    expect(result.unverifiedEvidence).toContain('customer-desktop');
    expect(result.verdict).toBe('unknown');
  });
});

describe('exact BYOC release subject', () => {
  const subject = { workspaceId: 'ws', workItemId: 'WI-10001532', taskId: 'task-1' };
  const journal = {
    schemaVersion: 1, operationId: 'operation-1', cursor: 0,
    currentStage: null, currentState: null, spentOperationIds: [], receipts: [],
  };
  const row = {
    task_id: subject.taskId, workspace_id: subject.workspaceId,
    work_item_id: subject.workItemId, class: 'deploy', detail: { release: journal },
  };
  const sqlFor = (rows: unknown[]) => vi.fn(async () => rows) as unknown as Sql;

  it('requires taskId in the tool contract, rather than selecting a recent release implicitly', () => {
    expect(tool.args.safeParse({ bar: 'R-4', workItemId: subject.workItemId }).success).toBe(false);
    expect(tool.args.safeParse({ bar: 'R-4', workItemId: subject.workItemId, taskId: subject.taskId }).success).toBe(true);
  });

  it('reads the selected task with workspace and work-item predicates, without a carry shortlist', async () => {
    const sql = sqlFor([row]);
    expect(await readByocReleaseSubject(subject, sql)).toMatchObject({
      taskId: subject.taskId, workItemId: subject.workItemId, operationId: journal.operationId,
    });
    const [strings, ...values] = vi.mocked(sql).mock.calls[0];
    expect(Array.from(strings as unknown as string[]).join('?')).toMatch(/WHERE task_id = \?/);
    expect(values).toEqual([subject.taskId, subject.workspaceId, subject.workItemId]);
  });

  it.each([
    [],
    [{ ...row, workspace_id: 'another-workspace' }],
    [{ ...row, work_item_id: 'WI-other' }],
    [{ ...row, task_id: 'another-task' }],
    [{ ...row, class: 'bash-job' }],
    [{ ...row, detail: { release: { ...journal, cursor: 1 } } }],
    [row, row],
  ])('refuses absent, mismatched, malformed or non-unique subjects', async (...rows) => {
    expect(await readByocReleaseSubject(subject, sqlFor(rows))).toBeNull();
  });

  it('rejects blank scope before making a database read', async () => {
    const sql = sqlFor([row]);
    await expect(readByocReleaseSubject({ ...subject, workspaceId: ' ' }, sql)).rejects.toThrow('non-empty');
    expect(sql).not.toHaveBeenCalled();
  });

  it('rejects a receipt copied from another operation', async () => {
    const receipt = {
      sequence: 0, operationId: 'foreign', requestIdentity: 'req', stage: 'publish.finalize',
      state: 'committed', inputHash: 'a'.repeat(64), evidenceRefs: ['publication:pass'],
      recordedAt: '2026-09-20T00:00:00Z',
    };
    expect(await readByocReleaseSubject(subject, sqlFor([{
      ...row, detail: { release: { ...journal, cursor: 1, receipts: [receipt] } },
    }]))).toBeNull();
  });

  it('binds the public publication probe to one task journal finalize input, not copied receipt prose', () => {
    const bundleSha256 = 'a'.repeat(64);
    const manifestSha256 = 'b'.repeat(64);
    const operationId = 'operation-1';
    const finalizeInputHash = releaseStageInputHash({ bundleSha256, manifestSha256 });
    const journal: TaskReleaseJournal = {
      schemaVersion: 1,
      operationId,
      source: { sha: '1'.repeat(40), gitlinks: { 'papercusp-desktop': '2'.repeat(40) } },
      artifactIdentity: {
        kind: 'papercusp-workspace-host-release',
        sourceSha: '1'.repeat(40),
        version: '2026.9.20-1',
        bundleSha256,
      },
      cursor: 2,
      currentStage: 'publish.finalize',
      currentState: 'committed',
      spentOperationIds: ['request-1', 'request-2'],
      receipts: [
        {
          sequence: 0,
          operationId,
          requestIdentity: 'request-1',
          stage: 'publish.multipart.complete',
          state: 'committed',
          inputHash: 'bundle-input',
          inputIdentity: null,
          evidenceRefs: [`provider:bundle:${bundleSha256}`],
          recordedAt: '2026-09-20T00:00:00Z',
        },
        {
          sequence: 1,
          operationId,
          requestIdentity: 'request-2',
          stage: 'publish.finalize',
          state: 'committed',
          inputHash: finalizeInputHash,
          inputIdentity: null,
          evidenceRefs: [`provider:finalization:${manifestSha256}`],
          recordedAt: '2026-09-20T00:00:01Z',
        },
      ],
    };

    expect(publicationProbeInputFromJournal(journal)).toEqual({
      bundleSha256,
      manifestSha256,
      operationId,
      expectedArtifactIdentity: {
        sourceSha: '1'.repeat(40),
        version: '2026.9.20-1',
      },
    });
    expect(publicationProbeInputFromJournal({
      ...journal,
      receipts: journal.receipts.map((receipt) =>
        receipt.stage === 'publish.finalize' ? { ...receipt, inputHash: 'foreign-input' } : receipt,
      ),
    })).toBeNull();
    for (const state of ['unknown', 'intent', 'refused'] as const) {
      expect(publicationProbeInputFromJournal({
        ...journal,
        receipts: [...journal.receipts, { ...journal.receipts[1], sequence: 2, state }],
      })).toBeNull();
    }
    expect(publicationProbeInputFromJournal({
      ...journal,
      artifactIdentity: { sourceSha: '1'.repeat(40), version: '2026.9.20-1' },
    })).toMatchObject({ bundleSha256, manifestSha256 });
    expect(publicationProbeInputFromJournal({
      ...journal,
      artifactIdentity: { bundleSha256: 'c'.repeat(64) },
    })).toBeNull();
    expect(publicationProbeInputFromJournal({
      ...journal,
      receipts: journal.receipts.map((receipt) => ({
        ...receipt, evidenceRefs: [...receipt.evidenceRefs, `provider:finalization:${'d'.repeat(64)}`],
      })),
    })).toBeNull();
  });

  it('the handler read path only discharges fetched byte obligations and preserves missing cryptographic proof', async () => {
    const fixture = publicationFixture();
    const journal: TaskReleaseJournal = {
      schemaVersion: 1, operationId: 'operation-1', cursor: 2,
      currentStage: 'publish.finalize', currentState: 'committed', spentOperationIds: [],
      source: { sha: '1'.repeat(40) },
      artifactIdentity: { bundleSha256: fixture.input.bundleSha256, version: PUBLICATION_VERSION },
      receipts: [
        { sequence: 0, operationId: 'operation-1', requestIdentity: 'build-req', stage: 'release.build.linux',
          state: 'committed', inputHash: 'a'.repeat(64), evidenceRefs: ['build:test'], recordedAt: '2026-09-20T00:00:00Z' },
        { sequence: 1, operationId: 'operation-1', requestIdentity: 'finalize-req', stage: 'publish.finalize',
          state: 'committed', inputHash: releaseStageInputHash(fixture.input),
          evidenceRefs: [`provider:finalization:${fixture.input.manifestSha256}`], recordedAt: '2026-09-20T00:00:01Z' },
      ],
    };
    const sql = sqlFor([{ ...row, detail: { release: journal } }]);
    const result = await readByocReadiness({ ...subject, bar: 'R-4' }, sql, fixture.fetcher);
    expect(result).toMatchObject({
      verdict: 'unknown', unverifiedEvidence: ['signature', 'sbom', 'executable-identity'],
      missingMilestones: [], failedMilestones: [],
    });
    fixture.fetcher.mockClear();
    const failed = await readByocReadiness({ ...subject, bar: 'R-4' }, sql, async () => new Response(null, { status: 404 }));
    expect(failed.unverifiedEvidence).toContain('public-bytes');
    expect(failed.unverifiedEvidence).toContain('manifest-archive-digest');
    fixture.objects.signature[0] ^= 1;
    expect(await readByocReadiness({ ...subject, bar: 'R-4' }, sql, fixture.fetcher)).toMatchObject({
      verdict: 'fail', failedMilestones: expect.arrayContaining(['publication:signature:content-digest-mismatch']),
    });
    fixture.fetcher.mockClear();
    await readByocReadiness({ ...subject, bar: 'R-5' }, sql, fixture.fetcher);
    await readByocReadiness({ ...subject, bar: 'R-4' }, sqlFor([]), fixture.fetcher);
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });
});
