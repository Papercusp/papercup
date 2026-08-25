import { sha256Hex } from '@papercusp/artifact-registry';
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
import { afterEach, describe, expect, it } from 'vitest';

import { makeEnv, stubGithub, type FakeR2 } from '../__tests__/fake-d1.ts';
import type { Env } from '../env.ts';
import { buildApi } from './index.ts';
import {
  WORKSPACE_HOST_ARTIFACT_PREFIX,
  WORKSPACE_HOST_PUBLIC_CACHE_CONTROL,
} from './workspace-host-artifacts.ts';

const api = buildApi();
const originalFetch = globalThis.fetch;
const VERSION = '2026.8.25-1';
const SBOM_SHA256 = 'b'.repeat(64);
const ATTESTATION_SHA256 = 'c'.repeat(64);

interface Fixture {
  bundle: Uint8Array;
  bundleSha256: string;
  signature: Uint8Array;
  signatureSha256: string;
  manifest: Record<string, unknown>;
  manifestBytes: Uint8Array;
  manifestSha256: string;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function fixture(
  mutate?: (manifest: Record<string, unknown>) => void,
): Promise<Fixture> {
  const bundle = new TextEncoder().encode('verified workspace-host server bundle');
  const signature = new TextEncoder().encode('untrusted comment: signature\nRWSignedBundle');
  const signingPublicKey = 'untrusted comment: Papercusp workspace-host release key\nRWQpublickey';
  const [bundleSha256, signatureSha256, signingKeySha256] = await Promise.all([
    sha256Hex(bundle),
    sha256Hex(signature),
    sha256Hex(new TextEncoder().encode(signingPublicKey)),
  ]);
  const urls = deriveWorkspaceHostCanonicalArtifactUrls(bundleSha256);
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
      sha256: bundleSha256,
      sizeBytes: bundle.byteLength,
    },
    baseImage: {
      reference: 'ubuntu-2404-minimal',
      architecture: 'x86_64',
      sha256: 'd'.repeat(64),
    },
    builder: {
      strategy: 'shared',
      kind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
      version: '1.14.2',
      templatePath: 'infra/images/workspace-host.pkr.hcl',
      templateSha256: 'e'.repeat(64),
    },
    materials: [
      {
        path: 'dist/papercusp-server.tgz',
        sha256: bundleSha256,
        sizeBytes: bundle.byteLength,
      },
      {
        path: WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT,
        sha256: 'f'.repeat(64),
        sizeBytes: 2_048,
        executable: true,
      },
    ],
    parameters: [{ name: 'distribution_profile', value: 'vm-release' }],
    targets: [{ provider: 'gcp', locations: ['us-central1'] }],
  });
  const artifact: WorkspaceHostImageArtifact = {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: { id: 'papercusp-workspace-host', version: VERSION },
    buildManifest,
    release: {
      version: VERSION,
      bundleUrl: urls.bundleUrl,
      bundleSha256,
      signatureUrl: urls.signatureUrl,
      signingPublicKey,
      signingKeySha256,
    },
    lifecycle: { state: 'active', publishedAt: '2026-08-25T00:00:00.000Z' },
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
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    kind: 'papercusp-workspace-host-release',
    artifact,
    files: {
      bundle: { name: 'server.tgz', sha256: bundleSha256, sizeBytes: bundle.byteLength },
      signature: {
        name: 'server.tgz.minisig',
        sha256: signatureSha256,
        sizeBytes: signature.byteLength,
      },
    },
    trustReport: {
      version: 'artifact-trust-v1',
      subject: {
        path: `dist/papercusp-server-${VERSION}.tgz`,
        name: `papercusp-server-${VERSION}.tgz`,
        bytes: bundle.byteLength,
        sha256: bundleSha256,
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
          subjectSha256: bundleSha256,
          signatureSha256,
          signingKeySha256,
          tool: { name: 'minisign', version: '0.12' },
          valid: true,
        },
        {
          kind: 'sbom',
          subjectSha256: bundleSha256,
          tool: { name: 'syft', version: '1.30' },
          format: 'cyclonedx-json',
          documentSha256: SBOM_SHA256,
          componentCount: 42,
        },
        {
          kind: 'vulnerability-scan',
          subjectSha256: bundleSha256,
          tool: { name: 'grype', version: '0.99' },
          sbomSha256: SBOM_SHA256,
          findings: [],
        },
        {
          kind: 'secret-scan',
          subjectSha256: bundleSha256,
          tool: { name: 'gitleaks', version: '8.28' },
          findings: [],
        },
        {
          kind: 'provenance-attestation',
          subjectSha256: bundleSha256,
          tool: { name: 'cosign', version: '2.5' },
          valid: true,
          predicateType: 'https://slsa.dev/provenance/v1',
          issuedAt: '2026-08-25T00:00:00.000Z',
          attestationSha256: ATTESTATION_SHA256,
        },
      ],
      failures: [],
    },
  };
  mutate?.(manifest);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  return {
    bundle,
    bundleSha256,
    signature,
    signatureSha256,
    manifest,
    manifestBytes,
    manifestSha256: await sha256Hex(manifestBytes),
  };
}

function authedEnv(): { env: Env; r2: FakeR2 } {
  stubGithub({ user: { id: 7, login: 'operator' } });
  const { env, r2 } = makeEnv({ CUPBOARD_OPERATOR_GITHUB_IDS: '7' });
  return { env, r2 };
}

async function upload(
  env: Env,
  bundleSha256: string,
  file: 'server.tgz' | 'server.tgz.minisig' | 'manifest.json',
  bytes: Uint8Array,
  declaredSha256: string,
): Promise<Response> {
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return api.request(
    `/admin/artifacts/workspace-host/sha256/${bundleSha256}/${file}`,
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer github-token',
        'content-type': file === 'manifest.json' ? 'application/json' : 'application/octet-stream',
        'x-artifact-sha256': declaredSha256,
        'x-artifact-size': String(bytes.byteLength),
      },
      body,
    },
    env,
  );
}

async function uploadFixture(env: Env, value: Fixture): Promise<Response[]> {
  return Promise.all([
    upload(env, value.bundleSha256, 'server.tgz', value.bundle, value.bundleSha256),
    upload(env, value.bundleSha256, 'server.tgz.minisig', value.signature, value.signatureSha256),
    upload(env, value.bundleSha256, 'manifest.json', value.manifestBytes, value.manifestSha256),
  ]);
}

function finalize(env: Env, bundleSha256: string): Promise<Response> {
  return api.request(
    `/admin/artifacts/workspace-host/sha256/${bundleSha256}/finalize`,
    { method: 'POST', headers: { authorization: 'Bearer github-token' } },
    env,
  );
}

describe('workspace-host artifact publication', () => {
  it('requires a valid allowlisted GitHub operator before storing bytes', async () => {
    const value = await fixture();
    stubGithub({ user: { error: 401 } });
    const { env, r2 } = makeEnv({ CUPBOARD_OPERATOR_GITHUB_IDS: '7' });

    const response = await upload(env, value.bundleSha256, 'server.tgz', value.bundle, value.bundleSha256);

    expect(response.status).toBe(401);
    expect(r2.data.size).toBe(0);
  });

  it('verifies actual bytes, stores create-only, dedupes an exact retry, and stays private before finalize', async () => {
    const value = await fixture();
    const { env, r2 } = authedEnv();
    const tampered = new TextEncoder().encode('different bytes with the declared digest');

    const rejected = await upload(
      env,
      value.bundleSha256,
      'server.tgz',
      tampered,
      value.bundleSha256,
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: 'artifact_sha256_mismatch' });

    const created = await upload(
      env,
      value.bundleSha256,
      'server.tgz',
      value.bundle,
      value.bundleSha256,
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ deduped: false });

    const duplicate = await upload(
      env,
      value.bundleSha256,
      'server.tgz',
      value.bundle,
      value.bundleSha256,
    );
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ deduped: true });
    expect(r2.data.size).toBe(1);

    const hidden = await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/server.tgz`,
      {},
      env,
    );
    expect(hidden.status).toBe(404);
  });

  it('refuses finalization until all three verified objects exist', async () => {
    const value = await fixture();
    const { env } = authedEnv();
    await upload(env, value.bundleSha256, 'server.tgz', value.bundle, value.bundleSha256);

    const response = await finalize(env, value.bundleSha256);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'uploads_incomplete',
      missing: ['server.tgz.minisig', 'manifest.json'],
    });
  });

  it('rejects a trust envelope with secret findings and never creates visibility', async () => {
    const value = await fixture((manifest) => {
      const trust = manifest.trustReport as { evidence: Array<Record<string, unknown>> };
      const secretScan = trust.evidence.find((entry) => entry.kind === 'secret-scan')!;
      secretScan.findings = [{ ruleId: 'cloud-api-key', location: 'bundle:12' }];
      (manifest as Record<string, unknown>).smuggledToken = 'ghp_abcdefghijklmnopqrstuvwxyz';
    });
    const { env, r2 } = authedEnv();
    expect((await Promise.all(await uploadFixture(env, value))).every((response) => response.status === 201)).toBe(true);

    const response = await finalize(env, value.bundleSha256);
    const body = await response.json() as { error: string; errors: string[] };

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_manifest');
    expect(body.errors.join(' ')).toMatch(/unexpected manifest field|secret-shaped|zero findings/);
    expect(r2.data.has(`${WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/.finalized.json`)).toBe(false);
    expect((await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/manifest.json`,
      {},
      env,
    )).status).toBe(404);
  });

  it('rejects an otherwise valid manifest that points at a noncanonical release origin', async () => {
    const value = await fixture((manifest) => {
      const artifact = manifest.artifact as WorkspaceHostImageArtifact;
      (artifact.release as { bundleUrl: string }).bundleUrl =
        `https://releases.papercusp.com/${VERSION}/server.tgz`;
      (artifact.release as { signatureUrl: string }).signatureUrl =
        `${artifact.release.bundleUrl}.minisig`;
    });
    const { env } = authedEnv();
    await uploadFixture(env, value);

    const response = await finalize(env, value.bundleSha256);
    const body = await response.json() as { errors: string[] };

    expect(response.status).toBe(400);
    expect(body.errors).toContain('artifact release URLs must equal the D-105 digest-derived Cupboard URLs');
  });

  it('finalizes idempotently and serves public GET/HEAD with immutable integrity metadata', async () => {
    const value = await fixture();
    const { env, r2 } = authedEnv();
    const uploads = await uploadFixture(env, value);
    expect(uploads.map((response) => response.status)).toEqual([201, 201, 201]);

    const created = await finalize(env, value.bundleSha256);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      ok: true,
      bundleSha256: value.bundleSha256,
      manifestSha256: value.manifestSha256,
      deduped: false,
    });

    const duplicate = await finalize(env, value.bundleSha256);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ deduped: true });

    const get = await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/server.tgz`,
      {},
      env,
    );
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(value.bundle);
    expect(get.headers.get('cache-control')).toBe(WORKSPACE_HOST_PUBLIC_CACHE_CONTROL);
    expect(get.headers.get('x-artifact-sha256')).toBe(value.bundleSha256);
    expect(get.headers.get('content-type')).toBe('application/gzip');
    expect(get.headers.get('x-content-type-options')).toBe('nosniff');

    const head = await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/manifest.json`,
      { method: 'HEAD' },
      env,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).toBe(String(value.manifestBytes.byteLength));
    expect(head.headers.get('x-artifact-sha256')).toBe(value.manifestSha256);

    const markerKey = `${WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/.finalized.json`;
    expect(r2.data.has(markerKey)).toBe(true);
  });

  it('fails closed when finalized object metadata no longer matches the marker', async () => {
    const value = await fixture();
    const { env, r2 } = authedEnv();
    await uploadFixture(env, value);
    expect((await finalize(env, value.bundleSha256)).status).toBe(201);
    const bundleKey = `${WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/server.tgz`;
    r2.customMetadata.get(bundleKey)!.fileSha256 = '0'.repeat(64);

    const response = await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/server.tgz`,
      {},
      env,
    );

    expect(response.status).toBe(404);
  });

  it('refuses a conflicting re-upload at the same bundle namespace', async () => {
    const value = await fixture();
    const { env } = authedEnv();
    expect((await upload(
      env,
      value.bundleSha256,
      'server.tgz.minisig',
      value.signature,
      value.signatureSha256,
    )).status).toBe(201);
    const replacement = new TextEncoder().encode('different detached signature');
    const replacementSha256 = await sha256Hex(replacement);

    const response = await upload(
      env,
      value.bundleSha256,
      'server.tgz.minisig',
      replacement,
      replacementSha256,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'artifact_conflict' });
  });
});
