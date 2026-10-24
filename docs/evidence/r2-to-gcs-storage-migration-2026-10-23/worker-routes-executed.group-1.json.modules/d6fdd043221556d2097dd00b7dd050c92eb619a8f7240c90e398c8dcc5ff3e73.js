'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION", () => { try { return WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_CLEAN_ROOM_AUTHORIZED_KEY", () => { try { return WORKSPACE_HOST_CLEAN_ROOM_AUTHORIZED_KEY } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_IMAGE_ACTIONS", () => { try { return WORKSPACE_HOST_IMAGE_ACTIONS } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_IMAGE_LIFECYCLE_STATES", () => { try { return WORKSPACE_HOST_IMAGE_LIFECYCLE_STATES } catch {} });
__vite_ssr_exportName__("workspaceHostImageModel", () => { try { return workspaceHostImageModel } catch {} });
__vite_ssr_exportName__("validateWorkspaceHostImageArtifact", () => { try { return validateWorkspaceHostImageArtifact } catch {} });
__vite_ssr_exportName__("evaluateWorkspaceHostImageCompatibility", () => { try { return evaluateWorkspaceHostImageCompatibility } catch {} });
__vite_ssr_exportName__("buildWorkspaceHostCleanRoomInstallFixture", () => { try { return buildWorkspaceHostCleanRoomInstallFixture } catch {} });
__vite_ssr_exportName__("runWorkspaceHostCleanRoomAcceptance", () => { try { return runWorkspaceHostCleanRoomAcceptance } catch {} });
__vite_ssr_exportName__("workspaceHostCleanRoomFixtureAttestation", () => { try { return workspaceHostCleanRoomFixtureAttestation } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("node:crypto", {"importedNames":["createHash"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-build-manifest.ts", {"importedNames":["verifyWorkspaceHostBuildManifest","verifyWorkspaceHostReleaseProvenance"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-bootstrap.ts", {"importedNames":["DEFAULT_WORKSPACE_HOST_MODEL","WORKSPACE_HOST_BOOTC_BASE_IMAGE","DEFAULT_WORKSPACE_HOST_AGENT_USER","DEFAULT_WORKSPACE_HOST_SERVICE_USER","DEFAULT_WORKSPACE_HOST_WORKSPACE_USER","workspaceHostBootstrapChecks","WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION","WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION","WORKSPACE_HOST_CONTAINERS_POLICY_PATH","WORKSPACE_HOST_DATA_ROOT","WORKSPACE_HOST_MODELS","WORKSPACE_HOST_RUNTIME_ROOT","WORKSPACE_HOST_STATE_ROOT","buildWorkspaceHostBootstrap","parseWorkspaceHostBootstrapAttestation","validateWorkspaceHostBootstrapAttestation","workspaceHostBootcPinnedImageRef"]});



const WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION = "papercusp-workspace-host-image-acceptance-v1";
const WORKSPACE_HOST_CLEAN_ROOM_AUTHORIZED_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIARur6lLxx+/iz7rmO8bWK0dgsvHlrS1hemegIRKbYma papercusp-workspace-host-clean-room-fixture (private key discarded at generation)";
const WORKSPACE_HOST_IMAGE_ACTIONS = [
  "install",
  "upgrade",
  "rollback"
];
const WORKSPACE_HOST_IMAGE_LIFECYCLE_STATES = [
  "active",
  "deprecated",
  "withdrawn"
];
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const REGISTRY_IMAGE = /^[a-z0-9][a-z0-9._-]*(?::\d{1,5})?(?:\/[a-z0-9][a-z0-9._-]*)+(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/;
const DAY_MS = 24 * 60 * 60 * 1e3;
function workspaceHostImageModel(artifact) {
  return artifact.hostModel ?? __vite_ssr_import_2__.DEFAULT_WORKSPACE_HOST_MODEL;
};
function compatibilityModel(value) {
  return value.hostModel ?? __vite_ssr_import_2__.DEFAULT_WORKSPACE_HOST_MODEL;
}
function compatibilityPlatform(value) {
  return compatibilityModel(value) === "bootc-image" ? value.bootcBaseImage ?? "" : value.ubuntuVersion ?? "";
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireText(value, path, errors) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} must be a non-empty string`);
  }
}
function timestamp(value, path, errors) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) errors.push(`${path} must be an ISO timestamp`);
  return parsed;
}
function sameImage(left, right) {
  return isRecord(left) && isRecord(right) && left.id === right.id && left.version === right.version;
}
function validateWorkspaceHostImageArtifact(artifact) {
  const errors = [];
  if (!isRecord(artifact)) {
    return ["artifact must be an object"];
  };
  if (artifact.contractVersion !== WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION) {
    errors.push(
      `contractVersion must be '${WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION}'`
    );
  };
  const section = (value, path) => {
    const present = isRecord(value);
    if (!present) errors.push(`${path} must be an object`);
    return present;
  };
  const listSection = (value, path) => {
    const present = Array.isArray(value);
    if (!present) errors.push(`${path} must be an array`);
    return present;
  };
  const hasImage = section(artifact.image, "image");
  const hasManifest = section(artifact.buildManifest, "buildManifest");
  const hasRelease = section(artifact.release, "release");
  const hasLifecycle = section(artifact.lifecycle, "lifecycle");
  const hasCompatibility = listSection(artifact.compatibility, "compatibility");
  const hostModel = workspaceHostImageModel(artifact);
  if (!__vite_ssr_import_2__.WORKSPACE_HOST_MODELS.includes(hostModel)) {
    errors.push(`unsupported hostModel '${String(hostModel)}'`);
  };
  const bootc = artifact.bootc;
  const bootcRecord = isRecord(bootc) ? bootc : void 0;
  if (hostModel === "bootc-image") {
    if (!section(bootc, "bootc")) {
    } else {
      if (typeof bootcRecord?.image !== "string" || !REGISTRY_IMAGE.test(bootcRecord.image)) {
        errors.push("bootc.image must be a registry-qualified tagged image reference");
      };
      if (typeof bootcRecord?.imageDigest !== "string" || !IMAGE_DIGEST.test(bootcRecord.imageDigest)) {
        errors.push("bootc.imageDigest must be a lowercase sha256 manifest digest");
      };
      if (typeof bootcRecord?.baseImage !== "string" || !REGISTRY_IMAGE.test(bootcRecord.baseImage)) {
        errors.push("bootc.baseImage must be a registry-qualified image reference");
      };
      if (bootcRecord?.signaturePolicyPath !== __vite_ssr_import_2__.WORKSPACE_HOST_CONTAINERS_POLICY_PATH) {
        errors.push(
          `bootc.signaturePolicyPath must be '${__vite_ssr_import_2__.WORKSPACE_HOST_CONTAINERS_POLICY_PATH}'`
        );
      }
    }
  } else if (bootc !== void 0) {
    errors.push("bootc is valid only when hostModel is 'bootc-image'");
  };
  if (hasImage) {
    requireText(artifact.image.id, "image.id", errors);
    requireText(artifact.image.version, "image.version", errors);
  };
  if (hasManifest) {
    const manifest = (0,__vite_ssr_import_1__.verifyWorkspaceHostBuildManifest)(artifact.buildManifest);
    if (!manifest.ok) {
      errors.push(...manifest.errors.map((error) => `buildManifest: ${error}`));
    }
  };
  const buildManifest = hasManifest ? artifact.buildManifest : void 0;
  const releaseArtifactValue = buildManifest?.releaseArtifact;
  const baseImageValue = buildManifest?.baseImage;
  const materialsValue = buildManifest?.materials;
  const targetsValue = buildManifest?.targets;
  section(releaseArtifactValue, "buildManifest.releaseArtifact");
  section(baseImageValue, "buildManifest.baseImage");
  listSection(materialsValue, "buildManifest.materials");
  listSection(targetsValue, "buildManifest.targets");
  const releaseArtifact = isRecord(releaseArtifactValue) ? releaseArtifactValue : void 0;
  const baseImage = isRecord(baseImageValue) ? baseImageValue : void 0;
  const materials = Array.isArray(materialsValue) ? materialsValue : void 0;
  const targets = Array.isArray(targetsValue) ? targetsValue : void 0;
  if (materials !== void 0) {
    materials.forEach((material, index) => {
      if (!isRecord(material)) {
        errors.push(`buildManifest.materials[${index}] must be an object`);
      }
    });
  };
  if (targets !== void 0) {
    targets.forEach((target, index) => {
      if (!isRecord(target)) {
        errors.push(`buildManifest.targets[${index}] must be an object`);
      }
    });
  };
  if (hasImage && hasManifest && releaseArtifact !== void 0 && artifact.image.version !== releaseArtifact.version) {
    errors.push(
      "image.version must equal buildManifest.releaseArtifact.version"
    );
  };
  if (hasImage && hasRelease && artifact.release.version !== artifact.image.version) {
    errors.push("release.version must equal image.version");
  };
  if (!hasImage || !hasManifest || !hasRelease || !hasLifecycle || !hasCompatibility) {
    return errors;
  };
  const release = artifact.release;
  const canVerifyReleaseProvenance = releaseArtifact !== void 0 && materials !== void 0 && typeof releaseArtifact.sha256 === "string" && typeof releaseArtifact.version === "string" && materials.every(isRecord) && typeof release.version === "string" && typeof release.bundleSha256 === "string" && typeof release.bundleUrl === "string" && typeof release.signatureUrl === "string";
  if (canVerifyReleaseProvenance) {
    const provenance = (0,__vite_ssr_import_1__.verifyWorkspaceHostReleaseProvenance)(
      artifact.buildManifest,
      artifact.release
    );
    if (!provenance.ok) {
      errors.push(
        ...provenance.errors.filter((error) => !error.startsWith("manifest is not self-consistent:")).map((error) => `release provenance: ${error}`)
      );
    }
  };
  if (typeof release.signingKeySha256 !== "string" || !SHA256.test(release.signingKeySha256)) {
    errors.push("release.signingKeySha256 must be a lowercase SHA-256 digest");
  };
  requireText(
    release.signingPublicKey,
    "release.signingPublicKey",
    errors
  );
  if (typeof release.signingPublicKey === "string" && typeof release.signingKeySha256 === "string" && (0,__vite_ssr_import_0__.createHash)("sha256").update(release.signingPublicKey, "utf8").digest("hex") !== release.signingKeySha256) {
    errors.push(
      "release.signingKeySha256 must equal the SHA-256 of signingPublicKey"
    );
  };
  const lifecycle = artifact.lifecycle;
  const lifecycleState = lifecycle.state;
  const publishedAt = timestamp(
    lifecycle.publishedAt,
    "lifecycle.publishedAt",
    errors
  );
  const deprecatedAt = lifecycle.deprecatedAt ? timestamp(
    lifecycle.deprecatedAt,
    "lifecycle.deprecatedAt",
    errors
  ) : void 0;
  const supportEndsAt = lifecycle.supportEndsAt ? timestamp(
    lifecycle.supportEndsAt,
    "lifecycle.supportEndsAt",
    errors
  ) : void 0;
  if (!WORKSPACE_HOST_IMAGE_LIFECYCLE_STATES.includes(
    lifecycleState
  )) {
    errors.push(`unsupported lifecycle.state '${String(lifecycleState)}'`);
  };
  if (lifecycleState === "active" && deprecatedAt !== void 0) {
    errors.push("active artifacts must not carry lifecycle.deprecatedAt");
  };
  if (lifecycleState !== "active" && deprecatedAt === void 0) {
    errors.push(
      "deprecated/withdrawn artifacts require lifecycle.deprecatedAt"
    );
  };
  if (deprecatedAt !== void 0 && Number.isFinite(publishedAt) && deprecatedAt < publishedAt) {
    errors.push("lifecycle.deprecatedAt must not predate publishedAt");
  };
  if (supportEndsAt !== void 0 && Number.isFinite(publishedAt) && supportEndsAt < publishedAt) {
    errors.push("lifecycle.supportEndsAt must not predate publishedAt");
  };
  if (lifecycleState === "deprecated" && !lifecycle.successor) {
    errors.push("deprecated artifacts require an exact lifecycle.successor");
  };
  if (sameImage(artifact.image, lifecycle.successor)) {
    errors.push("lifecycle.successor must differ from the current image");
  };
  if (sameImage(artifact.image, lifecycle.rollbackTarget)) {
    errors.push("lifecycle.rollbackTarget must differ from the current image");
  };
  for (const [name, ref] of [
    ["lifecycle.successor", lifecycle.successor],
    ["lifecycle.rollbackTarget", lifecycle.rollbackTarget]
  ]) {
    if (ref !== void 0) {
      if (!isRecord(ref)) {
        errors.push(`${name} must be an object`);
      } else {
        requireText(ref.id, `${name}.id`, errors);
        requireText(ref.version, `${name}.version`, errors);
      }
    }
  };
  const compatibility = artifact.compatibility;
  if (compatibility.length === 0) {
    errors.push("compatibility must contain at least one matrix row");
  };
  const targetProviders = new Set(
    (targets ?? []).map(
      (target) => isRecord(target) ? target.provider : void 0
    )
  );
  const seen = /* @__PURE__ */ new Set();
  compatibility.forEach((rawRule, index) => {
    if (!isRecord(rawRule)) {
      errors.push(`compatibility[${index}] must be an object`);
      return;
    };
    const rule = rawRule;
    const ruleHostModel = compatibilityModel(rule);
    requireText(rule.provider, `compatibility[${index}].provider`, errors);
    requireText(
      rule.architecture,
      `compatibility[${index}].architecture`,
      errors
    );
    if (!targetProviders.has(rule.provider)) {
      errors.push(
        `compatibility[${index}].provider '${rule.provider}' is absent from buildManifest.targets`
      );
    };
    if (rule.architecture !== (baseImage !== void 0 ? baseImage.architecture : void 0)) {
      errors.push(
        `compatibility[${index}].architecture must equal buildManifest.baseImage.architecture`
      );
    };
    if (ruleHostModel !== hostModel) {
      errors.push(`compatibility[${index}].hostModel must equal artifact hostModel '${hostModel}'`);
    };
    if (ruleHostModel === "ubuntu-release-bundle") {
      if (rule.ubuntuVersion !== __vite_ssr_import_2__.WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION) {
        errors.push(
          `compatibility[${index}].ubuntuVersion must be '${__vite_ssr_import_2__.WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION}'`
        );
      };
      if (rule.bootcBaseImage !== void 0) {
        errors.push(`compatibility[${index}].bootcBaseImage is invalid for the Ubuntu host model`);
      }
    } else {
      if (typeof rule.bootcBaseImage !== "string" || !REGISTRY_IMAGE.test(rule.bootcBaseImage)) {
        errors.push(`compatibility[${index}].bootcBaseImage must be a registry-qualified image reference`);
      };
      if (rule.bootcBaseImage !== bootcRecord?.baseImage) {
        errors.push(`compatibility[${index}].bootcBaseImage must equal bootc.baseImage`);
      };
      if (rule.ubuntuVersion !== void 0) {
        errors.push(`compatibility[${index}].ubuntuVersion is invalid for the bootc host model`);
      }
    };
    if (rule.bootstrapContractVersion !== __vite_ssr_import_2__.WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION) {
      errors.push(
        `compatibility[${index}].bootstrapContractVersion must be '${__vite_ssr_import_2__.WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION}'`
      );
    };
    if (!Array.isArray(rule.actions)) {
      errors.push(`compatibility[${index}].actions must be an array`);
    } else {
      if (rule.actions.length === 0) {
        errors.push(`compatibility[${index}].actions must not be empty`);
      };
      const uniqueActions = new Set(rule.actions);
      if (uniqueActions.size !== rule.actions.length || rule.actions.some(
        (action) => !WORKSPACE_HOST_IMAGE_ACTIONS.includes(action)
      )) {
        errors.push(
          `compatibility[${index}].actions must contain unique supported actions`
        );
      }
    };
    if (rule.maximumArtifactAgeDays !== void 0 && (!Number.isSafeInteger(rule.maximumArtifactAgeDays) || rule.maximumArtifactAgeDays <= 0)) {
      errors.push(
        `compatibility[${index}].maximumArtifactAgeDays must be a positive integer`
      );
    };
    const key = [
      rule.provider,
      rule.architecture,
      ruleHostModel,
      compatibilityPlatform(rule),
      typeof rule.bootstrapContractVersion === "string" ? rule.bootstrapContractVersion : ""
    ].join("\0");
    if (seen.has(key)) {
      errors.push(`compatibility contains duplicate matrix row ${index}`);
    };
    seen.add(key);
  });
  return errors;
};
function evaluateWorkspaceHostImageCompatibility(artifact, request) {
  const issues = [];
  const invalid = validateWorkspaceHostImageArtifact(artifact);
  if (invalid.length > 0) {
    return {
      compatible: false,
      issues: invalid.map((message) => ({
        code: "invalid-artifact",
        message
      }))
    };
  };
  const observedAt = Date.parse(request.observedAt);
  if (!Number.isFinite(observedAt)) {
    return {
      compatible: false,
      issues: [
        {
          code: "invalid-observed-at",
          message: "observedAt must be an ISO timestamp"
        }
      ]
    };
  };
  const requestHostModel = compatibilityModel(request);
  const requestPlatform = requestHostModel === "bootc-image" ? request.bootcBaseImage : request.ubuntuVersion;
  const matchedRule = artifact.compatibility.find(
    (rule) => rule.provider === request.provider && rule.architecture === request.architecture && compatibilityModel(rule) === requestHostModel && compatibilityPlatform(rule) === requestPlatform && rule.bootstrapContractVersion === __vite_ssr_import_2__.WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION
  );
  if (!matchedRule) {
    return {
      compatible: false,
      issues: [
        {
          code: "matrix-miss",
          message: `No compatibility row matches ${request.provider}/${request.architecture}/${requestHostModel}/${requestPlatform}`
        }
      ]
    };
  };
  if (!matchedRule.actions.includes(request.action)) {
    issues.push({
      code: "action-not-supported",
      message: `Compatibility row does not allow '${request.action}'`
    });
  };
  const publishedAt = Date.parse(artifact.lifecycle.publishedAt);
  if (observedAt < publishedAt) {
    issues.push({
      code: "artifact-not-yet-published",
      message: "Artifact publication time is later than observedAt"
    });
  };
  if (artifact.lifecycle.state === "withdrawn") {
    issues.push({
      code: "withdrawn-artifact",
      message: "Withdrawn artifacts are never installable, upgradeable, or rollback targets"
    });
  } else if (artifact.lifecycle.state === "deprecated" && request.action !== "rollback") {
    issues.push({
      code: "deprecated-artifact",
      message: "Deprecated artifacts are accepted only through an explicit rollback edge"
    });
  };
  if (artifact.lifecycle.supportEndsAt && observedAt > Date.parse(artifact.lifecycle.supportEndsAt)) {
    issues.push({
      code: "support-ended",
      message: `Artifact support ended at ${artifact.lifecycle.supportEndsAt}`
    });
  };
  if (request.action !== "rollback" && matchedRule.maximumArtifactAgeDays !== void 0 && observedAt - publishedAt > matchedRule.maximumArtifactAgeDays * DAY_MS) {
    issues.push({
      code: "stale-artifact",
      message: `Artifact exceeds the ${matchedRule.maximumArtifactAgeDays}-day freshness ceiling`
    });
  };
  if (request.action === "rollback") {
    if (!request.currentArtifact) {
      issues.push({
        code: "rollback-source-missing",
        message: "Rollback requires the currently installed artifact metadata"
      });
    } else {
      const invalidCurrentArtifact = validateWorkspaceHostImageArtifact(
        request.currentArtifact
      );
      if (invalidCurrentArtifact.length > 0) {
        issues.push(
          ...invalidCurrentArtifact.map((message) => ({
            code: "invalid-artifact",
            message: `currentArtifact: ${message}`
          }))
        );
      } else if (!sameImage(
        request.currentArtifact.lifecycle.rollbackTarget,
        artifact.image
      )) {
        issues.push({
          code: "rollback-target-mismatch",
          message: `Current image ${request.currentArtifact.image.id}@${request.currentArtifact.image.version} does not name ${artifact.image.id}@${artifact.image.version} as its rollback target`
        });
      }
    }
  };
  return { compatible: issues.length === 0, matchedRule, issues };
};
function fixtureBootstrapInput(artifact, spec) {
  const hostModel = workspaceHostImageModel(artifact);
  const bootc = artifact.hostModel === "bootc-image" ? artifact.bootc : void 0;
  if (hostModel === "bootc-image" && !bootc) {
    throw new Error("bootc image artifact is missing its image identity");
  };
  return {
    contractVersion: __vite_ssr_import_2__.WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
    action: spec.action,
    hostId: spec.hostId,
    hostModel,
    ...hostModel === "bootc-image" ? {
      bootc: {
        image: bootc.image,
        imageDigest: bootc.imageDigest,
        baseImage: bootc.baseImage,
        signaturePolicyPath: bootc.signaturePolicyPath
      }
    } : {},
    release: artifact.release,
    migrationId: spec.migrationId,
    minimumNodeMajor: spec.minimumNodeMajor,
    service: spec.service,
    isolation: spec.isolation,
    ...spec.agentRuntimeInstalls ? { agentRuntimeInstalls: spec.agentRuntimeInstalls } : {},
    ...spec.statusChannel ? { statusChannel: spec.statusChannel } : {},
    workspaceAuthorizedKeys: spec.workspaceAuthorizedKeys?.length ? spec.workspaceAuthorizedKeys : [WORKSPACE_HOST_CLEAN_ROOM_AUTHORIZED_KEY],
    entrypoints: spec.entrypoints,
    publicMetadata: {
      ...spec.publicMetadata,
      imageAcceptance: {
        fixtureId: spec.fixtureId,
        provider: spec.provider,
        architecture: spec.architecture,
        imageId: artifact.image.id,
        imageVersion: artifact.image.version,
        manifestIdentity: artifact.buildManifest.manifestIdentity
      }
    }
  };
}
function cleanRoomCompatibilityRequest(artifact, spec) {
  const hostModel = spec.hostModel ?? workspaceHostImageModel(artifact);
  const common = {
    action: spec.action,
    provider: spec.provider,
    architecture: spec.architecture,
    observedAt: spec.observedAt,
    currentArtifact: spec.currentArtifact
  };
  return hostModel === "bootc-image" ? {
    ...common,
    hostModel,
    bootcBaseImage: spec.bootcBaseImage ?? (artifact.hostModel === "bootc-image" ? artifact.bootc.baseImage : __vite_ssr_import_2__.WORKSPACE_HOST_BOOTC_BASE_IMAGE)
  } : {
    ...common,
    hostModel,
    ubuntuVersion: __vite_ssr_import_2__.WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION
  };
}
function buildWorkspaceHostCleanRoomInstallFixture(artifact, spec) {
  const compatibility = evaluateWorkspaceHostImageCompatibility(
    artifact,
    cleanRoomCompatibilityRequest(artifact, spec)
  );
  if (!compatibility.compatible) {
    throw new Error(
      `Workspace-host image is incompatible: ${compatibility.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`
    );
  };
  const fixtureErrors = [];
  requireText(spec.fixtureId, "fixtureId", fixtureErrors);
  if (fixtureErrors.length > 0) {
    throw new Error(fixtureErrors.join("; "));
  };
  const bootstrapInput = fixtureBootstrapInput(artifact, spec);
  const bootstrapScript = (0,__vite_ssr_import_2__.buildWorkspaceHostBootstrap)(bootstrapInput);
  return {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    fixtureId: spec.fixtureId,
    image: artifact.image,
    manifestIdentity: artifact.buildManifest.manifestIdentity,
    bootstrapInput,
    bootstrapScript,
    bootstrapScriptSha256: (0,__vite_ssr_import_0__.createHash)("sha256").update(bootstrapScript, "utf8").digest("hex")
  };
};
async function runWorkspaceHostCleanRoomAcceptance(artifact, spec, executor) {
  const compatibility = evaluateWorkspaceHostImageCompatibility(
    artifact,
    cleanRoomCompatibilityRequest(artifact, spec)
  );
  const base = {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    fixtureId: spec.fixtureId,
    image: artifact.image
  };
  if (!compatibility.compatible) {
    return { ...base, passed: false, checks: [], issues: compatibility.issues };
  };
  let fixture;
  try {
    fixture = buildWorkspaceHostCleanRoomInstallFixture(artifact, spec);
    const replay = buildWorkspaceHostCleanRoomInstallFixture(artifact, spec);
    if (fixture.bootstrapScript !== replay.bootstrapScript || fixture.bootstrapScriptSha256 !== replay.bootstrapScriptSha256) {
      throw new Error("clean-room bootstrap fixture is not deterministic");
    }
  } catch (error) {
    return {
      ...base,
      passed: false,
      checks: ["artifact-identity", "compatibility-matrix"],
      issues: [
        {
          code: "invalid-artifact",
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    };
  };
  try {
    const result = await executor.execute(fixture);
    const attestation = (0,__vite_ssr_import_2__.parseWorkspaceHostBootstrapAttestation)(result.stdout);
    const validation = (0,__vite_ssr_import_2__.validateWorkspaceHostBootstrapAttestation)(
      attestation,
      fixture.bootstrapInput
    );
    if (!validation.ok) {
      return {
        ...base,
        passed: false,
        checks: [
          "artifact-identity",
          "compatibility-matrix",
          "deterministic-bootstrap-fixture"
        ],
        issues: validation.errors.map((message) => ({
          code: "invalid-artifact",
          message: `clean-room attestation: ${message}`
        })),
        bootstrapScriptSha256: fixture.bootstrapScriptSha256,
        attestation
      };
    };
    return {
      ...base,
      passed: true,
      checks: [
        "artifact-identity",
        "compatibility-matrix",
        "deterministic-bootstrap-fixture",
        "exact-bootstrap-attestation"
      ],
      issues: [],
      bootstrapScriptSha256: fixture.bootstrapScriptSha256,
      attestation
    };
  } catch (error) {
    return {
      ...base,
      passed: false,
      checks: [
        "artifact-identity",
        "compatibility-matrix",
        "deterministic-bootstrap-fixture"
      ],
      issues: [
        {
          code: "invalid-artifact",
          message: `clean-room execution: ${error instanceof Error ? error.message : String(error)}`
        }
      ],
      bootstrapScriptSha256: fixture.bootstrapScriptSha256
    };
  }
};
function workspaceHostCleanRoomFixtureAttestation(fixture, observedAt, nodeMajor = fixture.bootstrapInput.minimumNodeMajor) {
  const serviceUser = fixture.bootstrapInput.service.user ?? __vite_ssr_import_2__.DEFAULT_WORKSPACE_HOST_SERVICE_USER;
  const serviceGroup = fixture.bootstrapInput.service.group ?? serviceUser;
  const workspaceUser = fixture.bootstrapInput.isolation?.workspaceUser ?? __vite_ssr_import_2__.DEFAULT_WORKSPACE_HOST_WORKSPACE_USER;
  const workspaceGroup = fixture.bootstrapInput.isolation?.workspaceGroup ?? workspaceUser;
  const agentUser = fixture.bootstrapInput.isolation?.agentUser ?? __vite_ssr_import_2__.DEFAULT_WORKSPACE_HOST_AGENT_USER;
  const agentGroup = fixture.bootstrapInput.isolation?.agentGroup ?? agentUser;
  const common = {
    contractVersion: __vite_ssr_import_2__.WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
    hostId: fixture.bootstrapInput.hostId,
    action: fixture.bootstrapInput.action,
    observedAt,
    status: "healthy",
    migration: { id: fixture.bootstrapInput.migrationId, applied: true },
    runtime: {
      nodeMajor,
      minimumNodeMajor: fixture.bootstrapInput.minimumNodeMajor,
      psu: true,
      pui: true,
      agentLaunchers: { claude: true, codex: true, omp: true },
      // A clean-room image is validated before any host provisioning runs, so no vendor agent
      // runtime has been installed at this point (D-259). False is the accurate reading, not a
      // placeholder — the fixture must not claim a capability the image does not carry.
      agentRuntimesInstalledByBootstrap: false,
      agentRuntimesVerifiedByBootstrap: false
    },
    service: {
      name: fixture.bootstrapInput.service.name,
      user: serviceUser,
      group: serviceGroup,
      bindHost: "127.0.0.1",
      port: fixture.bootstrapInput.service.port,
      active: true
    },
    isolation: {
      workspaceUser,
      workspaceGroup,
      agentUser,
      agentGroup,
      runtimeRoot: __vite_ssr_import_2__.WORKSPACE_HOST_RUNTIME_ROOT,
      stateRoot: __vite_ssr_import_2__.WORKSPACE_HOST_STATE_ROOT,
      workspaceRoot: __vite_ssr_import_2__.WORKSPACE_HOST_DATA_ROOT,
      runtimeReadableByWorkspaceUser: false,
      runtimeWritableByWorkspaceUser: false,
      runtimeReadableByAgentUser: true,
      runtimeWritableByAgentUser: false,
      agentHomeReadableBySshUser: false,
      workspaceWritableByService: true,
      workspaceWritableBySshUser: true,
      workspaceWritableByAgentUser: true,
      sudo: false,
      serviceGroupMember: false,
      operatorIngress: "ssh-local-forward"
    }
  };
  if (fixture.bootstrapInput.hostModel === "bootc-image") {
    const bootc = fixture.bootstrapInput.bootc;
    if (!bootc) throw new Error("bootc clean-room fixture is missing its image identity");
    return {
      ...common,
      hostModel: "bootc-image",
      bootcBaseImage: bootc.baseImage ?? __vite_ssr_import_2__.WORKSPACE_HOST_BOOTC_BASE_IMAGE,
      release: {
        version: fixture.bootstrapInput.release.version,
        // What `bootc status` reports on a correct host: the digest-pinned ref (WI-10006339).
        source: (0,__vite_ssr_import_2__.workspaceHostBootcPinnedImageRef)(bootc),
        imageDigest: bootc.imageDigest,
        signaturePolicyPath: bootc.signaturePolicyPath,
        signatureVerified: true
      },
      isolation: {
        ...common.isolation,
        updateMode: "bootc-atomic-image-swap"
      },
      checks: (0,__vite_ssr_import_2__.workspaceHostBootstrapChecks)("bootc-image").map((name) => ({
        name,
        ok: true
      }))
    };
  };
  return {
    ...common,
    hostModel: "ubuntu-release-bundle",
    ubuntuVersion: __vite_ssr_import_2__.WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
    release: {
      version: fixture.bootstrapInput.release.version,
      source: fixture.bootstrapInput.release.bundleUrl,
      bundleSha256: fixture.bootstrapInput.release.bundleSha256,
      signingKeySha256: fixture.bootstrapInput.release.signingKeySha256,
      signatureVerified: true
    },
    isolation: {
      ...common.isolation,
      updateMode: "signed-atomic-release-swap"
    },
    checks: (0,__vite_ssr_import_2__.workspaceHostBootstrapChecks)("ubuntu-release-bundle").map((name) => ({
      name,
      ok: true
    }))
  };
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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LHVCQUF1QixFQUFFLElBQUksQ0FBQyxVQUFVO0FBQUEsTUFDM0U7QUFBQSxNQUNBLElBQUk7QUFBQSxJQUNOLEVBQUU7QUFBQSxFQUNKO0FBQ0YiLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbIndvcmtzcGFjZS1ob3N0LWltYWdlLnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcblxuaW1wb3J0IHR5cGUgeyBXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdCB9IGZyb20gXCIuL3dvcmtzcGFjZS1ob3N0LWJ1aWxkLW1hbmlmZXN0XCI7XG5pbXBvcnQge1xuICB2ZXJpZnlXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdCxcbiAgdmVyaWZ5V29ya3NwYWNlSG9zdFJlbGVhc2VQcm92ZW5hbmNlLFxufSBmcm9tIFwiLi93b3Jrc3BhY2UtaG9zdC1idWlsZC1tYW5pZmVzdFwiO1xuaW1wb3J0IHtcbiAgREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9NT0RFTCxcbiAgV09SS1NQQUNFX0hPU1RfQk9PVENfQkFTRV9JTUFHRSxcbiAgREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9BR0VOVF9VU0VSLFxuICBERUZBVUxUX1dPUktTUEFDRV9IT1NUX1NFUlZJQ0VfVVNFUixcbiAgREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9XT1JLU1BBQ0VfVVNFUixcbiAgd29ya3NwYWNlSG9zdEJvb3RzdHJhcENoZWNrcyxcbiAgV09SS1NQQUNFX0hPU1RfQk9PVFNUUkFQX0NPTlRSQUNUX1ZFUlNJT04sXG4gIFdPUktTUEFDRV9IT1NUX0JPT1RTVFJBUF9VQlVOVFVfVkVSU0lPTixcbiAgV09SS1NQQUNFX0hPU1RfQ09OVEFJTkVSU19QT0xJQ1lfUEFUSCxcbiAgV09SS1NQQUNFX0hPU1RfREFUQV9ST09ULFxuICBXT1JLU1BBQ0VfSE9TVF9NT0RFTFMsXG4gIFdPUktTUEFDRV9IT1NUX1JVTlRJTUVfUk9PVCxcbiAgV09SS1NQQUNFX0hPU1RfU1RBVEVfUk9PVCxcbiAgYnVpbGRXb3Jrc3BhY2VIb3N0Qm9vdHN0cmFwLFxuICBwYXJzZVdvcmtzcGFjZUhvc3RCb290c3RyYXBBdHRlc3RhdGlvbixcbiAgdmFsaWRhdGVXb3Jrc3BhY2VIb3N0Qm9vdHN0cmFwQXR0ZXN0YXRpb24sXG4gIHR5cGUgV29ya3NwYWNlSG9zdEJvb3RzdHJhcEF0dGVzdGF0aW9uLFxuICB0eXBlIFdvcmtzcGFjZUhvc3RCb290c3RyYXBFbnRyeXBvaW50cyxcbiAgdHlwZSBXb3Jrc3BhY2VIb3N0QWdlbnRSdW50aW1lSW5zdGFsbCxcbiAgdHlwZSBXb3Jrc3BhY2VIb3N0Qm9vdHN0cmFwSW5wdXQsXG4gIHR5cGUgV29ya3NwYWNlSG9zdEJvb3RzdHJhcElzb2xhdGlvbixcbiAgdHlwZSBXb3Jrc3BhY2VIb3N0Qm9vdHN0cmFwUmVsZWFzZSxcbiAgdHlwZSBXb3Jrc3BhY2VIb3N0Qm9vdHN0cmFwU2VydmljZSxcbiAgdHlwZSBXb3Jrc3BhY2VIb3N0Qm9vdHN0cmFwU3RhdHVzQ2hhbm5lbCxcbiAgdHlwZSBXb3Jrc3BhY2VIb3N0TW9kZWwsXG4gIHdvcmtzcGFjZUhvc3RCb290Y1Bpbm5lZEltYWdlUmVmLFxufSBmcm9tIFwiLi93b3Jrc3BhY2UtaG9zdC1ib290c3RyYXBcIjtcbmltcG9ydCB0eXBlIHtcbiAgV29ya3NwYWNlSG9zdEltYWdlUmVmLFxuICBXb3Jrc3BhY2VIb3N0UHJvdmlkZXJUYXJnZXQsXG59IGZyb20gXCIuL3dvcmtzcGFjZS1ob3N0LXR5cGVzXCI7XG5cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9JTUFHRV9BQ0NFUFRBTkNFX0NPTlRSQUNUX1ZFUlNJT04gPVxuICBcInBhcGVyY3VzcC13b3Jrc3BhY2UtaG9zdC1pbWFnZS1hY2NlcHRhbmNlLXYxXCI7XG5cbi8qKlxuICogVGhlIGF1dGhvcml6ZWQga2V5IHRoZSBDTEVBTi1ST09NIGZpeHR1cmUgaW5zdGFsbHMgd2hlbiBhIHNwZWMgZG9lcyBub3QgbmFtZSBvbmUuXG4gKlxuICogSXQgaXMgYSBmaXhlZCBsaXRlcmFsIG9uIHB1cnBvc2UuIFRoZSBnYXRlIGNvbXBhcmVzIGBib290c3RyYXBTY3JpcHRTaGEyNTZgIHRvIHByb3ZlIHRoZVxuICogZml4dHVyZSBpcyBkZXRlcm1pbmlzdGljLCBzbyB0aGUgc2NyaXB0IG11c3Qgbm90IHZhcnkgd2l0aCBlbnZpcm9ubWVudC1zcGVjaWZpYyBrZXkgbWF0ZXJpYWw7XG4gKiBzdWJzdGl0dXRpbmcgYSByZWFsIGNvbnRyb2xsZXIga2V5IGhlcmUgd291bGQgbWFrZSB0aGF0IGNoZWNrIGZhaWwgYWNyb3NzIGVudmlyb25tZW50cyBmb3IgYVxuICogcmVhc29uIHRoYXQgaGFzIG5vdGhpbmcgdG8gZG8gd2l0aCB0aGUgaW1hZ2UuXG4gKlxuICogSXRzIHByaXZhdGUgaGFsZiB3YXMgZ2VuZXJhdGVkIGFuZCBkZXN0cm95ZWQgaW4gdGhlIHNhbWUgY29tbWFuZCBhbmQgd2FzIG5ldmVyIHJlY29yZGVkLCBzbyBpdFxuICogYXV0aG9yaXplcyBub2JvZHkuIFRoYXQgaXMgdGhlIHBvaW50OiB0aGUgY2xlYW4tcm9vbSBWTSBzdGlsbCBleGVyY2lzZXMgdGhlIHJlYWxcbiAqIGF1dGhvcml6ZWRfa2V5cyByZW5kZXJpbmcgcGF0aCDigJQgc28gYSByZWdyZXNzaW9uIGluIGl0IGZhaWxzIHRoZSBnYXRlIOKAlCB3aXRob3V0IGdyYW50aW5nIGFjY2Vzc1xuICogdG8gYW55dGhpbmcuIFByb2R1Y3Rpb24gcHJvdmlzaW9uaW5nIHBhc3NlcyB0aGUgY29udHJvbGxlcidzIGFjdHVhbCBwdWJsaWMga2V5IGluc3RlYWQuXG4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9DTEVBTl9ST09NX0FVVEhPUklaRURfS0VZID1cbiAgXCJzc2gtZWQyNTUxOSBBQUFBQzNOemFDMWxaREkxTlRFNUFBQUFJQVJ1cjZsTHh4Ky9pejdybU84YldLMGRnc3ZIbHJTMWhlbWVnSVJLYlltYSBwYXBlcmN1c3Atd29ya3NwYWNlLWhvc3QtY2xlYW4tcm9vbS1maXh0dXJlIChwcml2YXRlIGtleSBkaXNjYXJkZWQgYXQgZ2VuZXJhdGlvbilcIjtcblxuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX0lNQUdFX0FDVElPTlMgPSBbXG4gIFwiaW5zdGFsbFwiLFxuICBcInVwZ3JhZGVcIixcbiAgXCJyb2xsYmFja1wiLFxuXSBhcyBjb25zdDtcbmV4cG9ydCB0eXBlIFdvcmtzcGFjZUhvc3RJbWFnZUFjdGlvbiA9XG4gICh0eXBlb2YgV09SS1NQQUNFX0hPU1RfSU1BR0VfQUNUSU9OUylbbnVtYmVyXTtcblxuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX0lNQUdFX0xJRkVDWUNMRV9TVEFURVMgPSBbXG4gIFwiYWN0aXZlXCIsXG4gIFwiZGVwcmVjYXRlZFwiLFxuICBcIndpdGhkcmF3blwiLFxuXSBhcyBjb25zdDtcbmV4cG9ydCB0eXBlIFdvcmtzcGFjZUhvc3RJbWFnZUxpZmVjeWNsZVN0YXRlID1cbiAgKHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9JTUFHRV9MSUZFQ1lDTEVfU1RBVEVTKVtudW1iZXJdO1xuXG5pbnRlcmZhY2UgV29ya3NwYWNlSG9zdEltYWdlQ29tcGF0aWJpbGl0eVJ1bGVCYXNlIHtcbiAgcHJvdmlkZXI6IFdvcmtzcGFjZUhvc3RQcm92aWRlclRhcmdldDtcbiAgYXJjaGl0ZWN0dXJlOiBzdHJpbmc7XG4gIGJvb3RzdHJhcENvbnRyYWN0VmVyc2lvbjogdHlwZW9mIFdPUktTUEFDRV9IT1NUX0JPT1RTVFJBUF9DT05UUkFDVF9WRVJTSU9OO1xuICBhY3Rpb25zOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0SW1hZ2VBY3Rpb25bXTtcbiAgLyoqIE9wdGlvbmFsIGZyZXNobmVzcyBjZWlsaW5nIGZvciBuZXcgaW5zdGFsbHMvdXBncmFkZXMuIFJvbGxiYWNrIHVzZXMgc3VwcG9ydEVuZHNBdCBpbnN0ZWFkLiAqL1xuICBtYXhpbXVtQXJ0aWZhY3RBZ2VEYXlzPzogbnVtYmVyO1xuICAvKipcbiAgICogVGhlIGFnZW50LWhvbWUgYnVuZGxlIGNvbnRyYWN0IHZlcnNpb25zIFRISVMgYnVuZGxlJ3MgaG9zdCBwcm9ncmFtIGNhbiBwYXJzZSwgZGVyaXZlZCBhdFxuICAgKiBidWlsZCB0aW1lIGZyb20gdGhlIHNvdXJjZSBiZWluZyBwYWNrYWdlZCAoV0ktMTAwMDE3NTEpLlxuICAgKlxuICAgKiBBbiBhZ2UgY2VpbGluZyBjYW5ub3QgYW5zd2VyIHRoaXMgcXVlc3Rpb24uIGBtYXhpbXVtQXJ0aWZhY3RBZ2VEYXlzYCBpcyAzMCwgYW5kIHRoZSByMzFcbiAgICogcHVibGljYXRpb24gd2FzIGN1dCAyMDI2LTA5LTA3VDA5OjE4WiDigJQgU0lYIEhPVVJTIEFORCBGSUZUWS1UV08gTUlOVVRFUyBiZWZvcmUgYWdlbnQtaG9tZVxuICAgKiBidW5kbGUgdjMgbGFuZGVkICg5NmIwZDI0OCwgMTY6MTBaIHRoZSBzYW1lIGRheSkuIFNvIGl0IHdhcyBhIHdlbGwgd2l0aGluLXBvbGljeSwgMTAtZGF5LW9sZCxcbiAgICogZnVsbHktc2lnbmVkIGFydGlmYWN0IHRoYXQgY291bGQgbm90IHBhcnNlIHRoZSBvbmx5IG1hdGVyaWFsIHRoZSBjb250cm9sbGVyIGlzIHBlcm1pdHRlZCB0b1xuICAgKiBzZW5kICh2MyBhbG9uZSBpcyBhZG1pc3Npb24tZWxpZ2libGUsIEQtMzExKS4gRnJlc2huZXNzIGluIERBWVMgY2Fubm90IHNlZSBhIHNrZXcgbWVhc3VyZWQgaW5cbiAgICogSE9VUlMgYWdhaW5zdCBhIGNvbnRyYWN0IGJvdW5kYXJ5OyBvbmx5IG5hbWluZyB0aGUgdmVyc2lvbnMgY2FuLlxuICAgKlxuICAgKiBBYnNlbnQgbWVhbnMgXCJ0aGlzIHB1YmxpY2F0aW9uIHByZWRhdGVzIHRoZSBkZWNsYXJhdGlvblwiLCBOT1QgXCJhbnkgdmVyc2lvbiBpcyBmaW5lXCIg4oCUIHNlZSB0aGVcbiAgICogcmVmdXNhbCBpbiBwcm92aXNpb24tYm9vdHN0cmFwLCB3aGljaCBmYWlscyBjbG9zZWQgb24gZXhhY3RseSB0aGF0IHJlYWRpbmcuXG4gICAqL1xuICBhZ2VudEhvbWVCdW5kbGVDb250cmFjdFZlcnNpb25zPzogcmVhZG9ubHkgc3RyaW5nW107XG59XG5cbi8qKiBPbmUgZXhhY3QgY2VsbCBpbiB0aGUgcHJvdmlkZXIgw5cgYXJjaGl0ZWN0dXJlIMOXIGhvc3QtbW9kZWwgYWNjZXB0YW5jZSBtYXRyaXguICovXG5leHBvcnQgdHlwZSBXb3Jrc3BhY2VIb3N0SW1hZ2VDb21wYXRpYmlsaXR5UnVsZSA9XG4gIFdvcmtzcGFjZUhvc3RJbWFnZUNvbXBhdGliaWxpdHlSdWxlQmFzZSAmXG4gICAgKFxuICAgICAgfCB7XG4gICAgICAgICAgLyoqIE9taXR0ZWQgcHJlc2VydmVzIHRoZSBzaGlwcGVkIHByZS1ib290YyBhcnRpZmFjdCB3aXJlIHNoYXBlLiAqL1xuICAgICAgICAgIGhvc3RNb2RlbD86IFwidWJ1bnR1LXJlbGVhc2UtYnVuZGxlXCI7XG4gICAgICAgICAgdWJ1bnR1VmVyc2lvbjogdHlwZW9mIFdPUktTUEFDRV9IT1NUX0JPT1RTVFJBUF9VQlVOVFVfVkVSU0lPTjtcbiAgICAgICAgICBib290Y0Jhc2VJbWFnZT86IG5ldmVyO1xuICAgICAgICB9XG4gICAgICB8IHtcbiAgICAgICAgICBob3N0TW9kZWw6IFwiYm9vdGMtaW1hZ2VcIjtcbiAgICAgICAgICBib290Y0Jhc2VJbWFnZTogc3RyaW5nO1xuICAgICAgICAgIHVidW50dVZlcnNpb24/OiBuZXZlcjtcbiAgICAgICAgfVxuICAgICk7XG5cbi8qKiBJbW11dGFibGUgbGlmZWN5Y2xlIGVkZ2VzLiBFdmVyeSByZWZlcmVuY2UgbmFtZXMgYm90aCBpbWFnZSBpZCBhbmQgdmVyc2lvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdEltYWdlTGlmZWN5Y2xlTWV0YWRhdGEge1xuICBzdGF0ZTogV29ya3NwYWNlSG9zdEltYWdlTGlmZWN5Y2xlU3RhdGU7XG4gIHB1Ymxpc2hlZEF0OiBzdHJpbmc7XG4gIGRlcHJlY2F0ZWRBdD86IHN0cmluZztcbiAgc3VwcG9ydEVuZHNBdD86IHN0cmluZztcbiAgc3VjY2Vzc29yPzogV29ya3NwYWNlSG9zdEltYWdlUmVmICYgeyB2ZXJzaW9uOiBzdHJpbmcgfTtcbiAgcm9sbGJhY2tUYXJnZXQ/OiBXb3Jrc3BhY2VIb3N0SW1hZ2VSZWYgJiB7IHZlcnNpb246IHN0cmluZyB9O1xufVxuXG4vKiogVGhlIE9DSSBpZGVudGl0eSBhIGJvb3RjIGhvc3QgYWN0dWFsbHkgYm9vdHMgYW5kIHZlcmlmaWVzIHRocm91Z2ggY29udGFpbmVycy9pbWFnZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdEJvb3RjSW1hZ2VJZGVudGl0eSB7XG4gIC8qKiBSZWdpc3RyeS1xdWFsaWZpZWQgdGFnZ2VkIHNvdXJjZSBpbWFnZTsgdGhlIGRpZ2VzdCBiZWxvdyBpcyB0aGUgaW1tdXRhYmxlIGlkZW50aXR5LiAqL1xuICBpbWFnZTogc3RyaW5nO1xuICBpbWFnZURpZ2VzdDogYHNoYTI1Njoke3N0cmluZ31gO1xuICBiYXNlSW1hZ2U6IHN0cmluZztcbiAgc2lnbmF0dXJlUG9saWN5UGF0aDogdHlwZW9mIFdPUktTUEFDRV9IT1NUX0NPTlRBSU5FUlNfUE9MSUNZX1BBVEg7XG59XG5cbmludGVyZmFjZSBXb3Jrc3BhY2VIb3N0SW1hZ2VBcnRpZmFjdEJhc2Uge1xuICBjb250cmFjdFZlcnNpb246IHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9JTUFHRV9BQ0NFUFRBTkNFX0NPTlRSQUNUX1ZFUlNJT047XG4gIGltYWdlOiBXb3Jrc3BhY2VIb3N0SW1hZ2VSZWYgJiB7IHZlcnNpb246IHN0cmluZyB9O1xuICBidWlsZE1hbmlmZXN0OiBXb3Jrc3BhY2VIb3N0QnVpbGRNYW5pZmVzdDtcbiAgcmVsZWFzZTogV29ya3NwYWNlSG9zdEJvb3RzdHJhcFJlbGVhc2U7XG4gIGxpZmVjeWNsZTogV29ya3NwYWNlSG9zdEltYWdlTGlmZWN5Y2xlTWV0YWRhdGE7XG4gIGNvbXBhdGliaWxpdHk6IHJlYWRvbmx5IFdvcmtzcGFjZUhvc3RJbWFnZUNvbXBhdGliaWxpdHlSdWxlW107XG59XG5cbi8qKlxuICogUHJvdmlkZXItbmV1dHJhbCBhY2NlcHRhbmNlIG1ldGFkYXRhIGFyb3VuZCBvbmUgaW1tdXRhYmxlIFZNIGltYWdlIHJlbGVhc2UuXG4gKiBUaGUgY2Fub25pY2FsIGJ1aWxkIG1hbmlmZXN0IG93bnMgcmVwcm9kdWNpYmxlIGlucHV0czsgdGhlIGJvb3RzdHJhcCByZWxlYXNlXG4gKiBvd25zIHRoZSBydW50aW1lIHBheWxvYWQ7IHRoZSBtb2RlbC1zcGVjaWZpYyBtZW1iZXIgb3ducyB0aGUgaG9zdCBpZGVudGl0eS5cbiAqL1xuZXhwb3J0IHR5cGUgV29ya3NwYWNlSG9zdEltYWdlQXJ0aWZhY3QgPSBXb3Jrc3BhY2VIb3N0SW1hZ2VBcnRpZmFjdEJhc2UgJlxuICAoXG4gICAgfCB7XG4gICAgICAgIC8qKiBPbWl0dGVkIHByZXNlcnZlcyB0aGUgc2hpcHBlZCBwcmUtYm9vdGMgYXJ0aWZhY3Qgd2lyZSBzaGFwZS4gKi9cbiAgICAgICAgaG9zdE1vZGVsPzogXCJ1YnVudHUtcmVsZWFzZS1idW5kbGVcIjtcbiAgICAgICAgYm9vdGM/OiBuZXZlcjtcbiAgICAgIH1cbiAgICB8IHtcbiAgICAgICAgaG9zdE1vZGVsOiBcImJvb3RjLWltYWdlXCI7XG4gICAgICAgIGJvb3RjOiBXb3Jrc3BhY2VIb3N0Qm9vdGNJbWFnZUlkZW50aXR5O1xuICAgICAgfVxuICApO1xuXG5leHBvcnQgdHlwZSBXb3Jrc3BhY2VIb3N0SW1hZ2VDb21wYXRpYmlsaXR5SXNzdWVDb2RlID1cbiAgfCBcImludmFsaWQtYXJ0aWZhY3RcIlxuICB8IFwiaW52YWxpZC1vYnNlcnZlZC1hdFwiXG4gIHwgXCJtYXRyaXgtbWlzc1wiXG4gIHwgXCJhY3Rpb24tbm90LXN1cHBvcnRlZFwiXG4gIHwgXCJhcnRpZmFjdC1ub3QteWV0LXB1Ymxpc2hlZFwiXG4gIHwgXCJzdGFsZS1hcnRpZmFjdFwiXG4gIHwgXCJkZXByZWNhdGVkLWFydGlmYWN0XCJcbiAgfCBcIndpdGhkcmF3bi1hcnRpZmFjdFwiXG4gIHwgXCJzdXBwb3J0LWVuZGVkXCJcbiAgfCBcInJvbGxiYWNrLXNvdXJjZS1taXNzaW5nXCJcbiAgfCBcInJvbGxiYWNrLXRhcmdldC1taXNtYXRjaFwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RJbWFnZUNvbXBhdGliaWxpdHlJc3N1ZSB7XG4gIGNvZGU6IFdvcmtzcGFjZUhvc3RJbWFnZUNvbXBhdGliaWxpdHlJc3N1ZUNvZGU7XG4gIG1lc3NhZ2U6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RJbWFnZUNvbXBhdGliaWxpdHlSZXF1ZXN0QmFzZSB7XG4gIGFjdGlvbjogV29ya3NwYWNlSG9zdEltYWdlQWN0aW9uO1xuICBwcm92aWRlcjogV29ya3NwYWNlSG9zdFByb3ZpZGVyVGFyZ2V0O1xuICBhcmNoaXRlY3R1cmU6IHN0cmluZztcbiAgb2JzZXJ2ZWRBdDogc3RyaW5nO1xuICAvKiogUmVxdWlyZWQgZm9yIHJvbGxiYWNrIHNvIHRoZSBjdXJyZW50IGltYWdlJ3MgaW1tdXRhYmxlIGVkZ2UgY2FuIGJlIGNoZWNrZWQuICovXG4gIGN1cnJlbnRBcnRpZmFjdD86IFdvcmtzcGFjZUhvc3RJbWFnZUFydGlmYWN0O1xufVxuXG5leHBvcnQgdHlwZSBXb3Jrc3BhY2VIb3N0SW1hZ2VDb21wYXRpYmlsaXR5UmVxdWVzdCA9XG4gIFdvcmtzcGFjZUhvc3RJbWFnZUNvbXBhdGliaWxpdHlSZXF1ZXN0QmFzZSAmXG4gICAgKFxuICAgICAgfCB7XG4gICAgICAgICAgaG9zdE1vZGVsPzogXCJ1YnVudHUtcmVsZWFzZS1idW5kbGVcIjtcbiAgICAgICAgICB1YnVudHVWZXJzaW9uOiB0eXBlb2YgV09SS1NQQUNFX0hPU1RfQk9PVFNUUkFQX1VCVU5UVV9WRVJTSU9OO1xuICAgICAgICAgIGJvb3RjQmFzZUltYWdlPzogbmV2ZXI7XG4gICAgICAgIH1cbiAgICAgIHwge1xuICAgICAgICAgIGhvc3RNb2RlbDogXCJib290Yy1pbWFnZVwiO1xuICAgICAgICAgIGJvb3RjQmFzZUltYWdlOiBzdHJpbmc7XG4gICAgICAgICAgdWJ1bnR1VmVyc2lvbj86IG5ldmVyO1xuICAgICAgICB9XG4gICAgKTtcblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0SW1hZ2VDb21wYXRpYmlsaXR5UmVzdWx0IHtcbiAgY29tcGF0aWJsZTogYm9vbGVhbjtcbiAgbWF0Y2hlZFJ1bGU/OiBXb3Jrc3BhY2VIb3N0SW1hZ2VDb21wYXRpYmlsaXR5UnVsZTtcbiAgaXNzdWVzOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0SW1hZ2VDb21wYXRpYmlsaXR5SXNzdWVbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0Q2xlYW5Sb29tSW5zdGFsbFNwZWMge1xuICBmaXh0dXJlSWQ6IHN0cmluZztcbiAgYWN0aW9uOiBXb3Jrc3BhY2VIb3N0SW1hZ2VBY3Rpb247XG4gIHByb3ZpZGVyOiBXb3Jrc3BhY2VIb3N0UHJvdmlkZXJUYXJnZXQ7XG4gIGFyY2hpdGVjdHVyZTogc3RyaW5nO1xuICAvKiogT21pdHRlZCBwcmVzZXJ2ZXMgdGhlIHNoaXBwZWQgVWJ1bnR1IGZpeHR1cmUuIEJvb3RjIGZpeHR1cmVzIGFyZSBleHBsaWNpdC4gKi9cbiAgaG9zdE1vZGVsPzogV29ya3NwYWNlSG9zdE1vZGVsO1xuICAvKiogUmVxdWlyZWQgYnkgdGhlIGJvb3RjIG1hdHJpeDsgaWdub3JlZCBub3doZXJlIGFuZCBmb3JiaWRkZW4gb24gdGhlIFVidW50dSBtb2RlbC4gKi9cbiAgYm9vdGNCYXNlSW1hZ2U/OiBzdHJpbmc7XG4gIG9ic2VydmVkQXQ6IHN0cmluZztcbiAgaG9zdElkOiBzdHJpbmc7XG4gIG1pZ3JhdGlvbklkOiBzdHJpbmc7XG4gIG1pbmltdW1Ob2RlTWFqb3I6IG51bWJlcjtcbiAgc2VydmljZTogV29ya3NwYWNlSG9zdEJvb3RzdHJhcFNlcnZpY2U7XG4gIGlzb2xhdGlvbj86IFdvcmtzcGFjZUhvc3RCb290c3RyYXBJc29sYXRpb247XG4gIC8qKiBQcm92aWRlci1zcGVjaWZpYyBjbGVhbi1yb29tIHJ1bnRpbWUgc2V0OyBBV1Mgc3VwcGxpZXMgdGhlIGNvbnRyb2xsZXIncyBwcm9kdWN0aW9uIHNldC4gKi9cbiAgYWdlbnRSdW50aW1lSW5zdGFsbHM/OiByZWFkb25seSBXb3Jrc3BhY2VIb3N0QWdlbnRSdW50aW1lSW5zdGFsbFtdO1xuICAvKiogUHJvdmlkZXItc3BlY2lmaWMgYm9vdHN0cmFwIHN0YXR1cyBjaGFubmVsIHVzZWQgdG8gYXR0ZXN0IHJlbW90ZSBjb21wbGV0aW9uLiAqL1xuICBzdGF0dXNDaGFubmVsPzogV29ya3NwYWNlSG9zdEJvb3RzdHJhcFN0YXR1c0NoYW5uZWw7XG4gIC8qKlxuICAgKiBLZXlzIHRvIGF1dGhvcml6ZSBmb3IgdGhlIHdvcmtzcGFjZSBhY2NvdW50LiBPcHRpb25hbCBoZXJlIOKAlCB1bmxpa2Ugb25cbiAgICogYFdvcmtzcGFjZUhvc3RCb290c3RyYXBJbnB1dGAsIHdoZXJlIGl0IGlzIHJlcXVpcmVkIOKAlCBiZWNhdXNlIGEgY2xlYW4tcm9vbSBWTSBpcyB0b3JuIGRvd25cbiAgICogYW5kIGhhcyBubyBjb250cm9sbGVyIHRvIGFkbWl0LiBPbWl0dGVkIOKHkiBgV09SS1NQQUNFX0hPU1RfQ0xFQU5fUk9PTV9BVVRIT1JJWkVEX0tFWWAsIHdoaWNoXG4gICAqIGtlZXBzIHRoZSBmaXh0dXJlIHNjcmlwdCBkZXRlcm1pbmlzdGljLlxuICAgKi9cbiAgd29ya3NwYWNlQXV0aG9yaXplZEtleXM/OiByZWFkb25seSBzdHJpbmdbXTtcbiAgZW50cnlwb2ludHM/OiBQYXJ0aWFsPFdvcmtzcGFjZUhvc3RCb290c3RyYXBFbnRyeXBvaW50cz47XG4gIHB1YmxpY01ldGFkYXRhPzogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+O1xuICBjdXJyZW50QXJ0aWZhY3Q/OiBXb3Jrc3BhY2VIb3N0SW1hZ2VBcnRpZmFjdDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0Q2xlYW5Sb29tSW5zdGFsbEZpeHR1cmUge1xuICBjb250cmFjdFZlcnNpb246IHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9JTUFHRV9BQ0NFUFRBTkNFX0NPTlRSQUNUX1ZFUlNJT047XG4gIGZpeHR1cmVJZDogc3RyaW5nO1xuICBpbWFnZTogV29ya3NwYWNlSG9zdEltYWdlUmVmICYgeyB2ZXJzaW9uOiBzdHJpbmcgfTtcbiAgbWFuaWZlc3RJZGVudGl0eTogV29ya3NwYWNlSG9zdEJ1aWxkTWFuaWZlc3RbXCJtYW5pZmVzdElkZW50aXR5XCJdO1xuICBib290c3RyYXBJbnB1dDogV29ya3NwYWNlSG9zdEJvb3RzdHJhcElucHV0O1xuICBib290c3RyYXBTY3JpcHQ6IHN0cmluZztcbiAgYm9vdHN0cmFwU2NyaXB0U2hhMjU2OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdENsZWFuUm9vbUV4ZWN1dG9yIHtcbiAgZXhlY3V0ZShcbiAgICBmaXh0dXJlOiBXb3Jrc3BhY2VIb3N0Q2xlYW5Sb29tSW5zdGFsbEZpeHR1cmUsXG4gICk6IFByb21pc2U8eyBzdGRvdXQ6IHN0cmluZyB9Pjtcbn1cblxuZXhwb3J0IHR5cGUgV29ya3NwYWNlSG9zdENsZWFuUm9vbUFjY2VwdGFuY2VDaGVjayA9XG4gIHwgXCJhcnRpZmFjdC1pZGVudGl0eVwiXG4gIHwgXCJjb21wYXRpYmlsaXR5LW1hdHJpeFwiXG4gIHwgXCJkZXRlcm1pbmlzdGljLWJvb3RzdHJhcC1maXh0dXJlXCJcbiAgfCBcImV4YWN0LWJvb3RzdHJhcC1hdHRlc3RhdGlvblwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RDbGVhblJvb21BY2NlcHRhbmNlUmVwb3J0IHtcbiAgY29udHJhY3RWZXJzaW9uOiB0eXBlb2YgV09SS1NQQUNFX0hPU1RfSU1BR0VfQUNDRVBUQU5DRV9DT05UUkFDVF9WRVJTSU9OO1xuICBmaXh0dXJlSWQ6IHN0cmluZztcbiAgaW1hZ2U6IFdvcmtzcGFjZUhvc3RJbWFnZVJlZiAmIHsgdmVyc2lvbjogc3RyaW5nIH07XG4gIHBhc3NlZDogYm9vbGVhbjtcbiAgY2hlY2tzOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0Q2xlYW5Sb29tQWNjZXB0YW5jZUNoZWNrW107XG4gIGlzc3VlczogcmVhZG9ubHkgV29ya3NwYWNlSG9zdEltYWdlQ29tcGF0aWJpbGl0eUlzc3VlW107XG4gIGJvb3RzdHJhcFNjcmlwdFNoYTI1Nj86IHN0cmluZztcbiAgYXR0ZXN0YXRpb24/OiBXb3Jrc3BhY2VIb3N0Qm9vdHN0cmFwQXR0ZXN0YXRpb247XG59XG5cbmNvbnN0IFNIQTI1NiA9IC9eW2EtZjAtOV17NjR9JC87XG5jb25zdCBJTUFHRV9ESUdFU1QgPSAvXnNoYTI1NjpbYS1mMC05XXs2NH0kLztcbmNvbnN0IFJFR0lTVFJZX0lNQUdFID1cbiAgL15bYS16MC05XVthLXowLTkuXy1dKig/OjpcXGR7MSw1fSk/KD86XFwvW2EtejAtOV1bYS16MC05Ll8tXSopKyg/OjpbQS1aYS16MC05XVtBLVphLXowLTkuXy1dezAsMTI3fSk/JC87XG5jb25zdCBEQVlfTVMgPSAyNCAqIDYwICogNjAgKiAxXzAwMDtcblxuZXhwb3J0IGZ1bmN0aW9uIHdvcmtzcGFjZUhvc3RJbWFnZU1vZGVsKFxuICBhcnRpZmFjdDogUGljazxXb3Jrc3BhY2VIb3N0SW1hZ2VBcnRpZmFjdCwgXCJob3N0TW9kZWxcIj4sXG4pOiBXb3Jrc3BhY2VIb3N0TW9kZWwge1xuICByZXR1cm4gYXJ0aWZhY3QuaG9zdE1vZGVsID8/IERFRkFVTFRfV09SS1NQQUNFX0hPU1RfTU9ERUw7XG59XG5cbmZ1bmN0aW9uIGNvbXBhdGliaWxpdHlNb2RlbChcbiAgdmFsdWU6IFBpY2s8V29ya3NwYWNlSG9zdEltYWdlQ29tcGF0aWJpbGl0eVJ1bGUsIFwiaG9zdE1vZGVsXCI+IHxcbiAgICBQaWNrPFdvcmtzcGFjZUhvc3RJbWFnZUNvbXBhdGliaWxpdHlSZXF1ZXN0LCBcImhvc3RNb2RlbFwiPixcbik6IFdvcmtzcGFjZUhvc3RNb2RlbCB7XG4gIHJldHVybiB2YWx1ZS5ob3N0TW9kZWwgPz8gREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9NT0RFTDtcbn1cblxuZnVuY3Rpb24gY29tcGF0aWJpbGl0eVBsYXRmb3JtKHZhbHVlOiBXb3Jrc3BhY2VIb3N0SW1hZ2VDb21wYXRpYmlsaXR5UnVsZSk6IHN0cmluZyB7XG4gIHJldHVybiBjb21wYXRpYmlsaXR5TW9kZWwodmFsdWUpID09PSBcImJvb3RjLWltYWdlXCJcbiAgICA/IHZhbHVlLmJvb3RjQmFzZUltYWdlID8/IFwiXCJcbiAgICA6IHZhbHVlLnVidW50dVZlcnNpb24gPz8gXCJcIjtcbn1cblxuLyoqXG4gKiBSZXBvcnQgYSBub24tc3RyaW5nIGFzIHRoZSB2YWxpZGF0aW9uIGZhaWx1cmUgaXQgaXMsIHJhdGhlciB0aGFuIGNyYXNoaW5nIG9uIGl0LlxuICpcbiAqIFRoZSBwYXJhbWV0ZXIgaXMgVFlQRUQgYHN0cmluZ2AsIHNvIFR5cGVTY3JpcHQgaXMgc2F0aXNmaWVkIOKAlCBidXQgZXZlcnkgY2FsbGVyIGhlcmVcbiAqIHZhbGlkYXRlcyB2YWx1ZXMgcGFyc2VkIGZyb20gSlNPTiBvbiBkaXNrLCB3aGVyZSB0aGF0IGd1YXJhbnRlZSBkb2VzIG5vdCBob2xkLiBUaGUgYmFyZVxuICogYHZhbHVlLnRyaW0oKWAgdGhlcmVmb3JlIHRocmV3IGBDYW5ub3QgcmVhZCBwcm9wZXJ0aWVzIG9mIHVuZGVmaW5lZGAgZm9yIGV4YWN0bHkgdGhlXG4gKiBtYWxmb3JtZWQgaW5wdXQgdGhpcyBoZWxwZXIgZXhpc3RzIHRvIHJlamVjdCwgYW5kIGJlY2F1c2UgY29tcGF0aWJpbGl0eSBldmFsdWF0aW9uIHJ1bnNcbiAqIG91dHNpZGUgYHJ1bldvcmtzcGFjZUhvc3RDbGVhblJvb21BY2NlcHRhbmNlYCdzIHRyeS9jYXRjaCwgdGhhdCBUeXBlRXJyb3IgZXNjYXBlZCB0aGUgd2hvbGVcbiAqIGFjY2VwdGFuY2UgcGF0aCBpbnN0ZWFkIG9mIGJlY29taW5nIGEgYHBhc3NlZDogZmFsc2VgIHJlcG9ydCBuYW1pbmcgdGhlIGZpZWxkLlxuICovXG5mdW5jdGlvbiBpc1JlY29yZCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiAmJiB2YWx1ZSAhPT0gbnVsbCAmJiAhQXJyYXkuaXNBcnJheSh2YWx1ZSk7XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVUZXh0KHZhbHVlOiB1bmtub3duLCBwYXRoOiBzdHJpbmcsIGVycm9yczogc3RyaW5nW10pOiB2b2lkIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fCAhdmFsdWUudHJpbSgpKSB7XG4gICAgZXJyb3JzLnB1c2goYCR7cGF0aH0gbXVzdCBiZSBhIG5vbi1lbXB0eSBzdHJpbmdgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB0aW1lc3RhbXAodmFsdWU6IHVua25vd24sIHBhdGg6IHN0cmluZywgZXJyb3JzOiBzdHJpbmdbXSk6IG51bWJlciB7XG4gIGNvbnN0IHBhcnNlZCA9IHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiA/IERhdGUucGFyc2UodmFsdWUpIDogTnVtYmVyLk5hTjtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUocGFyc2VkKSkgZXJyb3JzLnB1c2goYCR7cGF0aH0gbXVzdCBiZSBhbiBJU08gdGltZXN0YW1wYCk7XG4gIHJldHVybiBwYXJzZWQ7XG59XG5cbmZ1bmN0aW9uIHNhbWVJbWFnZShcbiAgbGVmdDogdW5rbm93bixcbiAgcmlnaHQ6IHVua25vd24sXG4pOiBib29sZWFuIHtcbiAgcmV0dXJuIChcbiAgICBpc1JlY29yZChsZWZ0KSAmJlxuICAgIGlzUmVjb3JkKHJpZ2h0KSAmJlxuICAgIGxlZnQuaWQgPT09IHJpZ2h0LmlkICYmXG4gICAgbGVmdC52ZXJzaW9uID09PSByaWdodC52ZXJzaW9uXG4gICk7XG59XG5cbi8qKiBWZXJpZnkgZXZlcnkgaWRlbnRpdHkgYW5kIGxpZmVjeWNsZSBlZGdlIGJlZm9yZSBjb21wYXRpYmlsaXR5IGlzIGV2YWx1YXRlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZVdvcmtzcGFjZUhvc3RJbWFnZUFydGlmYWN0KFxuICBhcnRpZmFjdDogV29ya3NwYWNlSG9zdEltYWdlQXJ0aWZhY3QsXG4pOiByZWFkb25seSBzdHJpbmdbXSB7XG4gIGNvbnN0IGVycm9yczogc3RyaW5nW10gPSBbXTtcbiAgaWYgKCFpc1JlY29yZChhcnRpZmFjdCkpIHtcbiAgICByZXR1cm4gW1wiYXJ0aWZhY3QgbXVzdCBiZSBhbiBvYmplY3RcIl07XG4gIH1cbiAgaWYgKFxuICAgIGFydGlmYWN0LmNvbnRyYWN0VmVyc2lvbiAhPT1cbiAgICBXT1JLU1BBQ0VfSE9TVF9JTUFHRV9BQ0NFUFRBTkNFX0NPTlRSQUNUX1ZFUlNJT05cbiAgKSB7XG4gICAgZXJyb3JzLnB1c2goXG4gICAgICBgY29udHJhY3RWZXJzaW9uIG11c3QgYmUgJyR7V09SS1NQQUNFX0hPU1RfSU1BR0VfQUNDRVBUQU5DRV9DT05UUkFDVF9WRVJTSU9OfSdgLFxuICAgICk7XG4gIH1cbiAgLy8gU3RydWN0dXJhbCBwcmVjb25kaXRpb25zIGNvbWUgZmlyc3QuIEV2ZXJ5IGNoZWNrIGJlbG93IHJlYWRzIFRIUk9VR0ggdGhlc2Ugc2VjdGlvbnMsIGFuZFxuICAvLyBhIHZhbGlkYXRvciB3aG9zZSBlbnRpcmUgam9iIGlzIHRvIHJlcG9ydCB3aGF0IGlzIHdyb25nIG11c3Qgbm90IGNyYXNoIG9uIHRoZSBtYWxmb3JtZWRcbiAgLy8gaW5wdXQgaXQgZXhpc3RzIHRvIHJlamVjdDogYHJ1bldvcmtzcGFjZUhvc3RDbGVhblJvb21BY2NlcHRhbmNlYCBjYWxscyBjb21wYXRpYmlsaXR5XG4gIC8vIGV2YWx1YXRpb24gT1VUU0lERSBpdHMgdHJ5L2NhdGNoLCBzbyBhIFR5cGVFcnJvciBoZXJlIGVzY2FwZXMgdGhlIGFjY2VwdGFuY2UgcGF0aCBhcyBhblxuICAvLyBvcGFxdWUgXCJDYW5ub3QgcmVhZCBwcm9wZXJ0aWVzIG9mIHVuZGVmaW5lZFwiIGluc3RlYWQgb2YgYSBgcGFzc2VkOiBmYWxzZWAgcmVwb3J0IG5hbWluZ1xuICAvLyB0aGUgb2ZmZW5kaW5nIGZpZWxkLlxuICBjb25zdCBzZWN0aW9uID0gKHZhbHVlOiB1bmtub3duLCBwYXRoOiBzdHJpbmcpOiB2YWx1ZSBpcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiB7XG4gICAgY29uc3QgcHJlc2VudCA9IGlzUmVjb3JkKHZhbHVlKTtcbiAgICBpZiAoIXByZXNlbnQpIGVycm9ycy5wdXNoKGAke3BhdGh9IG11c3QgYmUgYW4gb2JqZWN0YCk7XG4gICAgcmV0dXJuIHByZXNlbnQ7XG4gIH07XG4gIGNvbnN0IGxpc3RTZWN0aW9uID0gKHZhbHVlOiB1bmtub3duLCBwYXRoOiBzdHJpbmcpOiB2YWx1ZSBpcyByZWFkb25seSB1bmtub3duW10gPT4ge1xuICAgIGNvbnN0IHByZXNlbnQgPSBBcnJheS5pc0FycmF5KHZhbHVlKTtcbiAgICBpZiAoIXByZXNlbnQpIGVycm9ycy5wdXNoKGAke3BhdGh9IG11c3QgYmUgYW4gYXJyYXlgKTtcbiAgICByZXR1cm4gcHJlc2VudDtcbiAgfTtcbiAgY29uc3QgaGFzSW1hZ2UgPSBzZWN0aW9uKGFydGlmYWN0LmltYWdlLCBcImltYWdlXCIpO1xuICBjb25zdCBoYXNNYW5pZmVzdCA9IHNlY3Rpb24oYXJ0aWZhY3QuYnVpbGRNYW5pZmVzdCwgXCJidWlsZE1hbmlmZXN0XCIpO1xuICBjb25zdCBoYXNSZWxlYXNlID0gc2VjdGlvbihhcnRpZmFjdC5yZWxlYXNlLCBcInJlbGVhc2VcIik7XG4gIGNvbnN0IGhhc0xpZmVjeWNsZSA9IHNlY3Rpb24oYXJ0aWZhY3QubGlmZWN5Y2xlLCBcImxpZmVjeWNsZVwiKTtcbiAgY29uc3QgaGFzQ29tcGF0aWJpbGl0eSA9IGxpc3RTZWN0aW9uKGFydGlmYWN0LmNvbXBhdGliaWxpdHksIFwiY29tcGF0aWJpbGl0eVwiKTtcbiAgY29uc3QgaG9zdE1vZGVsID0gd29ya3NwYWNlSG9zdEltYWdlTW9kZWwoYXJ0aWZhY3QpO1xuICBpZiAoIVdPUktTUEFDRV9IT1NUX01PREVMUy5pbmNsdWRlcyhob3N0TW9kZWwpKSB7XG4gICAgZXJyb3JzLnB1c2goYHVuc3VwcG9ydGVkIGhvc3RNb2RlbCAnJHtTdHJpbmcoaG9zdE1vZGVsKX0nYCk7XG4gIH1cbiAgY29uc3QgYm9vdGMgPSAoYXJ0aWZhY3QgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikuYm9vdGM7XG4gIGNvbnN0IGJvb3RjUmVjb3JkID0gaXNSZWNvcmQoYm9vdGMpID8gYm9vdGMgOiB1bmRlZmluZWQ7XG4gIGlmIChob3N0TW9kZWwgPT09IFwiYm9vdGMtaW1hZ2VcIikge1xuICAgIGlmICghc2VjdGlvbihib290YywgXCJib290Y1wiKSkge1xuICAgICAgLy8gVGhlIHNlY3Rpb24gaGVscGVyIGFscmVhZHkgbmFtZXMgdGhlIHN0cnVjdHVyYWwgZXJyb3IuXG4gICAgfSBlbHNlIHtcbiAgICAgIGlmIChcbiAgICAgICAgdHlwZW9mIGJvb3RjUmVjb3JkPy5pbWFnZSAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgICAhUkVHSVNUUllfSU1BR0UudGVzdChib290Y1JlY29yZC5pbWFnZSlcbiAgICAgICkge1xuICAgICAgICBlcnJvcnMucHVzaChcImJvb3RjLmltYWdlIG11c3QgYmUgYSByZWdpc3RyeS1xdWFsaWZpZWQgdGFnZ2VkIGltYWdlIHJlZmVyZW5jZVwiKTtcbiAgICAgIH1cbiAgICAgIGlmIChcbiAgICAgICAgdHlwZW9mIGJvb3RjUmVjb3JkPy5pbWFnZURpZ2VzdCAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgICAhSU1BR0VfRElHRVNULnRlc3QoYm9vdGNSZWNvcmQuaW1hZ2VEaWdlc3QpXG4gICAgICApIHtcbiAgICAgICAgZXJyb3JzLnB1c2goXCJib290Yy5pbWFnZURpZ2VzdCBtdXN0IGJlIGEgbG93ZXJjYXNlIHNoYTI1NiBtYW5pZmVzdCBkaWdlc3RcIik7XG4gICAgICB9XG4gICAgICBpZiAoXG4gICAgICAgIHR5cGVvZiBib290Y1JlY29yZD8uYmFzZUltYWdlICE9PSBcInN0cmluZ1wiIHx8XG4gICAgICAgICFSRUdJU1RSWV9JTUFHRS50ZXN0KGJvb3RjUmVjb3JkLmJhc2VJbWFnZSlcbiAgICAgICkge1xuICAgICAgICBlcnJvcnMucHVzaChcImJvb3RjLmJhc2VJbWFnZSBtdXN0IGJlIGEgcmVnaXN0cnktcXVhbGlmaWVkIGltYWdlIHJlZmVyZW5jZVwiKTtcbiAgICAgIH1cbiAgICAgIGlmIChcbiAgICAgICAgYm9vdGNSZWNvcmQ/LnNpZ25hdHVyZVBvbGljeVBhdGggIT09XG4gICAgICAgIFdPUktTUEFDRV9IT1NUX0NPTlRBSU5FUlNfUE9MSUNZX1BBVEhcbiAgICAgICkge1xuICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICBgYm9vdGMuc2lnbmF0dXJlUG9saWN5UGF0aCBtdXN0IGJlICcke1dPUktTUEFDRV9IT1NUX0NPTlRBSU5FUlNfUE9MSUNZX1BBVEh9J2AsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9IGVsc2UgaWYgKGJvb3RjICE9PSB1bmRlZmluZWQpIHtcbiAgICBlcnJvcnMucHVzaChcImJvb3RjIGlzIHZhbGlkIG9ubHkgd2hlbiBob3N0TW9kZWwgaXMgJ2Jvb3RjLWltYWdlJ1wiKTtcbiAgfVxuXG4gIGlmIChoYXNJbWFnZSkge1xuICAgIHJlcXVpcmVUZXh0KGFydGlmYWN0LmltYWdlLmlkLCBcImltYWdlLmlkXCIsIGVycm9ycyk7XG4gICAgcmVxdWlyZVRleHQoYXJ0aWZhY3QuaW1hZ2UudmVyc2lvbiwgXCJpbWFnZS52ZXJzaW9uXCIsIGVycm9ycyk7XG4gIH1cblxuICBpZiAoaGFzTWFuaWZlc3QpIHtcbiAgICBjb25zdCBtYW5pZmVzdCA9IHZlcmlmeVdvcmtzcGFjZUhvc3RCdWlsZE1hbmlmZXN0KGFydGlmYWN0LmJ1aWxkTWFuaWZlc3QpO1xuICAgIGlmICghbWFuaWZlc3Qub2spIHtcbiAgICAgIGVycm9ycy5wdXNoKC4uLm1hbmlmZXN0LmVycm9ycy5tYXAoKGVycm9yKSA9PiBgYnVpbGRNYW5pZmVzdDogJHtlcnJvcn1gKSk7XG4gICAgfVxuICB9XG4gIGNvbnN0IGJ1aWxkTWFuaWZlc3QgPSBoYXNNYW5pZmVzdFxuICAgID8gKGFydGlmYWN0LmJ1aWxkTWFuaWZlc3QgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilcbiAgICA6IHVuZGVmaW5lZDtcbiAgY29uc3QgcmVsZWFzZUFydGlmYWN0VmFsdWUgPSBidWlsZE1hbmlmZXN0Py5yZWxlYXNlQXJ0aWZhY3Q7XG4gIGNvbnN0IGJhc2VJbWFnZVZhbHVlID0gYnVpbGRNYW5pZmVzdD8uYmFzZUltYWdlO1xuICBjb25zdCBtYXRlcmlhbHNWYWx1ZSA9IGJ1aWxkTWFuaWZlc3Q/Lm1hdGVyaWFscztcbiAgY29uc3QgdGFyZ2V0c1ZhbHVlID0gYnVpbGRNYW5pZmVzdD8udGFyZ2V0cztcbiAgc2VjdGlvbihyZWxlYXNlQXJ0aWZhY3RWYWx1ZSwgXCJidWlsZE1hbmlmZXN0LnJlbGVhc2VBcnRpZmFjdFwiKTtcbiAgc2VjdGlvbihiYXNlSW1hZ2VWYWx1ZSwgXCJidWlsZE1hbmlmZXN0LmJhc2VJbWFnZVwiKTtcbiAgbGlzdFNlY3Rpb24obWF0ZXJpYWxzVmFsdWUsIFwiYnVpbGRNYW5pZmVzdC5tYXRlcmlhbHNcIik7XG4gIGxpc3RTZWN0aW9uKHRhcmdldHNWYWx1ZSwgXCJidWlsZE1hbmlmZXN0LnRhcmdldHNcIik7XG4gIGNvbnN0IHJlbGVhc2VBcnRpZmFjdCA9IGlzUmVjb3JkKHJlbGVhc2VBcnRpZmFjdFZhbHVlKVxuICAgID8gcmVsZWFzZUFydGlmYWN0VmFsdWVcbiAgICA6IHVuZGVmaW5lZDtcbiAgY29uc3QgYmFzZUltYWdlID0gaXNSZWNvcmQoYmFzZUltYWdlVmFsdWUpID8gYmFzZUltYWdlVmFsdWUgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IG1hdGVyaWFscyA9IEFycmF5LmlzQXJyYXkobWF0ZXJpYWxzVmFsdWUpXG4gICAgPyAobWF0ZXJpYWxzVmFsdWUgYXMgcmVhZG9ubHkgdW5rbm93bltdKVxuICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCB0YXJnZXRzID0gQXJyYXkuaXNBcnJheSh0YXJnZXRzVmFsdWUpXG4gICAgPyAodGFyZ2V0c1ZhbHVlIGFzIHJlYWRvbmx5IHVua25vd25bXSlcbiAgICA6IHVuZGVmaW5lZDtcbiAgaWYgKG1hdGVyaWFscyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgbWF0ZXJpYWxzLmZvckVhY2goKG1hdGVyaWFsOiB1bmtub3duLCBpbmRleDogbnVtYmVyKSA9PiB7XG4gICAgICBpZiAoIWlzUmVjb3JkKG1hdGVyaWFsKSkge1xuICAgICAgICBlcnJvcnMucHVzaChgYnVpbGRNYW5pZmVzdC5tYXRlcmlhbHNbJHtpbmRleH1dIG11c3QgYmUgYW4gb2JqZWN0YCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgaWYgKHRhcmdldHMgIT09IHVuZGVmaW5lZCkge1xuICAgIHRhcmdldHMuZm9yRWFjaCgodGFyZ2V0OiB1bmtub3duLCBpbmRleDogbnVtYmVyKSA9PiB7XG4gICAgICBpZiAoIWlzUmVjb3JkKHRhcmdldCkpIHtcbiAgICAgICAgZXJyb3JzLnB1c2goYGJ1aWxkTWFuaWZlc3QudGFyZ2V0c1ske2luZGV4fV0gbXVzdCBiZSBhbiBvYmplY3RgKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuICBpZiAoXG4gICAgaGFzSW1hZ2UgJiZcbiAgICBoYXNNYW5pZmVzdCAmJlxuICAgIHJlbGVhc2VBcnRpZmFjdCAhPT0gdW5kZWZpbmVkICYmXG4gICAgYXJ0aWZhY3QuaW1hZ2UudmVyc2lvbiAhPT0gcmVsZWFzZUFydGlmYWN0LnZlcnNpb25cbiAgKSB7XG4gICAgZXJyb3JzLnB1c2goXG4gICAgICBcImltYWdlLnZlcnNpb24gbXVzdCBlcXVhbCBidWlsZE1hbmlmZXN0LnJlbGVhc2VBcnRpZmFjdC52ZXJzaW9uXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoaGFzSW1hZ2UgJiYgaGFzUmVsZWFzZSAmJiBhcnRpZmFjdC5yZWxlYXNlLnZlcnNpb24gIT09IGFydGlmYWN0LmltYWdlLnZlcnNpb24pIHtcbiAgICBlcnJvcnMucHVzaChcInJlbGVhc2UudmVyc2lvbiBtdXN0IGVxdWFsIGltYWdlLnZlcnNpb25cIik7XG4gIH1cblxuICAvLyBOb3RoaW5nIGJlbG93IGNhbiBiZSBldmFsdWF0ZWQgd2l0aG91dCBhbGwgdGhyZWUgc2VjdGlvbnMsIGFuZCBjb250aW51aW5nIHdvdWxkIG9ubHlcbiAgLy8gY29udmVydCBhIGNsZWFyIHN0cnVjdHVyYWwgcmVqZWN0aW9uIGludG8gYSBjcmFzaC5cbiAgaWYgKFxuICAgICFoYXNJbWFnZSB8fFxuICAgICFoYXNNYW5pZmVzdCB8fFxuICAgICFoYXNSZWxlYXNlIHx8XG4gICAgIWhhc0xpZmVjeWNsZSB8fFxuICAgICFoYXNDb21wYXRpYmlsaXR5XG4gICkge1xuICAgIHJldHVybiBlcnJvcnM7XG4gIH1cblxuICAvLyBUaGUgZGVsZWdhdGVkIHByb3ZlbmFuY2UgdmVyaWZpZXIgZXhwZWN0cyB0aGUgbWFuaWZlc3QncyByZWxlYXNlIGFydGlmYWN0IGFuZCBtYXRlcmlhbHMgdG9cbiAgLy8gaGF2ZSB0aGUgcnVudGltZSBzaGFwZXMgaXQgcmVhZHMgKGBzaGEyNTYudG9Mb3dlckNhc2UoKWAgYW5kIGBtYXRlcmlhbHMuZmluZCguLi4pYCkuIFRoZVxuICAvLyBtYW5pZmVzdCB2ZXJpZmllciByZXBvcnRzIG1hbGZvcm1lZCB2YWx1ZXMsIGJ1dCBkZWxpYmVyYXRlbHkgY2F0Y2hlcyBpdHMgb3duIGV4Y2VwdGlvbnM7XG4gIC8vIGRvIG5vdCBjYWxsIHRoZSBsb3dlci1sZXZlbCB2ZXJpZmllciB1bnRpbCB0aGVzZSB0d28gbmVzdGVkIHNlY3Rpb25zIGFyZSBzYWZlIHRvIHRyYXZlcnNlLlxuICBjb25zdCByZWxlYXNlID0gYXJ0aWZhY3QucmVsZWFzZSBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBjb25zdCBjYW5WZXJpZnlSZWxlYXNlUHJvdmVuYW5jZSA9XG4gICAgcmVsZWFzZUFydGlmYWN0ICE9PSB1bmRlZmluZWQgJiZcbiAgICBtYXRlcmlhbHMgIT09IHVuZGVmaW5lZCAmJlxuICAgIHR5cGVvZiByZWxlYXNlQXJ0aWZhY3Quc2hhMjU2ID09PSBcInN0cmluZ1wiICYmXG4gICAgdHlwZW9mIHJlbGVhc2VBcnRpZmFjdC52ZXJzaW9uID09PSBcInN0cmluZ1wiICYmXG4gICAgbWF0ZXJpYWxzLmV2ZXJ5KGlzUmVjb3JkKSAmJlxuICAgIHR5cGVvZiByZWxlYXNlLnZlcnNpb24gPT09IFwic3RyaW5nXCIgJiZcbiAgICB0eXBlb2YgcmVsZWFzZS5idW5kbGVTaGEyNTYgPT09IFwic3RyaW5nXCIgJiZcbiAgICB0eXBlb2YgcmVsZWFzZS5idW5kbGVVcmwgPT09IFwic3RyaW5nXCIgJiZcbiAgICB0eXBlb2YgcmVsZWFzZS5zaWduYXR1cmVVcmwgPT09IFwic3RyaW5nXCI7XG5cbiAgLy8gVGhlIHJlbGVhc2UgcGlucyBtdXN0IGJlIHByb3ZlbmFuY2UtYm91bmQgdG8gdGhlIG1hbmlmZXN0IGFib3ZlOiBzYW1lIGRpZ2VzdCwgc2FtZSB2ZXJzaW9uLFxuICAvLyBhbiBpbW11dGFibHkgYWRkcmVzc2VkIGJ1bmRsZSwgYSBtYXRjaGluZyBkZXRhY2hlZCBzaWduYXR1cmUsIGFuZCBhIHBhY2thZ2VkIGV4ZWN1dGFibGVcbiAgLy8gaW5pdGlhbGl6ZXIuIFRoaXMgaXMgZGVsZWdhdGVkIHJhdGhlciB0aGFuIHJlc3RhdGVkIHNvIHRoZSB0d28gc3VyZmFjZXMgY2Fubm90IGRyaWZ0IOKAlCB0aGVcbiAgLy8gZGlnZXN0IGFuZCB2ZXJzaW9uIGVxdWFsaXRpZXMgdXNlZCB0byBiZSBkdXBsaWNhdGVkIGhlcmUsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIHNlY29uZCBjb3B5XG4gIC8vIHRoYXQgZ29lcyBzdGFsZS4gVGhlIG1hbmlmZXN0J3Mgb3duIHNlbGYtY29uc2lzdGVuY3kgZXJyb3JzIGFyZSBkcm9wcGVkIGJlY2F1c2UgdGhleSBhcmVcbiAgLy8gYWxyZWFkeSByZXBvcnRlZCBhYm92ZSB1bmRlciB0aGUgYGJ1aWxkTWFuaWZlc3Q6YCBwcmVmaXg7IHJlLXJlcG9ydGluZyB0aGVtIGhlcmUgd291bGQgc2hvd1xuICAvLyBvbmUgZGVmZWN0IHR3aWNlIGFuZCBpbnZpdGUgZml4aW5nIGl0IGluIHRoZSB3cm9uZyBwbGFjZS5cbiAgaWYgKGNhblZlcmlmeVJlbGVhc2VQcm92ZW5hbmNlKSB7XG4gICAgY29uc3QgcHJvdmVuYW5jZSA9IHZlcmlmeVdvcmtzcGFjZUhvc3RSZWxlYXNlUHJvdmVuYW5jZShcbiAgICAgIGFydGlmYWN0LmJ1aWxkTWFuaWZlc3QsXG4gICAgICBhcnRpZmFjdC5yZWxlYXNlLFxuICAgICk7XG4gICAgaWYgKCFwcm92ZW5hbmNlLm9rKSB7XG4gICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgLi4ucHJvdmVuYW5jZS5lcnJvcnNcbiAgICAgICAgICAuZmlsdGVyKChlcnJvcikgPT4gIWVycm9yLnN0YXJ0c1dpdGgoXCJtYW5pZmVzdCBpcyBub3Qgc2VsZi1jb25zaXN0ZW50OlwiKSlcbiAgICAgICAgICAubWFwKChlcnJvcikgPT4gYHJlbGVhc2UgcHJvdmVuYW5jZTogJHtlcnJvcn1gKSxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgaWYgKFxuICAgIHR5cGVvZiByZWxlYXNlLnNpZ25pbmdLZXlTaGEyNTYgIT09IFwic3RyaW5nXCIgfHxcbiAgICAhU0hBMjU2LnRlc3QocmVsZWFzZS5zaWduaW5nS2V5U2hhMjU2KVxuICApIHtcbiAgICBlcnJvcnMucHVzaChcInJlbGVhc2Uuc2lnbmluZ0tleVNoYTI1NiBtdXN0IGJlIGEgbG93ZXJjYXNlIFNIQS0yNTYgZGlnZXN0XCIpO1xuICB9XG4gIHJlcXVpcmVUZXh0KFxuICAgIHJlbGVhc2Uuc2lnbmluZ1B1YmxpY0tleSxcbiAgICBcInJlbGVhc2Uuc2lnbmluZ1B1YmxpY0tleVwiLFxuICAgIGVycm9ycyxcbiAgKTtcbiAgaWYgKFxuICAgIHR5cGVvZiByZWxlYXNlLnNpZ25pbmdQdWJsaWNLZXkgPT09IFwic3RyaW5nXCIgJiZcbiAgICB0eXBlb2YgcmVsZWFzZS5zaWduaW5nS2V5U2hhMjU2ID09PSBcInN0cmluZ1wiICYmXG4gICAgY3JlYXRlSGFzaChcInNoYTI1NlwiKVxuICAgICAgLnVwZGF0ZShyZWxlYXNlLnNpZ25pbmdQdWJsaWNLZXksIFwidXRmOFwiKVxuICAgICAgLmRpZ2VzdChcImhleFwiKSAhPT0gcmVsZWFzZS5zaWduaW5nS2V5U2hhMjU2XG4gICkge1xuICAgIGVycm9ycy5wdXNoKFxuICAgICAgXCJyZWxlYXNlLnNpZ25pbmdLZXlTaGEyNTYgbXVzdCBlcXVhbCB0aGUgU0hBLTI1NiBvZiBzaWduaW5nUHVibGljS2V5XCIsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGxpZmVjeWNsZSA9IGFydGlmYWN0LmxpZmVjeWNsZSBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBjb25zdCBsaWZlY3ljbGVTdGF0ZSA9IGxpZmVjeWNsZS5zdGF0ZTtcbiAgY29uc3QgcHVibGlzaGVkQXQgPSB0aW1lc3RhbXAoXG4gICAgbGlmZWN5Y2xlLnB1Ymxpc2hlZEF0LFxuICAgIFwibGlmZWN5Y2xlLnB1Ymxpc2hlZEF0XCIsXG4gICAgZXJyb3JzLFxuICApO1xuICBjb25zdCBkZXByZWNhdGVkQXQgPSBsaWZlY3ljbGUuZGVwcmVjYXRlZEF0XG4gICAgPyB0aW1lc3RhbXAoXG4gICAgICAgIGxpZmVjeWNsZS5kZXByZWNhdGVkQXQsXG4gICAgICAgIFwibGlmZWN5Y2xlLmRlcHJlY2F0ZWRBdFwiLFxuICAgICAgICBlcnJvcnMsXG4gICAgICApXG4gICAgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHN1cHBvcnRFbmRzQXQgPSBsaWZlY3ljbGUuc3VwcG9ydEVuZHNBdFxuICAgID8gdGltZXN0YW1wKFxuICAgICAgICBsaWZlY3ljbGUuc3VwcG9ydEVuZHNBdCxcbiAgICAgICAgXCJsaWZlY3ljbGUuc3VwcG9ydEVuZHNBdFwiLFxuICAgICAgICBlcnJvcnMsXG4gICAgICApXG4gICAgOiB1bmRlZmluZWQ7XG4gIGlmIChcbiAgICAhV09SS1NQQUNFX0hPU1RfSU1BR0VfTElGRUNZQ0xFX1NUQVRFUy5pbmNsdWRlcyhcbiAgICAgIGxpZmVjeWNsZVN0YXRlIGFzIFdvcmtzcGFjZUhvc3RJbWFnZUxpZmVjeWNsZVN0YXRlLFxuICAgIClcbiAgKSB7XG4gICAgZXJyb3JzLnB1c2goYHVuc3VwcG9ydGVkIGxpZmVjeWNsZS5zdGF0ZSAnJHtTdHJpbmcobGlmZWN5Y2xlU3RhdGUpfSdgKTtcbiAgfVxuICBpZiAobGlmZWN5Y2xlU3RhdGUgPT09IFwiYWN0aXZlXCIgJiYgZGVwcmVjYXRlZEF0ICE9PSB1bmRlZmluZWQpIHtcbiAgICBlcnJvcnMucHVzaChcImFjdGl2ZSBhcnRpZmFjdHMgbXVzdCBub3QgY2FycnkgbGlmZWN5Y2xlLmRlcHJlY2F0ZWRBdFwiKTtcbiAgfVxuICBpZiAobGlmZWN5Y2xlU3RhdGUgIT09IFwiYWN0aXZlXCIgJiYgZGVwcmVjYXRlZEF0ID09PSB1bmRlZmluZWQpIHtcbiAgICBlcnJvcnMucHVzaChcbiAgICAgIFwiZGVwcmVjYXRlZC93aXRoZHJhd24gYXJ0aWZhY3RzIHJlcXVpcmUgbGlmZWN5Y2xlLmRlcHJlY2F0ZWRBdFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKFxuICAgIGRlcHJlY2F0ZWRBdCAhPT0gdW5kZWZpbmVkICYmXG4gICAgTnVtYmVyLmlzRmluaXRlKHB1Ymxpc2hlZEF0KSAmJlxuICAgIGRlcHJlY2F0ZWRBdCA8IHB1Ymxpc2hlZEF0XG4gICkge1xuICAgIGVycm9ycy5wdXNoKFwibGlmZWN5Y2xlLmRlcHJlY2F0ZWRBdCBtdXN0IG5vdCBwcmVkYXRlIHB1Ymxpc2hlZEF0XCIpO1xuICB9XG4gIGlmIChcbiAgICBzdXBwb3J0RW5kc0F0ICE9PSB1bmRlZmluZWQgJiZcbiAgICBOdW1iZXIuaXNGaW5pdGUocHVibGlzaGVkQXQpICYmXG4gICAgc3VwcG9ydEVuZHNBdCA8IHB1Ymxpc2hlZEF0XG4gICkge1xuICAgIGVycm9ycy5wdXNoKFwibGlmZWN5Y2xlLnN1cHBvcnRFbmRzQXQgbXVzdCBub3QgcHJlZGF0ZSBwdWJsaXNoZWRBdFwiKTtcbiAgfVxuICBpZiAoXG4gICAgbGlmZWN5Y2xlU3RhdGUgPT09IFwiZGVwcmVjYXRlZFwiICYmXG4gICAgIWxpZmVjeWNsZS5zdWNjZXNzb3JcbiAgKSB7XG4gICAgZXJyb3JzLnB1c2goXCJkZXByZWNhdGVkIGFydGlmYWN0cyByZXF1aXJlIGFuIGV4YWN0IGxpZmVjeWNsZS5zdWNjZXNzb3JcIik7XG4gIH1cbiAgaWYgKHNhbWVJbWFnZShhcnRpZmFjdC5pbWFnZSwgbGlmZWN5Y2xlLnN1Y2Nlc3NvcikpIHtcbiAgICBlcnJvcnMucHVzaChcImxpZmVjeWNsZS5zdWNjZXNzb3IgbXVzdCBkaWZmZXIgZnJvbSB0aGUgY3VycmVudCBpbWFnZVwiKTtcbiAgfVxuICBpZiAoc2FtZUltYWdlKGFydGlmYWN0LmltYWdlLCBsaWZlY3ljbGUucm9sbGJhY2tUYXJnZXQpKSB7XG4gICAgZXJyb3JzLnB1c2goXCJsaWZlY3ljbGUucm9sbGJhY2tUYXJnZXQgbXVzdCBkaWZmZXIgZnJvbSB0aGUgY3VycmVudCBpbWFnZVwiKTtcbiAgfVxuICBmb3IgKGNvbnN0IFtuYW1lLCByZWZdIG9mIFtcbiAgICBbXCJsaWZlY3ljbGUuc3VjY2Vzc29yXCIsIGxpZmVjeWNsZS5zdWNjZXNzb3JdLFxuICAgIFtcImxpZmVjeWNsZS5yb2xsYmFja1RhcmdldFwiLCBsaWZlY3ljbGUucm9sbGJhY2tUYXJnZXRdLFxuICBdIGFzIGNvbnN0KSB7XG4gICAgaWYgKHJlZiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAoIWlzUmVjb3JkKHJlZikpIHtcbiAgICAgICAgZXJyb3JzLnB1c2goYCR7bmFtZX0gbXVzdCBiZSBhbiBvYmplY3RgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlcXVpcmVUZXh0KHJlZi5pZCwgYCR7bmFtZX0uaWRgLCBlcnJvcnMpO1xuICAgICAgICByZXF1aXJlVGV4dChyZWYudmVyc2lvbiwgYCR7bmFtZX0udmVyc2lvbmAsIGVycm9ycyk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgY29uc3QgY29tcGF0aWJpbGl0eSA9IGFydGlmYWN0LmNvbXBhdGliaWxpdHkgYXMgcmVhZG9ubHkgdW5rbm93bltdO1xuICBpZiAoY29tcGF0aWJpbGl0eS5sZW5ndGggPT09IDApIHtcbiAgICBlcnJvcnMucHVzaChcImNvbXBhdGliaWxpdHkgbXVzdCBjb250YWluIGF0IGxlYXN0IG9uZSBtYXRyaXggcm93XCIpO1xuICB9XG4gIGNvbnN0IHRhcmdldFByb3ZpZGVycyA9IG5ldyBTZXQoXG4gICAgKHRhcmdldHMgPz8gW10pLm1hcCgodGFyZ2V0OiB1bmtub3duKSA9PlxuICAgICAgaXNSZWNvcmQodGFyZ2V0KSA/IHRhcmdldC5wcm92aWRlciA6IHVuZGVmaW5lZCxcbiAgICApLFxuICApO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbXBhdGliaWxpdHkuZm9yRWFjaCgocmF3UnVsZSwgaW5kZXgpID0+IHtcbiAgICBpZiAoIWlzUmVjb3JkKHJhd1J1bGUpKSB7XG4gICAgICBlcnJvcnMucHVzaChgY29tcGF0aWJpbGl0eVske2luZGV4fV0gbXVzdCBiZSBhbiBvYmplY3RgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgcnVsZSA9IHJhd1J1bGUgYXMgdW5rbm93biBhcyBXb3Jrc3BhY2VIb3N0SW1hZ2VDb21wYXRpYmlsaXR5UnVsZTtcbiAgICBjb25zdCBydWxlSG9zdE1vZGVsID0gY29tcGF0aWJpbGl0eU1vZGVsKHJ1bGUpO1xuICAgIHJlcXVpcmVUZXh0KHJ1bGUucHJvdmlkZXIsIGBjb21wYXRpYmlsaXR5WyR7aW5kZXh9XS5wcm92aWRlcmAsIGVycm9ycyk7XG4gICAgcmVxdWlyZVRleHQoXG4gICAgICBydWxlLmFyY2hpdGVjdHVyZSxcbiAgICAgIGBjb21wYXRpYmlsaXR5WyR7aW5kZXh9XS5hcmNoaXRlY3R1cmVgLFxuICAgICAgZXJyb3JzLFxuICAgICk7XG4gICAgaWYgKCF0YXJnZXRQcm92aWRlcnMuaGFzKHJ1bGUucHJvdmlkZXIpKSB7XG4gICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgYGNvbXBhdGliaWxpdHlbJHtpbmRleH1dLnByb3ZpZGVyICcke3J1bGUucHJvdmlkZXJ9JyBpcyBhYnNlbnQgZnJvbSBidWlsZE1hbmlmZXN0LnRhcmdldHNgLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKFxuICAgICAgcnVsZS5hcmNoaXRlY3R1cmUgIT09XG4gICAgICAoYmFzZUltYWdlICE9PSB1bmRlZmluZWQgPyBiYXNlSW1hZ2UuYXJjaGl0ZWN0dXJlIDogdW5kZWZpbmVkKVxuICAgICkge1xuICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgIGBjb21wYXRpYmlsaXR5WyR7aW5kZXh9XS5hcmNoaXRlY3R1cmUgbXVzdCBlcXVhbCBidWlsZE1hbmlmZXN0LmJhc2VJbWFnZS5hcmNoaXRlY3R1cmVgLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHJ1bGVIb3N0TW9kZWwgIT09IGhvc3RNb2RlbCkge1xuICAgICAgZXJyb3JzLnB1c2goYGNvbXBhdGliaWxpdHlbJHtpbmRleH1dLmhvc3RNb2RlbCBtdXN0IGVxdWFsIGFydGlmYWN0IGhvc3RNb2RlbCAnJHtob3N0TW9kZWx9J2ApO1xuICAgIH1cbiAgICBpZiAocnVsZUhvc3RNb2RlbCA9PT0gXCJ1YnVudHUtcmVsZWFzZS1idW5kbGVcIikge1xuICAgICAgaWYgKHJ1bGUudWJ1bnR1VmVyc2lvbiAhPT0gV09SS1NQQUNFX0hPU1RfQk9PVFNUUkFQX1VCVU5UVV9WRVJTSU9OKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgIGBjb21wYXRpYmlsaXR5WyR7aW5kZXh9XS51YnVudHVWZXJzaW9uIG11c3QgYmUgJyR7V09SS1NQQUNFX0hPU1RfQk9PVFNUUkFQX1VCVU5UVV9WRVJTSU9OfSdgLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKHJ1bGUuYm9vdGNCYXNlSW1hZ2UgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBlcnJvcnMucHVzaChgY29tcGF0aWJpbGl0eVske2luZGV4fV0uYm9vdGNCYXNlSW1hZ2UgaXMgaW52YWxpZCBmb3IgdGhlIFVidW50dSBob3N0IG1vZGVsYCk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGlmIChcbiAgICAgICAgdHlwZW9mIHJ1bGUuYm9vdGNCYXNlSW1hZ2UgIT09IFwic3RyaW5nXCIgfHxcbiAgICAgICAgIVJFR0lTVFJZX0lNQUdFLnRlc3QocnVsZS5ib290Y0Jhc2VJbWFnZSlcbiAgICAgICkge1xuICAgICAgICBlcnJvcnMucHVzaChgY29tcGF0aWJpbGl0eVske2luZGV4fV0uYm9vdGNCYXNlSW1hZ2UgbXVzdCBiZSBhIHJlZ2lzdHJ5LXF1YWxpZmllZCBpbWFnZSByZWZlcmVuY2VgKTtcbiAgICAgIH1cbiAgICAgIGlmIChydWxlLmJvb3RjQmFzZUltYWdlICE9PSBib290Y1JlY29yZD8uYmFzZUltYWdlKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKGBjb21wYXRpYmlsaXR5WyR7aW5kZXh9XS5ib290Y0Jhc2VJbWFnZSBtdXN0IGVxdWFsIGJvb3RjLmJhc2VJbWFnZWApO1xuICAgICAgfVxuICAgICAgaWYgKHJ1bGUudWJ1bnR1VmVyc2lvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKGBjb21wYXRpYmlsaXR5WyR7aW5kZXh9XS51YnVudHVWZXJzaW9uIGlzIGludmFsaWQgZm9yIHRoZSBib290YyBob3N0IG1vZGVsYCk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChcbiAgICAgIHJ1bGUuYm9vdHN0cmFwQ29udHJhY3RWZXJzaW9uICE9PVxuICAgICAgV09SS1NQQUNFX0hPU1RfQk9PVFNUUkFQX0NPTlRSQUNUX1ZFUlNJT05cbiAgICApIHtcbiAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICBgY29tcGF0aWJpbGl0eVske2luZGV4fV0uYm9vdHN0cmFwQ29udHJhY3RWZXJzaW9uIG11c3QgYmUgJyR7V09SS1NQQUNFX0hPU1RfQk9PVFNUUkFQX0NPTlRSQUNUX1ZFUlNJT059J2AsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoIUFycmF5LmlzQXJyYXkocnVsZS5hY3Rpb25zKSkge1xuICAgICAgZXJyb3JzLnB1c2goYGNvbXBhdGliaWxpdHlbJHtpbmRleH1dLmFjdGlvbnMgbXVzdCBiZSBhbiBhcnJheWApO1xuICAgIH0gZWxzZSB7XG4gICAgICBpZiAocnVsZS5hY3Rpb25zLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBlcnJvcnMucHVzaChgY29tcGF0aWJpbGl0eVske2luZGV4fV0uYWN0aW9ucyBtdXN0IG5vdCBiZSBlbXB0eWApO1xuICAgICAgfVxuICAgICAgY29uc3QgdW5pcXVlQWN0aW9ucyA9IG5ldyBTZXQocnVsZS5hY3Rpb25zKTtcbiAgICAgIGlmIChcbiAgICAgICAgdW5pcXVlQWN0aW9ucy5zaXplICE9PSBydWxlLmFjdGlvbnMubGVuZ3RoIHx8XG4gICAgICAgIHJ1bGUuYWN0aW9ucy5zb21lKFxuICAgICAgICAgIChhY3Rpb24pID0+ICFXT1JLU1BBQ0VfSE9TVF9JTUFHRV9BQ1RJT05TLmluY2x1ZGVzKGFjdGlvbiksXG4gICAgICAgIClcbiAgICAgICkge1xuICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICBgY29tcGF0aWJpbGl0eVske2luZGV4fV0uYWN0aW9ucyBtdXN0IGNvbnRhaW4gdW5pcXVlIHN1cHBvcnRlZCBhY3Rpb25zYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKFxuICAgICAgcnVsZS5tYXhpbXVtQXJ0aWZhY3RBZ2VEYXlzICE9PSB1bmRlZmluZWQgJiZcbiAgICAgICghTnVtYmVyLmlzU2FmZUludGVnZXIocnVsZS5tYXhpbXVtQXJ0aWZhY3RBZ2VEYXlzKSB8fFxuICAgICAgICBydWxlLm1heGltdW1BcnRpZmFjdEFnZURheXMgPD0gMClcbiAgICApIHtcbiAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICBgY29tcGF0aWJpbGl0eVske2luZGV4fV0ubWF4aW11bUFydGlmYWN0QWdlRGF5cyBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlcmAsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBrZXkgPSBbXG4gICAgICBydWxlLnByb3ZpZGVyLFxuICAgICAgcnVsZS5hcmNoaXRlY3R1cmUsXG4gICAgICBydWxlSG9zdE1vZGVsLFxuICAgICAgY29tcGF0aWJpbGl0eVBsYXRmb3JtKHJ1bGUpLFxuICAgICAgdHlwZW9mIHJ1bGUuYm9vdHN0cmFwQ29udHJhY3RWZXJzaW9uID09PSBcInN0cmluZ1wiXG4gICAgICAgID8gcnVsZS5ib290c3RyYXBDb250cmFjdFZlcnNpb25cbiAgICAgICAgOiBcIlwiLFxuICAgIF0uam9pbihcIlxcdTAwMDBcIik7XG4gICAgaWYgKHNlZW4uaGFzKGtleSkpIHtcbiAgICAgIGVycm9ycy5wdXNoKGBjb21wYXRpYmlsaXR5IGNvbnRhaW5zIGR1cGxpY2F0ZSBtYXRyaXggcm93ICR7aW5kZXh9YCk7XG4gICAgfVxuICAgIHNlZW4uYWRkKGtleSk7XG4gIH0pO1xuICByZXR1cm4gZXJyb3JzO1xufVxuXG4vKiogRmFpbC1jbG9zZWQgY29tcGF0aWJpbGl0eSB2ZXJkaWN0IGZvciBvbmUgZXhhY3QgaW1hZ2UgYXJ0aWZhY3QuICovXG5leHBvcnQgZnVuY3Rpb24gZXZhbHVhdGVXb3Jrc3BhY2VIb3N0SW1hZ2VDb21wYXRpYmlsaXR5KFxuICBhcnRpZmFjdDogV29ya3NwYWNlSG9zdEltYWdlQXJ0aWZhY3QsXG4gIHJlcXVlc3Q6IFdvcmtzcGFjZUhvc3RJbWFnZUNvbXBhdGliaWxpdHlSZXF1ZXN0LFxuKTogV29ya3NwYWNlSG9zdEltYWdlQ29tcGF0aWJpbGl0eVJlc3VsdCB7XG4gIGNvbnN0IGlzc3VlczogV29ya3NwYWNlSG9zdEltYWdlQ29tcGF0aWJpbGl0eUlzc3VlW10gPSBbXTtcbiAgY29uc3QgaW52YWxpZCA9IHZhbGlkYXRlV29ya3NwYWNlSG9zdEltYWdlQXJ0aWZhY3QoYXJ0aWZhY3QpO1xuICBpZiAoaW52YWxpZC5sZW5ndGggPiAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbXBhdGlibGU6IGZhbHNlLFxuICAgICAgaXNzdWVzOiBpbnZhbGlkLm1hcCgobWVzc2FnZSkgPT4gKHtcbiAgICAgICAgY29kZTogXCJpbnZhbGlkLWFydGlmYWN0XCIsXG4gICAgICAgIG1lc3NhZ2UsXG4gICAgICB9KSksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IG9ic2VydmVkQXQgPSBEYXRlLnBhcnNlKHJlcXVlc3Qub2JzZXJ2ZWRBdCk7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKG9ic2VydmVkQXQpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbXBhdGlibGU6IGZhbHNlLFxuICAgICAgaXNzdWVzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBjb2RlOiBcImludmFsaWQtb2JzZXJ2ZWQtYXRcIixcbiAgICAgICAgICBtZXNzYWdlOiBcIm9ic2VydmVkQXQgbXVzdCBiZSBhbiBJU08gdGltZXN0YW1wXCIsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH07XG4gIH1cbiAgY29uc3QgcmVxdWVzdEhvc3RNb2RlbCA9IGNvbXBhdGliaWxpdHlNb2RlbChyZXF1ZXN0KTtcbiAgY29uc3QgcmVxdWVzdFBsYXRmb3JtID1cbiAgICByZXF1ZXN0SG9zdE1vZGVsID09PSBcImJvb3RjLWltYWdlXCIgPyByZXF1ZXN0LmJvb3RjQmFzZUltYWdlIDogcmVxdWVzdC51YnVudHVWZXJzaW9uO1xuICBjb25zdCBtYXRjaGVkUnVsZSA9IGFydGlmYWN0LmNvbXBhdGliaWxpdHkuZmluZChcbiAgICAocnVsZSkgPT5cbiAgICAgIHJ1bGUucHJvdmlkZXIgPT09IHJlcXVlc3QucHJvdmlkZXIgJiZcbiAgICAgIHJ1bGUuYXJjaGl0ZWN0dXJlID09PSByZXF1ZXN0LmFyY2hpdGVjdHVyZSAmJlxuICAgICAgY29tcGF0aWJpbGl0eU1vZGVsKHJ1bGUpID09PSByZXF1ZXN0SG9zdE1vZGVsICYmXG4gICAgICBjb21wYXRpYmlsaXR5UGxhdGZvcm0ocnVsZSkgPT09IHJlcXVlc3RQbGF0Zm9ybSAmJlxuICAgICAgcnVsZS5ib290c3RyYXBDb250cmFjdFZlcnNpb24gPT09XG4gICAgICAgIFdPUktTUEFDRV9IT1NUX0JPT1RTVFJBUF9DT05UUkFDVF9WRVJTSU9OLFxuICApO1xuICBpZiAoIW1hdGNoZWRSdWxlKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbXBhdGlibGU6IGZhbHNlLFxuICAgICAgaXNzdWVzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBjb2RlOiBcIm1hdHJpeC1taXNzXCIsXG4gICAgICAgICAgbWVzc2FnZTogYE5vIGNvbXBhdGliaWxpdHkgcm93IG1hdGNoZXMgJHtyZXF1ZXN0LnByb3ZpZGVyfS8ke3JlcXVlc3QuYXJjaGl0ZWN0dXJlfS8ke3JlcXVlc3RIb3N0TW9kZWx9LyR7cmVxdWVzdFBsYXRmb3JtfWAsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH07XG4gIH1cbiAgaWYgKCFtYXRjaGVkUnVsZS5hY3Rpb25zLmluY2x1ZGVzKHJlcXVlc3QuYWN0aW9uKSkge1xuICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgIGNvZGU6IFwiYWN0aW9uLW5vdC1zdXBwb3J0ZWRcIixcbiAgICAgIG1lc3NhZ2U6IGBDb21wYXRpYmlsaXR5IHJvdyBkb2VzIG5vdCBhbGxvdyAnJHtyZXF1ZXN0LmFjdGlvbn0nYCxcbiAgICB9KTtcbiAgfVxuXG4gIGNvbnN0IHB1Ymxpc2hlZEF0ID0gRGF0ZS5wYXJzZShhcnRpZmFjdC5saWZlY3ljbGUucHVibGlzaGVkQXQpO1xuICBpZiAob2JzZXJ2ZWRBdCA8IHB1Ymxpc2hlZEF0KSB7XG4gICAgaXNzdWVzLnB1c2goe1xuICAgICAgY29kZTogXCJhcnRpZmFjdC1ub3QteWV0LXB1Ymxpc2hlZFwiLFxuICAgICAgbWVzc2FnZTogXCJBcnRpZmFjdCBwdWJsaWNhdGlvbiB0aW1lIGlzIGxhdGVyIHRoYW4gb2JzZXJ2ZWRBdFwiLFxuICAgIH0pO1xuICB9XG4gIGlmIChhcnRpZmFjdC5saWZlY3ljbGUuc3RhdGUgPT09IFwid2l0aGRyYXduXCIpIHtcbiAgICBpc3N1ZXMucHVzaCh7XG4gICAgICBjb2RlOiBcIndpdGhkcmF3bi1hcnRpZmFjdFwiLFxuICAgICAgbWVzc2FnZTpcbiAgICAgICAgXCJXaXRoZHJhd24gYXJ0aWZhY3RzIGFyZSBuZXZlciBpbnN0YWxsYWJsZSwgdXBncmFkZWFibGUsIG9yIHJvbGxiYWNrIHRhcmdldHNcIixcbiAgICB9KTtcbiAgfSBlbHNlIGlmIChcbiAgICBhcnRpZmFjdC5saWZlY3ljbGUuc3RhdGUgPT09IFwiZGVwcmVjYXRlZFwiICYmXG4gICAgcmVxdWVzdC5hY3Rpb24gIT09IFwicm9sbGJhY2tcIlxuICApIHtcbiAgICBpc3N1ZXMucHVzaCh7XG4gICAgICBjb2RlOiBcImRlcHJlY2F0ZWQtYXJ0aWZhY3RcIixcbiAgICAgIG1lc3NhZ2U6XG4gICAgICAgIFwiRGVwcmVjYXRlZCBhcnRpZmFjdHMgYXJlIGFjY2VwdGVkIG9ubHkgdGhyb3VnaCBhbiBleHBsaWNpdCByb2xsYmFjayBlZGdlXCIsXG4gICAgfSk7XG4gIH1cbiAgaWYgKFxuICAgIGFydGlmYWN0LmxpZmVjeWNsZS5zdXBwb3J0RW5kc0F0ICYmXG4gICAgb2JzZXJ2ZWRBdCA+IERhdGUucGFyc2UoYXJ0aWZhY3QubGlmZWN5Y2xlLnN1cHBvcnRFbmRzQXQpXG4gICkge1xuICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgIGNvZGU6IFwic3VwcG9ydC1lbmRlZFwiLFxuICAgICAgbWVzc2FnZTogYEFydGlmYWN0IHN1cHBvcnQgZW5kZWQgYXQgJHthcnRpZmFjdC5saWZlY3ljbGUuc3VwcG9ydEVuZHNBdH1gLFxuICAgIH0pO1xuICB9XG4gIGlmIChcbiAgICByZXF1ZXN0LmFjdGlvbiAhPT0gXCJyb2xsYmFja1wiICYmXG4gICAgbWF0Y2hlZFJ1bGUubWF4aW11bUFydGlmYWN0QWdlRGF5cyAhPT0gdW5kZWZpbmVkICYmXG4gICAgb2JzZXJ2ZWRBdCAtIHB1Ymxpc2hlZEF0ID4gbWF0Y2hlZFJ1bGUubWF4aW11bUFydGlmYWN0QWdlRGF5cyAqIERBWV9NU1xuICApIHtcbiAgICBpc3N1ZXMucHVzaCh7XG4gICAgICBjb2RlOiBcInN0YWxlLWFydGlmYWN0XCIsXG4gICAgICBtZXNzYWdlOiBgQXJ0aWZhY3QgZXhjZWVkcyB0aGUgJHttYXRjaGVkUnVsZS5tYXhpbXVtQXJ0aWZhY3RBZ2VEYXlzfS1kYXkgZnJlc2huZXNzIGNlaWxpbmdgLFxuICAgIH0pO1xuICB9XG4gIGlmIChyZXF1ZXN0LmFjdGlvbiA9PT0gXCJyb2xsYmFja1wiKSB7XG4gICAgaWYgKCFyZXF1ZXN0LmN1cnJlbnRBcnRpZmFjdCkge1xuICAgICAgaXNzdWVzLnB1c2goe1xuICAgICAgICBjb2RlOiBcInJvbGxiYWNrLXNvdXJjZS1taXNzaW5nXCIsXG4gICAgICAgIG1lc3NhZ2U6IFwiUm9sbGJhY2sgcmVxdWlyZXMgdGhlIGN1cnJlbnRseSBpbnN0YWxsZWQgYXJ0aWZhY3QgbWV0YWRhdGFcIixcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBpbnZhbGlkQ3VycmVudEFydGlmYWN0ID0gdmFsaWRhdGVXb3Jrc3BhY2VIb3N0SW1hZ2VBcnRpZmFjdChcbiAgICAgICAgcmVxdWVzdC5jdXJyZW50QXJ0aWZhY3QsXG4gICAgICApO1xuICAgICAgaWYgKGludmFsaWRDdXJyZW50QXJ0aWZhY3QubGVuZ3RoID4gMCkge1xuICAgICAgICBpc3N1ZXMucHVzaChcbiAgICAgICAgICAuLi5pbnZhbGlkQ3VycmVudEFydGlmYWN0Lm1hcCgobWVzc2FnZSkgPT4gKHtcbiAgICAgICAgICAgIGNvZGU6IFwiaW52YWxpZC1hcnRpZmFjdFwiIGFzIGNvbnN0LFxuICAgICAgICAgICAgbWVzc2FnZTogYGN1cnJlbnRBcnRpZmFjdDogJHttZXNzYWdlfWAsXG4gICAgICAgICAgfSkpLFxuICAgICAgICApO1xuICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgIXNhbWVJbWFnZShcbiAgICAgICAgICByZXF1ZXN0LmN1cnJlbnRBcnRpZmFjdC5saWZlY3ljbGUucm9sbGJhY2tUYXJnZXQsXG4gICAgICAgICAgYXJ0aWZhY3QuaW1hZ2UsXG4gICAgICAgIClcbiAgICAgICkge1xuICAgICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgICAgY29kZTogXCJyb2xsYmFjay10YXJnZXQtbWlzbWF0Y2hcIixcbiAgICAgICAgICBtZXNzYWdlOiBgQ3VycmVudCBpbWFnZSAke3JlcXVlc3QuY3VycmVudEFydGlmYWN0LmltYWdlLmlkfUAke3JlcXVlc3QuY3VycmVudEFydGlmYWN0LmltYWdlLnZlcnNpb259IGRvZXMgbm90IG5hbWUgJHthcnRpZmFjdC5pbWFnZS5pZH1AJHthcnRpZmFjdC5pbWFnZS52ZXJzaW9ufSBhcyBpdHMgcm9sbGJhY2sgdGFyZ2V0YCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG4gIHJldHVybiB7IGNvbXBhdGlibGU6IGlzc3Vlcy5sZW5ndGggPT09IDAsIG1hdGNoZWRSdWxlLCBpc3N1ZXMgfTtcbn1cblxuZnVuY3Rpb24gZml4dHVyZUJvb3RzdHJhcElucHV0KFxuICBhcnRpZmFjdDogV29ya3NwYWNlSG9zdEltYWdlQXJ0aWZhY3QsXG4gIHNwZWM6IFdvcmtzcGFjZUhvc3RDbGVhblJvb21JbnN0YWxsU3BlYyxcbik6IFdvcmtzcGFjZUhvc3RCb290c3RyYXBJbnB1dCB7XG4gIGNvbnN0IGhvc3RNb2RlbCA9IHdvcmtzcGFjZUhvc3RJbWFnZU1vZGVsKGFydGlmYWN0KTtcbiAgY29uc3QgYm9vdGMgPSBhcnRpZmFjdC5ob3N0TW9kZWwgPT09IFwiYm9vdGMtaW1hZ2VcIiA/IGFydGlmYWN0LmJvb3RjIDogdW5kZWZpbmVkO1xuICBpZiAoaG9zdE1vZGVsID09PSBcImJvb3RjLWltYWdlXCIgJiYgIWJvb3RjKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiYm9vdGMgaW1hZ2UgYXJ0aWZhY3QgaXMgbWlzc2luZyBpdHMgaW1hZ2UgaWRlbnRpdHlcIik7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBjb250cmFjdFZlcnNpb246IFdPUktTUEFDRV9IT1NUX0JPT1RTVFJBUF9DT05UUkFDVF9WRVJTSU9OLFxuICAgIGFjdGlvbjogc3BlYy5hY3Rpb24sXG4gICAgaG9zdElkOiBzcGVjLmhvc3RJZCxcbiAgICBob3N0TW9kZWwsXG4gICAgLi4uKGhvc3RNb2RlbCA9PT0gXCJib290Yy1pbWFnZVwiXG4gICAgICA/IHtcbiAgICAgICAgICBib290Yzoge1xuICAgICAgICAgICAgaW1hZ2U6IGJvb3RjIS5pbWFnZSxcbiAgICAgICAgICAgIGltYWdlRGlnZXN0OiBib290YyEuaW1hZ2VEaWdlc3QsXG4gICAgICAgICAgICBiYXNlSW1hZ2U6IGJvb3RjIS5iYXNlSW1hZ2UsXG4gICAgICAgICAgICBzaWduYXR1cmVQb2xpY3lQYXRoOiBib290YyEuc2lnbmF0dXJlUG9saWN5UGF0aCxcbiAgICAgICAgICB9LFxuICAgICAgICB9XG4gICAgICA6IHt9KSxcbiAgICByZWxlYXNlOiBhcnRpZmFjdC5yZWxlYXNlLFxuICAgIG1pZ3JhdGlvbklkOiBzcGVjLm1pZ3JhdGlvbklkLFxuICAgIG1pbmltdW1Ob2RlTWFqb3I6IHNwZWMubWluaW11bU5vZGVNYWpvcixcbiAgICBzZXJ2aWNlOiBzcGVjLnNlcnZpY2UsXG4gICAgaXNvbGF0aW9uOiBzcGVjLmlzb2xhdGlvbixcbiAgICAuLi4oc3BlYy5hZ2VudFJ1bnRpbWVJbnN0YWxscyA/IHsgYWdlbnRSdW50aW1lSW5zdGFsbHM6IHNwZWMuYWdlbnRSdW50aW1lSW5zdGFsbHMgfSA6IHt9KSxcbiAgICAuLi4oc3BlYy5zdGF0dXNDaGFubmVsID8geyBzdGF0dXNDaGFubmVsOiBzcGVjLnN0YXR1c0NoYW5uZWwgfSA6IHt9KSxcbiAgICB3b3Jrc3BhY2VBdXRob3JpemVkS2V5czogc3BlYy53b3Jrc3BhY2VBdXRob3JpemVkS2V5cz8ubGVuZ3RoXG4gICAgICA/IHNwZWMud29ya3NwYWNlQXV0aG9yaXplZEtleXNcbiAgICAgIDogW1dPUktTUEFDRV9IT1NUX0NMRUFOX1JPT01fQVVUSE9SSVpFRF9LRVldLFxuICAgIGVudHJ5cG9pbnRzOiBzcGVjLmVudHJ5cG9pbnRzLFxuICAgIHB1YmxpY01ldGFkYXRhOiB7XG4gICAgICAuLi5zcGVjLnB1YmxpY01ldGFkYXRhLFxuICAgICAgaW1hZ2VBY2NlcHRhbmNlOiB7XG4gICAgICAgIGZpeHR1cmVJZDogc3BlYy5maXh0dXJlSWQsXG4gICAgICAgIHByb3ZpZGVyOiBzcGVjLnByb3ZpZGVyLFxuICAgICAgICBhcmNoaXRlY3R1cmU6IHNwZWMuYXJjaGl0ZWN0dXJlLFxuICAgICAgICBpbWFnZUlkOiBhcnRpZmFjdC5pbWFnZS5pZCxcbiAgICAgICAgaW1hZ2VWZXJzaW9uOiBhcnRpZmFjdC5pbWFnZS52ZXJzaW9uLFxuICAgICAgICBtYW5pZmVzdElkZW50aXR5OiBhcnRpZmFjdC5idWlsZE1hbmlmZXN0Lm1hbmlmZXN0SWRlbnRpdHksXG4gICAgICB9LFxuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIGNsZWFuUm9vbUNvbXBhdGliaWxpdHlSZXF1ZXN0KFxuICBhcnRpZmFjdDogV29ya3NwYWNlSG9zdEltYWdlQXJ0aWZhY3QsXG4gIHNwZWM6IFdvcmtzcGFjZUhvc3RDbGVhblJvb21JbnN0YWxsU3BlYyxcbik6IFdvcmtzcGFjZUhvc3RJbWFnZUNvbXBhdGliaWxpdHlSZXF1ZXN0IHtcbiAgY29uc3QgaG9zdE1vZGVsID0gc3BlYy5ob3N0TW9kZWwgPz8gd29ya3NwYWNlSG9zdEltYWdlTW9kZWwoYXJ0aWZhY3QpO1xuICBjb25zdCBjb21tb24gPSB7XG4gICAgYWN0aW9uOiBzcGVjLmFjdGlvbixcbiAgICBwcm92aWRlcjogc3BlYy5wcm92aWRlcixcbiAgICBhcmNoaXRlY3R1cmU6IHNwZWMuYXJjaGl0ZWN0dXJlLFxuICAgIG9ic2VydmVkQXQ6IHNwZWMub2JzZXJ2ZWRBdCxcbiAgICBjdXJyZW50QXJ0aWZhY3Q6IHNwZWMuY3VycmVudEFydGlmYWN0LFxuICB9IGFzIGNvbnN0O1xuICByZXR1cm4gaG9zdE1vZGVsID09PSBcImJvb3RjLWltYWdlXCJcbiAgICA/IHtcbiAgICAgICAgLi4uY29tbW9uLFxuICAgICAgICBob3N0TW9kZWwsXG4gICAgICAgIGJvb3RjQmFzZUltYWdlOlxuICAgICAgICAgIHNwZWMuYm9vdGNCYXNlSW1hZ2UgPz9cbiAgICAgICAgICAoYXJ0aWZhY3QuaG9zdE1vZGVsID09PSBcImJvb3RjLWltYWdlXCJcbiAgICAgICAgICAgID8gYXJ0aWZhY3QuYm9vdGMuYmFzZUltYWdlXG4gICAgICAgICAgICA6IFdPUktTUEFDRV9IT1NUX0JPT1RDX0JBU0VfSU1BR0UpLFxuICAgICAgfVxuICAgIDoge1xuICAgICAgICAuLi5jb21tb24sXG4gICAgICAgIGhvc3RNb2RlbCxcbiAgICAgICAgdWJ1bnR1VmVyc2lvbjogV09SS1NQQUNFX0hPU1RfQk9PVFNUUkFQX1VCVU5UVV9WRVJTSU9OLFxuICAgICAgfTtcbn1cblxuLyoqIEJ1aWxkIHRoZSBleGFjdCBkZXRlcm1pbmlzdGljIHNjcmlwdCBhIGNsZWFuLXJvb20gZXhlY3V0b3IgbXVzdCBydW4uICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRXb3Jrc3BhY2VIb3N0Q2xlYW5Sb29tSW5zdGFsbEZpeHR1cmUoXG4gIGFydGlmYWN0OiBXb3Jrc3BhY2VIb3N0SW1hZ2VBcnRpZmFjdCxcbiAgc3BlYzogV29ya3NwYWNlSG9zdENsZWFuUm9vbUluc3RhbGxTcGVjLFxuKTogV29ya3NwYWNlSG9zdENsZWFuUm9vbUluc3RhbGxGaXh0dXJlIHtcbiAgY29uc3QgY29tcGF0aWJpbGl0eSA9IGV2YWx1YXRlV29ya3NwYWNlSG9zdEltYWdlQ29tcGF0aWJpbGl0eShcbiAgICBhcnRpZmFjdCxcbiAgICBjbGVhblJvb21Db21wYXRpYmlsaXR5UmVxdWVzdChhcnRpZmFjdCwgc3BlYyksXG4gICk7XG4gIGlmICghY29tcGF0aWJpbGl0eS5jb21wYXRpYmxlKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYFdvcmtzcGFjZS1ob3N0IGltYWdlIGlzIGluY29tcGF0aWJsZTogJHtjb21wYXRpYmlsaXR5Lmlzc3Vlc1xuICAgICAgICAubWFwKChpc3N1ZSkgPT4gYCR7aXNzdWUuY29kZX06ICR7aXNzdWUubWVzc2FnZX1gKVxuICAgICAgICAuam9pbihcIjsgXCIpfWAsXG4gICAgKTtcbiAgfVxuICBjb25zdCBmaXh0dXJlRXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICByZXF1aXJlVGV4dChzcGVjLmZpeHR1cmVJZCwgXCJmaXh0dXJlSWRcIiwgZml4dHVyZUVycm9ycyk7XG4gIGlmIChmaXh0dXJlRXJyb3JzLmxlbmd0aCA+IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoZml4dHVyZUVycm9ycy5qb2luKFwiOyBcIikpO1xuICB9XG4gIGNvbnN0IGJvb3RzdHJhcElucHV0ID0gZml4dHVyZUJvb3RzdHJhcElucHV0KGFydGlmYWN0LCBzcGVjKTtcbiAgY29uc3QgYm9vdHN0cmFwU2NyaXB0ID0gYnVpbGRXb3Jrc3BhY2VIb3N0Qm9vdHN0cmFwKGJvb3RzdHJhcElucHV0KTtcbiAgcmV0dXJuIHtcbiAgICBjb250cmFjdFZlcnNpb246IFdPUktTUEFDRV9IT1NUX0lNQUdFX0FDQ0VQVEFOQ0VfQ09OVFJBQ1RfVkVSU0lPTixcbiAgICBmaXh0dXJlSWQ6IHNwZWMuZml4dHVyZUlkLFxuICAgIGltYWdlOiBhcnRpZmFjdC5pbWFnZSxcbiAgICBtYW5pZmVzdElkZW50aXR5OiBhcnRpZmFjdC5idWlsZE1hbmlmZXN0Lm1hbmlmZXN0SWRlbnRpdHksXG4gICAgYm9vdHN0cmFwSW5wdXQsXG4gICAgYm9vdHN0cmFwU2NyaXB0LFxuICAgIGJvb3RzdHJhcFNjcmlwdFNoYTI1NjogY3JlYXRlSGFzaChcInNoYTI1NlwiKVxuICAgICAgLnVwZGF0ZShib290c3RyYXBTY3JpcHQsIFwidXRmOFwiKVxuICAgICAgLmRpZ2VzdChcImhleFwiKSxcbiAgfTtcbn1cblxuLyoqXG4gKiBSdW4gb25lIGRldGVybWluaXN0aWMgY2xlYW4tcm9vbSBpbnN0YWxsL3VwZ3JhZGUvcm9sbGJhY2sgZml4dHVyZS4gVGhlXG4gKiBleGVjdXRvciBpcyBpbmplY3RlZCBzbyByZXBvc2l0b3J5IHRlc3RzIHVzZSBhIGhlcm1ldGljIGZha2Ugd2hpbGUgYSBWTSByaWdcbiAqIGNhbiBydW4gdGhlIGlkZW50aWNhbCBzaWduZWQgYm9vdHN0cmFwIHNjcmlwdCB3aXRob3V0IGNoYW5naW5nIHRoZSBjb250cmFjdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bldvcmtzcGFjZUhvc3RDbGVhblJvb21BY2NlcHRhbmNlKFxuICBhcnRpZmFjdDogV29ya3NwYWNlSG9zdEltYWdlQXJ0aWZhY3QsXG4gIHNwZWM6IFdvcmtzcGFjZUhvc3RDbGVhblJvb21JbnN0YWxsU3BlYyxcbiAgZXhlY3V0b3I6IFdvcmtzcGFjZUhvc3RDbGVhblJvb21FeGVjdXRvcixcbik6IFByb21pc2U8V29ya3NwYWNlSG9zdENsZWFuUm9vbUFjY2VwdGFuY2VSZXBvcnQ+IHtcbiAgY29uc3QgY29tcGF0aWJpbGl0eSA9IGV2YWx1YXRlV29ya3NwYWNlSG9zdEltYWdlQ29tcGF0aWJpbGl0eShcbiAgICBhcnRpZmFjdCxcbiAgICBjbGVhblJvb21Db21wYXRpYmlsaXR5UmVxdWVzdChhcnRpZmFjdCwgc3BlYyksXG4gICk7XG4gIGNvbnN0IGJhc2UgPSB7XG4gICAgY29udHJhY3RWZXJzaW9uOiBXT1JLU1BBQ0VfSE9TVF9JTUFHRV9BQ0NFUFRBTkNFX0NPTlRSQUNUX1ZFUlNJT04sXG4gICAgZml4dHVyZUlkOiBzcGVjLmZpeHR1cmVJZCxcbiAgICBpbWFnZTogYXJ0aWZhY3QuaW1hZ2UsXG4gIH0gYXMgY29uc3Q7XG4gIGlmICghY29tcGF0aWJpbGl0eS5jb21wYXRpYmxlKSB7XG4gICAgcmV0dXJuIHsgLi4uYmFzZSwgcGFzc2VkOiBmYWxzZSwgY2hlY2tzOiBbXSwgaXNzdWVzOiBjb21wYXRpYmlsaXR5Lmlzc3VlcyB9O1xuICB9XG5cbiAgbGV0IGZpeHR1cmU6IFdvcmtzcGFjZUhvc3RDbGVhblJvb21JbnN0YWxsRml4dHVyZTtcbiAgdHJ5IHtcbiAgICBmaXh0dXJlID0gYnVpbGRXb3Jrc3BhY2VIb3N0Q2xlYW5Sb29tSW5zdGFsbEZpeHR1cmUoYXJ0aWZhY3QsIHNwZWMpO1xuICAgIGNvbnN0IHJlcGxheSA9IGJ1aWxkV29ya3NwYWNlSG9zdENsZWFuUm9vbUluc3RhbGxGaXh0dXJlKGFydGlmYWN0LCBzcGVjKTtcbiAgICBpZiAoXG4gICAgICBmaXh0dXJlLmJvb3RzdHJhcFNjcmlwdCAhPT0gcmVwbGF5LmJvb3RzdHJhcFNjcmlwdCB8fFxuICAgICAgZml4dHVyZS5ib290c3RyYXBTY3JpcHRTaGEyNTYgIT09IHJlcGxheS5ib290c3RyYXBTY3JpcHRTaGEyNTZcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcImNsZWFuLXJvb20gYm9vdHN0cmFwIGZpeHR1cmUgaXMgbm90IGRldGVybWluaXN0aWNcIik7XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiB7XG4gICAgICAuLi5iYXNlLFxuICAgICAgcGFzc2VkOiBmYWxzZSxcbiAgICAgIGNoZWNrczogW1wiYXJ0aWZhY3QtaWRlbnRpdHlcIiwgXCJjb21wYXRpYmlsaXR5LW1hdHJpeFwiXSxcbiAgICAgIGlzc3VlczogW1xuICAgICAgICB7XG4gICAgICAgICAgY29kZTogXCJpbnZhbGlkLWFydGlmYWN0XCIsXG4gICAgICAgICAgbWVzc2FnZTogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9O1xuICB9XG5cbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBleGVjdXRvci5leGVjdXRlKGZpeHR1cmUpO1xuICAgIGNvbnN0IGF0dGVzdGF0aW9uID0gcGFyc2VXb3Jrc3BhY2VIb3N0Qm9vdHN0cmFwQXR0ZXN0YXRpb24ocmVzdWx0LnN0ZG91dCk7XG4gICAgY29uc3QgdmFsaWRhdGlvbiA9IHZhbGlkYXRlV29ya3NwYWNlSG9zdEJvb3RzdHJhcEF0dGVzdGF0aW9uKFxuICAgICAgYXR0ZXN0YXRpb24sXG4gICAgICBmaXh0dXJlLmJvb3RzdHJhcElucHV0LFxuICAgICk7XG4gICAgaWYgKCF2YWxpZGF0aW9uLm9rKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBwYXNzZWQ6IGZhbHNlLFxuICAgICAgICBjaGVja3M6IFtcbiAgICAgICAgICBcImFydGlmYWN0LWlkZW50aXR5XCIsXG4gICAgICAgICAgXCJjb21wYXRpYmlsaXR5LW1hdHJpeFwiLFxuICAgICAgICAgIFwiZGV0ZXJtaW5pc3RpYy1ib290c3RyYXAtZml4dHVyZVwiLFxuICAgICAgICBdLFxuICAgICAgICBpc3N1ZXM6IHZhbGlkYXRpb24uZXJyb3JzLm1hcCgobWVzc2FnZSkgPT4gKHtcbiAgICAgICAgICBjb2RlOiBcImludmFsaWQtYXJ0aWZhY3RcIixcbiAgICAgICAgICBtZXNzYWdlOiBgY2xlYW4tcm9vbSBhdHRlc3RhdGlvbjogJHttZXNzYWdlfWAsXG4gICAgICAgIH0pKSxcbiAgICAgICAgYm9vdHN0cmFwU2NyaXB0U2hhMjU2OiBmaXh0dXJlLmJvb3RzdHJhcFNjcmlwdFNoYTI1NixcbiAgICAgICAgYXR0ZXN0YXRpb24sXG4gICAgICB9O1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgLi4uYmFzZSxcbiAgICAgIHBhc3NlZDogdHJ1ZSxcbiAgICAgIGNoZWNrczogW1xuICAgICAgICBcImFydGlmYWN0LWlkZW50aXR5XCIsXG4gICAgICAgIFwiY29tcGF0aWJpbGl0eS1tYXRyaXhcIixcbiAgICAgICAgXCJkZXRlcm1pbmlzdGljLWJvb3RzdHJhcC1maXh0dXJlXCIsXG4gICAgICAgIFwiZXhhY3QtYm9vdHN0cmFwLWF0dGVzdGF0aW9uXCIsXG4gICAgICBdLFxuICAgICAgaXNzdWVzOiBbXSxcbiAgICAgIGJvb3RzdHJhcFNjcmlwdFNoYTI1NjogZml4dHVyZS5ib290c3RyYXBTY3JpcHRTaGEyNTYsXG4gICAgICBhdHRlc3RhdGlvbixcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiB7XG4gICAgICAuLi5iYXNlLFxuICAgICAgcGFzc2VkOiBmYWxzZSxcbiAgICAgIGNoZWNrczogW1xuICAgICAgICBcImFydGlmYWN0LWlkZW50aXR5XCIsXG4gICAgICAgIFwiY29tcGF0aWJpbGl0eS1tYXRyaXhcIixcbiAgICAgICAgXCJkZXRlcm1pbmlzdGljLWJvb3RzdHJhcC1maXh0dXJlXCIsXG4gICAgICBdLFxuICAgICAgaXNzdWVzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBjb2RlOiBcImludmFsaWQtYXJ0aWZhY3RcIixcbiAgICAgICAgICBtZXNzYWdlOiBgY2xlYW4tcm9vbSBleGVjdXRpb246ICR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpfWAsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgYm9vdHN0cmFwU2NyaXB0U2hhMjU2OiBmaXh0dXJlLmJvb3RzdHJhcFNjcmlwdFNoYTI1NixcbiAgICB9O1xuICB9XG59XG5cbi8qKiBCdWlsZCBhbiBleGFjdCBoZWFsdGh5IGF0dGVzdGF0aW9uIGZvciBkZXRlcm1pbmlzdGljIGZha2UgY2xlYW4tcm9vbSBleGVjdXRvcnMuICovXG5leHBvcnQgZnVuY3Rpb24gd29ya3NwYWNlSG9zdENsZWFuUm9vbUZpeHR1cmVBdHRlc3RhdGlvbihcbiAgZml4dHVyZTogV29ya3NwYWNlSG9zdENsZWFuUm9vbUluc3RhbGxGaXh0dXJlLFxuICBvYnNlcnZlZEF0OiBzdHJpbmcsXG4gIG5vZGVNYWpvciA9IGZpeHR1cmUuYm9vdHN0cmFwSW5wdXQubWluaW11bU5vZGVNYWpvcixcbik6IFdvcmtzcGFjZUhvc3RCb290c3RyYXBBdHRlc3RhdGlvbiB7XG4gIGNvbnN0IHNlcnZpY2VVc2VyID1cbiAgICBmaXh0dXJlLmJvb3RzdHJhcElucHV0LnNlcnZpY2UudXNlciA/PyBERUZBVUxUX1dPUktTUEFDRV9IT1NUX1NFUlZJQ0VfVVNFUjtcbiAgY29uc3Qgc2VydmljZUdyb3VwID0gZml4dHVyZS5ib290c3RyYXBJbnB1dC5zZXJ2aWNlLmdyb3VwID8/IHNlcnZpY2VVc2VyO1xuICBjb25zdCB3b3Jrc3BhY2VVc2VyID1cbiAgICBmaXh0dXJlLmJvb3RzdHJhcElucHV0Lmlzb2xhdGlvbj8ud29ya3NwYWNlVXNlciA/P1xuICAgIERFRkFVTFRfV09SS1NQQUNFX0hPU1RfV09SS1NQQUNFX1VTRVI7XG4gIGNvbnN0IHdvcmtzcGFjZUdyb3VwID1cbiAgICBmaXh0dXJlLmJvb3RzdHJhcElucHV0Lmlzb2xhdGlvbj8ud29ya3NwYWNlR3JvdXAgPz8gd29ya3NwYWNlVXNlcjtcbiAgY29uc3QgYWdlbnRVc2VyID1cbiAgICBmaXh0dXJlLmJvb3RzdHJhcElucHV0Lmlzb2xhdGlvbj8uYWdlbnRVc2VyID8/XG4gICAgREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9BR0VOVF9VU0VSO1xuICBjb25zdCBhZ2VudEdyb3VwID0gZml4dHVyZS5ib290c3RyYXBJbnB1dC5pc29sYXRpb24/LmFnZW50R3JvdXAgPz8gYWdlbnRVc2VyO1xuICBjb25zdCBjb21tb24gPSB7XG4gICAgY29udHJhY3RWZXJzaW9uOiBXT1JLU1BBQ0VfSE9TVF9CT09UU1RSQVBfQ09OVFJBQ1RfVkVSU0lPTixcbiAgICBob3N0SWQ6IGZpeHR1cmUuYm9vdHN0cmFwSW5wdXQuaG9zdElkLFxuICAgIGFjdGlvbjogZml4dHVyZS5ib290c3RyYXBJbnB1dC5hY3Rpb24sXG4gICAgb2JzZXJ2ZWRBdCxcbiAgICBzdGF0dXM6IFwiaGVhbHRoeVwiLFxuICAgIG1pZ3JhdGlvbjogeyBpZDogZml4dHVyZS5ib290c3RyYXBJbnB1dC5taWdyYXRpb25JZCwgYXBwbGllZDogdHJ1ZSB9LFxuICAgIHJ1bnRpbWU6IHtcbiAgICAgIG5vZGVNYWpvcixcbiAgICAgIG1pbmltdW1Ob2RlTWFqb3I6IGZpeHR1cmUuYm9vdHN0cmFwSW5wdXQubWluaW11bU5vZGVNYWpvcixcbiAgICAgIHBzdTogdHJ1ZSxcbiAgICAgIHB1aTogdHJ1ZSxcbiAgICAgIGFnZW50TGF1bmNoZXJzOiB7IGNsYXVkZTogdHJ1ZSwgY29kZXg6IHRydWUsIG9tcDogdHJ1ZSB9LFxuICAgICAgLy8gQSBjbGVhbi1yb29tIGltYWdlIGlzIHZhbGlkYXRlZCBiZWZvcmUgYW55IGhvc3QgcHJvdmlzaW9uaW5nIHJ1bnMsIHNvIG5vIHZlbmRvciBhZ2VudFxuICAgICAgLy8gcnVudGltZSBoYXMgYmVlbiBpbnN0YWxsZWQgYXQgdGhpcyBwb2ludCAoRC0yNTkpLiBGYWxzZSBpcyB0aGUgYWNjdXJhdGUgcmVhZGluZywgbm90IGFcbiAgICAgIC8vIHBsYWNlaG9sZGVyIOKAlCB0aGUgZml4dHVyZSBtdXN0IG5vdCBjbGFpbSBhIGNhcGFiaWxpdHkgdGhlIGltYWdlIGRvZXMgbm90IGNhcnJ5LlxuICAgICAgYWdlbnRSdW50aW1lc0luc3RhbGxlZEJ5Qm9vdHN0cmFwOiBmYWxzZSxcbiAgICAgIGFnZW50UnVudGltZXNWZXJpZmllZEJ5Qm9vdHN0cmFwOiBmYWxzZSxcbiAgICB9LFxuICAgIHNlcnZpY2U6IHtcbiAgICAgIG5hbWU6IGZpeHR1cmUuYm9vdHN0cmFwSW5wdXQuc2VydmljZS5uYW1lLFxuICAgICAgdXNlcjogc2VydmljZVVzZXIsXG4gICAgICBncm91cDogc2VydmljZUdyb3VwLFxuICAgICAgYmluZEhvc3Q6IFwiMTI3LjAuMC4xXCIsXG4gICAgICBwb3J0OiBmaXh0dXJlLmJvb3RzdHJhcElucHV0LnNlcnZpY2UucG9ydCxcbiAgICAgIGFjdGl2ZTogdHJ1ZSxcbiAgICB9LFxuICAgIGlzb2xhdGlvbjoge1xuICAgICAgd29ya3NwYWNlVXNlcixcbiAgICAgIHdvcmtzcGFjZUdyb3VwLFxuICAgICAgYWdlbnRVc2VyLFxuICAgICAgYWdlbnRHcm91cCxcbiAgICAgIHJ1bnRpbWVSb290OiBXT1JLU1BBQ0VfSE9TVF9SVU5USU1FX1JPT1QsXG4gICAgICBzdGF0ZVJvb3Q6IFdPUktTUEFDRV9IT1NUX1NUQVRFX1JPT1QsXG4gICAgICB3b3Jrc3BhY2VSb290OiBXT1JLU1BBQ0VfSE9TVF9EQVRBX1JPT1QsXG4gICAgICBydW50aW1lUmVhZGFibGVCeVdvcmtzcGFjZVVzZXI6IGZhbHNlLFxuICAgICAgcnVudGltZVdyaXRhYmxlQnlXb3Jrc3BhY2VVc2VyOiBmYWxzZSxcbiAgICAgIHJ1bnRpbWVSZWFkYWJsZUJ5QWdlbnRVc2VyOiB0cnVlLFxuICAgICAgcnVudGltZVdyaXRhYmxlQnlBZ2VudFVzZXI6IGZhbHNlLFxuICAgICAgYWdlbnRIb21lUmVhZGFibGVCeVNzaFVzZXI6IGZhbHNlLFxuICAgICAgd29ya3NwYWNlV3JpdGFibGVCeVNlcnZpY2U6IHRydWUsXG4gICAgICB3b3Jrc3BhY2VXcml0YWJsZUJ5U3NoVXNlcjogdHJ1ZSxcbiAgICAgIHdvcmtzcGFjZVdyaXRhYmxlQnlBZ2VudFVzZXI6IHRydWUsXG4gICAgICBzdWRvOiBmYWxzZSxcbiAgICAgIHNlcnZpY2VHcm91cE1lbWJlcjogZmFsc2UsXG4gICAgICBvcGVyYXRvckluZ3Jlc3M6IFwic3NoLWxvY2FsLWZvcndhcmRcIixcbiAgICB9LFxuICB9IGFzIGNvbnN0O1xuICBpZiAoZml4dHVyZS5ib290c3RyYXBJbnB1dC5ob3N0TW9kZWwgPT09IFwiYm9vdGMtaW1hZ2VcIikge1xuICAgIGNvbnN0IGJvb3RjID0gZml4dHVyZS5ib290c3RyYXBJbnB1dC5ib290YztcbiAgICBpZiAoIWJvb3RjKSB0aHJvdyBuZXcgRXJyb3IoXCJib290YyBjbGVhbi1yb29tIGZpeHR1cmUgaXMgbWlzc2luZyBpdHMgaW1hZ2UgaWRlbnRpdHlcIik7XG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLmNvbW1vbixcbiAgICAgIGhvc3RNb2RlbDogXCJib290Yy1pbWFnZVwiLFxuICAgICAgYm9vdGNCYXNlSW1hZ2U6IGJvb3RjLmJhc2VJbWFnZSA/PyBXT1JLU1BBQ0VfSE9TVF9CT09UQ19CQVNFX0lNQUdFLFxuICAgICAgcmVsZWFzZToge1xuICAgICAgICB2ZXJzaW9uOiBmaXh0dXJlLmJvb3RzdHJhcElucHV0LnJlbGVhc2UudmVyc2lvbixcbiAgICAgICAgLy8gV2hhdCBgYm9vdGMgc3RhdHVzYCByZXBvcnRzIG9uIGEgY29ycmVjdCBob3N0OiB0aGUgZGlnZXN0LXBpbm5lZCByZWYgKFdJLTEwMDA2MzM5KS5cbiAgICAgICAgc291cmNlOiB3b3Jrc3BhY2VIb3N0Qm9vdGNQaW5uZWRJbWFnZVJlZihib290YyksXG4gICAgICAgIGltYWdlRGlnZXN0OiBib290Yy5pbWFnZURpZ2VzdCxcbiAgICAgICAgc2lnbmF0dXJlUG9saWN5UGF0aDogYm9vdGMuc2lnbmF0dXJlUG9saWN5UGF0aCxcbiAgICAgICAgc2lnbmF0dXJlVmVyaWZpZWQ6IHRydWUsXG4gICAgICB9LFxuICAgICAgaXNvbGF0aW9uOiB7XG4gICAgICAgIC4uLmNvbW1vbi5pc29sYXRpb24sXG4gICAgICAgIHVwZGF0ZU1vZGU6IFwiYm9vdGMtYXRvbWljLWltYWdlLXN3YXBcIixcbiAgICAgIH0sXG4gICAgICBjaGVja3M6IHdvcmtzcGFjZUhvc3RCb290c3RyYXBDaGVja3MoXCJib290Yy1pbWFnZVwiKS5tYXAoKG5hbWUpID0+ICh7XG4gICAgICAgIG5hbWUsXG4gICAgICAgIG9rOiB0cnVlIGFzIGNvbnN0LFxuICAgICAgfSkpLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHtcbiAgICAuLi5jb21tb24sXG4gICAgaG9zdE1vZGVsOiBcInVidW50dS1yZWxlYXNlLWJ1bmRsZVwiLFxuICAgIHVidW50dVZlcnNpb246IFdPUktTUEFDRV9IT1NUX0JPT1RTVFJBUF9VQlVOVFVfVkVSU0lPTixcbiAgICByZWxlYXNlOiB7XG4gICAgICB2ZXJzaW9uOiBmaXh0dXJlLmJvb3RzdHJhcElucHV0LnJlbGVhc2UudmVyc2lvbixcbiAgICAgIHNvdXJjZTogZml4dHVyZS5ib290c3RyYXBJbnB1dC5yZWxlYXNlLmJ1bmRsZVVybCxcbiAgICAgIGJ1bmRsZVNoYTI1NjogZml4dHVyZS5ib290c3RyYXBJbnB1dC5yZWxlYXNlLmJ1bmRsZVNoYTI1NixcbiAgICAgIHNpZ25pbmdLZXlTaGEyNTY6IGZpeHR1cmUuYm9vdHN0cmFwSW5wdXQucmVsZWFzZS5zaWduaW5nS2V5U2hhMjU2LFxuICAgICAgc2lnbmF0dXJlVmVyaWZpZWQ6IHRydWUsXG4gICAgfSxcbiAgICBpc29sYXRpb246IHtcbiAgICAgIC4uLmNvbW1vbi5pc29sYXRpb24sXG4gICAgICB1cGRhdGVNb2RlOiBcInNpZ25lZC1hdG9taWMtcmVsZWFzZS1zd2FwXCIsXG4gICAgfSxcbiAgICBjaGVja3M6IHdvcmtzcGFjZUhvc3RCb290c3RyYXBDaGVja3MoXCJ1YnVudHUtcmVsZWFzZS1idW5kbGVcIikubWFwKChuYW1lKSA9PiAoe1xuICAgICAgbmFtZSxcbiAgICAgIG9rOiB0cnVlIGFzIGNvbnN0LFxuICAgIH0pKSxcbiAgfTtcbn1cbiJdLCJmaWxlIjoiL0Bmcy9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2RlcGxveW1lbnQtZHJpdmVyL3NyYy93b3Jrc3BhY2UtaG9zdC1pbWFnZS50cyJ9

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2RlcGxveW1lbnQtZHJpdmVyL3NyYy93b3Jrc3BhY2UtaG9zdC1pbWFnZS50cyIsIi9AZnMvaG9tZS9tYXJzaC1vZmZpY2UvcGFwZXJjdXBhaS13b3Jrc3BhY2UvcGFwZXJjdXNwL2xpYnMvZ2VuZXJpYy9kZXBsb3ltZW50LWRyaXZlci9zcmMvd29ya3NwYWNlLWhvc3QtaW1hZ2UudHMiLFtdXQ==
}}