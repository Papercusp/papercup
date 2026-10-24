'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("WORKSPACE_HOST_ARTIFACT_PREFIX", () => { try { return WORKSPACE_HOST_ARTIFACT_PREFIX } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_ARTIFACT_FILES", () => { try { return WORKSPACE_HOST_ARTIFACT_FILES } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_PUBLIC_CACHE_CONTROL", () => { try { return WORKSPACE_HOST_PUBLIC_CACHE_CONTROL } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES", () => { try { return WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_MULTIPART_MAX_PARTS", () => { try { return WORKSPACE_HOST_MULTIPART_MAX_PARTS } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_MULTIPART_MAX_BUNDLE_BYTES", () => { try { return WORKSPACE_HOST_MULTIPART_MAX_BUNDLE_BYTES } catch {} });
__vite_ssr_exportName__("workspaceHostArtifactsRoute", () => { try { return workspaceHostArtifactsRoute } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/artifact-registry/src/index.ts", {"importedNames":["isHexSha256","sha256Hex"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/index.ts", {"importedNames":["deriveWorkspaceHostCanonicalArtifactUrls","validateWorkspaceHostImageArtifact"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/index.js", {"importedNames":["Hono"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/src/routes/admin.ts", {"importedNames":["requireOperator"]});




const WORKSPACE_HOST_ARTIFACT_PREFIX = "artifacts/workspace-host/sha256";
const WORKSPACE_HOST_ARTIFACT_FILES = [
  "server.tgz",
  "server.tgz.minisig",
  "manifest.json"
];
const WORKSPACE_HOST_PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";
const FINALIZATION_FILE = ".finalized.json";
const PUBLICATION_SCHEMA_VERSION = 1;
const PUBLICATION_KIND = "papercusp-workspace-host-release";
const FINALIZATION_KIND = "papercusp-workspace-host-finalization";
const ARTIFACT_TRUST_VERSION = "artifact-trust-v1";
const MULTIPART_STATE_SCHEMA_VERSION = 1;
const MULTIPART_STATE_KIND = "papercusp-workspace-host-multipart-upload";
const MULTIPART_STATE_NAMESPACE = "workspace-host-multipart-v1";
const MULTIPART_PART_RECEIPT_KIND = "papercusp-workspace-host-multipart-part-receipt";
const MULTIPART_PART_RECEIPT_NAMESPACE = "workspace-host-multipart-part-v1";
const MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024;
const WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES = 32 * 1024 * 1024;
const WORKSPACE_HOST_MULTIPART_MAX_PARTS = 1024;
const WORKSPACE_HOST_MULTIPART_MAX_BUNDLE_BYTES = WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES * WORKSPACE_HOST_MULTIPART_MAX_PARTS;
const MULTIPART_CONTROL_MAX_BYTES = 512 * 1024;
const MAX_BYTES = {
  "server.tgz": 64 * 1024 * 1024,
  "server.tgz.minisig": 64 * 1024,
  "manifest.json": 1024 * 1024,
  "sbom.cdx.json": 16 * 1024 * 1024
};
const CONTENT_TYPE = {
  "server.tgz": "application/gzip",
  "server.tgz.minisig": "text/plain; charset=utf-8",
  "manifest.json": "application/json; charset=utf-8",
  "sbom.cdx.json": "application/vnd.cyclonedx+json; charset=utf-8"
};
const REQUIRED_TRUST_EVIDENCE = [
  "signature",
  "sbom",
  "vulnerability-scan",
  "secret-scan",
  "provenance-attestation"
];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isArtifactFile(value) {
  return typeof value === "string" && (WORKSPACE_HOST_ARTIFACT_FILES.includes(value) || value === "sbom.cdx.json");
}
function artifactPrefix(bundleSha256) {
  return `${WORKSPACE_HOST_ARTIFACT_PREFIX}/${bundleSha256}`;
}
function artifactKey(bundleSha256, file) {
  return `${artifactPrefix(bundleSha256)}/${file}`;
}
function finalizationKey(bundleSha256) {
  return `${artifactPrefix(bundleSha256)}/${FINALIZATION_FILE}`;
}
function multipartStateKey(bundleSha256, uploadId) {
  return `${artifactPrefix(bundleSha256)}/.multipart/${encodeURIComponent(uploadId)}.json`;
}
function multipartPartReceiptKey(bundleSha256, uploadId, partNumber) {
  return `${artifactPrefix(bundleSha256)}/.multipart/${encodeURIComponent(uploadId)}/parts/${partNumber}.json`;
}
function multipartStateMatches(state, expected) {
  return state.bundleSha256 === expected.bundleSha256 && state.uploadId === expected.uploadId && state.sizeBytes === expected.sizeBytes && state.createdByGithubUserId === expected.createdByGithubUserId && state.parts.length === expected.parts.length && state.parts.every((part, index) => {
    const wanted = expected.parts[index];
    return wanted !== void 0 && part.partNumber === wanted.partNumber && part.sha256 === wanted.sha256 && part.sizeBytes === wanted.sizeBytes;
  });
}
function parsePositiveInteger(value) {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function isMultipartUploadId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function isR2MultipartUploadId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(value);
}
function r2ErrorCode(error) {
  if (!isRecord(error) && !(error instanceof Error)) return null;
  const explicit = isRecord(error) && typeof error.code === "number" ? error.code : null;
  if (explicit !== null && Number.isSafeInteger(explicit)) return explicit;
  const message = error instanceof Error ? error.message : isRecord(error) && typeof error.message === "string" ? error.message : "";
  const match = message.match(/\((\d+)\)\s*$/);
  return match ? Number(match[1]) : null;
}
function multipartStorageFailure(c, error, phase) {
  const code = r2ErrorCode(error);
  if (code === 10024) return c.json({ error: "multipart_upload_not_found" }, 404);
  if (code === 10025) return c.json({ error: "multipart_upload_incomplete" }, 409);
  if (code === 10011 || code === 10048) {
    return c.json({ error: "multipart_parts_invalid" }, 400);
  };
  if (code === 10058) return c.json({ error: "artifact_storage_rate_limited" }, 429);
  return c.json({ error: "artifact_storage_unavailable", phase }, 502);
}
async function readBoundedJson(request, maxBytes) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const parsedLength = parsePositiveInteger(declaredLength);
    if (parsedLength === null || parsedLength > maxBytes) {
      return { ok: false, error: "request_too_large" };
    }
  };
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return { ok: false, error: "invalid_json" };
  if (body.byteLength > maxBytes) return { ok: false, error: "request_too_large" };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(body)) };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}
function parseMultipartPlan(value, expectedSizeBytes) {
  const errors = [];
  if (!isRecord(value) || !Array.isArray(value.parts)) {
    return { parts: [], errors: ["parts must be an array"] };
  };
  for (const key of Object.keys(value)) {
    if (key !== "parts") errors.push(`unexpected multipart plan field '${key}'`);
  };
  if (value.parts.length === 0 || value.parts.length > WORKSPACE_HOST_MULTIPART_MAX_PARTS) {
    errors.push(`parts must contain 1-${WORKSPACE_HOST_MULTIPART_MAX_PARTS} entries`);
  };
  const parts = [];
  for (let index = 0; index < value.parts.length; index += 1) {
    const candidate = value.parts[index];
    if (!isRecord(candidate)) {
      errors.push(`parts[${index}] must be an object`);
      continue;
    };
    for (const key of Object.keys(candidate)) {
      if (!["partNumber", "sha256", "sizeBytes"].includes(key)) {
        errors.push(`unexpected parts[${index}] field '${key}'`);
      }
    };
    const partNumber = Number(candidate.partNumber);
    const sizeBytes = Number(candidate.sizeBytes);
    if (!Number.isSafeInteger(partNumber) || partNumber !== index + 1) {
      errors.push(`parts[${index}].partNumber must equal ${index + 1}`);
    };
    if (!(0,__vite_ssr_import_0__.isHexSha256)(candidate.sha256)) {
      errors.push(`parts[${index}].sha256 must be a lowercase SHA-256 digest`);
    };
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES) {
      errors.push(
        `parts[${index}].sizeBytes must be between 1 and ${WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES}`
      );
    };
    if (Number.isSafeInteger(partNumber) && (0,__vite_ssr_import_0__.isHexSha256)(candidate.sha256) && Number.isSafeInteger(sizeBytes) && sizeBytes > 0 && sizeBytes <= WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES) {
      parts.push({ partNumber, sha256: candidate.sha256, sizeBytes });
    }
  };
  if (parts.length === value.parts.length && parts.length > 0) {
    const regularPartBytes = parts[0].sizeBytes;
    if (parts.length > 1 && regularPartBytes < MULTIPART_MIN_PART_BYTES) {
      errors.push(`every non-final part must be at least ${MULTIPART_MIN_PART_BYTES} bytes`);
    };
    for (let index = 0; index < parts.length - 1; index += 1) {
      if (parts[index].sizeBytes !== regularPartBytes) {
        errors.push("all non-final multipart parts must have identical sizes");
        break;
      }
    };
    if (parts.at(-1).sizeBytes > regularPartBytes) {
      errors.push("the final multipart part cannot exceed the regular part size");
    };
    const totalBytes = parts.reduce((sum, part) => sum + part.sizeBytes, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes !== expectedSizeBytes) {
      errors.push("multipart part sizes must sum to x-artifact-size");
    }
  };
  return { parts, errors: [...new Set(errors)] };
}
function parseMultipartState(value, bundleSha256, uploadId) {
  if (!isRecord(value) || value.schemaVersion !== MULTIPART_STATE_SCHEMA_VERSION || value.kind !== MULTIPART_STATE_KIND || value.bundleSha256 !== bundleSha256 || value.uploadId !== uploadId || !isR2MultipartUploadId(value.r2UploadId) || !Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) <= 0 || Number(value.sizeBytes) > WORKSPACE_HOST_MULTIPART_MAX_BUNDLE_BYTES || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isSafeInteger(value.createdByGithubUserId) || Number(value.createdByGithubUserId) <= 0) {
    return null;
  };
  const plan = parseMultipartPlan({ parts: value.parts }, Number(value.sizeBytes));
  if (plan.errors.length > 0) return null;
  return {
    schemaVersion: MULTIPART_STATE_SCHEMA_VERSION,
    kind: MULTIPART_STATE_KIND,
    bundleSha256,
    uploadId,
    r2UploadId: value.r2UploadId,
    sizeBytes: Number(value.sizeBytes),
    createdAt: value.createdAt,
    createdByGithubUserId: Number(value.createdByGithubUserId),
    parts: plan.parts
  };
}
async function readMultipartState(env, bundleSha256, uploadId) {
  const object = await env.ARTIFACTS.get(multipartStateKey(bundleSha256, uploadId));
  if (!object || object.size > MULTIPART_CONTROL_MAX_BYTES) return null;
  try {
    const state = parseMultipartState(JSON.parse(await object.text()), bundleSha256, uploadId);
    const metadata = object.customMetadata ?? {};
    if (!state || metadata.namespace !== MULTIPART_STATE_NAMESPACE || metadata.bundleSha256 !== bundleSha256 || metadata.uploadId !== uploadId || metadata.createdByGithubUserId !== String(state.createdByGithubUserId)) {
      return null;
    };
    return state;
  } catch {
    return null;
  }
}
function parseMultipartPartReceipt(value, expected) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== MULTIPART_PART_RECEIPT_KIND || value.state !== "intent" && value.state !== "committed" || value.bundleSha256 !== expected.bundleSha256 || value.uploadId !== expected.uploadId || value.partNumber !== expected.partNumber || !(0,__vite_ssr_import_0__.isHexSha256)(value.sha256) || !Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) <= 0 || !Number.isSafeInteger(value.createdByGithubUserId) || Number(value.createdByGithubUserId) <= 0 || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return null;
  if (value.state === "committed") {
    if (typeof value.etag !== "string" || value.etag.length === 0 || value.etag.length > 512 || typeof value.committedAt !== "string" || !Number.isFinite(Date.parse(value.committedAt))) return null;
  } else if (value.etag !== void 0 || value.committedAt !== void 0) {
    return null;
  };
  return value;
}
async function readMultipartPartReceipt(env, expected) {
  const object = await env.ARTIFACTS.get(
    multipartPartReceiptKey(expected.bundleSha256, expected.uploadId, expected.partNumber)
  );
  if (!object || object.size > MULTIPART_CONTROL_MAX_BYTES) return null;
  try {
    const receipt = parseMultipartPartReceipt(JSON.parse(await object.text()), expected);
    const metadata = object.customMetadata ?? {};
    if (!receipt || metadata.namespace !== MULTIPART_PART_RECEIPT_NAMESPACE || metadata.bundleSha256 !== expected.bundleSha256 || metadata.uploadId !== expected.uploadId || metadata.partNumber !== String(expected.partNumber) || metadata.createdByGithubUserId !== String(receipt.createdByGithubUserId)) return null;
    return receipt;
  } catch {
    return null;
  }
}
function multipartPartReceiptMatches(receipt, expected) {
  return receipt.partNumber === expected.partNumber && receipt.sha256 === expected.sha256 && receipt.sizeBytes === expected.sizeBytes && receipt.createdByGithubUserId === expected.createdByGithubUserId;
}
function parseCompletionParts(value, plan) {
  if (!isRecord(value) || !Array.isArray(value.parts)) {
    return { parts: [], error: "parts must be an array" };
  };
  for (const key of Object.keys(value)) {
    if (key !== "parts") return { parts: [], error: `unexpected completion field '${key}'` };
  };
  if (value.parts.length !== plan.length) {
    return { parts: [], error: "completion must include every planned part exactly once" };
  };
  const parts = [];
  for (let index = 0; index < value.parts.length; index += 1) {
    const candidate = value.parts[index];
    if (!isRecord(candidate)) return { parts: [], error: `parts[${index}] must be an object` };
    for (const key of Object.keys(candidate)) {
      if (!["partNumber", "etag"].includes(key)) {
        return { parts: [], error: `unexpected parts[${index}] field '${key}'` };
      }
    };
    if (candidate.partNumber !== plan[index].partNumber) {
      return { parts: [], error: `parts[${index}].partNumber must equal ${plan[index].partNumber}` };
    };
    if (typeof candidate.etag !== "string" || candidate.etag.length === 0 || candidate.etag.length > 512) {
      return { parts: [], error: `parts[${index}].etag is invalid` };
    };
    parts.push({ partNumber: plan[index].partNumber, etag: candidate.etag });
  };
  return { parts, error: null };
}
function metadataFor(file, bundleSha256, fileSha256, sizeBytes, githubUserId) {
  return {
    namespace: "workspace-host-v1",
    bundleSha256,
    file,
    fileSha256,
    sizeBytes: String(sizeBytes),
    uploadedByGithubUserId: String(githubUserId)
  };
}
function descriptorFromObject(object, file, bundleSha256) {
  if (!object) return null;
  const metadata = object.customMetadata ?? {};
  const sizeBytes = Number(metadata.sizeBytes);
  if (metadata.namespace !== "workspace-host-v1" || metadata.bundleSha256 !== bundleSha256 || metadata.file !== file || !(0,__vite_ssr_import_0__.isHexSha256)(metadata.fileSha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes !== object.size) {
    return null;
  };
  if (file === "server.tgz" && metadata.fileSha256 !== bundleSha256) return null;
  return { sha256: metadata.fileSha256, sizeBytes };
}
function descriptorMatches(object, file, bundleSha256, expected) {
  const actual = descriptorFromObject(object, file, bundleSha256);
  return actual?.sha256 === expected.sha256 && actual.sizeBytes === expected.sizeBytes;
}
async function putCreateOnly(bucket, key, body, options) {
  try {
    const result = await bucket.put(key, body, {
      ...options,
      onlyIf: { etagDoesNotMatch: "*" }
    });
    return result ? "created" : "exists";
  } catch (error) {
    if (await bucket.head(key)) return "exists";
    throw error;
  }
}
const SAFE_SECRET_FIELD_NAMES = /* @__PURE__ */ new Set([
  "maxSecretFindings",
  "signingPublicKey",
  "signingKeySha256"
]);
const SECRET_FIELD = /(?:^|[-_.])(password|passwd|credential|credentials|secret|token|private[-_]?key|api[-_]?key)(?:$|[-_.])/i;
const SECRET_VALUE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/;
function secretMaterialError(value, path = "manifest") {
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) return `${path} contains secret-shaped material`;
    try {
      const url = new URL(value);
      if ((url.protocol === "https:" || url.protocol === "http:") && (url.username || url.password)) {
        return `${path} contains URL credentials`;
      }
    } catch {
    };
    return null;
  };
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = secretMaterialError(value[index], `${path}[${index}]`);
      if (error) return error;
    };
    return null;
  };
  if (!isRecord(value)) return null;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
    if (!SAFE_SECRET_FIELD_NAMES.has(key) && SECRET_FIELD.test(normalized)) {
      return `${path}.${key} is a secret-shaped field`;
    };
    const error = secretMaterialError(nested, `${path}.${key}`);
    if (error) return error;
  };
  return null;
}
function validTool(value) {
  return isRecord(value) && typeof value.name === "string" && value.name.trim().length > 0 && typeof value.version === "string" && value.version.trim().length > 0;
}
function validateTrustReport(value, bundleSha256, bundle, signature, signingKeySha256) {
  const errors = [];
  if (!isRecord(value)) return ["trustReport must be an object"];
  if (value.version !== ARTIFACT_TRUST_VERSION) {
    errors.push(`trustReport.version must be '${ARTIFACT_TRUST_VERSION}'`);
  };
  if (value.trusted !== true) errors.push("trustReport.trusted must be true");
  if (!Array.isArray(value.failures) || value.failures.length !== 0) {
    errors.push("trustReport.failures must be an empty array");
  };
  const subject = value.subject;
  if (!isRecord(subject) || subject.sha256 !== bundleSha256 || subject.bytes !== bundle.sizeBytes || subject.signed !== true || typeof subject.path !== "string" || subject.path.trim().length === 0 || typeof subject.name !== "string" || subject.name.trim().length === 0) {
    errors.push("trustReport.subject must bind the signed bundle digest and exact byte count");
  };
  const policy = value.policy;
  let maxAttestationAgeMs = null;
  if (!isRecord(policy) || policy.maxSecretFindings !== 0 || !["low", "medium", "high", "critical"].includes(String(policy.denyVulnerabilitiesAtOrAbove)) || !Number.isSafeInteger(policy.maxAttestationAgeMs) || Number(policy.maxAttestationAgeMs) <= 0) {
    errors.push("trustReport.policy must be explicit and require zero secret findings");
  } else {
    maxAttestationAgeMs = Number(policy.maxAttestationAgeMs);
  };
  if (!Array.isArray(value.evidence)) {
    errors.push("trustReport.evidence must contain every required evidence class");
    return errors;
  };
  const seen = /* @__PURE__ */ new Set();
  let sbomSha256 = null;
  let scannedSbomSha256 = null;
  for (const candidate of value.evidence) {
    if (!isRecord(candidate) || typeof candidate.kind !== "string") {
      errors.push("every trust evidence entry must be an object with a kind");
      continue;
    };
    const kind = candidate.kind;
    if (seen.has(kind)) errors.push(`trustReport.evidence contains duplicate '${kind}'`);
    seen.add(kind);
    if (candidate.subjectSha256 !== bundleSha256) {
      errors.push(`${kind} evidence is not bound to the bundle digest`);
    };
    if (!validTool(candidate.tool)) errors.push(`${kind} evidence lacks exact tool metadata`);
    if (kind === "signature") {
      if (candidate.valid !== true || candidate.signatureSha256 !== signature.sha256 || candidate.signingKeySha256 !== signingKeySha256) {
        errors.push("signature evidence must verify the uploaded signature and pinned signing key");
      }
    } else if (kind === "sbom") {
      if (typeof candidate.format !== "string" || !(0,__vite_ssr_import_0__.isHexSha256)(candidate.documentSha256) || !Number.isSafeInteger(candidate.componentCount) || Number(candidate.componentCount) < 0) {
        errors.push("sbom evidence is malformed");
      } else {
        sbomSha256 = candidate.documentSha256;
      }
    } else if (kind === "vulnerability-scan") {
      if (!(0,__vite_ssr_import_0__.isHexSha256)(candidate.sbomSha256) || !Array.isArray(candidate.findings)) {
        errors.push("vulnerability-scan evidence is malformed");
      } else {
        scannedSbomSha256 = candidate.sbomSha256;
      }
    } else if (kind === "secret-scan") {
      if (!Array.isArray(candidate.findings) || candidate.findings.length !== 0) {
        errors.push("secret-scan evidence must report zero findings");
      }
    } else if (kind === "provenance-attestation") {
      if (candidate.valid !== true || typeof candidate.predicateType !== "string" || candidate.predicateType.trim().length === 0 || !(0,__vite_ssr_import_0__.isHexSha256)(candidate.attestationSha256) || typeof candidate.issuedAt !== "string" || !Number.isFinite(Date.parse(candidate.issuedAt))) {
        errors.push("provenance-attestation evidence is malformed or invalid");
      } else if (maxAttestationAgeMs !== null) {
        const ageMs = Date.now() - Date.parse(candidate.issuedAt);
        if (ageMs < 0 || ageMs > maxAttestationAgeMs) {
          errors.push("provenance-attestation evidence is outside the declared freshness policy");
        }
      }
    }
  };
  for (const kind of REQUIRED_TRUST_EVIDENCE) {
    if (!seen.has(kind)) errors.push(`trustReport.evidence is missing '${kind}'`);
  };
  if (value.evidence.length !== REQUIRED_TRUST_EVIDENCE.length) {
    errors.push("trustReport.evidence must contain exactly the five required evidence classes");
  };
  if (sbomSha256 && scannedSbomSha256 && sbomSha256 !== scannedSbomSha256) {
    errors.push("vulnerability-scan evidence is bound to a different SBOM");
  };
  return errors;
}
function fileDescriptor(value, expectedName) {
  if (!isRecord(value) || value.name !== expectedName || !(0,__vite_ssr_import_0__.isHexSha256)(value.sha256) || !Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) <= 0) {
    return null;
  };
  return { sha256: value.sha256, sizeBytes: Number(value.sizeBytes) };
}
function validatePublicationManifest(value, bundleSha256, stored) {
  const errors = [];
  if (!isRecord(value)) return ["manifest must be a JSON object"];
  const allowedTopLevel = /* @__PURE__ */ new Set(["schemaVersion", "kind", "artifact", "files", "trustReport"]);
  for (const key of Object.keys(value)) {
    if (!allowedTopLevel.has(key)) errors.push(`unexpected manifest field '${key}'`);
  };
  if (value.schemaVersion !== PUBLICATION_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${PUBLICATION_SCHEMA_VERSION}`);
  };
  if (value.kind !== PUBLICATION_KIND) errors.push(`kind must be '${PUBLICATION_KIND}'`);
  const secretError = secretMaterialError(value);
  if (secretError) errors.push(secretError);
  const files = value.files;
  const bundle = isRecord(files) ? fileDescriptor(files.bundle, "server.tgz") : null;
  const signature = isRecord(files) ? fileDescriptor(files.signature, "server.tgz.minisig") : null;
  if (!bundle) errors.push("files.bundle must describe server.tgz with a digest and positive size");
  if (!signature) {
    errors.push("files.signature must describe server.tgz.minisig with a digest and positive size");
  };
  if (bundle && (bundle.sha256 !== bundleSha256 || bundle.sizeBytes !== stored["server.tgz"].sizeBytes)) {
    errors.push("files.bundle does not match the uploaded content-addressed bundle");
  };
  if (signature && (signature.sha256 !== stored["server.tgz.minisig"].sha256 || signature.sizeBytes !== stored["server.tgz.minisig"].sizeBytes)) {
    errors.push("files.signature does not match the uploaded detached signature");
  };
  let artifact = null;
  if (!isRecord(value.artifact)) {
    errors.push("artifact must be a WorkspaceHostImageArtifact object");
  } else {
    artifact = value.artifact;
    try {
      errors.push(...(0,__vite_ssr_import_1__.validateWorkspaceHostImageArtifact)(artifact).map((error) => `artifact: ${error}`));
    } catch (error) {
      errors.push(`artifact validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (artifact) {
    const canonical = (0,__vite_ssr_import_1__.deriveWorkspaceHostCanonicalArtifactUrls)(bundleSha256);
    if (artifact.release.bundleSha256 !== bundleSha256 || artifact.buildManifest.releaseArtifact.sha256 !== bundleSha256) {
      errors.push("artifact release/build digests must equal the addressed bundle digest");
    };
    if (artifact.buildManifest.releaseArtifact.sizeBytes !== stored["server.tgz"].sizeBytes) {
      errors.push("artifact build manifest size does not equal the uploaded bundle size");
    };
    if (artifact.release.bundleUrl !== canonical.bundleUrl || artifact.release.signatureUrl !== canonical.signatureUrl) {
      errors.push("artifact release URLs must equal the D-105 digest-derived Cupboard URLs");
    };
    if (artifact.lifecycle.state !== "active") errors.push("artifact lifecycle must be active at publication");
    if (bundle && signature) {
      errors.push(
        ...validateTrustReport(
          value.trustReport,
          bundleSha256,
          bundle,
          signature,
          artifact.release.signingKeySha256
        )
      );
    }
  };
  return [...new Set(errors)];
}
function parseFinalizationRecord(value, bundleSha256) {
  if (!isRecord(value) || value.schemaVersion !== PUBLICATION_SCHEMA_VERSION || value.kind !== FINALIZATION_KIND || value.bundleSha256 !== bundleSha256 || !(0,__vite_ssr_import_0__.isHexSha256)(value.manifestSha256) || typeof value.finalizedAt !== "string" || !Number.isFinite(Date.parse(value.finalizedAt)) || !Number.isSafeInteger(value.finalizedByGithubUserId) || Number(value.finalizedByGithubUserId) <= 0 || !isRecord(value.files)) {
    return null;
  };
  const files = {};
  for (const file of WORKSPACE_HOST_ARTIFACT_FILES) {
    const raw = value.files[file];
    if (!isRecord(raw) || !(0,__vite_ssr_import_0__.isHexSha256)(raw.sha256) || !Number.isSafeInteger(raw.sizeBytes) || Number(raw.sizeBytes) <= 0) {
      return null;
    };
    files[file] = { sha256: raw.sha256, sizeBytes: Number(raw.sizeBytes) };
  };
  if (files["server.tgz"].sha256 !== bundleSha256 || files["manifest.json"].sha256 !== value.manifestSha256) {
    return null;
  };
  return {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    kind: FINALIZATION_KIND,
    bundleSha256,
    manifestSha256: value.manifestSha256,
    files,
    finalizedAt: value.finalizedAt,
    finalizedByGithubUserId: Number(value.finalizedByGithubUserId)
  };
}
async function readFinalizationRecord(env, bundleSha256) {
  const object = await env.ARTIFACTS.get(finalizationKey(bundleSha256));
  if (!object) return null;
  try {
    const record = parseFinalizationRecord(JSON.parse(await object.text()), bundleSha256);
    const metadata = object.customMetadata ?? {};
    if (!record || metadata.namespace !== "workspace-host-v1" || metadata.bundleSha256 !== bundleSha256 || metadata.manifestSha256 !== record.manifestSha256 || metadata.finalizedByGithubUserId !== String(record.finalizedByGithubUserId)) {
      return null;
    };
    return record;
  } catch {
    return null;
  }
}
async function finalizationObjectsMatch(env, record) {
  for (const file of WORKSPACE_HOST_ARTIFACT_FILES) {
    const object = await env.ARTIFACTS.head(artifactKey(record.bundleSha256, file));
    if (!descriptorMatches(object, file, record.bundleSha256, record.files[file])) return false;
  };
  return true;
}
async function finalizedSbomDigest(env, bundleSha256) {
  const record = await readFinalizationRecord(env, bundleSha256);
  if (!record) return null;
  const object = await env.ARTIFACTS.get(artifactKey(bundleSha256, "manifest.json"));
  if (!descriptorMatches(object, "manifest.json", bundleSha256, record.files["manifest.json"])) return null;
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== record.files["manifest.json"].sizeBytes || await (0,__vite_ssr_import_0__.sha256Hex)(bytes) !== record.manifestSha256) return null;
  try {
    const manifest = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(manifest) || !isRecord(manifest.trustReport) || !Array.isArray(manifest.trustReport.evidence)) return null;
    const sboms = manifest.trustReport.evidence.filter((entry) => isRecord(entry) && entry.kind === "sbom");
    const sbom = sboms[0];
    return sboms.length === 1 && isRecord(sbom) && sbom.subjectSha256 === bundleSha256 && sbom.format === "cyclonedx-json" && (0,__vite_ssr_import_0__.isHexSha256)(sbom.documentSha256) ? sbom.documentSha256 : null;
  } catch {
    return null;
  }
}
async function uploadArtifact(c) {
  const operator = await (0,__vite_ssr_import_3__.requireOperator)(c);
  if (operator instanceof Response) return operator;
  const bundleSha256 = c.req.param("bundleSha256");
  const rawFile = c.req.param("file");
  if (!(0,__vite_ssr_import_0__.isHexSha256)(bundleSha256)) return c.json({ error: "invalid_bundle_sha256" }, 400);
  if (!isArtifactFile(rawFile)) return c.json({ error: "not_found" }, 404);
  const file = rawFile;
  const declaredSha256 = c.req.header("x-artifact-sha256") ?? "";
  const declaredSize = parsePositiveInteger(c.req.header("x-artifact-size"));
  if (!(0,__vite_ssr_import_0__.isHexSha256)(declaredSha256)) return c.json({ error: "invalid_artifact_sha256" }, 400);
  if (declaredSize === null) return c.json({ error: "invalid_artifact_size" }, 400);
  if (file === "server.tgz" && declaredSha256 !== bundleSha256) {
    return c.json({ error: "bundle_digest_mismatch" }, 400);
  };
  if (declaredSize > MAX_BYTES[file]) {
    if (file === "server.tgz") {
      return c.json(
        {
          error: "artifact_too_large",
          maxBytes: MAX_BYTES[file],
          multipart: {
            endpoint: `/admin/artifacts/workspace-host/sha256/${bundleSha256}/server.tgz/multipart`,
            maxPartBytes: WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES,
            maxParts: WORKSPACE_HOST_MULTIPART_MAX_PARTS,
            maxBundleBytes: WORKSPACE_HOST_MULTIPART_MAX_BUNDLE_BYTES
          }
        },
        413
      );
    };
    return c.json({ error: "artifact_too_large", maxBytes: MAX_BYTES[file] }, 413);
  };
  const contentLength = c.req.header("content-length");
  if (contentLength) {
    const parsedContentLength = parsePositiveInteger(contentLength);
    if (parsedContentLength === null || parsedContentLength !== declaredSize) {
      return c.json({ error: "content_length_mismatch" }, 400);
    }
  };
  if (file === "sbom.cdx.json") {
    const boundDigest = await finalizedSbomDigest(c.env, bundleSha256);
    if (!boundDigest) return c.json({ error: "finalized_sbom_binding_required" }, 409);
    if (declaredSha256 !== boundDigest) return c.json({ error: "sbom_binding_mismatch" }, 409);
  };
  const key = artifactKey(bundleSha256, file);
  const expected = { sha256: declaredSha256, sizeBytes: declaredSize };
  const existing = await c.env.ARTIFACTS.head(key);
  if (existing) {
    if (descriptorMatches(existing, file, bundleSha256, expected)) {
      return c.json({ ok: true, file, sha256: declaredSha256, bytes: declaredSize, deduped: true });
    };
    return c.json({ error: "artifact_conflict", file }, 409);
  };
  if (file !== "sbom.cdx.json" && await c.env.ARTIFACTS.head(finalizationKey(bundleSha256))) {
    return c.json({ error: "artifact_finalized" }, 409);
  };
  const body = await c.req.raw.arrayBuffer();
  if (body.byteLength !== declaredSize) return c.json({ error: "artifact_size_mismatch" }, 400);
  const actualSha256 = await (0,__vite_ssr_import_0__.sha256Hex)(body);
  if (actualSha256 !== declaredSha256) {
    return c.json({ error: "artifact_sha256_mismatch", expected: declaredSha256, actual: actualSha256 }, 400);
  };
  const outcome = await putCreateOnly(c.env.ARTIFACTS, key, body, {
    httpMetadata: { contentType: CONTENT_TYPE[file] },
    customMetadata: metadataFor(file, bundleSha256, declaredSha256, declaredSize, operator.id),
    sha256: declaredSha256
  });
  if (outcome === "exists") {
    const raced = await c.env.ARTIFACTS.head(key);
    if (descriptorMatches(raced, file, bundleSha256, expected)) {
      return c.json({ ok: true, file, sha256: declaredSha256, bytes: declaredSize, deduped: true });
    };
    return c.json({ error: "artifact_conflict", file }, 409);
  };
  return c.json(
    { ok: true, file, sha256: declaredSha256, bytes: declaredSize, deduped: false },
    201
  );
}
async function initiateMultipartArtifact(c) {
  const operator = await (0,__vite_ssr_import_3__.requireOperator)(c);
  if (operator instanceof Response) return operator;
  const bundleSha256 = c.req.param("bundleSha256");
  if (!(0,__vite_ssr_import_0__.isHexSha256)(bundleSha256)) return c.json({ error: "invalid_bundle_sha256" }, 400);
  const declaredSha256 = c.req.header("x-artifact-sha256") ?? "";
  const declaredSize = parsePositiveInteger(c.req.header("x-artifact-size"));
  if (!(0,__vite_ssr_import_0__.isHexSha256)(declaredSha256)) return c.json({ error: "invalid_artifact_sha256" }, 400);
  if (declaredSha256 !== bundleSha256) return c.json({ error: "bundle_digest_mismatch" }, 400);
  if (declaredSize === null) return c.json({ error: "invalid_artifact_size" }, 400);
  if (declaredSize > WORKSPACE_HOST_MULTIPART_MAX_BUNDLE_BYTES) {
    return c.json(
      { error: "artifact_too_large", maxBytes: WORKSPACE_HOST_MULTIPART_MAX_BUNDLE_BYTES },
      413
    );
  };
  const uploadId = c.req.header("x-operation-id");
  if (!isMultipartUploadId(uploadId)) {
    return c.json({ error: "invalid_multipart_operation_id" }, 400);
  };
  const key = artifactKey(bundleSha256, "server.tgz");
  const expected = { sha256: bundleSha256, sizeBytes: declaredSize };
  const existing = await c.env.ARTIFACTS.head(key);
  if (existing) {
    if (descriptorMatches(existing, "server.tgz", bundleSha256, expected)) {
      return c.json({
        ok: true,
        file: "server.tgz",
        sha256: bundleSha256,
        bytes: declaredSize,
        deduped: true
      });
    };
    return c.json({ error: "artifact_conflict", file: "server.tgz" }, 409);
  };
  if (await c.env.ARTIFACTS.head(finalizationKey(bundleSha256))) {
    return c.json({ error: "artifact_finalized" }, 409);
  };
  const body = await readBoundedJson(c.req.raw, MULTIPART_CONTROL_MAX_BYTES);
  if (!body.ok) {
    return c.json(
      { error: body.error },
      body.error === "request_too_large" ? 413 : 400
    );
  };
  const plan = parseMultipartPlan(body.value, declaredSize);
  if (plan.errors.length > 0) {
    return c.json({ error: "invalid_multipart_plan", errors: plan.errors }, 400);
  };
  const expectedState = {
    bundleSha256,
    uploadId,
    sizeBytes: declaredSize,
    createdByGithubUserId: operator.id,
    parts: plan.parts
  };
  let prior;
  try {
    prior = await readMultipartState(c.env, bundleSha256, uploadId);
  } catch (error) {
    return multipartStorageFailure(c, error, "initiate");
  };
  if (prior) {
    if (prior.createdByGithubUserId !== operator.id) {
      return c.json({ error: "multipart_upload_owner_mismatch" }, 403);
    };
    if (!multipartStateMatches(prior, expectedState)) {
      return c.json({ error: "multipart_operation_conflict" }, 409);
    };
    return c.json({
      ok: true,
      file: "server.tgz",
      uploadId,
      operationId: uploadId,
      sha256: bundleSha256,
      bytes: declaredSize,
      partSizeBytes: plan.parts[0].sizeBytes,
      partCount: plan.parts.length,
      maxPartBytes: WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES,
      maxParts: WORKSPACE_HOST_MULTIPART_MAX_PARTS,
      deduped: false,
      resumed: true
    });
  };
  let upload;
  try {
    upload = await c.env.ARTIFACTS.createMultipartUpload(key, {
      httpMetadata: { contentType: CONTENT_TYPE["server.tgz"] },
      customMetadata: {
        ...metadataFor("server.tgz", bundleSha256, bundleSha256, declaredSize, operator.id),
        uploadMode: "multipart"
      }
    });
  } catch (error) {
    return multipartStorageFailure(c, error, "initiate");
  };
  if (!isR2MultipartUploadId(upload.uploadId)) {
    await upload.abort().catch(() => void 0);
    return c.json({ error: "invalid_storage_upload_id" }, 502);
  };
  const state = {
    schemaVersion: MULTIPART_STATE_SCHEMA_VERSION,
    kind: MULTIPART_STATE_KIND,
    bundleSha256,
    uploadId,
    r2UploadId: upload.uploadId,
    sizeBytes: declaredSize,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    createdByGithubUserId: operator.id,
    parts: plan.parts
  };
  try {
    const stateOutcome = await putCreateOnly(
      c.env.ARTIFACTS,
      multipartStateKey(bundleSha256, uploadId),
      JSON.stringify(state),
      {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: {
          namespace: MULTIPART_STATE_NAMESPACE,
          bundleSha256,
          uploadId,
          createdByGithubUserId: String(operator.id)
        }
      }
    );
    if (stateOutcome === "exists") {
      await upload.abort().catch(() => void 0);
      let raced;
      try {
        raced = await readMultipartState(c.env, bundleSha256, uploadId);
      } catch (error) {
        return multipartStorageFailure(c, error, "initiate");
      };
      if (!raced || !multipartStateMatches(raced, expectedState)) {
        return c.json({ error: "multipart_operation_conflict" }, 409);
      };
      return c.json({
        ok: true,
        file: "server.tgz",
        uploadId,
        operationId: uploadId,
        sha256: bundleSha256,
        bytes: declaredSize,
        partSizeBytes: plan.parts[0].sizeBytes,
        partCount: plan.parts.length,
        maxPartBytes: WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES,
        maxParts: WORKSPACE_HOST_MULTIPART_MAX_PARTS,
        deduped: false,
        resumed: true
      });
    }
  } catch (error) {
    await upload.abort().catch(() => void 0);
    return multipartStorageFailure(c, error, "initiate");
  };
  return c.json(
    {
      ok: true,
      file: "server.tgz",
      uploadId,
      operationId: uploadId,
      sha256: bundleSha256,
      bytes: declaredSize,
      partSizeBytes: plan.parts[0].sizeBytes,
      partCount: plan.parts.length,
      maxPartBytes: WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES,
      maxParts: WORKSPACE_HOST_MULTIPART_MAX_PARTS,
      deduped: false,
      resumed: false
    },
    201
  );
}
async function uploadMultipartPart(c) {
  const operator = await (0,__vite_ssr_import_3__.requireOperator)(c);
  if (operator instanceof Response) return operator;
  const bundleSha256 = c.req.param("bundleSha256");
  const uploadId = c.req.query("uploadId");
  const partNumber = parsePositiveInteger(c.req.param("partNumber"));
  if (!(0,__vite_ssr_import_0__.isHexSha256)(bundleSha256)) return c.json({ error: "invalid_bundle_sha256" }, 400);
  if (!isMultipartUploadId(uploadId)) return c.json({ error: "invalid_multipart_upload_id" }, 400);
  if (partNumber === null || partNumber > WORKSPACE_HOST_MULTIPART_MAX_PARTS) {
    return c.json({ error: "invalid_multipart_part_number" }, 400);
  };
  let state;
  try {
    state = await readMultipartState(c.env, bundleSha256, uploadId);
  } catch (error) {
    return multipartStorageFailure(c, error, "part");
  };
  if (!state) return c.json({ error: "multipart_upload_not_found" }, 404);
  if (state.createdByGithubUserId !== operator.id) {
    return c.json({ error: "multipart_upload_owner_mismatch" }, 403);
  };
  const expected = state.parts[partNumber - 1];
  if (!expected || expected.partNumber !== partNumber) {
    return c.json({ error: "multipart_part_not_planned" }, 400);
  };
  const declaredSha256 = c.req.header("x-part-sha256") ?? "";
  const declaredSize = parsePositiveInteger(c.req.header("x-part-size"));
  if (!(0,__vite_ssr_import_0__.isHexSha256)(declaredSha256) || declaredSha256 !== expected.sha256) {
    return c.json({ error: "multipart_part_digest_mismatch" }, 400);
  };
  if (declaredSize === null || declaredSize !== expected.sizeBytes) {
    return c.json({ error: "multipart_part_size_mismatch" }, 400);
  };
  const contentLength = parsePositiveInteger(c.req.header("content-length"));
  if (contentLength === null) return c.json({ error: "content_length_required" }, 411);
  if (contentLength !== expected.sizeBytes) {
    return c.json({ error: "content_length_mismatch" }, 400);
  };
  const body = await c.req.raw.arrayBuffer();
  if (body.byteLength !== expected.sizeBytes) {
    return c.json({ error: "multipart_part_size_mismatch" }, 400);
  };
  const actualSha256 = await (0,__vite_ssr_import_0__.sha256Hex)(body);
  if (actualSha256 !== expected.sha256) {
    return c.json(
      { error: "multipart_part_sha256_mismatch", expected: expected.sha256, actual: actualSha256 },
      400
    );
  };
  const receiptIdentity = { bundleSha256, uploadId, partNumber };
  const receiptExpected = { ...expected, createdByGithubUserId: operator.id };
  let priorReceipt;
  try {
    priorReceipt = await readMultipartPartReceipt(c.env, receiptIdentity);
  } catch (error) {
    return multipartStorageFailure(c, error, "part-reconcile");
  };
  if (priorReceipt) {
    if (!multipartPartReceiptMatches(priorReceipt, receiptExpected)) {
      return c.json({ error: "multipart_part_operation_conflict" }, 409);
    };
    if (priorReceipt.state === "intent") {
      return c.json({ error: "multipart_part_outcome_unknown", uploadId, partNumber }, 409);
    };
    return c.json({
      ok: true,
      uploadId,
      partNumber,
      etag: priorReceipt.etag,
      sha256: priorReceipt.sha256,
      bytes: priorReceipt.sizeBytes,
      deduped: true,
      resumed: true
    });
  };
  const receiptKey = multipartPartReceiptKey(bundleSha256, uploadId, partNumber);
  const receiptMetadata = {
    namespace: MULTIPART_PART_RECEIPT_NAMESPACE,
    bundleSha256,
    uploadId,
    partNumber: String(partNumber),
    createdByGithubUserId: String(operator.id)
  };
  const intent = {
    schemaVersion: 1,
    kind: MULTIPART_PART_RECEIPT_KIND,
    state: "intent",
    bundleSha256,
    uploadId,
    partNumber,
    sha256: actualSha256,
    sizeBytes: body.byteLength,
    createdByGithubUserId: operator.id,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  try {
    const claimed = await putCreateOnly(c.env.ARTIFACTS, receiptKey, JSON.stringify(intent), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: receiptMetadata
    });
    if (claimed === "exists") {
      const raced = await readMultipartPartReceipt(c.env, receiptIdentity);
      if (!raced || !multipartPartReceiptMatches(raced, receiptExpected)) {
        return c.json({ error: "multipart_part_operation_conflict" }, 409);
      };
      if (raced.state === "intent") {
        return c.json({ error: "multipart_part_outcome_unknown", uploadId, partNumber }, 409);
      };
      return c.json({
        ok: true,
        uploadId,
        partNumber,
        etag: raced.etag,
        sha256: raced.sha256,
        bytes: raced.sizeBytes,
        deduped: true,
        resumed: true
      });
    }
  } catch (error) {
    return multipartStorageFailure(c, error, "part-intent");
  };
  try {
    const part = await c.env.ARTIFACTS.resumeMultipartUpload(artifactKey(bundleSha256, "server.tgz"), state.r2UploadId).uploadPart(partNumber, body);
    const committed = {
      ...intent,
      state: "committed",
      etag: part.etag,
      committedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await c.env.ARTIFACTS.put(receiptKey, JSON.stringify(committed), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: receiptMetadata
    });
    return c.json({
      ok: true,
      uploadId,
      partNumber: part.partNumber,
      etag: part.etag,
      sha256: actualSha256,
      bytes: body.byteLength,
      deduped: false,
      resumed: false
    });
  } catch (error) {
    return multipartStorageFailure(c, error, "part");
  }
}
async function getMultipartStatus(c) {
  const operator = await (0,__vite_ssr_import_3__.requireOperator)(c);
  if (operator instanceof Response) return operator;
  const bundleSha256 = c.req.param("bundleSha256");
  const uploadId = c.req.query("uploadId");
  const partNumber = parsePositiveInteger(c.req.query("partNumber"));
  if (!(0,__vite_ssr_import_0__.isHexSha256)(bundleSha256)) return c.json({ error: "invalid_bundle_sha256" }, 400);
  if (!isMultipartUploadId(uploadId)) return c.json({ error: "invalid_multipart_upload_id" }, 400);
  if (partNumber === null || partNumber > WORKSPACE_HOST_MULTIPART_MAX_PARTS) {
    return c.json({ error: "invalid_multipart_part_number" }, 400);
  };
  let state;
  let receipt;
  try {
    [state, receipt] = await Promise.all([
      readMultipartState(c.env, bundleSha256, uploadId),
      readMultipartPartReceipt(c.env, { bundleSha256, uploadId, partNumber })
    ]);
  } catch (error) {
    return multipartStorageFailure(c, error, "status");
  };
  if (!state) {
    const object = await c.env.ARTIFACTS.head(artifactKey(bundleSha256, "server.tgz"));
    const descriptor = descriptorFromObject(object, "server.tgz", bundleSha256);
    return descriptor ? c.json({ ok: true, uploadId, completed: true, bundle: descriptor }) : c.json({ error: "multipart_upload_not_found" }, 404);
  };
  if (state.createdByGithubUserId !== operator.id) {
    return c.json({ error: "multipart_upload_owner_mismatch" }, 403);
  };
  const expected = state.parts[partNumber - 1];
  if (!expected || expected.partNumber !== partNumber) {
    return c.json({ error: "multipart_part_not_planned" }, 400);
  };
  if (!receipt) return c.json({ ok: true, uploadId, partNumber, state: "absent" });
  if (!multipartPartReceiptMatches(receipt, { ...expected, createdByGithubUserId: operator.id })) {
    return c.json({ error: "multipart_part_operation_conflict" }, 409);
  };
  return c.json({
    ok: true,
    uploadId,
    partNumber,
    state: receipt.state,
    sha256: receipt.sha256,
    bytes: receipt.sizeBytes,
    ...receipt.state === "committed" ? { etag: receipt.etag } : {}
  });
}
async function completeMultipartArtifact(c) {
  const operator = await (0,__vite_ssr_import_3__.requireOperator)(c);
  if (operator instanceof Response) return operator;
  const bundleSha256 = c.req.param("bundleSha256");
  const uploadId = c.req.query("uploadId");
  if (!(0,__vite_ssr_import_0__.isHexSha256)(bundleSha256)) return c.json({ error: "invalid_bundle_sha256" }, 400);
  if (!isMultipartUploadId(uploadId)) return c.json({ error: "invalid_multipart_upload_id" }, 400);
  const key = artifactKey(bundleSha256, "server.tgz");
  let state;
  try {
    state = await readMultipartState(c.env, bundleSha256, uploadId);
  } catch (error) {
    return multipartStorageFailure(c, error, "complete");
  };
  if (!state) {
    const existing2 = await c.env.ARTIFACTS.head(key);
    const descriptor = descriptorFromObject(existing2, "server.tgz", bundleSha256);
    if (descriptor) {
      return c.json({
        ok: true,
        file: "server.tgz",
        sha256: bundleSha256,
        bytes: descriptor.sizeBytes,
        deduped: true
      });
    };
    if (existing2) return c.json({ error: "artifact_conflict", file: "server.tgz" }, 409);
    return c.json({ error: "multipart_upload_not_found" }, 404);
  };
  if (state.createdByGithubUserId !== operator.id) {
    return c.json({ error: "multipart_upload_owner_mismatch" }, 403);
  };
  const expected = { sha256: bundleSha256, sizeBytes: state.sizeBytes };
  const existing = await c.env.ARTIFACTS.head(key);
  if (existing) {
    if (!descriptorMatches(existing, "server.tgz", bundleSha256, expected)) {
      return c.json({ error: "artifact_conflict", file: "server.tgz" }, 409);
    };
    await c.env.ARTIFACTS.resumeMultipartUpload(key, state.r2UploadId).abort().catch(() => void 0);
    await c.env.ARTIFACTS.delete(multipartStateKey(bundleSha256, uploadId));
    return c.json({
      ok: true,
      file: "server.tgz",
      sha256: bundleSha256,
      bytes: state.sizeBytes,
      deduped: true
    });
  };
  if (await c.env.ARTIFACTS.head(finalizationKey(bundleSha256))) {
    return c.json({ error: "artifact_finalized" }, 409);
  };
  const body = await readBoundedJson(c.req.raw, MULTIPART_CONTROL_MAX_BYTES);
  if (!body.ok) {
    return c.json(
      { error: body.error },
      body.error === "request_too_large" ? 413 : 400
    );
  };
  const completion = parseCompletionParts(body.value, state.parts);
  if (completion.error) {
    return c.json({ error: "invalid_multipart_completion", detail: completion.error }, 400);
  };
  try {
    await c.env.ARTIFACTS.resumeMultipartUpload(key, state.r2UploadId).complete(completion.parts);
  } catch (error) {
    if (r2ErrorCode(error) === 10024) {
      const raced = await c.env.ARTIFACTS.head(key);
      if (descriptorMatches(raced, "server.tgz", bundleSha256, expected)) {
        await c.env.ARTIFACTS.delete(multipartStateKey(bundleSha256, uploadId));
        return c.json({
          ok: true,
          file: "server.tgz",
          sha256: bundleSha256,
          bytes: state.sizeBytes,
          deduped: true
        });
      };
      await c.env.ARTIFACTS.delete(multipartStateKey(bundleSha256, uploadId)).catch(() => void 0);
    };
    return multipartStorageFailure(c, error, "complete");
  };
  let completed;
  try {
    completed = await c.env.ARTIFACTS.head(key);
  } catch (error) {
    return multipartStorageFailure(c, error, "complete");
  };
  if (!completed || !descriptorMatches(completed, "server.tgz", bundleSha256, expected)) {
    await c.env.ARTIFACTS.delete(multipartStateKey(bundleSha256, uploadId)).catch(() => void 0);
    return c.json({ error: "multipart_completed_object_mismatch" }, 409);
  };
  try {
    await c.env.ARTIFACTS.delete(multipartStateKey(bundleSha256, uploadId));
  } catch (error) {
    return multipartStorageFailure(c, error, "complete");
  };
  return c.json(
    {
      ok: true,
      file: "server.tgz",
      sha256: bundleSha256,
      bytes: state.sizeBytes,
      etag: completed.httpEtag,
      deduped: false
    },
    201
  );
}
async function abortMultipartArtifact(c) {
  const operator = await (0,__vite_ssr_import_3__.requireOperator)(c);
  if (operator instanceof Response) return operator;
  const bundleSha256 = c.req.param("bundleSha256");
  const uploadId = c.req.query("uploadId");
  if (!(0,__vite_ssr_import_0__.isHexSha256)(bundleSha256)) return c.json({ error: "invalid_bundle_sha256" }, 400);
  if (!isMultipartUploadId(uploadId)) return c.json({ error: "invalid_multipart_upload_id" }, 400);
  let state;
  try {
    state = await readMultipartState(c.env, bundleSha256, uploadId);
  } catch (error) {
    return multipartStorageFailure(c, error, "abort");
  };
  if (!state) return new Response(null, { status: 204 });
  if (state.createdByGithubUserId !== operator.id) {
    return c.json({ error: "multipart_upload_owner_mismatch" }, 403);
  };
  try {
    await c.env.ARTIFACTS.resumeMultipartUpload(artifactKey(bundleSha256, "server.tgz"), state.r2UploadId).abort();
  } catch (error) {
    if (r2ErrorCode(error) !== 10024) return multipartStorageFailure(c, error, "abort");
  };
  try {
    await c.env.ARTIFACTS.delete(multipartStateKey(bundleSha256, uploadId));
  } catch (error) {
    return multipartStorageFailure(c, error, "abort");
  };
  return new Response(null, { status: 204 });
}
async function finalizeArtifact(c) {
  const operator = await (0,__vite_ssr_import_3__.requireOperator)(c);
  if (operator instanceof Response) return operator;
  const bundleSha256 = c.req.param("bundleSha256");
  if (!(0,__vite_ssr_import_0__.isHexSha256)(bundleSha256)) return c.json({ error: "invalid_bundle_sha256" }, 400);
  const markerHead = await c.env.ARTIFACTS.head(finalizationKey(bundleSha256));
  if (markerHead) {
    const existing = await readFinalizationRecord(c.env, bundleSha256);
    if (!existing || !await finalizationObjectsMatch(c.env, existing)) {
      return c.json({ error: "finalization_conflict" }, 409);
    };
    return c.json({ ok: true, bundleSha256, manifestSha256: existing.manifestSha256, deduped: true });
  };
  const stored = {};
  const missing = [];
  for (const file of WORKSPACE_HOST_ARTIFACT_FILES) {
    const descriptor = descriptorFromObject(await c.env.ARTIFACTS.head(artifactKey(bundleSha256, file)), file, bundleSha256);
    if (!descriptor) missing.push(file);
    else stored[file] = descriptor;
  };
  if (missing.length > 0) return c.json({ error: "uploads_incomplete", missing }, 409);
  const manifestObject = await c.env.ARTIFACTS.get(artifactKey(bundleSha256, "manifest.json"));
  if (!manifestObject) return c.json({ error: "uploads_incomplete", missing: ["manifest.json"] }, 409);
  const manifestBody = await manifestObject.arrayBuffer();
  const actualManifestSha256 = await (0,__vite_ssr_import_0__.sha256Hex)(manifestBody);
  if (actualManifestSha256 !== stored["manifest.json"].sha256 || manifestBody.byteLength !== stored["manifest.json"].sizeBytes) {
    return c.json({ error: "manifest_storage_mismatch" }, 409);
  };
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBody));
  } catch {
    return c.json({ error: "invalid_manifest_json" }, 400);
  };
  const errors = validatePublicationManifest(manifest, bundleSha256, stored);
  if (errors.length > 0) return c.json({ error: "invalid_manifest", errors }, 400);
  const record = {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    kind: FINALIZATION_KIND,
    bundleSha256,
    manifestSha256: actualManifestSha256,
    files: stored,
    finalizedAt: (/* @__PURE__ */ new Date()).toISOString(),
    finalizedByGithubUserId: operator.id
  };
  const markerBody = JSON.stringify(record);
  const outcome = await putCreateOnly(c.env.ARTIFACTS, finalizationKey(bundleSha256), markerBody, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      namespace: "workspace-host-v1",
      bundleSha256,
      manifestSha256: actualManifestSha256,
      finalizedByGithubUserId: String(operator.id)
    }
  });
  if (outcome === "exists") {
    const raced = await readFinalizationRecord(c.env, bundleSha256);
    if (!raced || raced.manifestSha256 !== actualManifestSha256) {
      return c.json({ error: "finalization_conflict" }, 409);
    };
    return c.json({ ok: true, bundleSha256, manifestSha256: actualManifestSha256, deduped: true });
  };
  return c.json({ ok: true, bundleSha256, manifestSha256: actualManifestSha256, deduped: false }, 201);
}
async function serveArtifact(c, headOnly) {
  const bundleSha256 = c.req.param("bundleSha256");
  const rawFile = c.req.param("file");
  if (!(0,__vite_ssr_import_0__.isHexSha256)(bundleSha256) || !isArtifactFile(rawFile)) {
    return c.json({ error: "not_found" }, 404);
  };
  const record = await readFinalizationRecord(c.env, bundleSha256);
  if (!record) return c.json({ error: "not_found" }, 404);
  const key = artifactKey(bundleSha256, rawFile);
  const object = headOnly ? await c.env.ARTIFACTS.head(key) : await c.env.ARTIFACTS.get(key);
  const sbomDigest = rawFile === "sbom.cdx.json" ? await finalizedSbomDigest(c.env, bundleSha256) : null;
  const descriptor = rawFile === "sbom.cdx.json" ? sbomDigest && object ? { sha256: sbomDigest, sizeBytes: object.size } : null : record.files[rawFile];
  if (!descriptor || !descriptorMatches(object, rawFile, bundleSha256, descriptor)) {
    return c.json({ error: "not_found" }, 404);
  };
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("cache-control", WORKSPACE_HOST_PUBLIC_CACHE_CONTROL);
  headers.set("content-type", CONTENT_TYPE[rawFile]);
  headers.set("content-length", String(descriptor.sizeBytes));
  headers.set("content-disposition", `attachment; filename="${rawFile}"`);
  headers.set("x-artifact-sha256", descriptor.sha256);
  headers.set("x-content-type-options", "nosniff");
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  const body = !headOnly && "body" in object ? object.body : null;
  return new Response(body, { status: 200, headers });
}
function workspaceHostArtifactsRoute() {
  const app = new __vite_ssr_import_2__.Hono();
  const adminPath = "/admin/artifacts/workspace-host/sha256/:bundleSha256/:file";
  const publicPath = "/artifacts/workspace-host/sha256/:bundleSha256/:file";
  const multipartPath = "/admin/artifacts/workspace-host/sha256/:bundleSha256/server.tgz/multipart";
  app.post(multipartPath, initiateMultipartArtifact);
  app.get(multipartPath, getMultipartStatus);
  app.put(`${multipartPath}/parts/:partNumber`, uploadMultipartPart);
  app.post(`${multipartPath}/complete`, completeMultipartArtifact);
  app.delete(multipartPath, abortMultipartArtifact);
  app.put(adminPath, uploadArtifact);
  app.post("/admin/artifacts/workspace-host/sha256/:bundleSha256/finalize", finalizeArtifact);
  app.get(publicPath, (c) => serveArtifact(c, false));
  app.on("HEAD", publicPath, (c) => serveArtifact(c, true));
  return app;
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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LFVBQVEsSUFBSSxpQkFBaUIsbUNBQW1DO0FBQ2hFLFVBQVEsSUFBSSxnQkFBZ0IsYUFBYSxPQUFPLENBQUM7QUFDakQsVUFBUSxJQUFJLGtCQUFrQixPQUFPLFdBQVcsU0FBUyxDQUFDO0FBQzFELFVBQVEsSUFBSSx1QkFBdUIseUJBQXlCLE9BQU8sR0FBRztBQUN0RSxVQUFRLElBQUkscUJBQXFCLFdBQVcsTUFBTTtBQUNsRCxVQUFRLElBQUksMEJBQTBCLFNBQVM7QUFDL0MsTUFBSSxPQUFRLFNBQVUsU0FBUSxJQUFJLFFBQVEsT0FBUSxRQUFRO0FBRTFELFFBQU0sT0FBTyxDQUFDLFlBQVksVUFBVSxTQUFXLE9BQXNCLE9BQU87QUFDNUUsU0FBTyxJQUFJLFNBQVMsTUFBTSxFQUFFLFFBQVEsS0FBSyxRQUFRLENBQUM7QUFDcEQ7QUFFTyxTQUFTLDhCQUF1RDtBQUNyRSxRQUFNLE1BQU0sSUFBSSwyQkFBd0I7QUFDeEMsUUFBTSxZQUFZO0FBQ2xCLFFBQU0sYUFBYTtBQUNuQixRQUFNLGdCQUNKO0FBRUYsTUFBSSxLQUFLLGVBQWUseUJBQXlCO0FBQ2pELE1BQUksSUFBSSxlQUFlLGtCQUFrQjtBQUN6QyxNQUFJLElBQUksR0FBRyxhQUFhLHNCQUFzQixtQkFBbUI7QUFDakUsTUFBSSxLQUFLLEdBQUcsYUFBYSxhQUFhLHlCQUF5QjtBQUMvRCxNQUFJLE9BQU8sZUFBZSxzQkFBc0I7QUFDaEQsTUFBSSxJQUFJLFdBQVcsY0FBYztBQUNqQyxNQUFJLEtBQUssaUVBQWlFLGdCQUFnQjtBQUMxRixNQUFJLElBQUksWUFBWSxDQUFDLE1BQU0sY0FBYyxHQUFHLEtBQUssQ0FBQztBQUNsRCxNQUFJLEdBQUcsUUFBUSxZQUFZLENBQUMsTUFBTSxjQUFjLEdBQUcsSUFBSSxDQUFDO0FBQ3hELFNBQU87QUFDVCIsIm5hbWVzIjpbImV4aXN0aW5nIl0sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbIndvcmtzcGFjZS1ob3N0LWFydGlmYWN0cy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEQtMTA1L0QtMTA3L0QtMTEyIHdvcmtzcGFjZS1ob3N0IGFydGlmYWN0IHB1YmxpY2F0aW9uLlxuICpcbiAqIE9wZXJhdG9yLWF1dGhlbnRpY2F0ZWQgdXBsb2FkcyBsYW5kIGNyZWF0ZS1vbmx5IHRocm91Z2ggdGhlIHByaXZhdGUgc3RvcmFnZVxuICogcG9ydC4gUHVibGljIEdFVC9IRUFEIHJlbWFpbiBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIG1pc3NpbmcgdW50aWwgYVxuICogY3JlYXRlLW9ubHkgZmluYWxpemF0aW9uIG1hcmtlciBiaW5kcyB0aGUgYnVuZGxlLCBkZXRhY2hlZCBzaWduYXR1cmUsXG4gKiBtYW5pZmVzdCwgc2lnbmluZyBrZXksIGFuZCB0cnVzdCByZWNlaXB0cyB0byBvbmUgdmVyaWZpZWQgZGlnZXN0LlxuICogTGFyZ2Ugc2VydmVyIGJ1bmRsZXMgdXNlIGEgcHJpdmF0ZSBpbW11dGFibGUgcGFydCBwbGFuIHBsdXMgcmVzdW1hYmxlXG4gKiBtdWx0aXBhcnQgc3RhdGUsIGtlZXBpbmcgZXZlcnkgV29ya2VyIHJlcXVlc3QgYm91bmRlZCB3aGlsZSBwcmVzZXJ2aW5nIHRoZVxuICogZXhhY3QgY29udGVudC1hZGRyZXNzZWQgc2VydmVyLnRneiBrZXkgY29uc3VtZWQgYnkgZmluYWxpemF0aW9uIGFuZCByZWFkZXJzLlxuICovXG5cbmltcG9ydCB7IGlzSGV4U2hhMjU2LCBzaGEyNTZIZXgsIHR5cGUgT2JqZWN0TWV0YWRhdGEsIHR5cGUgT2JqZWN0Qm9keSxcbiAgdHlwZSBPYmplY3RTdG9yZSwgdHlwZSBPYmplY3RQdXRPcHRpb25zLCB0eXBlIE11bHRpcGFydFVwbG9hZCwgdHlwZSBVcGxvYWRlZFBhcnQgfSBmcm9tICdAcGFwZXJjdXNwL2FydGlmYWN0LXJlZ2lzdHJ5JztcbmltcG9ydCB7XG4gIGRlcml2ZVdvcmtzcGFjZUhvc3RDYW5vbmljYWxBcnRpZmFjdFVybHMsXG4gIHZhbGlkYXRlV29ya3NwYWNlSG9zdEltYWdlQXJ0aWZhY3QsXG4gIHR5cGUgV29ya3NwYWNlSG9zdEltYWdlQXJ0aWZhY3QsXG59IGZyb20gJ0BwYXBlcmN1c3AvZGVwbG95bWVudC1kcml2ZXInO1xuaW1wb3J0IHsgSG9ubyB9IGZyb20gJ2hvbm8nO1xuaW1wb3J0IHR5cGUgeyBDb250ZXh0IH0gZnJvbSAnaG9ubyc7XG5cbmltcG9ydCB0eXBlIHsgRW52IH0gZnJvbSAnLi4vZW52LnRzJztcbmltcG9ydCB7IHJlcXVpcmVPcGVyYXRvciB9IGZyb20gJy4vYWRtaW4udHMnO1xuXG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfQVJUSUZBQ1RfUFJFRklYID0gJ2FydGlmYWN0cy93b3Jrc3BhY2UtaG9zdC9zaGEyNTYnO1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX0FSVElGQUNUX0ZJTEVTID0gW1xuICAnc2VydmVyLnRneicsXG4gICdzZXJ2ZXIudGd6Lm1pbmlzaWcnLFxuICAnbWFuaWZlc3QuanNvbicsXG5dIGFzIGNvbnN0O1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX1BVQkxJQ19DQUNIRV9DT05UUk9MID0gJ3B1YmxpYywgbWF4LWFnZT0zMTUzNjAwMCwgaW1tdXRhYmxlJztcblxudHlwZSBXb3Jrc3BhY2VIb3N0Q29yZUFydGlmYWN0RmlsZSA9ICh0eXBlb2YgV09SS1NQQUNFX0hPU1RfQVJUSUZBQ1RfRklMRVMpW251bWJlcl07XG50eXBlIFdvcmtzcGFjZUhvc3RBcnRpZmFjdEZpbGUgPSBXb3Jrc3BhY2VIb3N0Q29yZUFydGlmYWN0RmlsZSB8ICdzYm9tLmNkeC5qc29uJztcblxuY29uc3QgRklOQUxJWkFUSU9OX0ZJTEUgPSAnLmZpbmFsaXplZC5qc29uJztcbmNvbnN0IFBVQkxJQ0FUSU9OX1NDSEVNQV9WRVJTSU9OID0gMTtcbmNvbnN0IFBVQkxJQ0FUSU9OX0tJTkQgPSAncGFwZXJjdXNwLXdvcmtzcGFjZS1ob3N0LXJlbGVhc2UnO1xuY29uc3QgRklOQUxJWkFUSU9OX0tJTkQgPSAncGFwZXJjdXNwLXdvcmtzcGFjZS1ob3N0LWZpbmFsaXphdGlvbic7XG5jb25zdCBBUlRJRkFDVF9UUlVTVF9WRVJTSU9OID0gJ2FydGlmYWN0LXRydXN0LXYxJztcbmNvbnN0IE1VTFRJUEFSVF9TVEFURV9TQ0hFTUFfVkVSU0lPTiA9IDE7XG5jb25zdCBNVUxUSVBBUlRfU1RBVEVfS0lORCA9ICdwYXBlcmN1c3Atd29ya3NwYWNlLWhvc3QtbXVsdGlwYXJ0LXVwbG9hZCc7XG5jb25zdCBNVUxUSVBBUlRfU1RBVEVfTkFNRVNQQUNFID0gJ3dvcmtzcGFjZS1ob3N0LW11bHRpcGFydC12MSc7XG5jb25zdCBNVUxUSVBBUlRfUEFSVF9SRUNFSVBUX0tJTkQgPSAncGFwZXJjdXNwLXdvcmtzcGFjZS1ob3N0LW11bHRpcGFydC1wYXJ0LXJlY2VpcHQnO1xuY29uc3QgTVVMVElQQVJUX1BBUlRfUkVDRUlQVF9OQU1FU1BBQ0UgPSAnd29ya3NwYWNlLWhvc3QtbXVsdGlwYXJ0LXBhcnQtdjEnO1xuY29uc3QgTVVMVElQQVJUX01JTl9QQVJUX0JZVEVTID0gNSAqIDEwMjQgKiAxMDI0O1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX01VTFRJUEFSVF9NQVhfUEFSVF9CWVRFUyA9IDMyICogMTAyNCAqIDEwMjQ7XG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfTVVMVElQQVJUX01BWF9QQVJUUyA9IDEwMjQ7XG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfTVVMVElQQVJUX01BWF9CVU5ETEVfQllURVMgPVxuICBXT1JLU1BBQ0VfSE9TVF9NVUxUSVBBUlRfTUFYX1BBUlRfQllURVMgKiBXT1JLU1BBQ0VfSE9TVF9NVUxUSVBBUlRfTUFYX1BBUlRTO1xuY29uc3QgTVVMVElQQVJUX0NPTlRST0xfTUFYX0JZVEVTID0gNTEyICogMTAyNDtcbmNvbnN0IE1BWF9CWVRFUzogUmVhZG9ubHk8UmVjb3JkPFdvcmtzcGFjZUhvc3RBcnRpZmFjdEZpbGUsIG51bWJlcj4+ID0ge1xuICAnc2VydmVyLnRneic6IDY0ICogMTAyNCAqIDEwMjQsXG4gICdzZXJ2ZXIudGd6Lm1pbmlzaWcnOiA2NCAqIDEwMjQsXG4gICdtYW5pZmVzdC5qc29uJzogMTAyNCAqIDEwMjQsXG4gICdzYm9tLmNkeC5qc29uJzogMTYgKiAxMDI0ICogMTAyNCxcbn07XG5jb25zdCBDT05URU5UX1RZUEU6IFJlYWRvbmx5PFJlY29yZDxXb3Jrc3BhY2VIb3N0QXJ0aWZhY3RGaWxlLCBzdHJpbmc+PiA9IHtcbiAgJ3NlcnZlci50Z3onOiAnYXBwbGljYXRpb24vZ3ppcCcsXG4gICdzZXJ2ZXIudGd6Lm1pbmlzaWcnOiAndGV4dC9wbGFpbjsgY2hhcnNldD11dGYtOCcsXG4gICdtYW5pZmVzdC5qc29uJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnLFxuICAnc2JvbS5jZHguanNvbic6ICdhcHBsaWNhdGlvbi92bmQuY3ljbG9uZWR4K2pzb247IGNoYXJzZXQ9dXRmLTgnLFxufTtcbmNvbnN0IFJFUVVJUkVEX1RSVVNUX0VWSURFTkNFID0gW1xuICAnc2lnbmF0dXJlJyxcbiAgJ3Nib20nLFxuICAndnVsbmVyYWJpbGl0eS1zY2FuJyxcbiAgJ3NlY3JldC1zY2FuJyxcbiAgJ3Byb3ZlbmFuY2UtYXR0ZXN0YXRpb24nLFxuXSBhcyBjb25zdDtcblxuaW50ZXJmYWNlIFN0b3JlZEZpbGVEZXNjcmlwdG9yIHtcbiAgc2hhMjU2OiBzdHJpbmc7XG4gIHNpemVCeXRlczogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgRmluYWxpemF0aW9uUmVjb3JkIHtcbiAgc2NoZW1hVmVyc2lvbjogdHlwZW9mIFBVQkxJQ0FUSU9OX1NDSEVNQV9WRVJTSU9OO1xuICBraW5kOiB0eXBlb2YgRklOQUxJWkFUSU9OX0tJTkQ7XG4gIGJ1bmRsZVNoYTI1Njogc3RyaW5nO1xuICBtYW5pZmVzdFNoYTI1Njogc3RyaW5nO1xuICBmaWxlczogUmVjb3JkPFdvcmtzcGFjZUhvc3RDb3JlQXJ0aWZhY3RGaWxlLCBTdG9yZWRGaWxlRGVzY3JpcHRvcj47XG4gIGZpbmFsaXplZEF0OiBzdHJpbmc7XG4gIGZpbmFsaXplZEJ5R2l0aHViVXNlcklkOiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBNdWx0aXBhcnRQYXJ0UGxhbiB7XG4gIHBhcnROdW1iZXI6IG51bWJlcjtcbiAgc2hhMjU2OiBzdHJpbmc7XG4gIHNpemVCeXRlczogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgTXVsdGlwYXJ0VXBsb2FkU3RhdGUge1xuICBzY2hlbWFWZXJzaW9uOiB0eXBlb2YgTVVMVElQQVJUX1NUQVRFX1NDSEVNQV9WRVJTSU9OO1xuICBraW5kOiB0eXBlb2YgTVVMVElQQVJUX1NUQVRFX0tJTkQ7XG4gIGJ1bmRsZVNoYTI1Njogc3RyaW5nO1xuICAvKiogU2hvcnQgQVBJIGNhcGFiaWxpdHkgdG9rZW47IG5ldmVyIHRoZSBvcGFxdWUgbmF0aXZlIFIyIHVwbG9hZCBpZC4gKi9cbiAgdXBsb2FkSWQ6IHN0cmluZztcbiAgcjJVcGxvYWRJZDogc3RyaW5nO1xuICBzaXplQnl0ZXM6IG51bWJlcjtcbiAgY3JlYXRlZEF0OiBzdHJpbmc7XG4gIGNyZWF0ZWRCeUdpdGh1YlVzZXJJZDogbnVtYmVyO1xuICBwYXJ0czogTXVsdGlwYXJ0UGFydFBsYW5bXTtcbn1cblxuaW50ZXJmYWNlIE11bHRpcGFydFBhcnRSZWNlaXB0IHtcbiAgc2NoZW1hVmVyc2lvbjogMTtcbiAga2luZDogdHlwZW9mIE1VTFRJUEFSVF9QQVJUX1JFQ0VJUFRfS0lORDtcbiAgc3RhdGU6ICdpbnRlbnQnIHwgJ2NvbW1pdHRlZCc7XG4gIGJ1bmRsZVNoYTI1Njogc3RyaW5nO1xuICB1cGxvYWRJZDogc3RyaW5nO1xuICBwYXJ0TnVtYmVyOiBudW1iZXI7XG4gIHNoYTI1Njogc3RyaW5nO1xuICBzaXplQnl0ZXM6IG51bWJlcjtcbiAgY3JlYXRlZEJ5R2l0aHViVXNlcklkOiBudW1iZXI7XG4gIGNyZWF0ZWRBdDogc3RyaW5nO1xuICBldGFnPzogc3RyaW5nO1xuICBjb21taXR0ZWRBdD86IHN0cmluZztcbn1cblxudHlwZSBKc29uUmVjb3JkID0gUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cbmZ1bmN0aW9uIGlzUmVjb3JkKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgSnNvblJlY29yZCB7XG4gIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmIHZhbHVlICE9PSBudWxsICYmICFBcnJheS5pc0FycmF5KHZhbHVlKTtcbn1cblxuZnVuY3Rpb24gaXNBcnRpZmFjdEZpbGUodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBXb3Jrc3BhY2VIb3N0QXJ0aWZhY3RGaWxlIHtcbiAgcmV0dXJuIChcbiAgICB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmXG4gICAgKChXT1JLU1BBQ0VfSE9TVF9BUlRJRkFDVF9GSUxFUyBhcyByZWFkb25seSBzdHJpbmdbXSkuaW5jbHVkZXModmFsdWUpIHx8IHZhbHVlID09PSAnc2JvbS5jZHguanNvbicpXG4gICk7XG59XG5cbmZ1bmN0aW9uIGFydGlmYWN0UHJlZml4KGJ1bmRsZVNoYTI1Njogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke1dPUktTUEFDRV9IT1NUX0FSVElGQUNUX1BSRUZJWH0vJHtidW5kbGVTaGEyNTZ9YDtcbn1cblxuZnVuY3Rpb24gYXJ0aWZhY3RLZXkoYnVuZGxlU2hhMjU2OiBzdHJpbmcsIGZpbGU6IFdvcmtzcGFjZUhvc3RBcnRpZmFjdEZpbGUpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7YXJ0aWZhY3RQcmVmaXgoYnVuZGxlU2hhMjU2KX0vJHtmaWxlfWA7XG59XG5cbmZ1bmN0aW9uIGZpbmFsaXphdGlvbktleShidW5kbGVTaGEyNTY6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHthcnRpZmFjdFByZWZpeChidW5kbGVTaGEyNTYpfS8ke0ZJTkFMSVpBVElPTl9GSUxFfWA7XG59XG5cbmZ1bmN0aW9uIG11bHRpcGFydFN0YXRlS2V5KGJ1bmRsZVNoYTI1Njogc3RyaW5nLCB1cGxvYWRJZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke2FydGlmYWN0UHJlZml4KGJ1bmRsZVNoYTI1Nil9Ly5tdWx0aXBhcnQvJHtlbmNvZGVVUklDb21wb25lbnQodXBsb2FkSWQpfS5qc29uYDtcbn1cblxuZnVuY3Rpb24gbXVsdGlwYXJ0UGFydFJlY2VpcHRLZXkoXG4gIGJ1bmRsZVNoYTI1Njogc3RyaW5nLFxuICB1cGxvYWRJZDogc3RyaW5nLFxuICBwYXJ0TnVtYmVyOiBudW1iZXIsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYCR7YXJ0aWZhY3RQcmVmaXgoYnVuZGxlU2hhMjU2KX0vLm11bHRpcGFydC8ke2VuY29kZVVSSUNvbXBvbmVudCh1cGxvYWRJZCl9L3BhcnRzLyR7cGFydE51bWJlcn0uanNvbmA7XG59XG5cbmZ1bmN0aW9uIG11bHRpcGFydFN0YXRlTWF0Y2hlcyhcbiAgc3RhdGU6IE11bHRpcGFydFVwbG9hZFN0YXRlLFxuICBleHBlY3RlZDoge1xuICAgIGJ1bmRsZVNoYTI1Njogc3RyaW5nO1xuICAgIHVwbG9hZElkOiBzdHJpbmc7XG4gICAgc2l6ZUJ5dGVzOiBudW1iZXI7XG4gICAgY3JlYXRlZEJ5R2l0aHViVXNlcklkOiBudW1iZXI7XG4gICAgcGFydHM6IHJlYWRvbmx5IE11bHRpcGFydFBhcnRQbGFuW107XG4gIH0sXG4pOiBib29sZWFuIHtcbiAgcmV0dXJuIChcbiAgICBzdGF0ZS5idW5kbGVTaGEyNTYgPT09IGV4cGVjdGVkLmJ1bmRsZVNoYTI1NiAmJlxuICAgIHN0YXRlLnVwbG9hZElkID09PSBleHBlY3RlZC51cGxvYWRJZCAmJlxuICAgIHN0YXRlLnNpemVCeXRlcyA9PT0gZXhwZWN0ZWQuc2l6ZUJ5dGVzICYmXG4gICAgc3RhdGUuY3JlYXRlZEJ5R2l0aHViVXNlcklkID09PSBleHBlY3RlZC5jcmVhdGVkQnlHaXRodWJVc2VySWQgJiZcbiAgICBzdGF0ZS5wYXJ0cy5sZW5ndGggPT09IGV4cGVjdGVkLnBhcnRzLmxlbmd0aCAmJlxuICAgIHN0YXRlLnBhcnRzLmV2ZXJ5KChwYXJ0LCBpbmRleCkgPT4ge1xuICAgICAgY29uc3Qgd2FudGVkID0gZXhwZWN0ZWQucGFydHNbaW5kZXhdO1xuICAgICAgcmV0dXJuIChcbiAgICAgICAgd2FudGVkICE9PSB1bmRlZmluZWQgJiZcbiAgICAgICAgcGFydC5wYXJ0TnVtYmVyID09PSB3YW50ZWQucGFydE51bWJlciAmJlxuICAgICAgICBwYXJ0LnNoYTI1NiA9PT0gd2FudGVkLnNoYTI1NiAmJlxuICAgICAgICBwYXJ0LnNpemVCeXRlcyA9PT0gd2FudGVkLnNpemVCeXRlc1xuICAgICAgKTtcbiAgICB9KVxuICApO1xufVxuXG5mdW5jdGlvbiBwYXJzZVBvc2l0aXZlSW50ZWdlcih2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghdmFsdWUgfHwgIS9eWzEtOV1bMC05XSokLy50ZXN0KHZhbHVlKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHBhcnNlZCA9IE51bWJlcih2YWx1ZSk7XG4gIHJldHVybiBOdW1iZXIuaXNTYWZlSW50ZWdlcihwYXJzZWQpID8gcGFyc2VkIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gaXNNdWx0aXBhcnRVcGxvYWRJZCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIHN0cmluZyB7XG4gIHJldHVybiAoXG4gICAgdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJlxuICAgIC9eWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tNFswLTlhLWZdezN9LVs4OWFiXVswLTlhLWZdezN9LVswLTlhLWZdezEyfSQvaS50ZXN0KHZhbHVlKVxuICApO1xufVxuXG5mdW5jdGlvbiBpc1IyTXVsdGlwYXJ0VXBsb2FkSWQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBzdHJpbmcge1xuICByZXR1cm4gKFxuICAgIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiZcbiAgICB2YWx1ZS5sZW5ndGggPiAwICYmXG4gICAgdmFsdWUubGVuZ3RoIDw9IDgxOTIgJiZcbiAgICAhL1tcXHUwMDAwLVxcdTAwMWZcXHUwMDdmXS8udGVzdCh2YWx1ZSlcbiAgKTtcbn1cblxuZnVuY3Rpb24gcjJFcnJvckNvZGUoZXJyb3I6IHVua25vd24pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKCFpc1JlY29yZChlcnJvcikgJiYgIShlcnJvciBpbnN0YW5jZW9mIEVycm9yKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGV4cGxpY2l0ID0gaXNSZWNvcmQoZXJyb3IpICYmIHR5cGVvZiBlcnJvci5jb2RlID09PSAnbnVtYmVyJyA/IGVycm9yLmNvZGUgOiBudWxsO1xuICBpZiAoZXhwbGljaXQgIT09IG51bGwgJiYgTnVtYmVyLmlzU2FmZUludGVnZXIoZXhwbGljaXQpKSByZXR1cm4gZXhwbGljaXQ7XG4gIGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yXG4gICAgPyBlcnJvci5tZXNzYWdlXG4gICAgOiBpc1JlY29yZChlcnJvcikgJiYgdHlwZW9mIGVycm9yLm1lc3NhZ2UgPT09ICdzdHJpbmcnXG4gICAgICA/IGVycm9yLm1lc3NhZ2VcbiAgICAgIDogJyc7XG4gIGNvbnN0IG1hdGNoID0gbWVzc2FnZS5tYXRjaCgvXFwoKFxcZCspXFwpXFxzKiQvKTtcbiAgcmV0dXJuIG1hdGNoID8gTnVtYmVyKG1hdGNoWzFdKSA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIG11bHRpcGFydFN0b3JhZ2VGYWlsdXJlKFxuICBjOiBDb250ZXh0PHsgQmluZGluZ3M6IEVudiB9PixcbiAgZXJyb3I6IHVua25vd24sXG4gIHBoYXNlOiAnaW5pdGlhdGUnIHwgJ3BhcnQnIHwgJ3BhcnQtaW50ZW50JyB8ICdwYXJ0LXJlY29uY2lsZScgfCAnc3RhdHVzJyB8ICdjb21wbGV0ZScgfCAnYWJvcnQnLFxuKTogUmVzcG9uc2Uge1xuICBjb25zdCBjb2RlID0gcjJFcnJvckNvZGUoZXJyb3IpO1xuICBpZiAoY29kZSA9PT0gMTAwMjQpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ211bHRpcGFydF91cGxvYWRfbm90X2ZvdW5kJyB9LCA0MDQpO1xuICBpZiAoY29kZSA9PT0gMTAwMjUpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ211bHRpcGFydF91cGxvYWRfaW5jb21wbGV0ZScgfSwgNDA5KTtcbiAgaWYgKGNvZGUgPT09IDEwMDExIHx8IGNvZGUgPT09IDEwMDQ4KSB7XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbXVsdGlwYXJ0X3BhcnRzX2ludmFsaWQnIH0sIDQwMCk7XG4gIH1cbiAgaWYgKGNvZGUgPT09IDEwMDU4KSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdhcnRpZmFjdF9zdG9yYWdlX3JhdGVfbGltaXRlZCcgfSwgNDI5KTtcbiAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnYXJ0aWZhY3Rfc3RvcmFnZV91bmF2YWlsYWJsZScsIHBoYXNlIH0sIDUwMik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlYWRCb3VuZGVkSnNvbihcbiAgcmVxdWVzdDogUmVxdWVzdCxcbiAgbWF4Qnl0ZXM6IG51bWJlcixcbik6IFByb21pc2U8eyBvazogdHJ1ZTsgdmFsdWU6IHVua25vd24gfSB8IHsgb2s6IGZhbHNlOyBlcnJvcjogJ2ludmFsaWRfanNvbicgfCAncmVxdWVzdF90b29fbGFyZ2UnIH0+IHtcbiAgY29uc3QgZGVjbGFyZWRMZW5ndGggPSByZXF1ZXN0LmhlYWRlcnMuZ2V0KCdjb250ZW50LWxlbmd0aCcpO1xuICBpZiAoZGVjbGFyZWRMZW5ndGgpIHtcbiAgICBjb25zdCBwYXJzZWRMZW5ndGggPSBwYXJzZVBvc2l0aXZlSW50ZWdlcihkZWNsYXJlZExlbmd0aCk7XG4gICAgaWYgKHBhcnNlZExlbmd0aCA9PT0gbnVsbCB8fCBwYXJzZWRMZW5ndGggPiBtYXhCeXRlcykge1xuICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ3JlcXVlc3RfdG9vX2xhcmdlJyB9O1xuICAgIH1cbiAgfVxuICBjb25zdCBib2R5ID0gYXdhaXQgcmVxdWVzdC5hcnJheUJ1ZmZlcigpO1xuICBpZiAoYm9keS5ieXRlTGVuZ3RoID09PSAwKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnaW52YWxpZF9qc29uJyB9O1xuICBpZiAoYm9keS5ieXRlTGVuZ3RoID4gbWF4Qnl0ZXMpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdyZXF1ZXN0X3Rvb19sYXJnZScgfTtcbiAgdHJ5IHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IEpTT04ucGFyc2UobmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKGJvZHkpKSB9O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnaW52YWxpZF9qc29uJyB9O1xuICB9XG59XG5cbmZ1bmN0aW9uIHBhcnNlTXVsdGlwYXJ0UGxhbihcbiAgdmFsdWU6IHVua25vd24sXG4gIGV4cGVjdGVkU2l6ZUJ5dGVzOiBudW1iZXIsXG4pOiB7IHBhcnRzOiBNdWx0aXBhcnRQYXJ0UGxhbltdOyBlcnJvcnM6IHN0cmluZ1tdIH0ge1xuICBjb25zdCBlcnJvcnM6IHN0cmluZ1tdID0gW107XG4gIGlmICghaXNSZWNvcmQodmFsdWUpIHx8ICFBcnJheS5pc0FycmF5KHZhbHVlLnBhcnRzKSkge1xuICAgIHJldHVybiB7IHBhcnRzOiBbXSwgZXJyb3JzOiBbJ3BhcnRzIG11c3QgYmUgYW4gYXJyYXknXSB9O1xuICB9XG4gIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHZhbHVlKSkge1xuICAgIGlmIChrZXkgIT09ICdwYXJ0cycpIGVycm9ycy5wdXNoKGB1bmV4cGVjdGVkIG11bHRpcGFydCBwbGFuIGZpZWxkICcke2tleX0nYCk7XG4gIH1cbiAgaWYgKHZhbHVlLnBhcnRzLmxlbmd0aCA9PT0gMCB8fCB2YWx1ZS5wYXJ0cy5sZW5ndGggPiBXT1JLU1BBQ0VfSE9TVF9NVUxUSVBBUlRfTUFYX1BBUlRTKSB7XG4gICAgZXJyb3JzLnB1c2goYHBhcnRzIG11c3QgY29udGFpbiAxLSR7V09SS1NQQUNFX0hPU1RfTVVMVElQQVJUX01BWF9QQVJUU30gZW50cmllc2ApO1xuICB9XG5cbiAgY29uc3QgcGFydHM6IE11bHRpcGFydFBhcnRQbGFuW10gPSBbXTtcbiAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IHZhbHVlLnBhcnRzLmxlbmd0aDsgaW5kZXggKz0gMSkge1xuICAgIGNvbnN0IGNhbmRpZGF0ZSA9IHZhbHVlLnBhcnRzW2luZGV4XTtcbiAgICBpZiAoIWlzUmVjb3JkKGNhbmRpZGF0ZSkpIHtcbiAgICAgIGVycm9ycy5wdXNoKGBwYXJ0c1ske2luZGV4fV0gbXVzdCBiZSBhbiBvYmplY3RgKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhjYW5kaWRhdGUpKSB7XG4gICAgICBpZiAoIVsncGFydE51bWJlcicsICdzaGEyNTYnLCAnc2l6ZUJ5dGVzJ10uaW5jbHVkZXMoa2V5KSkge1xuICAgICAgICBlcnJvcnMucHVzaChgdW5leHBlY3RlZCBwYXJ0c1ske2luZGV4fV0gZmllbGQgJyR7a2V5fSdgKTtcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgcGFydE51bWJlciA9IE51bWJlcihjYW5kaWRhdGUucGFydE51bWJlcik7XG4gICAgY29uc3Qgc2l6ZUJ5dGVzID0gTnVtYmVyKGNhbmRpZGF0ZS5zaXplQnl0ZXMpO1xuICAgIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIocGFydE51bWJlcikgfHwgcGFydE51bWJlciAhPT0gaW5kZXggKyAxKSB7XG4gICAgICBlcnJvcnMucHVzaChgcGFydHNbJHtpbmRleH1dLnBhcnROdW1iZXIgbXVzdCBlcXVhbCAke2luZGV4ICsgMX1gKTtcbiAgICB9XG4gICAgaWYgKCFpc0hleFNoYTI1NihjYW5kaWRhdGUuc2hhMjU2KSkge1xuICAgICAgZXJyb3JzLnB1c2goYHBhcnRzWyR7aW5kZXh9XS5zaGEyNTYgbXVzdCBiZSBhIGxvd2VyY2FzZSBTSEEtMjU2IGRpZ2VzdGApO1xuICAgIH1cbiAgICBpZiAoXG4gICAgICAhTnVtYmVyLmlzU2FmZUludGVnZXIoc2l6ZUJ5dGVzKSB8fFxuICAgICAgc2l6ZUJ5dGVzIDw9IDAgfHxcbiAgICAgIHNpemVCeXRlcyA+IFdPUktTUEFDRV9IT1NUX01VTFRJUEFSVF9NQVhfUEFSVF9CWVRFU1xuICAgICkge1xuICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgIGBwYXJ0c1ske2luZGV4fV0uc2l6ZUJ5dGVzIG11c3QgYmUgYmV0d2VlbiAxIGFuZCAke1dPUktTUEFDRV9IT1NUX01VTFRJUEFSVF9NQVhfUEFSVF9CWVRFU31gLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKFxuICAgICAgTnVtYmVyLmlzU2FmZUludGVnZXIocGFydE51bWJlcikgJiZcbiAgICAgIGlzSGV4U2hhMjU2KGNhbmRpZGF0ZS5zaGEyNTYpICYmXG4gICAgICBOdW1iZXIuaXNTYWZlSW50ZWdlcihzaXplQnl0ZXMpICYmXG4gICAgICBzaXplQnl0ZXMgPiAwICYmXG4gICAgICBzaXplQnl0ZXMgPD0gV09SS1NQQUNFX0hPU1RfTVVMVElQQVJUX01BWF9QQVJUX0JZVEVTXG4gICAgKSB7XG4gICAgICBwYXJ0cy5wdXNoKHsgcGFydE51bWJlciwgc2hhMjU2OiBjYW5kaWRhdGUuc2hhMjU2LCBzaXplQnl0ZXMgfSk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gdmFsdWUucGFydHMubGVuZ3RoICYmIHBhcnRzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCByZWd1bGFyUGFydEJ5dGVzID0gcGFydHNbMF0uc2l6ZUJ5dGVzO1xuICAgIGlmIChwYXJ0cy5sZW5ndGggPiAxICYmIHJlZ3VsYXJQYXJ0Qnl0ZXMgPCBNVUxUSVBBUlRfTUlOX1BBUlRfQllURVMpIHtcbiAgICAgIGVycm9ycy5wdXNoKGBldmVyeSBub24tZmluYWwgcGFydCBtdXN0IGJlIGF0IGxlYXN0ICR7TVVMVElQQVJUX01JTl9QQVJUX0JZVEVTfSBieXRlc2ApO1xuICAgIH1cbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgcGFydHMubGVuZ3RoIC0gMTsgaW5kZXggKz0gMSkge1xuICAgICAgaWYgKHBhcnRzW2luZGV4XS5zaXplQnl0ZXMgIT09IHJlZ3VsYXJQYXJ0Qnl0ZXMpIHtcbiAgICAgICAgZXJyb3JzLnB1c2goJ2FsbCBub24tZmluYWwgbXVsdGlwYXJ0IHBhcnRzIG11c3QgaGF2ZSBpZGVudGljYWwgc2l6ZXMnKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChwYXJ0cy5hdCgtMSkhLnNpemVCeXRlcyA+IHJlZ3VsYXJQYXJ0Qnl0ZXMpIHtcbiAgICAgIGVycm9ycy5wdXNoKCd0aGUgZmluYWwgbXVsdGlwYXJ0IHBhcnQgY2Fubm90IGV4Y2VlZCB0aGUgcmVndWxhciBwYXJ0IHNpemUnKTtcbiAgICB9XG4gICAgY29uc3QgdG90YWxCeXRlcyA9IHBhcnRzLnJlZHVjZSgoc3VtLCBwYXJ0KSA9PiBzdW0gKyBwYXJ0LnNpemVCeXRlcywgMCk7XG4gICAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcih0b3RhbEJ5dGVzKSB8fCB0b3RhbEJ5dGVzICE9PSBleHBlY3RlZFNpemVCeXRlcykge1xuICAgICAgZXJyb3JzLnB1c2goJ211bHRpcGFydCBwYXJ0IHNpemVzIG11c3Qgc3VtIHRvIHgtYXJ0aWZhY3Qtc2l6ZScpO1xuICAgIH1cbiAgfVxuICByZXR1cm4geyBwYXJ0cywgZXJyb3JzOiBbLi4ubmV3IFNldChlcnJvcnMpXSB9O1xufVxuXG5mdW5jdGlvbiBwYXJzZU11bHRpcGFydFN0YXRlKFxuICB2YWx1ZTogdW5rbm93bixcbiAgYnVuZGxlU2hhMjU2OiBzdHJpbmcsXG4gIHVwbG9hZElkOiBzdHJpbmcsXG4pOiBNdWx0aXBhcnRVcGxvYWRTdGF0ZSB8IG51bGwge1xuICBpZiAoXG4gICAgIWlzUmVjb3JkKHZhbHVlKSB8fFxuICAgIHZhbHVlLnNjaGVtYVZlcnNpb24gIT09IE1VTFRJUEFSVF9TVEFURV9TQ0hFTUFfVkVSU0lPTiB8fFxuICAgIHZhbHVlLmtpbmQgIT09IE1VTFRJUEFSVF9TVEFURV9LSU5EIHx8XG4gICAgdmFsdWUuYnVuZGxlU2hhMjU2ICE9PSBidW5kbGVTaGEyNTYgfHxcbiAgICB2YWx1ZS51cGxvYWRJZCAhPT0gdXBsb2FkSWQgfHxcbiAgICAhaXNSMk11bHRpcGFydFVwbG9hZElkKHZhbHVlLnIyVXBsb2FkSWQpIHx8XG4gICAgIU51bWJlci5pc1NhZmVJbnRlZ2VyKHZhbHVlLnNpemVCeXRlcykgfHxcbiAgICBOdW1iZXIodmFsdWUuc2l6ZUJ5dGVzKSA8PSAwIHx8XG4gICAgTnVtYmVyKHZhbHVlLnNpemVCeXRlcykgPiBXT1JLU1BBQ0VfSE9TVF9NVUxUSVBBUlRfTUFYX0JVTkRMRV9CWVRFUyB8fFxuICAgIHR5cGVvZiB2YWx1ZS5jcmVhdGVkQXQgIT09ICdzdHJpbmcnIHx8XG4gICAgIU51bWJlci5pc0Zpbml0ZShEYXRlLnBhcnNlKHZhbHVlLmNyZWF0ZWRBdCkpIHx8XG4gICAgIU51bWJlci5pc1NhZmVJbnRlZ2VyKHZhbHVlLmNyZWF0ZWRCeUdpdGh1YlVzZXJJZCkgfHxcbiAgICBOdW1iZXIodmFsdWUuY3JlYXRlZEJ5R2l0aHViVXNlcklkKSA8PSAwXG4gICkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGNvbnN0IHBsYW4gPSBwYXJzZU11bHRpcGFydFBsYW4oeyBwYXJ0czogdmFsdWUucGFydHMgfSwgTnVtYmVyKHZhbHVlLnNpemVCeXRlcykpO1xuICBpZiAocGxhbi5lcnJvcnMubGVuZ3RoID4gMCkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7XG4gICAgc2NoZW1hVmVyc2lvbjogTVVMVElQQVJUX1NUQVRFX1NDSEVNQV9WRVJTSU9OLFxuICAgIGtpbmQ6IE1VTFRJUEFSVF9TVEFURV9LSU5ELFxuICAgIGJ1bmRsZVNoYTI1NixcbiAgICB1cGxvYWRJZCxcbiAgICByMlVwbG9hZElkOiB2YWx1ZS5yMlVwbG9hZElkLFxuICAgIHNpemVCeXRlczogTnVtYmVyKHZhbHVlLnNpemVCeXRlcyksXG4gICAgY3JlYXRlZEF0OiB2YWx1ZS5jcmVhdGVkQXQsXG4gICAgY3JlYXRlZEJ5R2l0aHViVXNlcklkOiBOdW1iZXIodmFsdWUuY3JlYXRlZEJ5R2l0aHViVXNlcklkKSxcbiAgICBwYXJ0czogcGxhbi5wYXJ0cyxcbiAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZE11bHRpcGFydFN0YXRlKFxuICBlbnY6IEVudixcbiAgYnVuZGxlU2hhMjU2OiBzdHJpbmcsXG4gIHVwbG9hZElkOiBzdHJpbmcsXG4pOiBQcm9taXNlPE11bHRpcGFydFVwbG9hZFN0YXRlIHwgbnVsbD4ge1xuICBjb25zdCBvYmplY3QgPSBhd2FpdCBlbnYuQVJUSUZBQ1RTLmdldChtdWx0aXBhcnRTdGF0ZUtleShidW5kbGVTaGEyNTYsIHVwbG9hZElkKSk7XG4gIGlmICghb2JqZWN0IHx8IG9iamVjdC5zaXplID4gTVVMVElQQVJUX0NPTlRST0xfTUFYX0JZVEVTKSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCBzdGF0ZSA9IHBhcnNlTXVsdGlwYXJ0U3RhdGUoSlNPTi5wYXJzZShhd2FpdCBvYmplY3QudGV4dCgpKSwgYnVuZGxlU2hhMjU2LCB1cGxvYWRJZCk7XG4gICAgY29uc3QgbWV0YWRhdGEgPSBvYmplY3QuY3VzdG9tTWV0YWRhdGEgPz8ge307XG4gICAgaWYgKFxuICAgICAgIXN0YXRlIHx8XG4gICAgICBtZXRhZGF0YS5uYW1lc3BhY2UgIT09IE1VTFRJUEFSVF9TVEFURV9OQU1FU1BBQ0UgfHxcbiAgICAgIG1ldGFkYXRhLmJ1bmRsZVNoYTI1NiAhPT0gYnVuZGxlU2hhMjU2IHx8XG4gICAgICBtZXRhZGF0YS51cGxvYWRJZCAhPT0gdXBsb2FkSWQgfHxcbiAgICAgIG1ldGFkYXRhLmNyZWF0ZWRCeUdpdGh1YlVzZXJJZCAhPT0gU3RyaW5nKHN0YXRlLmNyZWF0ZWRCeUdpdGh1YlVzZXJJZClcbiAgICApIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICByZXR1cm4gc3RhdGU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIHBhcnNlTXVsdGlwYXJ0UGFydFJlY2VpcHQoXG4gIHZhbHVlOiB1bmtub3duLFxuICBleHBlY3RlZDoge1xuICAgIGJ1bmRsZVNoYTI1Njogc3RyaW5nO1xuICAgIHVwbG9hZElkOiBzdHJpbmc7XG4gICAgcGFydE51bWJlcjogbnVtYmVyO1xuICB9LFxuKTogTXVsdGlwYXJ0UGFydFJlY2VpcHQgfCBudWxsIHtcbiAgaWYgKFxuICAgICFpc1JlY29yZCh2YWx1ZSkgfHxcbiAgICB2YWx1ZS5zY2hlbWFWZXJzaW9uICE9PSAxIHx8XG4gICAgdmFsdWUua2luZCAhPT0gTVVMVElQQVJUX1BBUlRfUkVDRUlQVF9LSU5EIHx8XG4gICAgKHZhbHVlLnN0YXRlICE9PSAnaW50ZW50JyAmJiB2YWx1ZS5zdGF0ZSAhPT0gJ2NvbW1pdHRlZCcpIHx8XG4gICAgdmFsdWUuYnVuZGxlU2hhMjU2ICE9PSBleHBlY3RlZC5idW5kbGVTaGEyNTYgfHxcbiAgICB2YWx1ZS51cGxvYWRJZCAhPT0gZXhwZWN0ZWQudXBsb2FkSWQgfHxcbiAgICB2YWx1ZS5wYXJ0TnVtYmVyICE9PSBleHBlY3RlZC5wYXJ0TnVtYmVyIHx8XG4gICAgIWlzSGV4U2hhMjU2KHZhbHVlLnNoYTI1NikgfHxcbiAgICAhTnVtYmVyLmlzU2FmZUludGVnZXIodmFsdWUuc2l6ZUJ5dGVzKSB8fFxuICAgIE51bWJlcih2YWx1ZS5zaXplQnl0ZXMpIDw9IDAgfHxcbiAgICAhTnVtYmVyLmlzU2FmZUludGVnZXIodmFsdWUuY3JlYXRlZEJ5R2l0aHViVXNlcklkKSB8fFxuICAgIE51bWJlcih2YWx1ZS5jcmVhdGVkQnlHaXRodWJVc2VySWQpIDw9IDAgfHxcbiAgICB0eXBlb2YgdmFsdWUuY3JlYXRlZEF0ICE9PSAnc3RyaW5nJyB8fFxuICAgICFOdW1iZXIuaXNGaW5pdGUoRGF0ZS5wYXJzZSh2YWx1ZS5jcmVhdGVkQXQpKVxuICApIHJldHVybiBudWxsO1xuICBpZiAodmFsdWUuc3RhdGUgPT09ICdjb21taXR0ZWQnKSB7XG4gICAgaWYgKFxuICAgICAgdHlwZW9mIHZhbHVlLmV0YWcgIT09ICdzdHJpbmcnIHx8XG4gICAgICB2YWx1ZS5ldGFnLmxlbmd0aCA9PT0gMCB8fFxuICAgICAgdmFsdWUuZXRhZy5sZW5ndGggPiA1MTIgfHxcbiAgICAgIHR5cGVvZiB2YWx1ZS5jb21taXR0ZWRBdCAhPT0gJ3N0cmluZycgfHxcbiAgICAgICFOdW1iZXIuaXNGaW5pdGUoRGF0ZS5wYXJzZSh2YWx1ZS5jb21taXR0ZWRBdCkpXG4gICAgKSByZXR1cm4gbnVsbDtcbiAgfSBlbHNlIGlmICh2YWx1ZS5ldGFnICE9PSB1bmRlZmluZWQgfHwgdmFsdWUuY29tbWl0dGVkQXQgIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIHJldHVybiB2YWx1ZSBhcyB1bmtub3duIGFzIE11bHRpcGFydFBhcnRSZWNlaXB0O1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWFkTXVsdGlwYXJ0UGFydFJlY2VpcHQoXG4gIGVudjogRW52LFxuICBleHBlY3RlZDogeyBidW5kbGVTaGEyNTY6IHN0cmluZzsgdXBsb2FkSWQ6IHN0cmluZzsgcGFydE51bWJlcjogbnVtYmVyIH0sXG4pOiBQcm9taXNlPE11bHRpcGFydFBhcnRSZWNlaXB0IHwgbnVsbD4ge1xuICBjb25zdCBvYmplY3QgPSBhd2FpdCBlbnYuQVJUSUZBQ1RTLmdldChcbiAgICBtdWx0aXBhcnRQYXJ0UmVjZWlwdEtleShleHBlY3RlZC5idW5kbGVTaGEyNTYsIGV4cGVjdGVkLnVwbG9hZElkLCBleHBlY3RlZC5wYXJ0TnVtYmVyKSxcbiAgKTtcbiAgaWYgKCFvYmplY3QgfHwgb2JqZWN0LnNpemUgPiBNVUxUSVBBUlRfQ09OVFJPTF9NQVhfQllURVMpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHJlY2VpcHQgPSBwYXJzZU11bHRpcGFydFBhcnRSZWNlaXB0KEpTT04ucGFyc2UoYXdhaXQgb2JqZWN0LnRleHQoKSksIGV4cGVjdGVkKTtcbiAgICBjb25zdCBtZXRhZGF0YSA9IG9iamVjdC5jdXN0b21NZXRhZGF0YSA/PyB7fTtcbiAgICBpZiAoXG4gICAgICAhcmVjZWlwdCB8fFxuICAgICAgbWV0YWRhdGEubmFtZXNwYWNlICE9PSBNVUxUSVBBUlRfUEFSVF9SRUNFSVBUX05BTUVTUEFDRSB8fFxuICAgICAgbWV0YWRhdGEuYnVuZGxlU2hhMjU2ICE9PSBleHBlY3RlZC5idW5kbGVTaGEyNTYgfHxcbiAgICAgIG1ldGFkYXRhLnVwbG9hZElkICE9PSBleHBlY3RlZC51cGxvYWRJZCB8fFxuICAgICAgbWV0YWRhdGEucGFydE51bWJlciAhPT0gU3RyaW5nKGV4cGVjdGVkLnBhcnROdW1iZXIpIHx8XG4gICAgICBtZXRhZGF0YS5jcmVhdGVkQnlHaXRodWJVc2VySWQgIT09IFN0cmluZyhyZWNlaXB0LmNyZWF0ZWRCeUdpdGh1YlVzZXJJZClcbiAgICApIHJldHVybiBudWxsO1xuICAgIHJldHVybiByZWNlaXB0O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBtdWx0aXBhcnRQYXJ0UmVjZWlwdE1hdGNoZXMoXG4gIHJlY2VpcHQ6IE11bHRpcGFydFBhcnRSZWNlaXB0LFxuICBleHBlY3RlZDogTXVsdGlwYXJ0UGFydFBsYW4gJiB7IGNyZWF0ZWRCeUdpdGh1YlVzZXJJZDogbnVtYmVyIH0sXG4pOiBib29sZWFuIHtcbiAgcmV0dXJuIChcbiAgICByZWNlaXB0LnBhcnROdW1iZXIgPT09IGV4cGVjdGVkLnBhcnROdW1iZXIgJiZcbiAgICByZWNlaXB0LnNoYTI1NiA9PT0gZXhwZWN0ZWQuc2hhMjU2ICYmXG4gICAgcmVjZWlwdC5zaXplQnl0ZXMgPT09IGV4cGVjdGVkLnNpemVCeXRlcyAmJlxuICAgIHJlY2VpcHQuY3JlYXRlZEJ5R2l0aHViVXNlcklkID09PSBleHBlY3RlZC5jcmVhdGVkQnlHaXRodWJVc2VySWRcbiAgKTtcbn1cblxuZnVuY3Rpb24gcGFyc2VDb21wbGV0aW9uUGFydHMoXG4gIHZhbHVlOiB1bmtub3duLFxuICBwbGFuOiByZWFkb25seSBNdWx0aXBhcnRQYXJ0UGxhbltdLFxuKTogeyBwYXJ0czogVXBsb2FkZWRQYXJ0W107IGVycm9yOiBzdHJpbmcgfCBudWxsIH0ge1xuICBpZiAoIWlzUmVjb3JkKHZhbHVlKSB8fCAhQXJyYXkuaXNBcnJheSh2YWx1ZS5wYXJ0cykpIHtcbiAgICByZXR1cm4geyBwYXJ0czogW10sIGVycm9yOiAncGFydHMgbXVzdCBiZSBhbiBhcnJheScgfTtcbiAgfVxuICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyh2YWx1ZSkpIHtcbiAgICBpZiAoa2V5ICE9PSAncGFydHMnKSByZXR1cm4geyBwYXJ0czogW10sIGVycm9yOiBgdW5leHBlY3RlZCBjb21wbGV0aW9uIGZpZWxkICcke2tleX0nYCB9O1xuICB9XG4gIGlmICh2YWx1ZS5wYXJ0cy5sZW5ndGggIT09IHBsYW4ubGVuZ3RoKSB7XG4gICAgcmV0dXJuIHsgcGFydHM6IFtdLCBlcnJvcjogJ2NvbXBsZXRpb24gbXVzdCBpbmNsdWRlIGV2ZXJ5IHBsYW5uZWQgcGFydCBleGFjdGx5IG9uY2UnIH07XG4gIH1cbiAgY29uc3QgcGFydHM6IFVwbG9hZGVkUGFydFtdID0gW107XG4gIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCB2YWx1ZS5wYXJ0cy5sZW5ndGg7IGluZGV4ICs9IDEpIHtcbiAgICBjb25zdCBjYW5kaWRhdGUgPSB2YWx1ZS5wYXJ0c1tpbmRleF07XG4gICAgaWYgKCFpc1JlY29yZChjYW5kaWRhdGUpKSByZXR1cm4geyBwYXJ0czogW10sIGVycm9yOiBgcGFydHNbJHtpbmRleH1dIG11c3QgYmUgYW4gb2JqZWN0YCB9O1xuICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKGNhbmRpZGF0ZSkpIHtcbiAgICAgIGlmICghWydwYXJ0TnVtYmVyJywgJ2V0YWcnXS5pbmNsdWRlcyhrZXkpKSB7XG4gICAgICAgIHJldHVybiB7IHBhcnRzOiBbXSwgZXJyb3I6IGB1bmV4cGVjdGVkIHBhcnRzWyR7aW5kZXh9XSBmaWVsZCAnJHtrZXl9J2AgfTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGNhbmRpZGF0ZS5wYXJ0TnVtYmVyICE9PSBwbGFuW2luZGV4XS5wYXJ0TnVtYmVyKSB7XG4gICAgICByZXR1cm4geyBwYXJ0czogW10sIGVycm9yOiBgcGFydHNbJHtpbmRleH1dLnBhcnROdW1iZXIgbXVzdCBlcXVhbCAke3BsYW5baW5kZXhdLnBhcnROdW1iZXJ9YCB9O1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGNhbmRpZGF0ZS5ldGFnICE9PSAnc3RyaW5nJyB8fCBjYW5kaWRhdGUuZXRhZy5sZW5ndGggPT09IDAgfHwgY2FuZGlkYXRlLmV0YWcubGVuZ3RoID4gNTEyKSB7XG4gICAgICByZXR1cm4geyBwYXJ0czogW10sIGVycm9yOiBgcGFydHNbJHtpbmRleH1dLmV0YWcgaXMgaW52YWxpZGAgfTtcbiAgICB9XG4gICAgcGFydHMucHVzaCh7IHBhcnROdW1iZXI6IHBsYW5baW5kZXhdLnBhcnROdW1iZXIsIGV0YWc6IGNhbmRpZGF0ZS5ldGFnIH0pO1xuICB9XG4gIHJldHVybiB7IHBhcnRzLCBlcnJvcjogbnVsbCB9O1xufVxuXG5mdW5jdGlvbiBtZXRhZGF0YUZvcihcbiAgZmlsZTogV29ya3NwYWNlSG9zdEFydGlmYWN0RmlsZSxcbiAgYnVuZGxlU2hhMjU2OiBzdHJpbmcsXG4gIGZpbGVTaGEyNTY6IHN0cmluZyxcbiAgc2l6ZUJ5dGVzOiBudW1iZXIsXG4gIGdpdGh1YlVzZXJJZDogbnVtYmVyLFxuKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gIHJldHVybiB7XG4gICAgbmFtZXNwYWNlOiAnd29ya3NwYWNlLWhvc3QtdjEnLFxuICAgIGJ1bmRsZVNoYTI1NixcbiAgICBmaWxlLFxuICAgIGZpbGVTaGEyNTYsXG4gICAgc2l6ZUJ5dGVzOiBTdHJpbmcoc2l6ZUJ5dGVzKSxcbiAgICB1cGxvYWRlZEJ5R2l0aHViVXNlcklkOiBTdHJpbmcoZ2l0aHViVXNlcklkKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gZGVzY3JpcHRvckZyb21PYmplY3QoXG4gIG9iamVjdDogUGljazxPYmplY3RNZXRhZGF0YSwgJ3NpemUnIHwgJ2N1c3RvbU1ldGFkYXRhJz4gfCBudWxsLFxuICBmaWxlOiBXb3Jrc3BhY2VIb3N0QXJ0aWZhY3RGaWxlLFxuICBidW5kbGVTaGEyNTY6IHN0cmluZyxcbik6IFN0b3JlZEZpbGVEZXNjcmlwdG9yIHwgbnVsbCB7XG4gIGlmICghb2JqZWN0KSByZXR1cm4gbnVsbDtcbiAgY29uc3QgbWV0YWRhdGEgPSBvYmplY3QuY3VzdG9tTWV0YWRhdGEgPz8ge307XG4gIGNvbnN0IHNpemVCeXRlcyA9IE51bWJlcihtZXRhZGF0YS5zaXplQnl0ZXMpO1xuICBpZiAoXG4gICAgbWV0YWRhdGEubmFtZXNwYWNlICE9PSAnd29ya3NwYWNlLWhvc3QtdjEnIHx8XG4gICAgbWV0YWRhdGEuYnVuZGxlU2hhMjU2ICE9PSBidW5kbGVTaGEyNTYgfHxcbiAgICBtZXRhZGF0YS5maWxlICE9PSBmaWxlIHx8XG4gICAgIWlzSGV4U2hhMjU2KG1ldGFkYXRhLmZpbGVTaGEyNTYpIHx8XG4gICAgIU51bWJlci5pc1NhZmVJbnRlZ2VyKHNpemVCeXRlcykgfHxcbiAgICBzaXplQnl0ZXMgPD0gMCB8fFxuICAgIHNpemVCeXRlcyAhPT0gb2JqZWN0LnNpemVcbiAgKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgaWYgKGZpbGUgPT09ICdzZXJ2ZXIudGd6JyAmJiBtZXRhZGF0YS5maWxlU2hhMjU2ICE9PSBidW5kbGVTaGEyNTYpIHJldHVybiBudWxsO1xuICByZXR1cm4geyBzaGEyNTY6IG1ldGFkYXRhLmZpbGVTaGEyNTYsIHNpemVCeXRlcyB9O1xufVxuXG5mdW5jdGlvbiBkZXNjcmlwdG9yTWF0Y2hlcyhcbiAgb2JqZWN0OiBQaWNrPE9iamVjdE1ldGFkYXRhLCAnc2l6ZScgfCAnY3VzdG9tTWV0YWRhdGEnPiB8IG51bGwsXG4gIGZpbGU6IFdvcmtzcGFjZUhvc3RBcnRpZmFjdEZpbGUsXG4gIGJ1bmRsZVNoYTI1Njogc3RyaW5nLFxuICBleHBlY3RlZDogU3RvcmVkRmlsZURlc2NyaXB0b3IsXG4pOiBib29sZWFuIHtcbiAgY29uc3QgYWN0dWFsID0gZGVzY3JpcHRvckZyb21PYmplY3Qob2JqZWN0LCBmaWxlLCBidW5kbGVTaGEyNTYpO1xuICByZXR1cm4gYWN0dWFsPy5zaGEyNTYgPT09IGV4cGVjdGVkLnNoYTI1NiAmJiBhY3R1YWwuc2l6ZUJ5dGVzID09PSBleHBlY3RlZC5zaXplQnl0ZXM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHB1dENyZWF0ZU9ubHkoXG4gIGJ1Y2tldDogT2JqZWN0U3RvcmUsXG4gIGtleTogc3RyaW5nLFxuICBib2R5OiBBcnJheUJ1ZmZlciB8IFVpbnQ4QXJyYXkgfCBzdHJpbmcsXG4gIG9wdGlvbnM6IE9iamVjdFB1dE9wdGlvbnMsXG4pOiBQcm9taXNlPCdjcmVhdGVkJyB8ICdleGlzdHMnPiB7XG4gIHRyeSB7XG4gICAgLy8gUHJvdmlkZXJzIGNhbiBzdXJmYWNlIGFuIHVuc2F0aXNmaWVkIHByZWNvbmRpdGlvbiBhcyBudWxsIG9yIGFuIGV4Y2VwdGlvbi5cbiAgICAvLyBIYW5kbGUgYm90aCBhbmQgYWRqdWRpY2F0ZSB0aGUgcmFjZSBmcm9tIGEgZnJlc2ggSEVBRC5cbiAgICBjb25zdCByZXN1bHQgPSAoYXdhaXQgYnVja2V0LnB1dChrZXksIGJvZHksIHtcbiAgICAgIC4uLm9wdGlvbnMsXG4gICAgICBvbmx5SWY6IHsgZXRhZ0RvZXNOb3RNYXRjaDogJyonIH0sXG4gICAgfSkpIGFzIE9iamVjdE1ldGFkYXRhIHwgbnVsbDtcbiAgICByZXR1cm4gcmVzdWx0ID8gJ2NyZWF0ZWQnIDogJ2V4aXN0cyc7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgaWYgKGF3YWl0IGJ1Y2tldC5oZWFkKGtleSkpIHJldHVybiAnZXhpc3RzJztcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxufVxuXG5jb25zdCBTQUZFX1NFQ1JFVF9GSUVMRF9OQU1FUyA9IG5ldyBTZXQoW1xuICAnbWF4U2VjcmV0RmluZGluZ3MnLFxuICAnc2lnbmluZ1B1YmxpY0tleScsXG4gICdzaWduaW5nS2V5U2hhMjU2Jyxcbl0pO1xuY29uc3QgU0VDUkVUX0ZJRUxEID0gLyg/Ol58Wy1fLl0pKHBhc3N3b3JkfHBhc3N3ZHxjcmVkZW50aWFsfGNyZWRlbnRpYWxzfHNlY3JldHx0b2tlbnxwcml2YXRlWy1fXT9rZXl8YXBpWy1fXT9rZXkpKD86JHxbLV8uXSkvaTtcbmNvbnN0IFNFQ1JFVF9WQUxVRSA9IC8tLS0tLUJFR0lOICg/OlJTQSB8RUMgfE9QRU5TU0ggKT9QUklWQVRFIEtFWS0tLS0tfFxcYig/OkFLSUFbMC05QS1aXXsxNn18Z2l0aHViX3BhdF9bQS1aYS16MC05X117MjAsfXxnaFtwb3Vzcl1fW0EtWmEtejAtOV17MjAsfXxzay0oPzpwcm9qLSk/W0EtWmEtejAtOV8tXXsyMCx9KVxcYi87XG5cbmZ1bmN0aW9uIHNlY3JldE1hdGVyaWFsRXJyb3IodmFsdWU6IHVua25vd24sIHBhdGggPSAnbWFuaWZlc3QnKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgaWYgKFNFQ1JFVF9WQUxVRS50ZXN0KHZhbHVlKSkgcmV0dXJuIGAke3BhdGh9IGNvbnRhaW5zIHNlY3JldC1zaGFwZWQgbWF0ZXJpYWxgO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHZhbHVlKTtcbiAgICAgIGlmICgodXJsLnByb3RvY29sID09PSAnaHR0cHM6JyB8fCB1cmwucHJvdG9jb2wgPT09ICdodHRwOicpICYmICh1cmwudXNlcm5hbWUgfHwgdXJsLnBhc3N3b3JkKSkge1xuICAgICAgICByZXR1cm4gYCR7cGF0aH0gY29udGFpbnMgVVJMIGNyZWRlbnRpYWxzYDtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIE1vc3QgbWFuaWZlc3Qgc3RyaW5ncyBhcmUgbm90IFVSTHM7IG9ubHkgc3VjY2Vzc2Z1bGx5IHBhcnNlZCBIVFRQKFMpXG4gICAgICAvLyB2YWx1ZXMgcGFydGljaXBhdGUgaW4gdGhlIHVzZXJpbmZvIGd1YXJkLlxuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgdmFsdWUubGVuZ3RoOyBpbmRleCArPSAxKSB7XG4gICAgICBjb25zdCBlcnJvciA9IHNlY3JldE1hdGVyaWFsRXJyb3IodmFsdWVbaW5kZXhdLCBgJHtwYXRofVske2luZGV4fV1gKTtcbiAgICAgIGlmIChlcnJvcikgcmV0dXJuIGVycm9yO1xuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBpZiAoIWlzUmVjb3JkKHZhbHVlKSkgcmV0dXJuIG51bGw7XG4gIGZvciAoY29uc3QgW2tleSwgbmVzdGVkXSBvZiBPYmplY3QuZW50cmllcyh2YWx1ZSkpIHtcbiAgICBjb25zdCBub3JtYWxpemVkID0ga2V5LnJlcGxhY2UoLyhbYS16MC05XSkoW0EtWl0pL2csICckMS0kMicpO1xuICAgIGlmICghU0FGRV9TRUNSRVRfRklFTERfTkFNRVMuaGFzKGtleSkgJiYgU0VDUkVUX0ZJRUxELnRlc3Qobm9ybWFsaXplZCkpIHtcbiAgICAgIHJldHVybiBgJHtwYXRofS4ke2tleX0gaXMgYSBzZWNyZXQtc2hhcGVkIGZpZWxkYDtcbiAgICB9XG4gICAgY29uc3QgZXJyb3IgPSBzZWNyZXRNYXRlcmlhbEVycm9yKG5lc3RlZCwgYCR7cGF0aH0uJHtrZXl9YCk7XG4gICAgaWYgKGVycm9yKSByZXR1cm4gZXJyb3I7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIHZhbGlkVG9vbCh2YWx1ZTogdW5rbm93bik6IGJvb2xlYW4ge1xuICByZXR1cm4gKFxuICAgIGlzUmVjb3JkKHZhbHVlKSAmJlxuICAgIHR5cGVvZiB2YWx1ZS5uYW1lID09PSAnc3RyaW5nJyAmJlxuICAgIHZhbHVlLm5hbWUudHJpbSgpLmxlbmd0aCA+IDAgJiZcbiAgICB0eXBlb2YgdmFsdWUudmVyc2lvbiA9PT0gJ3N0cmluZycgJiZcbiAgICB2YWx1ZS52ZXJzaW9uLnRyaW0oKS5sZW5ndGggPiAwXG4gICk7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlVHJ1c3RSZXBvcnQoXG4gIHZhbHVlOiB1bmtub3duLFxuICBidW5kbGVTaGEyNTY6IHN0cmluZyxcbiAgYnVuZGxlOiBTdG9yZWRGaWxlRGVzY3JpcHRvcixcbiAgc2lnbmF0dXJlOiBTdG9yZWRGaWxlRGVzY3JpcHRvcixcbiAgc2lnbmluZ0tleVNoYTI1Njogc3RyaW5nLFxuKTogc3RyaW5nW10ge1xuICBjb25zdCBlcnJvcnM6IHN0cmluZ1tdID0gW107XG4gIGlmICghaXNSZWNvcmQodmFsdWUpKSByZXR1cm4gWyd0cnVzdFJlcG9ydCBtdXN0IGJlIGFuIG9iamVjdCddO1xuICBpZiAodmFsdWUudmVyc2lvbiAhPT0gQVJUSUZBQ1RfVFJVU1RfVkVSU0lPTikge1xuICAgIGVycm9ycy5wdXNoKGB0cnVzdFJlcG9ydC52ZXJzaW9uIG11c3QgYmUgJyR7QVJUSUZBQ1RfVFJVU1RfVkVSU0lPTn0nYCk7XG4gIH1cbiAgaWYgKHZhbHVlLnRydXN0ZWQgIT09IHRydWUpIGVycm9ycy5wdXNoKCd0cnVzdFJlcG9ydC50cnVzdGVkIG11c3QgYmUgdHJ1ZScpO1xuICBpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUuZmFpbHVyZXMpIHx8IHZhbHVlLmZhaWx1cmVzLmxlbmd0aCAhPT0gMCkge1xuICAgIGVycm9ycy5wdXNoKCd0cnVzdFJlcG9ydC5mYWlsdXJlcyBtdXN0IGJlIGFuIGVtcHR5IGFycmF5Jyk7XG4gIH1cblxuICBjb25zdCBzdWJqZWN0ID0gdmFsdWUuc3ViamVjdDtcbiAgaWYgKFxuICAgICFpc1JlY29yZChzdWJqZWN0KSB8fFxuICAgIHN1YmplY3Quc2hhMjU2ICE9PSBidW5kbGVTaGEyNTYgfHxcbiAgICBzdWJqZWN0LmJ5dGVzICE9PSBidW5kbGUuc2l6ZUJ5dGVzIHx8XG4gICAgc3ViamVjdC5zaWduZWQgIT09IHRydWUgfHxcbiAgICB0eXBlb2Ygc3ViamVjdC5wYXRoICE9PSAnc3RyaW5nJyB8fFxuICAgIHN1YmplY3QucGF0aC50cmltKCkubGVuZ3RoID09PSAwIHx8XG4gICAgdHlwZW9mIHN1YmplY3QubmFtZSAhPT0gJ3N0cmluZycgfHxcbiAgICBzdWJqZWN0Lm5hbWUudHJpbSgpLmxlbmd0aCA9PT0gMFxuICApIHtcbiAgICBlcnJvcnMucHVzaCgndHJ1c3RSZXBvcnQuc3ViamVjdCBtdXN0IGJpbmQgdGhlIHNpZ25lZCBidW5kbGUgZGlnZXN0IGFuZCBleGFjdCBieXRlIGNvdW50Jyk7XG4gIH1cblxuICBjb25zdCBwb2xpY3kgPSB2YWx1ZS5wb2xpY3k7XG4gIGxldCBtYXhBdHRlc3RhdGlvbkFnZU1zOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgaWYgKFxuICAgICFpc1JlY29yZChwb2xpY3kpIHx8XG4gICAgcG9saWN5Lm1heFNlY3JldEZpbmRpbmdzICE9PSAwIHx8XG4gICAgIVsnbG93JywgJ21lZGl1bScsICdoaWdoJywgJ2NyaXRpY2FsJ10uaW5jbHVkZXMoU3RyaW5nKHBvbGljeS5kZW55VnVsbmVyYWJpbGl0aWVzQXRPckFib3ZlKSkgfHxcbiAgICAhTnVtYmVyLmlzU2FmZUludGVnZXIocG9saWN5Lm1heEF0dGVzdGF0aW9uQWdlTXMpIHx8XG4gICAgTnVtYmVyKHBvbGljeS5tYXhBdHRlc3RhdGlvbkFnZU1zKSA8PSAwXG4gICkge1xuICAgIGVycm9ycy5wdXNoKCd0cnVzdFJlcG9ydC5wb2xpY3kgbXVzdCBiZSBleHBsaWNpdCBhbmQgcmVxdWlyZSB6ZXJvIHNlY3JldCBmaW5kaW5ncycpO1xuICB9IGVsc2Uge1xuICAgIG1heEF0dGVzdGF0aW9uQWdlTXMgPSBOdW1iZXIocG9saWN5Lm1heEF0dGVzdGF0aW9uQWdlTXMpO1xuICB9XG5cbiAgaWYgKCFBcnJheS5pc0FycmF5KHZhbHVlLmV2aWRlbmNlKSkge1xuICAgIGVycm9ycy5wdXNoKCd0cnVzdFJlcG9ydC5ldmlkZW5jZSBtdXN0IGNvbnRhaW4gZXZlcnkgcmVxdWlyZWQgZXZpZGVuY2UgY2xhc3MnKTtcbiAgICByZXR1cm4gZXJyb3JzO1xuICB9XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgbGV0IHNib21TaGEyNTY6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgc2Nhbm5lZFNib21TaGEyNTY6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBmb3IgKGNvbnN0IGNhbmRpZGF0ZSBvZiB2YWx1ZS5ldmlkZW5jZSkge1xuICAgIGlmICghaXNSZWNvcmQoY2FuZGlkYXRlKSB8fCB0eXBlb2YgY2FuZGlkYXRlLmtpbmQgIT09ICdzdHJpbmcnKSB7XG4gICAgICBlcnJvcnMucHVzaCgnZXZlcnkgdHJ1c3QgZXZpZGVuY2UgZW50cnkgbXVzdCBiZSBhbiBvYmplY3Qgd2l0aCBhIGtpbmQnKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBraW5kID0gY2FuZGlkYXRlLmtpbmQ7XG4gICAgaWYgKHNlZW4uaGFzKGtpbmQpKSBlcnJvcnMucHVzaChgdHJ1c3RSZXBvcnQuZXZpZGVuY2UgY29udGFpbnMgZHVwbGljYXRlICcke2tpbmR9J2ApO1xuICAgIHNlZW4uYWRkKGtpbmQpO1xuICAgIGlmIChjYW5kaWRhdGUuc3ViamVjdFNoYTI1NiAhPT0gYnVuZGxlU2hhMjU2KSB7XG4gICAgICBlcnJvcnMucHVzaChgJHtraW5kfSBldmlkZW5jZSBpcyBub3QgYm91bmQgdG8gdGhlIGJ1bmRsZSBkaWdlc3RgKTtcbiAgICB9XG4gICAgaWYgKCF2YWxpZFRvb2woY2FuZGlkYXRlLnRvb2wpKSBlcnJvcnMucHVzaChgJHtraW5kfSBldmlkZW5jZSBsYWNrcyBleGFjdCB0b29sIG1ldGFkYXRhYCk7XG5cbiAgICBpZiAoa2luZCA9PT0gJ3NpZ25hdHVyZScpIHtcbiAgICAgIGlmIChcbiAgICAgICAgY2FuZGlkYXRlLnZhbGlkICE9PSB0cnVlIHx8XG4gICAgICAgIGNhbmRpZGF0ZS5zaWduYXR1cmVTaGEyNTYgIT09IHNpZ25hdHVyZS5zaGEyNTYgfHxcbiAgICAgICAgY2FuZGlkYXRlLnNpZ25pbmdLZXlTaGEyNTYgIT09IHNpZ25pbmdLZXlTaGEyNTZcbiAgICAgICkge1xuICAgICAgICBlcnJvcnMucHVzaCgnc2lnbmF0dXJlIGV2aWRlbmNlIG11c3QgdmVyaWZ5IHRoZSB1cGxvYWRlZCBzaWduYXR1cmUgYW5kIHBpbm5lZCBzaWduaW5nIGtleScpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoa2luZCA9PT0gJ3Nib20nKSB7XG4gICAgICBpZiAoXG4gICAgICAgIHR5cGVvZiBjYW5kaWRhdGUuZm9ybWF0ICE9PSAnc3RyaW5nJyB8fFxuICAgICAgICAhaXNIZXhTaGEyNTYoY2FuZGlkYXRlLmRvY3VtZW50U2hhMjU2KSB8fFxuICAgICAgICAhTnVtYmVyLmlzU2FmZUludGVnZXIoY2FuZGlkYXRlLmNvbXBvbmVudENvdW50KSB8fFxuICAgICAgICBOdW1iZXIoY2FuZGlkYXRlLmNvbXBvbmVudENvdW50KSA8IDBcbiAgICAgICkge1xuICAgICAgICBlcnJvcnMucHVzaCgnc2JvbSBldmlkZW5jZSBpcyBtYWxmb3JtZWQnKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHNib21TaGEyNTYgPSBjYW5kaWRhdGUuZG9jdW1lbnRTaGEyNTY7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChraW5kID09PSAndnVsbmVyYWJpbGl0eS1zY2FuJykge1xuICAgICAgaWYgKCFpc0hleFNoYTI1NihjYW5kaWRhdGUuc2JvbVNoYTI1NikgfHwgIUFycmF5LmlzQXJyYXkoY2FuZGlkYXRlLmZpbmRpbmdzKSkge1xuICAgICAgICBlcnJvcnMucHVzaCgndnVsbmVyYWJpbGl0eS1zY2FuIGV2aWRlbmNlIGlzIG1hbGZvcm1lZCcpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc2Nhbm5lZFNib21TaGEyNTYgPSBjYW5kaWRhdGUuc2JvbVNoYTI1NjtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKGtpbmQgPT09ICdzZWNyZXQtc2NhbicpIHtcbiAgICAgIGlmICghQXJyYXkuaXNBcnJheShjYW5kaWRhdGUuZmluZGluZ3MpIHx8IGNhbmRpZGF0ZS5maW5kaW5ncy5sZW5ndGggIT09IDApIHtcbiAgICAgICAgZXJyb3JzLnB1c2goJ3NlY3JldC1zY2FuIGV2aWRlbmNlIG11c3QgcmVwb3J0IHplcm8gZmluZGluZ3MnKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKGtpbmQgPT09ICdwcm92ZW5hbmNlLWF0dGVzdGF0aW9uJykge1xuICAgICAgaWYgKFxuICAgICAgICBjYW5kaWRhdGUudmFsaWQgIT09IHRydWUgfHxcbiAgICAgICAgdHlwZW9mIGNhbmRpZGF0ZS5wcmVkaWNhdGVUeXBlICE9PSAnc3RyaW5nJyB8fFxuICAgICAgICBjYW5kaWRhdGUucHJlZGljYXRlVHlwZS50cmltKCkubGVuZ3RoID09PSAwIHx8XG4gICAgICAgICFpc0hleFNoYTI1NihjYW5kaWRhdGUuYXR0ZXN0YXRpb25TaGEyNTYpIHx8XG4gICAgICAgIHR5cGVvZiBjYW5kaWRhdGUuaXNzdWVkQXQgIT09ICdzdHJpbmcnIHx8XG4gICAgICAgICFOdW1iZXIuaXNGaW5pdGUoRGF0ZS5wYXJzZShjYW5kaWRhdGUuaXNzdWVkQXQpKVxuICAgICAgKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKCdwcm92ZW5hbmNlLWF0dGVzdGF0aW9uIGV2aWRlbmNlIGlzIG1hbGZvcm1lZCBvciBpbnZhbGlkJyk7XG4gICAgICB9IGVsc2UgaWYgKG1heEF0dGVzdGF0aW9uQWdlTXMgIT09IG51bGwpIHtcbiAgICAgICAgY29uc3QgYWdlTXMgPSBEYXRlLm5vdygpIC0gRGF0ZS5wYXJzZShjYW5kaWRhdGUuaXNzdWVkQXQpO1xuICAgICAgICBpZiAoYWdlTXMgPCAwIHx8IGFnZU1zID4gbWF4QXR0ZXN0YXRpb25BZ2VNcykge1xuICAgICAgICAgIGVycm9ycy5wdXNoKCdwcm92ZW5hbmNlLWF0dGVzdGF0aW9uIGV2aWRlbmNlIGlzIG91dHNpZGUgdGhlIGRlY2xhcmVkIGZyZXNobmVzcyBwb2xpY3knKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuICBmb3IgKGNvbnN0IGtpbmQgb2YgUkVRVUlSRURfVFJVU1RfRVZJREVOQ0UpIHtcbiAgICBpZiAoIXNlZW4uaGFzKGtpbmQpKSBlcnJvcnMucHVzaChgdHJ1c3RSZXBvcnQuZXZpZGVuY2UgaXMgbWlzc2luZyAnJHtraW5kfSdgKTtcbiAgfVxuICBpZiAodmFsdWUuZXZpZGVuY2UubGVuZ3RoICE9PSBSRVFVSVJFRF9UUlVTVF9FVklERU5DRS5sZW5ndGgpIHtcbiAgICBlcnJvcnMucHVzaCgndHJ1c3RSZXBvcnQuZXZpZGVuY2UgbXVzdCBjb250YWluIGV4YWN0bHkgdGhlIGZpdmUgcmVxdWlyZWQgZXZpZGVuY2UgY2xhc3NlcycpO1xuICB9XG4gIGlmIChzYm9tU2hhMjU2ICYmIHNjYW5uZWRTYm9tU2hhMjU2ICYmIHNib21TaGEyNTYgIT09IHNjYW5uZWRTYm9tU2hhMjU2KSB7XG4gICAgZXJyb3JzLnB1c2goJ3Z1bG5lcmFiaWxpdHktc2NhbiBldmlkZW5jZSBpcyBib3VuZCB0byBhIGRpZmZlcmVudCBTQk9NJyk7XG4gIH1cbiAgcmV0dXJuIGVycm9ycztcbn1cblxuZnVuY3Rpb24gZmlsZURlc2NyaXB0b3IodmFsdWU6IHVua25vd24sIGV4cGVjdGVkTmFtZTogc3RyaW5nKTogU3RvcmVkRmlsZURlc2NyaXB0b3IgfCBudWxsIHtcbiAgaWYgKFxuICAgICFpc1JlY29yZCh2YWx1ZSkgfHxcbiAgICB2YWx1ZS5uYW1lICE9PSBleHBlY3RlZE5hbWUgfHxcbiAgICAhaXNIZXhTaGEyNTYodmFsdWUuc2hhMjU2KSB8fFxuICAgICFOdW1iZXIuaXNTYWZlSW50ZWdlcih2YWx1ZS5zaXplQnl0ZXMpIHx8XG4gICAgTnVtYmVyKHZhbHVlLnNpemVCeXRlcykgPD0gMFxuICApIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICByZXR1cm4geyBzaGEyNTY6IHZhbHVlLnNoYTI1Niwgc2l6ZUJ5dGVzOiBOdW1iZXIodmFsdWUuc2l6ZUJ5dGVzKSB9O1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVB1YmxpY2F0aW9uTWFuaWZlc3QoXG4gIHZhbHVlOiB1bmtub3duLFxuICBidW5kbGVTaGEyNTY6IHN0cmluZyxcbiAgc3RvcmVkOiBSZWNvcmQ8V29ya3NwYWNlSG9zdENvcmVBcnRpZmFjdEZpbGUsIFN0b3JlZEZpbGVEZXNjcmlwdG9yPixcbik6IHN0cmluZ1tdIHtcbiAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAoIWlzUmVjb3JkKHZhbHVlKSkgcmV0dXJuIFsnbWFuaWZlc3QgbXVzdCBiZSBhIEpTT04gb2JqZWN0J107XG4gIGNvbnN0IGFsbG93ZWRUb3BMZXZlbCA9IG5ldyBTZXQoWydzY2hlbWFWZXJzaW9uJywgJ2tpbmQnLCAnYXJ0aWZhY3QnLCAnZmlsZXMnLCAndHJ1c3RSZXBvcnQnXSk7XG4gIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHZhbHVlKSkge1xuICAgIGlmICghYWxsb3dlZFRvcExldmVsLmhhcyhrZXkpKSBlcnJvcnMucHVzaChgdW5leHBlY3RlZCBtYW5pZmVzdCBmaWVsZCAnJHtrZXl9J2ApO1xuICB9XG4gIGlmICh2YWx1ZS5zY2hlbWFWZXJzaW9uICE9PSBQVUJMSUNBVElPTl9TQ0hFTUFfVkVSU0lPTikge1xuICAgIGVycm9ycy5wdXNoKGBzY2hlbWFWZXJzaW9uIG11c3QgYmUgJHtQVUJMSUNBVElPTl9TQ0hFTUFfVkVSU0lPTn1gKTtcbiAgfVxuICBpZiAodmFsdWUua2luZCAhPT0gUFVCTElDQVRJT05fS0lORCkgZXJyb3JzLnB1c2goYGtpbmQgbXVzdCBiZSAnJHtQVUJMSUNBVElPTl9LSU5EfSdgKTtcblxuICBjb25zdCBzZWNyZXRFcnJvciA9IHNlY3JldE1hdGVyaWFsRXJyb3IodmFsdWUpO1xuICBpZiAoc2VjcmV0RXJyb3IpIGVycm9ycy5wdXNoKHNlY3JldEVycm9yKTtcblxuICBjb25zdCBmaWxlcyA9IHZhbHVlLmZpbGVzO1xuICBjb25zdCBidW5kbGUgPSBpc1JlY29yZChmaWxlcykgPyBmaWxlRGVzY3JpcHRvcihmaWxlcy5idW5kbGUsICdzZXJ2ZXIudGd6JykgOiBudWxsO1xuICBjb25zdCBzaWduYXR1cmUgPSBpc1JlY29yZChmaWxlcykgPyBmaWxlRGVzY3JpcHRvcihmaWxlcy5zaWduYXR1cmUsICdzZXJ2ZXIudGd6Lm1pbmlzaWcnKSA6IG51bGw7XG4gIGlmICghYnVuZGxlKSBlcnJvcnMucHVzaCgnZmlsZXMuYnVuZGxlIG11c3QgZGVzY3JpYmUgc2VydmVyLnRneiB3aXRoIGEgZGlnZXN0IGFuZCBwb3NpdGl2ZSBzaXplJyk7XG4gIGlmICghc2lnbmF0dXJlKSB7XG4gICAgZXJyb3JzLnB1c2goJ2ZpbGVzLnNpZ25hdHVyZSBtdXN0IGRlc2NyaWJlIHNlcnZlci50Z3oubWluaXNpZyB3aXRoIGEgZGlnZXN0IGFuZCBwb3NpdGl2ZSBzaXplJyk7XG4gIH1cbiAgaWYgKGJ1bmRsZSAmJiAoYnVuZGxlLnNoYTI1NiAhPT0gYnVuZGxlU2hhMjU2IHx8IGJ1bmRsZS5zaXplQnl0ZXMgIT09IHN0b3JlZFsnc2VydmVyLnRneiddLnNpemVCeXRlcykpIHtcbiAgICBlcnJvcnMucHVzaCgnZmlsZXMuYnVuZGxlIGRvZXMgbm90IG1hdGNoIHRoZSB1cGxvYWRlZCBjb250ZW50LWFkZHJlc3NlZCBidW5kbGUnKTtcbiAgfVxuICBpZiAoXG4gICAgc2lnbmF0dXJlICYmXG4gICAgKHNpZ25hdHVyZS5zaGEyNTYgIT09IHN0b3JlZFsnc2VydmVyLnRnei5taW5pc2lnJ10uc2hhMjU2IHx8XG4gICAgICBzaWduYXR1cmUuc2l6ZUJ5dGVzICE9PSBzdG9yZWRbJ3NlcnZlci50Z3oubWluaXNpZyddLnNpemVCeXRlcylcbiAgKSB7XG4gICAgZXJyb3JzLnB1c2goJ2ZpbGVzLnNpZ25hdHVyZSBkb2VzIG5vdCBtYXRjaCB0aGUgdXBsb2FkZWQgZGV0YWNoZWQgc2lnbmF0dXJlJyk7XG4gIH1cblxuICBsZXQgYXJ0aWZhY3Q6IFdvcmtzcGFjZUhvc3RJbWFnZUFydGlmYWN0IHwgbnVsbCA9IG51bGw7XG4gIGlmICghaXNSZWNvcmQodmFsdWUuYXJ0aWZhY3QpKSB7XG4gICAgZXJyb3JzLnB1c2goJ2FydGlmYWN0IG11c3QgYmUgYSBXb3Jrc3BhY2VIb3N0SW1hZ2VBcnRpZmFjdCBvYmplY3QnKTtcbiAgfSBlbHNlIHtcbiAgICBhcnRpZmFjdCA9IHZhbHVlLmFydGlmYWN0IGFzIHVua25vd24gYXMgV29ya3NwYWNlSG9zdEltYWdlQXJ0aWZhY3Q7XG4gICAgdHJ5IHtcbiAgICAgIGVycm9ycy5wdXNoKC4uLnZhbGlkYXRlV29ya3NwYWNlSG9zdEltYWdlQXJ0aWZhY3QoYXJ0aWZhY3QpLm1hcCgoZXJyb3IpID0+IGBhcnRpZmFjdDogJHtlcnJvcn1gKSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGVycm9ycy5wdXNoKGBhcnRpZmFjdCB2YWxpZGF0aW9uIGZhaWxlZDogJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcil9YCk7XG4gICAgfVxuICB9XG5cbiAgaWYgKGFydGlmYWN0KSB7XG4gICAgY29uc3QgY2Fub25pY2FsID0gZGVyaXZlV29ya3NwYWNlSG9zdENhbm9uaWNhbEFydGlmYWN0VXJscyhidW5kbGVTaGEyNTYpO1xuICAgIGlmIChcbiAgICAgIGFydGlmYWN0LnJlbGVhc2UuYnVuZGxlU2hhMjU2ICE9PSBidW5kbGVTaGEyNTYgfHxcbiAgICAgIGFydGlmYWN0LmJ1aWxkTWFuaWZlc3QucmVsZWFzZUFydGlmYWN0LnNoYTI1NiAhPT0gYnVuZGxlU2hhMjU2XG4gICAgKSB7XG4gICAgICBlcnJvcnMucHVzaCgnYXJ0aWZhY3QgcmVsZWFzZS9idWlsZCBkaWdlc3RzIG11c3QgZXF1YWwgdGhlIGFkZHJlc3NlZCBidW5kbGUgZGlnZXN0Jyk7XG4gICAgfVxuICAgIGlmIChhcnRpZmFjdC5idWlsZE1hbmlmZXN0LnJlbGVhc2VBcnRpZmFjdC5zaXplQnl0ZXMgIT09IHN0b3JlZFsnc2VydmVyLnRneiddLnNpemVCeXRlcykge1xuICAgICAgZXJyb3JzLnB1c2goJ2FydGlmYWN0IGJ1aWxkIG1hbmlmZXN0IHNpemUgZG9lcyBub3QgZXF1YWwgdGhlIHVwbG9hZGVkIGJ1bmRsZSBzaXplJyk7XG4gICAgfVxuICAgIGlmIChcbiAgICAgIGFydGlmYWN0LnJlbGVhc2UuYnVuZGxlVXJsICE9PSBjYW5vbmljYWwuYnVuZGxlVXJsIHx8XG4gICAgICBhcnRpZmFjdC5yZWxlYXNlLnNpZ25hdHVyZVVybCAhPT0gY2Fub25pY2FsLnNpZ25hdHVyZVVybFxuICAgICkge1xuICAgICAgZXJyb3JzLnB1c2goJ2FydGlmYWN0IHJlbGVhc2UgVVJMcyBtdXN0IGVxdWFsIHRoZSBELTEwNSBkaWdlc3QtZGVyaXZlZCBDdXBib2FyZCBVUkxzJyk7XG4gICAgfVxuICAgIGlmIChhcnRpZmFjdC5saWZlY3ljbGUuc3RhdGUgIT09ICdhY3RpdmUnKSBlcnJvcnMucHVzaCgnYXJ0aWZhY3QgbGlmZWN5Y2xlIG11c3QgYmUgYWN0aXZlIGF0IHB1YmxpY2F0aW9uJyk7XG4gICAgaWYgKGJ1bmRsZSAmJiBzaWduYXR1cmUpIHtcbiAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAuLi52YWxpZGF0ZVRydXN0UmVwb3J0KFxuICAgICAgICAgIHZhbHVlLnRydXN0UmVwb3J0LFxuICAgICAgICAgIGJ1bmRsZVNoYTI1NixcbiAgICAgICAgICBidW5kbGUsXG4gICAgICAgICAgc2lnbmF0dXJlLFxuICAgICAgICAgIGFydGlmYWN0LnJlbGVhc2Uuc2lnbmluZ0tleVNoYTI1NixcbiAgICAgICAgKSxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIHJldHVybiBbLi4ubmV3IFNldChlcnJvcnMpXTtcbn1cblxuZnVuY3Rpb24gcGFyc2VGaW5hbGl6YXRpb25SZWNvcmQodmFsdWU6IHVua25vd24sIGJ1bmRsZVNoYTI1Njogc3RyaW5nKTogRmluYWxpemF0aW9uUmVjb3JkIHwgbnVsbCB7XG4gIGlmIChcbiAgICAhaXNSZWNvcmQodmFsdWUpIHx8XG4gICAgdmFsdWUuc2NoZW1hVmVyc2lvbiAhPT0gUFVCTElDQVRJT05fU0NIRU1BX1ZFUlNJT04gfHxcbiAgICB2YWx1ZS5raW5kICE9PSBGSU5BTElaQVRJT05fS0lORCB8fFxuICAgIHZhbHVlLmJ1bmRsZVNoYTI1NiAhPT0gYnVuZGxlU2hhMjU2IHx8XG4gICAgIWlzSGV4U2hhMjU2KHZhbHVlLm1hbmlmZXN0U2hhMjU2KSB8fFxuICAgIHR5cGVvZiB2YWx1ZS5maW5hbGl6ZWRBdCAhPT0gJ3N0cmluZycgfHxcbiAgICAhTnVtYmVyLmlzRmluaXRlKERhdGUucGFyc2UodmFsdWUuZmluYWxpemVkQXQpKSB8fFxuICAgICFOdW1iZXIuaXNTYWZlSW50ZWdlcih2YWx1ZS5maW5hbGl6ZWRCeUdpdGh1YlVzZXJJZCkgfHxcbiAgICBOdW1iZXIodmFsdWUuZmluYWxpemVkQnlHaXRodWJVc2VySWQpIDw9IDAgfHxcbiAgICAhaXNSZWNvcmQodmFsdWUuZmlsZXMpXG4gICkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGNvbnN0IGZpbGVzID0ge30gYXMgUmVjb3JkPFdvcmtzcGFjZUhvc3RDb3JlQXJ0aWZhY3RGaWxlLCBTdG9yZWRGaWxlRGVzY3JpcHRvcj47XG4gIGZvciAoY29uc3QgZmlsZSBvZiBXT1JLU1BBQ0VfSE9TVF9BUlRJRkFDVF9GSUxFUykge1xuICAgIGNvbnN0IHJhdyA9IHZhbHVlLmZpbGVzW2ZpbGVdO1xuICAgIGlmICghaXNSZWNvcmQocmF3KSB8fCAhaXNIZXhTaGEyNTYocmF3LnNoYTI1NikgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKHJhdy5zaXplQnl0ZXMpIHx8IE51bWJlcihyYXcuc2l6ZUJ5dGVzKSA8PSAwKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgZmlsZXNbZmlsZV0gPSB7IHNoYTI1NjogcmF3LnNoYTI1Niwgc2l6ZUJ5dGVzOiBOdW1iZXIocmF3LnNpemVCeXRlcykgfTtcbiAgfVxuICBpZiAoZmlsZXNbJ3NlcnZlci50Z3onXS5zaGEyNTYgIT09IGJ1bmRsZVNoYTI1NiB8fCBmaWxlc1snbWFuaWZlc3QuanNvbiddLnNoYTI1NiAhPT0gdmFsdWUubWFuaWZlc3RTaGEyNTYpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICByZXR1cm4ge1xuICAgIHNjaGVtYVZlcnNpb246IFBVQkxJQ0FUSU9OX1NDSEVNQV9WRVJTSU9OLFxuICAgIGtpbmQ6IEZJTkFMSVpBVElPTl9LSU5ELFxuICAgIGJ1bmRsZVNoYTI1NixcbiAgICBtYW5pZmVzdFNoYTI1NjogdmFsdWUubWFuaWZlc3RTaGEyNTYsXG4gICAgZmlsZXMsXG4gICAgZmluYWxpemVkQXQ6IHZhbHVlLmZpbmFsaXplZEF0LFxuICAgIGZpbmFsaXplZEJ5R2l0aHViVXNlcklkOiBOdW1iZXIodmFsdWUuZmluYWxpemVkQnlHaXRodWJVc2VySWQpLFxuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWFkRmluYWxpemF0aW9uUmVjb3JkKGVudjogRW52LCBidW5kbGVTaGEyNTY6IHN0cmluZyk6IFByb21pc2U8RmluYWxpemF0aW9uUmVjb3JkIHwgbnVsbD4ge1xuICBjb25zdCBvYmplY3QgPSBhd2FpdCBlbnYuQVJUSUZBQ1RTLmdldChmaW5hbGl6YXRpb25LZXkoYnVuZGxlU2hhMjU2KSk7XG4gIGlmICghb2JqZWN0KSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCByZWNvcmQgPSBwYXJzZUZpbmFsaXphdGlvblJlY29yZChKU09OLnBhcnNlKGF3YWl0IG9iamVjdC50ZXh0KCkpLCBidW5kbGVTaGEyNTYpO1xuICAgIGNvbnN0IG1ldGFkYXRhID0gb2JqZWN0LmN1c3RvbU1ldGFkYXRhID8/IHt9O1xuICAgIGlmIChcbiAgICAgICFyZWNvcmQgfHxcbiAgICAgIG1ldGFkYXRhLm5hbWVzcGFjZSAhPT0gJ3dvcmtzcGFjZS1ob3N0LXYxJyB8fFxuICAgICAgbWV0YWRhdGEuYnVuZGxlU2hhMjU2ICE9PSBidW5kbGVTaGEyNTYgfHxcbiAgICAgIG1ldGFkYXRhLm1hbmlmZXN0U2hhMjU2ICE9PSByZWNvcmQubWFuaWZlc3RTaGEyNTYgfHxcbiAgICAgIG1ldGFkYXRhLmZpbmFsaXplZEJ5R2l0aHViVXNlcklkICE9PSBTdHJpbmcocmVjb3JkLmZpbmFsaXplZEJ5R2l0aHViVXNlcklkKVxuICAgICkge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIHJldHVybiByZWNvcmQ7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZpbmFsaXphdGlvbk9iamVjdHNNYXRjaChlbnY6IEVudiwgcmVjb3JkOiBGaW5hbGl6YXRpb25SZWNvcmQpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgZm9yIChjb25zdCBmaWxlIG9mIFdPUktTUEFDRV9IT1NUX0FSVElGQUNUX0ZJTEVTKSB7XG4gICAgY29uc3Qgb2JqZWN0ID0gYXdhaXQgZW52LkFSVElGQUNUUy5oZWFkKGFydGlmYWN0S2V5KHJlY29yZC5idW5kbGVTaGEyNTYsIGZpbGUpKTtcbiAgICBpZiAoIWRlc2NyaXB0b3JNYXRjaGVzKG9iamVjdCwgZmlsZSwgcmVjb3JkLmJ1bmRsZVNoYTI1NiwgcmVjb3JkLmZpbGVzW2ZpbGVdKSkgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vKiogU3VwcGxlbWVudGFyeSBldmlkZW5jZSBpcyBhbHJlYWR5IHBpbm5lZCBieSB0aGUgaW1tdXRhYmxlIG1hbmlmZXN0LiBBdHRhY2hpbmdcbiAqIGl0cyBleGFjdCBieXRlcyBtdXN0IG5ldmVyIHJlcGxhY2UgdGhhdCBtYW5pZmVzdCBvciBpdHMgdGhyZWUtb2JqZWN0IG1hcmtlci4gKi9cbmFzeW5jIGZ1bmN0aW9uIGZpbmFsaXplZFNib21EaWdlc3QoZW52OiBFbnYsIGJ1bmRsZVNoYTI1Njogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGNvbnN0IHJlY29yZCA9IGF3YWl0IHJlYWRGaW5hbGl6YXRpb25SZWNvcmQoZW52LCBidW5kbGVTaGEyNTYpO1xuICBpZiAoIXJlY29yZCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IG9iamVjdCA9IGF3YWl0IGVudi5BUlRJRkFDVFMuZ2V0KGFydGlmYWN0S2V5KGJ1bmRsZVNoYTI1NiwgJ21hbmlmZXN0Lmpzb24nKSk7XG4gIGlmICghZGVzY3JpcHRvck1hdGNoZXMob2JqZWN0LCAnbWFuaWZlc3QuanNvbicsIGJ1bmRsZVNoYTI1NiwgcmVjb3JkLmZpbGVzWydtYW5pZmVzdC5qc29uJ10pKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgYnl0ZXMgPSBhd2FpdCBvYmplY3QhLmFycmF5QnVmZmVyKCk7XG4gIGlmIChieXRlcy5ieXRlTGVuZ3RoICE9PSByZWNvcmQuZmlsZXNbJ21hbmlmZXN0Lmpzb24nXS5zaXplQnl0ZXMgfHxcbiAgICAgIGF3YWl0IHNoYTI1NkhleChieXRlcykgIT09IHJlY29yZC5tYW5pZmVzdFNoYTI1NikgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgbWFuaWZlc3Q6IHVua25vd24gPSBKU09OLnBhcnNlKG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShieXRlcykpO1xuICAgIGlmICghaXNSZWNvcmQobWFuaWZlc3QpIHx8ICFpc1JlY29yZChtYW5pZmVzdC50cnVzdFJlcG9ydCkgfHxcbiAgICAgICAgIUFycmF5LmlzQXJyYXkobWFuaWZlc3QudHJ1c3RSZXBvcnQuZXZpZGVuY2UpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBzYm9tcyA9IG1hbmlmZXN0LnRydXN0UmVwb3J0LmV2aWRlbmNlLmZpbHRlcigoZW50cnkpID0+IGlzUmVjb3JkKGVudHJ5KSAmJiBlbnRyeS5raW5kID09PSAnc2JvbScpO1xuICAgIGNvbnN0IHNib20gPSBzYm9tc1swXTtcbiAgICByZXR1cm4gc2JvbXMubGVuZ3RoID09PSAxICYmIGlzUmVjb3JkKHNib20pICYmIHNib20uc3ViamVjdFNoYTI1NiA9PT0gYnVuZGxlU2hhMjU2ICYmXG4gICAgICBzYm9tLmZvcm1hdCA9PT0gJ2N5Y2xvbmVkeC1qc29uJyAmJiBpc0hleFNoYTI1NihzYm9tLmRvY3VtZW50U2hhMjU2KSA/IHNib20uZG9jdW1lbnRTaGEyNTYgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiB1cGxvYWRBcnRpZmFjdChjOiBDb250ZXh0PHsgQmluZGluZ3M6IEVudiB9Pik6IFByb21pc2U8UmVzcG9uc2U+IHtcbiAgY29uc3Qgb3BlcmF0b3IgPSBhd2FpdCByZXF1aXJlT3BlcmF0b3IoYyk7XG4gIGlmIChvcGVyYXRvciBpbnN0YW5jZW9mIFJlc3BvbnNlKSByZXR1cm4gb3BlcmF0b3I7XG5cbiAgY29uc3QgYnVuZGxlU2hhMjU2ID0gYy5yZXEucGFyYW0oJ2J1bmRsZVNoYTI1NicpO1xuICBjb25zdCByYXdGaWxlID0gYy5yZXEucGFyYW0oJ2ZpbGUnKTtcbiAgaWYgKCFpc0hleFNoYTI1NihidW5kbGVTaGEyNTYpKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2J1bmRsZV9zaGEyNTYnIH0sIDQwMCk7XG4gIGlmICghaXNBcnRpZmFjdEZpbGUocmF3RmlsZSkpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ25vdF9mb3VuZCcgfSwgNDA0KTtcbiAgY29uc3QgZmlsZSA9IHJhd0ZpbGU7XG5cbiAgY29uc3QgZGVjbGFyZWRTaGEyNTYgPSBjLnJlcS5oZWFkZXIoJ3gtYXJ0aWZhY3Qtc2hhMjU2JykgPz8gJyc7XG4gIGNvbnN0IGRlY2xhcmVkU2l6ZSA9IHBhcnNlUG9zaXRpdmVJbnRlZ2VyKGMucmVxLmhlYWRlcigneC1hcnRpZmFjdC1zaXplJykpO1xuICBpZiAoIWlzSGV4U2hhMjU2KGRlY2xhcmVkU2hhMjU2KSkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9hcnRpZmFjdF9zaGEyNTYnIH0sIDQwMCk7XG4gIGlmIChkZWNsYXJlZFNpemUgPT09IG51bGwpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfYXJ0aWZhY3Rfc2l6ZScgfSwgNDAwKTtcbiAgaWYgKGZpbGUgPT09ICdzZXJ2ZXIudGd6JyAmJiBkZWNsYXJlZFNoYTI1NiAhPT0gYnVuZGxlU2hhMjU2KSB7XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnYnVuZGxlX2RpZ2VzdF9taXNtYXRjaCcgfSwgNDAwKTtcbiAgfVxuICBpZiAoZGVjbGFyZWRTaXplID4gTUFYX0JZVEVTW2ZpbGVdKSB7XG4gICAgaWYgKGZpbGUgPT09ICdzZXJ2ZXIudGd6Jykge1xuICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAge1xuICAgICAgICAgIGVycm9yOiAnYXJ0aWZhY3RfdG9vX2xhcmdlJyxcbiAgICAgICAgICBtYXhCeXRlczogTUFYX0JZVEVTW2ZpbGVdLFxuICAgICAgICAgIG11bHRpcGFydDoge1xuICAgICAgICAgICAgZW5kcG9pbnQ6IGAvYWRtaW4vYXJ0aWZhY3RzL3dvcmtzcGFjZS1ob3N0L3NoYTI1Ni8ke2J1bmRsZVNoYTI1Nn0vc2VydmVyLnRnei9tdWx0aXBhcnRgLFxuICAgICAgICAgICAgbWF4UGFydEJ5dGVzOiBXT1JLU1BBQ0VfSE9TVF9NVUxUSVBBUlRfTUFYX1BBUlRfQllURVMsXG4gICAgICAgICAgICBtYXhQYXJ0czogV09SS1NQQUNFX0hPU1RfTVVMVElQQVJUX01BWF9QQVJUUyxcbiAgICAgICAgICAgIG1heEJ1bmRsZUJ5dGVzOiBXT1JLU1BBQ0VfSE9TVF9NVUxUSVBBUlRfTUFYX0JVTkRMRV9CWVRFUyxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICA0MTMsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdhcnRpZmFjdF90b29fbGFyZ2UnLCBtYXhCeXRlczogTUFYX0JZVEVTW2ZpbGVdIH0sIDQxMyk7XG4gIH1cbiAgY29uc3QgY29udGVudExlbmd0aCA9IGMucmVxLmhlYWRlcignY29udGVudC1sZW5ndGgnKTtcbiAgaWYgKGNvbnRlbnRMZW5ndGgpIHtcbiAgICBjb25zdCBwYXJzZWRDb250ZW50TGVuZ3RoID0gcGFyc2VQb3NpdGl2ZUludGVnZXIoY29udGVudExlbmd0aCk7XG4gICAgaWYgKHBhcnNlZENvbnRlbnRMZW5ndGggPT09IG51bGwgfHwgcGFyc2VkQ29udGVudExlbmd0aCAhPT0gZGVjbGFyZWRTaXplKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdjb250ZW50X2xlbmd0aF9taXNtYXRjaCcgfSwgNDAwKTtcbiAgICB9XG4gIH1cblxuICBpZiAoZmlsZSA9PT0gJ3Nib20uY2R4Lmpzb24nKSB7XG4gICAgY29uc3QgYm91bmREaWdlc3QgPSBhd2FpdCBmaW5hbGl6ZWRTYm9tRGlnZXN0KGMuZW52LCBidW5kbGVTaGEyNTYpO1xuICAgIGlmICghYm91bmREaWdlc3QpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ZpbmFsaXplZF9zYm9tX2JpbmRpbmdfcmVxdWlyZWQnIH0sIDQwOSk7XG4gICAgaWYgKGRlY2xhcmVkU2hhMjU2ICE9PSBib3VuZERpZ2VzdCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnc2JvbV9iaW5kaW5nX21pc21hdGNoJyB9LCA0MDkpO1xuICB9XG4gIGNvbnN0IGtleSA9IGFydGlmYWN0S2V5KGJ1bmRsZVNoYTI1NiwgZmlsZSk7XG4gIGNvbnN0IGV4cGVjdGVkID0geyBzaGEyNTY6IGRlY2xhcmVkU2hhMjU2LCBzaXplQnl0ZXM6IGRlY2xhcmVkU2l6ZSB9O1xuICBjb25zdCBleGlzdGluZyA9IGF3YWl0IGMuZW52LkFSVElGQUNUUy5oZWFkKGtleSk7XG4gIGlmIChleGlzdGluZykge1xuICAgIGlmIChkZXNjcmlwdG9yTWF0Y2hlcyhleGlzdGluZywgZmlsZSwgYnVuZGxlU2hhMjU2LCBleHBlY3RlZCkpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBvazogdHJ1ZSwgZmlsZSwgc2hhMjU2OiBkZWNsYXJlZFNoYTI1NiwgYnl0ZXM6IGRlY2xhcmVkU2l6ZSwgZGVkdXBlZDogdHJ1ZSB9KTtcbiAgICB9XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnYXJ0aWZhY3RfY29uZmxpY3QnLCBmaWxlIH0sIDQwOSk7XG4gIH1cbiAgaWYgKGZpbGUgIT09ICdzYm9tLmNkeC5qc29uJyAmJiBhd2FpdCBjLmVudi5BUlRJRkFDVFMuaGVhZChmaW5hbGl6YXRpb25LZXkoYnVuZGxlU2hhMjU2KSkpIHtcbiAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdhcnRpZmFjdF9maW5hbGl6ZWQnIH0sIDQwOSk7XG4gIH1cblxuICBjb25zdCBib2R5ID0gYXdhaXQgYy5yZXEucmF3LmFycmF5QnVmZmVyKCk7XG4gIGlmIChib2R5LmJ5dGVMZW5ndGggIT09IGRlY2xhcmVkU2l6ZSkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnYXJ0aWZhY3Rfc2l6ZV9taXNtYXRjaCcgfSwgNDAwKTtcbiAgY29uc3QgYWN0dWFsU2hhMjU2ID0gYXdhaXQgc2hhMjU2SGV4KGJvZHkpO1xuICBpZiAoYWN0dWFsU2hhMjU2ICE9PSBkZWNsYXJlZFNoYTI1Nikge1xuICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2FydGlmYWN0X3NoYTI1Nl9taXNtYXRjaCcsIGV4cGVjdGVkOiBkZWNsYXJlZFNoYTI1NiwgYWN0dWFsOiBhY3R1YWxTaGEyNTYgfSwgNDAwKTtcbiAgfVxuXG4gIGNvbnN0IG91dGNvbWUgPSBhd2FpdCBwdXRDcmVhdGVPbmx5KGMuZW52LkFSVElGQUNUUywga2V5LCBib2R5LCB7XG4gICAgaHR0cE1ldGFkYXRhOiB7IGNvbnRlbnRUeXBlOiBDT05URU5UX1RZUEVbZmlsZV0gfSxcbiAgICBjdXN0b21NZXRhZGF0YTogbWV0YWRhdGFGb3IoZmlsZSwgYnVuZGxlU2hhMjU2LCBkZWNsYXJlZFNoYTI1NiwgZGVjbGFyZWRTaXplLCBvcGVyYXRvci5pZCksXG4gICAgc2hhMjU2OiBkZWNsYXJlZFNoYTI1NixcbiAgfSk7XG4gIGlmIChvdXRjb21lID09PSAnZXhpc3RzJykge1xuICAgIGNvbnN0IHJhY2VkID0gYXdhaXQgYy5lbnYuQVJUSUZBQ1RTLmhlYWQoa2V5KTtcbiAgICBpZiAoZGVzY3JpcHRvck1hdGNoZXMocmFjZWQsIGZpbGUsIGJ1bmRsZVNoYTI1NiwgZXhwZWN0ZWQpKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIGZpbGUsIHNoYTI1NjogZGVjbGFyZWRTaGEyNTYsIGJ5dGVzOiBkZWNsYXJlZFNpemUsIGRlZHVwZWQ6IHRydWUgfSk7XG4gICAgfVxuICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2FydGlmYWN0X2NvbmZsaWN0JywgZmlsZSB9LCA0MDkpO1xuICB9XG4gIHJldHVybiBjLmpzb24oXG4gICAgeyBvazogdHJ1ZSwgZmlsZSwgc2hhMjU2OiBkZWNsYXJlZFNoYTI1NiwgYnl0ZXM6IGRlY2xhcmVkU2l6ZSwgZGVkdXBlZDogZmFsc2UgfSxcbiAgICAyMDEsXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGluaXRpYXRlTXVsdGlwYXJ0QXJ0aWZhY3QoYzogQ29udGV4dDx7IEJpbmRpbmdzOiBFbnYgfT4pOiBQcm9taXNlPFJlc3BvbnNlPiB7XG4gIGNvbnN0IG9wZXJhdG9yID0gYXdhaXQgcmVxdWlyZU9wZXJhdG9yKGMpO1xuICBpZiAob3BlcmF0b3IgaW5zdGFuY2VvZiBSZXNwb25zZSkgcmV0dXJuIG9wZXJhdG9yO1xuXG4gIGNvbnN0IGJ1bmRsZVNoYTI1NiA9IGMucmVxLnBhcmFtKCdidW5kbGVTaGEyNTYnKTtcbiAgaWYgKCFpc0hleFNoYTI1NihidW5kbGVTaGEyNTYpKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2J1bmRsZV9zaGEyNTYnIH0sIDQwMCk7XG4gIGNvbnN0IGRlY2xhcmVkU2hhMjU2ID0gYy5yZXEuaGVhZGVyKCd4LWFydGlmYWN0LXNoYTI1NicpID8/ICcnO1xuICBjb25zdCBkZWNsYXJlZFNpemUgPSBwYXJzZVBvc2l0aXZlSW50ZWdlcihjLnJlcS5oZWFkZXIoJ3gtYXJ0aWZhY3Qtc2l6ZScpKTtcbiAgaWYgKCFpc0hleFNoYTI1NihkZWNsYXJlZFNoYTI1NikpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfYXJ0aWZhY3Rfc2hhMjU2JyB9LCA0MDApO1xuICBpZiAoZGVjbGFyZWRTaGEyNTYgIT09IGJ1bmRsZVNoYTI1NikgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnYnVuZGxlX2RpZ2VzdF9taXNtYXRjaCcgfSwgNDAwKTtcbiAgaWYgKGRlY2xhcmVkU2l6ZSA9PT0gbnVsbCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9hcnRpZmFjdF9zaXplJyB9LCA0MDApO1xuICBpZiAoZGVjbGFyZWRTaXplID4gV09SS1NQQUNFX0hPU1RfTVVMVElQQVJUX01BWF9CVU5ETEVfQllURVMpIHtcbiAgICByZXR1cm4gYy5qc29uKFxuICAgICAgeyBlcnJvcjogJ2FydGlmYWN0X3Rvb19sYXJnZScsIG1heEJ5dGVzOiBXT1JLU1BBQ0VfSE9TVF9NVUxUSVBBUlRfTUFYX0JVTkRMRV9CWVRFUyB9LFxuICAgICAgNDEzLFxuICAgICk7XG4gIH1cbiAgLy8gVGhlIGNhbGxlciBwZXJzaXN0cyB0aGlzIG9uZS11c2UgaWRlbnRpdHkgaW4gaXRzIHRhc2svb3BlcmF0aW9uIGpvdXJuYWxcbiAgLy8gQkVGT1JFIGlzc3VpbmcgdGhlIG11dGF0aW9uLiBJdCBpcyBhbHNvIHRoZSBwdWJsaWMgbXVsdGlwYXJ0IGNhcGFiaWxpdHksXG4gIC8vIHdoaWNoIG1ha2VzIGEgbG9zdCByZXNwb25zZSByZWNvdmVyYWJsZSB3aXRob3V0IGV4cG9zaW5nIHRoZSBvcGFxdWUgbmF0aXZlXG4gIC8vIFIyIHVwbG9hZCBpZCBvciBjcmVhdGluZyBhIHNlY29uZCBwcm92aWRlciB1cGxvYWQuXG4gIGNvbnN0IHVwbG9hZElkID0gYy5yZXEuaGVhZGVyKCd4LW9wZXJhdGlvbi1pZCcpO1xuICBpZiAoIWlzTXVsdGlwYXJ0VXBsb2FkSWQodXBsb2FkSWQpKSB7XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9tdWx0aXBhcnRfb3BlcmF0aW9uX2lkJyB9LCA0MDApO1xuICB9XG5cbiAgY29uc3Qga2V5ID0gYXJ0aWZhY3RLZXkoYnVuZGxlU2hhMjU2LCAnc2VydmVyLnRneicpO1xuICBjb25zdCBleHBlY3RlZCA9IHsgc2hhMjU2OiBidW5kbGVTaGEyNTYsIHNpemVCeXRlczogZGVjbGFyZWRTaXplIH07XG4gIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgYy5lbnYuQVJUSUZBQ1RTLmhlYWQoa2V5KTtcbiAgaWYgKGV4aXN0aW5nKSB7XG4gICAgaWYgKGRlc2NyaXB0b3JNYXRjaGVzKGV4aXN0aW5nLCAnc2VydmVyLnRneicsIGJ1bmRsZVNoYTI1NiwgZXhwZWN0ZWQpKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGZpbGU6ICdzZXJ2ZXIudGd6JyxcbiAgICAgICAgc2hhMjU2OiBidW5kbGVTaGEyNTYsXG4gICAgICAgIGJ5dGVzOiBkZWNsYXJlZFNpemUsXG4gICAgICAgIGRlZHVwZWQ6IHRydWUsXG4gICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnYXJ0aWZhY3RfY29uZmxpY3QnLCBmaWxlOiAnc2VydmVyLnRneicgfSwgNDA5KTtcbiAgfVxuICBpZiAoYXdhaXQgYy5lbnYuQVJUSUZBQ1RTLmhlYWQoZmluYWxpemF0aW9uS2V5KGJ1bmRsZVNoYTI1NikpKSB7XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnYXJ0aWZhY3RfZmluYWxpemVkJyB9LCA0MDkpO1xuICB9XG5cbiAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRCb3VuZGVkSnNvbihjLnJlcS5yYXcsIE1VTFRJUEFSVF9DT05UUk9MX01BWF9CWVRFUyk7XG4gIGlmICghYm9keS5vaykge1xuICAgIHJldHVybiBjLmpzb24oXG4gICAgICB7IGVycm9yOiBib2R5LmVycm9yIH0sXG4gICAgICBib2R5LmVycm9yID09PSAncmVxdWVzdF90b29fbGFyZ2UnID8gNDEzIDogNDAwLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcGxhbiA9IHBhcnNlTXVsdGlwYXJ0UGxhbihib2R5LnZhbHVlLCBkZWNsYXJlZFNpemUpO1xuICBpZiAocGxhbi5lcnJvcnMubGVuZ3RoID4gMCkge1xuICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfbXVsdGlwYXJ0X3BsYW4nLCBlcnJvcnM6IHBsYW4uZXJyb3JzIH0sIDQwMCk7XG4gIH1cblxuICBjb25zdCBleHBlY3RlZFN0YXRlID0ge1xuICAgIGJ1bmRsZVNoYTI1NixcbiAgICB1cGxvYWRJZCxcbiAgICBzaXplQnl0ZXM6IGRlY2xhcmVkU2l6ZSxcbiAgICBjcmVhdGVkQnlHaXRodWJVc2VySWQ6IG9wZXJhdG9yLmlkLFxuICAgIHBhcnRzOiBwbGFuLnBhcnRzLFxuICB9O1xuICBsZXQgcHJpb3I6IE11bHRpcGFydFVwbG9hZFN0YXRlIHwgbnVsbDtcbiAgdHJ5IHtcbiAgICBwcmlvciA9IGF3YWl0IHJlYWRNdWx0aXBhcnRTdGF0ZShjLmVudiwgYnVuZGxlU2hhMjU2LCB1cGxvYWRJZCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIG11bHRpcGFydFN0b3JhZ2VGYWlsdXJlKGMsIGVycm9yLCAnaW5pdGlhdGUnKTtcbiAgfVxuICBpZiAocHJpb3IpIHtcbiAgICBpZiAocHJpb3IuY3JlYXRlZEJ5R2l0aHViVXNlcklkICE9PSBvcGVyYXRvci5pZCkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbXVsdGlwYXJ0X3VwbG9hZF9vd25lcl9taXNtYXRjaCcgfSwgNDAzKTtcbiAgICB9XG4gICAgaWYgKCFtdWx0aXBhcnRTdGF0ZU1hdGNoZXMocHJpb3IsIGV4cGVjdGVkU3RhdGUpKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdtdWx0aXBhcnRfb3BlcmF0aW9uX2NvbmZsaWN0JyB9LCA0MDkpO1xuICAgIH1cbiAgICByZXR1cm4gYy5qc29uKHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgZmlsZTogJ3NlcnZlci50Z3onLFxuICAgICAgdXBsb2FkSWQsXG4gICAgICBvcGVyYXRpb25JZDogdXBsb2FkSWQsXG4gICAgICBzaGEyNTY6IGJ1bmRsZVNoYTI1NixcbiAgICAgIGJ5dGVzOiBkZWNsYXJlZFNpemUsXG4gICAgICBwYXJ0U2l6ZUJ5dGVzOiBwbGFuLnBhcnRzWzBdLnNpemVCeXRlcyxcbiAgICAgIHBhcnRDb3VudDogcGxhbi5wYXJ0cy5sZW5ndGgsXG4gICAgICBtYXhQYXJ0Qnl0ZXM6IFdPUktTUEFDRV9IT1NUX01VTFRJUEFSVF9NQVhfUEFSVF9CWVRFUyxcbiAgICAgIG1heFBhcnRzOiBXT1JLU1BBQ0VfSE9TVF9NVUxUSVBBUlRfTUFYX1BBUlRTLFxuICAgICAgZGVkdXBlZDogZmFsc2UsXG4gICAgICByZXN1bWVkOiB0cnVlLFxuICAgIH0pO1xuICB9XG5cbiAgbGV0IHVwbG9hZDogTXVsdGlwYXJ0VXBsb2FkO1xuICB0cnkge1xuICAgIHVwbG9hZCA9IGF3YWl0IGMuZW52LkFSVElGQUNUUy5jcmVhdGVNdWx0aXBhcnRVcGxvYWQoa2V5LCB7XG4gICAgICBodHRwTWV0YWRhdGE6IHsgY29udGVudFR5cGU6IENPTlRFTlRfVFlQRVsnc2VydmVyLnRneiddIH0sXG4gICAgICBjdXN0b21NZXRhZGF0YToge1xuICAgICAgICAuLi5tZXRhZGF0YUZvcignc2VydmVyLnRneicsIGJ1bmRsZVNoYTI1NiwgYnVuZGxlU2hhMjU2LCBkZWNsYXJlZFNpemUsIG9wZXJhdG9yLmlkKSxcbiAgICAgICAgdXBsb2FkTW9kZTogJ211bHRpcGFydCcsXG4gICAgICB9LFxuICAgIH0pO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiBtdWx0aXBhcnRTdG9yYWdlRmFpbHVyZShjLCBlcnJvciwgJ2luaXRpYXRlJyk7XG4gIH1cbiAgaWYgKCFpc1IyTXVsdGlwYXJ0VXBsb2FkSWQodXBsb2FkLnVwbG9hZElkKSkge1xuICAgIGF3YWl0IHVwbG9hZC5hYm9ydCgpLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9zdG9yYWdlX3VwbG9hZF9pZCcgfSwgNTAyKTtcbiAgfVxuICBjb25zdCBzdGF0ZTogTXVsdGlwYXJ0VXBsb2FkU3RhdGUgPSB7XG4gICAgc2NoZW1hVmVyc2lvbjogTVVMVElQQVJUX1NUQVRFX1NDSEVNQV9WRVJTSU9OLFxuICAgIGtpbmQ6IE1VTFRJUEFSVF9TVEFURV9LSU5ELFxuICAgIGJ1bmRsZVNoYTI1NixcbiAgICB1cGxvYWRJZCxcbiAgICByMlVwbG9hZElkOiB1cGxvYWQudXBsb2FkSWQsXG4gICAgc2l6ZUJ5dGVzOiBkZWNsYXJlZFNpemUsXG4gICAgY3JlYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgY3JlYXRlZEJ5R2l0aHViVXNlcklkOiBvcGVyYXRvci5pZCxcbiAgICBwYXJ0czogcGxhbi5wYXJ0cyxcbiAgfTtcbiAgdHJ5IHtcbiAgICBjb25zdCBzdGF0ZU91dGNvbWUgPSBhd2FpdCBwdXRDcmVhdGVPbmx5KFxuICAgICAgYy5lbnYuQVJUSUZBQ1RTLFxuICAgICAgbXVsdGlwYXJ0U3RhdGVLZXkoYnVuZGxlU2hhMjU2LCB1cGxvYWRJZCksXG4gICAgICBKU09OLnN0cmluZ2lmeShzdGF0ZSksXG4gICAgICB7XG4gICAgICAgIGh0dHBNZXRhZGF0YTogeyBjb250ZW50VHlwZTogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0sXG4gICAgICAgIGN1c3RvbU1ldGFkYXRhOiB7XG4gICAgICAgICAgbmFtZXNwYWNlOiBNVUxUSVBBUlRfU1RBVEVfTkFNRVNQQUNFLFxuICAgICAgICAgIGJ1bmRsZVNoYTI1NixcbiAgICAgICAgICB1cGxvYWRJZCxcbiAgICAgICAgICBjcmVhdGVkQnlHaXRodWJVc2VySWQ6IFN0cmluZyhvcGVyYXRvci5pZCksXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICk7XG4gICAgaWYgKHN0YXRlT3V0Y29tZSA9PT0gJ2V4aXN0cycpIHtcbiAgICAgIGF3YWl0IHVwbG9hZC5hYm9ydCgpLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XG4gICAgICBsZXQgcmFjZWQ6IE11bHRpcGFydFVwbG9hZFN0YXRlIHwgbnVsbDtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJhY2VkID0gYXdhaXQgcmVhZE11bHRpcGFydFN0YXRlKGMuZW52LCBidW5kbGVTaGEyNTYsIHVwbG9hZElkKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHJldHVybiBtdWx0aXBhcnRTdG9yYWdlRmFpbHVyZShjLCBlcnJvciwgJ2luaXRpYXRlJyk7XG4gICAgICB9XG4gICAgICBpZiAoIXJhY2VkIHx8ICFtdWx0aXBhcnRTdGF0ZU1hdGNoZXMocmFjZWQsIGV4cGVjdGVkU3RhdGUpKSB7XG4gICAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ211bHRpcGFydF9vcGVyYXRpb25fY29uZmxpY3QnIH0sIDQwOSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gYy5qc29uKHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGZpbGU6ICdzZXJ2ZXIudGd6JyxcbiAgICAgICAgdXBsb2FkSWQsXG4gICAgICAgIG9wZXJhdGlvbklkOiB1cGxvYWRJZCxcbiAgICAgICAgc2hhMjU2OiBidW5kbGVTaGEyNTYsXG4gICAgICAgIGJ5dGVzOiBkZWNsYXJlZFNpemUsXG4gICAgICAgIHBhcnRTaXplQnl0ZXM6IHBsYW4ucGFydHNbMF0uc2l6ZUJ5dGVzLFxuICAgICAgICBwYXJ0Q291bnQ6IHBsYW4ucGFydHMubGVuZ3RoLFxuICAgICAgICBtYXhQYXJ0Qnl0ZXM6IFdPUktTUEFDRV9IT1NUX01VTFRJUEFSVF9NQVhfUEFSVF9CWVRFUyxcbiAgICAgICAgbWF4UGFydHM6IFdPUktTUEFDRV9IT1NUX01VTFRJUEFSVF9NQVhfUEFSVFMsXG4gICAgICAgIGRlZHVwZWQ6IGZhbHNlLFxuICAgICAgICByZXN1bWVkOiB0cnVlLFxuICAgICAgfSk7XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGF3YWl0IHVwbG9hZC5hYm9ydCgpLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XG4gICAgcmV0dXJuIG11bHRpcGFydFN0b3JhZ2VGYWlsdXJlKGMsIGVycm9yLCAnaW5pdGlhdGUnKTtcbiAgfVxuXG4gIHJldHVybiBjLmpzb24oXG4gICAge1xuICAgICAgb2s6IHRydWUsXG4gICAgICBmaWxlOiAnc2VydmVyLnRneicsXG4gICAgICB1cGxvYWRJZCxcbiAgICAgIG9wZXJhdGlvbklkOiB1cGxvYWRJZCxcbiAgICAgIHNoYTI1NjogYnVuZGxlU2hhMjU2LFxuICAgICAgYnl0ZXM6IGRlY2xhcmVkU2l6ZSxcbiAgICAgIHBhcnRTaXplQnl0ZXM6IHBsYW4ucGFydHNbMF0uc2l6ZUJ5dGVzLFxuICAgICAgcGFydENvdW50OiBwbGFuLnBhcnRzLmxlbmd0aCxcbiAgICAgIG1heFBhcnRCeXRlczogV09SS1NQQUNFX0hPU1RfTVVMVElQQVJUX01BWF9QQVJUX0JZVEVTLFxuICAgICAgbWF4UGFydHM6IFdPUktTUEFDRV9IT1NUX01VTFRJUEFSVF9NQVhfUEFSVFMsXG4gICAgICBkZWR1cGVkOiBmYWxzZSxcbiAgICAgIHJlc3VtZWQ6IGZhbHNlLFxuICAgIH0sXG4gICAgMjAxLFxuICApO1xufVxuXG5hc3luYyBmdW5jdGlvbiB1cGxvYWRNdWx0aXBhcnRQYXJ0KGM6IENvbnRleHQ8eyBCaW5kaW5nczogRW52IH0+KTogUHJvbWlzZTxSZXNwb25zZT4ge1xuICBjb25zdCBvcGVyYXRvciA9IGF3YWl0IHJlcXVpcmVPcGVyYXRvcihjKTtcbiAgaWYgKG9wZXJhdG9yIGluc3RhbmNlb2YgUmVzcG9uc2UpIHJldHVybiBvcGVyYXRvcjtcbiAgY29uc3QgYnVuZGxlU2hhMjU2ID0gYy5yZXEucGFyYW0oJ2J1bmRsZVNoYTI1NicpO1xuICBjb25zdCB1cGxvYWRJZCA9IGMucmVxLnF1ZXJ5KCd1cGxvYWRJZCcpO1xuICBjb25zdCBwYXJ0TnVtYmVyID0gcGFyc2VQb3NpdGl2ZUludGVnZXIoYy5yZXEucGFyYW0oJ3BhcnROdW1iZXInKSk7XG4gIGlmICghaXNIZXhTaGEyNTYoYnVuZGxlU2hhMjU2KSkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9idW5kbGVfc2hhMjU2JyB9LCA0MDApO1xuICBpZiAoIWlzTXVsdGlwYXJ0VXBsb2FkSWQodXBsb2FkSWQpKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX211bHRpcGFydF91cGxvYWRfaWQnIH0sIDQwMCk7XG4gIGlmIChcbiAgICBwYXJ0TnVtYmVyID09PSBudWxsIHx8XG4gICAgcGFydE51bWJlciA+IFdPUktTUEFDRV9IT1NUX01VTFRJUEFSVF9NQVhfUEFSVFNcbiAgKSB7XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9tdWx0aXBhcnRfcGFydF9udW1iZXInIH0sIDQwMCk7XG4gIH1cblxuICBsZXQgc3RhdGU6IE11bHRpcGFydFVwbG9hZFN0YXRlIHwgbnVsbDtcbiAgdHJ5IHtcbiAgICBzdGF0ZSA9IGF3YWl0IHJlYWRNdWx0aXBhcnRTdGF0ZShjLmVudiwgYnVuZGxlU2hhMjU2LCB1cGxvYWRJZCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIG11bHRpcGFydFN0b3JhZ2VGYWlsdXJlKGMsIGVycm9yLCAncGFydCcpO1xuICB9XG4gIGlmICghc3RhdGUpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ211bHRpcGFydF91cGxvYWRfbm90X2ZvdW5kJyB9LCA0MDQpO1xuICBpZiAoc3RhdGUuY3JlYXRlZEJ5R2l0aHViVXNlcklkICE9PSBvcGVyYXRvci5pZCkge1xuICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ211bHRpcGFydF91cGxvYWRfb3duZXJfbWlzbWF0Y2gnIH0sIDQwMyk7XG4gIH1cbiAgY29uc3QgZXhwZWN0ZWQgPSBzdGF0ZS5wYXJ0c1twYXJ0TnVtYmVyIC0gMV07XG4gIGlmICghZXhwZWN0ZWQgfHwgZXhwZWN0ZWQucGFydE51bWJlciAhPT0gcGFydE51bWJlcikge1xuICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ211bHRpcGFydF9wYXJ0X25vdF9wbGFubmVkJyB9LCA0MDApO1xuICB9XG5cbiAgY29uc3QgZGVjbGFyZWRTaGEyNTYgPSBjLnJlcS5oZWFkZXIoJ3gtcGFydC1zaGEyNTYnKSA/PyAnJztcbiAgY29uc3QgZGVjbGFyZWRTaXplID0gcGFyc2VQb3NpdGl2ZUludGVnZXIoYy5yZXEuaGVhZGVyKCd4LXBhcnQtc2l6ZScpKTtcbiAgaWYgKCFpc0hleFNoYTI1NihkZWNsYXJlZFNoYTI1NikgfHwgZGVjbGFyZWRTaGEyNTYgIT09IGV4cGVjdGVkLnNoYTI1Nikge1xuICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ211bHRpcGFydF9wYXJ0X2RpZ2VzdF9taXNtYXRjaCcgfSwgNDAwKTtcbiAgfVxuICBpZiAoZGVjbGFyZWRTaXplID09PSBudWxsIHx8IGRlY2xhcmVkU2l6ZSAhPT0gZXhwZWN0ZWQuc2l6ZUJ5dGVzKSB7XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbXVsdGlwYXJ0X3BhcnRfc2l6ZV9taXNtYXRjaCcgfSwgNDAwKTtcbiAgfVxuICBjb25zdCBjb250ZW50TGVuZ3RoID0gcGFyc2VQb3NpdGl2ZUludGVnZXIoYy5yZXEuaGVhZGVyKCdjb250ZW50LWxlbmd0aCcpKTtcbiAgaWYgKGNvbnRlbnRMZW5ndGggPT09IG51bGwpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2NvbnRlbnRfbGVuZ3RoX3JlcXVpcmVkJyB9LCA0MTEpO1xuICBpZiAoY29udGVudExlbmd0aCAhPT0gZXhwZWN0ZWQuc2l6ZUJ5dGVzKSB7XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnY29udGVudF9sZW5ndGhfbWlzbWF0Y2gnIH0sIDQwMCk7XG4gIH1cblxuICBjb25zdCBib2R5ID0gYXdhaXQgYy5yZXEucmF3LmFycmF5QnVmZmVyKCk7XG4gIGlmIChib2R5LmJ5dGVMZW5ndGggIT09IGV4cGVjdGVkLnNpemVCeXRlcykge1xuICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ211bHRpcGFydF9wYXJ0X3NpemVfbWlzbWF0Y2gnIH0sIDQwMCk7XG4gIH1cbiAgY29uc3QgYWN0dWFsU2hhMjU2ID0gYXdhaXQgc2hhMjU2SGV4KGJvZHkpO1xuICBpZiAoYWN0dWFsU2hhMjU2ICE9PSBleHBlY3RlZC5zaGEyNTYpIHtcbiAgICByZXR1cm4gYy5qc29uKFxuICAgICAgeyBlcnJvcjogJ211bHRpcGFydF9wYXJ0X3NoYTI1Nl9taXNtYXRjaCcsIGV4cGVjdGVkOiBleHBlY3RlZC5zaGEyNTYsIGFjdHVhbDogYWN0dWFsU2hhMjU2IH0sXG4gICAgICA0MDAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IHJlY2VpcHRJZGVudGl0eSA9IHsgYnVuZGxlU2hhMjU2LCB1cGxvYWRJZCwgcGFydE51bWJlciB9O1xuICBjb25zdCByZWNlaXB0RXhwZWN0ZWQgPSB7IC4uLmV4cGVjdGVkLCBjcmVhdGVkQnlHaXRodWJVc2VySWQ6IG9wZXJhdG9yLmlkIH07XG4gIGxldCBwcmlvclJlY2VpcHQ6IE11bHRpcGFydFBhcnRSZWNlaXB0IHwgbnVsbDtcbiAgdHJ5IHtcbiAgICBwcmlvclJlY2VpcHQgPSBhd2FpdCByZWFkTXVsdGlwYXJ0UGFydFJlY2VpcHQoYy5lbnYsIHJlY2VpcHRJZGVudGl0eSk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIG11bHRpcGFydFN0b3JhZ2VGYWlsdXJlKGMsIGVycm9yLCAncGFydC1yZWNvbmNpbGUnKTtcbiAgfVxuICBpZiAocHJpb3JSZWNlaXB0KSB7XG4gICAgaWYgKCFtdWx0aXBhcnRQYXJ0UmVjZWlwdE1hdGNoZXMocHJpb3JSZWNlaXB0LCByZWNlaXB0RXhwZWN0ZWQpKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdtdWx0aXBhcnRfcGFydF9vcGVyYXRpb25fY29uZmxpY3QnIH0sIDQwOSk7XG4gICAgfVxuICAgIGlmIChwcmlvclJlY2VpcHQuc3RhdGUgPT09ICdpbnRlbnQnKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdtdWx0aXBhcnRfcGFydF9vdXRjb21lX3Vua25vd24nLCB1cGxvYWRJZCwgcGFydE51bWJlciB9LCA0MDkpO1xuICAgIH1cbiAgICByZXR1cm4gYy5qc29uKHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdXBsb2FkSWQsXG4gICAgICBwYXJ0TnVtYmVyLFxuICAgICAgZXRhZzogcHJpb3JSZWNlaXB0LmV0YWcsXG4gICAgICBzaGEyNTY6IHByaW9yUmVjZWlwdC5zaGEyNTYsXG4gICAgICBieXRlczogcHJpb3JSZWNlaXB0LnNpemVCeXRlcyxcbiAgICAgIGRlZHVwZWQ6IHRydWUsXG4gICAgICByZXN1bWVkOiB0cnVlLFxuICAgIH0pO1xuICB9XG5cbiAgY29uc3QgcmVjZWlwdEtleSA9IG11bHRpcGFydFBhcnRSZWNlaXB0S2V5KGJ1bmRsZVNoYTI1NiwgdXBsb2FkSWQsIHBhcnROdW1iZXIpO1xuICBjb25zdCByZWNlaXB0TWV0YWRhdGEgPSB7XG4gICAgbmFtZXNwYWNlOiBNVUxUSVBBUlRfUEFSVF9SRUNFSVBUX05BTUVTUEFDRSxcbiAgICBidW5kbGVTaGEyNTYsXG4gICAgdXBsb2FkSWQsXG4gICAgcGFydE51bWJlcjogU3RyaW5nKHBhcnROdW1iZXIpLFxuICAgIGNyZWF0ZWRCeUdpdGh1YlVzZXJJZDogU3RyaW5nKG9wZXJhdG9yLmlkKSxcbiAgfTtcbiAgY29uc3QgaW50ZW50OiBNdWx0aXBhcnRQYXJ0UmVjZWlwdCA9IHtcbiAgICBzY2hlbWFWZXJzaW9uOiAxLFxuICAgIGtpbmQ6IE1VTFRJUEFSVF9QQVJUX1JFQ0VJUFRfS0lORCxcbiAgICBzdGF0ZTogJ2ludGVudCcsXG4gICAgYnVuZGxlU2hhMjU2LFxuICAgIHVwbG9hZElkLFxuICAgIHBhcnROdW1iZXIsXG4gICAgc2hhMjU2OiBhY3R1YWxTaGEyNTYsXG4gICAgc2l6ZUJ5dGVzOiBib2R5LmJ5dGVMZW5ndGgsXG4gICAgY3JlYXRlZEJ5R2l0aHViVXNlcklkOiBvcGVyYXRvci5pZCxcbiAgICBjcmVhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgfTtcbiAgdHJ5IHtcbiAgICBjb25zdCBjbGFpbWVkID0gYXdhaXQgcHV0Q3JlYXRlT25seShjLmVudi5BUlRJRkFDVFMsIHJlY2VpcHRLZXksIEpTT04uc3RyaW5naWZ5KGludGVudCksIHtcbiAgICAgIGh0dHBNZXRhZGF0YTogeyBjb250ZW50VHlwZTogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0sXG4gICAgICBjdXN0b21NZXRhZGF0YTogcmVjZWlwdE1ldGFkYXRhLFxuICAgIH0pO1xuICAgIGlmIChjbGFpbWVkID09PSAnZXhpc3RzJykge1xuICAgICAgY29uc3QgcmFjZWQgPSBhd2FpdCByZWFkTXVsdGlwYXJ0UGFydFJlY2VpcHQoYy5lbnYsIHJlY2VpcHRJZGVudGl0eSk7XG4gICAgICBpZiAoIXJhY2VkIHx8ICFtdWx0aXBhcnRQYXJ0UmVjZWlwdE1hdGNoZXMocmFjZWQsIHJlY2VpcHRFeHBlY3RlZCkpIHtcbiAgICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbXVsdGlwYXJ0X3BhcnRfb3BlcmF0aW9uX2NvbmZsaWN0JyB9LCA0MDkpO1xuICAgICAgfVxuICAgICAgaWYgKHJhY2VkLnN0YXRlID09PSAnaW50ZW50Jykge1xuICAgICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdtdWx0aXBhcnRfcGFydF9vdXRjb21lX3Vua25vd24nLCB1cGxvYWRJZCwgcGFydE51bWJlciB9LCA0MDkpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGMuanNvbih7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICB1cGxvYWRJZCxcbiAgICAgICAgcGFydE51bWJlcixcbiAgICAgICAgZXRhZzogcmFjZWQuZXRhZyxcbiAgICAgICAgc2hhMjU2OiByYWNlZC5zaGEyNTYsXG4gICAgICAgIGJ5dGVzOiByYWNlZC5zaXplQnl0ZXMsXG4gICAgICAgIGRlZHVwZWQ6IHRydWUsXG4gICAgICAgIHJlc3VtZWQ6IHRydWUsXG4gICAgICB9KTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIG11bHRpcGFydFN0b3JhZ2VGYWlsdXJlKGMsIGVycm9yLCAncGFydC1pbnRlbnQnKTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgY29uc3QgcGFydCA9IGF3YWl0IGMuZW52LkFSVElGQUNUU1xuICAgICAgLnJlc3VtZU11bHRpcGFydFVwbG9hZChhcnRpZmFjdEtleShidW5kbGVTaGEyNTYsICdzZXJ2ZXIudGd6JyksIHN0YXRlLnIyVXBsb2FkSWQpXG4gICAgICAudXBsb2FkUGFydChwYXJ0TnVtYmVyLCBib2R5KTtcbiAgICBjb25zdCBjb21taXR0ZWQ6IE11bHRpcGFydFBhcnRSZWNlaXB0ID0ge1xuICAgICAgLi4uaW50ZW50LFxuICAgICAgc3RhdGU6ICdjb21taXR0ZWQnLFxuICAgICAgZXRhZzogcGFydC5ldGFnLFxuICAgICAgY29tbWl0dGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICB9O1xuICAgIGF3YWl0IGMuZW52LkFSVElGQUNUUy5wdXQocmVjZWlwdEtleSwgSlNPTi5zdHJpbmdpZnkoY29tbWl0dGVkKSwge1xuICAgICAgaHR0cE1ldGFkYXRhOiB7IGNvbnRlbnRUeXBlOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSxcbiAgICAgIGN1c3RvbU1ldGFkYXRhOiByZWNlaXB0TWV0YWRhdGEsXG4gICAgfSk7XG4gICAgcmV0dXJuIGMuanNvbih7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHVwbG9hZElkLFxuICAgICAgcGFydE51bWJlcjogcGFydC5wYXJ0TnVtYmVyLFxuICAgICAgZXRhZzogcGFydC5ldGFnLFxuICAgICAgc2hhMjU2OiBhY3R1YWxTaGEyNTYsXG4gICAgICBieXRlczogYm9keS5ieXRlTGVuZ3RoLFxuICAgICAgZGVkdXBlZDogZmFsc2UsXG4gICAgICByZXN1bWVkOiBmYWxzZSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4gbXVsdGlwYXJ0U3RvcmFnZUZhaWx1cmUoYywgZXJyb3IsICdwYXJ0Jyk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0TXVsdGlwYXJ0U3RhdHVzKGM6IENvbnRleHQ8eyBCaW5kaW5nczogRW52IH0+KTogUHJvbWlzZTxSZXNwb25zZT4ge1xuICBjb25zdCBvcGVyYXRvciA9IGF3YWl0IHJlcXVpcmVPcGVyYXRvcihjKTtcbiAgaWYgKG9wZXJhdG9yIGluc3RhbmNlb2YgUmVzcG9uc2UpIHJldHVybiBvcGVyYXRvcjtcbiAgY29uc3QgYnVuZGxlU2hhMjU2ID0gYy5yZXEucGFyYW0oJ2J1bmRsZVNoYTI1NicpO1xuICBjb25zdCB1cGxvYWRJZCA9IGMucmVxLnF1ZXJ5KCd1cGxvYWRJZCcpO1xuICBjb25zdCBwYXJ0TnVtYmVyID0gcGFyc2VQb3NpdGl2ZUludGVnZXIoYy5yZXEucXVlcnkoJ3BhcnROdW1iZXInKSk7XG4gIGlmICghaXNIZXhTaGEyNTYoYnVuZGxlU2hhMjU2KSkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9idW5kbGVfc2hhMjU2JyB9LCA0MDApO1xuICBpZiAoIWlzTXVsdGlwYXJ0VXBsb2FkSWQodXBsb2FkSWQpKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX211bHRpcGFydF91cGxvYWRfaWQnIH0sIDQwMCk7XG4gIGlmIChwYXJ0TnVtYmVyID09PSBudWxsIHx8IHBhcnROdW1iZXIgPiBXT1JLU1BBQ0VfSE9TVF9NVUxUSVBBUlRfTUFYX1BBUlRTKSB7XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9tdWx0aXBhcnRfcGFydF9udW1iZXInIH0sIDQwMCk7XG4gIH1cbiAgbGV0IHN0YXRlOiBNdWx0aXBhcnRVcGxvYWRTdGF0ZSB8IG51bGw7XG4gIGxldCByZWNlaXB0OiBNdWx0aXBhcnRQYXJ0UmVjZWlwdCB8IG51bGw7XG4gIHRyeSB7XG4gICAgW3N0YXRlLCByZWNlaXB0XSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgIHJlYWRNdWx0aXBhcnRTdGF0ZShjLmVudiwgYnVuZGxlU2hhMjU2LCB1cGxvYWRJZCksXG4gICAgICByZWFkTXVsdGlwYXJ0UGFydFJlY2VpcHQoYy5lbnYsIHsgYnVuZGxlU2hhMjU2LCB1cGxvYWRJZCwgcGFydE51bWJlciB9KSxcbiAgICBdKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4gbXVsdGlwYXJ0U3RvcmFnZUZhaWx1cmUoYywgZXJyb3IsICdzdGF0dXMnKTtcbiAgfVxuICBpZiAoIXN0YXRlKSB7XG4gICAgY29uc3Qgb2JqZWN0ID0gYXdhaXQgYy5lbnYuQVJUSUZBQ1RTLmhlYWQoYXJ0aWZhY3RLZXkoYnVuZGxlU2hhMjU2LCAnc2VydmVyLnRneicpKTtcbiAgICBjb25zdCBkZXNjcmlwdG9yID0gZGVzY3JpcHRvckZyb21PYmplY3Qob2JqZWN0LCAnc2VydmVyLnRneicsIGJ1bmRsZVNoYTI1Nik7XG4gICAgcmV0dXJuIGRlc2NyaXB0b3JcbiAgICAgID8gYy5qc29uKHsgb2s6IHRydWUsIHVwbG9hZElkLCBjb21wbGV0ZWQ6IHRydWUsIGJ1bmRsZTogZGVzY3JpcHRvciB9KVxuICAgICAgOiBjLmpzb24oeyBlcnJvcjogJ211bHRpcGFydF91cGxvYWRfbm90X2ZvdW5kJyB9LCA0MDQpO1xuICB9XG4gIGlmIChzdGF0ZS5jcmVhdGVkQnlHaXRodWJVc2VySWQgIT09IG9wZXJhdG9yLmlkKSB7XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbXVsdGlwYXJ0X3VwbG9hZF9vd25lcl9taXNtYXRjaCcgfSwgNDAzKTtcbiAgfVxuICBjb25zdCBleHBlY3RlZCA9IHN0YXRlLnBhcnRzW3BhcnROdW1iZXIgLSAxXTtcbiAgaWYgKCFleHBlY3RlZCB8fCBleHBlY3RlZC5wYXJ0TnVtYmVyICE9PSBwYXJ0TnVtYmVyKSB7XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbXVsdGlwYXJ0X3BhcnRfbm90X3BsYW5uZWQnIH0sIDQwMCk7XG4gIH1cbiAgaWYgKCFyZWNlaXB0KSByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIHVwbG9hZElkLCBwYXJ0TnVtYmVyLCBzdGF0ZTogJ2Fic2VudCcgfSk7XG4gIGlmICghbXVsdGlwYXJ0UGFydFJlY2VpcHRNYXRjaGVzKHJlY2VpcHQsIHsgLi4uZXhwZWN0ZWQsIGNyZWF0ZWRCeUdpdGh1YlVzZXJJZDogb3BlcmF0b3IuaWQgfSkpIHtcbiAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdtdWx0aXBhcnRfcGFydF9vcGVyYXRpb25fY29uZmxpY3QnIH0sIDQwOSk7XG4gIH1cbiAgcmV0dXJuIGMuanNvbih7XG4gICAgb2s6IHRydWUsXG4gICAgdXBsb2FkSWQsXG4gICAgcGFydE51bWJlcixcbiAgICBzdGF0ZTogcmVjZWlwdC5zdGF0ZSxcbiAgICBzaGEyNTY6IHJlY2VpcHQuc2hhMjU2LFxuICAgIGJ5dGVzOiByZWNlaXB0LnNpemVCeXRlcyxcbiAgICAuLi4ocmVjZWlwdC5zdGF0ZSA9PT0gJ2NvbW1pdHRlZCcgPyB7IGV0YWc6IHJlY2VpcHQuZXRhZyB9IDoge30pLFxuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY29tcGxldGVNdWx0aXBhcnRBcnRpZmFjdChjOiBDb250ZXh0PHsgQmluZGluZ3M6IEVudiB9Pik6IFByb21pc2U8UmVzcG9uc2U+IHtcbiAgY29uc3Qgb3BlcmF0b3IgPSBhd2FpdCByZXF1aXJlT3BlcmF0b3IoYyk7XG4gIGlmIChvcGVyYXRvciBpbnN0YW5jZW9mIFJlc3BvbnNlKSByZXR1cm4gb3BlcmF0b3I7XG4gIGNvbnN0IGJ1bmRsZVNoYTI1NiA9IGMucmVxLnBhcmFtKCdidW5kbGVTaGEyNTYnKTtcbiAgY29uc3QgdXBsb2FkSWQgPSBjLnJlcS5xdWVyeSgndXBsb2FkSWQnKTtcbiAgaWYgKCFpc0hleFNoYTI1NihidW5kbGVTaGEyNTYpKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2J1bmRsZV9zaGEyNTYnIH0sIDQwMCk7XG4gIGlmICghaXNNdWx0aXBhcnRVcGxvYWRJZCh1cGxvYWRJZCkpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfbXVsdGlwYXJ0X3VwbG9hZF9pZCcgfSwgNDAwKTtcblxuICBjb25zdCBrZXkgPSBhcnRpZmFjdEtleShidW5kbGVTaGEyNTYsICdzZXJ2ZXIudGd6Jyk7XG4gIGxldCBzdGF0ZTogTXVsdGlwYXJ0VXBsb2FkU3RhdGUgfCBudWxsO1xuICB0cnkge1xuICAgIHN0YXRlID0gYXdhaXQgcmVhZE11bHRpcGFydFN0YXRlKGMuZW52LCBidW5kbGVTaGEyNTYsIHVwbG9hZElkKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4gbXVsdGlwYXJ0U3RvcmFnZUZhaWx1cmUoYywgZXJyb3IsICdjb21wbGV0ZScpO1xuICB9XG4gIGlmICghc3RhdGUpIHtcbiAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IGMuZW52LkFSVElGQUNUUy5oZWFkKGtleSk7XG4gICAgY29uc3QgZGVzY3JpcHRvciA9IGRlc2NyaXB0b3JGcm9tT2JqZWN0KGV4aXN0aW5nLCAnc2VydmVyLnRneicsIGJ1bmRsZVNoYTI1Nik7XG4gICAgaWYgKGRlc2NyaXB0b3IpIHtcbiAgICAgIHJldHVybiBjLmpzb24oe1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgZmlsZTogJ3NlcnZlci50Z3onLFxuICAgICAgICBzaGEyNTY6IGJ1bmRsZVNoYTI1NixcbiAgICAgICAgYnl0ZXM6IGRlc2NyaXB0b3Iuc2l6ZUJ5dGVzLFxuICAgICAgICBkZWR1cGVkOiB0cnVlLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGlmIChleGlzdGluZykgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnYXJ0aWZhY3RfY29uZmxpY3QnLCBmaWxlOiAnc2VydmVyLnRneicgfSwgNDA5KTtcbiAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdtdWx0aXBhcnRfdXBsb2FkX25vdF9mb3VuZCcgfSwgNDA0KTtcbiAgfVxuICBpZiAoc3RhdGUuY3JlYXRlZEJ5R2l0aHViVXNlcklkICE9PSBvcGVyYXRvci5pZCkge1xuICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ211bHRpcGFydF91cGxvYWRfb3duZXJfbWlzbWF0Y2gnIH0sIDQwMyk7XG4gIH1cblxuICBjb25zdCBleHBlY3RlZCA9IHsgc2hhMjU2OiBidW5kbGVTaGEyNTYsIHNpemVCeXRlczogc3RhdGUuc2l6ZUJ5dGVzIH07XG4gIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgYy5lbnYuQVJUSUZBQ1RTLmhlYWQoa2V5KTtcbiAgaWYgKGV4aXN0aW5nKSB7XG4gICAgaWYgKCFkZXNjcmlwdG9yTWF0Y2hlcyhleGlzdGluZywgJ3NlcnZlci50Z3onLCBidW5kbGVTaGEyNTYsIGV4cGVjdGVkKSkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnYXJ0aWZhY3RfY29uZmxpY3QnLCBmaWxlOiAnc2VydmVyLnRneicgfSwgNDA5KTtcbiAgICB9XG4gICAgYXdhaXQgYy5lbnYuQVJUSUZBQ1RTXG4gICAgICAucmVzdW1lTXVsdGlwYXJ0VXBsb2FkKGtleSwgc3RhdGUucjJVcGxvYWRJZClcbiAgICAgIC5hYm9ydCgpXG4gICAgICAuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgICBhd2FpdCBjLmVudi5BUlRJRkFDVFMuZGVsZXRlKG11bHRpcGFydFN0YXRlS2V5KGJ1bmRsZVNoYTI1NiwgdXBsb2FkSWQpKTtcbiAgICByZXR1cm4gYy5qc29uKHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgZmlsZTogJ3NlcnZlci50Z3onLFxuICAgICAgc2hhMjU2OiBidW5kbGVTaGEyNTYsXG4gICAgICBieXRlczogc3RhdGUuc2l6ZUJ5dGVzLFxuICAgICAgZGVkdXBlZDogdHJ1ZSxcbiAgICB9KTtcbiAgfVxuICBpZiAoYXdhaXQgYy5lbnYuQVJUSUZBQ1RTLmhlYWQoZmluYWxpemF0aW9uS2V5KGJ1bmRsZVNoYTI1NikpKSB7XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnYXJ0aWZhY3RfZmluYWxpemVkJyB9LCA0MDkpO1xuICB9XG5cbiAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRCb3VuZGVkSnNvbihjLnJlcS5yYXcsIE1VTFRJUEFSVF9DT05UUk9MX01BWF9CWVRFUyk7XG4gIGlmICghYm9keS5vaykge1xuICAgIHJldHVybiBjLmpzb24oXG4gICAgICB7IGVycm9yOiBib2R5LmVycm9yIH0sXG4gICAgICBib2R5LmVycm9yID09PSAncmVxdWVzdF90b29fbGFyZ2UnID8gNDEzIDogNDAwLFxuICAgICk7XG4gIH1cbiAgY29uc3QgY29tcGxldGlvbiA9IHBhcnNlQ29tcGxldGlvblBhcnRzKGJvZHkudmFsdWUsIHN0YXRlLnBhcnRzKTtcbiAgaWYgKGNvbXBsZXRpb24uZXJyb3IpIHtcbiAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX211bHRpcGFydF9jb21wbGV0aW9uJywgZGV0YWlsOiBjb21wbGV0aW9uLmVycm9yIH0sIDQwMCk7XG4gIH1cblxuICB0cnkge1xuICAgIGF3YWl0IGMuZW52LkFSVElGQUNUU1xuICAgICAgLnJlc3VtZU11bHRpcGFydFVwbG9hZChrZXksIHN0YXRlLnIyVXBsb2FkSWQpXG4gICAgICAuY29tcGxldGUoY29tcGxldGlvbi5wYXJ0cyk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgaWYgKHIyRXJyb3JDb2RlKGVycm9yKSA9PT0gMTAwMjQpIHtcbiAgICAgIGNvbnN0IHJhY2VkID0gYXdhaXQgYy5lbnYuQVJUSUZBQ1RTLmhlYWQoa2V5KTtcbiAgICAgIGlmIChkZXNjcmlwdG9yTWF0Y2hlcyhyYWNlZCwgJ3NlcnZlci50Z3onLCBidW5kbGVTaGEyNTYsIGV4cGVjdGVkKSkge1xuICAgICAgICBhd2FpdCBjLmVudi5BUlRJRkFDVFMuZGVsZXRlKG11bHRpcGFydFN0YXRlS2V5KGJ1bmRsZVNoYTI1NiwgdXBsb2FkSWQpKTtcbiAgICAgICAgcmV0dXJuIGMuanNvbih7XG4gICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgZmlsZTogJ3NlcnZlci50Z3onLFxuICAgICAgICAgIHNoYTI1NjogYnVuZGxlU2hhMjU2LFxuICAgICAgICAgIGJ5dGVzOiBzdGF0ZS5zaXplQnl0ZXMsXG4gICAgICAgICAgZGVkdXBlZDogdHJ1ZSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBhd2FpdCBjLmVudi5BUlRJRkFDVFMuZGVsZXRlKG11bHRpcGFydFN0YXRlS2V5KGJ1bmRsZVNoYTI1NiwgdXBsb2FkSWQpKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xuICAgIH1cbiAgICByZXR1cm4gbXVsdGlwYXJ0U3RvcmFnZUZhaWx1cmUoYywgZXJyb3IsICdjb21wbGV0ZScpO1xuICB9XG5cbiAgLy8gUHJvZHVjdGlvbiBSMiBtYXkgcmV0dXJuIGFuIGltbWVkaWF0ZSBjb21wbGV0aW9uIG9iamVjdCB3aXRob3V0IHRoZSBjdXN0b21cbiAgLy8gbWV0YWRhdGEgdGhhdCBpcyBhbHJlYWR5IGR1cmFibGUgb24gdGhlIHN0b3JlZCBvYmplY3QuIEEgZnJlc2ggSEVBRCBpcyB0aGVcbiAgLy8gYXV0aG9yaXRhdGl2ZSBwb3N0LWNvbW1pdCB2aWV3IGFuZCBpcyBhbHNvIHdoYXQgZXZlcnkgcmVwbGF5L2ZpbmFsaXphdGlvblxuICAvLyBwYXRoIGFkanVkaWNhdGVzLiBWYWxpZGF0aW5nIHRoZSB0cmFuc2llbnQgcmV0dXJuIG9iamVjdCBwcm9kdWNlZCBhIGZhbHNlXG4gIC8vIGBtdWx0aXBhcnRfY29tcGxldGVkX29iamVjdF9taXNtYXRjaGAgYWZ0ZXIgYWxsIHBhcnRzIGhhZCBjb21taXR0ZWQgZ3JlZW4uXG4gIGxldCBjb21wbGV0ZWQ6IE9iamVjdE1ldGFkYXRhIHwgbnVsbDtcbiAgdHJ5IHtcbiAgICBjb21wbGV0ZWQgPSBhd2FpdCBjLmVudi5BUlRJRkFDVFMuaGVhZChrZXkpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiBtdWx0aXBhcnRTdG9yYWdlRmFpbHVyZShjLCBlcnJvciwgJ2NvbXBsZXRlJyk7XG4gIH1cbiAgaWYgKCFjb21wbGV0ZWQgfHwgIWRlc2NyaXB0b3JNYXRjaGVzKGNvbXBsZXRlZCwgJ3NlcnZlci50Z3onLCBidW5kbGVTaGEyNTYsIGV4cGVjdGVkKSkge1xuICAgIGF3YWl0IGMuZW52LkFSVElGQUNUUy5kZWxldGUobXVsdGlwYXJ0U3RhdGVLZXkoYnVuZGxlU2hhMjU2LCB1cGxvYWRJZCkpLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbXVsdGlwYXJ0X2NvbXBsZXRlZF9vYmplY3RfbWlzbWF0Y2gnIH0sIDQwOSk7XG4gIH1cbiAgdHJ5IHtcbiAgICBhd2FpdCBjLmVudi5BUlRJRkFDVFMuZGVsZXRlKG11bHRpcGFydFN0YXRlS2V5KGJ1bmRsZVNoYTI1NiwgdXBsb2FkSWQpKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4gbXVsdGlwYXJ0U3RvcmFnZUZhaWx1cmUoYywgZXJyb3IsICdjb21wbGV0ZScpO1xuICB9XG4gIHJldHVybiBjLmpzb24oXG4gICAge1xuICAgICAgb2s6IHRydWUsXG4gICAgICBmaWxlOiAnc2VydmVyLnRneicsXG4gICAgICBzaGEyNTY6IGJ1bmRsZVNoYTI1NixcbiAgICAgIGJ5dGVzOiBzdGF0ZS5zaXplQnl0ZXMsXG4gICAgICBldGFnOiBjb21wbGV0ZWQuaHR0cEV0YWcsXG4gICAgICBkZWR1cGVkOiBmYWxzZSxcbiAgICB9LFxuICAgIDIwMSxcbiAgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gYWJvcnRNdWx0aXBhcnRBcnRpZmFjdChjOiBDb250ZXh0PHsgQmluZGluZ3M6IEVudiB9Pik6IFByb21pc2U8UmVzcG9uc2U+IHtcbiAgY29uc3Qgb3BlcmF0b3IgPSBhd2FpdCByZXF1aXJlT3BlcmF0b3IoYyk7XG4gIGlmIChvcGVyYXRvciBpbnN0YW5jZW9mIFJlc3BvbnNlKSByZXR1cm4gb3BlcmF0b3I7XG4gIGNvbnN0IGJ1bmRsZVNoYTI1NiA9IGMucmVxLnBhcmFtKCdidW5kbGVTaGEyNTYnKTtcbiAgY29uc3QgdXBsb2FkSWQgPSBjLnJlcS5xdWVyeSgndXBsb2FkSWQnKTtcbiAgaWYgKCFpc0hleFNoYTI1NihidW5kbGVTaGEyNTYpKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2J1bmRsZV9zaGEyNTYnIH0sIDQwMCk7XG4gIGlmICghaXNNdWx0aXBhcnRVcGxvYWRJZCh1cGxvYWRJZCkpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfbXVsdGlwYXJ0X3VwbG9hZF9pZCcgfSwgNDAwKTtcblxuICBsZXQgc3RhdGU6IE11bHRpcGFydFVwbG9hZFN0YXRlIHwgbnVsbDtcbiAgdHJ5IHtcbiAgICBzdGF0ZSA9IGF3YWl0IHJlYWRNdWx0aXBhcnRTdGF0ZShjLmVudiwgYnVuZGxlU2hhMjU2LCB1cGxvYWRJZCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIG11bHRpcGFydFN0b3JhZ2VGYWlsdXJlKGMsIGVycm9yLCAnYWJvcnQnKTtcbiAgfVxuICBpZiAoIXN0YXRlKSByZXR1cm4gbmV3IFJlc3BvbnNlKG51bGwsIHsgc3RhdHVzOiAyMDQgfSk7XG4gIGlmIChzdGF0ZS5jcmVhdGVkQnlHaXRodWJVc2VySWQgIT09IG9wZXJhdG9yLmlkKSB7XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbXVsdGlwYXJ0X3VwbG9hZF9vd25lcl9taXNtYXRjaCcgfSwgNDAzKTtcbiAgfVxuICB0cnkge1xuICAgIGF3YWl0IGMuZW52LkFSVElGQUNUU1xuICAgICAgLnJlc3VtZU11bHRpcGFydFVwbG9hZChhcnRpZmFjdEtleShidW5kbGVTaGEyNTYsICdzZXJ2ZXIudGd6JyksIHN0YXRlLnIyVXBsb2FkSWQpXG4gICAgICAuYWJvcnQoKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAocjJFcnJvckNvZGUoZXJyb3IpICE9PSAxMDAyNCkgcmV0dXJuIG11bHRpcGFydFN0b3JhZ2VGYWlsdXJlKGMsIGVycm9yLCAnYWJvcnQnKTtcbiAgfVxuICB0cnkge1xuICAgIGF3YWl0IGMuZW52LkFSVElGQUNUUy5kZWxldGUobXVsdGlwYXJ0U3RhdGVLZXkoYnVuZGxlU2hhMjU2LCB1cGxvYWRJZCkpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiBtdWx0aXBhcnRTdG9yYWdlRmFpbHVyZShjLCBlcnJvciwgJ2Fib3J0Jyk7XG4gIH1cbiAgcmV0dXJuIG5ldyBSZXNwb25zZShudWxsLCB7IHN0YXR1czogMjA0IH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBmaW5hbGl6ZUFydGlmYWN0KGM6IENvbnRleHQ8eyBCaW5kaW5nczogRW52IH0+KTogUHJvbWlzZTxSZXNwb25zZT4ge1xuICBjb25zdCBvcGVyYXRvciA9IGF3YWl0IHJlcXVpcmVPcGVyYXRvcihjKTtcbiAgaWYgKG9wZXJhdG9yIGluc3RhbmNlb2YgUmVzcG9uc2UpIHJldHVybiBvcGVyYXRvcjtcbiAgY29uc3QgYnVuZGxlU2hhMjU2ID0gYy5yZXEucGFyYW0oJ2J1bmRsZVNoYTI1NicpO1xuICBpZiAoIWlzSGV4U2hhMjU2KGJ1bmRsZVNoYTI1NikpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfYnVuZGxlX3NoYTI1NicgfSwgNDAwKTtcblxuICBjb25zdCBtYXJrZXJIZWFkID0gYXdhaXQgYy5lbnYuQVJUSUZBQ1RTLmhlYWQoZmluYWxpemF0aW9uS2V5KGJ1bmRsZVNoYTI1NikpO1xuICBpZiAobWFya2VySGVhZCkge1xuICAgIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgcmVhZEZpbmFsaXphdGlvblJlY29yZChjLmVudiwgYnVuZGxlU2hhMjU2KTtcbiAgICBpZiAoIWV4aXN0aW5nIHx8ICEoYXdhaXQgZmluYWxpemF0aW9uT2JqZWN0c01hdGNoKGMuZW52LCBleGlzdGluZykpKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdmaW5hbGl6YXRpb25fY29uZmxpY3QnIH0sIDQwOSk7XG4gICAgfVxuICAgIHJldHVybiBjLmpzb24oeyBvazogdHJ1ZSwgYnVuZGxlU2hhMjU2LCBtYW5pZmVzdFNoYTI1NjogZXhpc3RpbmcubWFuaWZlc3RTaGEyNTYsIGRlZHVwZWQ6IHRydWUgfSk7XG4gIH1cblxuICBjb25zdCBzdG9yZWQgPSB7fSBhcyBSZWNvcmQ8V29ya3NwYWNlSG9zdENvcmVBcnRpZmFjdEZpbGUsIFN0b3JlZEZpbGVEZXNjcmlwdG9yPjtcbiAgY29uc3QgbWlzc2luZzogV29ya3NwYWNlSG9zdEFydGlmYWN0RmlsZVtdID0gW107XG4gIGZvciAoY29uc3QgZmlsZSBvZiBXT1JLU1BBQ0VfSE9TVF9BUlRJRkFDVF9GSUxFUykge1xuICAgIGNvbnN0IGRlc2NyaXB0b3IgPSBkZXNjcmlwdG9yRnJvbU9iamVjdChhd2FpdCBjLmVudi5BUlRJRkFDVFMuaGVhZChhcnRpZmFjdEtleShidW5kbGVTaGEyNTYsIGZpbGUpKSwgZmlsZSwgYnVuZGxlU2hhMjU2KTtcbiAgICBpZiAoIWRlc2NyaXB0b3IpIG1pc3NpbmcucHVzaChmaWxlKTtcbiAgICBlbHNlIHN0b3JlZFtmaWxlXSA9IGRlc2NyaXB0b3I7XG4gIH1cbiAgaWYgKG1pc3NpbmcubGVuZ3RoID4gMCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAndXBsb2Fkc19pbmNvbXBsZXRlJywgbWlzc2luZyB9LCA0MDkpO1xuXG4gIGNvbnN0IG1hbmlmZXN0T2JqZWN0ID0gYXdhaXQgYy5lbnYuQVJUSUZBQ1RTLmdldChhcnRpZmFjdEtleShidW5kbGVTaGEyNTYsICdtYW5pZmVzdC5qc29uJykpO1xuICBpZiAoIW1hbmlmZXN0T2JqZWN0KSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd1cGxvYWRzX2luY29tcGxldGUnLCBtaXNzaW5nOiBbJ21hbmlmZXN0Lmpzb24nXSB9LCA0MDkpO1xuICBjb25zdCBtYW5pZmVzdEJvZHkgPSBhd2FpdCBtYW5pZmVzdE9iamVjdC5hcnJheUJ1ZmZlcigpO1xuICBjb25zdCBhY3R1YWxNYW5pZmVzdFNoYTI1NiA9IGF3YWl0IHNoYTI1NkhleChtYW5pZmVzdEJvZHkpO1xuICBpZiAoXG4gICAgYWN0dWFsTWFuaWZlc3RTaGEyNTYgIT09IHN0b3JlZFsnbWFuaWZlc3QuanNvbiddLnNoYTI1NiB8fFxuICAgIG1hbmlmZXN0Qm9keS5ieXRlTGVuZ3RoICE9PSBzdG9yZWRbJ21hbmlmZXN0Lmpzb24nXS5zaXplQnl0ZXNcbiAgKSB7XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbWFuaWZlc3Rfc3RvcmFnZV9taXNtYXRjaCcgfSwgNDA5KTtcbiAgfVxuXG4gIGxldCBtYW5pZmVzdDogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICBtYW5pZmVzdCA9IEpTT04ucGFyc2UobmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKG1hbmlmZXN0Qm9keSkpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX21hbmlmZXN0X2pzb24nIH0sIDQwMCk7XG4gIH1cbiAgY29uc3QgZXJyb3JzID0gdmFsaWRhdGVQdWJsaWNhdGlvbk1hbmlmZXN0KG1hbmlmZXN0LCBidW5kbGVTaGEyNTYsIHN0b3JlZCk7XG4gIGlmIChlcnJvcnMubGVuZ3RoID4gMCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9tYW5pZmVzdCcsIGVycm9ycyB9LCA0MDApO1xuXG4gIGNvbnN0IHJlY29yZDogRmluYWxpemF0aW9uUmVjb3JkID0ge1xuICAgIHNjaGVtYVZlcnNpb246IFBVQkxJQ0FUSU9OX1NDSEVNQV9WRVJTSU9OLFxuICAgIGtpbmQ6IEZJTkFMSVpBVElPTl9LSU5ELFxuICAgIGJ1bmRsZVNoYTI1NixcbiAgICBtYW5pZmVzdFNoYTI1NjogYWN0dWFsTWFuaWZlc3RTaGEyNTYsXG4gICAgZmlsZXM6IHN0b3JlZCxcbiAgICBmaW5hbGl6ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIGZpbmFsaXplZEJ5R2l0aHViVXNlcklkOiBvcGVyYXRvci5pZCxcbiAgfTtcbiAgY29uc3QgbWFya2VyQm9keSA9IEpTT04uc3RyaW5naWZ5KHJlY29yZCk7XG4gIGNvbnN0IG91dGNvbWUgPSBhd2FpdCBwdXRDcmVhdGVPbmx5KGMuZW52LkFSVElGQUNUUywgZmluYWxpemF0aW9uS2V5KGJ1bmRsZVNoYTI1NiksIG1hcmtlckJvZHksIHtcbiAgICBodHRwTWV0YWRhdGE6IHsgY29udGVudFR5cGU6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9LFxuICAgIGN1c3RvbU1ldGFkYXRhOiB7XG4gICAgICBuYW1lc3BhY2U6ICd3b3Jrc3BhY2UtaG9zdC12MScsXG4gICAgICBidW5kbGVTaGEyNTYsXG4gICAgICBtYW5pZmVzdFNoYTI1NjogYWN0dWFsTWFuaWZlc3RTaGEyNTYsXG4gICAgICBmaW5hbGl6ZWRCeUdpdGh1YlVzZXJJZDogU3RyaW5nKG9wZXJhdG9yLmlkKSxcbiAgICB9LFxuICB9KTtcbiAgaWYgKG91dGNvbWUgPT09ICdleGlzdHMnKSB7XG4gICAgY29uc3QgcmFjZWQgPSBhd2FpdCByZWFkRmluYWxpemF0aW9uUmVjb3JkKGMuZW52LCBidW5kbGVTaGEyNTYpO1xuICAgIGlmICghcmFjZWQgfHwgcmFjZWQubWFuaWZlc3RTaGEyNTYgIT09IGFjdHVhbE1hbmlmZXN0U2hhMjU2KSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdmaW5hbGl6YXRpb25fY29uZmxpY3QnIH0sIDQwOSk7XG4gICAgfVxuICAgIHJldHVybiBjLmpzb24oeyBvazogdHJ1ZSwgYnVuZGxlU2hhMjU2LCBtYW5pZmVzdFNoYTI1NjogYWN0dWFsTWFuaWZlc3RTaGEyNTYsIGRlZHVwZWQ6IHRydWUgfSk7XG4gIH1cbiAgcmV0dXJuIGMuanNvbih7IG9rOiB0cnVlLCBidW5kbGVTaGEyNTYsIG1hbmlmZXN0U2hhMjU2OiBhY3R1YWxNYW5pZmVzdFNoYTI1NiwgZGVkdXBlZDogZmFsc2UgfSwgMjAxKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc2VydmVBcnRpZmFjdChcbiAgYzogQ29udGV4dDx7IEJpbmRpbmdzOiBFbnYgfT4sXG4gIGhlYWRPbmx5OiBib29sZWFuLFxuKTogUHJvbWlzZTxSZXNwb25zZT4ge1xuICBjb25zdCBidW5kbGVTaGEyNTYgPSBjLnJlcS5wYXJhbSgnYnVuZGxlU2hhMjU2Jyk7XG4gIGNvbnN0IHJhd0ZpbGUgPSBjLnJlcS5wYXJhbSgnZmlsZScpO1xuICBpZiAoIWlzSGV4U2hhMjU2KGJ1bmRsZVNoYTI1NikgfHwgIWlzQXJ0aWZhY3RGaWxlKHJhd0ZpbGUpKSB7XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbm90X2ZvdW5kJyB9LCA0MDQpO1xuICB9XG4gIGNvbnN0IHJlY29yZCA9IGF3YWl0IHJlYWRGaW5hbGl6YXRpb25SZWNvcmQoYy5lbnYsIGJ1bmRsZVNoYTI1Nik7XG4gIGlmICghcmVjb3JkKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdub3RfZm91bmQnIH0sIDQwNCk7XG5cbiAgY29uc3Qga2V5ID0gYXJ0aWZhY3RLZXkoYnVuZGxlU2hhMjU2LCByYXdGaWxlKTtcbiAgY29uc3Qgb2JqZWN0ID0gaGVhZE9ubHkgPyBhd2FpdCBjLmVudi5BUlRJRkFDVFMuaGVhZChrZXkpIDogYXdhaXQgYy5lbnYuQVJUSUZBQ1RTLmdldChrZXkpO1xuICBjb25zdCBzYm9tRGlnZXN0ID0gcmF3RmlsZSA9PT0gJ3Nib20uY2R4Lmpzb24nID8gYXdhaXQgZmluYWxpemVkU2JvbURpZ2VzdChjLmVudiwgYnVuZGxlU2hhMjU2KSA6IG51bGw7XG4gIGNvbnN0IGRlc2NyaXB0b3IgPSByYXdGaWxlID09PSAnc2JvbS5jZHguanNvbidcbiAgICA/IChzYm9tRGlnZXN0ICYmIG9iamVjdCA/IHsgc2hhMjU2OiBzYm9tRGlnZXN0LCBzaXplQnl0ZXM6IG9iamVjdC5zaXplIH0gOiBudWxsKVxuICAgIDogcmVjb3JkLmZpbGVzW3Jhd0ZpbGVdO1xuICBpZiAoIWRlc2NyaXB0b3IgfHwgIWRlc2NyaXB0b3JNYXRjaGVzKG9iamVjdCwgcmF3RmlsZSwgYnVuZGxlU2hhMjU2LCBkZXNjcmlwdG9yKSkge1xuICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ25vdF9mb3VuZCcgfSwgNDA0KTtcbiAgfVxuICBjb25zdCBoZWFkZXJzID0gbmV3IEhlYWRlcnMoKTtcbiAgb2JqZWN0IS53cml0ZUh0dHBNZXRhZGF0YShoZWFkZXJzKTtcbiAgaGVhZGVycy5zZXQoJ2NhY2hlLWNvbnRyb2wnLCBXT1JLU1BBQ0VfSE9TVF9QVUJMSUNfQ0FDSEVfQ09OVFJPTCk7XG4gIGhlYWRlcnMuc2V0KCdjb250ZW50LXR5cGUnLCBDT05URU5UX1RZUEVbcmF3RmlsZV0pO1xuICBoZWFkZXJzLnNldCgnY29udGVudC1sZW5ndGgnLCBTdHJpbmcoZGVzY3JpcHRvci5zaXplQnl0ZXMpKTtcbiAgaGVhZGVycy5zZXQoJ2NvbnRlbnQtZGlzcG9zaXRpb24nLCBgYXR0YWNobWVudDsgZmlsZW5hbWU9XCIke3Jhd0ZpbGV9XCJgKTtcbiAgaGVhZGVycy5zZXQoJ3gtYXJ0aWZhY3Qtc2hhMjU2JywgZGVzY3JpcHRvci5zaGEyNTYpO1xuICBoZWFkZXJzLnNldCgneC1jb250ZW50LXR5cGUtb3B0aW9ucycsICdub3NuaWZmJyk7XG4gIGlmIChvYmplY3QhLmh0dHBFdGFnKSBoZWFkZXJzLnNldCgnZXRhZycsIG9iamVjdCEuaHR0cEV0YWcpO1xuXG4gIGNvbnN0IGJvZHkgPSAhaGVhZE9ubHkgJiYgJ2JvZHknIGluIG9iamVjdCEgPyAob2JqZWN0IGFzIE9iamVjdEJvZHkpLmJvZHkgOiBudWxsO1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKGJvZHksIHsgc3RhdHVzOiAyMDAsIGhlYWRlcnMgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB3b3Jrc3BhY2VIb3N0QXJ0aWZhY3RzUm91dGUoKTogSG9ubzx7IEJpbmRpbmdzOiBFbnYgfT4ge1xuICBjb25zdCBhcHAgPSBuZXcgSG9ubzx7IEJpbmRpbmdzOiBFbnYgfT4oKTtcbiAgY29uc3QgYWRtaW5QYXRoID0gJy9hZG1pbi9hcnRpZmFjdHMvd29ya3NwYWNlLWhvc3Qvc2hhMjU2LzpidW5kbGVTaGEyNTYvOmZpbGUnO1xuICBjb25zdCBwdWJsaWNQYXRoID0gJy9hcnRpZmFjdHMvd29ya3NwYWNlLWhvc3Qvc2hhMjU2LzpidW5kbGVTaGEyNTYvOmZpbGUnO1xuICBjb25zdCBtdWx0aXBhcnRQYXRoID1cbiAgICAnL2FkbWluL2FydGlmYWN0cy93b3Jrc3BhY2UtaG9zdC9zaGEyNTYvOmJ1bmRsZVNoYTI1Ni9zZXJ2ZXIudGd6L211bHRpcGFydCc7XG5cbiAgYXBwLnBvc3QobXVsdGlwYXJ0UGF0aCwgaW5pdGlhdGVNdWx0aXBhcnRBcnRpZmFjdCk7XG4gIGFwcC5nZXQobXVsdGlwYXJ0UGF0aCwgZ2V0TXVsdGlwYXJ0U3RhdHVzKTtcbiAgYXBwLnB1dChgJHttdWx0aXBhcnRQYXRofS9wYXJ0cy86cGFydE51bWJlcmAsIHVwbG9hZE11bHRpcGFydFBhcnQpO1xuICBhcHAucG9zdChgJHttdWx0aXBhcnRQYXRofS9jb21wbGV0ZWAsIGNvbXBsZXRlTXVsdGlwYXJ0QXJ0aWZhY3QpO1xuICBhcHAuZGVsZXRlKG11bHRpcGFydFBhdGgsIGFib3J0TXVsdGlwYXJ0QXJ0aWZhY3QpO1xuICBhcHAucHV0KGFkbWluUGF0aCwgdXBsb2FkQXJ0aWZhY3QpO1xuICBhcHAucG9zdCgnL2FkbWluL2FydGlmYWN0cy93b3Jrc3BhY2UtaG9zdC9zaGEyNTYvOmJ1bmRsZVNoYTI1Ni9maW5hbGl6ZScsIGZpbmFsaXplQXJ0aWZhY3QpO1xuICBhcHAuZ2V0KHB1YmxpY1BhdGgsIChjKSA9PiBzZXJ2ZUFydGlmYWN0KGMsIGZhbHNlKSk7XG4gIGFwcC5vbignSEVBRCcsIHB1YmxpY1BhdGgsIChjKSA9PiBzZXJ2ZUFydGlmYWN0KGMsIHRydWUpKTtcbiAgcmV0dXJuIGFwcDtcbn1cbiJdLCJmaWxlIjoiL3NyYy9yb3V0ZXMvd29ya3NwYWNlLWhvc3QtYXJ0aWZhY3RzLnRzIn0=

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9vcGVyYXRvci1wdWJsaWMvc3JjL3JvdXRlcy93b3Jrc3BhY2UtaG9zdC1hcnRpZmFjdHMudHMiLCIvc3JjL3JvdXRlcy93b3Jrc3BhY2UtaG9zdC1hcnRpZmFjdHMudHMiLFtdXQ==
}}