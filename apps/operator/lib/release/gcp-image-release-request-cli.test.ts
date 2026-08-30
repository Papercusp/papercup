import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { evaluateWorkspaceHostReleaseGate } from "@papercusp/operator-core/lib/workspace-host/workspace-host-release-gate";

import {
  buildImageArtifact,
  composeRequest,
  parseGcpImageReleaseRequestCliArgs,
} from "./gcp-image-release-request-cli";

/**
 * This CLI is the producer named by D-193. The image-family release ratifies an artifact that
 * describes a PACKER build over an immutable base image, which is a different object from the
 * publication manifest's sidecar-built bundle artifact — and before this file existed, nothing
 * assembled it, so `releaseGate.artifact` could only be hand-written.
 *
 * The load-bearing test here is `satisfies the real release gate`: the others check individual
 * refusals, but only running the actual gate proves the emitted document is admissible. The r8
 * cut passed every check its authors thought to run and still died at `packer init`
 * (EI-21750653220169836).
 */
const PROJECT = "active-alcove-504205-q3";
const BUNDLE_SHA = "a070057f2a892fbd9b7f353d58745d8a7ee591c838ae20417966401815cc7e07";
const KEY_SHA = "66bad893ed3a4140ea848787d1fd19d3673d5d1fdd92ae3434d67db5b6999bf8";
const BASE_SHA = "01af466feb100306498c86aa6bad1815e33036019aa34d4362c20f374ea5c829";
const BASE_IMAGE = "projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260826";
const PUBLISHED_AT = "2026-08-30T02:14:40.345Z";
const TEMPLATE_BODY = 'packer {\n  required_plugins {}\n}\n';
const CUPBOARD = "https://papercusp-cupboard.aviynw.workers.dev";
const SIGNING_PUBLIC_KEY =
  "untrusted comment: minisign public key: 5D3A7DD4A7089944\nRWREmQin1H06XfseQbDxZxnbUzVEFqNzYLmA5gnCdg+6cAKucqh02Be5\n";
/** The bundle cannot initialize a workspace without this entrypoint, so the gate requires it. */
const INITIALIZER_PATH = "bin/papercusp-remote-initializer";
const INITIALIZER_BODY = "#!/usr/bin/env node\n// fixture stand-in for the remote initializer\n";
const BOOTSTRAP_SCRIPT_SHA = "216345ddd771dd1d653c597ee5aaa285181374414a4e80551d1bc9a0d9b9f667";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function publicationManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "papercusp-workspace-host-release",
    artifact: {
      contractVersion: "papercusp-workspace-host-image-acceptance-v1",
      image: { id: "papercusp-workspace-host", version: "0.0.18" },
      buildManifest: {
        releaseArtifact: { name: "server.tgz", version: "0.0.18", sha256: BUNDLE_SHA, sizeBytes: 2003038223 },
      },
      release: {
        version: "0.0.18",
        bundleUrl: `${CUPBOARD}/artifacts/workspace-host/sha256/${BUNDLE_SHA}/server.tgz`,
        bundleSha256: BUNDLE_SHA,
        signatureUrl: `${CUPBOARD}/artifacts/workspace-host/sha256/${BUNDLE_SHA}/server.tgz.minisig`,
        // The gate recomputes this digest over the FULL key string, trailing newline included.
        signingKeySha256: KEY_SHA,
        signingPublicKey: SIGNING_PUBLIC_KEY,
      },
      compatibility: [
        {
          provider: "gcp",
          architecture: "x86_64",
          ubuntuVersion: "24.04",
          bootstrapContractVersion: "papercusp-workspace-host-bootstrap-v2",
          actions: ["install", "upgrade", "rollback"],
          maximumArtifactAgeDays: 30,
        },
      ],
    },
    trustReport: {
      version: "artifact-trust-v1",
      subject: { path: "server.tgz", name: "server.tgz", bytes: 2003038223, sha256: BUNDLE_SHA, signed: true },
      policy: { denyVulnerabilitiesAtOrAbove: "high", maxSecretFindings: 0, maxAttestationAgeMs: 86400000 },
      trusted: true,
      evidence: [],
      failures: [],
    },
    ...overrides,
  };
}

function inputDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: PROJECT,
    imageName: "papercusp-workspace-host-0-0-18",
    family: "papercusp-workspace-host",
    publishedAt: PUBLISHED_AT,
    source: { repository: "https://github.com/Papercusp/papercusp.git", revision: "daf63630615e9266fe9cee27d388ff44aa42366f" },
    baseImage: { reference: BASE_IMAGE, architecture: "x86_64", sha256: BASE_SHA },
    builder: { templatePath: "infra/images/workspace-host.pkr.hcl" },
    materials: [{ path: "template.pkr.hcl", executable: false }, { path: INITIALIZER_PATH, executable: true }],
    cleanRoom: { zone: "us-central1-a", serviceAccountEmail: "papercusp-vm@example.iam.gserviceaccount.com", subnetwork: "pc-p046-rel-subnet" },
    compatibilityRequest: {
      action: "install",
      provider: "gcp",
      architecture: "x86_64",
      ubuntuVersion: "24.04",
      observedAt: "2026-08-30T03:10:00.000Z",
    },
    placement: { projectId: PROJECT, zone: "us-central1-a", subnetwork: "pc-p046-rel-subnet", architecture: "x86_64" },
    spec: { action: "install", provider: "gcp", architecture: "x86_64", hostId: "probe", fixtureId: "probe" },
    ...overrides,
  };
}

function cleanRoomReport(imageId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cleanRoomReport: {
      contractVersion: "papercusp-workspace-host-image-acceptance-v1",
      fixtureId: "p046-r15-clean-room",
      image: { id: imageId, version: "0.0.18" },
      passed: true,
      checks: ["artifact-identity", "compatibility-matrix", "deterministic-bootstrap-fixture", "exact-bootstrap-attestation"],
      issues: [],
      ...overrides,
    },
  };
}

/** Lay out a repo root with the Packer template plus the input and publication documents. */
async function fixture(
  input: Record<string, unknown> = inputDocument(),
  publication: Record<string, unknown> = publicationManifest(),
  report?: Record<string, unknown>,
): Promise<{ root: string; args: ReturnType<typeof parseGcpImageReleaseRequestCliArgs> }> {
  const root = await mkdtemp(join(tmpdir(), "gcp-image-request-"));
  roots.push(root);
  await writeFile(join(root, "template.pkr.hcl"), TEMPLATE_BODY, "utf8");
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(publication), "utf8");
  const inputPath = join(root, "input.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      ...input,
      publicationManifest: manifestPath,
      builder: { ...(input.builder as Record<string, unknown>), templatePath: "template.pkr.hcl" },
    }),
    "utf8",
  );
  // --source-root is supplied by default so material digests are MEASURED rather than restated;
  // the "unmeasurable material" test deliberately drops it.
  const argv = ["--input-file", inputPath, "--repo-root", root, "--source-root", root];
  if (report) {
    const reportPath = join(root, "report.json");
    await writeFile(reportPath, JSON.stringify(report), "utf8");
    argv.push("--clean-room-report", reportPath, "--emit", "request");
  } else {
    argv.push("--emit", "artifact");
  }
  return { root, args: parseGcpImageReleaseRequestCliArgs(argv) };
}

describe("parseGcpImageReleaseRequestCliArgs", () => {
  it("requires an input file", () => {
    expect(() => parseGcpImageReleaseRequestCliArgs([])).toThrow(/--input-file is required/);
  });

  it("rejects unknown flags rather than ignoring them", () => {
    expect(() => parseGcpImageReleaseRequestCliArgs(["--input-file", "a.json", "--turbo"])).toThrow(/unknown flag --turbo/);
  });

  it("refuses to emit a request without a clean-room report", () => {
    expect(() => parseGcpImageReleaseRequestCliArgs(["--input-file", "a.json", "--emit", "request"])).toThrow(
      /requires --clean-room-report/,
    );
  });

  it("rejects an unsupported emit mode", () => {
    expect(() => parseGcpImageReleaseRequestCliArgs(["--input-file", "a.json", "--emit", "yaml"])).toThrow(/--emit must be one of/);
  });
});

describe("buildImageArtifact", () => {
  it("pins the packer builder kind and MEASURES the template digest", async () => {
    const { args } = await fixture();
    const { artifact } = await buildImageArtifact(args);
    const expected = "sha256";
    expect(artifact.buildManifest.builder.kind).toBe("hashicorp-packer");
    expect(artifact.buildManifest.builder.templatePath).toBe("template.pkr.hcl");
    // The digest is of the file on disk, not anything the input could have supplied.
    const { createHash } = await import("node:crypto");
    expect(artifact.buildManifest.builder.templateSha256).toBe(
      createHash(expected).update(TEMPLATE_BODY).digest("hex"),
    );
  });

  it("emits the immutable image id rather than the publication manifest's bare product name", async () => {
    const { args } = await fixture();
    const { artifact } = await buildImageArtifact(args);
    expect(artifact.image.id).toBe(`projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18`);
  });

  it("transcribes the bundle digest instead of letting the caller restate it", async () => {
    const { args } = await fixture();
    const { artifact } = await buildImageArtifact(args);
    expect(artifact.release.bundleSha256).toBe(BUNDLE_SHA);
    expect(artifact.buildManifest.releaseArtifact.sha256).toBe(BUNDLE_SHA);
  });

  it("refuses a publication manifest whose three bundle digests disagree", async () => {
    const broken = publicationManifest();
    const artifactBlock = broken.artifact as Record<string, unknown>;
    (artifactBlock.release as Record<string, unknown>).bundleSha256 = BASE_SHA;
    const { args } = await fixture(inputDocument(), broken);
    await expect(buildImageArtifact(args)).rejects.toThrow(/internally inconsistent/);
  });

  it("refuses an untrusted trust report", async () => {
    const untrusted = publicationManifest();
    (untrusted.trustReport as Record<string, unknown>).trusted = false;
    const { args } = await fixture(inputDocument(), untrusted);
    await expect(buildImageArtifact(args)).rejects.toThrow(/not trusted/);
  });

  it("refuses a base image that is a family alias rather than an immutable id", async () => {
    const { args } = await fixture(
      inputDocument({ baseImage: { reference: "ubuntu-2404-lts-amd64", architecture: "x86_64", sha256: BASE_SHA } }),
    );
    await expect(buildImageArtifact(args)).rejects.toThrow(/family aliases are forbidden/);
  });

  it("refuses a template path that escapes the repository root", async () => {
    const { args } = await fixture();
    const escaping = { ...args, inputFile: args.inputFile };
    const { readFile, writeFile: write } = await import("node:fs/promises");
    const doc = JSON.parse(await readFile(escaping.inputFile, "utf8")) as Record<string, unknown>;
    doc.builder = { templatePath: "../outside.pkr.hcl" };
    await write(escaping.inputFile, JSON.stringify(doc), "utf8");
    await expect(buildImageArtifact(escaping)).rejects.toThrow(/repository-relative POSIX path/);
  });

  it("measures material digests from --source-root when the input omits them", async () => {
    const { root, args } = await fixture(inputDocument({ materials: [{ path: "template.pkr.hcl" }] }));
    const { artifact } = await buildImageArtifact({ ...args, sourceRoot: root });
    const { createHash } = await import("node:crypto");
    expect(artifact.buildManifest.materials[0]).toMatchObject({
      path: "template.pkr.hcl",
      sha256: createHash("sha256").update(TEMPLATE_BODY).digest("hex"),
      sizeBytes: TEMPLATE_BODY.length,
    });
  });

  it("refuses an unmeasurable material rather than emitting a manifest without it", async () => {
    const { args } = await fixture(inputDocument({ materials: [{ path: "template.pkr.hcl" }] }));
    const { sourceRoot: _dropped, ...withoutSourceRoot } = args;
    await expect(buildImageArtifact(withoutSourceRoot)).rejects.toThrow(/no --source-root was given to measure it/);
  });

  it("refuses a manifest that names no build inputs at all", async () => {
    const { args } = await fixture(inputDocument({ materials: [] }));
    await expect(buildImageArtifact(args)).rejects.toThrow(/at least one build input/);
  });
});

describe("composeRequest", () => {
  it("refuses a clean-room report produced under a different artifact identity", async () => {
    // The exact D-193 trap: this report PASSED, but against the bundle artifact's bare image id.
    const { args } = await fixture(inputDocument(), publicationManifest(), cleanRoomReport("papercusp-workspace-host"));
    await expect(composeRequest(args)).rejects.toThrow(/Re-run the clean-room against/);
  });

  it("refuses a clean-room report that did not pass", async () => {
    const { args } = await fixture(
      inputDocument(),
      publicationManifest(),
      cleanRoomReport(`projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18`, { passed: false }),
    );
    await expect(composeRequest(args)).rejects.toThrow(/did not pass/);
  });

  it("binds the connection to the gcloud active-user credential, never a service-account key", async () => {
    const { args } = await fixture(
      inputDocument(),
      publicationManifest(),
      cleanRoomReport(`projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18`),
    );
    const composed = await composeRequest(args);
    expect(composed.connection).toMatchObject({
      target: "gcp",
      cloudCredentialRef: "gcloud://active-user",
      scope: { kind: "project", id: PROJECT },
    });
  });

  it("satisfies the real release gate", async () => {
    const { args } = await fixture(
      inputDocument(),
      publicationManifest(),
      cleanRoomReport(`projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18`),
    );
    const composed = (await composeRequest(args)) as {
      request: { releaseGate: Parameters<typeof evaluateWorkspaceHostReleaseGate>[0] };
    };
    const verdict = evaluateWorkspaceHostReleaseGate(composed.request.releaseGate);
    // Mapped to strings so a regression names the failing rule instead of printing `{ …(2) }`.
    expect(verdict.failures.map((failure) => `${failure.code}: ${failure.message}`)).toEqual([]);
    expect(verdict.accepted).toBe(true);
  });

  it("still fails the gate if the builder kind is downgraded — the guard is real, not incidental", async () => {
    const { args } = await fixture(
      inputDocument(),
      publicationManifest(),
      cleanRoomReport(`projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18`),
    );
    const composed = (await composeRequest(args)) as {
      request: { releaseGate: Parameters<typeof evaluateWorkspaceHostReleaseGate>[0] };
    };
    const mutated = {
      ...composed.request.releaseGate,
      artifact: {
        ...composed.request.releaseGate.artifact,
        buildManifest: {
          ...composed.request.releaseGate.artifact.buildManifest,
          builder: {
            ...composed.request.releaseGate.artifact.buildManifest.builder,
            kind: "papercusp-desktop-sidecar" as never,
            templatePath: "papercusp-desktop/bin/build-desktop-sidecar.sh",
          },
        },
      },
    };
    const verdict = evaluateWorkspaceHostReleaseGate(mutated);
    expect(verdict.accepted).toBe(false);
    expect(verdict.failures.some((failure) => failure.code === "unsupported-builder")).toBe(true);
  });
});
