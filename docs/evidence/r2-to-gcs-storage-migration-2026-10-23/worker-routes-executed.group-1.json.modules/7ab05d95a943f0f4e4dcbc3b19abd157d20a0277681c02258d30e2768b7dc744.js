'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION", () => { try { return WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_BUILD_MANIFEST_SCHEMA_VERSION", () => { try { return WORKSPACE_HOST_BUILD_MANIFEST_SCHEMA_VERSION } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_PACKER_BUILDER_KIND", () => { try { return WORKSPACE_HOST_PACKER_BUILDER_KIND } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_SIDECAR_BUILDER_KIND", () => { try { return WORKSPACE_HOST_SIDECAR_BUILDER_KIND } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_BOOTC_BUILDER_KIND", () => { try { return WORKSPACE_HOST_BOOTC_BUILDER_KIND } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_BUILDER_KINDS", () => { try { return WORKSPACE_HOST_BUILDER_KINDS } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_SHARED_BUILDER_KIND", () => { try { return WORKSPACE_HOST_SHARED_BUILDER_KIND } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_BUILDER_TEMPLATE_SHAPES", () => { try { return WORKSPACE_HOST_BUILDER_TEMPLATE_SHAPES } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_IMAGE_FAMILY_BUILDER_KINDS", () => { try { return WORKSPACE_HOST_IMAGE_FAMILY_BUILDER_KINDS } catch {} });
__vite_ssr_exportName__("WorkspaceHostBuildManifestError", () => { try { return WorkspaceHostBuildManifestError } catch {} });
__vite_ssr_exportName__("normalizeWorkspaceHostBuildManifestInput", () => { try { return normalizeWorkspaceHostBuildManifestInput } catch {} });
__vite_ssr_exportName__("canonicalWorkspaceHostBuildManifestPayload", () => { try { return canonicalWorkspaceHostBuildManifestPayload } catch {} });
__vite_ssr_exportName__("buildWorkspaceHostBuildManifest", () => { try { return buildWorkspaceHostBuildManifest } catch {} });
__vite_ssr_exportName__("verifyWorkspaceHostBuildManifest", () => { try { return verifyWorkspaceHostBuildManifest } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT", () => { try { return WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT", () => { try { return WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_DESKTOP_SESSION_ENTRYPOINT", () => { try { return WORKSPACE_HOST_DESKTOP_SESSION_ENTRYPOINT } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_PUI_ENTRYPOINT", () => { try { return WORKSPACE_HOST_PUI_ENTRYPOINT } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_PUI_COMPANION_PATH", () => { try { return WORKSPACE_HOST_PUI_COMPANION_PATH } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_PUI_INSTALL_MANIFEST_PATH", () => { try { return WORKSPACE_HOST_PUI_INSTALL_MANIFEST_PATH } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS", () => { try { return WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_ARTIFACT_ORIGIN", () => { try { return WORKSPACE_HOST_ARTIFACT_ORIGIN } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_ARTIFACT_PATH_PREFIX", () => { try { return WORKSPACE_HOST_ARTIFACT_PATH_PREFIX } catch {} });
__vite_ssr_exportName__("deriveWorkspaceHostCanonicalArtifactUrls", () => { try { return deriveWorkspaceHostCanonicalArtifactUrls } catch {} });
__vite_ssr_exportName__("workspaceHostReleaseAddressingErrors", () => { try { return workspaceHostReleaseAddressingErrors } catch {} });
__vite_ssr_exportName__("verifyWorkspaceHostReleaseProvenance", () => { try { return verifyWorkspaceHostReleaseProvenance } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("node:crypto", {"importedNames":["createHash"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/papercusp-publish-auth/src/jcs.ts", {"importedNames":["canonicalize"]});


const WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION = "papercusp-workspace-host-build-input-v1";
const WORKSPACE_HOST_BUILD_MANIFEST_SCHEMA_VERSION = 1;
const WORKSPACE_HOST_PACKER_BUILDER_KIND = "hashicorp-packer";
const WORKSPACE_HOST_SIDECAR_BUILDER_KIND = "papercusp-desktop-sidecar";
const WORKSPACE_HOST_BOOTC_BUILDER_KIND = "bootc-image-builder";
const WORKSPACE_HOST_BUILDER_KINDS = [
  WORKSPACE_HOST_PACKER_BUILDER_KIND,
  WORKSPACE_HOST_SIDECAR_BUILDER_KIND,
  WORKSPACE_HOST_BOOTC_BUILDER_KIND
];
const WORKSPACE_HOST_SHARED_BUILDER_KIND = WORKSPACE_HOST_PACKER_BUILDER_KIND;
const WORKSPACE_HOST_BUILDER_TEMPLATE_SHAPES = {
  [WORKSPACE_HOST_PACKER_BUILDER_KIND]: {
    pattern: /\.pkr\.(hcl|json)$/,
    description: "a Packer template (.pkr.hcl or .pkr.json)",
    imageFamilyEligible: true
  },
  [WORKSPACE_HOST_BOOTC_BUILDER_KIND]: {
    // bootc-image-builder consumes an OCI image built from a Containerfile; the manifest
    // pins the Containerfile because that is the in-repo, content-addressable input.
    pattern: /(^|\/)[^/]*Containerfile$/,
    description: "a Containerfile",
    imageFamilyEligible: true
  },
  [WORKSPACE_HOST_SIDECAR_BUILDER_KIND]: {
    pattern: /\.(sh|mjs|ts)$/,
    description: "a sidecar build script (.sh, .mjs or .ts)",
    imageFamilyEligible: false
  }
};
const WORKSPACE_HOST_IMAGE_FAMILY_BUILDER_KINDS = WORKSPACE_HOST_BUILDER_KINDS.filter(
  (kind) => WORKSPACE_HOST_BUILDER_TEMPLATE_SHAPES[kind].imageFamilyEligible
);
class WorkspaceHostBuildManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceHostBuildManifestError";
  }
};
const SHA256_HEX = /^[a-f0-9]{64}$/;
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SECRET_PARAMETER = /(?:^|[-_.])(credential|password|private[-_]?key|secret|token)(?:$|[-_.])/i;
const GCP_IMMUTABLE_IMAGE_REFERENCE = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/global\/images\/[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const OCI_IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._-]*(?::\d{1,5})?(?:\/[a-z0-9][a-z0-9._-]*)+(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/;
const SECRET_MATERIAL = /(?:^|[/_.-])(?:private[-_.]?key|secret|secrets|credential|credentials|password|passwd|token|id_rsa|id_ecdsa|id_ed25519)(?:$|[/_.-])|\.(?:pem|key|p12|pfx|jks|keystore)$/i;
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function requireText(value, path) {
  if (value.trim().length === 0)
    throw new WorkspaceHostBuildManifestError(
      `${path} must be a non-empty string`
    );
  return value;
}
function requireSha256(value, path) {
  if (!SHA256_HEX.test(value)) {
    throw new WorkspaceHostBuildManifestError(
      `${path} must be a lowercase 64-character SHA-256 hex digest`
    );
  };
  return value;
}
function requireSize(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceHostBuildManifestError(
      `${path} must be a non-negative safe integer`
    );
  };
  return value;
}
function requireRelativePath(value, path) {
  requireText(value, path);
  const segments = value.split("/");
  if (value.startsWith("/") || value.includes("\\") || segments.some(
    (segment) => segment === "" || segment === "." || segment === ".."
  )) {
    throw new WorkspaceHostBuildManifestError(
      `${path} must be a normalized repository-relative POSIX path`
    );
  };
  return value;
}
function assertUnique(values, path) {
  const seen = /* @__PURE__ */ new Set();
  for (const value of values) {
    if (seen.has(value))
      throw new WorkspaceHostBuildManifestError(
        `${path} contains duplicate '${value}'`
      );
    seen.add(value);
  }
}
function normalizeMaterials(materials) {
  if (materials.length === 0)
    throw new WorkspaceHostBuildManifestError(
      "materials must contain at least one build input"
    );
  materials.forEach((material, index) => {
    if (typeof material.path === "string" && SECRET_MATERIAL.test(material.path))
      throw new WorkspaceHostBuildManifestError(
        `materials[${index}].path ${material.path} names secret key material, which must never be enumerated in a published manifest`
      );
  });
  const normalized = materials.map((material, index) => ({
    path: requireRelativePath(material.path, `materials[${index}].path`),
    sha256: requireSha256(material.sha256, `materials[${index}].sha256`),
    sizeBytes: requireSize(material.sizeBytes, `materials[${index}].sizeBytes`),
    ...material.executable === void 0 ? {} : { executable: material.executable }
  }));
  assertUnique(
    normalized.map((material) => material.path),
    "materials"
  );
  return normalized.sort((left, right) => compareText(left.path, right.path));
}
function normalizeParameters(parameters) {
  const normalized = parameters.map((parameter, index) => {
    const name = requireText(parameter.name, `parameters[${index}].name`);
    if (SECRET_PARAMETER.test(name)) {
      throw new WorkspaceHostBuildManifestError(
        `parameters[${index}].name '${name}' is secret-shaped and cannot enter the manifest`
      );
    };
    if (typeof parameter.value === "number" && !Number.isFinite(parameter.value)) {
      throw new WorkspaceHostBuildManifestError(
        `parameters[${index}].value must be finite`
      );
    };
    return { name, value: parameter.value };
  });
  assertUnique(
    normalized.map((parameter) => parameter.name),
    "parameters"
  );
  return normalized.sort((left, right) => compareText(left.name, right.name));
}
function normalizeTargets(targets) {
  if (targets.length === 0)
    throw new WorkspaceHostBuildManifestError(
      "targets must contain at least one provider"
    );
  const normalized = targets.map((target, index) => {
    const provider = requireText(target.provider, `targets[${index}].provider`);
    const locations = target.locations.map(
      (location, locationIndex) => requireText(location, `targets[${index}].locations[${locationIndex}]`)
    );
    assertUnique(locations, `targets[${index}].locations`);
    return { provider, locations: [...locations].sort(compareText) };
  });
  assertUnique(
    normalized.map((target) => target.provider),
    "targets"
  );
  return normalized.sort(
    (left, right) => compareText(left.provider, right.provider)
  );
}
function normalizeBaseImageReference(reference, targets, builderKind) {
  const normalized = requireText(reference, "baseImage.reference");
  if (builderKind === WORKSPACE_HOST_BOOTC_BUILDER_KIND) {
    if (!OCI_IMAGE_REFERENCE.test(normalized)) {
      throw new WorkspaceHostBuildManifestError(
        "baseImage.reference must be a registry-qualified OCI image reference for bootc-image-builder"
      );
    };
    return normalized;
  };
  if (targets.some((target) => target.provider === "gcp") && !GCP_IMMUTABLE_IMAGE_REFERENCE.test(normalized)) {
    throw new WorkspaceHostBuildManifestError(
      "baseImage.reference must be an immutable projects/{project}/global/images/{name} reference when a gcp target is present; family aliases are forbidden"
    );
  };
  return normalized;
}
function normalizeWorkspaceHostBuildManifestInput(input) {
  if (input.contractVersion !== WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION) {
    throw new WorkspaceHostBuildManifestError(
      `contractVersion must be '${WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION}'`
    );
  };
  if (input.distributionProfile !== "vm-release") {
    throw new WorkspaceHostBuildManifestError(
      "distributionProfile must be 'vm-release'"
    );
  };
  if (!GIT_REVISION.test(input.source.revision)) {
    throw new WorkspaceHostBuildManifestError(
      "source.revision must be a lowercase immutable Git SHA-1 or SHA-256 object id"
    );
  };
  if (input.builder.strategy !== "shared" || !WORKSPACE_HOST_BUILDER_KINDS.includes(
    input.builder.kind
  )) {
    throw new WorkspaceHostBuildManifestError(
      `builder must select a shared canonical producer (${WORKSPACE_HOST_BUILDER_KINDS.join(", ")})`
    );
  };
  const normalizedTargets = normalizeTargets(input.targets);
  return {
    schemaVersion: WORKSPACE_HOST_BUILD_MANIFEST_SCHEMA_VERSION,
    contractVersion: input.contractVersion,
    distributionProfile: input.distributionProfile,
    source: {
      repository: requireText(input.source.repository, "source.repository"),
      revision: input.source.revision
    },
    releaseArtifact: {
      name: requireText(input.releaseArtifact.name, "releaseArtifact.name"),
      version: requireText(
        input.releaseArtifact.version,
        "releaseArtifact.version"
      ),
      sha256: requireSha256(
        input.releaseArtifact.sha256,
        "releaseArtifact.sha256"
      ),
      sizeBytes: requireSize(
        input.releaseArtifact.sizeBytes,
        "releaseArtifact.sizeBytes"
      )
    },
    baseImage: {
      reference: normalizeBaseImageReference(
        input.baseImage.reference,
        normalizedTargets,
        input.builder.kind
      ),
      architecture: requireText(
        input.baseImage.architecture,
        "baseImage.architecture"
      ),
      sha256: requireSha256(input.baseImage.sha256, "baseImage.sha256")
    },
    builder: {
      strategy: input.builder.strategy,
      kind: input.builder.kind,
      version: requireText(input.builder.version, "builder.version"),
      templatePath: requireRelativePath(
        input.builder.templatePath,
        "builder.templatePath"
      ),
      templateSha256: requireSha256(
        input.builder.templateSha256,
        "builder.templateSha256"
      )
    },
    materials: normalizeMaterials(input.materials),
    parameters: normalizeParameters(input.parameters),
    targets: normalizedTargets
  };
};
function canonicalWorkspaceHostBuildManifestPayload(payload) {
  const { manifestIdentity: _manifestIdentity, ...canonicalPayload } = payload;
  return (0,__vite_ssr_import_1__.canonicalize)(canonicalPayload);
};
function identityFor(payload) {
  const digest = (0,__vite_ssr_import_0__.createHash)("sha256").update(canonicalWorkspaceHostBuildManifestPayload(payload), "utf8").digest("hex");
  return `sha256:${digest}`;
}
function buildWorkspaceHostBuildManifest(input) {
  const payload = normalizeWorkspaceHostBuildManifestInput(input);
  return { ...payload, manifestIdentity: identityFor(payload) };
};
function verifyWorkspaceHostBuildManifest(manifest) {
  try {
    const {
      manifestIdentity,
      schemaVersion: _schemaVersion,
      ...input
    } = manifest;
    const payload = normalizeWorkspaceHostBuildManifestInput(input);
    const expectedIdentity = identityFor(payload);
    const errors = [
      ...manifest.schemaVersion === WORKSPACE_HOST_BUILD_MANIFEST_SCHEMA_VERSION ? [] : [
        `schemaVersion must be ${WORKSPACE_HOST_BUILD_MANIFEST_SCHEMA_VERSION}`
      ],
      ...manifestIdentity === expectedIdentity ? [] : [
        `manifestIdentity ${manifestIdentity} does not match canonical payload ${expectedIdentity}`
      ]
    ];
    return { ok: errors.length === 0, expectedIdentity, errors };
  } catch (error) {
    return {
      ok: false,
      expectedIdentity: `sha256:${"0".repeat(64)}`,
      errors: [error instanceof Error ? error.message : String(error)]
    };
  }
};
const WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT = "bin/papercusp-remote-initializer";
const WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT = "bin/papercusp-deliver-material";
const WORKSPACE_HOST_DESKTOP_SESSION_ENTRYPOINT = "bin/papercusp-desktop-session.cjs";
const WORKSPACE_HOST_PUI_ENTRYPOINT = "bin/pui";
const WORKSPACE_HOST_PUI_COMPANION_PATH = "pui-companion.wasm";
const WORKSPACE_HOST_PUI_INSTALL_MANIFEST_PATH = "pui-install.json";
const WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS = [
  { path: WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT, executable: true },
  { path: WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT, executable: true },
  { path: WORKSPACE_HOST_DESKTOP_SESSION_ENTRYPOINT, executable: true },
  { path: WORKSPACE_HOST_PUI_ENTRYPOINT, executable: true },
  { path: WORKSPACE_HOST_PUI_COMPANION_PATH },
  { path: WORKSPACE_HOST_PUI_INSTALL_MANIFEST_PATH }
];
const MUTABLE_URL_SEGMENT = /^(?:latest|stable|current|main|master|edge|head|nightly|rolling|dev|unstable)(?:\.[A-Za-z0-9.]+)?$/i;
const FIXTURE_HOST = /(?:^|\.)(?:invalid|test|example|localhost|local|internal)$/i;
const CONTENT_ADDRESSED_DIGEST = /\/sha256\/([0-9a-fA-F]{64})(?=\/|$)/;
function urlPathname(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return "";
  }
}
const WORKSPACE_HOST_ARTIFACT_ORIGIN = "https://cupboard.papercusp.com";
const WORKSPACE_HOST_ARTIFACT_PATH_PREFIX = "/artifacts/workspace-host";
function deriveWorkspaceHostCanonicalArtifactUrls(bundleSha256, options = {}) {
  const digest = requireText(bundleSha256, "bundleSha256").toLowerCase();
  if (!SHA256_HEX.test(digest))
    throw new Error(
      "bundleSha256 must be a lowercase SHA-256 digest; canonical artifact URLs are derived from the digest and must never be defaulted"
    );
  const origin = options.origin ?? WORKSPACE_HOST_ARTIFACT_ORIGIN;
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error(`origin ${origin} must be a valid public HTTPS URL`);
  };
  if (parsedOrigin.protocol !== "https:")
    throw new Error(`origin ${origin} must use HTTPS`);
  if (FIXTURE_HOST.test(parsedOrigin.hostname))
    throw new Error(
      `origin host ${parsedOrigin.hostname} is a reserved non-resolvable name, not a publication target`
    );
  const base = `${parsedOrigin.origin}${WORKSPACE_HOST_ARTIFACT_PATH_PREFIX}/sha256/${digest}`;
  const bundleUrl = `${base}/server.tgz`;
  return {
    bundleUrl,
    signatureUrl: `${bundleUrl}.minisig`,
    manifestUrl: `${base}/manifest.json`
  };
};
function workspaceHostReleaseAddressingErrors(release, expected) {
  const errors = [];
  const expectedDigest = expected.sha256.toLowerCase();
  const subject = expected.subject ?? "the built artifact";
  errors.push(...immutableUrlErrors(release.bundleUrl, "release.bundleUrl"));
  errors.push(
    ...immutableUrlErrors(release.signatureUrl, "release.signatureUrl")
  );
  if (release.signatureUrl !== `${release.bundleUrl}.minisig`)
    errors.push(
      "release.signatureUrl must be release.bundleUrl suffixed with .minisig"
    );
  if (release.bundleUrl.length > 0) {
    const contentAddress = CONTENT_ADDRESSED_DIGEST.exec(
      urlPathname(release.bundleUrl)
    );
    if (contentAddress) {
      const addressedDigest = (contentAddress[1] ?? "").toLowerCase();
      if (addressedDigest !== expectedDigest)
        errors.push(
          `release.bundleUrl is content-addressed at ${addressedDigest}, which is not ${subject} ${expectedDigest}`
        );
    } else if (!release.bundleUrl.includes(expected.version))
      errors.push(
        `release.bundleUrl must be content-addressed under /sha256/${expectedDigest}/ or embed the release version ${expected.version} so the pin is immutable`
      );
  };
  return errors;
};
function immutableUrlErrors(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return [`${label} must be a valid public HTTPS URL`];
  };
  const errors = [];
  if (parsed.protocol !== "https:") errors.push(`${label} must use HTTPS`);
  if (FIXTURE_HOST.test(parsed.hostname))
    errors.push(
      `${label} host ${parsed.hostname} is a reserved non-resolvable name, not a publication target`
    );
  const segments = parsed.pathname.split("/").filter((part) => part.length > 0);
  const basename = segments.at(-1) ?? "";
  if (basename.length === 0)
    errors.push(`${label} must address a file, not a directory`);
  if (segments.some((segment) => MUTABLE_URL_SEGMENT.test(segment)))
    errors.push(
      `${label} must not point at a mutable release channel; pin an immutable versioned path`
    );
  return errors;
}
function verifyWorkspaceHostReleaseProvenance(manifest, release) {
  const errors = [];
  const manifestVerification = verifyWorkspaceHostBuildManifest(manifest);
  if (!manifestVerification.ok)
    errors.push(
      ...manifestVerification.errors.map(
        (error) => `manifest is not self-consistent: ${error}`
      )
    );
  const expectedDigest = manifest.releaseArtifact.sha256.toLowerCase();
  const pinnedDigest = release.bundleSha256.toLowerCase();
  if (!SHA256_HEX.test(pinnedDigest))
    errors.push("release.bundleSha256 must be a lowercase SHA-256 digest");
  else if (pinnedDigest !== expectedDigest)
    errors.push(
      `release.bundleSha256 ${pinnedDigest} does not match the built artifact ${expectedDigest}`
    );
  if (release.version !== manifest.releaseArtifact.version)
    errors.push(
      `release.version ${release.version} does not match the built artifact version ${manifest.releaseArtifact.version}`
    );
  errors.push(
    ...workspaceHostReleaseAddressingErrors(release, {
      sha256: expectedDigest,
      version: manifest.releaseArtifact.version
    })
  );
  for (const required of WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS) {
    const material = manifest.materials.find(
      (candidate) => candidate.path === required.path
    );
    if (!material) {
      errors.push(`materials must include required release material ${required.path}`);
      continue;
    };
    if (material.sizeBytes === 0)
      errors.push(`${required.path} must be non-empty`);
    if (required.executable === true && material.executable !== true)
      errors.push(`${required.path} must be marked executable`);
  };
  return { ok: errors.length === 0, errors };
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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VUFBVSxTQUFTLFNBQVM7QUFBQSxJQUM3QztBQUNBLFFBQUksQ0FBQyxVQUFVO0FBQ2IsYUFBTyxLQUFLLG9EQUFvRCxTQUFTLElBQUksRUFBRTtBQUMvRTtBQUFBLElBQ0Y7QUFDQSxRQUFJLFNBQVMsY0FBYztBQUN6QixhQUFPLEtBQUssR0FBRyxTQUFTLElBQUksb0JBQW9CO0FBQ2xELFFBQUksU0FBUyxlQUFlLFFBQVEsU0FBUyxlQUFlO0FBQzFELGFBQU8sS0FBSyxHQUFHLFNBQVMsSUFBSSw0QkFBNEI7QUFBQSxFQUM1RDtBQUVBLFNBQU8sRUFBRSxJQUFJLE9BQU8sV0FBVyxHQUFHLE9BQU87QUFDM0MiLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbIndvcmtzcGFjZS1ob3N0LWJ1aWxkLW1hbmlmZXN0LnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcblxuaW1wb3J0IHsgY2Fub25pY2FsaXplIH0gZnJvbSBcIkBwYXBlcmN1c3AvcHVibGlzaC1hdXRoL2pjc1wiO1xuXG5pbXBvcnQgdHlwZSB7IFdvcmtzcGFjZUhvc3RQcm92aWRlclRhcmdldCB9IGZyb20gXCIuL3dvcmtzcGFjZS1ob3N0LXR5cGVzXCI7XG5cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9CVUlMRF9JTlBVVF9DT05UUkFDVF9WRVJTSU9OID1cbiAgXCJwYXBlcmN1c3Atd29ya3NwYWNlLWhvc3QtYnVpbGQtaW5wdXQtdjFcIjtcbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9CVUlMRF9NQU5JRkVTVF9TQ0hFTUFfVkVSU0lPTiA9IDE7XG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfUEFDS0VSX0JVSUxERVJfS0lORCA9IFwiaGFzaGljb3JwLXBhY2tlclwiO1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX1NJREVDQVJfQlVJTERFUl9LSU5EID1cbiAgXCJwYXBlcmN1c3AtZGVza3RvcC1zaWRlY2FyXCI7XG4vKipcbiAqIFAtMzA3IC8gRC0yNTQg4oCUIHRoZSBib290YyBwcm9kdWNlci4gT25lIE9DSSBpbWFnZSBpcyBidWlsdCBvbmNlLCB0aGVuXG4gKiBgYm9vdGMtaW1hZ2UtYnVpbGRlcmAgcmVuZGVycyBpdCB0byBlYWNoIGNsb3VkJ3MgZGlzayBmb3JtYXQgKGdjZSAvIGFtaSAvIHZoZCksIHNvIHRoZVxuICogcGVyLWNsb3VkIEJBS0UgcGF0aHMgY29sbGFwc2UgdG8gb25lIHdoaWxlIHRoZSBwZXItY2xvdWQgUFVCTElTSCBhZGFwdGVycyBzdGF5IGFzIHRoZXlcbiAqIGFyZSAoZWFjaCBjbG91ZCdzIGltYWdlIHJlZ2lzdHJ5IGdlbnVpbmVseSBkaWZmZXJzLCBhbmQgRC0yNTMga2VlcHMgdGhlbSkuXG4gKlxuICogSXRzIGB0ZW1wbGF0ZVBhdGhgIG5hbWVzIGEgQ29udGFpbmVyZmlsZSwgbm90IGEgYC5wa3IuaGNsYCDigJQgc2VlXG4gKiBXT1JLU1BBQ0VfSE9TVF9CVUlMREVSX1RFTVBMQVRFX1NIQVBFUywgd2hpY2ggaXMgd2hhdCBrZWVwcyBhIGJ1aWxkZXIga2luZCBhbmQgdGhlXG4gKiB0ZW1wbGF0ZSBmaWxlIGl0IGlzIGhhbmRlZCBmcm9tIGRyaWZ0aW5nIGFwYXJ0LlxuICovXG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfQk9PVENfQlVJTERFUl9LSU5EID0gXCJib290Yy1pbWFnZS1idWlsZGVyXCI7XG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfQlVJTERFUl9LSU5EUyA9IFtcbiAgV09SS1NQQUNFX0hPU1RfUEFDS0VSX0JVSUxERVJfS0lORCxcbiAgV09SS1NQQUNFX0hPU1RfU0lERUNBUl9CVUlMREVSX0tJTkQsXG4gIFdPUktTUEFDRV9IT1NUX0JPT1RDX0JVSUxERVJfS0lORCxcbl0gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBXb3Jrc3BhY2VIb3N0QnVpbGRlcktpbmQgPVxuICAodHlwZW9mIFdPUktTUEFDRV9IT1NUX0JVSUxERVJfS0lORFMpW251bWJlcl07XG5cbi8qKiBCYWNrd2FyZC1jb21wYXRpYmxlIG5hbWUgZm9yIHRoZSBELTA0NyBWTS1pbWFnZSBidWlsZGVyLiAqL1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX1NIQVJFRF9CVUlMREVSX0tJTkQgPVxuICBXT1JLU1BBQ0VfSE9TVF9QQUNLRVJfQlVJTERFUl9LSU5EO1xuXG4vKipcbiAqIFdoYXQgYSBnaXZlbiBidWlsZGVyIGtpbmQncyBgdGVtcGxhdGVQYXRoYCBtdXN0IExPT0sgbGlrZSwgYW5kIHdoaWNoIGtpbmRzIG1heSBwcm9kdWNlIGFcbiAqIFZNIGltYWdlIGF0IGFsbC4gS2VwdCBiZXNpZGUgdGhlIGtpbmRzIHRoZW1zZWx2ZXMgc28gdGhlIHR3byBjYW5ub3QgZHJpZnQ6IGFkZGluZyBhIGtpbmRcbiAqIHdpdGhvdXQgZGVjaWRpbmcgaXRzIHRlbXBsYXRlIHNoYXBlIGlzIGEgdHlwZSBlcnJvciwgbm90IGEgcnVudGltZSBzdXJwcmlzZS5cbiAqXG4gKiBUaGlzIHRhYmxlIGV4aXN0cyBiZWNhdXNlIHRoZSBmaWVsZCB1c2VkIHRvIGJlIHN0b3JlZCBhbmQgbmV2ZXIgcmVhZC4gQSBtYW5pZmVzdCBuYW1pbmdcbiAqIHRoZSBkZXNrdG9wLXNpZGVjYXIgYnVpbGRlciDigJQgd2hvc2UgXCJ0ZW1wbGF0ZVwiIGlzIGEgYmFzaCBzY3JpcHQg4oCUIHBhc3NlZCBldmVyeSBnYXRlIGFuZFxuICogZGllZCBsYXRlciBhdCBgcGFja2VyIGluaXRgLCB3aXRoIGFuIGVycm9yIG5hbWluZyBQYWNrZXIgcmF0aGVyIHRoYW4gdGhlIG1hbmlmZXN0IGZpZWxkXG4gKiB0aGF0IGNob3NlIHRoZSBmaWxlIChFSS0yMTc1MDY1MzIyMDE2OTgzNjsgdGhlIHI4IHdvcmtzcGFjZS1ob3N0IGFydGlmYWN0IHNoaXBwZWQgZXhhY3RseVxuICogdGhhdCB3YXkpLiBUaGUgcG9pbnQgaXMgdG8gcmVmdXNlIHRoZSBtYW5pZmVzdCBCRUZPUkUgYW55dGhpbmcgYmlsbGFibGUgcnVucywgbmFtaW5nIHRoZVxuICogZmllbGQgdGhhdCBpcyBhY3R1YWxseSB3cm9uZy5cbiAqXG4gKiBgaW1hZ2VGYW1pbHlFbGlnaWJsZTogZmFsc2VgIHN0aWxsIGdldHMgYSBzaGFwZSwgZGVsaWJlcmF0ZWx5OiB0aGUgc2lkZWNhciBidW5kbGUgaXMgYVxuICogcmVhbCBidWlsZGVyIHdpdGggYSByZWFsIHRlbXBsYXRlLCBpdCBzaW1wbHkgbWF5IG5vdCBjdXQgYSBWTSBpbWFnZS4gRW5jb2RpbmcgdGhhdCBhcyBhXG4gKiBtaXNzaW5nIGVudHJ5IHdvdWxkIG1ha2UgXCJ1bmtub3duIGtpbmRcIiBhbmQgXCJrbm93biBraW5kLCB3cm9uZyBqb2JcIiBpbmRpc3Rpbmd1aXNoYWJsZSDigJRcbiAqIHRoZSBzYW1lIGNvbGxhcHNlLXR3by1jYXVzZXMtaW50by1vbmUtbWVzc2FnZSBkZWZlY3QgdGhpcyB0YWJsZSBpcyBoZXJlIHRvIHByZXZlbnQuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdEJ1aWxkZXJUZW1wbGF0ZVNoYXBlIHtcbiAgLyoqIE1hdGNoZXMgdGhlIHRlbXBsYXRlUGF0aCBhIGJ1aWxkIG9mIHRoaXMga2luZCBpcyBoYW5kZWQuICovXG4gIHJlYWRvbmx5IHBhdHRlcm46IFJlZ0V4cDtcbiAgLyoqIEh1bWFuIGRlc2NyaXB0aW9uIG9mIHRoZSBhY2NlcHRlZCBzaGFwZSwgZm9yIHRoZSByZWZ1c2FsIG1lc3NhZ2UuICovXG4gIHJlYWRvbmx5IGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gIC8qKiBXaGV0aGVyIHRoaXMga2luZCBtYXkgcHJvZHVjZSBhIHdvcmtzcGFjZS1ob3N0IFZNIGltYWdlIHJlbGVhc2UuICovXG4gIHJlYWRvbmx5IGltYWdlRmFtaWx5RWxpZ2libGU6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9CVUlMREVSX1RFTVBMQVRFX1NIQVBFUzogUmVhZG9ubHk8XG4gIFJlY29yZDxXb3Jrc3BhY2VIb3N0QnVpbGRlcktpbmQsIFdvcmtzcGFjZUhvc3RCdWlsZGVyVGVtcGxhdGVTaGFwZT5cbj4gPSB7XG4gIFtXT1JLU1BBQ0VfSE9TVF9QQUNLRVJfQlVJTERFUl9LSU5EXToge1xuICAgIHBhdHRlcm46IC9cXC5wa3JcXC4oaGNsfGpzb24pJC8sXG4gICAgZGVzY3JpcHRpb246IFwiYSBQYWNrZXIgdGVtcGxhdGUgKC5wa3IuaGNsIG9yIC5wa3IuanNvbilcIixcbiAgICBpbWFnZUZhbWlseUVsaWdpYmxlOiB0cnVlLFxuICB9LFxuICBbV09SS1NQQUNFX0hPU1RfQk9PVENfQlVJTERFUl9LSU5EXToge1xuICAgIC8vIGJvb3RjLWltYWdlLWJ1aWxkZXIgY29uc3VtZXMgYW4gT0NJIGltYWdlIGJ1aWx0IGZyb20gYSBDb250YWluZXJmaWxlOyB0aGUgbWFuaWZlc3RcbiAgICAvLyBwaW5zIHRoZSBDb250YWluZXJmaWxlIGJlY2F1c2UgdGhhdCBpcyB0aGUgaW4tcmVwbywgY29udGVudC1hZGRyZXNzYWJsZSBpbnB1dC5cbiAgICBwYXR0ZXJuOiAvKF58XFwvKVteL10qQ29udGFpbmVyZmlsZSQvLFxuICAgIGRlc2NyaXB0aW9uOiBcImEgQ29udGFpbmVyZmlsZVwiLFxuICAgIGltYWdlRmFtaWx5RWxpZ2libGU6IHRydWUsXG4gIH0sXG4gIFtXT1JLU1BBQ0VfSE9TVF9TSURFQ0FSX0JVSUxERVJfS0lORF06IHtcbiAgICBwYXR0ZXJuOiAvXFwuKHNofG1qc3x0cykkLyxcbiAgICBkZXNjcmlwdGlvbjogXCJhIHNpZGVjYXIgYnVpbGQgc2NyaXB0ICguc2gsIC5tanMgb3IgLnRzKVwiLFxuICAgIGltYWdlRmFtaWx5RWxpZ2libGU6IGZhbHNlLFxuICB9LFxufTtcblxuLyoqXG4gKiBUaGUgYnVpbGRlciBraW5kcyB0aGF0IG1heSBjdXQgYSB3b3Jrc3BhY2UtaG9zdCBWTSBpbWFnZSByZWxlYXNlLCBkZXJpdmVkIGZyb20gdGhlIHRhYmxlXG4gKiBhYm92ZSByYXRoZXIgdGhhbiByZXN0YXRlZCDigJQgYSBzZWNvbmQgaGFuZC1tYWludGFpbmVkIGxpc3QgaXMgaG93IHRoZSB0d28gZGlzYWdyZWUuXG4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9JTUFHRV9GQU1JTFlfQlVJTERFUl9LSU5EUzogcmVhZG9ubHkgV29ya3NwYWNlSG9zdEJ1aWxkZXJLaW5kW10gPVxuICBXT1JLU1BBQ0VfSE9TVF9CVUlMREVSX0tJTkRTLmZpbHRlcihcbiAgICAoa2luZCkgPT4gV09SS1NQQUNFX0hPU1RfQlVJTERFUl9URU1QTEFURV9TSEFQRVNba2luZF0uaW1hZ2VGYW1pbHlFbGlnaWJsZSxcbiAgKTtcblxuZXhwb3J0IHR5cGUgV29ya3NwYWNlSG9zdEJ1aWxkUGFyYW1ldGVyVmFsdWUgPSBzdHJpbmcgfCBudW1iZXIgfCBib29sZWFuO1xuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RCdWlsZE1hdGVyaWFsIHtcbiAgLyoqIFJlcG9zaXRvcnktcmVsYXRpdmUgUE9TSVggcGF0aC4gQWJzb2x1dGUgcGF0aHMgYW5kIHRyYXZlcnNhbCBhcmUgcmVmdXNlZC4gKi9cbiAgcmVhZG9ubHkgcGF0aDogc3RyaW5nO1xuICByZWFkb25seSBzaGEyNTY6IHN0cmluZztcbiAgcmVhZG9ubHkgc2l6ZUJ5dGVzOiBudW1iZXI7XG4gIHJlYWRvbmx5IGV4ZWN1dGFibGU/OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RCdWlsZFBhcmFtZXRlciB7XG4gIHJlYWRvbmx5IG5hbWU6IHN0cmluZztcbiAgLyoqIEJ1aWxkLXNoYXBpbmcsIG5vbi1zZWNyZXQgdmFsdWUuIFNlY3JldC1zaGFwZWQgcGFyYW1ldGVyIG5hbWVzIGFyZSByZWZ1c2VkLiAqL1xuICByZWFkb25seSB2YWx1ZTogV29ya3NwYWNlSG9zdEJ1aWxkUGFyYW1ldGVyVmFsdWU7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdEJ1aWxkVGFyZ2V0IHtcbiAgcmVhZG9ubHkgcHJvdmlkZXI6IFdvcmtzcGFjZUhvc3RQcm92aWRlclRhcmdldDtcbiAgLyoqIFByb3ZpZGVyIGxvY2F0aW9ucyByZWNlaXZpbmcgaWRlbnRpY2FsIGJ1aWx0IGJ5dGVzLiBFbXB0eSBtZWFucyBwcm92aWRlci1nbG9iYWwuICovXG4gIHJlYWRvbmx5IGxvY2F0aW9uczogcmVhZG9ubHkgc3RyaW5nW107XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdEJ1aWxkTWFuaWZlc3RJbnB1dCB7XG4gIHJlYWRvbmx5IGNvbnRyYWN0VmVyc2lvbjogdHlwZW9mIFdPUktTUEFDRV9IT1NUX0JVSUxEX0lOUFVUX0NPTlRSQUNUX1ZFUlNJT047XG4gIHJlYWRvbmx5IGRpc3RyaWJ1dGlvblByb2ZpbGU6IFwidm0tcmVsZWFzZVwiO1xuICByZWFkb25seSBzb3VyY2U6IHtcbiAgICByZWFkb25seSByZXBvc2l0b3J5OiBzdHJpbmc7XG4gICAgLyoqIEltbXV0YWJsZSBHaXQgb2JqZWN0IGlkZW50aXR5IChTSEEtMSBvciBTSEEtMjU2IHJlcG9zaXRvcnkgZm9ybWF0KS4gKi9cbiAgICByZWFkb25seSByZXZpc2lvbjogc3RyaW5nO1xuICB9O1xuICByZWFkb25seSByZWxlYXNlQXJ0aWZhY3Q6IHtcbiAgICByZWFkb25seSBuYW1lOiBzdHJpbmc7XG4gICAgcmVhZG9ubHkgdmVyc2lvbjogc3RyaW5nO1xuICAgIHJlYWRvbmx5IHNoYTI1Njogc3RyaW5nO1xuICAgIHJlYWRvbmx5IHNpemVCeXRlczogbnVtYmVyO1xuICB9O1xuICByZWFkb25seSBiYXNlSW1hZ2U6IHtcbiAgICByZWFkb25seSByZWZlcmVuY2U6IHN0cmluZztcbiAgICByZWFkb25seSBhcmNoaXRlY3R1cmU6IHN0cmluZztcbiAgICByZWFkb25seSBzaGEyNTY6IHN0cmluZztcbiAgfTtcbiAgcmVhZG9ubHkgYnVpbGRlcjoge1xuICAgIHJlYWRvbmx5IHN0cmF0ZWd5OiBcInNoYXJlZFwiO1xuICAgIHJlYWRvbmx5IGtpbmQ6IFdvcmtzcGFjZUhvc3RCdWlsZGVyS2luZDtcbiAgICByZWFkb25seSB2ZXJzaW9uOiBzdHJpbmc7XG4gICAgcmVhZG9ubHkgdGVtcGxhdGVQYXRoOiBzdHJpbmc7XG4gICAgcmVhZG9ubHkgdGVtcGxhdGVTaGEyNTY6IHN0cmluZztcbiAgfTtcbiAgcmVhZG9ubHkgbWF0ZXJpYWxzOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0QnVpbGRNYXRlcmlhbFtdO1xuICByZWFkb25seSBwYXJhbWV0ZXJzOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0QnVpbGRQYXJhbWV0ZXJbXTtcbiAgcmVhZG9ubHkgdGFyZ2V0czogcmVhZG9ubHkgV29ya3NwYWNlSG9zdEJ1aWxkVGFyZ2V0W107XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdEJ1aWxkTWFuaWZlc3RQYXlsb2FkIGV4dGVuZHMgV29ya3NwYWNlSG9zdEJ1aWxkTWFuaWZlc3RJbnB1dCB7XG4gIHJlYWRvbmx5IHNjaGVtYVZlcnNpb246IHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9CVUlMRF9NQU5JRkVTVF9TQ0hFTUFfVkVSU0lPTjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdCBleHRlbmRzIFdvcmtzcGFjZUhvc3RCdWlsZE1hbmlmZXN0UGF5bG9hZCB7XG4gIC8qKiBTSEEtMjU2IG92ZXIgUkZDIDg3ODUgY2Fub25pY2FsIEpTT04gb2YgdGhlIG5vcm1hbGl6ZWQgcGF5bG9hZCwgZXhjbHVkaW5nIHRoaXMgZmllbGQuICovXG4gIHJlYWRvbmx5IG1hbmlmZXN0SWRlbnRpdHk6IGBzaGEyNTY6JHtzdHJpbmd9YDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdFZlcmlmaWNhdGlvbiB7XG4gIHJlYWRvbmx5IG9rOiBib29sZWFuO1xuICByZWFkb25seSBleHBlY3RlZElkZW50aXR5OiBgc2hhMjU2OiR7c3RyaW5nfWA7XG4gIHJlYWRvbmx5IGVycm9yczogcmVhZG9ubHkgc3RyaW5nW107XG59XG5cbmV4cG9ydCBjbGFzcyBXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIldvcmtzcGFjZUhvc3RCdWlsZE1hbmlmZXN0RXJyb3JcIjtcbiAgfVxufVxuXG5jb25zdCBTSEEyNTZfSEVYID0gL15bYS1mMC05XXs2NH0kLztcbmNvbnN0IEdJVF9SRVZJU0lPTiA9IC9eKD86W2EtZjAtOV17NDB9fFthLWYwLTldezY0fSkkLztcbmNvbnN0IFNFQ1JFVF9QQVJBTUVURVIgPVxuICAvKD86XnxbLV8uXSkoY3JlZGVudGlhbHxwYXNzd29yZHxwcml2YXRlWy1fXT9rZXl8c2VjcmV0fHRva2VuKSg/OiR8Wy1fLl0pL2k7XG4vKipcbiAqIEdDUCBpbWFnZSByZWZlcmVuY2VzIGFyZSBwcm92aWRlciByZXNvdXJjZXMsIG5vdCBndWVzdC1sb2NhbCBsYWJlbHMgb3IgcGF0aHMuIEtlZXAgdGhpc1xuICogdmFsaWRhdG9yIGxvY2FsIHRvIHRoZSBwcm92aWRlci1uZXV0cmFsIG1hbmlmZXN0IHBhY2thZ2Ugc28gdGhlIHJlbGVhc2UgZ2F0ZSByZWplY3RzIGFcbiAqIG5vbi1pbWFnZSB2YWx1ZSBiZWZvcmUgYSBwcm92aWRlciBhZGFwdGVyIChvciBhIGJpbGxhYmxlIGJ1aWxkKSBpcyByZWFjaGVkLlxuICovXG5jb25zdCBHQ1BfSU1NVVRBQkxFX0lNQUdFX1JFRkVSRU5DRSA9XG4gIC9ecHJvamVjdHNcXC9bYS16XVthLXowLTktXXs0LDI4fVthLXowLTldXFwvZ2xvYmFsXFwvaW1hZ2VzXFwvW2Etel0oPzpbLWEtejAtOV17MCw2MX1bYS16MC05XSk/JC87XG5jb25zdCBPQ0lfSU1BR0VfUkVGRVJFTkNFID1cbiAgL15bYS16MC05XVthLXowLTkuXy1dKig/OjpcXGR7MSw1fSk/KD86XFwvW2EtejAtOV1bYS16MC05Ll8tXSopKyg/OjpbQS1aYS16MC05XVtBLVphLXowLTkuXy1dezAsMTI3fSk/JC87XG5cbi8qKlxuICogTWF0ZXJpYWwgcGF0aHMgdGhhdCBuYW1lIHNlY3JldCBrZXkgbWF0ZXJpYWwuIFRoZSBtYW5pZmVzdCBpcyBwdWJsaXNoZWQgYmVzaWRlIHRoZSBhcnRpZmFjdCBpdFxuICogZGVzY3JpYmVzLCBzbyBlbnVtZXJhdGluZyBhIHByaXZhdGUga2V5IGhlcmUgbGVha3MgaXRzIGV4aXN0ZW5jZSBhbmQgbG9jYXRpb24gZXZlbiB3aGVuIHRoZVxuICogYnl0ZXMgbmV2ZXIgbGVhdmUgdGhlIGJ1aWxkZXIuXG4gKlxuICogRGVsaWJlcmF0ZWx5IG5hcnJvd2VyIHRoYW4gXCJjb250YWlucyB0aGUgd29yZCBrZXlcIjogYSBtaW5pc2lnbiBQVUJMSUMga2V5IChgLnB1YmApIGlzIGFcbiAqIHJlcXVpcmVkIHBhcnQgb2YgYSB2ZXJpZmlhYmxlIHJlbGVhc2UgYW5kIG11c3Qga2VlcCBwYXNzaW5nLlxuICovXG5jb25zdCBTRUNSRVRfTUFURVJJQUwgPVxuICAvKD86XnxbL18uLV0pKD86cHJpdmF0ZVstXy5dP2tleXxzZWNyZXR8c2VjcmV0c3xjcmVkZW50aWFsfGNyZWRlbnRpYWxzfHBhc3N3b3JkfHBhc3N3ZHx0b2tlbnxpZF9yc2F8aWRfZWNkc2F8aWRfZWQyNTUxOSkoPzokfFsvXy4tXSl8XFwuKD86cGVtfGtleXxwMTJ8cGZ4fGprc3xrZXlzdG9yZSkkL2k7XG5cbmZ1bmN0aW9uIGNvbXBhcmVUZXh0KGxlZnQ6IHN0cmluZywgcmlnaHQ6IHN0cmluZyk6IG51bWJlciB7XG4gIHJldHVybiBsZWZ0IDwgcmlnaHQgPyAtMSA6IGxlZnQgPiByaWdodCA/IDEgOiAwO1xufVxuXG5mdW5jdGlvbiByZXF1aXJlVGV4dCh2YWx1ZTogc3RyaW5nLCBwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAodmFsdWUudHJpbSgpLmxlbmd0aCA9PT0gMClcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEJ1aWxkTWFuaWZlc3RFcnJvcihcbiAgICAgIGAke3BhdGh9IG11c3QgYmUgYSBub24tZW1wdHkgc3RyaW5nYCxcbiAgICApO1xuICByZXR1cm4gdmFsdWU7XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVTaGEyNTYodmFsdWU6IHN0cmluZywgcGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCFTSEEyNTZfSEVYLnRlc3QodmFsdWUpKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RCdWlsZE1hbmlmZXN0RXJyb3IoXG4gICAgICBgJHtwYXRofSBtdXN0IGJlIGEgbG93ZXJjYXNlIDY0LWNoYXJhY3RlciBTSEEtMjU2IGhleCBkaWdlc3RgLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG5mdW5jdGlvbiByZXF1aXJlU2l6ZSh2YWx1ZTogbnVtYmVyLCBwYXRoOiBzdHJpbmcpOiBudW1iZXIge1xuICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKHZhbHVlKSB8fCB2YWx1ZSA8IDApIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEJ1aWxkTWFuaWZlc3RFcnJvcihcbiAgICAgIGAke3BhdGh9IG11c3QgYmUgYSBub24tbmVnYXRpdmUgc2FmZSBpbnRlZ2VyYCxcbiAgICApO1xuICB9XG4gIHJldHVybiB2YWx1ZTtcbn1cblxuZnVuY3Rpb24gcmVxdWlyZVJlbGF0aXZlUGF0aCh2YWx1ZTogc3RyaW5nLCBwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXF1aXJlVGV4dCh2YWx1ZSwgcGF0aCk7XG4gIGNvbnN0IHNlZ21lbnRzID0gdmFsdWUuc3BsaXQoXCIvXCIpO1xuICBpZiAoXG4gICAgdmFsdWUuc3RhcnRzV2l0aChcIi9cIikgfHxcbiAgICB2YWx1ZS5pbmNsdWRlcyhcIlxcXFxcIikgfHxcbiAgICBzZWdtZW50cy5zb21lKFxuICAgICAgKHNlZ21lbnQpID0+IHNlZ21lbnQgPT09IFwiXCIgfHwgc2VnbWVudCA9PT0gXCIuXCIgfHwgc2VnbWVudCA9PT0gXCIuLlwiLFxuICAgIClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RCdWlsZE1hbmlmZXN0RXJyb3IoXG4gICAgICBgJHtwYXRofSBtdXN0IGJlIGEgbm9ybWFsaXplZCByZXBvc2l0b3J5LXJlbGF0aXZlIFBPU0lYIHBhdGhgLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBhc3NlcnRVbmlxdWUodmFsdWVzOiByZWFkb25seSBzdHJpbmdbXSwgcGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCB2YWx1ZSBvZiB2YWx1ZXMpIHtcbiAgICBpZiAoc2Vlbi5oYXModmFsdWUpKVxuICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RCdWlsZE1hbmlmZXN0RXJyb3IoXG4gICAgICAgIGAke3BhdGh9IGNvbnRhaW5zIGR1cGxpY2F0ZSAnJHt2YWx1ZX0nYCxcbiAgICAgICk7XG4gICAgc2Vlbi5hZGQodmFsdWUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU1hdGVyaWFscyhcbiAgbWF0ZXJpYWxzOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0QnVpbGRNYXRlcmlhbFtdLFxuKTogV29ya3NwYWNlSG9zdEJ1aWxkTWF0ZXJpYWxbXSB7XG4gIGlmIChtYXRlcmlhbHMubGVuZ3RoID09PSAwKVxuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdEVycm9yKFxuICAgICAgXCJtYXRlcmlhbHMgbXVzdCBjb250YWluIGF0IGxlYXN0IG9uZSBidWlsZCBpbnB1dFwiLFxuICAgICk7XG4gIG1hdGVyaWFscy5mb3JFYWNoKChtYXRlcmlhbCwgaW5kZXgpID0+IHtcbiAgICBpZiAodHlwZW9mIG1hdGVyaWFsLnBhdGggPT09IFwic3RyaW5nXCIgJiYgU0VDUkVUX01BVEVSSUFMLnRlc3QobWF0ZXJpYWwucGF0aCkpXG4gICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEJ1aWxkTWFuaWZlc3RFcnJvcihcbiAgICAgICAgYG1hdGVyaWFsc1ske2luZGV4fV0ucGF0aCAke21hdGVyaWFsLnBhdGh9IG5hbWVzIHNlY3JldCBrZXkgbWF0ZXJpYWwsIHdoaWNoIG11c3QgbmV2ZXIgYmUgZW51bWVyYXRlZCBpbiBhIHB1Ymxpc2hlZCBtYW5pZmVzdGAsXG4gICAgICApO1xuICB9KTtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IG1hdGVyaWFscy5tYXAoKG1hdGVyaWFsLCBpbmRleCkgPT4gKHtcbiAgICBwYXRoOiByZXF1aXJlUmVsYXRpdmVQYXRoKG1hdGVyaWFsLnBhdGgsIGBtYXRlcmlhbHNbJHtpbmRleH1dLnBhdGhgKSxcbiAgICBzaGEyNTY6IHJlcXVpcmVTaGEyNTYobWF0ZXJpYWwuc2hhMjU2LCBgbWF0ZXJpYWxzWyR7aW5kZXh9XS5zaGEyNTZgKSxcbiAgICBzaXplQnl0ZXM6IHJlcXVpcmVTaXplKG1hdGVyaWFsLnNpemVCeXRlcywgYG1hdGVyaWFsc1ske2luZGV4fV0uc2l6ZUJ5dGVzYCksXG4gICAgLi4uKG1hdGVyaWFsLmV4ZWN1dGFibGUgPT09IHVuZGVmaW5lZFxuICAgICAgPyB7fVxuICAgICAgOiB7IGV4ZWN1dGFibGU6IG1hdGVyaWFsLmV4ZWN1dGFibGUgfSksXG4gIH0pKTtcbiAgYXNzZXJ0VW5pcXVlKFxuICAgIG5vcm1hbGl6ZWQubWFwKChtYXRlcmlhbCkgPT4gbWF0ZXJpYWwucGF0aCksXG4gICAgXCJtYXRlcmlhbHNcIixcbiAgKTtcbiAgcmV0dXJuIG5vcm1hbGl6ZWQuc29ydCgobGVmdCwgcmlnaHQpID0+IGNvbXBhcmVUZXh0KGxlZnQucGF0aCwgcmlnaHQucGF0aCkpO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQYXJhbWV0ZXJzKFxuICBwYXJhbWV0ZXJzOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0QnVpbGRQYXJhbWV0ZXJbXSxcbik6IFdvcmtzcGFjZUhvc3RCdWlsZFBhcmFtZXRlcltdIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IHBhcmFtZXRlcnMubWFwKChwYXJhbWV0ZXIsIGluZGV4KSA9PiB7XG4gICAgY29uc3QgbmFtZSA9IHJlcXVpcmVUZXh0KHBhcmFtZXRlci5uYW1lLCBgcGFyYW1ldGVyc1ske2luZGV4fV0ubmFtZWApO1xuICAgIGlmIChTRUNSRVRfUEFSQU1FVEVSLnRlc3QobmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdEVycm9yKFxuICAgICAgICBgcGFyYW1ldGVyc1ske2luZGV4fV0ubmFtZSAnJHtuYW1lfScgaXMgc2VjcmV0LXNoYXBlZCBhbmQgY2Fubm90IGVudGVyIHRoZSBtYW5pZmVzdGAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoXG4gICAgICB0eXBlb2YgcGFyYW1ldGVyLnZhbHVlID09PSBcIm51bWJlclwiICYmXG4gICAgICAhTnVtYmVyLmlzRmluaXRlKHBhcmFtZXRlci52YWx1ZSlcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdEVycm9yKFxuICAgICAgICBgcGFyYW1ldGVyc1ske2luZGV4fV0udmFsdWUgbXVzdCBiZSBmaW5pdGVgLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgbmFtZSwgdmFsdWU6IHBhcmFtZXRlci52YWx1ZSB9O1xuICB9KTtcbiAgYXNzZXJ0VW5pcXVlKFxuICAgIG5vcm1hbGl6ZWQubWFwKChwYXJhbWV0ZXIpID0+IHBhcmFtZXRlci5uYW1lKSxcbiAgICBcInBhcmFtZXRlcnNcIixcbiAgKTtcbiAgcmV0dXJuIG5vcm1hbGl6ZWQuc29ydCgobGVmdCwgcmlnaHQpID0+IGNvbXBhcmVUZXh0KGxlZnQubmFtZSwgcmlnaHQubmFtZSkpO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVUYXJnZXRzKFxuICB0YXJnZXRzOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0QnVpbGRUYXJnZXRbXSxcbik6IFdvcmtzcGFjZUhvc3RCdWlsZFRhcmdldFtdIHtcbiAgaWYgKHRhcmdldHMubGVuZ3RoID09PSAwKVxuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdEVycm9yKFxuICAgICAgXCJ0YXJnZXRzIG11c3QgY29udGFpbiBhdCBsZWFzdCBvbmUgcHJvdmlkZXJcIixcbiAgICApO1xuICBjb25zdCBub3JtYWxpemVkID0gdGFyZ2V0cy5tYXAoKHRhcmdldCwgaW5kZXgpID0+IHtcbiAgICBjb25zdCBwcm92aWRlciA9IHJlcXVpcmVUZXh0KHRhcmdldC5wcm92aWRlciwgYHRhcmdldHNbJHtpbmRleH1dLnByb3ZpZGVyYCk7XG4gICAgY29uc3QgbG9jYXRpb25zID0gdGFyZ2V0LmxvY2F0aW9ucy5tYXAoKGxvY2F0aW9uLCBsb2NhdGlvbkluZGV4KSA9PlxuICAgICAgcmVxdWlyZVRleHQobG9jYXRpb24sIGB0YXJnZXRzWyR7aW5kZXh9XS5sb2NhdGlvbnNbJHtsb2NhdGlvbkluZGV4fV1gKSxcbiAgICApO1xuICAgIGFzc2VydFVuaXF1ZShsb2NhdGlvbnMsIGB0YXJnZXRzWyR7aW5kZXh9XS5sb2NhdGlvbnNgKTtcbiAgICByZXR1cm4geyBwcm92aWRlciwgbG9jYXRpb25zOiBbLi4ubG9jYXRpb25zXS5zb3J0KGNvbXBhcmVUZXh0KSB9O1xuICB9KTtcbiAgYXNzZXJ0VW5pcXVlKFxuICAgIG5vcm1hbGl6ZWQubWFwKCh0YXJnZXQpID0+IHRhcmdldC5wcm92aWRlciksXG4gICAgXCJ0YXJnZXRzXCIsXG4gICk7XG4gIHJldHVybiBub3JtYWxpemVkLnNvcnQoKGxlZnQsIHJpZ2h0KSA9PlxuICAgIGNvbXBhcmVUZXh0KGxlZnQucHJvdmlkZXIsIHJpZ2h0LnByb3ZpZGVyKSxcbiAgKTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQmFzZUltYWdlUmVmZXJlbmNlKFxuICByZWZlcmVuY2U6IHN0cmluZyxcbiAgdGFyZ2V0czogcmVhZG9ubHkgV29ya3NwYWNlSG9zdEJ1aWxkVGFyZ2V0W10sXG4gIGJ1aWxkZXJLaW5kOiBXb3Jrc3BhY2VIb3N0QnVpbGRlcktpbmQsXG4pOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gcmVxdWlyZVRleHQocmVmZXJlbmNlLCBcImJhc2VJbWFnZS5yZWZlcmVuY2VcIik7XG4gIGlmIChidWlsZGVyS2luZCA9PT0gV09SS1NQQUNFX0hPU1RfQk9PVENfQlVJTERFUl9LSU5EKSB7XG4gICAgaWYgKCFPQ0lfSU1BR0VfUkVGRVJFTkNFLnRlc3Qobm9ybWFsaXplZCkpIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdEVycm9yKFxuICAgICAgICBcImJhc2VJbWFnZS5yZWZlcmVuY2UgbXVzdCBiZSBhIHJlZ2lzdHJ5LXF1YWxpZmllZCBPQ0kgaW1hZ2UgcmVmZXJlbmNlIGZvciBib290Yy1pbWFnZS1idWlsZGVyXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gbm9ybWFsaXplZDtcbiAgfVxuICBpZiAoXG4gICAgdGFyZ2V0cy5zb21lKCh0YXJnZXQpID0+IHRhcmdldC5wcm92aWRlciA9PT0gXCJnY3BcIikgJiZcbiAgICAhR0NQX0lNTVVUQUJMRV9JTUFHRV9SRUZFUkVOQ0UudGVzdChub3JtYWxpemVkKVxuICApIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEJ1aWxkTWFuaWZlc3RFcnJvcihcbiAgICAgIFwiYmFzZUltYWdlLnJlZmVyZW5jZSBtdXN0IGJlIGFuIGltbXV0YWJsZSBwcm9qZWN0cy97cHJvamVjdH0vZ2xvYmFsL2ltYWdlcy97bmFtZX0gcmVmZXJlbmNlIHdoZW4gYSBnY3AgdGFyZ2V0IGlzIHByZXNlbnQ7IGZhbWlseSBhbGlhc2VzIGFyZSBmb3JiaWRkZW5cIixcbiAgICApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplV29ya3NwYWNlSG9zdEJ1aWxkTWFuaWZlc3RJbnB1dChcbiAgaW5wdXQ6IFdvcmtzcGFjZUhvc3RCdWlsZE1hbmlmZXN0SW5wdXQsXG4pOiBXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdFBheWxvYWQge1xuICBpZiAoaW5wdXQuY29udHJhY3RWZXJzaW9uICE9PSBXT1JLU1BBQ0VfSE9TVF9CVUlMRF9JTlBVVF9DT05UUkFDVF9WRVJTSU9OKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RCdWlsZE1hbmlmZXN0RXJyb3IoXG4gICAgICBgY29udHJhY3RWZXJzaW9uIG11c3QgYmUgJyR7V09SS1NQQUNFX0hPU1RfQlVJTERfSU5QVVRfQ09OVFJBQ1RfVkVSU0lPTn0nYCxcbiAgICApO1xuICB9XG4gIGlmIChpbnB1dC5kaXN0cmlidXRpb25Qcm9maWxlICE9PSBcInZtLXJlbGVhc2VcIikge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdEVycm9yKFxuICAgICAgXCJkaXN0cmlidXRpb25Qcm9maWxlIG11c3QgYmUgJ3ZtLXJlbGVhc2UnXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoIUdJVF9SRVZJU0lPTi50ZXN0KGlucHV0LnNvdXJjZS5yZXZpc2lvbikpIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEJ1aWxkTWFuaWZlc3RFcnJvcihcbiAgICAgIFwic291cmNlLnJldmlzaW9uIG11c3QgYmUgYSBsb3dlcmNhc2UgaW1tdXRhYmxlIEdpdCBTSEEtMSBvciBTSEEtMjU2IG9iamVjdCBpZFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKFxuICAgIGlucHV0LmJ1aWxkZXIuc3RyYXRlZ3kgIT09IFwic2hhcmVkXCIgfHxcbiAgICAhV09SS1NQQUNFX0hPU1RfQlVJTERFUl9LSU5EUy5pbmNsdWRlcyhcbiAgICAgIGlucHV0LmJ1aWxkZXIua2luZCBhcyBXb3Jrc3BhY2VIb3N0QnVpbGRlcktpbmQsXG4gICAgKVxuICApIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEJ1aWxkTWFuaWZlc3RFcnJvcihcbiAgICAgIGBidWlsZGVyIG11c3Qgc2VsZWN0IGEgc2hhcmVkIGNhbm9uaWNhbCBwcm9kdWNlciAoJHtXT1JLU1BBQ0VfSE9TVF9CVUlMREVSX0tJTkRTLmpvaW4oXCIsIFwiKX0pYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWRUYXJnZXRzID0gbm9ybWFsaXplVGFyZ2V0cyhpbnB1dC50YXJnZXRzKTtcblxuICByZXR1cm4ge1xuICAgIHNjaGVtYVZlcnNpb246IFdPUktTUEFDRV9IT1NUX0JVSUxEX01BTklGRVNUX1NDSEVNQV9WRVJTSU9OLFxuICAgIGNvbnRyYWN0VmVyc2lvbjogaW5wdXQuY29udHJhY3RWZXJzaW9uLFxuICAgIGRpc3RyaWJ1dGlvblByb2ZpbGU6IGlucHV0LmRpc3RyaWJ1dGlvblByb2ZpbGUsXG4gICAgc291cmNlOiB7XG4gICAgICByZXBvc2l0b3J5OiByZXF1aXJlVGV4dChpbnB1dC5zb3VyY2UucmVwb3NpdG9yeSwgXCJzb3VyY2UucmVwb3NpdG9yeVwiKSxcbiAgICAgIHJldmlzaW9uOiBpbnB1dC5zb3VyY2UucmV2aXNpb24sXG4gICAgfSxcbiAgICByZWxlYXNlQXJ0aWZhY3Q6IHtcbiAgICAgIG5hbWU6IHJlcXVpcmVUZXh0KGlucHV0LnJlbGVhc2VBcnRpZmFjdC5uYW1lLCBcInJlbGVhc2VBcnRpZmFjdC5uYW1lXCIpLFxuICAgICAgdmVyc2lvbjogcmVxdWlyZVRleHQoXG4gICAgICAgIGlucHV0LnJlbGVhc2VBcnRpZmFjdC52ZXJzaW9uLFxuICAgICAgICBcInJlbGVhc2VBcnRpZmFjdC52ZXJzaW9uXCIsXG4gICAgICApLFxuICAgICAgc2hhMjU2OiByZXF1aXJlU2hhMjU2KFxuICAgICAgICBpbnB1dC5yZWxlYXNlQXJ0aWZhY3Quc2hhMjU2LFxuICAgICAgICBcInJlbGVhc2VBcnRpZmFjdC5zaGEyNTZcIixcbiAgICAgICksXG4gICAgICBzaXplQnl0ZXM6IHJlcXVpcmVTaXplKFxuICAgICAgICBpbnB1dC5yZWxlYXNlQXJ0aWZhY3Quc2l6ZUJ5dGVzLFxuICAgICAgICBcInJlbGVhc2VBcnRpZmFjdC5zaXplQnl0ZXNcIixcbiAgICAgICksXG4gICAgfSxcbiAgICBiYXNlSW1hZ2U6IHtcbiAgICAgIHJlZmVyZW5jZTogbm9ybWFsaXplQmFzZUltYWdlUmVmZXJlbmNlKFxuICAgICAgICBpbnB1dC5iYXNlSW1hZ2UucmVmZXJlbmNlLFxuICAgICAgICBub3JtYWxpemVkVGFyZ2V0cyxcbiAgICAgICAgaW5wdXQuYnVpbGRlci5raW5kLFxuICAgICAgKSxcbiAgICAgIGFyY2hpdGVjdHVyZTogcmVxdWlyZVRleHQoXG4gICAgICAgIGlucHV0LmJhc2VJbWFnZS5hcmNoaXRlY3R1cmUsXG4gICAgICAgIFwiYmFzZUltYWdlLmFyY2hpdGVjdHVyZVwiLFxuICAgICAgKSxcbiAgICAgIHNoYTI1NjogcmVxdWlyZVNoYTI1NihpbnB1dC5iYXNlSW1hZ2Uuc2hhMjU2LCBcImJhc2VJbWFnZS5zaGEyNTZcIiksXG4gICAgfSxcbiAgICBidWlsZGVyOiB7XG4gICAgICBzdHJhdGVneTogaW5wdXQuYnVpbGRlci5zdHJhdGVneSxcbiAgICAgIGtpbmQ6IGlucHV0LmJ1aWxkZXIua2luZCxcbiAgICAgIHZlcnNpb246IHJlcXVpcmVUZXh0KGlucHV0LmJ1aWxkZXIudmVyc2lvbiwgXCJidWlsZGVyLnZlcnNpb25cIiksXG4gICAgICB0ZW1wbGF0ZVBhdGg6IHJlcXVpcmVSZWxhdGl2ZVBhdGgoXG4gICAgICAgIGlucHV0LmJ1aWxkZXIudGVtcGxhdGVQYXRoLFxuICAgICAgICBcImJ1aWxkZXIudGVtcGxhdGVQYXRoXCIsXG4gICAgICApLFxuICAgICAgdGVtcGxhdGVTaGEyNTY6IHJlcXVpcmVTaGEyNTYoXG4gICAgICAgIGlucHV0LmJ1aWxkZXIudGVtcGxhdGVTaGEyNTYsXG4gICAgICAgIFwiYnVpbGRlci50ZW1wbGF0ZVNoYTI1NlwiLFxuICAgICAgKSxcbiAgICB9LFxuICAgIG1hdGVyaWFsczogbm9ybWFsaXplTWF0ZXJpYWxzKGlucHV0Lm1hdGVyaWFscyksXG4gICAgcGFyYW1ldGVyczogbm9ybWFsaXplUGFyYW1ldGVycyhpbnB1dC5wYXJhbWV0ZXJzKSxcbiAgICB0YXJnZXRzOiBub3JtYWxpemVkVGFyZ2V0cyxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNhbm9uaWNhbFdvcmtzcGFjZUhvc3RCdWlsZE1hbmlmZXN0UGF5bG9hZChcbiAgcGF5bG9hZDogV29ya3NwYWNlSG9zdEJ1aWxkTWFuaWZlc3RQYXlsb2FkLFxuKTogc3RyaW5nIHtcbiAgLy8gVHlwZVNjcmlwdCdzIHN0cnVjdHVyYWwgdHlwaW5nIHBlcm1pdHMgYSBmdWxsIG1hbmlmZXN0IGF0IHRoaXMgYm91bmRhcnkuXG4gIC8vIFN0cmlwIHRoZSBzZWxmLXJlZmVyZW50aWFsIGlkZW50aXR5IGF0IHJ1bnRpbWUgc28gZXZlcnkgY2FsbGVyIGhhc2hlcyBvbmx5XG4gIC8vIHRoZSBwYXlsb2FkIGV2ZW4gd2hlbiBpdCBwYXNzZXMgdGhlIGVucmljaGVkIG9iamVjdCBkaXJlY3RseS5cbiAgY29uc3QgeyBtYW5pZmVzdElkZW50aXR5OiBfbWFuaWZlc3RJZGVudGl0eSwgLi4uY2Fub25pY2FsUGF5bG9hZCB9ID1cbiAgICBwYXlsb2FkIGFzIFdvcmtzcGFjZUhvc3RCdWlsZE1hbmlmZXN0O1xuICByZXR1cm4gY2Fub25pY2FsaXplKGNhbm9uaWNhbFBheWxvYWQpO1xufVxuXG5mdW5jdGlvbiBpZGVudGl0eUZvcihcbiAgcGF5bG9hZDogV29ya3NwYWNlSG9zdEJ1aWxkTWFuaWZlc3RQYXlsb2FkLFxuKTogYHNoYTI1Njoke3N0cmluZ31gIHtcbiAgY29uc3QgZGlnZXN0ID0gY3JlYXRlSGFzaChcInNoYTI1NlwiKVxuICAgIC51cGRhdGUoY2Fub25pY2FsV29ya3NwYWNlSG9zdEJ1aWxkTWFuaWZlc3RQYXlsb2FkKHBheWxvYWQpLCBcInV0ZjhcIilcbiAgICAuZGlnZXN0KFwiaGV4XCIpO1xuICByZXR1cm4gYHNoYTI1Njoke2RpZ2VzdH1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdChcbiAgaW5wdXQ6IFdvcmtzcGFjZUhvc3RCdWlsZE1hbmlmZXN0SW5wdXQsXG4pOiBXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdCB7XG4gIGNvbnN0IHBheWxvYWQgPSBub3JtYWxpemVXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdElucHV0KGlucHV0KTtcbiAgcmV0dXJuIHsgLi4ucGF5bG9hZCwgbWFuaWZlc3RJZGVudGl0eTogaWRlbnRpdHlGb3IocGF5bG9hZCkgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHZlcmlmeVdvcmtzcGFjZUhvc3RCdWlsZE1hbmlmZXN0KFxuICBtYW5pZmVzdDogV29ya3NwYWNlSG9zdEJ1aWxkTWFuaWZlc3QsXG4pOiBXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdFZlcmlmaWNhdGlvbiB7XG4gIHRyeSB7XG4gICAgY29uc3Qge1xuICAgICAgbWFuaWZlc3RJZGVudGl0eSxcbiAgICAgIHNjaGVtYVZlcnNpb246IF9zY2hlbWFWZXJzaW9uLFxuICAgICAgLi4uaW5wdXRcbiAgICB9ID0gbWFuaWZlc3Q7XG4gICAgY29uc3QgcGF5bG9hZCA9IG5vcm1hbGl6ZVdvcmtzcGFjZUhvc3RCdWlsZE1hbmlmZXN0SW5wdXQoaW5wdXQpO1xuICAgIGNvbnN0IGV4cGVjdGVkSWRlbnRpdHkgPSBpZGVudGl0eUZvcihwYXlsb2FkKTtcbiAgICBjb25zdCBlcnJvcnMgPSBbXG4gICAgICAuLi4obWFuaWZlc3Quc2NoZW1hVmVyc2lvbiA9PT1cbiAgICAgIFdPUktTUEFDRV9IT1NUX0JVSUxEX01BTklGRVNUX1NDSEVNQV9WRVJTSU9OXG4gICAgICAgID8gW11cbiAgICAgICAgOiBbXG4gICAgICAgICAgICBgc2NoZW1hVmVyc2lvbiBtdXN0IGJlICR7V09SS1NQQUNFX0hPU1RfQlVJTERfTUFOSUZFU1RfU0NIRU1BX1ZFUlNJT059YCxcbiAgICAgICAgICBdKSxcbiAgICAgIC4uLihtYW5pZmVzdElkZW50aXR5ID09PSBleHBlY3RlZElkZW50aXR5XG4gICAgICAgID8gW11cbiAgICAgICAgOiBbXG4gICAgICAgICAgICBgbWFuaWZlc3RJZGVudGl0eSAke21hbmlmZXN0SWRlbnRpdHl9IGRvZXMgbm90IG1hdGNoIGNhbm9uaWNhbCBwYXlsb2FkICR7ZXhwZWN0ZWRJZGVudGl0eX1gLFxuICAgICAgICAgIF0pLFxuICAgIF07XG4gICAgcmV0dXJuIHsgb2s6IGVycm9ycy5sZW5ndGggPT09IDAsIGV4cGVjdGVkSWRlbnRpdHksIGVycm9ycyB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBleHBlY3RlZElkZW50aXR5OiBgc2hhMjU2OiR7XCIwXCIucmVwZWF0KDY0KX1gLFxuICAgICAgZXJyb3JzOiBbZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpXSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogUmVsZWFzZSBwcm92ZW5hbmNlOiBkb2VzIGEgYm9vdHN0cmFwJ3MgcmVsZWFzZSBwaW4gYWN0dWFsbHkgZGVzY3JpYmUgVEhJUyBidWlsZD9cbiAqXG4gKiBBIGJvb3RzdHJhcCByZWxlYXNlIGNhcnJpZXMgYSBVUkwgYW5kIGEgZGlnZXN0LCBhbmQgbm90aGluZyBpbiB0aGUgYm9vdHN0cmFwIG1vZHVsZSBjYW4gdGVsbFxuICogd2hldGhlciB0aG9zZSBkZXNjcmliZSBhIHJlYWwgYXJ0aWZhY3Qgb3Igd2VyZSBoYW5kLXR5cGVkIGludG8gYSB0ZXN0LiBUaGF0IGlzIG5vdCBhXG4gKiBoeXBvdGhldGljYWwgZ2FwOiBldmVyeSBwdWJsaWNhdGlvbiBVUkwgaW4gdGhpcyByZXBvc2l0b3J5IHRvZGF5IGxpdmVzIGluIGEgYC50ZXN0LnRzYCBmaWxlLlxuICogQmluZGluZyB0aGUgcGluIHRvIGEgbWFuaWZlc3QgaXMgd2hhdCBtYWtlcyBmaXh0dXJlIHByb3ZlbmFuY2UgREVURUNUQUJMRSDigJQgYSBkaWdlc3QgdGhhdFxuICogbWF0Y2hlcyBubyBidWlsZCBjYW5ub3QgcGFzcywgaG93ZXZlciBwbGF1c2libGUgaXRzIGhvc3RuYW1lIGxvb2tzLlxuICpcbiAqIFRoaXMgbGl2ZXMgYmVzaWRlIHRoZSBtYW5pZmVzdCBkZWxpYmVyYXRlbHkuIFRoZSBxdWVzdGlvbiBcImlzIHRoaXMgcmVsZWFzZSB0aGUgb25lIHRoaXNcbiAqIG1hbmlmZXN0IGJ1aWx0P1wiIGlzIG1hbmlmZXN0IHRydXRoLCBhbmQgYW5zd2VyaW5nIGl0IGhlcmUga2VlcHMgdGhlIGRlcGVuZGVuY3kgcG9pbnRpbmcgb25lXG4gKiB3YXkgKGJvb3RzdHJhcCAtPiBtYW5pZmVzdCwgdGhlIGRpcmVjdGlvbiBgd29ya3NwYWNlLWhvc3QtaW1hZ2VgIGFscmVhZHkgdXNlcykgaW5zdGVhZCBvZlxuICogaW50cm9kdWNpbmcgYSBzZWNvbmQgcmVsZWFzZSBzdXJmYWNlLlxuICovXG5cbi8qKiBCdW5kbGUtcmVsYXRpdmUgcGF0aCBvZiB0aGUgcmVtb3RlIGluaXRpYWxpemVyIGV4ZWN1dGFibGUgaW5zaWRlIHRoZSBleHRyYWN0ZWQgcmVsZWFzZS4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9SRU1PVEVfSU5JVElBTElaRVJfRU5UUllQT0lOVCA9XG4gIFwiYmluL3BhcGVyY3VzcC1yZW1vdGUtaW5pdGlhbGl6ZXJcIjtcblxuLyoqXG4gKiBCdW5kbGUtcmVsYXRpdmUgcGF0aCBvZiB0aGUgY3JlZGVudGlhbC1kZWxpdmVyeSBleGVjdXRhYmxlIGluc2lkZSB0aGUgZXh0cmFjdGVkIHJlbGVhc2UuXG4gKlxuICogU2VwYXJhdGUgZnJvbSB0aGUgcmVtb3RlIGluaXRpYWxpemVyIGJlY2F1c2UgdGhlIHR3byBwcm9ncmFtcyBoYXZlIG9wcG9zaXRlIHJlbGF0aW9uc2hpcHMgd2l0aFxuICogc2VjcmV0IG1hdGVyaWFsIChELTIxNSk7IGEgYnVuZGxlIGNhcnJ5aW5nIG9uZSBidXQgbm90IHRoZSBvdGhlciBjYW4gaW5pdGlhbGl6ZSBhIGhvc3QgYW5kIHRoZW5cbiAqIGZhaWwgZXZlcnkgYGdpdGAvYGFnZW50YCBiaW5kIG9uIGl0LlxuICpcbiAqIOKaoCBOQU1FRCBgZGVsaXZlci1tYXRlcmlhbGAsIE5PVCBgY3JlZGVudGlhbC1kZWxpdmVyeWAsIEFORCBJVCBNVVNUIFNUQVkgVEhBVCBXQVkuIGBTRUNSRVRfTUFURVJJQUxgXG4gKiBiZWxvdyByZWZ1c2VzIGFueSBtYW5pZmVzdCBwYXRoIGNvbnRhaW5pbmcgYGNyZWRlbnRpYWxgLCBiZWNhdXNlIGEgcHVibGlzaGVkIG1hbmlmZXN0IGVudW1lcmF0aW5nXG4gKiBhIGNyZWRlbnRpYWwgcGF0aCBsZWFrcyBpdHMgZXhpc3RlbmNlIGFuZCBsb2NhdGlvbi4gVGhpcyBlbnRyeSBpcyBhIFBST0dSQU0sIG5vdCBrZXkgbWF0ZXJpYWwsIHNvXG4gKiB0aGUgcmVmdXNhbCBpcyBhIGZhbHNlIHBvc2l0aXZlIOKAlCBidXQgdGhlIGd1YXJkIGlzIGEgTkFNRSBoZXVyaXN0aWMgYW5kIGNhbm5vdCB0ZWxsIHRoZSB0d28gYXBhcnQuXG4gKiBSZW5hbWluZyB0aGUgZmlsZSBpcyB0aGUgaG9uZXN0IGZpeDsgZXhlbXB0aW5nIGBiaW4vYCBvciBgZXhlY3V0YWJsZTogdHJ1ZWAgd291bGQgcHVuY2ggYSBob2xlXG4gKiB0aHJvdWdoIHdoaWNoIGEgcmVhbCBjcmVkZW50aWFsIHBhdGggY291bGQgbGF0ZXIgcGFzcy4gRG8gbm90IFwicmVzdG9yZVwiIHRoZSBvYnZpb3VzIG5hbWUuXG4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9DUkVERU5USUFMX0RFTElWRVJZX0VOVFJZUE9JTlQgPVxuICBcImJpbi9wYXBlcmN1c3AtZGVsaXZlci1tYXRlcmlhbFwiO1xuXG4vKiogSW5lcnQgdW50aWwgdGhlIG9wdGlvbmFsIGRlc2t0b3AgcGFjayBpbnN0YWxscyBpdHMgc29ja2V0LWFjdGl2YXRlZCBzZXJ2aWNlLiAqL1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX0RFU0tUT1BfU0VTU0lPTl9FTlRSWVBPSU5UID0gXCJiaW4vcGFwZXJjdXNwLWRlc2t0b3Atc2Vzc2lvbi5janNcIjtcblxuLyoqIEJ1bmRsZS1yZWxhdGl2ZSBQVUkgZ2VuZXJhdGlvbiBpbnN0YWxsZWQgYW5kIGF0dGVzdGVkIGFzIG9uZSBpbW11dGFibGUgcmVsZWFzZSB1bml0LiAqL1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX1BVSV9FTlRSWVBPSU5UID0gXCJiaW4vcHVpXCI7XG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfUFVJX0NPTVBBTklPTl9QQVRIID0gXCJwdWktY29tcGFuaW9uLndhc21cIjtcbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9QVUlfSU5TVEFMTF9NQU5JRkVTVF9QQVRIID0gXCJwdWktaW5zdGFsbC5qc29uXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdFJlcXVpcmVkUmVsZWFzZU1hdGVyaWFsIHtcbiAgcmVhZG9ubHkgcGF0aDogc3RyaW5nO1xuICByZWFkb25seSBleGVjdXRhYmxlPzogdHJ1ZTtcbn1cblxuLyoqXG4gKiBSdW50aW1lIG1hdGVyaWFscyB3aXRob3V0IHdoaWNoIGEgc2lnbmVkIGJ1bmRsZSBjYW4gaW5zdGFsbCBzdWNjZXNzZnVsbHkgYnV0IGNhbm5vdCBhY3R1YWxseVxuICogaW5pdGlhbGl6ZSBhIHJlbW90ZSB3b3Jrc3BhY2Ugb3IgcHJvdmUgdGhhdCBpdHMgUFVJIGJpbmFyeSBhbmQgY29tcGFuaW9uIGNhbWUgZnJvbSBvbmUgYnVpbGQuXG4gKiBLZWVwIHRoaXMgYXMgdGhlIHNpbmdsZSByZWxlYXNlLWdhdGUgY29udHJhY3Q7IHByb2R1Y2VycyBhbmQgZml4dHVyZXMgY29uc3VtZSB0aGVzZSBleHBvcnRlZFxuICogcGF0aHMgcmF0aGVyIHRoYW4gbWFpbnRhaW5pbmcgcGFyYWxsZWwgcmVxdWlyZWQtbWF0ZXJpYWwgbGlzdHMuXG4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9SRVFVSVJFRF9SRUxFQVNFX01BVEVSSUFMUzogcmVhZG9ubHkgV29ya3NwYWNlSG9zdFJlcXVpcmVkUmVsZWFzZU1hdGVyaWFsW10gPVxuICBbXG4gICAgeyBwYXRoOiBXT1JLU1BBQ0VfSE9TVF9SRU1PVEVfSU5JVElBTElaRVJfRU5UUllQT0lOVCwgZXhlY3V0YWJsZTogdHJ1ZSB9LFxuICAgIHsgcGF0aDogV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9ERUxJVkVSWV9FTlRSWVBPSU5ULCBleGVjdXRhYmxlOiB0cnVlIH0sXG4gICAgeyBwYXRoOiBXT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1NFU1NJT05fRU5UUllQT0lOVCwgZXhlY3V0YWJsZTogdHJ1ZSB9LFxuICAgIHsgcGF0aDogV09SS1NQQUNFX0hPU1RfUFVJX0VOVFJZUE9JTlQsIGV4ZWN1dGFibGU6IHRydWUgfSxcbiAgICB7IHBhdGg6IFdPUktTUEFDRV9IT1NUX1BVSV9DT01QQU5JT05fUEFUSCB9LFxuICAgIHsgcGF0aDogV09SS1NQQUNFX0hPU1RfUFVJX0lOU1RBTExfTUFOSUZFU1RfUEFUSCB9LFxuICBdO1xuXG4vKipcbiAqIFBhdGggc2VnbWVudHMgbmFtaW5nIGEgTVVUQUJMRSByZWxlYXNlIGNoYW5uZWwuIEEgVVJMIGVuZGluZyBpbiBvbmUgb2YgdGhlc2UgY2FuIHNlcnZlXG4gKiBkaWZmZXJlbnQgYnl0ZXMgdG9tb3Jyb3csIHNvIHBpbm5pbmcgYSBkaWdlc3QgYWdhaW5zdCBpdCBpcyBhIHByb21pc2UgdGhlIFVSTCBjYW5ub3Qga2VlcC5cbiAqL1xuY29uc3QgTVVUQUJMRV9VUkxfU0VHTUVOVCA9XG4gIC9eKD86bGF0ZXN0fHN0YWJsZXxjdXJyZW50fG1haW58bWFzdGVyfGVkZ2V8aGVhZHxuaWdodGx5fHJvbGxpbmd8ZGV2fHVuc3RhYmxlKSg/OlxcLltBLVphLXowLTkuXSspPyQvaTtcblxuLyoqXG4gKiBSZXNlcnZlZCBhbmQgbm9uLXJlc29sdmFibGUgVExEcyAoUkZDIDI2MDYgLyBSRkMgNjc2MSkuIEEgaG9zdCB1bmRlciBvbmUgb2YgdGhlc2UgY2FuIG5ldmVyXG4gKiBiZSBhIHJlYWwgcHVibGljYXRpb24gdGFyZ2V0LCBzbyBpdHMgcHJlc2VuY2UgaXMgcG9zaXRpdmUgZXZpZGVuY2Ugb2YgZml4dHVyZSBwcm92ZW5hbmNlXG4gKiByYXRoZXIgdGhhbiBhIG1lcmUgYWJzZW5jZSBvZiBldmlkZW5jZS5cbiAqL1xuY29uc3QgRklYVFVSRV9IT1NUID0gLyg/Ol58XFwuKSg/OmludmFsaWR8dGVzdHxleGFtcGxlfGxvY2FsaG9zdHxsb2NhbHxpbnRlcm5hbCkkL2k7XG5cbi8qKlxuICogQSBjb250ZW50LWFkZHJlc3NlZCBwYXRoIHNlZ21lbnQgcGFpciDigJQgYC9zaGEyNTYvPDY0IGhleD5gIGZvbGxvd2VkIGJ5IGEgYC9gIG9yIHRoZSBlbmQgb2YgdGhlXG4gKiBwYXRoLiBBbmNob3Jpbmcgb24gdGhlIGBzaGEyNTYvYCBsYWJlbCByYXRoZXIgdGhhbiBcImEgNjQtaGV4IHJ1biBhbnl3aGVyZSBpbiB0aGUgc3RyaW5nXCIgaXNcbiAqIGRlbGliZXJhdGU6IGEgYmFyZSBoZXggcnVuIGFsc28gbWF0Y2hlcyBhIHF1ZXJ5IHZhbHVlIG9yIGEgaG9zdG5hbWUsIG5laXRoZXIgb2Ygd2hpY2ggYWRkcmVzc2VzXG4gKiB0aGUgYXJ0aWZhY3QsIHNvIGEgbG9vc2VyIHBhdHRlcm4gd291bGQgYWNjZXB0IGEgbXV0YWJsZSBVUkwgdGhhdCBtZXJlbHkgbWVudGlvbnMgYSBkaWdlc3QuXG4gKi9cbmNvbnN0IENPTlRFTlRfQUREUkVTU0VEX0RJR0VTVCA9IC9cXC9zaGEyNTZcXC8oWzAtOWEtZkEtRl17NjR9KSg/PVxcL3wkKS87XG5cbi8qKlxuICogVGhlIHBhdGhuYW1lIG9mIGEgVVJMLCBvciB0aGUgZW1wdHkgc3RyaW5nIHdoZW4gaXQgZG9lcyBub3QgcGFyc2UuIEFuIHVucGFyc2VhYmxlIFVSTCBpc1xuICogcmVwb3J0ZWQgYnkgdGhlIHNoYXBlIGNoZWNrczsgcmV0dXJuaW5nIGVtcHR5IGhlcmUga2VlcHMgdGhlIGFkZHJlc3NpbmcgcnVsZXMgZnJvbSByZWFkaW5nIGFcbiAqIGRpZ2VzdCBvdXQgb2YgYSBzdHJpbmcgdGhhdCBpcyBub3QgYSBVUkwgYXQgYWxsLlxuICovXG5mdW5jdGlvbiB1cmxQYXRobmFtZSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gbmV3IFVSTCh2YWx1ZSkucGF0aG5hbWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBcIlwiO1xuICB9XG59XG5cbi8qKlxuICogVGhlIHB1Ymxpc2hlZCBvcmlnaW4gZm9yIHdvcmtzcGFjZS1ob3N0IHJlbGVhc2UgYXJ0aWZhY3RzLlxuICpcbiAqIFRoaXMgaXMgdGhlIG1haW50YWluZWQgYXJ0aWZhY3Qgb3JpZ2luLCBleHRlbmRlZCByYXRoZXIgdGhhbiByZXBsYWNlZDogYSBzZWNvbmQgcHVibGlzaGVyIHdvdWxkXG4gKiBiZSBhIHBhcmFsbGVsIHJlbGVhc2Ugc3lzdGVtLCB3aGljaCBpcyBwcmVjaXNlbHkgd2hhdCB0aGlzIGxhbmUgbXVzdCBub3QgYnVpbGQuXG4gKlxuICog4pqgIFRoZSBCUkFOREVEIGhvc3QsIGRlbGliZXJhdGVseSDigJQgbm90IHRoZSBXb3JrZXIncyBvd24gYCoud29ya2Vycy5kZXZgIG9yaWdpbi4gQm90aCBuYW1lcyByb3V0ZVxuICogdG8gdGhlIHNhbWUgV29ya2VyIGFuZCBzZXJ2ZSBieXRlLWlkZW50aWNhbCBib2RpZXMsIGJ1dCB0aGUgd29ya2Vycy5kZXYgZm9ybSBlbWJlZHMgdGhlXG4gKiBDbG91ZGZsYXJlIEFDQ09VTlQgU1VCRE9NQUlOLCB3aGljaCBpcyB0aGUgcmVsZWFzZSBvd25lcidzIEdpdEh1YiBoYW5kbGUuIEJlY2F1c2UgdGhpcyBjb25zdGFudFxuICogaXMgYnVuZGxlZCBpbnRvIHRoZSBzaGlwcGVkIGhvc3QsIHVzaW5nIHRoYXQgZm9ybSBjb21waWxlZCBhIHBlcnNvbmFsIGlkZW50aXR5IHN0cmluZyBpbnRvIGV2ZXJ5XG4gKiByZWxlYXNlIGFuZCBmb3JjZWQgYW4gYWNjZXB0YW5jZSBpbiB0aGUgcmVsZWFzZSBpZGVudGl0eSBnYXRlIChXSS0zODIzMyBkaXNjbG9zZWQgaXQ7IFdJLTM4MzIxXG4gKiByZW1vdmVkIGl0KS4gQ2FsbGVycyB0aGF0IGdlbnVpbmVseSBuZWVkIGFub3RoZXIgb3JpZ2luIHBhc3MgYG9wdGlvbnMub3JpZ2luYDsgZG8gbm90IHJlaW50cm9kdWNlXG4gKiBhbiBhY2NvdW50LWJlYXJpbmcgaG9zdG5hbWUgaGVyZS5cbiAqXG4gKiDimqAgRlJPTSBUSEUgUEFQRVJDVVNQIERFViBCT1ggdGhpcyBob3N0bmFtZSB3aWxsIG5vdCByZXNvbHZlIG9yIGNvbm5lY3Q6IHRoYXQgYm94IHNpbGVudGx5XG4gKiBibGFja2hvbGVzIFRMUyB0byBldmVyeSBwYXBlcmN1c3AtZmFtaWx5IG5hbWUgYnkgU05JIChFSS0xNjc0MixcbiAqIGFnZW50LWluc2lnaHRzL3N1LWJveC1zbmktdGxzLWJsYWNraG9sZS1ub3Qtb3V0YWdlKS4gQSBsb2NhbCB0aW1lb3V0IGhlcmUgaXMgTk9UIGV2aWRlbmNlIHRoZVxuICogb3JpZ2luIGlzIGRvd24sIGFuZCBtdXN0IG5vdCBiZSBcImZpeGVkXCIgYnkgcG9pbnRpbmcgdGhpcyBiYWNrIGF0IHdvcmtlcnMuZGV2LlxuICovXG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfQVJUSUZBQ1RfT1JJR0lOID0gXCJodHRwczovL2N1cGJvYXJkLnBhcGVyY3VzcC5jb21cIjtcblxuLyoqIFRoZSBwdWJsaXNoZWQgcGF0aCBwcmVmaXggdW5kZXIgd2hpY2ggd29ya3NwYWNlLWhvc3QgYXJ0aWZhY3RzIGFyZSBjb250ZW50LWFkZHJlc3NlZC4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9BUlRJRkFDVF9QQVRIX1BSRUZJWCA9IFwiL2FydGlmYWN0cy93b3Jrc3BhY2UtaG9zdFwiO1xuXG4vKiogVGhlIHRocmVlIGFydGlmYWN0cyBwdWJsaXNoZWQgdG9nZXRoZXIgZm9yIG9uZSB3b3Jrc3BhY2UtaG9zdCBidW5kbGUuICovXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RDYW5vbmljYWxBcnRpZmFjdFVybHMge1xuICByZWFkb25seSBidW5kbGVVcmw6IHN0cmluZztcbiAgcmVhZG9ubHkgc2lnbmF0dXJlVXJsOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG1hbmlmZXN0VXJsOiBzdHJpbmc7XG59XG5cbi8qKlxuICogRGVyaXZlIHRoZSBjYW5vbmljYWwgcHVibGlzaGVkIFVSTHMgZm9yIGEgYnVuZGxlIGZyb20gaXRzIHZlcmlmaWVkIGRpZ2VzdC5cbiAqXG4gKiBUaGlzIGV4aXN0cyBzbyB0aGF0IGEgYm9vdHN0cmFwIGNvbmZpZyBvciBtYW5pZmVzdCBuZXZlciBoYXMgdG8gYXV0aG9yIHRoZXNlIFVSTHMgYnkgaGFuZCwgYW5kXG4gKiB0aGVyZWZvcmUgY2FuIG5ldmVyICpkZWZhdWx0KiB0byBhIGZpeHR1cmUgaG9zdCBvciBhIG11dGFibGUgYGxhdGVzdGAgcGF0aCB3aGVuIGEgZGlnZXN0IGlzXG4gKiBtaXNzaW5nOiBhbiBhYnNlbnQgb3IgbWFsZm9ybWVkIGRpZ2VzdCBUSFJPV1MgcmF0aGVyIHRoYW4geWllbGRpbmcgYSBwbGF1c2libGUtbG9va2luZyBVUkwuXG4gKiBEZXJpdmluZyBmcm9tIHRoZSBkaWdlc3QgaXMgYWxzbyB3aGF0IG1ha2VzIHRoZSByZXN1bHRpbmcgcGluIHNlbGYtdmVyaWZ5aW5nIOKAlCB0aGUgYWRkcmVzcyBhbmRcbiAqIHRoZSBpbnRlZ3JpdHkgY2hlY2sgYXJlIHRoZSBzYW1lIHZhbHVlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVyaXZlV29ya3NwYWNlSG9zdENhbm9uaWNhbEFydGlmYWN0VXJscyhcbiAgYnVuZGxlU2hhMjU2OiBzdHJpbmcsXG4gIG9wdGlvbnM6IHsgcmVhZG9ubHkgb3JpZ2luPzogc3RyaW5nIH0gPSB7fSxcbik6IFdvcmtzcGFjZUhvc3RDYW5vbmljYWxBcnRpZmFjdFVybHMge1xuICBjb25zdCBkaWdlc3QgPSByZXF1aXJlVGV4dChidW5kbGVTaGEyNTYsIFwiYnVuZGxlU2hhMjU2XCIpLnRvTG93ZXJDYXNlKCk7XG4gIGlmICghU0hBMjU2X0hFWC50ZXN0KGRpZ2VzdCkpXG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJidW5kbGVTaGEyNTYgbXVzdCBiZSBhIGxvd2VyY2FzZSBTSEEtMjU2IGRpZ2VzdDsgY2Fub25pY2FsIGFydGlmYWN0IFVSTHMgYXJlIGRlcml2ZWQgZnJvbSB0aGUgZGlnZXN0IGFuZCBtdXN0IG5ldmVyIGJlIGRlZmF1bHRlZFwiLFxuICAgICk7XG5cbiAgY29uc3Qgb3JpZ2luID0gb3B0aW9ucy5vcmlnaW4gPz8gV09SS1NQQUNFX0hPU1RfQVJUSUZBQ1RfT1JJR0lOO1xuICBsZXQgcGFyc2VkT3JpZ2luOiBVUkw7XG4gIHRyeSB7XG4gICAgcGFyc2VkT3JpZ2luID0gbmV3IFVSTChvcmlnaW4pO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYG9yaWdpbiAke29yaWdpbn0gbXVzdCBiZSBhIHZhbGlkIHB1YmxpYyBIVFRQUyBVUkxgKTtcbiAgfVxuICBpZiAocGFyc2VkT3JpZ2luLnByb3RvY29sICE9PSBcImh0dHBzOlwiKVxuICAgIHRocm93IG5ldyBFcnJvcihgb3JpZ2luICR7b3JpZ2lufSBtdXN0IHVzZSBIVFRQU2ApO1xuICBpZiAoRklYVFVSRV9IT1NULnRlc3QocGFyc2VkT3JpZ2luLmhvc3RuYW1lKSlcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgb3JpZ2luIGhvc3QgJHtwYXJzZWRPcmlnaW4uaG9zdG5hbWV9IGlzIGEgcmVzZXJ2ZWQgbm9uLXJlc29sdmFibGUgbmFtZSwgbm90IGEgcHVibGljYXRpb24gdGFyZ2V0YCxcbiAgICApO1xuXG4gIGNvbnN0IGJhc2UgPSBgJHtwYXJzZWRPcmlnaW4ub3JpZ2lufSR7V09SS1NQQUNFX0hPU1RfQVJUSUZBQ1RfUEFUSF9QUkVGSVh9L3NoYTI1Ni8ke2RpZ2VzdH1gO1xuICBjb25zdCBidW5kbGVVcmwgPSBgJHtiYXNlfS9zZXJ2ZXIudGd6YDtcbiAgcmV0dXJuIHtcbiAgICBidW5kbGVVcmwsXG4gICAgc2lnbmF0dXJlVXJsOiBgJHtidW5kbGVVcmx9Lm1pbmlzaWdgLFxuICAgIG1hbmlmZXN0VXJsOiBgJHtiYXNlfS9tYW5pZmVzdC5qc29uYCxcbiAgfTtcbn1cblxuLyoqIFRoZSByZWxlYXNlIHBpbnMgYSBib290c3RyYXAgY29uZmlnIGNhcnJpZXMsIGFzIHRoZSBzdWJzZXQgcHJvdmVuYW5jZSBjYW4gYWRqdWRpY2F0ZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdFJlbGVhc2VQaW5zIHtcbiAgcmVhZG9ubHkgdmVyc2lvbjogc3RyaW5nO1xuICByZWFkb25seSBidW5kbGVVcmw6IHN0cmluZztcbiAgcmVhZG9ubHkgYnVuZGxlU2hhMjU2OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHNpZ25hdHVyZVVybDogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RSZWxlYXNlUHJvdmVuYW5jZVJlc3VsdCB7XG4gIHJlYWRvbmx5IG9rOiBib29sZWFuO1xuICByZWFkb25seSBlcnJvcnM6IHJlYWRvbmx5IHN0cmluZ1tdO1xufVxuXG4vKipcbiAqIFRoZSByZWxlYXNlLWFkZHJlc3NpbmcgcnVsZSwgc2hhcmVkIGJ5IGV2ZXJ5IHN1cmZhY2UgdGhhdCBwaW5zIGEgd29ya3NwYWNlLWhvc3QgYnVuZGxlLlxuICpcbiAqIEQtMTA2IHJlcXVpcmVzIGJ1aWxkIG1hbmlmZXN0cywgYm9vdHN0cmFwIGNvbmZpZ3VyYXRpb24sIHZhbGlkYXRvcnMgYW5kIGZpeHR1cmVzIHRvIGFncmVlIG9uXG4gKiBPTkUgcnVsZSBmb3Igd2hhdCBtYWtlcyBhIHBpbiBpbW11dGFibGUgcmF0aGVyIHRoYW4gZWFjaCByZXN0YXRpbmcgaXQuIFR3byBjYWxsZXJzIGNhbiBwcm92ZVxuICogZGlmZmVyZW50IHRoaW5ncywgc28gdGhlIGNhbGxlciBwYXNzZXMgdGhlIGRpZ2VzdC92ZXJzaW9uIGl0IGNhbiBhY3R1YWxseSBzdGFuZCBiZWhpbmQ6XG4gKlxuICogICAtIHRoZSBidWlsZCBtYW5pZmVzdCBwcm92ZXMgdGhlbSBmcm9tIHRoZSBhcnRpZmFjdCBpdCBqdXN0IGJ1aWx0O1xuICogICAtIHRoZSBib290c3RyYXAgY29udHJhY3QgcHJvdmVzIHRoZW0gZnJvbSB0aGUgcGlucyB0aGUgcmVsZWFzZSBpdHNlbGYgY2Fycmllcywgd2hpY2ggbWFrZXNcbiAqICAgICB0aGlzIGEgU0VMRi1DT05TSVNURU5DWSBjaGVjayDigJQgdGhlIFVSTCBtdXN0IGFkZHJlc3MgdGhlIHZlcnkgZGlnZXN0IHRoZSBob3N0IGlzIGFib3V0IHRvXG4gKiAgICAgdmVyaWZ5IGFmdGVyIGRvd25sb2FkLiBXaXRob3V0IGl0LCBgcmVxdWlyZVB1YmxpY0h0dHBzVXJsYCB3b3VsZCBoYXBwaWx5IGFjY2VwdCBhIG11dGFibGVcbiAqICAgICBgLi4uL2xhdGVzdC50Z3pgIGFsb25nc2lkZSBhIHdlbGwtZm9ybWVkIGRpZ2VzdCB0aGF0IG5vdGhpbmcgdGllcyBpdCB0bywgYW5kIHRoYXQgVVJMIGlzXG4gKiAgICAgYmFrZWQgaW50byBhIHNjcmlwdCB0aGF0IHJ1bnMgYXMgcm9vdCBvbiB0aGUgaG9zdC5cbiAqXG4gKiBCZWNhdXNlIGJvdGggY2FsbGVycyBydW4gdGhlIHNhbWUgcnVsZSwgYSBVUkwgYWNjZXB0ZWQgYnkgb25lIHN1cmZhY2UgY2Fubm90IGJlIHJlamVjdGVkIGJ5XG4gKiB0aGUgb3RoZXIg4oCUIHdoaWNoIGlzIHRoZSBwcm9wZXJ0eSB0aGF0IGtlcHQgZHJpZnRpbmcgd2hlbiB0aGUgcnVsZSB3YXMgd3JpdHRlbiBvdXQgdHdpY2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3b3Jrc3BhY2VIb3N0UmVsZWFzZUFkZHJlc3NpbmdFcnJvcnMoXG4gIHJlbGVhc2U6IFdvcmtzcGFjZUhvc3RSZWxlYXNlUGlucyxcbiAgZXhwZWN0ZWQ6IHtcbiAgICByZWFkb25seSBzaGEyNTY6IHN0cmluZztcbiAgICByZWFkb25seSB2ZXJzaW9uOiBzdHJpbmc7XG4gICAgLyoqXG4gICAgICogSG93IHRoZSBjYWxsZXIgbmFtZXMgdGhlIGFydGlmYWN0IGl0IGNhbiBwcm92ZSwgc28gdGhlIG1lc3NhZ2Ugc3RheXMgYWNjdXJhdGUgb24gYm90aFxuICAgICAqIHN1cmZhY2VzOiB0aGUgbWFuaWZlc3QgcHJvdmVzIFwidGhlIGJ1aWx0IGFydGlmYWN0XCI7IGJvb3RzdHJhcCBwcm92ZXMgdGhlIGRpZ2VzdCB0aGVcbiAgICAgKiByZWxlYXNlIHBpbnMuXG4gICAgICovXG4gICAgcmVhZG9ubHkgc3ViamVjdD86IHN0cmluZztcbiAgfSxcbik6IHN0cmluZ1tdIHtcbiAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBleHBlY3RlZERpZ2VzdCA9IGV4cGVjdGVkLnNoYTI1Ni50b0xvd2VyQ2FzZSgpO1xuICBjb25zdCBzdWJqZWN0ID0gZXhwZWN0ZWQuc3ViamVjdCA/PyBcInRoZSBidWlsdCBhcnRpZmFjdFwiO1xuXG4gIGVycm9ycy5wdXNoKC4uLmltbXV0YWJsZVVybEVycm9ycyhyZWxlYXNlLmJ1bmRsZVVybCwgXCJyZWxlYXNlLmJ1bmRsZVVybFwiKSk7XG4gIGVycm9ycy5wdXNoKFxuICAgIC4uLmltbXV0YWJsZVVybEVycm9ycyhyZWxlYXNlLnNpZ25hdHVyZVVybCwgXCJyZWxlYXNlLnNpZ25hdHVyZVVybFwiKSxcbiAgKTtcblxuICAvLyBUaGUgc2lnbmF0dXJlIG11c3QgYmUgdGhlIGRldGFjaGVkIGNvbXBhbmlvbiBvZiB0aGUgYnVuZGxlIGl0IHNpZ25zLiBBbGxvd2luZyBhbiB1bnJlbGF0ZWRcbiAgLy8gc2lnbmF0dXJlIFVSTCB3b3VsZCBsZXQgYSB2YWxpZCBzaWduYXR1cmUgb3ZlciBhIERJRkZFUkVOVCBhcnRpZmFjdCBzYXRpc2Z5IHRoZSBjaGVjay5cbiAgaWYgKHJlbGVhc2Uuc2lnbmF0dXJlVXJsICE9PSBgJHtyZWxlYXNlLmJ1bmRsZVVybH0ubWluaXNpZ2ApXG4gICAgZXJyb3JzLnB1c2goXG4gICAgICBcInJlbGVhc2Uuc2lnbmF0dXJlVXJsIG11c3QgYmUgcmVsZWFzZS5idW5kbGVVcmwgc3VmZml4ZWQgd2l0aCAubWluaXNpZ1wiLFxuICAgICk7XG5cbiAgLy8gQW4gaW1tdXRhYmxlIHBpbiBuZWVkcyB0aGUgVVJMIHRvIG5hbWUgV0hJQ0ggYXJ0aWZhY3QgaXQgYWRkcmVzc2VzIOKAlCBvdGhlcndpc2UgdGhlIHNhbWUgVVJMXG4gIC8vIGNhbiBiZSByZS1wb2ludGVkIGF0IGEgZGlmZmVyZW50IGJ1aWxkIHdpdGhvdXQgdGhlIHBpbiBjaGFuZ2luZy4gVHdvIGZvcm1zIHF1YWxpZnk6XG4gIC8vXG4gIC8vICAgY29udGVudC1hZGRyZXNzZWQgIC4uLi9zaGEyNTYvPGJ1bmRsZVNoYTI1Nj4vc2VydmVyLnRneiAgICh0aGUgY2Fub25pY2FsIHB1Ymxpc2hlZCBwYXRoKVxuICAvLyAgIHZlcnNpb24tZW1iZWRkZWQgICAuLi4vPHZlcnNpb24+L3NlcnZlci50Z3pcbiAgLy9cbiAgLy8gVGhlIGNvbnRlbnQtYWRkcmVzc2VkIGZvcm0gaXMgc3RyaWN0bHkgc3Ryb25nZXIgYW5kIGlzIHRoZXJlZm9yZSBjaGVja2VkIGZpcnN0OiB0aGUgZGlnZXN0XG4gIC8vIElTIHRoZSBpbW11dGFiaWxpdHkgcHJvb2YsIHdoZXJlIGEgdmVyc2lvbiBzdHJpbmcgb25seSBwcm9taXNlcyBvbmUuIEEgY29udGVudC1hZGRyZXNzZWQgVVJMXG4gIC8vIHdob3NlIGRpZ2VzdCBpcyBOT1QgdGhlIGV4cGVjdGVkIG9uZSBpcyBhIEhBUkRFUiBmYWlsdXJlIHRoYW4gYW4gdW5waW5uZWQgb25lIOKAlCBpdCBkb2VzIG5vdFxuICAvLyBtZXJlbHkgZmFpbCB0byBwcm92ZSBpbW11dGFiaWxpdHksIGl0IHBvc2l0aXZlbHkgYWRkcmVzc2VzIGEgZGlmZmVyZW50IGFydGlmYWN0IOKAlCBzbyBpdCBpc1xuICAvLyByZXBvcnRlZCBhcyBhIG1pc21hdGNoIHJhdGhlciB0aGFuIGZhbGxpbmcgdGhyb3VnaCB0byB0aGUgdmVyc2lvbi1lbWJlZGRpbmcgcnVsZS5cbiAgaWYgKHJlbGVhc2UuYnVuZGxlVXJsLmxlbmd0aCA+IDApIHtcbiAgICAvLyBNYXRjaCBhZ2FpbnN0IHRoZSBQQVRIIG9ubHkuIEEgZGlnZXN0IGluIGEgcXVlcnkgc3RyaW5nIG9yIGZyYWdtZW50IGRvZXMgbm90IGRldGVybWluZVxuICAgIC8vIHdoaWNoIGJ5dGVzIHRoZSBvcmlnaW4gc2VydmVzLCBzbyB0cmVhdGluZyBvbmUgYXMgYW4gYWRkcmVzcyB3b3VsZCBhY2NlcHQgYSBtdXRhYmxlIFVSTFxuICAgIC8vIHRoYXQgbWVyZWx5IG1lbnRpb25zIHRoZSBkaWdlc3QgaXQgaXMgc3VwcG9zZWQgdG8gYmUgcGlubmVkIHRvLlxuICAgIGNvbnN0IGNvbnRlbnRBZGRyZXNzID0gQ09OVEVOVF9BRERSRVNTRURfRElHRVNULmV4ZWMoXG4gICAgICB1cmxQYXRobmFtZShyZWxlYXNlLmJ1bmRsZVVybCksXG4gICAgKTtcbiAgICBpZiAoY29udGVudEFkZHJlc3MpIHtcbiAgICAgIGNvbnN0IGFkZHJlc3NlZERpZ2VzdCA9IChjb250ZW50QWRkcmVzc1sxXSA/PyBcIlwiKS50b0xvd2VyQ2FzZSgpO1xuICAgICAgaWYgKGFkZHJlc3NlZERpZ2VzdCAhPT0gZXhwZWN0ZWREaWdlc3QpXG4gICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgIGByZWxlYXNlLmJ1bmRsZVVybCBpcyBjb250ZW50LWFkZHJlc3NlZCBhdCAke2FkZHJlc3NlZERpZ2VzdH0sIHdoaWNoIGlzIG5vdCAke3N1YmplY3R9ICR7ZXhwZWN0ZWREaWdlc3R9YCxcbiAgICAgICAgKTtcbiAgICB9IGVsc2UgaWYgKCFyZWxlYXNlLmJ1bmRsZVVybC5pbmNsdWRlcyhleHBlY3RlZC52ZXJzaW9uKSlcbiAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICBgcmVsZWFzZS5idW5kbGVVcmwgbXVzdCBiZSBjb250ZW50LWFkZHJlc3NlZCB1bmRlciAvc2hhMjU2LyR7ZXhwZWN0ZWREaWdlc3R9LyBvciBlbWJlZCB0aGUgcmVsZWFzZSB2ZXJzaW9uICR7ZXhwZWN0ZWQudmVyc2lvbn0gc28gdGhlIHBpbiBpcyBpbW11dGFibGVgLFxuICAgICAgKTtcbiAgfVxuXG4gIHJldHVybiBlcnJvcnM7XG59XG5cbmZ1bmN0aW9uIGltbXV0YWJsZVVybEVycm9ycyh2YWx1ZTogc3RyaW5nLCBsYWJlbDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBsZXQgcGFyc2VkOiBVUkw7XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gbmV3IFVSTCh2YWx1ZSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbYCR7bGFiZWx9IG11c3QgYmUgYSB2YWxpZCBwdWJsaWMgSFRUUFMgVVJMYF07XG4gIH1cbiAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAocGFyc2VkLnByb3RvY29sICE9PSBcImh0dHBzOlwiKSBlcnJvcnMucHVzaChgJHtsYWJlbH0gbXVzdCB1c2UgSFRUUFNgKTtcbiAgaWYgKEZJWFRVUkVfSE9TVC50ZXN0KHBhcnNlZC5ob3N0bmFtZSkpXG4gICAgZXJyb3JzLnB1c2goXG4gICAgICBgJHtsYWJlbH0gaG9zdCAke3BhcnNlZC5ob3N0bmFtZX0gaXMgYSByZXNlcnZlZCBub24tcmVzb2x2YWJsZSBuYW1lLCBub3QgYSBwdWJsaWNhdGlvbiB0YXJnZXRgLFxuICAgICk7XG4gIGNvbnN0IHNlZ21lbnRzID0gcGFyc2VkLnBhdGhuYW1lLnNwbGl0KFwiL1wiKS5maWx0ZXIoKHBhcnQpID0+IHBhcnQubGVuZ3RoID4gMCk7XG4gIGNvbnN0IGJhc2VuYW1lID0gc2VnbWVudHMuYXQoLTEpID8/IFwiXCI7XG4gIGlmIChiYXNlbmFtZS5sZW5ndGggPT09IDApXG4gICAgZXJyb3JzLnB1c2goYCR7bGFiZWx9IG11c3QgYWRkcmVzcyBhIGZpbGUsIG5vdCBhIGRpcmVjdG9yeWApO1xuICBpZiAoc2VnbWVudHMuc29tZSgoc2VnbWVudCkgPT4gTVVUQUJMRV9VUkxfU0VHTUVOVC50ZXN0KHNlZ21lbnQpKSlcbiAgICBlcnJvcnMucHVzaChcbiAgICAgIGAke2xhYmVsfSBtdXN0IG5vdCBwb2ludCBhdCBhIG11dGFibGUgcmVsZWFzZSBjaGFubmVsOyBwaW4gYW4gaW1tdXRhYmxlIHZlcnNpb25lZCBwYXRoYCxcbiAgICApO1xuICByZXR1cm4gZXJyb3JzO1xufVxuXG4vKipcbiAqIFZlcmlmeSB0aGF0IGEgcmVsZWFzZSBwaW4gaXMgdGhlIGFydGlmYWN0IHRoaXMgbWFuaWZlc3QgYnVpbHQuXG4gKlxuICogUmV0dXJucyBldmVyeSBmYWlsdXJlIHJhdGhlciB0aGFuIHRocm93aW5nIG9uIHRoZSBmaXJzdCwgYmVjYXVzZSBhIGNhbGxlciByZXBhaXJpbmcgYSByZWxlYXNlXG4gKiBjb25maWcgd2FudHMgdGhlIHdob2xlIGxpc3Qg4oCUIGFuZCBiZWNhdXNlIGEgc2luZ2xlIHJlcG9ydGVkIGVycm9yIGludml0ZXMgZml4aW5nIHRoYXQgb25lXG4gKiBzeW1wdG9tIHdoaWxlIHRoZSByZXN0IG9mIHRoZSBwcm92ZW5hbmNlIHN0YXlzIGJyb2tlbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZlcmlmeVdvcmtzcGFjZUhvc3RSZWxlYXNlUHJvdmVuYW5jZShcbiAgbWFuaWZlc3Q6IFdvcmtzcGFjZUhvc3RCdWlsZE1hbmlmZXN0LFxuICByZWxlYXNlOiBXb3Jrc3BhY2VIb3N0UmVsZWFzZVBpbnMsXG4pOiBXb3Jrc3BhY2VIb3N0UmVsZWFzZVByb3ZlbmFuY2VSZXN1bHQge1xuICBjb25zdCBlcnJvcnM6IHN0cmluZ1tdID0gW107XG5cbiAgY29uc3QgbWFuaWZlc3RWZXJpZmljYXRpb24gPSB2ZXJpZnlXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdChtYW5pZmVzdCk7XG4gIGlmICghbWFuaWZlc3RWZXJpZmljYXRpb24ub2spXG4gICAgZXJyb3JzLnB1c2goXG4gICAgICAuLi5tYW5pZmVzdFZlcmlmaWNhdGlvbi5lcnJvcnMubWFwKFxuICAgICAgICAoZXJyb3IpID0+IGBtYW5pZmVzdCBpcyBub3Qgc2VsZi1jb25zaXN0ZW50OiAke2Vycm9yfWAsXG4gICAgICApLFxuICAgICk7XG5cbiAgY29uc3QgZXhwZWN0ZWREaWdlc3QgPSBtYW5pZmVzdC5yZWxlYXNlQXJ0aWZhY3Quc2hhMjU2LnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IHBpbm5lZERpZ2VzdCA9IHJlbGVhc2UuYnVuZGxlU2hhMjU2LnRvTG93ZXJDYXNlKCk7XG4gIGlmICghU0hBMjU2X0hFWC50ZXN0KHBpbm5lZERpZ2VzdCkpXG4gICAgZXJyb3JzLnB1c2goXCJyZWxlYXNlLmJ1bmRsZVNoYTI1NiBtdXN0IGJlIGEgbG93ZXJjYXNlIFNIQS0yNTYgZGlnZXN0XCIpO1xuICBlbHNlIGlmIChwaW5uZWREaWdlc3QgIT09IGV4cGVjdGVkRGlnZXN0KVxuICAgIGVycm9ycy5wdXNoKFxuICAgICAgYHJlbGVhc2UuYnVuZGxlU2hhMjU2ICR7cGlubmVkRGlnZXN0fSBkb2VzIG5vdCBtYXRjaCB0aGUgYnVpbHQgYXJ0aWZhY3QgJHtleHBlY3RlZERpZ2VzdH1gLFxuICAgICk7XG5cbiAgaWYgKHJlbGVhc2UudmVyc2lvbiAhPT0gbWFuaWZlc3QucmVsZWFzZUFydGlmYWN0LnZlcnNpb24pXG4gICAgZXJyb3JzLnB1c2goXG4gICAgICBgcmVsZWFzZS52ZXJzaW9uICR7cmVsZWFzZS52ZXJzaW9ufSBkb2VzIG5vdCBtYXRjaCB0aGUgYnVpbHQgYXJ0aWZhY3QgdmVyc2lvbiAke21hbmlmZXN0LnJlbGVhc2VBcnRpZmFjdC52ZXJzaW9ufWAsXG4gICAgKTtcblxuICAvLyBUaGUgYWRkcmVzc2luZyBydWxlIGxpdmVzIGluIG9uZSBwbGFjZSAoc2VlIHdvcmtzcGFjZUhvc3RSZWxlYXNlQWRkcmVzc2luZ0Vycm9ycykgc28gdGhlXG4gIC8vIGJvb3RzdHJhcCBjb250cmFjdCBjYW5ub3QgZHJpZnQgZnJvbSBpdC4gSGVyZSB0aGUgbWFuaWZlc3QgaXMgdGhlIGF1dGhvcml0eSBmb3Igd2hhdCB0aGVcbiAgLy8gVVJMIG11c3QgYWRkcmVzcywgYmVjYXVzZSBpdCBqdXN0IGJ1aWx0IHRoZSBhcnRpZmFjdC5cbiAgZXJyb3JzLnB1c2goXG4gICAgLi4ud29ya3NwYWNlSG9zdFJlbGVhc2VBZGRyZXNzaW5nRXJyb3JzKHJlbGVhc2UsIHtcbiAgICAgIHNoYTI1NjogZXhwZWN0ZWREaWdlc3QsXG4gICAgICB2ZXJzaW9uOiBtYW5pZmVzdC5yZWxlYXNlQXJ0aWZhY3QudmVyc2lvbixcbiAgICB9KSxcbiAgKTtcblxuICBmb3IgKGNvbnN0IHJlcXVpcmVkIG9mIFdPUktTUEFDRV9IT1NUX1JFUVVJUkVEX1JFTEVBU0VfTUFURVJJQUxTKSB7XG4gICAgY29uc3QgbWF0ZXJpYWwgPSBtYW5pZmVzdC5tYXRlcmlhbHMuZmluZChcbiAgICAgIChjYW5kaWRhdGUpID0+IGNhbmRpZGF0ZS5wYXRoID09PSByZXF1aXJlZC5wYXRoLFxuICAgICk7XG4gICAgaWYgKCFtYXRlcmlhbCkge1xuICAgICAgZXJyb3JzLnB1c2goYG1hdGVyaWFscyBtdXN0IGluY2x1ZGUgcmVxdWlyZWQgcmVsZWFzZSBtYXRlcmlhbCAke3JlcXVpcmVkLnBhdGh9YCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKG1hdGVyaWFsLnNpemVCeXRlcyA9PT0gMClcbiAgICAgIGVycm9ycy5wdXNoKGAke3JlcXVpcmVkLnBhdGh9IG11c3QgYmUgbm9uLWVtcHR5YCk7XG4gICAgaWYgKHJlcXVpcmVkLmV4ZWN1dGFibGUgPT09IHRydWUgJiYgbWF0ZXJpYWwuZXhlY3V0YWJsZSAhPT0gdHJ1ZSlcbiAgICAgIGVycm9ycy5wdXNoKGAke3JlcXVpcmVkLnBhdGh9IG11c3QgYmUgbWFya2VkIGV4ZWN1dGFibGVgKTtcbiAgfVxuXG4gIHJldHVybiB7IG9rOiBlcnJvcnMubGVuZ3RoID09PSAwLCBlcnJvcnMgfTtcbn1cbiJdLCJmaWxlIjoiL0Bmcy9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2RlcGxveW1lbnQtZHJpdmVyL3NyYy93b3Jrc3BhY2UtaG9zdC1idWlsZC1tYW5pZmVzdC50cyJ9

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2RlcGxveW1lbnQtZHJpdmVyL3NyYy93b3Jrc3BhY2UtaG9zdC1idWlsZC1tYW5pZmVzdC50cyIsIi9AZnMvaG9tZS9tYXJzaC1vZmZpY2UvcGFwZXJjdXBhaS13b3Jrc3BhY2UvcGFwZXJjdXNwL2xpYnMvZ2VuZXJpYy9kZXBsb3ltZW50LWRyaXZlci9zcmMvd29ya3NwYWNlLWhvc3QtYnVpbGQtbWFuaWZlc3QudHMiLFtdXQ==
}}