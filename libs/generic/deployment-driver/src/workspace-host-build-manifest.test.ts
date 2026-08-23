import { describe, expect, it } from "vitest";

import {
  WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
  WORKSPACE_HOST_SHARED_BUILDER_KIND,
  WorkspaceHostBuildManifestError,
  buildWorkspaceHostBuildManifest,
  canonicalWorkspaceHostBuildManifestPayload,
  verifyWorkspaceHostBuildManifest,
  type WorkspaceHostBuildManifestInput,
} from "./index";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

function input(): WorkspaceHostBuildManifestInput {
  return {
    contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
    distributionProfile: "vm-release",
    source: { repository: "Papercusp/papercusp", revision: "1".repeat(40) },
    releaseArtifact: {
      name: "papercusp-server_1.2.3_amd64.deb",
      version: "1.2.3",
      sha256: SHA_A,
      sizeBytes: 42,
    },
    baseImage: {
      reference: "ubuntu-24.04-amd64",
      architecture: "x86_64",
      sha256: SHA_B,
    },
    builder: {
      strategy: "shared",
      kind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
      version: "1.11.2",
      templatePath: "images/workspace-host.pkr.hcl",
      templateSha256: SHA_C,
    },
    materials: [
      { path: "systemd/papercusp-server.service", sha256: SHA_D, sizeBytes: 9 },
      {
        path: "artifacts/papercusp-server.deb",
        sha256: SHA_A,
        sizeBytes: 42,
        executable: false,
      },
    ],
    parameters: [
      { name: "release_channel", value: "stable" },
      { name: "root_volume_gib", value: 40 },
    ],
    targets: [
      { provider: "gcp", locations: ["us-central1", "us-east1"] },
      { provider: "aws", locations: ["us-east-1"] },
      { provider: "azure", locations: ["eastus"] },
    ],
  };
}

describe("workspace-host build manifest", () => {
  it("normalizes unordered inputs into one deterministic manifest identity", () => {
    const first = buildWorkspaceHostBuildManifest(input());
    const reordered = input();
    const second = buildWorkspaceHostBuildManifest({
      ...reordered,
      materials: [...reordered.materials].reverse(),
      parameters: [...reordered.parameters].reverse(),
      targets: [...reordered.targets].reverse().map((target) => ({
        ...target,
        locations: [...target.locations].reverse(),
      })),
    });

    expect(second).toEqual(first);
    expect(first.targets.map((target) => target.provider)).toEqual([
      "aws",
      "azure",
      "gcp",
    ]);
    expect(first.materials.map((material) => material.path)).toEqual([
      "artifacts/papercusp-server.deb",
      "systemd/papercusp-server.service",
    ]);
    expect(first.manifestIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(canonicalWorkspaceHostBuildManifestPayload(first)).not.toContain(
      "manifestIdentity",
    );
    expect(verifyWorkspaceHostBuildManifest(first)).toMatchObject({
      ok: true,
      expectedIdentity: first.manifestIdentity,
    });
  });

  it("changes identity when any reproducible build input changes and detects tampering", () => {
    const manifest = buildWorkspaceHostBuildManifest(input());
    const changed = buildWorkspaceHostBuildManifest({
      ...input(),
      releaseArtifact: { ...input().releaseArtifact, sizeBytes: 43 },
    });
    expect(changed.manifestIdentity).not.toBe(manifest.manifestIdentity);

    const tampered = {
      ...manifest,
      baseImage: { ...manifest.baseImage, sha256: SHA_D },
    };
    const verdict = verifyWorkspaceHostBuildManifest(tampered);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]).toContain("does not match canonical payload");
  });

  it.each([
    [
      "path traversal",
      () => ({
        ...input(),
        materials: [{ path: "../secret", sha256: SHA_A, sizeBytes: 1 }],
      }),
    ],
    [
      "duplicate material",
      () => ({
        ...input(),
        materials: [input().materials[0]!, input().materials[0]!],
      }),
    ],
    [
      "secret parameter",
      () => ({
        ...input(),
        parameters: [{ name: "cloud_token", value: "do-not-record" }],
      }),
    ],
    [
      "mutable revision",
      () => ({ ...input(), source: { ...input().source, revision: "main" } }),
    ],
    [
      "invalid digest",
      () => ({
        ...input(),
        baseImage: { ...input().baseImage, sha256: "latest" },
      }),
    ],
  ])("refuses %s", (_name, makeInvalid) => {
    expect(() =>
      buildWorkspaceHostBuildManifest(
        makeInvalid() as WorkspaceHostBuildManifestInput,
      ),
    ).toThrow(WorkspaceHostBuildManifestError);
  });

  it("requires the shared Packer selection and unique provider targets", () => {
    expect(() =>
      buildWorkspaceHostBuildManifest({
        ...input(),
        builder: {
          ...input().builder,
          kind: "gcp-image-builder" as typeof WORKSPACE_HOST_SHARED_BUILDER_KIND,
        },
      }),
    ).toThrow("builder must select shared 'hashicorp-packer'");

    expect(() =>
      buildWorkspaceHostBuildManifest({
        ...input(),
        targets: [input().targets[0]!, input().targets[0]!],
      }),
    ).toThrow("targets contains duplicate 'gcp'");
  });
});
