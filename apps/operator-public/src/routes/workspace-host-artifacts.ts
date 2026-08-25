/**
 * D-105/D-107 workspace-host artifact publication.
 *
 * Operator-authenticated uploads land create-only in the existing Cupboard R2
 * bucket. Public GET/HEAD remain indistinguishable from missing until a
 * create-only finalization marker binds the bundle, detached signature,
 * manifest, signing key, and trust receipts to one verified digest.
 */

import { isHexSha256, sha256Hex } from '@papercusp/artifact-registry';
import {
  deriveWorkspaceHostCanonicalArtifactUrls,
  validateWorkspaceHostImageArtifact,
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';
import { Hono } from 'hono';
import type { Context } from 'hono';

import type { Env } from '../env.ts';
import { requireOperator } from './admin.ts';

export const WORKSPACE_HOST_ARTIFACT_PREFIX = 'artifacts/workspace-host/sha256';
export const WORKSPACE_HOST_ARTIFACT_FILES = [
  'server.tgz',
  'server.tgz.minisig',
  'manifest.json',
] as const;
export const WORKSPACE_HOST_PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable';

type WorkspaceHostArtifactFile = (typeof WORKSPACE_HOST_ARTIFACT_FILES)[number];

const FINALIZATION_FILE = '.finalized.json';
const PUBLICATION_SCHEMA_VERSION = 1;
const PUBLICATION_KIND = 'papercusp-workspace-host-release';
const FINALIZATION_KIND = 'papercusp-workspace-host-finalization';
const ARTIFACT_TRUST_VERSION = 'artifact-trust-v1';
const MAX_BYTES: Readonly<Record<WorkspaceHostArtifactFile, number>> = {
  'server.tgz': 64 * 1024 * 1024,
  'server.tgz.minisig': 64 * 1024,
  'manifest.json': 1024 * 1024,
};
const CONTENT_TYPE: Readonly<Record<WorkspaceHostArtifactFile, string>> = {
  'server.tgz': 'application/gzip',
  'server.tgz.minisig': 'text/plain; charset=utf-8',
  'manifest.json': 'application/json; charset=utf-8',
};
const REQUIRED_TRUST_EVIDENCE = [
  'signature',
  'sbom',
  'vulnerability-scan',
  'secret-scan',
  'provenance-attestation',
] as const;

interface StoredFileDescriptor {
  sha256: string;
  sizeBytes: number;
}

interface FinalizationRecord {
  schemaVersion: typeof PUBLICATION_SCHEMA_VERSION;
  kind: typeof FINALIZATION_KIND;
  bundleSha256: string;
  manifestSha256: string;
  files: Record<WorkspaceHostArtifactFile, StoredFileDescriptor>;
  finalizedAt: string;
  finalizedByGithubUserId: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArtifactFile(value: unknown): value is WorkspaceHostArtifactFile {
  return (
    typeof value === 'string' &&
    (WORKSPACE_HOST_ARTIFACT_FILES as readonly string[]).includes(value)
  );
}

function artifactPrefix(bundleSha256: string): string {
  return `${WORKSPACE_HOST_ARTIFACT_PREFIX}/${bundleSha256}`;
}

function artifactKey(bundleSha256: string, file: WorkspaceHostArtifactFile): string {
  return `${artifactPrefix(bundleSha256)}/${file}`;
}

function finalizationKey(bundleSha256: string): string {
  return `${artifactPrefix(bundleSha256)}/${FINALIZATION_FILE}`;
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function metadataFor(
  file: WorkspaceHostArtifactFile,
  bundleSha256: string,
  fileSha256: string,
  sizeBytes: number,
  githubUserId: number,
): Record<string, string> {
  return {
    namespace: 'workspace-host-v1',
    bundleSha256,
    file,
    fileSha256,
    sizeBytes: String(sizeBytes),
    uploadedByGithubUserId: String(githubUserId),
  };
}

function descriptorFromObject(
  object: Pick<R2Object, 'size' | 'customMetadata'> | null,
  file: WorkspaceHostArtifactFile,
  bundleSha256: string,
): StoredFileDescriptor | null {
  if (!object) return null;
  const metadata = object.customMetadata ?? {};
  const sizeBytes = Number(metadata.sizeBytes);
  if (
    metadata.namespace !== 'workspace-host-v1' ||
    metadata.bundleSha256 !== bundleSha256 ||
    metadata.file !== file ||
    !isHexSha256(metadata.fileSha256) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes !== object.size
  ) {
    return null;
  }
  if (file === 'server.tgz' && metadata.fileSha256 !== bundleSha256) return null;
  return { sha256: metadata.fileSha256, sizeBytes };
}

function descriptorMatches(
  object: Pick<R2Object, 'size' | 'customMetadata'> | null,
  file: WorkspaceHostArtifactFile,
  bundleSha256: string,
  expected: StoredFileDescriptor,
): boolean {
  const actual = descriptorFromObject(object, file, bundleSha256);
  return actual?.sha256 === expected.sha256 && actual.sizeBytes === expected.sizeBytes;
}

async function putCreateOnly(
  bucket: R2Bucket,
  key: string,
  body: ArrayBuffer | Uint8Array | string,
  options: R2PutOptions,
): Promise<'created' | 'exists'> {
  try {
    // The installed Workers types model conditional PUT as R2Object, while the
    // runtime may surface an unsatisfied precondition as null or an exception.
    // Handle both and adjudicate the race from a fresh HEAD.
    const result = (await bucket.put(key, body, {
      ...options,
      onlyIf: { etagDoesNotMatch: '*' },
    })) as R2Object | null;
    return result ? 'created' : 'exists';
  } catch (error) {
    if (await bucket.head(key)) return 'exists';
    throw error;
  }
}

const SAFE_SECRET_FIELD_NAMES = new Set([
  'maxSecretFindings',
  'signingPublicKey',
  'signingKeySha256',
]);
const SECRET_FIELD = /(?:^|[-_.])(password|passwd|credential|credentials|secret|token|private[-_]?key|api[-_]?key)(?:$|[-_.])/i;
const SECRET_VALUE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/;

function secretMaterialError(value: unknown, path = 'manifest'): string | null {
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) return `${path} contains secret-shaped material`;
    try {
      const url = new URL(value);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && (url.username || url.password)) {
        return `${path} contains URL credentials`;
      }
    } catch {
      // Most manifest strings are not URLs; only successfully parsed HTTP(S)
      // values participate in the userinfo guard.
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = secretMaterialError(value[index], `${path}[${index}]`);
      if (error) return error;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1-$2');
    if (!SAFE_SECRET_FIELD_NAMES.has(key) && SECRET_FIELD.test(normalized)) {
      return `${path}.${key} is a secret-shaped field`;
    }
    const error = secretMaterialError(nested, `${path}.${key}`);
    if (error) return error;
  }
  return null;
}

function validTool(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    typeof value.version === 'string' &&
    value.version.trim().length > 0
  );
}

function validateTrustReport(
  value: unknown,
  bundleSha256: string,
  bundle: StoredFileDescriptor,
  signature: StoredFileDescriptor,
  signingKeySha256: string,
): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['trustReport must be an object'];
  if (value.version !== ARTIFACT_TRUST_VERSION) {
    errors.push(`trustReport.version must be '${ARTIFACT_TRUST_VERSION}'`);
  }
  if (value.trusted !== true) errors.push('trustReport.trusted must be true');
  if (!Array.isArray(value.failures) || value.failures.length !== 0) {
    errors.push('trustReport.failures must be an empty array');
  }

  const subject = value.subject;
  if (
    !isRecord(subject) ||
    subject.sha256 !== bundleSha256 ||
    subject.bytes !== bundle.sizeBytes ||
    subject.signed !== true ||
    typeof subject.path !== 'string' ||
    subject.path.trim().length === 0 ||
    typeof subject.name !== 'string' ||
    subject.name.trim().length === 0
  ) {
    errors.push('trustReport.subject must bind the signed bundle digest and exact byte count');
  }

  const policy = value.policy;
  let maxAttestationAgeMs: number | null = null;
  if (
    !isRecord(policy) ||
    policy.maxSecretFindings !== 0 ||
    !['low', 'medium', 'high', 'critical'].includes(String(policy.denyVulnerabilitiesAtOrAbove)) ||
    !Number.isSafeInteger(policy.maxAttestationAgeMs) ||
    Number(policy.maxAttestationAgeMs) <= 0
  ) {
    errors.push('trustReport.policy must be explicit and require zero secret findings');
  } else {
    maxAttestationAgeMs = Number(policy.maxAttestationAgeMs);
  }

  if (!Array.isArray(value.evidence)) {
    errors.push('trustReport.evidence must contain every required evidence class');
    return errors;
  }
  const seen = new Set<string>();
  let sbomSha256: string | null = null;
  let scannedSbomSha256: string | null = null;
  for (const candidate of value.evidence) {
    if (!isRecord(candidate) || typeof candidate.kind !== 'string') {
      errors.push('every trust evidence entry must be an object with a kind');
      continue;
    }
    const kind = candidate.kind;
    if (seen.has(kind)) errors.push(`trustReport.evidence contains duplicate '${kind}'`);
    seen.add(kind);
    if (candidate.subjectSha256 !== bundleSha256) {
      errors.push(`${kind} evidence is not bound to the bundle digest`);
    }
    if (!validTool(candidate.tool)) errors.push(`${kind} evidence lacks exact tool metadata`);

    if (kind === 'signature') {
      if (
        candidate.valid !== true ||
        candidate.signatureSha256 !== signature.sha256 ||
        candidate.signingKeySha256 !== signingKeySha256
      ) {
        errors.push('signature evidence must verify the uploaded signature and pinned signing key');
      }
    } else if (kind === 'sbom') {
      if (
        typeof candidate.format !== 'string' ||
        !isHexSha256(candidate.documentSha256) ||
        !Number.isSafeInteger(candidate.componentCount) ||
        Number(candidate.componentCount) < 0
      ) {
        errors.push('sbom evidence is malformed');
      } else {
        sbomSha256 = candidate.documentSha256;
      }
    } else if (kind === 'vulnerability-scan') {
      if (!isHexSha256(candidate.sbomSha256) || !Array.isArray(candidate.findings)) {
        errors.push('vulnerability-scan evidence is malformed');
      } else {
        scannedSbomSha256 = candidate.sbomSha256;
      }
    } else if (kind === 'secret-scan') {
      if (!Array.isArray(candidate.findings) || candidate.findings.length !== 0) {
        errors.push('secret-scan evidence must report zero findings');
      }
    } else if (kind === 'provenance-attestation') {
      if (
        candidate.valid !== true ||
        typeof candidate.predicateType !== 'string' ||
        candidate.predicateType.trim().length === 0 ||
        !isHexSha256(candidate.attestationSha256) ||
        typeof candidate.issuedAt !== 'string' ||
        !Number.isFinite(Date.parse(candidate.issuedAt))
      ) {
        errors.push('provenance-attestation evidence is malformed or invalid');
      } else if (maxAttestationAgeMs !== null) {
        const ageMs = Date.now() - Date.parse(candidate.issuedAt);
        if (ageMs < 0 || ageMs > maxAttestationAgeMs) {
          errors.push('provenance-attestation evidence is outside the declared freshness policy');
        }
      }
    }
  }
  for (const kind of REQUIRED_TRUST_EVIDENCE) {
    if (!seen.has(kind)) errors.push(`trustReport.evidence is missing '${kind}'`);
  }
  if (value.evidence.length !== REQUIRED_TRUST_EVIDENCE.length) {
    errors.push('trustReport.evidence must contain exactly the five required evidence classes');
  }
  if (sbomSha256 && scannedSbomSha256 && sbomSha256 !== scannedSbomSha256) {
    errors.push('vulnerability-scan evidence is bound to a different SBOM');
  }
  return errors;
}

function fileDescriptor(value: unknown, expectedName: string): StoredFileDescriptor | null {
  if (
    !isRecord(value) ||
    value.name !== expectedName ||
    !isHexSha256(value.sha256) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    Number(value.sizeBytes) <= 0
  ) {
    return null;
  }
  return { sha256: value.sha256, sizeBytes: Number(value.sizeBytes) };
}

function validatePublicationManifest(
  value: unknown,
  bundleSha256: string,
  stored: Record<WorkspaceHostArtifactFile, StoredFileDescriptor>,
): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['manifest must be a JSON object'];
  const allowedTopLevel = new Set(['schemaVersion', 'kind', 'artifact', 'files', 'trustReport']);
  for (const key of Object.keys(value)) {
    if (!allowedTopLevel.has(key)) errors.push(`unexpected manifest field '${key}'`);
  }
  if (value.schemaVersion !== PUBLICATION_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${PUBLICATION_SCHEMA_VERSION}`);
  }
  if (value.kind !== PUBLICATION_KIND) errors.push(`kind must be '${PUBLICATION_KIND}'`);

  const secretError = secretMaterialError(value);
  if (secretError) errors.push(secretError);

  const files = value.files;
  const bundle = isRecord(files) ? fileDescriptor(files.bundle, 'server.tgz') : null;
  const signature = isRecord(files) ? fileDescriptor(files.signature, 'server.tgz.minisig') : null;
  if (!bundle) errors.push('files.bundle must describe server.tgz with a digest and positive size');
  if (!signature) {
    errors.push('files.signature must describe server.tgz.minisig with a digest and positive size');
  }
  if (bundle && (bundle.sha256 !== bundleSha256 || bundle.sizeBytes !== stored['server.tgz'].sizeBytes)) {
    errors.push('files.bundle does not match the uploaded content-addressed bundle');
  }
  if (
    signature &&
    (signature.sha256 !== stored['server.tgz.minisig'].sha256 ||
      signature.sizeBytes !== stored['server.tgz.minisig'].sizeBytes)
  ) {
    errors.push('files.signature does not match the uploaded detached signature');
  }

  let artifact: WorkspaceHostImageArtifact | null = null;
  if (!isRecord(value.artifact)) {
    errors.push('artifact must be a WorkspaceHostImageArtifact object');
  } else {
    artifact = value.artifact as unknown as WorkspaceHostImageArtifact;
    try {
      errors.push(...validateWorkspaceHostImageArtifact(artifact).map((error) => `artifact: ${error}`));
    } catch (error) {
      errors.push(`artifact validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (artifact) {
    const canonical = deriveWorkspaceHostCanonicalArtifactUrls(bundleSha256);
    if (
      artifact.release.bundleSha256 !== bundleSha256 ||
      artifact.buildManifest.releaseArtifact.sha256 !== bundleSha256
    ) {
      errors.push('artifact release/build digests must equal the addressed bundle digest');
    }
    if (artifact.buildManifest.releaseArtifact.sizeBytes !== stored['server.tgz'].sizeBytes) {
      errors.push('artifact build manifest size does not equal the uploaded bundle size');
    }
    if (
      artifact.release.bundleUrl !== canonical.bundleUrl ||
      artifact.release.signatureUrl !== canonical.signatureUrl
    ) {
      errors.push('artifact release URLs must equal the D-105 digest-derived Cupboard URLs');
    }
    if (artifact.lifecycle.state !== 'active') errors.push('artifact lifecycle must be active at publication');
    if (bundle && signature) {
      errors.push(
        ...validateTrustReport(
          value.trustReport,
          bundleSha256,
          bundle,
          signature,
          artifact.release.signingKeySha256,
        ),
      );
    }
  }
  return [...new Set(errors)];
}

function parseFinalizationRecord(value: unknown, bundleSha256: string): FinalizationRecord | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== PUBLICATION_SCHEMA_VERSION ||
    value.kind !== FINALIZATION_KIND ||
    value.bundleSha256 !== bundleSha256 ||
    !isHexSha256(value.manifestSha256) ||
    typeof value.finalizedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.finalizedAt)) ||
    !Number.isSafeInteger(value.finalizedByGithubUserId) ||
    Number(value.finalizedByGithubUserId) <= 0 ||
    !isRecord(value.files)
  ) {
    return null;
  }
  const files = {} as Record<WorkspaceHostArtifactFile, StoredFileDescriptor>;
  for (const file of WORKSPACE_HOST_ARTIFACT_FILES) {
    const raw = value.files[file];
    if (!isRecord(raw) || !isHexSha256(raw.sha256) || !Number.isSafeInteger(raw.sizeBytes) || Number(raw.sizeBytes) <= 0) {
      return null;
    }
    files[file] = { sha256: raw.sha256, sizeBytes: Number(raw.sizeBytes) };
  }
  if (files['server.tgz'].sha256 !== bundleSha256 || files['manifest.json'].sha256 !== value.manifestSha256) {
    return null;
  }
  return {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    kind: FINALIZATION_KIND,
    bundleSha256,
    manifestSha256: value.manifestSha256,
    files,
    finalizedAt: value.finalizedAt,
    finalizedByGithubUserId: Number(value.finalizedByGithubUserId),
  };
}

async function readFinalizationRecord(env: Env, bundleSha256: string): Promise<FinalizationRecord | null> {
  const object = await env.ARTIFACTS.get(finalizationKey(bundleSha256));
  if (!object) return null;
  try {
    const record = parseFinalizationRecord(JSON.parse(await object.text()), bundleSha256);
    const metadata = object.customMetadata ?? {};
    if (
      !record ||
      metadata.namespace !== 'workspace-host-v1' ||
      metadata.bundleSha256 !== bundleSha256 ||
      metadata.manifestSha256 !== record.manifestSha256 ||
      metadata.finalizedByGithubUserId !== String(record.finalizedByGithubUserId)
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

async function finalizationObjectsMatch(env: Env, record: FinalizationRecord): Promise<boolean> {
  for (const file of WORKSPACE_HOST_ARTIFACT_FILES) {
    const object = await env.ARTIFACTS.head(artifactKey(record.bundleSha256, file));
    if (!descriptorMatches(object, file, record.bundleSha256, record.files[file])) return false;
  }
  return true;
}

async function uploadArtifact(c: Context<{ Bindings: Env }>): Promise<Response> {
  const operator = await requireOperator(c);
  if (operator instanceof Response) return operator;

  const bundleSha256 = c.req.param('bundleSha256');
  const rawFile = c.req.param('file');
  if (!isHexSha256(bundleSha256)) return c.json({ error: 'invalid_bundle_sha256' }, 400);
  if (!isArtifactFile(rawFile)) return c.json({ error: 'not_found' }, 404);
  const file = rawFile;

  const declaredSha256 = c.req.header('x-artifact-sha256') ?? '';
  const declaredSize = parsePositiveInteger(c.req.header('x-artifact-size'));
  if (!isHexSha256(declaredSha256)) return c.json({ error: 'invalid_artifact_sha256' }, 400);
  if (declaredSize === null) return c.json({ error: 'invalid_artifact_size' }, 400);
  if (file === 'server.tgz' && declaredSha256 !== bundleSha256) {
    return c.json({ error: 'bundle_digest_mismatch' }, 400);
  }
  if (declaredSize > MAX_BYTES[file]) {
    return c.json({ error: 'artifact_too_large', maxBytes: MAX_BYTES[file] }, 413);
  }
  const contentLength = c.req.header('content-length');
  if (contentLength) {
    const parsedContentLength = parsePositiveInteger(contentLength);
    if (parsedContentLength === null || parsedContentLength !== declaredSize) {
      return c.json({ error: 'content_length_mismatch' }, 400);
    }
  }

  const key = artifactKey(bundleSha256, file);
  const expected = { sha256: declaredSha256, sizeBytes: declaredSize };
  const existing = await c.env.ARTIFACTS.head(key);
  if (existing) {
    if (descriptorMatches(existing, file, bundleSha256, expected)) {
      return c.json({ ok: true, file, sha256: declaredSha256, bytes: declaredSize, deduped: true });
    }
    return c.json({ error: 'artifact_conflict', file }, 409);
  }
  if (await c.env.ARTIFACTS.head(finalizationKey(bundleSha256))) {
    return c.json({ error: 'artifact_finalized' }, 409);
  }

  const body = await c.req.raw.arrayBuffer();
  if (body.byteLength !== declaredSize) return c.json({ error: 'artifact_size_mismatch' }, 400);
  const actualSha256 = await sha256Hex(body);
  if (actualSha256 !== declaredSha256) {
    return c.json({ error: 'artifact_sha256_mismatch', expected: declaredSha256, actual: actualSha256 }, 400);
  }

  const outcome = await putCreateOnly(c.env.ARTIFACTS, key, body, {
    httpMetadata: { contentType: CONTENT_TYPE[file] },
    customMetadata: metadataFor(file, bundleSha256, declaredSha256, declaredSize, operator.id),
    sha256: declaredSha256,
  });
  if (outcome === 'exists') {
    const raced = await c.env.ARTIFACTS.head(key);
    if (descriptorMatches(raced, file, bundleSha256, expected)) {
      return c.json({ ok: true, file, sha256: declaredSha256, bytes: declaredSize, deduped: true });
    }
    return c.json({ error: 'artifact_conflict', file }, 409);
  }
  return c.json(
    { ok: true, file, sha256: declaredSha256, bytes: declaredSize, deduped: false },
    201,
  );
}

async function finalizeArtifact(c: Context<{ Bindings: Env }>): Promise<Response> {
  const operator = await requireOperator(c);
  if (operator instanceof Response) return operator;
  const bundleSha256 = c.req.param('bundleSha256');
  if (!isHexSha256(bundleSha256)) return c.json({ error: 'invalid_bundle_sha256' }, 400);

  const markerHead = await c.env.ARTIFACTS.head(finalizationKey(bundleSha256));
  if (markerHead) {
    const existing = await readFinalizationRecord(c.env, bundleSha256);
    if (!existing || !(await finalizationObjectsMatch(c.env, existing))) {
      return c.json({ error: 'finalization_conflict' }, 409);
    }
    return c.json({ ok: true, bundleSha256, manifestSha256: existing.manifestSha256, deduped: true });
  }

  const stored = {} as Record<WorkspaceHostArtifactFile, StoredFileDescriptor>;
  const missing: WorkspaceHostArtifactFile[] = [];
  for (const file of WORKSPACE_HOST_ARTIFACT_FILES) {
    const descriptor = descriptorFromObject(await c.env.ARTIFACTS.head(artifactKey(bundleSha256, file)), file, bundleSha256);
    if (!descriptor) missing.push(file);
    else stored[file] = descriptor;
  }
  if (missing.length > 0) return c.json({ error: 'uploads_incomplete', missing }, 409);

  const manifestObject = await c.env.ARTIFACTS.get(artifactKey(bundleSha256, 'manifest.json'));
  if (!manifestObject) return c.json({ error: 'uploads_incomplete', missing: ['manifest.json'] }, 409);
  const manifestBody = await manifestObject.arrayBuffer();
  const actualManifestSha256 = await sha256Hex(manifestBody);
  if (
    actualManifestSha256 !== stored['manifest.json'].sha256 ||
    manifestBody.byteLength !== stored['manifest.json'].sizeBytes
  ) {
    return c.json({ error: 'manifest_storage_mismatch' }, 409);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBody));
  } catch {
    return c.json({ error: 'invalid_manifest_json' }, 400);
  }
  const errors = validatePublicationManifest(manifest, bundleSha256, stored);
  if (errors.length > 0) return c.json({ error: 'invalid_manifest', errors }, 400);

  const record: FinalizationRecord = {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    kind: FINALIZATION_KIND,
    bundleSha256,
    manifestSha256: actualManifestSha256,
    files: stored,
    finalizedAt: new Date().toISOString(),
    finalizedByGithubUserId: operator.id,
  };
  const markerBody = JSON.stringify(record);
  const outcome = await putCreateOnly(c.env.ARTIFACTS, finalizationKey(bundleSha256), markerBody, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: {
      namespace: 'workspace-host-v1',
      bundleSha256,
      manifestSha256: actualManifestSha256,
      finalizedByGithubUserId: String(operator.id),
    },
  });
  if (outcome === 'exists') {
    const raced = await readFinalizationRecord(c.env, bundleSha256);
    if (!raced || raced.manifestSha256 !== actualManifestSha256) {
      return c.json({ error: 'finalization_conflict' }, 409);
    }
    return c.json({ ok: true, bundleSha256, manifestSha256: actualManifestSha256, deduped: true });
  }
  return c.json({ ok: true, bundleSha256, manifestSha256: actualManifestSha256, deduped: false }, 201);
}

async function serveArtifact(
  c: Context<{ Bindings: Env }>,
  headOnly: boolean,
): Promise<Response> {
  const bundleSha256 = c.req.param('bundleSha256');
  const rawFile = c.req.param('file');
  if (!isHexSha256(bundleSha256) || !isArtifactFile(rawFile)) {
    return c.json({ error: 'not_found' }, 404);
  }
  const record = await readFinalizationRecord(c.env, bundleSha256);
  if (!record) return c.json({ error: 'not_found' }, 404);

  const key = artifactKey(bundleSha256, rawFile);
  const object = headOnly ? await c.env.ARTIFACTS.head(key) : await c.env.ARTIFACTS.get(key);
  if (!descriptorMatches(object, rawFile, bundleSha256, record.files[rawFile])) {
    return c.json({ error: 'not_found' }, 404);
  }
  const descriptor = record.files[rawFile];
  const headers = new Headers();
  object!.writeHttpMetadata(headers);
  headers.set('cache-control', WORKSPACE_HOST_PUBLIC_CACHE_CONTROL);
  headers.set('content-type', CONTENT_TYPE[rawFile]);
  headers.set('content-length', String(descriptor.sizeBytes));
  headers.set('content-disposition', `attachment; filename="${rawFile}"`);
  headers.set('x-artifact-sha256', descriptor.sha256);
  headers.set('x-content-type-options', 'nosniff');
  if (object!.httpEtag) headers.set('etag', object!.httpEtag);

  const body = !headOnly && 'body' in object! ? (object as R2ObjectBody).body : null;
  return new Response(body, { status: 200, headers });
}

export function workspaceHostArtifactsRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  const adminPath = '/admin/artifacts/workspace-host/sha256/:bundleSha256/:file';
  const publicPath = '/artifacts/workspace-host/sha256/:bundleSha256/:file';

  app.put(adminPath, uploadArtifact);
  app.post('/admin/artifacts/workspace-host/sha256/:bundleSha256/finalize', finalizeArtifact);
  app.get(publicPath, (c) => serveArtifact(c, false));
  app.on('HEAD', publicPath, (c) => serveArtifact(c, true));
  return app;
}
