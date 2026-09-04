import { describe, expect, it } from "vitest";

import {
  WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTC_BUILDER_KIND,
  WORKSPACE_HOST_SIDECAR_BUILDER_KIND,
  WORKSPACE_HOST_SHARED_BUILDER_KIND,
  WorkspaceHostBuildManifestError,
  buildWorkspaceHostBuildManifest,
  canonicalWorkspaceHostBuildManifestPayload,
  verifyWorkspaceHostBuildManifest,
  verifyWorkspaceHostReleaseProvenance,
  WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT,
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT,
  WORKSPACE_HOST_PUI_COMPANION_PATH,
  WORKSPACE_HOST_PUI_ENTRYPOINT,
  WORKSPACE_HOST_PUI_INSTALL_MANIFEST_PATH,
  WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS,
  WORKSPACE_HOST_ARTIFACT_ORIGIN,
  WORKSPACE_HOST_ARTIFACT_PATH_PREFIX,
  deriveWorkspaceHostCanonicalArtifactUrls,
  type WorkspaceHostBuildManifestInput,
  type WorkspaceHostRequiredReleaseMaterial,
  type WorkspaceHostReleasePins,
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
      reference:
        "projects/papercusp-images-123/global/images/ubuntu-2404-amd64",
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
  it("re-exports the complete required release-material contract through the package index", () => {
    const required: readonly WorkspaceHostRequiredReleaseMaterial[] =
      WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS;
    expect(required.map(({ path }) => path)).toEqual([
      WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT,
      WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT,
      WORKSPACE_HOST_PUI_ENTRYPOINT,
      WORKSPACE_HOST_PUI_COMPANION_PATH,
      WORKSPACE_HOST_PUI_INSTALL_MANIFEST_PATH,
    ]);
  });

  /**
   * Every REQUIRED material must be nameable in a published manifest.
   *
   * A required path that trips the secret-material guard is unshippable — the bundle cannot be
   * built at all — and the failure surfaces far from the rename that caused it. The
   * credential-delivery entrypoint is deliberately named `deliver-material` for exactly this
   * reason, and renaming it to the obvious `bin/papercusp-credential-delivery` is what this test
   * exists to catch.
   */
  it("names no required release material that the secret-material guard would refuse", () => {
    for (const required of WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS) {
      expect(() =>
        buildWorkspaceHostBuildManifest({
          ...input(),
          materials: [
            ...input().materials,
            { path: required.path, sha256: SHA_B, sizeBytes: 64, executable: true },
          ],
        }),
      ).not.toThrow();
    }

    // Calibration: the guard really does refuse this class, so the passes above are a property of
    // the chosen names rather than of a guard that never fires.
    expect(() =>
      buildWorkspaceHostBuildManifest({
        ...input(),
        materials: [
          ...input().materials,
          { path: "bin/papercusp-credential-delivery", sha256: SHA_B, sizeBytes: 64 },
        ],
      }),
    ).toThrow(/secret key material/);
  });

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

  it.each([
    "ubuntu-24.04-amd64",
    "ubuntu-24.04.4-host-default-linux-x64:/etc/os-release",
    "projects/papercusp-images-123/global/images/family/ubuntu-base",
  ])("refuses a non-immutable GCP base-image reference: %s", (reference) => {
    expect(() =>
      buildWorkspaceHostBuildManifest({
        ...input(),
        baseImage: { ...input().baseImage, reference },
      }),
    ).toThrow(
      "baseImage.reference must be an immutable projects/{project}/global/images/{name} reference",
    );
  });

  it("preserves provider-neutral base-image references for non-GCP targets", () => {
    const manifest = buildWorkspaceHostBuildManifest({
      ...input(),
      baseImage: { ...input().baseImage, reference: "ubuntu-24.04-amd64" },
      targets: [{ provider: "aws", locations: ["us-east-1"] }],
    });

    expect(manifest.baseImage.reference).toBe("ubuntu-24.04-amd64");
  });

  it("accepts an OCI base for a bootc GCP target and rejects an unqualified one", () => {
    const bootc: WorkspaceHostBuildManifestInput = {
      ...input(),
      baseImage: {
        ...input().baseImage,
        reference: "quay.io/centos-bootc/centos-bootc:stream9",
      },
      builder: {
        ...input().builder,
        kind: WORKSPACE_HOST_BOOTC_BUILDER_KIND,
        templatePath: "infra/images/bootc/workspace-host.Containerfile",
      },
    };
    expect(buildWorkspaceHostBuildManifest(bootc).baseImage.reference).toBe(
      "quay.io/centos-bootc/centos-bootc:stream9",
    );
    expect(() =>
      buildWorkspaceHostBuildManifest({
        ...bootc,
        baseImage: { ...bootc.baseImage, reference: "centos-bootc:stream9" },
      }),
    ).toThrow("registry-qualified OCI image reference");
  });

  it("refuses a material path that is secret-shaped", () => {
    // Secret material must never be enumerated into a manifest that is published alongside the
    // artifact it describes. The parameter guard already covers values; this covers paths.
    expect(() =>
      buildWorkspaceHostBuildManifest({
        ...input(),
        materials: [
          {
            path: "secrets/signing_private_key.pem",
            sha256: SHA_A,
            sizeBytes: 1,
          },
        ],
      }),
    ).toThrow(WorkspaceHostBuildManifestError);
  });

  it("accepts the real sidecar producer for a Server bundle", () => {
    const manifest = buildWorkspaceHostBuildManifest({
      ...input(),
      builder: {
        strategy: "shared",
        kind: WORKSPACE_HOST_SIDECAR_BUILDER_KIND,
        version: "0.0.18",
        templatePath: "papercusp-desktop/bin/build-desktop-sidecar.sh",
        templateSha256: SHA_C,
      },
    });

    expect(manifest.builder).toEqual({
      strategy: "shared",
      kind: WORKSPACE_HOST_SIDECAR_BUILDER_KIND,
      version: "0.0.18",
      templatePath: "papercusp-desktop/bin/build-desktop-sidecar.sh",
      templateSha256: SHA_C,
    });
    expect(verifyWorkspaceHostBuildManifest(manifest).ok).toBe(true);
  });

  it("requires a canonical shared producer and unique provider targets", () => {
    expect(() =>
      buildWorkspaceHostBuildManifest({
        ...input(),
        builder: {
          ...input().builder,
          kind: "gcp-image-builder" as typeof WORKSPACE_HOST_SHARED_BUILDER_KIND,
        },
      }),
    ).toThrow("builder must select a shared canonical producer");

    expect(() =>
      buildWorkspaceHostBuildManifest({
        ...input(),
        targets: [input().targets[0]!, input().targets[0]!],
      }),
    ).toThrow("targets contains duplicate 'gcp'");
  });
});

describe("workspace-host release provenance", () => {
  const BASE = "https://releases.papercusp.example-host.net/server/1.2.3.tgz";

  /** A manifest whose materials carry the complete remote/PUI runtime generation. */
  function shippable(): WorkspaceHostBuildManifestInput {
    const base = input();
    return {
      ...base,
      materials: [
        ...base.materials,
        {
          path: WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT,
          sha256: SHA_C,
          sizeBytes: 512,
          executable: true,
        },
        {
          path: WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT,
          sha256: SHA_B,
          sizeBytes: 448,
          executable: true,
        },
        {
          path: WORKSPACE_HOST_PUI_ENTRYPOINT,
          sha256: SHA_D,
          sizeBytes: 1_024,
          executable: true,
        },
        {
          path: WORKSPACE_HOST_PUI_COMPANION_PATH,
          sha256: SHA_B,
          sizeBytes: 2_048,
        },
        {
          path: WORKSPACE_HOST_PUI_INSTALL_MANIFEST_PATH,
          sha256: SHA_A,
          sizeBytes: 256,
        },
      ],
    };
  }

  function pins(
    overrides: Partial<WorkspaceHostReleasePins> = {},
  ): WorkspaceHostReleasePins {
    return {
      version: "1.2.3",
      bundleUrl: BASE,
      bundleSha256: SHA_A,
      signatureUrl: `${BASE}.minisig`,
      ...overrides,
    };
  }

  // POSITIVE CONTROL. Without it, every refusal below could be passing because the fixture is
  // malformed for some unrelated reason rather than because the guard under test fired.
  it("accepts an immutable, digest-pinned release with every required runtime material", () => {
    const verdict = verifyWorkspaceHostReleaseProvenance(
      buildWorkspaceHostBuildManifest(shippable()),
      pins(),
    );
    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it("refuses a bundle digest that matches no built artifact", () => {
    const verdict = verifyWorkspaceHostReleaseProvenance(
      buildWorkspaceHostBuildManifest(shippable()),
      pins({ bundleSha256: SHA_D }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toContain(
      "does not match the built artifact",
    );
  });

  it("refuses a signature that is not the detached companion of the bundle", () => {
    // A valid signature over a DIFFERENT artifact must not satisfy the check.
    const verdict = verifyWorkspaceHostReleaseProvenance(
      buildWorkspaceHostBuildManifest(shippable()),
      pins({
        signatureUrl:
          "https://releases.papercusp.example-host.net/server/other-1.2.3.tgz.minisig",
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toContain(
      "must be release.bundleUrl suffixed with .minisig",
    );
  });

  it.each([
    ["latest", "https://releases.papercusp.example-host.net/server/latest.tgz"],
    ["stable", "https://releases.papercusp.example-host.net/stable/1.2.3.tgz"],
    ["main", "https://releases.papercusp.example-host.net/main/1.2.3.tgz"],
  ])("refuses the mutable release channel %s", (_name, bundleUrl) => {
    const verdict = verifyWorkspaceHostReleaseProvenance(
      buildWorkspaceHostBuildManifest(shippable()),
      pins({ bundleUrl, signatureUrl: `${bundleUrl}.minisig` }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toContain("mutable release channel");
  });

  it.each([
    ["reserved .invalid", "https://releases.papercusp.invalid/server/1.2.3.tgz"],
    ["reserved .test", "https://releases.papercusp.test/server/1.2.3.tgz"],
    ["localhost", "https://localhost/server/1.2.3.tgz"],
  ])("refuses fixture provenance: %s", (_name, bundleUrl) => {
    const verdict = verifyWorkspaceHostReleaseProvenance(
      buildWorkspaceHostBuildManifest(shippable()),
      pins({ bundleUrl, signatureUrl: `${bundleUrl}.minisig` }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toContain("reserved non-resolvable name");
  });

  it("refuses a bundle URL that is neither content-addressed nor version-embedded", () => {
    const bundleUrl =
      "https://releases.papercusp.example-host.net/server/server.tgz";
    const verdict = verifyWorkspaceHostReleaseProvenance(
      buildWorkspaceHostBuildManifest(shippable()),
      pins({ bundleUrl, signatureUrl: `${bundleUrl}.minisig` }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toContain("embed the release version");
  });

  // The canonical published path is content-addressed and carries NO version string. An earlier
  // revision of this guard required the version to appear in the URL, which would have rejected
  // the very URL the publication contract mandates — the tests passed only because the fixture
  // above happens to use a version-style path. This case pins the canonical form directly.
  it("accepts the canonical content-addressed URL, which carries no version", () => {
    const bundleUrl = `https://papercusp-cupboard.aviynw.workers.dev/artifacts/workspace-host/sha256/${SHA_A}/server.tgz`;
    const verdict = verifyWorkspaceHostReleaseProvenance(
      buildWorkspaceHostBuildManifest(shippable()),
      pins({ bundleUrl, signatureUrl: `${bundleUrl}.minisig` }),
    );
    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it("refuses a content-addressed URL that addresses a different artifact", () => {
    // Accepting the digest FORM without checking the digest VALUE would let a well-shaped URL
    // point at someone else's bundle while the pin still claimed to be immutable.
    const bundleUrl = `https://papercusp-cupboard.aviynw.workers.dev/artifacts/workspace-host/sha256/${SHA_D}/server.tgz`;
    const verdict = verifyWorkspaceHostReleaseProvenance(
      buildWorkspaceHostBuildManifest(shippable()),
      pins({ bundleUrl, signatureUrl: `${bundleUrl}.minisig` }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toContain(
      "is content-addressed at",
    );
  });

  it("does not accept a digest that merely appears in the query string", () => {
    // A 64-hex run anywhere in the URL is not an address. Only the /sha256/<digest>/ path form
    // actually determines which bytes the origin serves.
    const bundleUrl = `https://releases.papercusp.example-host.net/server/server.tgz?digest=${SHA_A}`;
    const verdict = verifyWorkspaceHostReleaseProvenance(
      buildWorkspaceHostBuildManifest(shippable()),
      pins({ bundleUrl, signatureUrl: `${bundleUrl}.minisig` }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toContain("embed the release version");
  });

  it.each(WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS)(
    "refuses a bundle whose materials omit $path",
    (required) => {
      const complete = shippable();
      const verdict = verifyWorkspaceHostReleaseProvenance(
        buildWorkspaceHostBuildManifest({
          ...complete,
          materials: complete.materials.filter(
            (material) => material.path !== required.path,
          ),
        }),
        pins(),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.errors.join("\n")).toContain(required.path);
    },
  );

  it.each(WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS)(
    "refuses an empty required release material at $path",
    (required) => {
      const complete = shippable();
      const verdict = verifyWorkspaceHostReleaseProvenance(
        buildWorkspaceHostBuildManifest({
          ...complete,
          materials: complete.materials.map((material) =>
            material.path === required.path
              ? { ...material, sizeBytes: 0 }
              : material,
          ),
        }),
        pins(),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.errors.join("\n")).toContain(`${required.path} must be non-empty`);
    },
  );

  it.each(
    WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS.filter(
      (required) => required.executable === true,
    ),
  )("refuses a non-executable required entrypoint at $path", (required) => {
    const complete = shippable();
    const verdict = verifyWorkspaceHostReleaseProvenance(
      buildWorkspaceHostBuildManifest({
        ...complete,
        materials: complete.materials.map((material) =>
          material.path === required.path
            ? { ...material, executable: false }
            : material,
        ),
      }),
      pins(),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toContain(
      `${required.path} must be marked executable`,
    );
  });

  // The point of deriving URLs from the digest is that the pin they produce must SATISFY the
  // provenance guard without any hand-authoring step in between. Asserting the string shape alone
  // would leave the two halves free to drift apart; this binds them.
  it("derives canonical URLs that satisfy the provenance guard end to end", () => {
    const derived = deriveWorkspaceHostCanonicalArtifactUrls(SHA_A);
    const verdict = verifyWorkspaceHostReleaseProvenance(
      buildWorkspaceHostBuildManifest(shippable()),
      pins({
        bundleUrl: derived.bundleUrl,
        signatureUrl: derived.signatureUrl,
        bundleSha256: SHA_A,
      }),
    );
    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it("reports every provenance failure at once rather than only the first", () => {
    const bundleUrl = "https://releases.papercusp.invalid/server/latest.tgz";
    const verdict = verifyWorkspaceHostReleaseProvenance(
      buildWorkspaceHostBuildManifest(input()),
      pins({
        bundleUrl,
        signatureUrl: `${bundleUrl}.minisig`,
        bundleSha256: SHA_D,
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.length).toBeGreaterThan(3);
  });
});

describe("canonical workspace-host artifact URLs", () => {
  const SHA = "a".repeat(64);

  it("derives the bundle, signature, and manifest paths from the digest", () => {
    expect(deriveWorkspaceHostCanonicalArtifactUrls(SHA)).toEqual({
      bundleUrl: `${WORKSPACE_HOST_ARTIFACT_ORIGIN}${WORKSPACE_HOST_ARTIFACT_PATH_PREFIX}/sha256/${SHA}/server.tgz`,
      signatureUrl: `${WORKSPACE_HOST_ARTIFACT_ORIGIN}${WORKSPACE_HOST_ARTIFACT_PATH_PREFIX}/sha256/${SHA}/server.tgz.minisig`,
      manifestUrl: `${WORKSPACE_HOST_ARTIFACT_ORIGIN}${WORKSPACE_HOST_ARTIFACT_PATH_PREFIX}/sha256/${SHA}/manifest.json`,
    });
  });

  it("normalizes an uppercase digest rather than producing a second address for the same bytes", () => {
    expect(deriveWorkspaceHostCanonicalArtifactUrls(SHA.toUpperCase())).toEqual(
      deriveWorkspaceHostCanonicalArtifactUrls(SHA),
    );
  });

  // The whole reason to derive rather than author: when the digest is missing or malformed there
  // must be NO plausible-looking URL to fall back to. A `latest`/fixture default is exactly the
  // failure this helper exists to make unreachable.
  it.each([
    ["empty", ""],
    ["not a digest", "latest"],
    ["truncated", "a".repeat(63)],
    ["non-hex", `${"a".repeat(63)}z`],
  ])("throws rather than defaulting when the digest is %s", (_name, digest) => {
    expect(() => deriveWorkspaceHostCanonicalArtifactUrls(digest)).toThrow();
  });

  it.each([
    ["plain HTTP", "http://papercusp-cupboard.aviynw.workers.dev"],
    ["a reserved name", "https://cupboard.invalid"],
    ["localhost", "https://localhost:8787"],
    ["not a URL", "papercusp-cupboard"],
  ])("refuses a %s origin", (_name, origin) => {
    expect(() =>
      deriveWorkspaceHostCanonicalArtifactUrls(SHA, { origin }),
    ).toThrow();
  });
});
