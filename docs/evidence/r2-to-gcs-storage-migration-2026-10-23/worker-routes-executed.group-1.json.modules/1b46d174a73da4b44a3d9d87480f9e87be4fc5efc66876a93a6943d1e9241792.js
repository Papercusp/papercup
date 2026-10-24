'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/artifact-registry/src/index.ts", {"importedNames":["sha256Hex"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/index.ts", {"importedNames":["WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION","WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION","WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION","WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION","WORKSPACE_HOST_SIDECAR_BUILDER_KIND","buildWorkspaceHostBuildManifest","deriveWorkspaceHostCanonicalArtifactUrls","workspaceHostRequiredReleaseMaterialFixtures"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/dist/index.js", {"importedNames":["afterEach","describe","expect","it"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/src/__tests__/fake-d1.ts", {"importedNames":["makeEnv","stubGithub"]});
const __vite_ssr_import_4__ = await __vite_ssr_import__("/src/routes/index.ts", {"importedNames":["buildApi"]});
const __vite_ssr_import_5__ = await __vite_ssr_import__("/src/routes/workspace-host-artifacts.ts", {"importedNames":["WORKSPACE_HOST_ARTIFACT_PREFIX","WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES","WORKSPACE_HOST_PUBLIC_CACHE_CONTROL"]});






const api = (0,__vite_ssr_import_4__.buildApi)();
const originalFetch = globalThis.fetch;
const VERSION = "2026.8.25-1";
const SBOM_SHA256 = "b".repeat(64);
const ATTESTATION_SHA256 = "c".repeat(64);
(0,__vite_ssr_import_2__.afterEach)(() => {
  globalThis.fetch = originalFetch;
});
async function fixture(mutate, bundleOverride) {
  const bundle = bundleOverride ?? new TextEncoder().encode("verified workspace-host server bundle");
  const signature = new TextEncoder().encode("untrusted comment: signature\nRWSignedBundle");
  const signingPublicKey = "untrusted comment: Papercusp workspace-host release key\nRWQpublickey";
  const [bundleSha256, signatureSha256, signingKeySha256] = await Promise.all([
    (0,__vite_ssr_import_0__.sha256Hex)(bundle),
    (0,__vite_ssr_import_0__.sha256Hex)(signature),
    (0,__vite_ssr_import_0__.sha256Hex)(new TextEncoder().encode(signingPublicKey))
  ]);
  const urls = (0,__vite_ssr_import_1__.deriveWorkspaceHostCanonicalArtifactUrls)(bundleSha256);
  const buildManifest = (0,__vite_ssr_import_1__.buildWorkspaceHostBuildManifest)({
    contractVersion: __vite_ssr_import_1__.WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
    distributionProfile: "vm-release",
    source: {
      repository: "https://github.com/Papercusp/papercusp.git",
      revision: "1".repeat(40)
    },
    releaseArtifact: {
      name: `papercusp-server-${VERSION}.tgz`,
      version: VERSION,
      sha256: bundleSha256,
      sizeBytes: bundle.byteLength
    },
    baseImage: {
      reference: "projects/papercusp-images-123/global/images/ubuntu-2404-minimal",
      architecture: "x86_64",
      sha256: "d".repeat(64)
    },
    builder: {
      strategy: "shared",
      kind: __vite_ssr_import_1__.WORKSPACE_HOST_SIDECAR_BUILDER_KIND,
      version: "0.0.18",
      templatePath: "papercusp-desktop/bin/build-desktop-sidecar.sh",
      templateSha256: "e".repeat(64)
    },
    materials: [
      {
        path: "dist/papercusp-server.tgz",
        sha256: bundleSha256,
        sizeBytes: bundle.byteLength
      },
      // Derived from the release-gate contract, never restated: a material added there must reach
      // this fixture on its own, or the publisher rejects the upload with a 400 naming a path this
      // file never mentions.
      ...(0,__vite_ssr_import_1__.workspaceHostRequiredReleaseMaterialFixtures)()
    ],
    parameters: [{ name: "distribution_profile", value: "vm-release" }],
    targets: [{ provider: "gcp", locations: ["us-central1"] }]
  });
  const artifact = {
    contractVersion: __vite_ssr_import_1__.WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: { id: "papercusp-workspace-host", version: VERSION },
    buildManifest,
    release: {
      version: VERSION,
      bundleUrl: urls.bundleUrl,
      bundleSha256,
      signatureUrl: urls.signatureUrl,
      signingPublicKey,
      signingKeySha256
    },
    lifecycle: { state: "active", publishedAt: "2026-08-25T00:00:00.000Z" },
    compatibility: [
      {
        provider: "gcp",
        architecture: "x86_64",
        ubuntuVersion: __vite_ssr_import_1__.WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
        bootstrapContractVersion: __vite_ssr_import_1__.WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
        actions: ["install"],
        maximumArtifactAgeDays: 30
      }
    ]
  };
  const manifest = {
    schemaVersion: 1,
    kind: "papercusp-workspace-host-release",
    artifact,
    files: {
      bundle: { name: "server.tgz", sha256: bundleSha256, sizeBytes: bundle.byteLength },
      signature: {
        name: "server.tgz.minisig",
        sha256: signatureSha256,
        sizeBytes: signature.byteLength
      }
    },
    trustReport: {
      version: "artifact-trust-v1",
      subject: {
        path: `dist/papercusp-server-${VERSION}.tgz`,
        name: `papercusp-server-${VERSION}.tgz`,
        bytes: bundle.byteLength,
        sha256: bundleSha256,
        signed: true
      },
      policy: {
        denyVulnerabilitiesAtOrAbove: "high",
        maxSecretFindings: 0,
        maxAttestationAgeMs: 60 * 60 * 1e3
      },
      trusted: true,
      evidence: [
        {
          kind: "signature",
          subjectSha256: bundleSha256,
          signatureSha256,
          signingKeySha256,
          tool: { name: "minisign", version: "0.12" },
          valid: true
        },
        {
          kind: "sbom",
          subjectSha256: bundleSha256,
          tool: { name: "syft", version: "1.30" },
          format: "cyclonedx-json",
          documentSha256: SBOM_SHA256,
          componentCount: 42
        },
        {
          kind: "vulnerability-scan",
          subjectSha256: bundleSha256,
          tool: { name: "grype", version: "0.99" },
          sbomSha256: SBOM_SHA256,
          findings: []
        },
        {
          kind: "secret-scan",
          subjectSha256: bundleSha256,
          tool: { name: "gitleaks", version: "8.28" },
          findings: []
        },
        {
          kind: "provenance-attestation",
          subjectSha256: bundleSha256,
          tool: { name: "cosign", version: "2.5" },
          valid: true,
          predicateType: "https://slsa.dev/provenance/v1",
          issuedAt: (/* @__PURE__ */ new Date()).toISOString(),
          attestationSha256: ATTESTATION_SHA256
        }
      ],
      failures: []
    }
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
    manifestSha256: await (0,__vite_ssr_import_0__.sha256Hex)(manifestBytes)
  };
}
function authedEnv() {
  (0,__vite_ssr_import_3__.stubGithub)({ user: { id: 7, login: "operator" } });
  const { env, r2 } = (0,__vite_ssr_import_3__.makeEnv)({ CUPBOARD_OPERATOR_GITHUB_IDS: "7" });
  return { env, r2 };
}
async function upload(env, bundleSha256, file, bytes, declaredSha256) {
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return api.request(
    `/admin/artifacts/workspace-host/sha256/${bundleSha256}/${file}`,
    {
      method: "PUT",
      headers: {
        authorization: "Bearer github-token",
        "content-type": file === "manifest.json" ? "application/json" : "application/octet-stream",
        "x-artifact-sha256": declaredSha256,
        "x-artifact-size": String(bytes.byteLength)
      },
      body
    },
    env
  );
}
async function initiateMultipart(env, bundleSha256, sizeBytes, parts, operationId = crypto.randomUUID()) {
  return api.request(
    `/admin/artifacts/workspace-host/sha256/${bundleSha256}/server.tgz/multipart`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer github-token",
        "content-type": "application/json",
        "x-artifact-sha256": bundleSha256,
        "x-artifact-size": String(sizeBytes),
        "x-operation-id": operationId
      },
      body: JSON.stringify({ parts })
    },
    env
  );
}
async function uploadMultipartPart(env, bundleSha256, uploadId, partNumber, bytes, declaredSha256) {
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return api.request(
    `/admin/artifacts/workspace-host/sha256/${bundleSha256}/server.tgz/multipart/parts/${partNumber}?uploadId=${encodeURIComponent(uploadId)}`,
    {
      method: "PUT",
      headers: {
        authorization: "Bearer github-token",
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
        "x-part-sha256": declaredSha256,
        "x-part-size": String(bytes.byteLength)
      },
      body
    },
    env
  );
}
async function multipartPartStatus(env, bundleSha256, uploadId, partNumber) {
  return api.request(
    `/admin/artifacts/workspace-host/sha256/${bundleSha256}/server.tgz/multipart?uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`,
    { headers: { authorization: "Bearer github-token" } },
    env
  );
}
async function completeMultipart(env, bundleSha256, uploadId, parts) {
  return api.request(
    `/admin/artifacts/workspace-host/sha256/${bundleSha256}/server.tgz/multipart/complete?uploadId=${encodeURIComponent(uploadId)}`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer github-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ parts })
    },
    env
  );
}
async function abortMultipart(env, bundleSha256, uploadId) {
  return api.request(
    `/admin/artifacts/workspace-host/sha256/${bundleSha256}/server.tgz/multipart?uploadId=${encodeURIComponent(uploadId)}`,
    { method: "DELETE", headers: { authorization: "Bearer github-token" } },
    env
  );
}
async function uploadFixture(env, value) {
  return Promise.all([
    upload(env, value.bundleSha256, "server.tgz", value.bundle, value.bundleSha256),
    upload(env, value.bundleSha256, "server.tgz.minisig", value.signature, value.signatureSha256),
    upload(env, value.bundleSha256, "manifest.json", value.manifestBytes, value.manifestSha256)
  ]);
}
async function finalize(env, bundleSha256) {
  return api.request(
    `/admin/artifacts/workspace-host/sha256/${bundleSha256}/finalize`,
    { method: "POST", headers: { authorization: "Bearer github-token" } },
    env
  );
}
(0,__vite_ssr_import_2__.describe)("workspace-host artifact publication", () => {
  (0,__vite_ssr_import_2__.it)("attaches only the SBOM bound by a finalized manifest without rewriting the release", async () => {
    const sbom = new TextEncoder().encode(JSON.stringify({ bomFormat: "CycloneDX", components: [] }));
    const sbomSha = await (0,__vite_ssr_import_0__.sha256Hex)(sbom);
    const value = await fixture((manifest) => {
      const evidence = manifest.trustReport.evidence;
      evidence.find((entry) => entry.kind === "sbom").documentSha256 = sbomSha;
      evidence.find((entry) => entry.kind === "vulnerability-scan").sbomSha256 = sbomSha;
    });
    const { env, r2 } = authedEnv();
    (0,__vite_ssr_import_2__.expect)((await upload(env, value.bundleSha256, "sbom.cdx.json", sbom, sbomSha)).status).toBe(409);
    await uploadFixture(env, value);
    (0,__vite_ssr_import_2__.expect)((await finalize(env, value.bundleSha256)).status).toBe(201);
    const before = new Map(r2.data);
    const path = `/artifacts/workspace-host/sha256/${value.bundleSha256}/sbom.cdx.json`;
    (0,__vite_ssr_import_2__.expect)((await api.request(path, {}, env)).status).toBe(404);
    const wrong = new TextEncoder().encode("unbound evidence");
    (0,__vite_ssr_import_2__.expect)((await upload(env, value.bundleSha256, "sbom.cdx.json", wrong, await (0,__vite_ssr_import_0__.sha256Hex)(wrong))).status).toBe(409);
    (0,__vite_ssr_import_2__.expect)((await upload(env, value.bundleSha256, "sbom.cdx.json", wrong, sbomSha)).status).toBe(400);
    (0,__vite_ssr_import_2__.expect)((await upload(env, value.bundleSha256, "sbom.cdx.json", sbom, sbomSha)).status).toBe(201);
    const retry = await upload(env, value.bundleSha256, "sbom.cdx.json", sbom, sbomSha);
    (0,__vite_ssr_import_2__.expect)(retry.status).toBe(200);
    (0,__vite_ssr_import_2__.expect)(await retry.json()).toMatchObject({ deduped: true });
    const publicBytes = await api.request(path, {}, env);
    (0,__vite_ssr_import_2__.expect)(publicBytes.status).toBe(200);
    (0,__vite_ssr_import_2__.expect)(publicBytes.headers.get("x-artifact-sha256")).toBe(sbomSha);
    (0,__vite_ssr_import_2__.expect)(new Uint8Array(await publicBytes.arrayBuffer())).toEqual(sbom);
    (0,__vite_ssr_import_2__.expect)((await api.request(path, { method: "HEAD" }, env)).headers.get("content-length")).toBe(String(sbom.length));
    for (const [key, object] of before) (0,__vite_ssr_import_2__.expect)(r2.data.get(key)).toEqual(object);
    (0,__vite_ssr_import_2__.expect)(r2.data.size).toBe(before.size + 1);
    const manifestKey = `${__vite_ssr_import_5__.WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/manifest.json`;
    r2.data.set(manifestKey, new TextEncoder().encode("{}"));
    (0,__vite_ssr_import_2__.expect)((await api.request(path, {}, env)).status).toBe(404);
  });
  (0,__vite_ssr_import_2__.it)("requires a valid allowlisted GitHub operator before storing bytes", async () => {
    const value = await fixture();
    (0,__vite_ssr_import_3__.stubGithub)({ user: { error: 401 } });
    const { env, r2 } = (0,__vite_ssr_import_3__.makeEnv)({ CUPBOARD_OPERATOR_GITHUB_IDS: "7" });
    const response = await upload(env, value.bundleSha256, "server.tgz", value.bundle, value.bundleSha256);
    (0,__vite_ssr_import_2__.expect)(response.status).toBe(401);
    (0,__vite_ssr_import_2__.expect)(r2.data.size).toBe(0);
  });
  (0,__vite_ssr_import_2__.it)("verifies actual bytes, stores create-only, dedupes an exact retry, and stays private before finalize", async () => {
    const value = await fixture();
    const { env, r2 } = authedEnv();
    const tampered = new TextEncoder().encode("different bytes with the declared digest");
    const rejected = await upload(
      env,
      value.bundleSha256,
      "server.tgz",
      tampered,
      value.bundleSha256
    );
    (0,__vite_ssr_import_2__.expect)(rejected.status).toBe(400);
    (0,__vite_ssr_import_2__.expect)(await rejected.json()).toMatchObject({ error: "artifact_sha256_mismatch" });
    const created = await upload(
      env,
      value.bundleSha256,
      "server.tgz",
      value.bundle,
      value.bundleSha256
    );
    (0,__vite_ssr_import_2__.expect)(created.status).toBe(201);
    (0,__vite_ssr_import_2__.expect)(await created.json()).toMatchObject({ deduped: false });
    const duplicate = await upload(
      env,
      value.bundleSha256,
      "server.tgz",
      value.bundle,
      value.bundleSha256
    );
    (0,__vite_ssr_import_2__.expect)(duplicate.status).toBe(200);
    (0,__vite_ssr_import_2__.expect)(await duplicate.json()).toMatchObject({ deduped: true });
    (0,__vite_ssr_import_2__.expect)(r2.data.size).toBe(1);
    const hidden = await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/server.tgz`,
      {},
      env
    );
    (0,__vite_ssr_import_2__.expect)(hidden.status).toBe(404);
  });
  (0,__vite_ssr_import_2__.it)("redirects oversized direct uploads to multipart and rejects an invalid bounded part plan", async () => {
    const bundleSha256 = "a".repeat(64);
    const { env } = authedEnv();
    const oversized = await api.request(
      `/admin/artifacts/workspace-host/sha256/${bundleSha256}/server.tgz`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer github-token",
          "content-length": "1",
          "x-artifact-sha256": bundleSha256,
          "x-artifact-size": String(64 * 1024 * 1024 + 1)
        },
        body: new Uint8Array([1])
      },
      env
    );
    (0,__vite_ssr_import_2__.expect)(oversized.status).toBe(413);
    (0,__vite_ssr_import_2__.expect)(await oversized.json()).toMatchObject({
      error: "artifact_too_large",
      multipart: { maxPartBytes: __vite_ssr_import_5__.WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES }
    });
    const invalidPlan = await initiateMultipart(
      env,
      bundleSha256,
      10 * 1024 * 1024 + 1,
      [
        { partNumber: 1, sha256: "b".repeat(64), sizeBytes: 5 * 1024 * 1024 },
        { partNumber: 2, sha256: "c".repeat(64), sizeBytes: 5 * 1024 * 1024 + 1 }
      ]
    );
    (0,__vite_ssr_import_2__.expect)(invalidPlan.status).toBe(400);
    (0,__vite_ssr_import_2__.expect)(await invalidPlan.json()).toMatchObject({
      error: "invalid_multipart_plan",
      errors: ["the final multipart part cannot exceed the regular part size"]
    });
  });
  (0,__vite_ssr_import_2__.it)("reconciles a lost initiate response by caller operation id and rejects identity drift", async () => {
    const bundle = new TextEncoder().encode("restart-safe multipart body");
    const bundleSha256 = await (0,__vite_ssr_import_0__.sha256Hex)(bundle);
    const part = {
      partNumber: 1,
      sha256: bundleSha256,
      sizeBytes: bundle.byteLength
    };
    const operationId = crypto.randomUUID();
    const { env, r2 } = authedEnv();
    const lost = await initiateMultipart(
      env,
      bundleSha256,
      bundle.byteLength,
      [part],
      operationId
    );
    (0,__vite_ssr_import_2__.expect)(lost.status).toBe(201);
    (0,__vite_ssr_import_2__.expect)(r2.multipartUploads.size).toBe(1);
    const reconciled = await initiateMultipart(
      env,
      bundleSha256,
      bundle.byteLength,
      [part],
      operationId
    );
    (0,__vite_ssr_import_2__.expect)(reconciled.status).toBe(200);
    (0,__vite_ssr_import_2__.expect)(await reconciled.json()).toMatchObject({
      uploadId: operationId,
      operationId,
      resumed: true,
      deduped: false
    });
    (0,__vite_ssr_import_2__.expect)(r2.multipartUploads.size).toBe(1);
    const drifted = await initiateMultipart(
      env,
      bundleSha256,
      bundle.byteLength,
      [{ ...part, sha256: "f".repeat(64) }],
      operationId
    );
    (0,__vite_ssr_import_2__.expect)(drifted.status).toBe(409);
    (0,__vite_ssr_import_2__.expect)(await drifted.json()).toMatchObject({ error: "multipart_operation_conflict" });
    (0,__vite_ssr_import_2__.expect)(r2.multipartUploads.size).toBe(1);
  });
  (0,__vite_ssr_import_2__.it)("reconciles a lost part response from its committed receipt without another R2 mutation", async () => {
    const bundle = new TextEncoder().encode("one restart-safe part");
    const bundleSha256 = await (0,__vite_ssr_import_0__.sha256Hex)(bundle);
    const operationId = crypto.randomUUID();
    const { env, r2 } = authedEnv();
    const initiated = await initiateMultipart(env, bundleSha256, bundle.byteLength, [{
      partNumber: 1,
      sha256: bundleSha256,
      sizeBytes: bundle.byteLength
    }], operationId);
    (0,__vite_ssr_import_2__.expect)(initiated.status).toBe(201);
    const lost = await uploadMultipartPart(
      env,
      bundleSha256,
      operationId,
      1,
      bundle,
      bundleSha256
    );
    (0,__vite_ssr_import_2__.expect)(lost.status).toBe(200);
    (0,__vite_ssr_import_2__.expect)(r2.multipartPartUploadCalls).toBe(1);
    const status = await multipartPartStatus(env, bundleSha256, operationId, 1);
    (0,__vite_ssr_import_2__.expect)(status.status).toBe(200);
    const committed = await status.json();
    (0,__vite_ssr_import_2__.expect)(committed).toMatchObject({ state: "committed", sha256: bundleSha256 });
    const replay = await uploadMultipartPart(
      env,
      bundleSha256,
      operationId,
      1,
      bundle,
      bundleSha256
    );
    (0,__vite_ssr_import_2__.expect)(replay.status).toBe(200);
    (0,__vite_ssr_import_2__.expect)(await replay.json()).toMatchObject({
      etag: committed.etag,
      deduped: true,
      resumed: true
    });
    (0,__vite_ssr_import_2__.expect)(r2.multipartPartUploadCalls).toBe(1);
  });
  (0,__vite_ssr_import_2__.it)("uploads a bounded multipart bundle with verified replay, incomplete, conflict, and finalize behavior", async () => {
    const regularPartBytes = 5 * 1024 * 1024;
    const firstPart = new Uint8Array(regularPartBytes).fill(97);
    const finalPart = new TextEncoder().encode("final multipart bytes");
    const bundle = new Uint8Array(firstPart.byteLength + finalPart.byteLength);
    bundle.set(firstPart, 0);
    bundle.set(finalPart, firstPart.byteLength);
    const value = await fixture(void 0, bundle);
    const parts = [
      {
        partNumber: 1,
        sha256: await (0,__vite_ssr_import_0__.sha256Hex)(firstPart),
        sizeBytes: firstPart.byteLength
      },
      {
        partNumber: 2,
        sha256: await (0,__vite_ssr_import_0__.sha256Hex)(finalPart),
        sizeBytes: finalPart.byteLength
      }
    ];
    const { env, r2 } = authedEnv();
    const opaqueNativeUploadId = `opaque/native+r2=${"x".repeat(600)}`;
    r2.nextMultipartUploadId = opaqueNativeUploadId;
    const initiated = await initiateMultipart(
      env,
      value.bundleSha256,
      bundle.byteLength,
      parts
    );
    (0,__vite_ssr_import_2__.expect)(initiated.status).toBe(201);
    const initiatedBody = await initiated.json();
    (0,__vite_ssr_import_2__.expect)(initiatedBody).toMatchObject({
      partCount: 2,
      partSizeBytes: regularPartBytes,
      maxPartBytes: __vite_ssr_import_5__.WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES,
      deduped: false
    });
    (0,__vite_ssr_import_2__.expect)(initiatedBody.uploadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    (0,__vite_ssr_import_2__.expect)(initiatedBody.uploadId).not.toBe(opaqueNativeUploadId);
    (0,__vite_ssr_import_2__.expect)(r2.multipartUploads.size).toBe(1);
    (0,__vite_ssr_import_2__.expect)(r2.multipartUploads.has(opaqueNativeUploadId)).toBe(true);
    const rejectedPart = await uploadMultipartPart(
      env,
      value.bundleSha256,
      initiatedBody.uploadId,
      1,
      firstPart,
      "0".repeat(64)
    );
    (0,__vite_ssr_import_2__.expect)(rejectedPart.status).toBe(400);
    (0,__vite_ssr_import_2__.expect)(await rejectedPart.json()).toMatchObject({ error: "multipart_part_digest_mismatch" });
    const firstUpload = await uploadMultipartPart(
      env,
      value.bundleSha256,
      initiatedBody.uploadId,
      1,
      firstPart,
      parts[0].sha256
    );
    (0,__vite_ssr_import_2__.expect)(firstUpload.status).toBe(200);
    const firstUploadBody = await firstUpload.json();
    const firstUploaded = {
      partNumber: firstUploadBody.partNumber,
      etag: firstUploadBody.etag
    };
    const firstReplay = await uploadMultipartPart(
      env,
      value.bundleSha256,
      initiatedBody.uploadId,
      1,
      firstPart,
      parts[0].sha256
    );
    (0,__vite_ssr_import_2__.expect)(firstReplay.status).toBe(200);
    (0,__vite_ssr_import_2__.expect)(await firstReplay.json()).toMatchObject({ etag: firstUploaded.etag });
    const incomplete = await completeMultipart(
      env,
      value.bundleSha256,
      initiatedBody.uploadId,
      [firstUploaded, { partNumber: 2, etag: "missing-part" }]
    );
    (0,__vite_ssr_import_2__.expect)(incomplete.status).toBe(409);
    (0,__vite_ssr_import_2__.expect)(await incomplete.json()).toMatchObject({ error: "multipart_upload_incomplete" });
    const finalUpload = await uploadMultipartPart(
      env,
      value.bundleSha256,
      initiatedBody.uploadId,
      2,
      finalPart,
      parts[1].sha256
    );
    (0,__vite_ssr_import_2__.expect)(finalUpload.status).toBe(200);
    const finalUploadBody = await finalUpload.json();
    const finalUploaded = {
      partNumber: finalUploadBody.partNumber,
      etag: finalUploadBody.etag
    };
    r2.nextMultipartCompleteReturnOmitsCustomMetadata = true;
    const completed = await completeMultipart(
      env,
      value.bundleSha256,
      initiatedBody.uploadId,
      [firstUploaded, finalUploaded]
    );
    (0,__vite_ssr_import_2__.expect)(completed.status).toBe(201);
    (0,__vite_ssr_import_2__.expect)(await completed.json()).toMatchObject({ deduped: false, bytes: bundle.byteLength });
    (0,__vite_ssr_import_2__.expect)(r2.multipartUploads.size).toBe(0);
    const bundleKey = `${__vite_ssr_import_5__.WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/server.tgz`;
    const storedBundle = r2.data.get(bundleKey);
    (0,__vite_ssr_import_2__.expect)(storedBundle.byteLength).toBe(bundle.byteLength);
    (0,__vite_ssr_import_2__.expect)(await (0,__vite_ssr_import_0__.sha256Hex)(storedBundle)).toBe(value.bundleSha256);
    const completedReplay = await completeMultipart(
      env,
      value.bundleSha256,
      initiatedBody.uploadId,
      [firstUploaded, finalUploaded]
    );
    (0,__vite_ssr_import_2__.expect)(completedReplay.status).toBe(200);
    (0,__vite_ssr_import_2__.expect)(await completedReplay.json()).toMatchObject({ deduped: true });
    const conflictingInitiate = await initiateMultipart(
      env,
      value.bundleSha256,
      bundle.byteLength + 1,
      parts
    );
    (0,__vite_ssr_import_2__.expect)(conflictingInitiate.status).toBe(409);
    (0,__vite_ssr_import_2__.expect)(await conflictingInitiate.json()).toMatchObject({ error: "artifact_conflict" });
    (0,__vite_ssr_import_2__.expect)((await upload(
      env,
      value.bundleSha256,
      "server.tgz.minisig",
      value.signature,
      value.signatureSha256
    )).status).toBe(201);
    (0,__vite_ssr_import_2__.expect)((await upload(
      env,
      value.bundleSha256,
      "manifest.json",
      value.manifestBytes,
      value.manifestSha256
    )).status).toBe(201);
    (0,__vite_ssr_import_2__.expect)((await finalize(env, value.bundleSha256)).status).toBe(201);
    const published = await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/server.tgz`,
      {},
      env
    );
    (0,__vite_ssr_import_2__.expect)(published.status).toBe(200);
    const publishedBundle = new Uint8Array(await published.arrayBuffer());
    (0,__vite_ssr_import_2__.expect)(publishedBundle.byteLength).toBe(bundle.byteLength);
    (0,__vite_ssr_import_2__.expect)(await (0,__vite_ssr_import_0__.sha256Hex)(publishedBundle)).toBe(value.bundleSha256);
  });
  (0,__vite_ssr_import_2__.it)("aborts multipart state idempotently and refuses parts after closure", async () => {
    const bundle = new TextEncoder().encode("small abortable multipart body");
    const bundleSha256 = await (0,__vite_ssr_import_0__.sha256Hex)(bundle);
    const partSha256 = await (0,__vite_ssr_import_0__.sha256Hex)(bundle);
    const { env, r2 } = authedEnv();
    const initiated = await initiateMultipart(env, bundleSha256, bundle.byteLength, [
      { partNumber: 1, sha256: partSha256, sizeBytes: bundle.byteLength }
    ]);
    const { uploadId } = await initiated.json();
    (0,__vite_ssr_import_2__.expect)(initiated.status).toBe(201);
    (0,__vite_ssr_import_2__.expect)(r2.multipartUploads.size).toBe(1);
    (0,__vite_ssr_import_2__.expect)((await abortMultipart(env, bundleSha256, uploadId)).status).toBe(204);
    (0,__vite_ssr_import_2__.expect)((await abortMultipart(env, bundleSha256, uploadId)).status).toBe(204);
    (0,__vite_ssr_import_2__.expect)(r2.multipartUploads.size).toBe(0);
    const closedPart = await uploadMultipartPart(
      env,
      bundleSha256,
      uploadId,
      1,
      bundle,
      partSha256
    );
    (0,__vite_ssr_import_2__.expect)(closedPart.status).toBe(404);
    (0,__vite_ssr_import_2__.expect)(await closedPart.json()).toMatchObject({ error: "multipart_upload_not_found" });
    (0,__vite_ssr_import_2__.expect)(r2.data.has(`${__vite_ssr_import_5__.WORKSPACE_HOST_ARTIFACT_PREFIX}/${bundleSha256}/server.tgz`)).toBe(false);
  });
  (0,__vite_ssr_import_2__.it)("refuses finalization until all three verified objects exist", async () => {
    const value = await fixture();
    const { env } = authedEnv();
    await upload(env, value.bundleSha256, "server.tgz", value.bundle, value.bundleSha256);
    const response = await finalize(env, value.bundleSha256);
    (0,__vite_ssr_import_2__.expect)(response.status).toBe(409);
    (0,__vite_ssr_import_2__.expect)(await response.json()).toEqual({
      error: "uploads_incomplete",
      missing: ["server.tgz.minisig", "manifest.json"]
    });
  });
  (0,__vite_ssr_import_2__.it)("rejects a trust envelope with secret findings and never creates visibility", async () => {
    const value = await fixture((manifest) => {
      const trust = manifest.trustReport;
      const secretScan = trust.evidence.find((entry) => entry.kind === "secret-scan");
      secretScan.findings = [{ ruleId: "cloud-api-key", location: "bundle:12" }];
      manifest.smuggledToken = "ghp_abcdefghijklmnopqrstuvwxyz";
    });
    const { env, r2 } = authedEnv();
    (0,__vite_ssr_import_2__.expect)((await Promise.all(await uploadFixture(env, value))).every((response2) => response2.status === 201)).toBe(true);
    const response = await finalize(env, value.bundleSha256);
    const body = await response.json();
    (0,__vite_ssr_import_2__.expect)(response.status).toBe(400);
    (0,__vite_ssr_import_2__.expect)(body.error).toBe("invalid_manifest");
    (0,__vite_ssr_import_2__.expect)(body.errors.join(" ")).toMatch(/unexpected manifest field|secret-shaped|zero findings/);
    (0,__vite_ssr_import_2__.expect)(r2.data.has(`${__vite_ssr_import_5__.WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/.finalized.json`)).toBe(false);
    (0,__vite_ssr_import_2__.expect)((await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/manifest.json`,
      {},
      env
    )).status).toBe(404);
  });
  (0,__vite_ssr_import_2__.it)("rejects an otherwise valid manifest that points at a noncanonical release origin", async () => {
    const value = await fixture((manifest) => {
      const artifact = manifest.artifact;
      artifact.release.bundleUrl = `https://releases.papercusp.com/${VERSION}/server.tgz`;
      artifact.release.signatureUrl = `${artifact.release.bundleUrl}.minisig`;
    });
    const { env } = authedEnv();
    await uploadFixture(env, value);
    const response = await finalize(env, value.bundleSha256);
    const body = await response.json();
    (0,__vite_ssr_import_2__.expect)(response.status).toBe(400);
    (0,__vite_ssr_import_2__.expect)(body.errors).toContain("artifact release URLs must equal the D-105 digest-derived Cupboard URLs");
  });
  (0,__vite_ssr_import_2__.it)("finalizes idempotently and serves public GET/HEAD with immutable integrity metadata", async () => {
    const value = await fixture();
    const { env, r2 } = authedEnv();
    const uploads = await uploadFixture(env, value);
    (0,__vite_ssr_import_2__.expect)(uploads.map((response) => response.status)).toEqual([201, 201, 201]);
    const created = await finalize(env, value.bundleSha256);
    (0,__vite_ssr_import_2__.expect)(created.status).toBe(201);
    (0,__vite_ssr_import_2__.expect)(await created.json()).toMatchObject({
      ok: true,
      bundleSha256: value.bundleSha256,
      manifestSha256: value.manifestSha256,
      deduped: false
    });
    const duplicate = await finalize(env, value.bundleSha256);
    (0,__vite_ssr_import_2__.expect)(duplicate.status).toBe(200);
    (0,__vite_ssr_import_2__.expect)(await duplicate.json()).toMatchObject({ deduped: true });
    const get = await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/server.tgz`,
      {},
      env
    );
    (0,__vite_ssr_import_2__.expect)(get.status).toBe(200);
    (0,__vite_ssr_import_2__.expect)(new Uint8Array(await get.arrayBuffer())).toEqual(value.bundle);
    (0,__vite_ssr_import_2__.expect)(get.headers.get("cache-control")).toBe((0,__vite_ssr_import_5__.WORKSPACE_HOST_PUBLIC_CACHE_CONTROL));
    (0,__vite_ssr_import_2__.expect)(get.headers.get("x-artifact-sha256")).toBe(value.bundleSha256);
    (0,__vite_ssr_import_2__.expect)(get.headers.get("content-type")).toBe("application/gzip");
    (0,__vite_ssr_import_2__.expect)(get.headers.get("x-content-type-options")).toBe("nosniff");
    const head = await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/manifest.json`,
      { method: "HEAD" },
      env
    );
    (0,__vite_ssr_import_2__.expect)(head.status).toBe(200);
    (0,__vite_ssr_import_2__.expect)(await head.text()).toBe("");
    (0,__vite_ssr_import_2__.expect)(head.headers.get("content-length")).toBe(String(value.manifestBytes.byteLength));
    (0,__vite_ssr_import_2__.expect)(head.headers.get("x-artifact-sha256")).toBe(value.manifestSha256);
    const markerKey = `${__vite_ssr_import_5__.WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/.finalized.json`;
    (0,__vite_ssr_import_2__.expect)(r2.data.has(markerKey)).toBe(true);
    await r2.delete(`${__vite_ssr_import_5__.WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/server.tgz.minisig`);
    const incompleteRetry = await finalize(env, value.bundleSha256);
    (0,__vite_ssr_import_2__.expect)(incompleteRetry.status).toBe(409);
    (0,__vite_ssr_import_2__.expect)(await incompleteRetry.json()).toMatchObject({ error: "finalization_conflict" });
  });
  (0,__vite_ssr_import_2__.it)("fails closed when finalized object metadata no longer matches the marker", async () => {
    const value = await fixture();
    const { env, r2 } = authedEnv();
    await uploadFixture(env, value);
    (0,__vite_ssr_import_2__.expect)((await finalize(env, value.bundleSha256)).status).toBe(201);
    const bundleKey = `${__vite_ssr_import_5__.WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/server.tgz`;
    const bundleMetadata = r2.customMetadata.get(bundleKey);
    const originalBundleSha256 = bundleMetadata.fileSha256;
    bundleMetadata.fileSha256 = "0".repeat(64);
    const objectMismatch = await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/server.tgz`,
      {},
      env
    );
    (0,__vite_ssr_import_2__.expect)(objectMismatch.status).toBe(404);
    bundleMetadata.fileSha256 = originalBundleSha256;
    const markerKey = `${__vite_ssr_import_5__.WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/.finalized.json`;
    r2.customMetadata.get(markerKey).manifestSha256 = "0".repeat(64);
    const markerMismatch = await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/server.tgz`,
      {},
      env
    );
    (0,__vite_ssr_import_2__.expect)(markerMismatch.status).toBe(404);
  });
  (0,__vite_ssr_import_2__.it)("refuses a conflicting re-upload at the same bundle namespace", async () => {
    const value = await fixture();
    const { env } = authedEnv();
    (0,__vite_ssr_import_2__.expect)((await upload(
      env,
      value.bundleSha256,
      "server.tgz.minisig",
      value.signature,
      value.signatureSha256
    )).status).toBe(201);
    const replacement = new TextEncoder().encode("different detached signature");
    const replacementSha256 = await (0,__vite_ssr_import_0__.sha256Hex)(replacement);
    const response = await upload(
      env,
      value.bundleSha256,
      "server.tgz.minisig",
      replacement,
      replacementSha256
    );
    (0,__vite_ssr_import_2__.expect)(response.status).toBe(409);
    (0,__vite_ssr_import_2__.expect)(await response.json()).toMatchObject({ error: "artifact_conflict" });
  });
});
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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LElBQ0Y7QUFFQSxxQ0FBTyxTQUFTLE1BQU0sRUFBRSxLQUFLLEdBQUc7QUFDaEMscUNBQU8sTUFBTSxTQUFTLEtBQUssQ0FBQyxFQUFFLGNBQWMsRUFBRSxPQUFPLG9CQUFvQixDQUFDO0FBQUEsRUFDNUUsQ0FBQztBQUNILENBQUMiLCJuYW1lcyI6WyJyZXNwb25zZSJdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJ3b3Jrc3BhY2UtaG9zdC1hcnRpZmFjdHMudGVzdC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBzaGEyNTZIZXggfSBmcm9tICdAcGFwZXJjdXNwL2FydGlmYWN0LXJlZ2lzdHJ5JztcbmltcG9ydCB7XG4gIFdPUktTUEFDRV9IT1NUX0JPT1RTVFJBUF9DT05UUkFDVF9WRVJTSU9OLFxuICBXT1JLU1BBQ0VfSE9TVF9CT09UU1RSQVBfVUJVTlRVX1ZFUlNJT04sXG4gIFdPUktTUEFDRV9IT1NUX0JVSUxEX0lOUFVUX0NPTlRSQUNUX1ZFUlNJT04sXG4gIFdPUktTUEFDRV9IT1NUX0lNQUdFX0FDQ0VQVEFOQ0VfQ09OVFJBQ1RfVkVSU0lPTixcbiAgV09SS1NQQUNFX0hPU1RfU0lERUNBUl9CVUlMREVSX0tJTkQsXG4gIGJ1aWxkV29ya3NwYWNlSG9zdEJ1aWxkTWFuaWZlc3QsXG4gIGRlcml2ZVdvcmtzcGFjZUhvc3RDYW5vbmljYWxBcnRpZmFjdFVybHMsXG4gIHdvcmtzcGFjZUhvc3RSZXF1aXJlZFJlbGVhc2VNYXRlcmlhbEZpeHR1cmVzLFxuICB0eXBlIFdvcmtzcGFjZUhvc3RJbWFnZUFydGlmYWN0LFxufSBmcm9tICdAcGFwZXJjdXNwL2RlcGxveW1lbnQtZHJpdmVyJztcbmltcG9ydCB7IGFmdGVyRWFjaCwgZGVzY3JpYmUsIGV4cGVjdCwgaXQgfSBmcm9tICd2aXRlc3QnO1xuXG5pbXBvcnQgeyBtYWtlRW52LCBzdHViR2l0aHViLCB0eXBlIEZha2VSMiB9IGZyb20gJy4uL19fdGVzdHNfXy9mYWtlLWQxLnRzJztcbmltcG9ydCB0eXBlIHsgRW52IH0gZnJvbSAnLi4vZW52LnRzJztcbmltcG9ydCB7IGJ1aWxkQXBpIH0gZnJvbSAnLi9pbmRleC50cyc7XG5pbXBvcnQge1xuICBXT1JLU1BBQ0VfSE9TVF9BUlRJRkFDVF9QUkVGSVgsXG4gIFdPUktTUEFDRV9IT1NUX01VTFRJUEFSVF9NQVhfUEFSVF9CWVRFUyxcbiAgV09SS1NQQUNFX0hPU1RfUFVCTElDX0NBQ0hFX0NPTlRST0wsXG59IGZyb20gJy4vd29ya3NwYWNlLWhvc3QtYXJ0aWZhY3RzLnRzJztcblxuY29uc3QgYXBpID0gYnVpbGRBcGkoKTtcbmNvbnN0IG9yaWdpbmFsRmV0Y2ggPSBnbG9iYWxUaGlzLmZldGNoO1xuY29uc3QgVkVSU0lPTiA9ICcyMDI2LjguMjUtMSc7XG5jb25zdCBTQk9NX1NIQTI1NiA9ICdiJy5yZXBlYXQoNjQpO1xuY29uc3QgQVRURVNUQVRJT05fU0hBMjU2ID0gJ2MnLnJlcGVhdCg2NCk7XG5cbmludGVyZmFjZSBGaXh0dXJlIHtcbiAgYnVuZGxlOiBVaW50OEFycmF5O1xuICBidW5kbGVTaGEyNTY6IHN0cmluZztcbiAgc2lnbmF0dXJlOiBVaW50OEFycmF5O1xuICBzaWduYXR1cmVTaGEyNTY6IHN0cmluZztcbiAgbWFuaWZlc3Q6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBtYW5pZmVzdEJ5dGVzOiBVaW50OEFycmF5O1xuICBtYW5pZmVzdFNoYTI1Njogc3RyaW5nO1xufVxuXG5hZnRlckVhY2goKCkgPT4ge1xuICBnbG9iYWxUaGlzLmZldGNoID0gb3JpZ2luYWxGZXRjaDtcbn0pO1xuXG5hc3luYyBmdW5jdGlvbiBmaXh0dXJlKFxuICBtdXRhdGU/OiAobWFuaWZlc3Q6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB2b2lkLFxuICBidW5kbGVPdmVycmlkZT86IFVpbnQ4QXJyYXksXG4pOiBQcm9taXNlPEZpeHR1cmU+IHtcbiAgY29uc3QgYnVuZGxlID0gYnVuZGxlT3ZlcnJpZGUgPz8gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKCd2ZXJpZmllZCB3b3Jrc3BhY2UtaG9zdCBzZXJ2ZXIgYnVuZGxlJyk7XG4gIGNvbnN0IHNpZ25hdHVyZSA9IG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZSgndW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZVxcblJXU2lnbmVkQnVuZGxlJyk7XG4gIGNvbnN0IHNpZ25pbmdQdWJsaWNLZXkgPSAndW50cnVzdGVkIGNvbW1lbnQ6IFBhcGVyY3VzcCB3b3Jrc3BhY2UtaG9zdCByZWxlYXNlIGtleVxcblJXUXB1YmxpY2tleSc7XG4gIGNvbnN0IFtidW5kbGVTaGEyNTYsIHNpZ25hdHVyZVNoYTI1Niwgc2lnbmluZ0tleVNoYTI1Nl0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgc2hhMjU2SGV4KGJ1bmRsZSksXG4gICAgc2hhMjU2SGV4KHNpZ25hdHVyZSksXG4gICAgc2hhMjU2SGV4KG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShzaWduaW5nUHVibGljS2V5KSksXG4gIF0pO1xuICBjb25zdCB1cmxzID0gZGVyaXZlV29ya3NwYWNlSG9zdENhbm9uaWNhbEFydGlmYWN0VXJscyhidW5kbGVTaGEyNTYpO1xuICBjb25zdCBidWlsZE1hbmlmZXN0ID0gYnVpbGRXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdCh7XG4gICAgY29udHJhY3RWZXJzaW9uOiBXT1JLU1BBQ0VfSE9TVF9CVUlMRF9JTlBVVF9DT05UUkFDVF9WRVJTSU9OLFxuICAgIGRpc3RyaWJ1dGlvblByb2ZpbGU6ICd2bS1yZWxlYXNlJyxcbiAgICBzb3VyY2U6IHtcbiAgICAgIHJlcG9zaXRvcnk6ICdodHRwczovL2dpdGh1Yi5jb20vUGFwZXJjdXNwL3BhcGVyY3VzcC5naXQnLFxuICAgICAgcmV2aXNpb246ICcxJy5yZXBlYXQoNDApLFxuICAgIH0sXG4gICAgcmVsZWFzZUFydGlmYWN0OiB7XG4gICAgICBuYW1lOiBgcGFwZXJjdXNwLXNlcnZlci0ke1ZFUlNJT059LnRnemAsXG4gICAgICB2ZXJzaW9uOiBWRVJTSU9OLFxuICAgICAgc2hhMjU2OiBidW5kbGVTaGEyNTYsXG4gICAgICBzaXplQnl0ZXM6IGJ1bmRsZS5ieXRlTGVuZ3RoLFxuICAgIH0sXG4gICAgYmFzZUltYWdlOiB7XG4gICAgICByZWZlcmVuY2U6ICdwcm9qZWN0cy9wYXBlcmN1c3AtaW1hZ2VzLTEyMy9nbG9iYWwvaW1hZ2VzL3VidW50dS0yNDA0LW1pbmltYWwnLFxuICAgICAgYXJjaGl0ZWN0dXJlOiAneDg2XzY0JyxcbiAgICAgIHNoYTI1NjogJ2QnLnJlcGVhdCg2NCksXG4gICAgfSxcbiAgICBidWlsZGVyOiB7XG4gICAgICBzdHJhdGVneTogJ3NoYXJlZCcsXG4gICAgICBraW5kOiBXT1JLU1BBQ0VfSE9TVF9TSURFQ0FSX0JVSUxERVJfS0lORCxcbiAgICAgIHZlcnNpb246ICcwLjAuMTgnLFxuICAgICAgdGVtcGxhdGVQYXRoOiAncGFwZXJjdXNwLWRlc2t0b3AvYmluL2J1aWxkLWRlc2t0b3Atc2lkZWNhci5zaCcsXG4gICAgICB0ZW1wbGF0ZVNoYTI1NjogJ2UnLnJlcGVhdCg2NCksXG4gICAgfSxcbiAgICBtYXRlcmlhbHM6IFtcbiAgICAgIHtcbiAgICAgICAgcGF0aDogJ2Rpc3QvcGFwZXJjdXNwLXNlcnZlci50Z3onLFxuICAgICAgICBzaGEyNTY6IGJ1bmRsZVNoYTI1NixcbiAgICAgICAgc2l6ZUJ5dGVzOiBidW5kbGUuYnl0ZUxlbmd0aCxcbiAgICAgIH0sXG4gICAgICAvLyBEZXJpdmVkIGZyb20gdGhlIHJlbGVhc2UtZ2F0ZSBjb250cmFjdCwgbmV2ZXIgcmVzdGF0ZWQ6IGEgbWF0ZXJpYWwgYWRkZWQgdGhlcmUgbXVzdCByZWFjaFxuICAgICAgLy8gdGhpcyBmaXh0dXJlIG9uIGl0cyBvd24sIG9yIHRoZSBwdWJsaXNoZXIgcmVqZWN0cyB0aGUgdXBsb2FkIHdpdGggYSA0MDAgbmFtaW5nIGEgcGF0aCB0aGlzXG4gICAgICAvLyBmaWxlIG5ldmVyIG1lbnRpb25zLlxuICAgICAgLi4ud29ya3NwYWNlSG9zdFJlcXVpcmVkUmVsZWFzZU1hdGVyaWFsRml4dHVyZXMoKSxcbiAgICBdLFxuICAgIHBhcmFtZXRlcnM6IFt7IG5hbWU6ICdkaXN0cmlidXRpb25fcHJvZmlsZScsIHZhbHVlOiAndm0tcmVsZWFzZScgfV0sXG4gICAgdGFyZ2V0czogW3sgcHJvdmlkZXI6ICdnY3AnLCBsb2NhdGlvbnM6IFsndXMtY2VudHJhbDEnXSB9XSxcbiAgfSk7XG4gIGNvbnN0IGFydGlmYWN0OiBXb3Jrc3BhY2VIb3N0SW1hZ2VBcnRpZmFjdCA9IHtcbiAgICBjb250cmFjdFZlcnNpb246IFdPUktTUEFDRV9IT1NUX0lNQUdFX0FDQ0VQVEFOQ0VfQ09OVFJBQ1RfVkVSU0lPTixcbiAgICBpbWFnZTogeyBpZDogJ3BhcGVyY3VzcC13b3Jrc3BhY2UtaG9zdCcsIHZlcnNpb246IFZFUlNJT04gfSxcbiAgICBidWlsZE1hbmlmZXN0LFxuICAgIHJlbGVhc2U6IHtcbiAgICAgIHZlcnNpb246IFZFUlNJT04sXG4gICAgICBidW5kbGVVcmw6IHVybHMuYnVuZGxlVXJsLFxuICAgICAgYnVuZGxlU2hhMjU2LFxuICAgICAgc2lnbmF0dXJlVXJsOiB1cmxzLnNpZ25hdHVyZVVybCxcbiAgICAgIHNpZ25pbmdQdWJsaWNLZXksXG4gICAgICBzaWduaW5nS2V5U2hhMjU2LFxuICAgIH0sXG4gICAgbGlmZWN5Y2xlOiB7IHN0YXRlOiAnYWN0aXZlJywgcHVibGlzaGVkQXQ6ICcyMDI2LTA4LTI1VDAwOjAwOjAwLjAwMFonIH0sXG4gICAgY29tcGF0aWJpbGl0eTogW1xuICAgICAge1xuICAgICAgICBwcm92aWRlcjogJ2djcCcsXG4gICAgICAgIGFyY2hpdGVjdHVyZTogJ3g4Nl82NCcsXG4gICAgICAgIHVidW50dVZlcnNpb246IFdPUktTUEFDRV9IT1NUX0JPT1RTVFJBUF9VQlVOVFVfVkVSU0lPTixcbiAgICAgICAgYm9vdHN0cmFwQ29udHJhY3RWZXJzaW9uOiBXT1JLU1BBQ0VfSE9TVF9CT09UU1RSQVBfQ09OVFJBQ1RfVkVSU0lPTixcbiAgICAgICAgYWN0aW9uczogWydpbnN0YWxsJ10sXG4gICAgICAgIG1heGltdW1BcnRpZmFjdEFnZURheXM6IDMwLFxuICAgICAgfSxcbiAgICBdLFxuICB9O1xuICBjb25zdCBtYW5pZmVzdDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgc2NoZW1hVmVyc2lvbjogMSxcbiAgICBraW5kOiAncGFwZXJjdXNwLXdvcmtzcGFjZS1ob3N0LXJlbGVhc2UnLFxuICAgIGFydGlmYWN0LFxuICAgIGZpbGVzOiB7XG4gICAgICBidW5kbGU6IHsgbmFtZTogJ3NlcnZlci50Z3onLCBzaGEyNTY6IGJ1bmRsZVNoYTI1Niwgc2l6ZUJ5dGVzOiBidW5kbGUuYnl0ZUxlbmd0aCB9LFxuICAgICAgc2lnbmF0dXJlOiB7XG4gICAgICAgIG5hbWU6ICdzZXJ2ZXIudGd6Lm1pbmlzaWcnLFxuICAgICAgICBzaGEyNTY6IHNpZ25hdHVyZVNoYTI1NixcbiAgICAgICAgc2l6ZUJ5dGVzOiBzaWduYXR1cmUuYnl0ZUxlbmd0aCxcbiAgICAgIH0sXG4gICAgfSxcbiAgICB0cnVzdFJlcG9ydDoge1xuICAgICAgdmVyc2lvbjogJ2FydGlmYWN0LXRydXN0LXYxJyxcbiAgICAgIHN1YmplY3Q6IHtcbiAgICAgICAgcGF0aDogYGRpc3QvcGFwZXJjdXNwLXNlcnZlci0ke1ZFUlNJT059LnRnemAsXG4gICAgICAgIG5hbWU6IGBwYXBlcmN1c3Atc2VydmVyLSR7VkVSU0lPTn0udGd6YCxcbiAgICAgICAgYnl0ZXM6IGJ1bmRsZS5ieXRlTGVuZ3RoLFxuICAgICAgICBzaGEyNTY6IGJ1bmRsZVNoYTI1NixcbiAgICAgICAgc2lnbmVkOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIHBvbGljeToge1xuICAgICAgICBkZW55VnVsbmVyYWJpbGl0aWVzQXRPckFib3ZlOiAnaGlnaCcsXG4gICAgICAgIG1heFNlY3JldEZpbmRpbmdzOiAwLFxuICAgICAgICBtYXhBdHRlc3RhdGlvbkFnZU1zOiA2MCAqIDYwICogMV8wMDAsXG4gICAgICB9LFxuICAgICAgdHJ1c3RlZDogdHJ1ZSxcbiAgICAgIGV2aWRlbmNlOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBraW5kOiAnc2lnbmF0dXJlJyxcbiAgICAgICAgICBzdWJqZWN0U2hhMjU2OiBidW5kbGVTaGEyNTYsXG4gICAgICAgICAgc2lnbmF0dXJlU2hhMjU2LFxuICAgICAgICAgIHNpZ25pbmdLZXlTaGEyNTYsXG4gICAgICAgICAgdG9vbDogeyBuYW1lOiAnbWluaXNpZ24nLCB2ZXJzaW9uOiAnMC4xMicgfSxcbiAgICAgICAgICB2YWxpZDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGtpbmQ6ICdzYm9tJyxcbiAgICAgICAgICBzdWJqZWN0U2hhMjU2OiBidW5kbGVTaGEyNTYsXG4gICAgICAgICAgdG9vbDogeyBuYW1lOiAnc3lmdCcsIHZlcnNpb246ICcxLjMwJyB9LFxuICAgICAgICAgIGZvcm1hdDogJ2N5Y2xvbmVkeC1qc29uJyxcbiAgICAgICAgICBkb2N1bWVudFNoYTI1NjogU0JPTV9TSEEyNTYsXG4gICAgICAgICAgY29tcG9uZW50Q291bnQ6IDQyLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAga2luZDogJ3Z1bG5lcmFiaWxpdHktc2NhbicsXG4gICAgICAgICAgc3ViamVjdFNoYTI1NjogYnVuZGxlU2hhMjU2LFxuICAgICAgICAgIHRvb2w6IHsgbmFtZTogJ2dyeXBlJywgdmVyc2lvbjogJzAuOTknIH0sXG4gICAgICAgICAgc2JvbVNoYTI1NjogU0JPTV9TSEEyNTYsXG4gICAgICAgICAgZmluZGluZ3M6IFtdLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAga2luZDogJ3NlY3JldC1zY2FuJyxcbiAgICAgICAgICBzdWJqZWN0U2hhMjU2OiBidW5kbGVTaGEyNTYsXG4gICAgICAgICAgdG9vbDogeyBuYW1lOiAnZ2l0bGVha3MnLCB2ZXJzaW9uOiAnOC4yOCcgfSxcbiAgICAgICAgICBmaW5kaW5nczogW10sXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBraW5kOiAncHJvdmVuYW5jZS1hdHRlc3RhdGlvbicsXG4gICAgICAgICAgc3ViamVjdFNoYTI1NjogYnVuZGxlU2hhMjU2LFxuICAgICAgICAgIHRvb2w6IHsgbmFtZTogJ2Nvc2lnbicsIHZlcnNpb246ICcyLjUnIH0sXG4gICAgICAgICAgdmFsaWQ6IHRydWUsXG4gICAgICAgICAgcHJlZGljYXRlVHlwZTogJ2h0dHBzOi8vc2xzYS5kZXYvcHJvdmVuYW5jZS92MScsXG4gICAgICAgICAgaXNzdWVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgICBhdHRlc3RhdGlvblNoYTI1NjogQVRURVNUQVRJT05fU0hBMjU2LFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIGZhaWx1cmVzOiBbXSxcbiAgICB9LFxuICB9O1xuICBtdXRhdGU/LihtYW5pZmVzdCk7XG4gIGNvbnN0IG1hbmlmZXN0Qnl0ZXMgPSBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoSlNPTi5zdHJpbmdpZnkobWFuaWZlc3QpKTtcbiAgcmV0dXJuIHtcbiAgICBidW5kbGUsXG4gICAgYnVuZGxlU2hhMjU2LFxuICAgIHNpZ25hdHVyZSxcbiAgICBzaWduYXR1cmVTaGEyNTYsXG4gICAgbWFuaWZlc3QsXG4gICAgbWFuaWZlc3RCeXRlcyxcbiAgICBtYW5pZmVzdFNoYTI1NjogYXdhaXQgc2hhMjU2SGV4KG1hbmlmZXN0Qnl0ZXMpLFxuICB9O1xufVxuXG5mdW5jdGlvbiBhdXRoZWRFbnYoKTogeyBlbnY6IEVudjsgcjI6IEZha2VSMiB9IHtcbiAgc3R1YkdpdGh1Yih7IHVzZXI6IHsgaWQ6IDcsIGxvZ2luOiAnb3BlcmF0b3InIH0gfSk7XG4gIGNvbnN0IHsgZW52LCByMiB9ID0gbWFrZUVudih7IENVUEJPQVJEX09QRVJBVE9SX0dJVEhVQl9JRFM6ICc3JyB9KTtcbiAgcmV0dXJuIHsgZW52LCByMiB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiB1cGxvYWQoXG4gIGVudjogRW52LFxuICBidW5kbGVTaGEyNTY6IHN0cmluZyxcbiAgZmlsZTogJ3NlcnZlci50Z3onIHwgJ3NlcnZlci50Z3oubWluaXNpZycgfCAnbWFuaWZlc3QuanNvbicgfCAnc2JvbS5jZHguanNvbicsXG4gIGJ5dGVzOiBVaW50OEFycmF5LFxuICBkZWNsYXJlZFNoYTI1Njogc3RyaW5nLFxuKTogUHJvbWlzZTxSZXNwb25zZT4ge1xuICBjb25zdCBib2R5ID0gYnl0ZXMuYnVmZmVyLnNsaWNlKGJ5dGVzLmJ5dGVPZmZzZXQsIGJ5dGVzLmJ5dGVPZmZzZXQgKyBieXRlcy5ieXRlTGVuZ3RoKSBhcyBBcnJheUJ1ZmZlcjtcbiAgcmV0dXJuIGFwaS5yZXF1ZXN0KFxuICAgIGAvYWRtaW4vYXJ0aWZhY3RzL3dvcmtzcGFjZS1ob3N0L3NoYTI1Ni8ke2J1bmRsZVNoYTI1Nn0vJHtmaWxlfWAsXG4gICAge1xuICAgICAgbWV0aG9kOiAnUFVUJyxcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgYXV0aG9yaXphdGlvbjogJ0JlYXJlciBnaXRodWItdG9rZW4nLFxuICAgICAgICAnY29udGVudC10eXBlJzogZmlsZSA9PT0gJ21hbmlmZXN0Lmpzb24nID8gJ2FwcGxpY2F0aW9uL2pzb24nIDogJ2FwcGxpY2F0aW9uL29jdGV0LXN0cmVhbScsXG4gICAgICAgICd4LWFydGlmYWN0LXNoYTI1Nic6IGRlY2xhcmVkU2hhMjU2LFxuICAgICAgICAneC1hcnRpZmFjdC1zaXplJzogU3RyaW5nKGJ5dGVzLmJ5dGVMZW5ndGgpLFxuICAgICAgfSxcbiAgICAgIGJvZHksXG4gICAgfSxcbiAgICBlbnYsXG4gICk7XG59XG5cbmludGVyZmFjZSBNdWx0aXBhcnRQbGFuUGFydCB7XG4gIHBhcnROdW1iZXI6IG51bWJlcjtcbiAgc2hhMjU2OiBzdHJpbmc7XG4gIHNpemVCeXRlczogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgVXBsb2FkZWRNdWx0aXBhcnRQYXJ0IHtcbiAgcGFydE51bWJlcjogbnVtYmVyO1xuICBldGFnOiBzdHJpbmc7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGluaXRpYXRlTXVsdGlwYXJ0KFxuICBlbnY6IEVudixcbiAgYnVuZGxlU2hhMjU2OiBzdHJpbmcsXG4gIHNpemVCeXRlczogbnVtYmVyLFxuICBwYXJ0czogTXVsdGlwYXJ0UGxhblBhcnRbXSxcbiAgb3BlcmF0aW9uSWQ6IHN0cmluZyA9IGNyeXB0by5yYW5kb21VVUlEKCksXG4pOiBQcm9taXNlPFJlc3BvbnNlPiB7XG4gIHJldHVybiBhcGkucmVxdWVzdChcbiAgICBgL2FkbWluL2FydGlmYWN0cy93b3Jrc3BhY2UtaG9zdC9zaGEyNTYvJHtidW5kbGVTaGEyNTZ9L3NlcnZlci50Z3ovbXVsdGlwYXJ0YCxcbiAgICB7XG4gICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgYXV0aG9yaXphdGlvbjogJ0JlYXJlciBnaXRodWItdG9rZW4nLFxuICAgICAgICAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAneC1hcnRpZmFjdC1zaGEyNTYnOiBidW5kbGVTaGEyNTYsXG4gICAgICAgICd4LWFydGlmYWN0LXNpemUnOiBTdHJpbmcoc2l6ZUJ5dGVzKSxcbiAgICAgICAgJ3gtb3BlcmF0aW9uLWlkJzogb3BlcmF0aW9uSWQsXG4gICAgICB9LFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBwYXJ0cyB9KSxcbiAgICB9LFxuICAgIGVudixcbiAgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gdXBsb2FkTXVsdGlwYXJ0UGFydChcbiAgZW52OiBFbnYsXG4gIGJ1bmRsZVNoYTI1Njogc3RyaW5nLFxuICB1cGxvYWRJZDogc3RyaW5nLFxuICBwYXJ0TnVtYmVyOiBudW1iZXIsXG4gIGJ5dGVzOiBVaW50OEFycmF5LFxuICBkZWNsYXJlZFNoYTI1Njogc3RyaW5nLFxuKTogUHJvbWlzZTxSZXNwb25zZT4ge1xuICBjb25zdCBib2R5ID0gYnl0ZXMuYnVmZmVyLnNsaWNlKGJ5dGVzLmJ5dGVPZmZzZXQsIGJ5dGVzLmJ5dGVPZmZzZXQgKyBieXRlcy5ieXRlTGVuZ3RoKSBhcyBBcnJheUJ1ZmZlcjtcbiAgcmV0dXJuIGFwaS5yZXF1ZXN0KFxuICAgIGAvYWRtaW4vYXJ0aWZhY3RzL3dvcmtzcGFjZS1ob3N0L3NoYTI1Ni8ke2J1bmRsZVNoYTI1Nn0vc2VydmVyLnRnei9tdWx0aXBhcnQvcGFydHMvJHtwYXJ0TnVtYmVyfT91cGxvYWRJZD0ke2VuY29kZVVSSUNvbXBvbmVudCh1cGxvYWRJZCl9YCxcbiAgICB7XG4gICAgICBtZXRob2Q6ICdQVVQnLFxuICAgICAgaGVhZGVyczoge1xuICAgICAgICBhdXRob3JpemF0aW9uOiAnQmVhcmVyIGdpdGh1Yi10b2tlbicsXG4gICAgICAgICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtJyxcbiAgICAgICAgJ2NvbnRlbnQtbGVuZ3RoJzogU3RyaW5nKGJ5dGVzLmJ5dGVMZW5ndGgpLFxuICAgICAgICAneC1wYXJ0LXNoYTI1Nic6IGRlY2xhcmVkU2hhMjU2LFxuICAgICAgICAneC1wYXJ0LXNpemUnOiBTdHJpbmcoYnl0ZXMuYnl0ZUxlbmd0aCksXG4gICAgICB9LFxuICAgICAgYm9keSxcbiAgICB9LFxuICAgIGVudixcbiAgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbXVsdGlwYXJ0UGFydFN0YXR1cyhcbiAgZW52OiBFbnYsXG4gIGJ1bmRsZVNoYTI1Njogc3RyaW5nLFxuICB1cGxvYWRJZDogc3RyaW5nLFxuICBwYXJ0TnVtYmVyOiBudW1iZXIsXG4pOiBQcm9taXNlPFJlc3BvbnNlPiB7XG4gIHJldHVybiBhcGkucmVxdWVzdChcbiAgICBgL2FkbWluL2FydGlmYWN0cy93b3Jrc3BhY2UtaG9zdC9zaGEyNTYvJHtidW5kbGVTaGEyNTZ9L3NlcnZlci50Z3ovbXVsdGlwYXJ0P3VwbG9hZElkPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHVwbG9hZElkKX0mcGFydE51bWJlcj0ke3BhcnROdW1iZXJ9YCxcbiAgICB7IGhlYWRlcnM6IHsgYXV0aG9yaXphdGlvbjogJ0JlYXJlciBnaXRodWItdG9rZW4nIH0gfSxcbiAgICBlbnYsXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNvbXBsZXRlTXVsdGlwYXJ0KFxuICBlbnY6IEVudixcbiAgYnVuZGxlU2hhMjU2OiBzdHJpbmcsXG4gIHVwbG9hZElkOiBzdHJpbmcsXG4gIHBhcnRzOiBVcGxvYWRlZE11bHRpcGFydFBhcnRbXSxcbik6IFByb21pc2U8UmVzcG9uc2U+IHtcbiAgcmV0dXJuIGFwaS5yZXF1ZXN0KFxuICAgIGAvYWRtaW4vYXJ0aWZhY3RzL3dvcmtzcGFjZS1ob3N0L3NoYTI1Ni8ke2J1bmRsZVNoYTI1Nn0vc2VydmVyLnRnei9tdWx0aXBhcnQvY29tcGxldGU/dXBsb2FkSWQ9JHtlbmNvZGVVUklDb21wb25lbnQodXBsb2FkSWQpfWAsXG4gICAge1xuICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgIGF1dGhvcml6YXRpb246ICdCZWFyZXIgZ2l0aHViLXRva2VuJyxcbiAgICAgICAgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHBhcnRzIH0pLFxuICAgIH0sXG4gICAgZW52LFxuICApO1xufVxuXG5hc3luYyBmdW5jdGlvbiBhYm9ydE11bHRpcGFydChcbiAgZW52OiBFbnYsXG4gIGJ1bmRsZVNoYTI1Njogc3RyaW5nLFxuICB1cGxvYWRJZDogc3RyaW5nLFxuKTogUHJvbWlzZTxSZXNwb25zZT4ge1xuICByZXR1cm4gYXBpLnJlcXVlc3QoXG4gICAgYC9hZG1pbi9hcnRpZmFjdHMvd29ya3NwYWNlLWhvc3Qvc2hhMjU2LyR7YnVuZGxlU2hhMjU2fS9zZXJ2ZXIudGd6L211bHRpcGFydD91cGxvYWRJZD0ke2VuY29kZVVSSUNvbXBvbmVudCh1cGxvYWRJZCl9YCxcbiAgICB7IG1ldGhvZDogJ0RFTEVURScsIGhlYWRlcnM6IHsgYXV0aG9yaXphdGlvbjogJ0JlYXJlciBnaXRodWItdG9rZW4nIH0gfSxcbiAgICBlbnYsXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHVwbG9hZEZpeHR1cmUoZW52OiBFbnYsIHZhbHVlOiBGaXh0dXJlKTogUHJvbWlzZTxSZXNwb25zZVtdPiB7XG4gIHJldHVybiBQcm9taXNlLmFsbChbXG4gICAgdXBsb2FkKGVudiwgdmFsdWUuYnVuZGxlU2hhMjU2LCAnc2VydmVyLnRneicsIHZhbHVlLmJ1bmRsZSwgdmFsdWUuYnVuZGxlU2hhMjU2KSxcbiAgICB1cGxvYWQoZW52LCB2YWx1ZS5idW5kbGVTaGEyNTYsICdzZXJ2ZXIudGd6Lm1pbmlzaWcnLCB2YWx1ZS5zaWduYXR1cmUsIHZhbHVlLnNpZ25hdHVyZVNoYTI1NiksXG4gICAgdXBsb2FkKGVudiwgdmFsdWUuYnVuZGxlU2hhMjU2LCAnbWFuaWZlc3QuanNvbicsIHZhbHVlLm1hbmlmZXN0Qnl0ZXMsIHZhbHVlLm1hbmlmZXN0U2hhMjU2KSxcbiAgXSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZpbmFsaXplKGVudjogRW52LCBidW5kbGVTaGEyNTY6IHN0cmluZyk6IFByb21pc2U8UmVzcG9uc2U+IHtcbiAgcmV0dXJuIGFwaS5yZXF1ZXN0KFxuICAgIGAvYWRtaW4vYXJ0aWZhY3RzL3dvcmtzcGFjZS1ob3N0L3NoYTI1Ni8ke2J1bmRsZVNoYTI1Nn0vZmluYWxpemVgLFxuICAgIHsgbWV0aG9kOiAnUE9TVCcsIGhlYWRlcnM6IHsgYXV0aG9yaXphdGlvbjogJ0JlYXJlciBnaXRodWItdG9rZW4nIH0gfSxcbiAgICBlbnYsXG4gICk7XG59XG5cbmRlc2NyaWJlKCd3b3Jrc3BhY2UtaG9zdCBhcnRpZmFjdCBwdWJsaWNhdGlvbicsICgpID0+IHtcbiAgaXQoJ2F0dGFjaGVzIG9ubHkgdGhlIFNCT00gYm91bmQgYnkgYSBmaW5hbGl6ZWQgbWFuaWZlc3Qgd2l0aG91dCByZXdyaXRpbmcgdGhlIHJlbGVhc2UnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc2JvbSA9IG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShKU09OLnN0cmluZ2lmeSh7IGJvbUZvcm1hdDogJ0N5Y2xvbmVEWCcsIGNvbXBvbmVudHM6IFtdIH0pKTtcbiAgICBjb25zdCBzYm9tU2hhID0gYXdhaXQgc2hhMjU2SGV4KHNib20pO1xuICAgIGNvbnN0IHZhbHVlID0gYXdhaXQgZml4dHVyZSgobWFuaWZlc3QpID0+IHtcbiAgICAgIGNvbnN0IGV2aWRlbmNlID0gKG1hbmlmZXN0LnRydXN0UmVwb3J0IGFzIHsgZXZpZGVuY2U6IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB9KS5ldmlkZW5jZTtcbiAgICAgIGV2aWRlbmNlLmZpbmQoKGVudHJ5KSA9PiBlbnRyeS5raW5kID09PSAnc2JvbScpIS5kb2N1bWVudFNoYTI1NiA9IHNib21TaGE7XG4gICAgICBldmlkZW5jZS5maW5kKChlbnRyeSkgPT4gZW50cnkua2luZCA9PT0gJ3Z1bG5lcmFiaWxpdHktc2NhbicpIS5zYm9tU2hhMjU2ID0gc2JvbVNoYTtcbiAgICB9KTtcbiAgICBjb25zdCB7IGVudiwgcjIgfSA9IGF1dGhlZEVudigpO1xuICAgIGV4cGVjdCgoYXdhaXQgdXBsb2FkKGVudiwgdmFsdWUuYnVuZGxlU2hhMjU2LCAnc2JvbS5jZHguanNvbicsIHNib20sIHNib21TaGEpKS5zdGF0dXMpLnRvQmUoNDA5KTtcbiAgICBhd2FpdCB1cGxvYWRGaXh0dXJlKGVudiwgdmFsdWUpO1xuICAgIGV4cGVjdCgoYXdhaXQgZmluYWxpemUoZW52LCB2YWx1ZS5idW5kbGVTaGEyNTYpKS5zdGF0dXMpLnRvQmUoMjAxKTtcbiAgICBjb25zdCBiZWZvcmUgPSBuZXcgTWFwKHIyLmRhdGEpO1xuICAgIGNvbnN0IHBhdGggPSBgL2FydGlmYWN0cy93b3Jrc3BhY2UtaG9zdC9zaGEyNTYvJHt2YWx1ZS5idW5kbGVTaGEyNTZ9L3Nib20uY2R4Lmpzb25gO1xuICAgIGV4cGVjdCgoYXdhaXQgYXBpLnJlcXVlc3QocGF0aCwge30sIGVudikpLnN0YXR1cykudG9CZSg0MDQpO1xuXG4gICAgY29uc3Qgd3JvbmcgPSBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoJ3VuYm91bmQgZXZpZGVuY2UnKTtcbiAgICBleHBlY3QoKGF3YWl0IHVwbG9hZChlbnYsIHZhbHVlLmJ1bmRsZVNoYTI1NiwgJ3Nib20uY2R4Lmpzb24nLCB3cm9uZywgYXdhaXQgc2hhMjU2SGV4KHdyb25nKSkpLnN0YXR1cykudG9CZSg0MDkpO1xuICAgIGV4cGVjdCgoYXdhaXQgdXBsb2FkKGVudiwgdmFsdWUuYnVuZGxlU2hhMjU2LCAnc2JvbS5jZHguanNvbicsIHdyb25nLCBzYm9tU2hhKSkuc3RhdHVzKS50b0JlKDQwMCk7XG4gICAgZXhwZWN0KChhd2FpdCB1cGxvYWQoZW52LCB2YWx1ZS5idW5kbGVTaGEyNTYsICdzYm9tLmNkeC5qc29uJywgc2JvbSwgc2JvbVNoYSkpLnN0YXR1cykudG9CZSgyMDEpO1xuICAgIGNvbnN0IHJldHJ5ID0gYXdhaXQgdXBsb2FkKGVudiwgdmFsdWUuYnVuZGxlU2hhMjU2LCAnc2JvbS5jZHguanNvbicsIHNib20sIHNib21TaGEpO1xuICAgIGV4cGVjdChyZXRyeS5zdGF0dXMpLnRvQmUoMjAwKTtcbiAgICBleHBlY3QoYXdhaXQgcmV0cnkuanNvbigpKS50b01hdGNoT2JqZWN0KHsgZGVkdXBlZDogdHJ1ZSB9KTtcbiAgICBjb25zdCBwdWJsaWNCeXRlcyA9IGF3YWl0IGFwaS5yZXF1ZXN0KHBhdGgsIHt9LCBlbnYpO1xuICAgIGV4cGVjdChwdWJsaWNCeXRlcy5zdGF0dXMpLnRvQmUoMjAwKTtcbiAgICBleHBlY3QocHVibGljQnl0ZXMuaGVhZGVycy5nZXQoJ3gtYXJ0aWZhY3Qtc2hhMjU2JykpLnRvQmUoc2JvbVNoYSk7XG4gICAgZXhwZWN0KG5ldyBVaW50OEFycmF5KGF3YWl0IHB1YmxpY0J5dGVzLmFycmF5QnVmZmVyKCkpKS50b0VxdWFsKHNib20pO1xuICAgIGV4cGVjdCgoYXdhaXQgYXBpLnJlcXVlc3QocGF0aCwgeyBtZXRob2Q6ICdIRUFEJyB9LCBlbnYpKS5oZWFkZXJzLmdldCgnY29udGVudC1sZW5ndGgnKSkudG9CZShTdHJpbmcoc2JvbS5sZW5ndGgpKTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIG9iamVjdF0gb2YgYmVmb3JlKSBleHBlY3QocjIuZGF0YS5nZXQoa2V5KSkudG9FcXVhbChvYmplY3QpO1xuICAgIGV4cGVjdChyMi5kYXRhLnNpemUpLnRvQmUoYmVmb3JlLnNpemUgKyAxKTtcblxuICAgIC8vIEEgbWFuaWZlc3QgYWx0ZXJlZCBiZWhpbmQgdGhlIGltbXV0YWJsZSBkZXNjcmlwdG9yIGNhbm5vdCBhdXRob3JpemUgcHVibGljIGV2aWRlbmNlLlxuICAgIGNvbnN0IG1hbmlmZXN0S2V5ID0gYCR7V09SS1NQQUNFX0hPU1RfQVJUSUZBQ1RfUFJFRklYfS8ke3ZhbHVlLmJ1bmRsZVNoYTI1Nn0vbWFuaWZlc3QuanNvbmA7XG4gICAgcjIuZGF0YS5zZXQobWFuaWZlc3RLZXksIG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZSgne30nKSk7XG4gICAgZXhwZWN0KChhd2FpdCBhcGkucmVxdWVzdChwYXRoLCB7fSwgZW52KSkuc3RhdHVzKS50b0JlKDQwNCk7XG4gIH0pO1xuXG4gIGl0KCdyZXF1aXJlcyBhIHZhbGlkIGFsbG93bGlzdGVkIEdpdEh1YiBvcGVyYXRvciBiZWZvcmUgc3RvcmluZyBieXRlcycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB2YWx1ZSA9IGF3YWl0IGZpeHR1cmUoKTtcbiAgICBzdHViR2l0aHViKHsgdXNlcjogeyBlcnJvcjogNDAxIH0gfSk7XG4gICAgY29uc3QgeyBlbnYsIHIyIH0gPSBtYWtlRW52KHsgQ1VQQk9BUkRfT1BFUkFUT1JfR0lUSFVCX0lEUzogJzcnIH0pO1xuXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB1cGxvYWQoZW52LCB2YWx1ZS5idW5kbGVTaGEyNTYsICdzZXJ2ZXIudGd6JywgdmFsdWUuYnVuZGxlLCB2YWx1ZS5idW5kbGVTaGEyNTYpO1xuXG4gICAgZXhwZWN0KHJlc3BvbnNlLnN0YXR1cykudG9CZSg0MDEpO1xuICAgIGV4cGVjdChyMi5kYXRhLnNpemUpLnRvQmUoMCk7XG4gIH0pO1xuXG4gIGl0KCd2ZXJpZmllcyBhY3R1YWwgYnl0ZXMsIHN0b3JlcyBjcmVhdGUtb25seSwgZGVkdXBlcyBhbiBleGFjdCByZXRyeSwgYW5kIHN0YXlzIHByaXZhdGUgYmVmb3JlIGZpbmFsaXplJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHZhbHVlID0gYXdhaXQgZml4dHVyZSgpO1xuICAgIGNvbnN0IHsgZW52LCByMiB9ID0gYXV0aGVkRW52KCk7XG4gICAgY29uc3QgdGFtcGVyZWQgPSBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoJ2RpZmZlcmVudCBieXRlcyB3aXRoIHRoZSBkZWNsYXJlZCBkaWdlc3QnKTtcblxuICAgIGNvbnN0IHJlamVjdGVkID0gYXdhaXQgdXBsb2FkKFxuICAgICAgZW52LFxuICAgICAgdmFsdWUuYnVuZGxlU2hhMjU2LFxuICAgICAgJ3NlcnZlci50Z3onLFxuICAgICAgdGFtcGVyZWQsXG4gICAgICB2YWx1ZS5idW5kbGVTaGEyNTYsXG4gICAgKTtcbiAgICBleHBlY3QocmVqZWN0ZWQuc3RhdHVzKS50b0JlKDQwMCk7XG4gICAgZXhwZWN0KGF3YWl0IHJlamVjdGVkLmpzb24oKSkudG9NYXRjaE9iamVjdCh7IGVycm9yOiAnYXJ0aWZhY3Rfc2hhMjU2X21pc21hdGNoJyB9KTtcblxuICAgIGNvbnN0IGNyZWF0ZWQgPSBhd2FpdCB1cGxvYWQoXG4gICAgICBlbnYsXG4gICAgICB2YWx1ZS5idW5kbGVTaGEyNTYsXG4gICAgICAnc2VydmVyLnRneicsXG4gICAgICB2YWx1ZS5idW5kbGUsXG4gICAgICB2YWx1ZS5idW5kbGVTaGEyNTYsXG4gICAgKTtcbiAgICBleHBlY3QoY3JlYXRlZC5zdGF0dXMpLnRvQmUoMjAxKTtcbiAgICBleHBlY3QoYXdhaXQgY3JlYXRlZC5qc29uKCkpLnRvTWF0Y2hPYmplY3QoeyBkZWR1cGVkOiBmYWxzZSB9KTtcblxuICAgIGNvbnN0IGR1cGxpY2F0ZSA9IGF3YWl0IHVwbG9hZChcbiAgICAgIGVudixcbiAgICAgIHZhbHVlLmJ1bmRsZVNoYTI1NixcbiAgICAgICdzZXJ2ZXIudGd6JyxcbiAgICAgIHZhbHVlLmJ1bmRsZSxcbiAgICAgIHZhbHVlLmJ1bmRsZVNoYTI1NixcbiAgICApO1xuICAgIGV4cGVjdChkdXBsaWNhdGUuc3RhdHVzKS50b0JlKDIwMCk7XG4gICAgZXhwZWN0KGF3YWl0IGR1cGxpY2F0ZS5qc29uKCkpLnRvTWF0Y2hPYmplY3QoeyBkZWR1cGVkOiB0cnVlIH0pO1xuICAgIGV4cGVjdChyMi5kYXRhLnNpemUpLnRvQmUoMSk7XG5cbiAgICBjb25zdCBoaWRkZW4gPSBhd2FpdCBhcGkucmVxdWVzdChcbiAgICAgIGAvYXJ0aWZhY3RzL3dvcmtzcGFjZS1ob3N0L3NoYTI1Ni8ke3ZhbHVlLmJ1bmRsZVNoYTI1Nn0vc2VydmVyLnRnemAsXG4gICAgICB7fSxcbiAgICAgIGVudixcbiAgICApO1xuICAgIGV4cGVjdChoaWRkZW4uc3RhdHVzKS50b0JlKDQwNCk7XG4gIH0pO1xuXG4gIGl0KCdyZWRpcmVjdHMgb3ZlcnNpemVkIGRpcmVjdCB1cGxvYWRzIHRvIG11bHRpcGFydCBhbmQgcmVqZWN0cyBhbiBpbnZhbGlkIGJvdW5kZWQgcGFydCBwbGFuJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJ1bmRsZVNoYTI1NiA9ICdhJy5yZXBlYXQoNjQpO1xuICAgIGNvbnN0IHsgZW52IH0gPSBhdXRoZWRFbnYoKTtcbiAgICBjb25zdCBvdmVyc2l6ZWQgPSBhd2FpdCBhcGkucmVxdWVzdChcbiAgICAgIGAvYWRtaW4vYXJ0aWZhY3RzL3dvcmtzcGFjZS1ob3N0L3NoYTI1Ni8ke2J1bmRsZVNoYTI1Nn0vc2VydmVyLnRnemAsXG4gICAgICB7XG4gICAgICAgIG1ldGhvZDogJ1BVVCcsXG4gICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICBhdXRob3JpemF0aW9uOiAnQmVhcmVyIGdpdGh1Yi10b2tlbicsXG4gICAgICAgICAgJ2NvbnRlbnQtbGVuZ3RoJzogJzEnLFxuICAgICAgICAgICd4LWFydGlmYWN0LXNoYTI1Nic6IGJ1bmRsZVNoYTI1NixcbiAgICAgICAgICAneC1hcnRpZmFjdC1zaXplJzogU3RyaW5nKDY0ICogMTAyNCAqIDEwMjQgKyAxKSxcbiAgICAgICAgfSxcbiAgICAgICAgYm9keTogbmV3IFVpbnQ4QXJyYXkoWzFdKSxcbiAgICAgIH0sXG4gICAgICBlbnYsXG4gICAgKTtcbiAgICBleHBlY3Qob3ZlcnNpemVkLnN0YXR1cykudG9CZSg0MTMpO1xuICAgIGV4cGVjdChhd2FpdCBvdmVyc2l6ZWQuanNvbigpKS50b01hdGNoT2JqZWN0KHtcbiAgICAgIGVycm9yOiAnYXJ0aWZhY3RfdG9vX2xhcmdlJyxcbiAgICAgIG11bHRpcGFydDogeyBtYXhQYXJ0Qnl0ZXM6IFdPUktTUEFDRV9IT1NUX01VTFRJUEFSVF9NQVhfUEFSVF9CWVRFUyB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgaW52YWxpZFBsYW4gPSBhd2FpdCBpbml0aWF0ZU11bHRpcGFydChcbiAgICAgIGVudixcbiAgICAgIGJ1bmRsZVNoYTI1NixcbiAgICAgIDEwICogMTAyNCAqIDEwMjQgKyAxLFxuICAgICAgW1xuICAgICAgICB7IHBhcnROdW1iZXI6IDEsIHNoYTI1NjogJ2InLnJlcGVhdCg2NCksIHNpemVCeXRlczogNSAqIDEwMjQgKiAxMDI0IH0sXG4gICAgICAgIHsgcGFydE51bWJlcjogMiwgc2hhMjU2OiAnYycucmVwZWF0KDY0KSwgc2l6ZUJ5dGVzOiA1ICogMTAyNCAqIDEwMjQgKyAxIH0sXG4gICAgICBdLFxuICAgICk7XG4gICAgZXhwZWN0KGludmFsaWRQbGFuLnN0YXR1cykudG9CZSg0MDApO1xuICAgIGV4cGVjdChhd2FpdCBpbnZhbGlkUGxhbi5qc29uKCkpLnRvTWF0Y2hPYmplY3Qoe1xuICAgICAgZXJyb3I6ICdpbnZhbGlkX211bHRpcGFydF9wbGFuJyxcbiAgICAgIGVycm9yczogWyd0aGUgZmluYWwgbXVsdGlwYXJ0IHBhcnQgY2Fubm90IGV4Y2VlZCB0aGUgcmVndWxhciBwYXJ0IHNpemUnXSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgaXQoJ3JlY29uY2lsZXMgYSBsb3N0IGluaXRpYXRlIHJlc3BvbnNlIGJ5IGNhbGxlciBvcGVyYXRpb24gaWQgYW5kIHJlamVjdHMgaWRlbnRpdHkgZHJpZnQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYnVuZGxlID0gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKCdyZXN0YXJ0LXNhZmUgbXVsdGlwYXJ0IGJvZHknKTtcbiAgICBjb25zdCBidW5kbGVTaGEyNTYgPSBhd2FpdCBzaGEyNTZIZXgoYnVuZGxlKTtcbiAgICBjb25zdCBwYXJ0OiBNdWx0aXBhcnRQbGFuUGFydCA9IHtcbiAgICAgIHBhcnROdW1iZXI6IDEsXG4gICAgICBzaGEyNTY6IGJ1bmRsZVNoYTI1NixcbiAgICAgIHNpemVCeXRlczogYnVuZGxlLmJ5dGVMZW5ndGgsXG4gICAgfTtcbiAgICBjb25zdCBvcGVyYXRpb25JZCA9IGNyeXB0by5yYW5kb21VVUlEKCk7XG4gICAgY29uc3QgeyBlbnYsIHIyIH0gPSBhdXRoZWRFbnYoKTtcblxuICAgIC8vIFRoZSBmaXJzdCByZXNwb25zZSBpcyBkZWxpYmVyYXRlbHkgZGlzY2FyZGVkOiBmcm9tIHRoZSBjbGllbnQncyB2aWV3IHRoZVxuICAgIC8vIHByb3ZpZGVyIG1heSBoYXZlIGFjY2VwdGVkIHRoZSBtdXRhdGlvbiBhbmQgdGhlIG91dGNvbWUgaXMgdW5rbm93bi5cbiAgICBjb25zdCBsb3N0ID0gYXdhaXQgaW5pdGlhdGVNdWx0aXBhcnQoXG4gICAgICBlbnYsXG4gICAgICBidW5kbGVTaGEyNTYsXG4gICAgICBidW5kbGUuYnl0ZUxlbmd0aCxcbiAgICAgIFtwYXJ0XSxcbiAgICAgIG9wZXJhdGlvbklkLFxuICAgICk7XG4gICAgZXhwZWN0KGxvc3Quc3RhdHVzKS50b0JlKDIwMSk7XG4gICAgZXhwZWN0KHIyLm11bHRpcGFydFVwbG9hZHMuc2l6ZSkudG9CZSgxKTtcblxuICAgIGNvbnN0IHJlY29uY2lsZWQgPSBhd2FpdCBpbml0aWF0ZU11bHRpcGFydChcbiAgICAgIGVudixcbiAgICAgIGJ1bmRsZVNoYTI1NixcbiAgICAgIGJ1bmRsZS5ieXRlTGVuZ3RoLFxuICAgICAgW3BhcnRdLFxuICAgICAgb3BlcmF0aW9uSWQsXG4gICAgKTtcbiAgICBleHBlY3QocmVjb25jaWxlZC5zdGF0dXMpLnRvQmUoMjAwKTtcbiAgICBleHBlY3QoYXdhaXQgcmVjb25jaWxlZC5qc29uKCkpLnRvTWF0Y2hPYmplY3Qoe1xuICAgICAgdXBsb2FkSWQ6IG9wZXJhdGlvbklkLFxuICAgICAgb3BlcmF0aW9uSWQsXG4gICAgICByZXN1bWVkOiB0cnVlLFxuICAgICAgZGVkdXBlZDogZmFsc2UsXG4gICAgfSk7XG4gICAgZXhwZWN0KHIyLm11bHRpcGFydFVwbG9hZHMuc2l6ZSkudG9CZSgxKTtcblxuICAgIGNvbnN0IGRyaWZ0ZWQgPSBhd2FpdCBpbml0aWF0ZU11bHRpcGFydChcbiAgICAgIGVudixcbiAgICAgIGJ1bmRsZVNoYTI1NixcbiAgICAgIGJ1bmRsZS5ieXRlTGVuZ3RoLFxuICAgICAgW3sgLi4ucGFydCwgc2hhMjU2OiAnZicucmVwZWF0KDY0KSB9XSxcbiAgICAgIG9wZXJhdGlvbklkLFxuICAgICk7XG4gICAgZXhwZWN0KGRyaWZ0ZWQuc3RhdHVzKS50b0JlKDQwOSk7XG4gICAgZXhwZWN0KGF3YWl0IGRyaWZ0ZWQuanNvbigpKS50b01hdGNoT2JqZWN0KHsgZXJyb3I6ICdtdWx0aXBhcnRfb3BlcmF0aW9uX2NvbmZsaWN0JyB9KTtcbiAgICBleHBlY3QocjIubXVsdGlwYXJ0VXBsb2Fkcy5zaXplKS50b0JlKDEpO1xuICB9KTtcblxuICBpdCgncmVjb25jaWxlcyBhIGxvc3QgcGFydCByZXNwb25zZSBmcm9tIGl0cyBjb21taXR0ZWQgcmVjZWlwdCB3aXRob3V0IGFub3RoZXIgUjIgbXV0YXRpb24nLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYnVuZGxlID0gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKCdvbmUgcmVzdGFydC1zYWZlIHBhcnQnKTtcbiAgICBjb25zdCBidW5kbGVTaGEyNTYgPSBhd2FpdCBzaGEyNTZIZXgoYnVuZGxlKTtcbiAgICBjb25zdCBvcGVyYXRpb25JZCA9IGNyeXB0by5yYW5kb21VVUlEKCk7XG4gICAgY29uc3QgeyBlbnYsIHIyIH0gPSBhdXRoZWRFbnYoKTtcbiAgICBjb25zdCBpbml0aWF0ZWQgPSBhd2FpdCBpbml0aWF0ZU11bHRpcGFydChlbnYsIGJ1bmRsZVNoYTI1NiwgYnVuZGxlLmJ5dGVMZW5ndGgsIFt7XG4gICAgICBwYXJ0TnVtYmVyOiAxLFxuICAgICAgc2hhMjU2OiBidW5kbGVTaGEyNTYsXG4gICAgICBzaXplQnl0ZXM6IGJ1bmRsZS5ieXRlTGVuZ3RoLFxuICAgIH1dLCBvcGVyYXRpb25JZCk7XG4gICAgZXhwZWN0KGluaXRpYXRlZC5zdGF0dXMpLnRvQmUoMjAxKTtcblxuICAgIC8vIERpc2NhcmQgdGhlIHJlc3BvbnNlIGFmdGVyIHRoZSBzZXJ2ZXIgaGFzIGFjY2VwdGVkIGFuZCByZWNlaXB0ZWQgdGhlIFIyXG4gICAgLy8gbXV0YXRpb24sIG1hdGNoaW5nIGEgY2xpZW50IHRyYW5zcG9ydCBsb3NzL3Jlc3RhcnQuXG4gICAgY29uc3QgbG9zdCA9IGF3YWl0IHVwbG9hZE11bHRpcGFydFBhcnQoXG4gICAgICBlbnYsXG4gICAgICBidW5kbGVTaGEyNTYsXG4gICAgICBvcGVyYXRpb25JZCxcbiAgICAgIDEsXG4gICAgICBidW5kbGUsXG4gICAgICBidW5kbGVTaGEyNTYsXG4gICAgKTtcbiAgICBleHBlY3QobG9zdC5zdGF0dXMpLnRvQmUoMjAwKTtcbiAgICBleHBlY3QocjIubXVsdGlwYXJ0UGFydFVwbG9hZENhbGxzKS50b0JlKDEpO1xuXG4gICAgY29uc3Qgc3RhdHVzID0gYXdhaXQgbXVsdGlwYXJ0UGFydFN0YXR1cyhlbnYsIGJ1bmRsZVNoYTI1Niwgb3BlcmF0aW9uSWQsIDEpO1xuICAgIGV4cGVjdChzdGF0dXMuc3RhdHVzKS50b0JlKDIwMCk7XG4gICAgY29uc3QgY29tbWl0dGVkID0gYXdhaXQgc3RhdHVzLmpzb24oKSBhcyB7IGV0YWc6IHN0cmluZyB9O1xuICAgIGV4cGVjdChjb21taXR0ZWQpLnRvTWF0Y2hPYmplY3QoeyBzdGF0ZTogJ2NvbW1pdHRlZCcsIHNoYTI1NjogYnVuZGxlU2hhMjU2IH0pO1xuXG4gICAgY29uc3QgcmVwbGF5ID0gYXdhaXQgdXBsb2FkTXVsdGlwYXJ0UGFydChcbiAgICAgIGVudixcbiAgICAgIGJ1bmRsZVNoYTI1NixcbiAgICAgIG9wZXJhdGlvbklkLFxuICAgICAgMSxcbiAgICAgIGJ1bmRsZSxcbiAgICAgIGJ1bmRsZVNoYTI1NixcbiAgICApO1xuICAgIGV4cGVjdChyZXBsYXkuc3RhdHVzKS50b0JlKDIwMCk7XG4gICAgZXhwZWN0KGF3YWl0IHJlcGxheS5qc29uKCkpLnRvTWF0Y2hPYmplY3Qoe1xuICAgICAgZXRhZzogY29tbWl0dGVkLmV0YWcsXG4gICAgICBkZWR1cGVkOiB0cnVlLFxuICAgICAgcmVzdW1lZDogdHJ1ZSxcbiAgICB9KTtcbiAgICBleHBlY3QocjIubXVsdGlwYXJ0UGFydFVwbG9hZENhbGxzKS50b0JlKDEpO1xuICB9KTtcblxuICBpdCgndXBsb2FkcyBhIGJvdW5kZWQgbXVsdGlwYXJ0IGJ1bmRsZSB3aXRoIHZlcmlmaWVkIHJlcGxheSwgaW5jb21wbGV0ZSwgY29uZmxpY3QsIGFuZCBmaW5hbGl6ZSBiZWhhdmlvcicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCByZWd1bGFyUGFydEJ5dGVzID0gNSAqIDEwMjQgKiAxMDI0O1xuICAgIGNvbnN0IGZpcnN0UGFydCA9IG5ldyBVaW50OEFycmF5KHJlZ3VsYXJQYXJ0Qnl0ZXMpLmZpbGwoMHg2MSk7XG4gICAgY29uc3QgZmluYWxQYXJ0ID0gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKCdmaW5hbCBtdWx0aXBhcnQgYnl0ZXMnKTtcbiAgICBjb25zdCBidW5kbGUgPSBuZXcgVWludDhBcnJheShmaXJzdFBhcnQuYnl0ZUxlbmd0aCArIGZpbmFsUGFydC5ieXRlTGVuZ3RoKTtcbiAgICBidW5kbGUuc2V0KGZpcnN0UGFydCwgMCk7XG4gICAgYnVuZGxlLnNldChmaW5hbFBhcnQsIGZpcnN0UGFydC5ieXRlTGVuZ3RoKTtcbiAgICBjb25zdCB2YWx1ZSA9IGF3YWl0IGZpeHR1cmUodW5kZWZpbmVkLCBidW5kbGUpO1xuICAgIGNvbnN0IHBhcnRzOiBNdWx0aXBhcnRQbGFuUGFydFtdID0gW1xuICAgICAge1xuICAgICAgICBwYXJ0TnVtYmVyOiAxLFxuICAgICAgICBzaGEyNTY6IGF3YWl0IHNoYTI1NkhleChmaXJzdFBhcnQpLFxuICAgICAgICBzaXplQnl0ZXM6IGZpcnN0UGFydC5ieXRlTGVuZ3RoLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgcGFydE51bWJlcjogMixcbiAgICAgICAgc2hhMjU2OiBhd2FpdCBzaGEyNTZIZXgoZmluYWxQYXJ0KSxcbiAgICAgICAgc2l6ZUJ5dGVzOiBmaW5hbFBhcnQuYnl0ZUxlbmd0aCxcbiAgICAgIH0sXG4gICAgXTtcbiAgICBjb25zdCB7IGVudiwgcjIgfSA9IGF1dGhlZEVudigpO1xuICAgIGNvbnN0IG9wYXF1ZU5hdGl2ZVVwbG9hZElkID0gYG9wYXF1ZS9uYXRpdmUrcjI9JHsneCcucmVwZWF0KDYwMCl9YDtcbiAgICByMi5uZXh0TXVsdGlwYXJ0VXBsb2FkSWQgPSBvcGFxdWVOYXRpdmVVcGxvYWRJZDtcblxuICAgIGNvbnN0IGluaXRpYXRlZCA9IGF3YWl0IGluaXRpYXRlTXVsdGlwYXJ0KFxuICAgICAgZW52LFxuICAgICAgdmFsdWUuYnVuZGxlU2hhMjU2LFxuICAgICAgYnVuZGxlLmJ5dGVMZW5ndGgsXG4gICAgICBwYXJ0cyxcbiAgICApO1xuICAgIGV4cGVjdChpbml0aWF0ZWQuc3RhdHVzKS50b0JlKDIwMSk7XG4gICAgY29uc3QgaW5pdGlhdGVkQm9keSA9IGF3YWl0IGluaXRpYXRlZC5qc29uKCkgYXMge1xuICAgICAgdXBsb2FkSWQ6IHN0cmluZztcbiAgICAgIHBhcnRDb3VudDogbnVtYmVyO1xuICAgICAgcGFydFNpemVCeXRlczogbnVtYmVyO1xuICAgICAgbWF4UGFydEJ5dGVzOiBudW1iZXI7XG4gICAgICBkZWR1cGVkOiBib29sZWFuO1xuICAgIH07XG4gICAgZXhwZWN0KGluaXRpYXRlZEJvZHkpLnRvTWF0Y2hPYmplY3Qoe1xuICAgICAgcGFydENvdW50OiAyLFxuICAgICAgcGFydFNpemVCeXRlczogcmVndWxhclBhcnRCeXRlcyxcbiAgICAgIG1heFBhcnRCeXRlczogV09SS1NQQUNFX0hPU1RfTVVMVElQQVJUX01BWF9QQVJUX0JZVEVTLFxuICAgICAgZGVkdXBlZDogZmFsc2UsXG4gICAgfSk7XG4gICAgZXhwZWN0KGluaXRpYXRlZEJvZHkudXBsb2FkSWQpLnRvTWF0Y2goXG4gICAgICAvXlswLTlhLWZdezh9LVswLTlhLWZdezR9LTRbMC05YS1mXXszfS1bODlhYl1bMC05YS1mXXszfS1bMC05YS1mXXsxMn0kLyxcbiAgICApO1xuICAgIGV4cGVjdChpbml0aWF0ZWRCb2R5LnVwbG9hZElkKS5ub3QudG9CZShvcGFxdWVOYXRpdmVVcGxvYWRJZCk7XG4gICAgZXhwZWN0KHIyLm11bHRpcGFydFVwbG9hZHMuc2l6ZSkudG9CZSgxKTtcbiAgICBleHBlY3QocjIubXVsdGlwYXJ0VXBsb2Fkcy5oYXMob3BhcXVlTmF0aXZlVXBsb2FkSWQpKS50b0JlKHRydWUpO1xuXG4gICAgY29uc3QgcmVqZWN0ZWRQYXJ0ID0gYXdhaXQgdXBsb2FkTXVsdGlwYXJ0UGFydChcbiAgICAgIGVudixcbiAgICAgIHZhbHVlLmJ1bmRsZVNoYTI1NixcbiAgICAgIGluaXRpYXRlZEJvZHkudXBsb2FkSWQsXG4gICAgICAxLFxuICAgICAgZmlyc3RQYXJ0LFxuICAgICAgJzAnLnJlcGVhdCg2NCksXG4gICAgKTtcbiAgICBleHBlY3QocmVqZWN0ZWRQYXJ0LnN0YXR1cykudG9CZSg0MDApO1xuICAgIGV4cGVjdChhd2FpdCByZWplY3RlZFBhcnQuanNvbigpKS50b01hdGNoT2JqZWN0KHsgZXJyb3I6ICdtdWx0aXBhcnRfcGFydF9kaWdlc3RfbWlzbWF0Y2gnIH0pO1xuXG4gICAgY29uc3QgZmlyc3RVcGxvYWQgPSBhd2FpdCB1cGxvYWRNdWx0aXBhcnRQYXJ0KFxuICAgICAgZW52LFxuICAgICAgdmFsdWUuYnVuZGxlU2hhMjU2LFxuICAgICAgaW5pdGlhdGVkQm9keS51cGxvYWRJZCxcbiAgICAgIDEsXG4gICAgICBmaXJzdFBhcnQsXG4gICAgICBwYXJ0c1swXS5zaGEyNTYsXG4gICAgKTtcbiAgICBleHBlY3QoZmlyc3RVcGxvYWQuc3RhdHVzKS50b0JlKDIwMCk7XG4gICAgY29uc3QgZmlyc3RVcGxvYWRCb2R5ID0gYXdhaXQgZmlyc3RVcGxvYWQuanNvbigpIGFzIFVwbG9hZGVkTXVsdGlwYXJ0UGFydDtcbiAgICBjb25zdCBmaXJzdFVwbG9hZGVkOiBVcGxvYWRlZE11bHRpcGFydFBhcnQgPSB7XG4gICAgICBwYXJ0TnVtYmVyOiBmaXJzdFVwbG9hZEJvZHkucGFydE51bWJlcixcbiAgICAgIGV0YWc6IGZpcnN0VXBsb2FkQm9keS5ldGFnLFxuICAgIH07XG4gICAgY29uc3QgZmlyc3RSZXBsYXkgPSBhd2FpdCB1cGxvYWRNdWx0aXBhcnRQYXJ0KFxuICAgICAgZW52LFxuICAgICAgdmFsdWUuYnVuZGxlU2hhMjU2LFxuICAgICAgaW5pdGlhdGVkQm9keS51cGxvYWRJZCxcbiAgICAgIDEsXG4gICAgICBmaXJzdFBhcnQsXG4gICAgICBwYXJ0c1swXS5zaGEyNTYsXG4gICAgKTtcbiAgICBleHBlY3QoZmlyc3RSZXBsYXkuc3RhdHVzKS50b0JlKDIwMCk7XG4gICAgZXhwZWN0KGF3YWl0IGZpcnN0UmVwbGF5Lmpzb24oKSkudG9NYXRjaE9iamVjdCh7IGV0YWc6IGZpcnN0VXBsb2FkZWQuZXRhZyB9KTtcblxuICAgIGNvbnN0IGluY29tcGxldGUgPSBhd2FpdCBjb21wbGV0ZU11bHRpcGFydChcbiAgICAgIGVudixcbiAgICAgIHZhbHVlLmJ1bmRsZVNoYTI1NixcbiAgICAgIGluaXRpYXRlZEJvZHkudXBsb2FkSWQsXG4gICAgICBbZmlyc3RVcGxvYWRlZCwgeyBwYXJ0TnVtYmVyOiAyLCBldGFnOiAnbWlzc2luZy1wYXJ0JyB9XSxcbiAgICApO1xuICAgIGV4cGVjdChpbmNvbXBsZXRlLnN0YXR1cykudG9CZSg0MDkpO1xuICAgIGV4cGVjdChhd2FpdCBpbmNvbXBsZXRlLmpzb24oKSkudG9NYXRjaE9iamVjdCh7IGVycm9yOiAnbXVsdGlwYXJ0X3VwbG9hZF9pbmNvbXBsZXRlJyB9KTtcblxuICAgIGNvbnN0IGZpbmFsVXBsb2FkID0gYXdhaXQgdXBsb2FkTXVsdGlwYXJ0UGFydChcbiAgICAgIGVudixcbiAgICAgIHZhbHVlLmJ1bmRsZVNoYTI1NixcbiAgICAgIGluaXRpYXRlZEJvZHkudXBsb2FkSWQsXG4gICAgICAyLFxuICAgICAgZmluYWxQYXJ0LFxuICAgICAgcGFydHNbMV0uc2hhMjU2LFxuICAgICk7XG4gICAgZXhwZWN0KGZpbmFsVXBsb2FkLnN0YXR1cykudG9CZSgyMDApO1xuICAgIGNvbnN0IGZpbmFsVXBsb2FkQm9keSA9IGF3YWl0IGZpbmFsVXBsb2FkLmpzb24oKSBhcyBVcGxvYWRlZE11bHRpcGFydFBhcnQ7XG4gICAgY29uc3QgZmluYWxVcGxvYWRlZDogVXBsb2FkZWRNdWx0aXBhcnRQYXJ0ID0ge1xuICAgICAgcGFydE51bWJlcjogZmluYWxVcGxvYWRCb2R5LnBhcnROdW1iZXIsXG4gICAgICBldGFnOiBmaW5hbFVwbG9hZEJvZHkuZXRhZyxcbiAgICB9O1xuXG4gICAgLy8gUHJvZHVjdGlvbiBSMiBjYW4gb21pdCBkdXJhYmxlIGN1c3RvbSBtZXRhZGF0YSBmcm9tIHRoZSBpbW1lZGlhdGVcbiAgICAvLyBgY29tcGxldGUoKWAgcmV0dXJuIGV2ZW4gdGhvdWdoIGEgZnJlc2ggSEVBRCBhbHJlYWR5IGNhcnJpZXMgaXQuIFRoZVxuICAgIC8vIGNvbXBsZXRpb24gcm91dGUgbXVzdCBhZGp1ZGljYXRlIHRoZSBzdG9yZWQgb2JqZWN0LCBub3QgdGhhdCB0cmFuc2llbnRcbiAgICAvLyByZXNwb25zZSBzaGFwZSAobGl2ZSBELTEyOSBwdWJsaWNhdGlvbiBpbmNpZGVudCwgMjAyNi0wOC0yNikuXG4gICAgcjIubmV4dE11bHRpcGFydENvbXBsZXRlUmV0dXJuT21pdHNDdXN0b21NZXRhZGF0YSA9IHRydWU7XG4gICAgY29uc3QgY29tcGxldGVkID0gYXdhaXQgY29tcGxldGVNdWx0aXBhcnQoXG4gICAgICBlbnYsXG4gICAgICB2YWx1ZS5idW5kbGVTaGEyNTYsXG4gICAgICBpbml0aWF0ZWRCb2R5LnVwbG9hZElkLFxuICAgICAgW2ZpcnN0VXBsb2FkZWQsIGZpbmFsVXBsb2FkZWRdLFxuICAgICk7XG4gICAgZXhwZWN0KGNvbXBsZXRlZC5zdGF0dXMpLnRvQmUoMjAxKTtcbiAgICBleHBlY3QoYXdhaXQgY29tcGxldGVkLmpzb24oKSkudG9NYXRjaE9iamVjdCh7IGRlZHVwZWQ6IGZhbHNlLCBieXRlczogYnVuZGxlLmJ5dGVMZW5ndGggfSk7XG4gICAgZXhwZWN0KHIyLm11bHRpcGFydFVwbG9hZHMuc2l6ZSkudG9CZSgwKTtcbiAgICBjb25zdCBidW5kbGVLZXkgPSBgJHtXT1JLU1BBQ0VfSE9TVF9BUlRJRkFDVF9QUkVGSVh9LyR7dmFsdWUuYnVuZGxlU2hhMjU2fS9zZXJ2ZXIudGd6YDtcbiAgICBjb25zdCBzdG9yZWRCdW5kbGUgPSByMi5kYXRhLmdldChidW5kbGVLZXkpITtcbiAgICBleHBlY3Qoc3RvcmVkQnVuZGxlLmJ5dGVMZW5ndGgpLnRvQmUoYnVuZGxlLmJ5dGVMZW5ndGgpO1xuICAgIGV4cGVjdChhd2FpdCBzaGEyNTZIZXgoc3RvcmVkQnVuZGxlKSkudG9CZSh2YWx1ZS5idW5kbGVTaGEyNTYpO1xuXG4gICAgY29uc3QgY29tcGxldGVkUmVwbGF5ID0gYXdhaXQgY29tcGxldGVNdWx0aXBhcnQoXG4gICAgICBlbnYsXG4gICAgICB2YWx1ZS5idW5kbGVTaGEyNTYsXG4gICAgICBpbml0aWF0ZWRCb2R5LnVwbG9hZElkLFxuICAgICAgW2ZpcnN0VXBsb2FkZWQsIGZpbmFsVXBsb2FkZWRdLFxuICAgICk7XG4gICAgZXhwZWN0KGNvbXBsZXRlZFJlcGxheS5zdGF0dXMpLnRvQmUoMjAwKTtcbiAgICBleHBlY3QoYXdhaXQgY29tcGxldGVkUmVwbGF5Lmpzb24oKSkudG9NYXRjaE9iamVjdCh7IGRlZHVwZWQ6IHRydWUgfSk7XG5cbiAgICBjb25zdCBjb25mbGljdGluZ0luaXRpYXRlID0gYXdhaXQgaW5pdGlhdGVNdWx0aXBhcnQoXG4gICAgICBlbnYsXG4gICAgICB2YWx1ZS5idW5kbGVTaGEyNTYsXG4gICAgICBidW5kbGUuYnl0ZUxlbmd0aCArIDEsXG4gICAgICBwYXJ0cyxcbiAgICApO1xuICAgIGV4cGVjdChjb25mbGljdGluZ0luaXRpYXRlLnN0YXR1cykudG9CZSg0MDkpO1xuICAgIGV4cGVjdChhd2FpdCBjb25mbGljdGluZ0luaXRpYXRlLmpzb24oKSkudG9NYXRjaE9iamVjdCh7IGVycm9yOiAnYXJ0aWZhY3RfY29uZmxpY3QnIH0pO1xuXG4gICAgZXhwZWN0KChhd2FpdCB1cGxvYWQoXG4gICAgICBlbnYsXG4gICAgICB2YWx1ZS5idW5kbGVTaGEyNTYsXG4gICAgICAnc2VydmVyLnRnei5taW5pc2lnJyxcbiAgICAgIHZhbHVlLnNpZ25hdHVyZSxcbiAgICAgIHZhbHVlLnNpZ25hdHVyZVNoYTI1NixcbiAgICApKS5zdGF0dXMpLnRvQmUoMjAxKTtcbiAgICBleHBlY3QoKGF3YWl0IHVwbG9hZChcbiAgICAgIGVudixcbiAgICAgIHZhbHVlLmJ1bmRsZVNoYTI1NixcbiAgICAgICdtYW5pZmVzdC5qc29uJyxcbiAgICAgIHZhbHVlLm1hbmlmZXN0Qnl0ZXMsXG4gICAgICB2YWx1ZS5tYW5pZmVzdFNoYTI1NixcbiAgICApKS5zdGF0dXMpLnRvQmUoMjAxKTtcbiAgICBleHBlY3QoKGF3YWl0IGZpbmFsaXplKGVudiwgdmFsdWUuYnVuZGxlU2hhMjU2KSkuc3RhdHVzKS50b0JlKDIwMSk7XG4gICAgY29uc3QgcHVibGlzaGVkID0gYXdhaXQgYXBpLnJlcXVlc3QoXG4gICAgICBgL2FydGlmYWN0cy93b3Jrc3BhY2UtaG9zdC9zaGEyNTYvJHt2YWx1ZS5idW5kbGVTaGEyNTZ9L3NlcnZlci50Z3pgLFxuICAgICAge30sXG4gICAgICBlbnYsXG4gICAgKTtcbiAgICBleHBlY3QocHVibGlzaGVkLnN0YXR1cykudG9CZSgyMDApO1xuICAgIGNvbnN0IHB1Ymxpc2hlZEJ1bmRsZSA9IG5ldyBVaW50OEFycmF5KGF3YWl0IHB1Ymxpc2hlZC5hcnJheUJ1ZmZlcigpKTtcbiAgICBleHBlY3QocHVibGlzaGVkQnVuZGxlLmJ5dGVMZW5ndGgpLnRvQmUoYnVuZGxlLmJ5dGVMZW5ndGgpO1xuICAgIGV4cGVjdChhd2FpdCBzaGEyNTZIZXgocHVibGlzaGVkQnVuZGxlKSkudG9CZSh2YWx1ZS5idW5kbGVTaGEyNTYpO1xuICB9KTtcblxuICBpdCgnYWJvcnRzIG11bHRpcGFydCBzdGF0ZSBpZGVtcG90ZW50bHkgYW5kIHJlZnVzZXMgcGFydHMgYWZ0ZXIgY2xvc3VyZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBidW5kbGUgPSBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoJ3NtYWxsIGFib3J0YWJsZSBtdWx0aXBhcnQgYm9keScpO1xuICAgIGNvbnN0IGJ1bmRsZVNoYTI1NiA9IGF3YWl0IHNoYTI1NkhleChidW5kbGUpO1xuICAgIGNvbnN0IHBhcnRTaGEyNTYgPSBhd2FpdCBzaGEyNTZIZXgoYnVuZGxlKTtcbiAgICBjb25zdCB7IGVudiwgcjIgfSA9IGF1dGhlZEVudigpO1xuICAgIGNvbnN0IGluaXRpYXRlZCA9IGF3YWl0IGluaXRpYXRlTXVsdGlwYXJ0KGVudiwgYnVuZGxlU2hhMjU2LCBidW5kbGUuYnl0ZUxlbmd0aCwgW1xuICAgICAgeyBwYXJ0TnVtYmVyOiAxLCBzaGEyNTY6IHBhcnRTaGEyNTYsIHNpemVCeXRlczogYnVuZGxlLmJ5dGVMZW5ndGggfSxcbiAgICBdKTtcbiAgICBjb25zdCB7IHVwbG9hZElkIH0gPSBhd2FpdCBpbml0aWF0ZWQuanNvbigpIGFzIHsgdXBsb2FkSWQ6IHN0cmluZyB9O1xuICAgIGV4cGVjdChpbml0aWF0ZWQuc3RhdHVzKS50b0JlKDIwMSk7XG4gICAgZXhwZWN0KHIyLm11bHRpcGFydFVwbG9hZHMuc2l6ZSkudG9CZSgxKTtcblxuICAgIGV4cGVjdCgoYXdhaXQgYWJvcnRNdWx0aXBhcnQoZW52LCBidW5kbGVTaGEyNTYsIHVwbG9hZElkKSkuc3RhdHVzKS50b0JlKDIwNCk7XG4gICAgZXhwZWN0KChhd2FpdCBhYm9ydE11bHRpcGFydChlbnYsIGJ1bmRsZVNoYTI1NiwgdXBsb2FkSWQpKS5zdGF0dXMpLnRvQmUoMjA0KTtcbiAgICBleHBlY3QocjIubXVsdGlwYXJ0VXBsb2Fkcy5zaXplKS50b0JlKDApO1xuICAgIGNvbnN0IGNsb3NlZFBhcnQgPSBhd2FpdCB1cGxvYWRNdWx0aXBhcnRQYXJ0KFxuICAgICAgZW52LFxuICAgICAgYnVuZGxlU2hhMjU2LFxuICAgICAgdXBsb2FkSWQsXG4gICAgICAxLFxuICAgICAgYnVuZGxlLFxuICAgICAgcGFydFNoYTI1NixcbiAgICApO1xuICAgIGV4cGVjdChjbG9zZWRQYXJ0LnN0YXR1cykudG9CZSg0MDQpO1xuICAgIGV4cGVjdChhd2FpdCBjbG9zZWRQYXJ0Lmpzb24oKSkudG9NYXRjaE9iamVjdCh7IGVycm9yOiAnbXVsdGlwYXJ0X3VwbG9hZF9ub3RfZm91bmQnIH0pO1xuICAgIGV4cGVjdChyMi5kYXRhLmhhcyhgJHtXT1JLU1BBQ0VfSE9TVF9BUlRJRkFDVF9QUkVGSVh9LyR7YnVuZGxlU2hhMjU2fS9zZXJ2ZXIudGd6YCkpLnRvQmUoZmFsc2UpO1xuICB9KTtcblxuICBpdCgncmVmdXNlcyBmaW5hbGl6YXRpb24gdW50aWwgYWxsIHRocmVlIHZlcmlmaWVkIG9iamVjdHMgZXhpc3QnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdmFsdWUgPSBhd2FpdCBmaXh0dXJlKCk7XG4gICAgY29uc3QgeyBlbnYgfSA9IGF1dGhlZEVudigpO1xuICAgIGF3YWl0IHVwbG9hZChlbnYsIHZhbHVlLmJ1bmRsZVNoYTI1NiwgJ3NlcnZlci50Z3onLCB2YWx1ZS5idW5kbGUsIHZhbHVlLmJ1bmRsZVNoYTI1Nik7XG5cbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZpbmFsaXplKGVudiwgdmFsdWUuYnVuZGxlU2hhMjU2KTtcblxuICAgIGV4cGVjdChyZXNwb25zZS5zdGF0dXMpLnRvQmUoNDA5KTtcbiAgICBleHBlY3QoYXdhaXQgcmVzcG9uc2UuanNvbigpKS50b0VxdWFsKHtcbiAgICAgIGVycm9yOiAndXBsb2Fkc19pbmNvbXBsZXRlJyxcbiAgICAgIG1pc3Npbmc6IFsnc2VydmVyLnRnei5taW5pc2lnJywgJ21hbmlmZXN0Lmpzb24nXSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgaXQoJ3JlamVjdHMgYSB0cnVzdCBlbnZlbG9wZSB3aXRoIHNlY3JldCBmaW5kaW5ncyBhbmQgbmV2ZXIgY3JlYXRlcyB2aXNpYmlsaXR5JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHZhbHVlID0gYXdhaXQgZml4dHVyZSgobWFuaWZlc3QpID0+IHtcbiAgICAgIGNvbnN0IHRydXN0ID0gbWFuaWZlc3QudHJ1c3RSZXBvcnQgYXMgeyBldmlkZW5jZTogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IH07XG4gICAgICBjb25zdCBzZWNyZXRTY2FuID0gdHJ1c3QuZXZpZGVuY2UuZmluZCgoZW50cnkpID0+IGVudHJ5LmtpbmQgPT09ICdzZWNyZXQtc2NhbicpITtcbiAgICAgIHNlY3JldFNjYW4uZmluZGluZ3MgPSBbeyBydWxlSWQ6ICdjbG91ZC1hcGkta2V5JywgbG9jYXRpb246ICdidW5kbGU6MTInIH1dO1xuICAgICAgKG1hbmlmZXN0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KS5zbXVnZ2xlZFRva2VuID0gJ2docF9hYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eic7XG4gICAgfSk7XG4gICAgY29uc3QgeyBlbnYsIHIyIH0gPSBhdXRoZWRFbnYoKTtcbiAgICBleHBlY3QoKGF3YWl0IFByb21pc2UuYWxsKGF3YWl0IHVwbG9hZEZpeHR1cmUoZW52LCB2YWx1ZSkpKS5ldmVyeSgocmVzcG9uc2UpID0+IHJlc3BvbnNlLnN0YXR1cyA9PT0gMjAxKSkudG9CZSh0cnVlKTtcblxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmluYWxpemUoZW52LCB2YWx1ZS5idW5kbGVTaGEyNTYpO1xuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZXNwb25zZS5qc29uKCkgYXMgeyBlcnJvcjogc3RyaW5nOyBlcnJvcnM6IHN0cmluZ1tdIH07XG5cbiAgICBleHBlY3QocmVzcG9uc2Uuc3RhdHVzKS50b0JlKDQwMCk7XG4gICAgZXhwZWN0KGJvZHkuZXJyb3IpLnRvQmUoJ2ludmFsaWRfbWFuaWZlc3QnKTtcbiAgICBleHBlY3QoYm9keS5lcnJvcnMuam9pbignICcpKS50b01hdGNoKC91bmV4cGVjdGVkIG1hbmlmZXN0IGZpZWxkfHNlY3JldC1zaGFwZWR8emVybyBmaW5kaW5ncy8pO1xuICAgIGV4cGVjdChyMi5kYXRhLmhhcyhgJHtXT1JLU1BBQ0VfSE9TVF9BUlRJRkFDVF9QUkVGSVh9LyR7dmFsdWUuYnVuZGxlU2hhMjU2fS8uZmluYWxpemVkLmpzb25gKSkudG9CZShmYWxzZSk7XG4gICAgZXhwZWN0KChhd2FpdCBhcGkucmVxdWVzdChcbiAgICAgIGAvYXJ0aWZhY3RzL3dvcmtzcGFjZS1ob3N0L3NoYTI1Ni8ke3ZhbHVlLmJ1bmRsZVNoYTI1Nn0vbWFuaWZlc3QuanNvbmAsXG4gICAgICB7fSxcbiAgICAgIGVudixcbiAgICApKS5zdGF0dXMpLnRvQmUoNDA0KTtcbiAgfSk7XG5cbiAgaXQoJ3JlamVjdHMgYW4gb3RoZXJ3aXNlIHZhbGlkIG1hbmlmZXN0IHRoYXQgcG9pbnRzIGF0IGEgbm9uY2Fub25pY2FsIHJlbGVhc2Ugb3JpZ2luJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHZhbHVlID0gYXdhaXQgZml4dHVyZSgobWFuaWZlc3QpID0+IHtcbiAgICAgIGNvbnN0IGFydGlmYWN0ID0gbWFuaWZlc3QuYXJ0aWZhY3QgYXMgV29ya3NwYWNlSG9zdEltYWdlQXJ0aWZhY3Q7XG4gICAgICAoYXJ0aWZhY3QucmVsZWFzZSBhcyB7IGJ1bmRsZVVybDogc3RyaW5nIH0pLmJ1bmRsZVVybCA9XG4gICAgICAgIGBodHRwczovL3JlbGVhc2VzLnBhcGVyY3VzcC5jb20vJHtWRVJTSU9OfS9zZXJ2ZXIudGd6YDtcbiAgICAgIChhcnRpZmFjdC5yZWxlYXNlIGFzIHsgc2lnbmF0dXJlVXJsOiBzdHJpbmcgfSkuc2lnbmF0dXJlVXJsID1cbiAgICAgICAgYCR7YXJ0aWZhY3QucmVsZWFzZS5idW5kbGVVcmx9Lm1pbmlzaWdgO1xuICAgIH0pO1xuICAgIGNvbnN0IHsgZW52IH0gPSBhdXRoZWRFbnYoKTtcbiAgICBhd2FpdCB1cGxvYWRGaXh0dXJlKGVudiwgdmFsdWUpO1xuXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmaW5hbGl6ZShlbnYsIHZhbHVlLmJ1bmRsZVNoYTI1Nik7XG4gICAgY29uc3QgYm9keSA9IGF3YWl0IHJlc3BvbnNlLmpzb24oKSBhcyB7IGVycm9yczogc3RyaW5nW10gfTtcblxuICAgIGV4cGVjdChyZXNwb25zZS5zdGF0dXMpLnRvQmUoNDAwKTtcbiAgICBleHBlY3QoYm9keS5lcnJvcnMpLnRvQ29udGFpbignYXJ0aWZhY3QgcmVsZWFzZSBVUkxzIG11c3QgZXF1YWwgdGhlIEQtMTA1IGRpZ2VzdC1kZXJpdmVkIEN1cGJvYXJkIFVSTHMnKTtcbiAgfSk7XG5cbiAgaXQoJ2ZpbmFsaXplcyBpZGVtcG90ZW50bHkgYW5kIHNlcnZlcyBwdWJsaWMgR0VUL0hFQUQgd2l0aCBpbW11dGFibGUgaW50ZWdyaXR5IG1ldGFkYXRhJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHZhbHVlID0gYXdhaXQgZml4dHVyZSgpO1xuICAgIGNvbnN0IHsgZW52LCByMiB9ID0gYXV0aGVkRW52KCk7XG4gICAgY29uc3QgdXBsb2FkcyA9IGF3YWl0IHVwbG9hZEZpeHR1cmUoZW52LCB2YWx1ZSk7XG4gICAgZXhwZWN0KHVwbG9hZHMubWFwKChyZXNwb25zZSkgPT4gcmVzcG9uc2Uuc3RhdHVzKSkudG9FcXVhbChbMjAxLCAyMDEsIDIwMV0pO1xuXG4gICAgY29uc3QgY3JlYXRlZCA9IGF3YWl0IGZpbmFsaXplKGVudiwgdmFsdWUuYnVuZGxlU2hhMjU2KTtcbiAgICBleHBlY3QoY3JlYXRlZC5zdGF0dXMpLnRvQmUoMjAxKTtcbiAgICBleHBlY3QoYXdhaXQgY3JlYXRlZC5qc29uKCkpLnRvTWF0Y2hPYmplY3Qoe1xuICAgICAgb2s6IHRydWUsXG4gICAgICBidW5kbGVTaGEyNTY6IHZhbHVlLmJ1bmRsZVNoYTI1NixcbiAgICAgIG1hbmlmZXN0U2hhMjU2OiB2YWx1ZS5tYW5pZmVzdFNoYTI1NixcbiAgICAgIGRlZHVwZWQ6IGZhbHNlLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZHVwbGljYXRlID0gYXdhaXQgZmluYWxpemUoZW52LCB2YWx1ZS5idW5kbGVTaGEyNTYpO1xuICAgIGV4cGVjdChkdXBsaWNhdGUuc3RhdHVzKS50b0JlKDIwMCk7XG4gICAgZXhwZWN0KGF3YWl0IGR1cGxpY2F0ZS5qc29uKCkpLnRvTWF0Y2hPYmplY3QoeyBkZWR1cGVkOiB0cnVlIH0pO1xuXG4gICAgY29uc3QgZ2V0ID0gYXdhaXQgYXBpLnJlcXVlc3QoXG4gICAgICBgL2FydGlmYWN0cy93b3Jrc3BhY2UtaG9zdC9zaGEyNTYvJHt2YWx1ZS5idW5kbGVTaGEyNTZ9L3NlcnZlci50Z3pgLFxuICAgICAge30sXG4gICAgICBlbnYsXG4gICAgKTtcbiAgICBleHBlY3QoZ2V0LnN0YXR1cykudG9CZSgyMDApO1xuICAgIGV4cGVjdChuZXcgVWludDhBcnJheShhd2FpdCBnZXQuYXJyYXlCdWZmZXIoKSkpLnRvRXF1YWwodmFsdWUuYnVuZGxlKTtcbiAgICBleHBlY3QoZ2V0LmhlYWRlcnMuZ2V0KCdjYWNoZS1jb250cm9sJykpLnRvQmUoV09SS1NQQUNFX0hPU1RfUFVCTElDX0NBQ0hFX0NPTlRST0wpO1xuICAgIGV4cGVjdChnZXQuaGVhZGVycy5nZXQoJ3gtYXJ0aWZhY3Qtc2hhMjU2JykpLnRvQmUodmFsdWUuYnVuZGxlU2hhMjU2KTtcbiAgICBleHBlY3QoZ2V0LmhlYWRlcnMuZ2V0KCdjb250ZW50LXR5cGUnKSkudG9CZSgnYXBwbGljYXRpb24vZ3ppcCcpO1xuICAgIGV4cGVjdChnZXQuaGVhZGVycy5nZXQoJ3gtY29udGVudC10eXBlLW9wdGlvbnMnKSkudG9CZSgnbm9zbmlmZicpO1xuXG4gICAgY29uc3QgaGVhZCA9IGF3YWl0IGFwaS5yZXF1ZXN0KFxuICAgICAgYC9hcnRpZmFjdHMvd29ya3NwYWNlLWhvc3Qvc2hhMjU2LyR7dmFsdWUuYnVuZGxlU2hhMjU2fS9tYW5pZmVzdC5qc29uYCxcbiAgICAgIHsgbWV0aG9kOiAnSEVBRCcgfSxcbiAgICAgIGVudixcbiAgICApO1xuICAgIGV4cGVjdChoZWFkLnN0YXR1cykudG9CZSgyMDApO1xuICAgIGV4cGVjdChhd2FpdCBoZWFkLnRleHQoKSkudG9CZSgnJyk7XG4gICAgZXhwZWN0KGhlYWQuaGVhZGVycy5nZXQoJ2NvbnRlbnQtbGVuZ3RoJykpLnRvQmUoU3RyaW5nKHZhbHVlLm1hbmlmZXN0Qnl0ZXMuYnl0ZUxlbmd0aCkpO1xuICAgIGV4cGVjdChoZWFkLmhlYWRlcnMuZ2V0KCd4LWFydGlmYWN0LXNoYTI1NicpKS50b0JlKHZhbHVlLm1hbmlmZXN0U2hhMjU2KTtcblxuICAgIGNvbnN0IG1hcmtlcktleSA9IGAke1dPUktTUEFDRV9IT1NUX0FSVElGQUNUX1BSRUZJWH0vJHt2YWx1ZS5idW5kbGVTaGEyNTZ9Ly5maW5hbGl6ZWQuanNvbmA7XG4gICAgZXhwZWN0KHIyLmRhdGEuaGFzKG1hcmtlcktleSkpLnRvQmUodHJ1ZSk7XG5cbiAgICAvLyBBIG1hcmtlciBpcyBub3QgYSBibGFua2V0IHN1Y2Nlc3MgZm9yZXZlcjogYW4gaWRlbXBvdGVudCByZXRyeSByZS1wcm92ZXNcbiAgICAvLyB0aGUgZmluYWxpemVkIHNldCBhbmQgZmFpbHMgY2xvc2VkIGlmIGEgc2libGluZyBvYmplY3QgZGlzYXBwZWFyZWQuXG4gICAgYXdhaXQgcjIuZGVsZXRlKGAke1dPUktTUEFDRV9IT1NUX0FSVElGQUNUX1BSRUZJWH0vJHt2YWx1ZS5idW5kbGVTaGEyNTZ9L3NlcnZlci50Z3oubWluaXNpZ2ApO1xuICAgIGNvbnN0IGluY29tcGxldGVSZXRyeSA9IGF3YWl0IGZpbmFsaXplKGVudiwgdmFsdWUuYnVuZGxlU2hhMjU2KTtcbiAgICBleHBlY3QoaW5jb21wbGV0ZVJldHJ5LnN0YXR1cykudG9CZSg0MDkpO1xuICAgIGV4cGVjdChhd2FpdCBpbmNvbXBsZXRlUmV0cnkuanNvbigpKS50b01hdGNoT2JqZWN0KHsgZXJyb3I6ICdmaW5hbGl6YXRpb25fY29uZmxpY3QnIH0pO1xuICB9KTtcblxuICBpdCgnZmFpbHMgY2xvc2VkIHdoZW4gZmluYWxpemVkIG9iamVjdCBtZXRhZGF0YSBubyBsb25nZXIgbWF0Y2hlcyB0aGUgbWFya2VyJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHZhbHVlID0gYXdhaXQgZml4dHVyZSgpO1xuICAgIGNvbnN0IHsgZW52LCByMiB9ID0gYXV0aGVkRW52KCk7XG4gICAgYXdhaXQgdXBsb2FkRml4dHVyZShlbnYsIHZhbHVlKTtcbiAgICBleHBlY3QoKGF3YWl0IGZpbmFsaXplKGVudiwgdmFsdWUuYnVuZGxlU2hhMjU2KSkuc3RhdHVzKS50b0JlKDIwMSk7XG4gICAgY29uc3QgYnVuZGxlS2V5ID0gYCR7V09SS1NQQUNFX0hPU1RfQVJUSUZBQ1RfUFJFRklYfS8ke3ZhbHVlLmJ1bmRsZVNoYTI1Nn0vc2VydmVyLnRnemA7XG4gICAgY29uc3QgYnVuZGxlTWV0YWRhdGEgPSByMi5jdXN0b21NZXRhZGF0YS5nZXQoYnVuZGxlS2V5KSE7XG4gICAgY29uc3Qgb3JpZ2luYWxCdW5kbGVTaGEyNTYgPSBidW5kbGVNZXRhZGF0YS5maWxlU2hhMjU2O1xuICAgIGJ1bmRsZU1ldGFkYXRhLmZpbGVTaGEyNTYgPSAnMCcucmVwZWF0KDY0KTtcblxuICAgIGNvbnN0IG9iamVjdE1pc21hdGNoID0gYXdhaXQgYXBpLnJlcXVlc3QoXG4gICAgICBgL2FydGlmYWN0cy93b3Jrc3BhY2UtaG9zdC9zaGEyNTYvJHt2YWx1ZS5idW5kbGVTaGEyNTZ9L3NlcnZlci50Z3pgLFxuICAgICAge30sXG4gICAgICBlbnYsXG4gICAgKTtcbiAgICBleHBlY3Qob2JqZWN0TWlzbWF0Y2guc3RhdHVzKS50b0JlKDQwNCk7XG5cbiAgICBidW5kbGVNZXRhZGF0YS5maWxlU2hhMjU2ID0gb3JpZ2luYWxCdW5kbGVTaGEyNTY7XG4gICAgY29uc3QgbWFya2VyS2V5ID0gYCR7V09SS1NQQUNFX0hPU1RfQVJUSUZBQ1RfUFJFRklYfS8ke3ZhbHVlLmJ1bmRsZVNoYTI1Nn0vLmZpbmFsaXplZC5qc29uYDtcbiAgICByMi5jdXN0b21NZXRhZGF0YS5nZXQobWFya2VyS2V5KSEubWFuaWZlc3RTaGEyNTYgPSAnMCcucmVwZWF0KDY0KTtcbiAgICBjb25zdCBtYXJrZXJNaXNtYXRjaCA9IGF3YWl0IGFwaS5yZXF1ZXN0KFxuICAgICAgYC9hcnRpZmFjdHMvd29ya3NwYWNlLWhvc3Qvc2hhMjU2LyR7dmFsdWUuYnVuZGxlU2hhMjU2fS9zZXJ2ZXIudGd6YCxcbiAgICAgIHt9LFxuICAgICAgZW52LFxuICAgICk7XG5cbiAgICBleHBlY3QobWFya2VyTWlzbWF0Y2guc3RhdHVzKS50b0JlKDQwNCk7XG4gIH0pO1xuXG4gIGl0KCdyZWZ1c2VzIGEgY29uZmxpY3RpbmcgcmUtdXBsb2FkIGF0IHRoZSBzYW1lIGJ1bmRsZSBuYW1lc3BhY2UnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdmFsdWUgPSBhd2FpdCBmaXh0dXJlKCk7XG4gICAgY29uc3QgeyBlbnYgfSA9IGF1dGhlZEVudigpO1xuICAgIGV4cGVjdCgoYXdhaXQgdXBsb2FkKFxuICAgICAgZW52LFxuICAgICAgdmFsdWUuYnVuZGxlU2hhMjU2LFxuICAgICAgJ3NlcnZlci50Z3oubWluaXNpZycsXG4gICAgICB2YWx1ZS5zaWduYXR1cmUsXG4gICAgICB2YWx1ZS5zaWduYXR1cmVTaGEyNTYsXG4gICAgKSkuc3RhdHVzKS50b0JlKDIwMSk7XG4gICAgY29uc3QgcmVwbGFjZW1lbnQgPSBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoJ2RpZmZlcmVudCBkZXRhY2hlZCBzaWduYXR1cmUnKTtcbiAgICBjb25zdCByZXBsYWNlbWVudFNoYTI1NiA9IGF3YWl0IHNoYTI1NkhleChyZXBsYWNlbWVudCk7XG5cbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHVwbG9hZChcbiAgICAgIGVudixcbiAgICAgIHZhbHVlLmJ1bmRsZVNoYTI1NixcbiAgICAgICdzZXJ2ZXIudGd6Lm1pbmlzaWcnLFxuICAgICAgcmVwbGFjZW1lbnQsXG4gICAgICByZXBsYWNlbWVudFNoYTI1NixcbiAgICApO1xuXG4gICAgZXhwZWN0KHJlc3BvbnNlLnN0YXR1cykudG9CZSg0MDkpO1xuICAgIGV4cGVjdChhd2FpdCByZXNwb25zZS5qc29uKCkpLnRvTWF0Y2hPYmplY3QoeyBlcnJvcjogJ2FydGlmYWN0X2NvbmZsaWN0JyB9KTtcbiAgfSk7XG59KTtcbiJdLCJmaWxlIjoiL3NyYy9yb3V0ZXMvd29ya3NwYWNlLWhvc3QtYXJ0aWZhY3RzLnRlc3QudHMifQ==

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9vcGVyYXRvci1wdWJsaWMvc3JjL3JvdXRlcy93b3Jrc3BhY2UtaG9zdC1hcnRpZmFjdHMudGVzdC50cyIsIi9zcmMvcm91dGVzL3dvcmtzcGFjZS1ob3N0LWFydGlmYWN0cy50ZXN0LnRzIixbXV0=
}}