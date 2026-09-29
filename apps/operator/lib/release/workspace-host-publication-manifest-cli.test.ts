import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { workspaceHostRequiredReleaseMaterialFixtures } from "@papercusp/deployment-driver";
import { afterAll, describe, expect, it } from "vitest";

import {
  resolveMaterials,
  WORKSPACE_HOST_PUBLICATION_TRUST_POLICY,
  assembleWorkspaceHostPublicationManifest,
  assertBundledNodeMeetsMinimum,
  parsePublicationManifestCliArgs,
  parsePublicationManifestCliInput,
  parseBundledNodeVersion,
  parseSbomFacts,
  parseSecretScanFindings,
  parseVulnerabilityFacts,
  secretScanTool,
  serializeProvenanceStatement,
  verifyProvenanceStatement,
  type BundledNodeProbeRunner,
  type PublicationManifestAssemblyInput,
  type PublicationManifestCliInput,
} from "./workspace-host-publication-manifest-cli";

const digest = (seed: string): string =>
  createHash("sha256").update(seed, "utf8").digest("hex");
const execFile = promisify(execFileCallback);

const scratchDirs: string[] = [];
afterAll(async () => {
  await Promise.all(
    scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const BUNDLE_SHA = digest("bundle");
const SIGNATURE_SHA = digest("signature");
const SBOM_SHA = digest("sbom");
const SIGNING_KEY =
  "untrusted comment: minisign public key: 5D3A7DD4A7089944\nRWREmQin1H06XfseQbDxZxnbUzVEFqNzYLmA5gnCdg+6cAKucqh02Be5\n";

/** The exact shape the release auditor writes for a clean bundle. */
const CLEAN_AUDIT_LOG = [
  "==> auditing server.tgz",
  "    identity of this build box: build-git-email, build-git-name",
  "    [A] paths    — 10,724 members, 0 finding(s)",
  "    [B] content  — 0 distinct value(s) matched",
  "    ✓ CLEAN — no forbidden paths, no build-box identity, no credentials",
].join("\n");

const MATERIALS = [
  // Derived from the release-gate contract rather than restated: a material added there must
  // reach this fixture on its own, or every assembly case below fails naming a path this file
  // never mentions.
  ...workspaceHostRequiredReleaseMaterialFixtures(),
  {
    path: "papercusp-desktop/bin/audit-release-bundle.py",
    sha256: digest("auditor"),
    sizeBytes: 196_083,
    executable: true,
  },
] as const;

function cliInput(): PublicationManifestCliInput {
  return {
    image: { id: "papercusp-workspace-host", version: "0.0.18" },
    source: {
      repository: "https://github.com/Papercusp/papercusp.git",
      revision: "daf63630615e9266fe9cee27d388ff44aa42366f",
    },
    baseImage: {
      reference:
        "projects/papercusp-images-123/global/images/ubuntu-2404-amd64",
      architecture: "x86_64",
      sha256: digest("base-image"),
    },
    builder: {
      strategy: "shared",
      kind: "papercusp-desktop-sidecar",
      version: "0.0.18",
      templatePath: "papercusp-desktop/bin/build-desktop-sidecar.sh",
    },
    minimumNodeMajor: 24,
    materials: [...MATERIALS],
    parameters: [
      { name: "distribution_profile", value: "vm-release" },
      { name: "target_arch", value: "x64" },
    ],
    targets: [{ provider: "gcp", locations: [] }],
    compatibility: [
      {
        provider: "gcp",
        architecture: "x86_64",
        ubuntuVersion: "24.04",
        bootstrapContractVersion: "papercusp-workspace-host-bootstrap-v2",
        actions: ["install", "upgrade", "rollback"],
        maximumArtifactAgeDays: 30,
      },
    ] as PublicationManifestCliInput["compatibility"],
  };
}

function assemblyFacts(
  overrides: Partial<PublicationManifestAssemblyInput> = {},
): PublicationManifestAssemblyInput {
  return {
    input: cliInput(),
    materials: [...MATERIALS],
    builderTemplateSha256: digest("template"),
    baseImageSha256: digest("base-image"),
    bundle: { sha256: BUNDLE_SHA, bytes: 2_003_038_223 },
    signature: { sha256: SIGNATURE_SHA, bytes: 295 },
    signingPublicKey: SIGNING_KEY,
    sbom: {
      documentSha256: SBOM_SHA,
      componentCount: 298,
      tool: { name: "syft", version: "1.51.0" },
    },
    vulnerabilities: {
      findings: [{ id: "CVE-2017-8806", severity: "medium" }],
      tool: { name: "grype", version: "0.117.0" },
    },
    secretScan: {
      findings: [],
      tool: {
        name: "papercusp-audit-release-bundle.py",
        version: `sha256:${digest("auditor")}`,
      },
    },
    provenanceTool: { name: "@papercusp/deployment-driver", version: "0.1.0" },
    now: Date.parse("2026-08-30T02:00:00.000Z"),
    ...overrides,
  };
}

describe("publication manifest CLI arguments", () => {
  it("requires the publication directory and the input file", () => {
    expect(() =>
      parsePublicationManifestCliArgs(["--input-file", "in.json"]),
    ).toThrow(/--publication-dir is required/u);
    expect(() =>
      parsePublicationManifestCliArgs(["--publication-dir", "dir"]),
    ).toThrow(/--input-file is required/u);
  });

  it("refuses an unknown flag rather than ignoring it", () => {
    expect(() =>
      parsePublicationManifestCliArgs([
        "--publication-dir",
        "dir",
        "--input-file",
        "in.json",
        "--skip-trust",
        "yes",
      ]),
    ).toThrow(/unknown flag '--skip-trust'/u);
  });

  it("refuses a flag whose value is another flag", () => {
    expect(() =>
      parsePublicationManifestCliArgs(["--publication-dir", "--input-file"]),
    ).toThrow(/requires a value/u);
  });
});

describe("publication manifest CLI input", () => {
  it("requires a supported bundled Node floor", () => {
    expect(() =>
      parsePublicationManifestCliInput({
        ...cliInput(),
        minimumNodeMajor: 25.5,
      }),
    ).toThrow(/input\.minimumNodeMajor must be a supported integer/u);
  });

  it("requires exactly one source for the base-image digest", () => {
    const both = { ...cliInput(), baseImage: { ...cliInput().baseImage, sha256Path: "/etc/os-release" } };
    expect(() => parsePublicationManifestCliInput(both)).toThrow(
      /exactly one of sha256 or sha256Path/u,
    );
    const neither = {
      ...cliInput(),
      baseImage: {
        reference: "ubuntu",
        architecture: "x86_64",
      },
    };
    expect(() => parsePublicationManifestCliInput(neither)).toThrow(
      /exactly one of sha256 or sha256Path/u,
    );
  });

  it("accepts materials without digests, leaving them for --source-root derivation", () => {
    const parsed = parsePublicationManifestCliInput({
      ...cliInput(),
      materials: [{ path: "bin/papercusp-remote-initializer", executable: true }],
    });
    expect(parsed.materials[0]?.sha256).toBeUndefined();
  });

  // WI-10003878 / D-437: the rollback edge release.shipment.green verifies must survive parsing.
  it("carries lifecycle.rollbackTarget through and refuses a malformed one", () => {
    const parsed = parsePublicationManifestCliInput({
      ...cliInput(),
      lifecycle: { rollbackTarget: { id: "papercusp-workspace-host", version: "0.0.17" } },
    });
    expect(parsed.lifecycle).toEqual({
      rollbackTarget: { id: "papercusp-workspace-host", version: "0.0.17" },
    });
    expect(() =>
      parsePublicationManifestCliInput({
        ...cliInput(),
        lifecycle: { rollbackTarget: { id: "papercusp-workspace-host" } },
      }),
    ).toThrow(/input\.lifecycle\.rollbackTarget\.version/);
    expect(() =>
      parsePublicationManifestCliInput({ ...cliInput(), lifecycle: "yesterday" }),
    ).toThrow(/input\.lifecycle must be an object/);
    // An empty lifecycle stays absent, as before.
    expect(
      parsePublicationManifestCliInput({ ...cliInput(), lifecycle: {} }).lifecycle,
    ).toBeUndefined();
  });
});

describe("bundled Node publication guard", () => {
  it("parses only complete semantic Node versions", () => {
    expect(parseBundledNodeVersion("v24.18.1\n")).toEqual({
      version: "v24.18.1",
      major: 24,
    });
    expect(() => parseBundledNodeVersion("v24oops")).toThrow(
      /not a supported semantic version/u,
    );
  });

  it("measures the runtime from the archive and rejects a floor it cannot meet", async () => {
    const root = await mkdtemp(join(tmpdir(), "bundled-node-"));
    scratchDirs.push(root);
    const treeRoot = join(root, "tree");
    await mkdir(join(treeRoot, "bin"), { recursive: true });
    await writeFile(
      join(treeRoot, "bin", "node"),
      '#!/bin/sh\nprintf "%s\\n" "v24.18.1"\n',
      { encoding: "utf8", mode: 0o755 },
    );
    const archive = join(root, "server.tgz");
    await execFile(
      "tar",
      ["--create", "--gzip", "--file", archive, "--directory", treeRoot, "."],
      { encoding: "utf8" },
    );

    let governedCalls = 0;
    const runGoverned: BundledNodeProbeRunner = async (operation) => {
      governedCalls += 1;
      return operation();
    };

    expect(await assertBundledNodeMeetsMinimum(archive, 24, { runGoverned })).toEqual({
      version: "v24.18.1",
      major: 24,
    });
    await expect(
      assertBundledNodeMeetsMinimum(archive, 25, { runGoverned }),
    ).rejects.toThrow(/minimumNodeMajor 25 exceeds the bundled runtime v24\.18\.1/u);
    expect(governedCalls).toBe(2);
  });

  it("does not overflow while probing a large archive index", async () => {
    const root = await mkdtemp(join(tmpdir(), "bundled-node-large-index-"));
    scratchDirs.push(root);
    const treeRoot = join(root, "tree");
    await mkdir(join(treeRoot, "bin"), { recursive: true });
    await writeFile(
      join(treeRoot, "bin", "node"),
      '#!/bin/sh\nprintf "%s\\n" "v24.18.1"\n',
      { encoding: "utf8", mode: 0o755 },
    );
    // Repeat one long, valid member name enough times to make a full tar index exceed the
    // former 1 MiB maxBuffer. The probe's narrowed tar pattern must avoid reading that index.
    const filler = "filler-" + "x".repeat(96);
    await writeFile(join(treeRoot, filler), "x", "utf8");
    const fileList = join(root, "files.list");
    await writeFile(
      fileList,
      ["bin/node", ...Array.from({ length: 20_000 }, () => filler)].join("\n") + "\n",
      "utf8",
    );
    const archive = join(root, "server.tgz");
    await execFile(
      "tar",
      [
        "--create",
        "--gzip",
        "--file",
        archive,
        "--directory",
        treeRoot,
        "--files-from",
        fileList,
      ],
      { encoding: "utf8" },
    );

    await expect(assertBundledNodeMeetsMinimum(archive, 24, { runGoverned: (operation) => operation() })).resolves.toEqual({
      version: "v24.18.1",
      major: 24,
    });
  });
});

describe("secret-scan reading is fail-closed", () => {
  it("reads a clean audit as zero findings", () => {
    expect(parseSecretScanFindings(CLEAN_AUDIT_LOG)).toEqual([]);
  });

  it("refuses a log it cannot parse instead of reporting zero findings", () => {
    expect(() => parseSecretScanFindings("==> auditing server.tgz\n")).toThrow(
      /refusing to treat an unreadable audit as zero findings/u,
    );
  });

  it("reports findings when the auditor found any", () => {
    const dirty = [
      "    [A] paths    — 10,724 members, 2 finding(s)",
      "    [B] content  — 1 distinct value(s) matched",
    ].join("\n");
    const findings = parseSecretScanFindings(dirty);
    expect(findings).toHaveLength(3);
    expect(findings.map((finding) => finding.ruleId)).toEqual([
      "forbidden-path",
      "forbidden-path",
      "sensitive-content",
    ]);
  });

  it("refuses a log whose counts and verdict disagree", () => {
    const contradictory = [
      "    [A] paths    — 10,724 members, 0 finding(s)",
      "    [B] content  — 0 distinct value(s) matched",
    ].join("\n");
    expect(() => parseSecretScanFindings(contradictory)).toThrow(
      /carries no CLEAN verdict/u,
    );
    const alsoContradictory = [
      "    [A] paths    — 10,724 members, 1 finding(s)",
      "    [B] content  — 0 distinct value(s) matched",
      "    ✓ CLEAN — no forbidden paths",
    ].join("\n");
    expect(() => parseSecretScanFindings(alsoContradictory)).toThrow(
      /findings and a CLEAN verdict at once/u,
    );
  });
});

describe("evidence readers", () => {
  it("reads component count and generator from a CycloneDX SBOM", () => {
    const facts = parseSbomFacts({
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      components: [{ name: "a" }, { name: "b" }],
      metadata: {
        tools: { components: [{ type: "application", name: "syft", version: "1.51.0" }] },
      },
    });
    expect(facts).toEqual({
      componentCount: 2,
      tool: { name: "syft", version: "1.51.0" },
    });
  });

  it("refuses an SBOM in another format", () => {
    expect(() => parseSbomFacts({ bomFormat: "SPDX", components: [] })).toThrow(
      /bomFormat must be 'CycloneDX'/u,
    );
  });

  it("normalizes grype severities and maps negligible up to low", () => {
    const facts = parseVulnerabilityFacts({
      descriptor: { name: "grype", version: "0.117.0" },
      matches: [
        { vulnerability: { id: "CVE-1", severity: "Medium" } },
        { vulnerability: { id: "CVE-2", severity: "Negligible" } },
        { vulnerability: { id: "GO-1", severity: "Unknown" } },
      ],
    });
    expect(facts.findings).toEqual([
      { id: "CVE-1", severity: "medium" },
      { id: "CVE-2", severity: "low" },
      { id: "GO-1", severity: "unknown" },
    ]);
  });

  it("refuses a severity band it cannot score", () => {
    expect(() =>
      parseVulnerabilityFacts({
        descriptor: { name: "grype", version: "0.117.0" },
        matches: [{ vulnerability: { id: "CVE-1", severity: "Moderate" } }],
      }),
    ).toThrow(/unrecognized severity 'moderate'/u);
  });

  it("measures a material at sourcePath while recording its bundle-relative path", async () => {
    const root = await mkdtemp(join(tmpdir(), "publication-manifest-"));
    scratchDirs.push(root);
    await writeFile(join(root, "extracted-initializer"), "initializer bytes", "utf8");

    const resolved = await resolveMaterials(
      [
        {
          path: "bin/papercusp-remote-initializer",
          sourcePath: "extracted-initializer",
          executable: true,
        },
      ],
      root,
    );

    expect(resolved[0]?.path).toBe("bin/papercusp-remote-initializer");
    expect(resolved[0]?.sha256).toBe(
      createHash("sha256").update("initializer bytes", "utf8").digest("hex"),
    );
    expect(resolved[0]?.sizeBytes).toBe(17);
  });

  it("refuses a relative material path when no source root can resolve it", async () => {
    await expect(
      resolveMaterials([{ path: "bin/papercusp-remote-initializer" }], undefined),
    ).rejects.toThrow(/--source-root is required/u);
  });

  it("requires the auditor among the materials before it will name it as the scan tool", () => {
    expect(() =>
      secretScanTool([
        {
          path: "bin/papercusp-remote-initializer",
          sha256: digest("initializer"),
          sizeBytes: 1,
          executable: true,
        },
      ]),
    ).toThrow(/audit-release-bundle\.py/u);
  });
});

describe("manifest assembly", () => {
  it("produces the closed envelope bound to the measured bytes", async () => {
    const { manifest } = await assembleWorkspaceHostPublicationManifest(
      assemblyFacts(),
    );

    expect(Object.keys(manifest).sort()).toEqual([
      "artifact",
      "files",
      "kind",
      "schemaVersion",
      "trustReport",
    ]);
    expect(manifest.files.bundle).toEqual({
      name: "server.tgz",
      sha256: BUNDLE_SHA,
      sizeBytes: 2_003_038_223,
    });
    expect(manifest.files.signature).toEqual({
      name: "server.tgz.minisig",
      sha256: SIGNATURE_SHA,
      sizeBytes: 295,
    });
    expect(manifest.artifact.release.bundleSha256).toBe(BUNDLE_SHA);
    expect(manifest.artifact.buildManifest.releaseArtifact.sha256).toBe(BUNDLE_SHA);
    expect(manifest.artifact.lifecycle.state).toBe("active");
    // First shipment: no rollback edge unless the cut supplied one (D-437).
    expect(manifest.artifact.lifecycle.rollbackTarget).toBeUndefined();
    expect(manifest.trustReport.trusted).toBe(true);
    expect(manifest.trustReport.policy).toEqual(
      WORKSPACE_HOST_PUBLICATION_TRUST_POLICY,
    );
  });

  // WI-10003878: every r54-r60 manifest lacked this field, so no shipment could commit.
  it("publishes the cut's rollback edge in artifact.lifecycle.rollbackTarget", async () => {
    const input = {
      ...cliInput(),
      lifecycle: { rollbackTarget: { id: "papercusp-workspace-host", version: "0.0.17" } },
    };
    const { manifest } = await assembleWorkspaceHostPublicationManifest(
      assemblyFacts({ input }),
    );
    expect(manifest.artifact.lifecycle.rollbackTarget).toEqual({
      id: "papercusp-workspace-host",
      version: "0.0.17",
    });
    expect(manifest.trustReport.trusted).toBe(true);
  });

  it("content-addresses the published URLs at the measured digest", async () => {
    const { manifest } = await assembleWorkspaceHostPublicationManifest(
      assemblyFacts(),
    );
    expect(manifest.artifact.release.bundleUrl).toContain(`/sha256/${BUNDLE_SHA}/`);
    expect(manifest.artifact.release.signatureUrl).toBe(
      `${manifest.artifact.release.bundleUrl}.minisig`,
    );
  });

  it("recomputes the signing-key digest from the key's own bytes", async () => {
    const { manifest } = await assembleWorkspaceHostPublicationManifest(
      assemblyFacts(),
    );
    expect(manifest.artifact.release.signingKeySha256).toBe(
      createHash("sha256").update(SIGNING_KEY, "utf8").digest("hex"),
    );
  });

  it("records an attestation whose digest is the document it wrote", async () => {
    const assembly = await assembleWorkspaceHostPublicationManifest(assemblyFacts());
    const attestation = assembly.manifest.trustReport.evidence.find(
      (entry) => entry.kind === "provenance-attestation",
    );
    expect(attestation).toBeDefined();
    expect(assembly.provenanceSha256).toBe(
      createHash("sha256").update(assembly.provenanceDocument, "utf8").digest("hex"),
    );
    if (attestation?.kind === "provenance-attestation") {
      expect(attestation.attestationSha256).toBe(assembly.provenanceSha256);
      expect(attestation.valid).toBe(true);
    }
    expect(
      verifyProvenanceStatement(assembly.provenanceDocument, {
        bundleSha256: BUNDLE_SHA,
        manifestIdentity:
          assembly.manifest.artifact.buildManifest.manifestIdentity,
      }),
    ).toBe(true);
  });

  it("rejects an attestation that describes another bundle", () => {
    const foreign = serializeProvenanceStatement({
      predicateType: "https://slsa.dev/provenance/v1",
      subject: [{ name: "server.tgz", digest: { sha256: digest("other") } }],
      predicate: {
        buildDefinition: { externalParameters: { buildManifestIdentity: "sha256:x" } },
      },
    });
    expect(
      verifyProvenanceStatement(foreign, {
        bundleSha256: BUNDLE_SHA,
        manifestIdentity: "sha256:x",
      }),
    ).toBe(false);
  });

  it("refuses to build an envelope when the scan gates a finding", async () => {
    await expect(
      assembleWorkspaceHostPublicationManifest(
        assemblyFacts({
          vulnerabilities: {
            findings: [{ id: "CVE-9999-1", severity: "high" }],
            tool: { name: "grype", version: "0.117.0" },
          },
        }),
      ),
    ).rejects.toThrow(/untrusted-release|vulnerab/iu);
  });

  it("refuses to build an envelope when the auditor found a secret", async () => {
    await expect(
      assembleWorkspaceHostPublicationManifest(
        assemblyFacts({
          secretScan: {
            findings: [{ ruleId: "forbidden-path", location: "member 1" }],
            tool: {
              name: "papercusp-audit-release-bundle.py",
              version: `sha256:${digest("auditor")}`,
            },
          },
        }),
      ),
    ).rejects.toThrow(/secret/iu);
  });

  it("is deterministic: the same measurements produce the same manifest identity", async () => {
    const first = await assembleWorkspaceHostPublicationManifest(assemblyFacts());
    const second = await assembleWorkspaceHostPublicationManifest(assemblyFacts());
    expect(second.manifest.artifact.buildManifest.manifestIdentity).toBe(
      first.manifest.artifact.buildManifest.manifestIdentity,
    );
    expect(second.provenanceSha256).toBe(first.provenanceSha256);
  });
});
