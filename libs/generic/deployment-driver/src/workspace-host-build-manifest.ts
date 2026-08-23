import { createHash } from "node:crypto";

import { canonicalize } from "@papercusp/publish-auth/jcs";

import type { WorkspaceHostProviderTarget } from "./workspace-host-types";

export const WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION =
  "papercusp-workspace-host-build-input-v1";
export const WORKSPACE_HOST_BUILD_MANIFEST_SCHEMA_VERSION = 1;
export const WORKSPACE_HOST_SHARED_BUILDER_KIND = "hashicorp-packer";

export type WorkspaceHostBuildParameterValue = string | number | boolean;

export interface WorkspaceHostBuildMaterial {
  /** Repository-relative POSIX path. Absolute paths and traversal are refused. */
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly executable?: boolean;
}

export interface WorkspaceHostBuildParameter {
  readonly name: string;
  /** Build-shaping, non-secret value. Secret-shaped parameter names are refused. */
  readonly value: WorkspaceHostBuildParameterValue;
}

export interface WorkspaceHostBuildTarget {
  readonly provider: WorkspaceHostProviderTarget;
  /** Provider locations receiving identical built bytes. Empty means provider-global. */
  readonly locations: readonly string[];
}

export interface WorkspaceHostBuildManifestInput {
  readonly contractVersion: typeof WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION;
  readonly distributionProfile: "vm-release";
  readonly source: {
    readonly repository: string;
    /** Immutable Git object identity (SHA-1 or SHA-256 repository format). */
    readonly revision: string;
  };
  readonly releaseArtifact: {
    readonly name: string;
    readonly version: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  };
  readonly baseImage: {
    readonly reference: string;
    readonly architecture: string;
    readonly sha256: string;
  };
  readonly builder: {
    readonly strategy: "shared";
    readonly kind: typeof WORKSPACE_HOST_SHARED_BUILDER_KIND;
    readonly version: string;
    readonly templatePath: string;
    readonly templateSha256: string;
  };
  readonly materials: readonly WorkspaceHostBuildMaterial[];
  readonly parameters: readonly WorkspaceHostBuildParameter[];
  readonly targets: readonly WorkspaceHostBuildTarget[];
}

export interface WorkspaceHostBuildManifestPayload extends WorkspaceHostBuildManifestInput {
  readonly schemaVersion: typeof WORKSPACE_HOST_BUILD_MANIFEST_SCHEMA_VERSION;
}

export interface WorkspaceHostBuildManifest extends WorkspaceHostBuildManifestPayload {
  /** SHA-256 over RFC 8785 canonical JSON of the normalized payload, excluding this field. */
  readonly manifestIdentity: `sha256:${string}`;
}

export interface WorkspaceHostBuildManifestVerification {
  readonly ok: boolean;
  readonly expectedIdentity: `sha256:${string}`;
  readonly errors: readonly string[];
}

export class WorkspaceHostBuildManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceHostBuildManifestError";
  }
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SECRET_PARAMETER =
  /(?:^|[-_.])(credential|password|private[-_]?key|secret|token)(?:$|[-_.])/i;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireText(value: string, path: string): string {
  if (value.trim().length === 0)
    throw new WorkspaceHostBuildManifestError(
      `${path} must be a non-empty string`,
    );
  return value;
}

function requireSha256(value: string, path: string): string {
  if (!SHA256_HEX.test(value)) {
    throw new WorkspaceHostBuildManifestError(
      `${path} must be a lowercase 64-character SHA-256 hex digest`,
    );
  }
  return value;
}

function requireSize(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceHostBuildManifestError(
      `${path} must be a non-negative safe integer`,
    );
  }
  return value;
}

function requireRelativePath(value: string, path: string): string {
  requireText(value, path);
  const segments = value.split("/");
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new WorkspaceHostBuildManifestError(
      `${path} must be a normalized repository-relative POSIX path`,
    );
  }
  return value;
}

function assertUnique(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value))
      throw new WorkspaceHostBuildManifestError(
        `${path} contains duplicate '${value}'`,
      );
    seen.add(value);
  }
}

function normalizeMaterials(
  materials: readonly WorkspaceHostBuildMaterial[],
): WorkspaceHostBuildMaterial[] {
  if (materials.length === 0)
    throw new WorkspaceHostBuildManifestError(
      "materials must contain at least one build input",
    );
  const normalized = materials.map((material, index) => ({
    path: requireRelativePath(material.path, `materials[${index}].path`),
    sha256: requireSha256(material.sha256, `materials[${index}].sha256`),
    sizeBytes: requireSize(material.sizeBytes, `materials[${index}].sizeBytes`),
    ...(material.executable === undefined
      ? {}
      : { executable: material.executable }),
  }));
  assertUnique(
    normalized.map((material) => material.path),
    "materials",
  );
  return normalized.sort((left, right) => compareText(left.path, right.path));
}

function normalizeParameters(
  parameters: readonly WorkspaceHostBuildParameter[],
): WorkspaceHostBuildParameter[] {
  const normalized = parameters.map((parameter, index) => {
    const name = requireText(parameter.name, `parameters[${index}].name`);
    if (SECRET_PARAMETER.test(name)) {
      throw new WorkspaceHostBuildManifestError(
        `parameters[${index}].name '${name}' is secret-shaped and cannot enter the manifest`,
      );
    }
    if (
      typeof parameter.value === "number" &&
      !Number.isFinite(parameter.value)
    ) {
      throw new WorkspaceHostBuildManifestError(
        `parameters[${index}].value must be finite`,
      );
    }
    return { name, value: parameter.value };
  });
  assertUnique(
    normalized.map((parameter) => parameter.name),
    "parameters",
  );
  return normalized.sort((left, right) => compareText(left.name, right.name));
}

function normalizeTargets(
  targets: readonly WorkspaceHostBuildTarget[],
): WorkspaceHostBuildTarget[] {
  if (targets.length === 0)
    throw new WorkspaceHostBuildManifestError(
      "targets must contain at least one provider",
    );
  const normalized = targets.map((target, index) => {
    const provider = requireText(target.provider, `targets[${index}].provider`);
    const locations = target.locations.map((location, locationIndex) =>
      requireText(location, `targets[${index}].locations[${locationIndex}]`),
    );
    assertUnique(locations, `targets[${index}].locations`);
    return { provider, locations: [...locations].sort(compareText) };
  });
  assertUnique(
    normalized.map((target) => target.provider),
    "targets",
  );
  return normalized.sort((left, right) =>
    compareText(left.provider, right.provider),
  );
}

export function normalizeWorkspaceHostBuildManifestInput(
  input: WorkspaceHostBuildManifestInput,
): WorkspaceHostBuildManifestPayload {
  if (input.contractVersion !== WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION) {
    throw new WorkspaceHostBuildManifestError(
      `contractVersion must be '${WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION}'`,
    );
  }
  if (input.distributionProfile !== "vm-release") {
    throw new WorkspaceHostBuildManifestError(
      "distributionProfile must be 'vm-release'",
    );
  }
  if (!GIT_REVISION.test(input.source.revision)) {
    throw new WorkspaceHostBuildManifestError(
      "source.revision must be a lowercase immutable Git SHA-1 or SHA-256 object id",
    );
  }
  if (
    input.builder.strategy !== "shared" ||
    input.builder.kind !== WORKSPACE_HOST_SHARED_BUILDER_KIND
  ) {
    throw new WorkspaceHostBuildManifestError(
      `builder must select shared '${WORKSPACE_HOST_SHARED_BUILDER_KIND}' per the canonical build decision`,
    );
  }

  return {
    schemaVersion: WORKSPACE_HOST_BUILD_MANIFEST_SCHEMA_VERSION,
    contractVersion: input.contractVersion,
    distributionProfile: input.distributionProfile,
    source: {
      repository: requireText(input.source.repository, "source.repository"),
      revision: input.source.revision,
    },
    releaseArtifact: {
      name: requireText(input.releaseArtifact.name, "releaseArtifact.name"),
      version: requireText(
        input.releaseArtifact.version,
        "releaseArtifact.version",
      ),
      sha256: requireSha256(
        input.releaseArtifact.sha256,
        "releaseArtifact.sha256",
      ),
      sizeBytes: requireSize(
        input.releaseArtifact.sizeBytes,
        "releaseArtifact.sizeBytes",
      ),
    },
    baseImage: {
      reference: requireText(input.baseImage.reference, "baseImage.reference"),
      architecture: requireText(
        input.baseImage.architecture,
        "baseImage.architecture",
      ),
      sha256: requireSha256(input.baseImage.sha256, "baseImage.sha256"),
    },
    builder: {
      strategy: input.builder.strategy,
      kind: input.builder.kind,
      version: requireText(input.builder.version, "builder.version"),
      templatePath: requireRelativePath(
        input.builder.templatePath,
        "builder.templatePath",
      ),
      templateSha256: requireSha256(
        input.builder.templateSha256,
        "builder.templateSha256",
      ),
    },
    materials: normalizeMaterials(input.materials),
    parameters: normalizeParameters(input.parameters),
    targets: normalizeTargets(input.targets),
  };
}

export function canonicalWorkspaceHostBuildManifestPayload(
  payload: WorkspaceHostBuildManifestPayload,
): string {
  // TypeScript's structural typing permits a full manifest at this boundary.
  // Strip the self-referential identity at runtime so every caller hashes only
  // the payload even when it passes the enriched object directly.
  const { manifestIdentity: _manifestIdentity, ...canonicalPayload } =
    payload as WorkspaceHostBuildManifest;
  return canonicalize(canonicalPayload);
}

function identityFor(
  payload: WorkspaceHostBuildManifestPayload,
): `sha256:${string}` {
  const digest = createHash("sha256")
    .update(canonicalWorkspaceHostBuildManifestPayload(payload), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

export function buildWorkspaceHostBuildManifest(
  input: WorkspaceHostBuildManifestInput,
): WorkspaceHostBuildManifest {
  const payload = normalizeWorkspaceHostBuildManifestInput(input);
  return { ...payload, manifestIdentity: identityFor(payload) };
}

export function verifyWorkspaceHostBuildManifest(
  manifest: WorkspaceHostBuildManifest,
): WorkspaceHostBuildManifestVerification {
  try {
    const {
      manifestIdentity,
      schemaVersion: _schemaVersion,
      ...input
    } = manifest;
    const payload = normalizeWorkspaceHostBuildManifestInput(input);
    const expectedIdentity = identityFor(payload);
    const errors = [
      ...(manifest.schemaVersion ===
      WORKSPACE_HOST_BUILD_MANIFEST_SCHEMA_VERSION
        ? []
        : [
            `schemaVersion must be ${WORKSPACE_HOST_BUILD_MANIFEST_SCHEMA_VERSION}`,
          ]),
      ...(manifestIdentity === expectedIdentity
        ? []
        : [
            `manifestIdentity ${manifestIdentity} does not match canonical payload ${expectedIdentity}`,
          ]),
    ];
    return { ok: errors.length === 0, expectedIdentity, errors };
  } catch (error) {
    return {
      ok: false,
      expectedIdentity: `sha256:${"0".repeat(64)}`,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}
