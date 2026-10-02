import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTC_BASE_IMAGE,
  WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
  buildWorkspaceHostCleanRoomInstallFixture,
  deriveWorkspaceHostCanonicalArtifactUrls,
  workspaceHostCleanRoomFixtureAttestation,
  workspaceHostRequiredReleaseMaterialFixtures,
  type WorkspaceHostCleanRoomInstallSpec,
} from "@papercusp/deployment-driver";
import { WORKSPACE_HOST_BOOTC_BAKE_CONTRACT_VERSION } from "@papercusp/operator-core/lib/workspace-host/bootc-bake-manifest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGovernedOperation } from "@papercusp/operator-core/lib/resource-governor/execution";

vi.mock("@papercusp/operator-core/lib/resource-governor/execution", async (importOriginal) => ({
  ...await importOriginal<typeof import("@papercusp/operator-core/lib/resource-governor/execution")>(),
  runGovernedOperation: vi.fn(async (_input: unknown, operation: () => Promise<unknown>) => await operation()),
}));

import {
  BOOTC_TEMPLATE_PATH,
  actionableGrypeReport,
  buildBootcImageArtifact,
  buildBootcTrustReport,
  composeBootcAwsRequest,
  parseBootcImageReleaseRequestCliArgs,
  parseBootcSecretScan,
  parseCosignVerifiedDigests,
  parseVerifiedProvenance,
  rpmOwnedPaths,
  VENDOR_MIN_AVAILABLE_PACKAGES,
  vendorShipsNothingNewer,
} from "./bootc-image-release-request-cli";

// D-027 (WI-10005719). Shapes measured on the P-012 AWS bake: an INSTALLED rpm is located at the
// rpmdb and lists its files in metadata.files; a Go module inside an RPM-owned binary is a
// go-module located at that binary; stale base-layer copies sit in /sysroot/ostree objects.
const RPMDB = "/usr/share/rpm/rpmdb.sqlite";
const vendorSbomArtifacts = [
  { name: "skopeo", type: "rpm", version: "3:1.22.2-4.el9", locations: [{ path: RPMDB }], metadata: { files: [{ path: "/usr/bin/skopeo" }] } },
  // An .rpm ARCHIVE lying in the image: catalogued as type rpm, but not installed.
  { name: "smuggled", type: "rpm", version: "1.0-1.el9", locations: [{ path: "/opt/papercusp/cache/smuggled.rpm" }], metadata: { files: [{ path: "/usr/bin/smuggled" }] } },
];
const goAt = (path: string, id: string, severity = "High") => ({
  artifact: { name: "stdlib", type: "go-module", version: "go1.26.5", locations: [{ path }] },
  vulnerability: { id, severity, namespace: "govulndb:language:go", fix: { state: "fixed", versions: ["1.26.6"] } },
});
const installedRpmFinding = {
  artifact: { name: "openssl-libs", type: "rpm", version: "1:3.5.8-1.el9", locations: [{ path: RPMDB }] },
  vulnerability: { id: "RHSA-9001", severity: "High", namespace: "redhat:distro:redhat:9", fix: { state: "fixed" } },
};
const vendorUpdatesRecord = (overrides: Record<string, unknown> = {}) => ({
  digest: DIGEST_FOR_VENDOR,
  checkedAt: "2026-10-02T23:00:00Z",
  verdict: "no-updates",
  containerExit: 0,
  checkUpdateExit: 0,
  enabledRepos: 5,
  availablePackages: 65756,
  availablePackagesFloor: 1000,
  ...overrides,
});
const DIGEST_FOR_VENDOR = `sha256:${"9".repeat(64)}`;

const HEX = "9".repeat(64);
const DIGEST = `sha256:${HEX}`;
const REPO = "127.0.0.1:5096/papercusp/workspace-host";
const TAG = "papercusp-workspace-host-aws-test";
const BUNDLE = "a".repeat(64);
const VERSION = "0.0.21-p318r63";
const STARTED_ON = "2026-10-02T20:00:00Z";
const NOW = () => Date.parse("2026-10-02T21:00:00Z");
const SIGNING_PUBLIC_KEY = "untrusted comment: minisign public key: TEST\nRWQtest\n";

const cosignLog = (digest: string) =>
  `Verification for ${REPO}@${digest} --\nThe following checks were performed\n` +
  `${JSON.stringify([{ critical: { image: { "docker-manifest-digest": digest }, type: "cosign container image signature" }, optional: null }])}\n`;

const provenanceLine = (hex: string, startedOn = STARTED_ON) =>
  JSON.stringify({
    payloadType: "application/vnd.in-toto+json",
    payload: Buffer.from(
      JSON.stringify({
        _type: "https://in-toto.io/Statement/v0.1",
        predicateType: "https://slsa.dev/provenance/v1",
        subject: [{ name: REPO, digest: { sha256: hex } }],
        predicate: { runDetails: { metadata: { startedOn } } },
      }),
    ).toString("base64"),
    signatures: [],
  });

const cleanLog = (coverage = "12,345") =>
  `==> identity-scan of assembled tree\n    coverage: ${coverage} file(s) reachable by the scan\n    ✓ CLEAN — nothing found\n`;

const scanRecord = (overrides: Record<string, unknown> = {}) => ({
  digest: DIGEST,
  tool: { name: "papercusp-audit-release-bundle.py", version: `sha256:${"b".repeat(64)}` },
  exitCode: 0,
  ...overrides,
});

describe("bootc release request evidence readers", () => {
  it("reads the digest cosign verified, ignoring the prose around it", () => {
    expect(parseCosignVerifiedDigests(cosignLog(DIGEST))).toEqual([DIGEST]);
    expect(parseCosignVerifiedDigests("Error: no signatures found\n")).toEqual([]);
  });

  it("scopes grype to fixable findings and drops only EL9 generic-kernel NVD CPE matches (D-289)", () => {
    const narrowed = actionableGrypeReport({
      descriptor: { name: "grype", version: "0.99.0" },
      matches: [
        { artifact: { name: "openssl-libs", type: "rpm", version: "3.0.7-30.el9" }, vulnerability: { id: "CVE-1", severity: "Medium", namespace: "redhat:distro", fix: { state: "fixed" } } },
        { artifact: { name: "glibc", type: "rpm", version: "2.34-1.el9" }, vulnerability: { id: "CVE-2", severity: "High", namespace: "redhat:distro", fix: { state: "not-fixed" } } },
        { artifact: { name: "kernel-core", type: "rpm", version: "5.14.0-730.el9" }, vulnerability: { id: "CVE-3", severity: "High", namespace: "nvd:cpe", fix: { state: "fixed" } } },
        { artifact: { name: "kernel-core", type: "rpm", version: "5.14.0-730.el9" }, vulnerability: { id: "RHSA-4", severity: "High", namespace: "redhat:distro", fix: { state: "fixed" } } },
      ],
    });
    expect((narrowed.report.matches as { vulnerability: { id: string } }[]).map((match) => match.vulnerability.id)).toEqual(["CVE-1", "RHSA-4"]);
    expect(narrowed.excludedUnfixed).toBe(1);
    expect(narrowed.excludedGenericKernelCpe).toBe(1);
  });

  it("drops syft's linux-kernel artifact (vmlinuz, pkg:generic) on an EL9 kernel, keeps a non-EL9 one (WI-10005674)", () => {
    // The real shape on a bootc image: the kernel image is cataloged as type linux-kernel, matched
    // only by upstream NVD CPE, while the kernel RPMs stay matched in the vendor namespace.
    const linuxKernel = (version: string, id: string) => ({
      artifact: { name: "linux-kernel", type: "linux-kernel", version, purl: `pkg:generic/linux-kernel@${version}` },
      vulnerability: { id, severity: "High", namespace: "nvd:cpe", fix: { state: "fixed", versions: ["5.15.16"] } },
    });
    const narrowed = actionableGrypeReport({
      descriptor: { name: "grype", version: "0.117.0" },
      matches: [
        linuxKernel("5.14.0-730.el9.x86_64", "CVE-2022-0185"),
        linuxKernel("6.8.0-31-generic", "CVE-2024-1086"),
        { artifact: { name: "kernel-core", type: "rpm", version: "5.14.0-730.el9" }, vulnerability: { id: "RHSA-4", severity: "High", namespace: "redhat:distro", fix: { state: "fixed" } } },
      ],
    });
    expect((narrowed.report.matches as { vulnerability: { id: string } }[]).map((match) => match.vulnerability.id)).toEqual(["CVE-2024-1086", "RHSA-4"]);
    expect(narrowed.excludedGenericKernelCpe).toBe(1);
  });

  it("moves only vendor-owned fixed Critical/High findings out when the vendor ships nothing newer (D-027)", () => {
    const report = {
      descriptor: { name: "grype", version: "0.117.0" },
      matches: [
        goAt("/usr/bin/skopeo", "GO-1"),
        installedRpmFinding,
        goAt("/sysroot/ostree/repo/objects/9e/eca1cb.file", "GO-2"),
        goAt("/opt/papercusp/bin/connector", "GO-3"),
        goAt("/usr/bin/smuggled", "GO-4"),
        goAt("/usr/bin/skopeo", "GO-5", "Medium"),
      ],
    };
    const owned = rpmOwnedPaths({ artifacts: vendorSbomArtifacts });
    expect([...owned]).toEqual(["/usr/bin/skopeo"]);

    const narrowed = actionableGrypeReport(report, { ownedPaths: owned, vendorShipsNothingNewer: true });
    expect(narrowed.vendorPendingIds).toEqual(["GO-1", "RHSA-9001"]);
    expect(narrowed.excludedVendorPending).toBe(2);
    expect((narrowed.report.matches as { vulnerability: { id: string } }[]).map((m) => m.vulnerability.id)).toEqual(["GO-2", "GO-3", "GO-4", "GO-5"]);

    // Without proof that the vendor ships nothing newer, nothing is pending.
    const unproven = actionableGrypeReport(report, { ownedPaths: owned, vendorShipsNothingNewer: false });
    expect(unproven.excludedVendorPending).toBe(0);
    expect((unproven.report.matches as unknown[]).length).toBe(6);
    expect(actionableGrypeReport(report).excludedVendorPending).toBe(0);
  });

  it("accepts a vendor-updates record only when it proves nothing newer for this digest (D-027)", () => {
    expect(vendorShipsNothingNewer(vendorUpdatesRecord(), DIGEST_FOR_VENDOR)).toBe(true);
    for (const overrides of [
      { verdict: "updates-available", checkUpdateExit: 100 },
      { checkUpdateExit: 1 },
      { containerExit: 125 },
      { enabledRepos: 0 },
      { availablePackages: VENDOR_MIN_AVAILABLE_PACKAGES - 1 },
      // A bake run with a lowered floor does not lower the release gate's own.
      { availablePackages: 12, availablePackagesFloor: 10 },
      { checkUpdateExit: null },
    ]) {
      expect(vendorShipsNothingNewer(vendorUpdatesRecord(overrides), DIGEST_FOR_VENDOR), JSON.stringify(overrides)).toBe(false);
    }
    expect(() => vendorShipsNothingNewer(vendorUpdatesRecord({ digest: `sha256:${"1".repeat(64)}` }), DIGEST_FOR_VENDOR))
      .toThrow(/vendor-updates record is for/);
  });

  it("reads a clean secret scan only when record, log and coverage all agree", () => {
    expect(parseBootcSecretScan(scanRecord(), cleanLog(), DIGEST).findings).toEqual([]);
    expect(() => parseBootcSecretScan(scanRecord({ digest: `sha256:${"1".repeat(64)}` }), cleanLog(), DIGEST)).toThrow(/not sha256/);
    expect(() => parseBootcSecretScan(scanRecord(), cleanLog("12"), DIGEST)).toThrow(/measured almost nothing/);
    expect(() => parseBootcSecretScan(scanRecord(), "coverage: 9,000 file(s)\n", DIGEST)).toThrow(/contradictory or unscannable/);
    expect(() => parseBootcSecretScan(scanRecord({ exitCode: 2 }), cleanLog(), DIGEST)).toThrow(/contradictory or unscannable/);
    const dirty = parseBootcSecretScan(scanRecord({ exitCode: 1 }), "    coverage: 9,000 file(s)\n    ✗ ASSEMBLED BUNDLE CARRIES A CREDENTIAL\n", DIGEST);
    expect(dirty.findings).toHaveLength(1);
  });

  it("binds provenance to the in-toto subject and takes the newest statement", () => {
    const output = `${provenanceLine(HEX, "2026-10-01T00:00:00Z")}\n${provenanceLine(HEX)}\n${provenanceLine("1".repeat(64), "2026-10-03T00:00:00Z")}\n`;
    expect(parseVerifiedProvenance(output, DIGEST).issuedAt).toBe(STARTED_ON);
    expect(() => parseVerifiedProvenance(provenanceLine("1".repeat(64)), DIGEST)).toThrow(/no verified SLSA v1/);
  });

  it("requires a clean-room report before it will emit a request", () => {
    expect(() => parseBootcImageReleaseRequestCliArgs(["--input-file", "x.json"])).toThrow(/clean-room-report/);
    expect(parseBootcImageReleaseRequestCliArgs(["--input-file", "x.json", "--emit", "artifact"]).emit).toBe("artifact");
  });
});

describe("bootc release request assembly (end to end over a fixture bake)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(overrides: { sbomDigest?: string; containerfileDrift?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), "bootc-release-request-"));
    dirs.push(root);
    const repo = join(root, "repo");
    mkdirSync(join(repo, "infra/images/bootc"), { recursive: true });
    const containerfile = `FROM scratch\nARG PAPERCUSP_BASE_IMAGE=${WORKSPACE_HOST_BOOTC_BASE_IMAGE}\n`;
    writeFileSync(join(repo, BOOTC_TEMPLATE_PATH), containerfile);
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "fixture");
    const revision = git("rev-parse", "HEAD").stdout.trim();
    if (overrides.containerfileDrift) writeFileSync(join(repo, BOOTC_TEMPLATE_PATH), `${containerfile}# drift\n`);

    const out = join(root, "out");
    const sc = join(out, "supply-chain");
    mkdirSync(sc, { recursive: true });
    writeFileSync(join(out, "bake-manifest.json"), JSON.stringify({
      contractVersion: WORKSPACE_HOST_BOOTC_BAKE_CONTRACT_VERSION,
      image: REPO,
      tag: TAG,
      digest: DIGEST,
      pinnedRef: `${REPO}@${DIGEST}`,
      registryNamespace: "127.0.0.1:5096/papercusp",
      clouds: [{ cloud: "aws", type: "ami", artifact: join(out, "aws/disk.raw"), sha256: "2".repeat(64), sizeBytes: 1024 }],
    }));
    writeFileSync(join(sc, "supply-chain-summary.json"), JSON.stringify({ digest: DIGEST, verifiedFromRegistry: true }));
    writeFileSync(join(sc, "verify-sig.log"), cosignLog(DIGEST));
    writeFileSync(join(sc, "sbom.syft.json"), JSON.stringify({
      descriptor: { name: "syft", version: "1.30.0" },
      source: { type: "image", metadata: { manifestDigest: overrides.sbomDigest ?? DIGEST, imageSize: 2_000_000_000 } },
      artifacts: [{ name: "bash" }, { name: "glibc" }, { name: "openssl-libs" }],
    }));
    writeFileSync(join(sc, "vulns.json"), JSON.stringify({
      descriptor: { name: "grype", version: "0.99.0" },
      matches: [
        { artifact: { name: "openssl-libs", type: "rpm", version: "3.0.7-30.el9" }, vulnerability: { id: "CVE-1", severity: "Medium", namespace: "redhat:distro", fix: { state: "fixed" } } },
        { artifact: { name: "glibc", type: "rpm", version: "2.34-1.el9" }, vulnerability: { id: "CVE-2", severity: "High", namespace: "redhat:distro", fix: { state: "not-fixed" } } },
      ],
    }));
    writeFileSync(join(sc, "secret-scan.json"), JSON.stringify(scanRecord()));
    writeFileSync(join(sc, "secret-scan.log"), cleanLog());
    writeFileSync(join(sc, "verify-prov.json"), `${provenanceLine(HEX)}\n`);
    writeFileSync(join(sc, "provenance.json"), JSON.stringify({ buildDefinition: { internalParameters: { sourceCheckout: revision } } }));
    writeFileSync(join(root, "cosign.pub"), "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n");

    const urls = deriveWorkspaceHostCanonicalArtifactUrls(BUNDLE);
    writeFileSync(join(root, "publication.json"), JSON.stringify({
      artifact: {
        image: { id: "papercusp-workspace-host", version: VERSION },
        release: {
          version: VERSION,
          bundleUrl: urls.bundleUrl,
          bundleSha256: BUNDLE,
          signatureUrl: urls.signatureUrl,
          signingPublicKey: SIGNING_PUBLIC_KEY,
          signingKeySha256: createHash("sha256").update(SIGNING_PUBLIC_KEY, "utf8").digest("hex"),
        },
        buildManifest: {
          source: { repository: "https://github.com/Papercusp/papercusp.git", revision: "f".repeat(40) },
          releaseArtifact: { name: "server.tgz", version: VERSION, sha256: BUNDLE, sizeBytes: 42_000 },
          materials: [{ path: "dist/papercusp-server.tgz", sha256: BUNDLE, sizeBytes: 42_000 }, ...workspaceHostRequiredReleaseMaterialFixtures()],
        },
        compatibility: [{
          provider: "gcp",
          architecture: "x86_64",
          ubuntuVersion: "24.04",
          bootstrapContractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
          actions: ["install", "upgrade", "rollback"],
          maximumArtifactAgeDays: 30,
        }],
      },
      trustReport: { trusted: true },
    }));
    const publishedAt = "2026-10-02T20:30:00Z";
    writeFileSync(join(root, "input.json"), JSON.stringify({
      bakeManifest: "out/bake-manifest.json",
      cosignPublicKey: "cosign.pub",
      publicationManifest: "publication.json",
      baseImage: { architecture: "x86_64", sha256: "d".repeat(64) },
      builder: { version: "latest" },
      publishedAt,
      aws: {
        publisherAccountId: "413781344298",
        sourceRegion: "us-east-1",
        targets: [{ region: "us-east-1", kmsKeyArn: "arn:aws:kms:us-east-1:413781344298:key/test", shareWithAccountIds: ["497149484242"] }],
        cleanAccount: { accountId: "497149484242", region: "us-east-1", subnetId: "subnet-test", instanceProfileArn: "arn:aws:iam::497149484242:instance-profile/test" },
        deprecatePreviousAt: "2026-11-01T00:00:00Z",
      },
      connection: { target: "aws" },
    }));
    return { root, repo, inputFile: join(root, "input.json"), publishedAt };
  }

  it("builds a trusted report bound to the bake digest, with unfixed findings scoped out", async () => {
    const f = fixture();
    const built = await buildBootcTrustReport({ inputFile: f.inputFile, repoRoot: f.repo, emit: "trust-report" }, NOW);
    expect(built.trustReport.failures).toEqual([]);
    expect(built.trustReport.trusted).toBe(true);
    expect(built.trustReport.subject.sha256).toBe(HEX);
    expect(built.excluded.unfixed).toBe(1);
  });

  describe("vendor-pending findings (D-027, WI-10005719)", () => {
    function vendorFixture(opts: { vendorUpdates?: unknown; summaryVendorPending?: string } = {}) {
      const f = fixture();
      const sc = join(f.root, "out", "supply-chain");
      writeFileSync(join(sc, "sbom.syft.json"), JSON.stringify({
        descriptor: { name: "syft", version: "1.30.0" },
        source: { type: "image", metadata: { manifestDigest: DIGEST, imageSize: 2_000_000_000 } },
        artifacts: [...vendorSbomArtifacts, { name: "bash" }],
      }));
      writeFileSync(join(sc, "vulns.json"), JSON.stringify({
        descriptor: { name: "grype", version: "0.117.0" },
        matches: [goAt("/usr/bin/skopeo", "GO-1")],
      }));
      if (opts.vendorUpdates !== undefined) writeFileSync(join(sc, "vendor-updates.json"), JSON.stringify(opts.vendorUpdates));
      if (opts.summaryVendorPending !== undefined) {
        writeFileSync(join(sc, "supply-chain-summary.json"), JSON.stringify({ digest: DIGEST, verifiedFromRegistry: true, vendorPending: opts.summaryVendorPending }));
      }
      return f;
    }
    const build = (f: ReturnType<typeof vendorFixture>) =>
      buildBootcTrustReport({ inputFile: f.inputFile, repoRoot: f.repo, emit: "trust-report" }, NOW);

    it("trusts an image whose only fixed High finding is vendor-pending, and reports it", async () => {
      const built = await build(vendorFixture({ vendorUpdates: vendorUpdatesRecord({ digest: DIGEST }), summaryVendorPending: "1" }));
      expect(built.trustReport.failures).toEqual([]);
      expect(built.trustReport.trusted).toBe(true);
      expect(built.excluded.vendorPending).toBe(1);
      expect(built.vendorPendingIds).toEqual(["GO-1"]);
    });

    it("denies the same finding when the bake recorded no vendor check", async () => {
      const built = await build(vendorFixture());
      expect(built.trustReport.trusted).toBe(false);
      expect(built.excluded.vendorPending).toBe(0);
    });

    it("denies it when the vendor already ships a newer RPM", async () => {
      const built = await build(vendorFixture({ vendorUpdates: vendorUpdatesRecord({ digest: DIGEST, verdict: "updates-available", checkUpdateExit: 100 }) }));
      expect(built.trustReport.trusted).toBe(false);
    });

    it("refuses a vendor record for another image, and a shell/TS count disagreement", async () => {
      await expect(build(vendorFixture({ vendorUpdates: vendorUpdatesRecord({ digest: `sha256:${"1".repeat(64)}` }) })))
        .rejects.toThrow(/vendor-updates record is for/);
      await expect(build(vendorFixture({ vendorUpdates: vendorUpdatesRecord({ digest: DIGEST }), summaryVendorPending: "0" })))
        .rejects.toThrow(/D-027 copies disagree/);
    });
  });

  it("refuses an SBOM that describes a different image", async () => {
    const f = fixture({ sbomDigest: `sha256:${"1".repeat(64)}` });
    await expect(buildBootcTrustReport({ inputFile: f.inputFile, repoRoot: f.repo, emit: "trust-report" }, NOW)).rejects.toThrow(/syft SBOM describes/);
  });

  it("refuses when the Containerfile moved since the bake's recorded revision", async () => {
    const f = fixture({ containerfileDrift: true });
    await expect(buildBootcImageArtifact({ inputFile: f.inputFile, repoRoot: f.repo, emit: "artifact" }, NOW)).rejects.toThrow(/differs from its blob/);
  });

  it("refuses source verification when process admission is refused", async () => {
    const f = fixture();
    vi.mocked(runGovernedOperation).mockRejectedValueOnce(new Error("fixture admission refused"));
    await expect(buildBootcImageArtifact({ inputFile: f.inputFile, repoRoot: f.repo, emit: "artifact" }, NOW))
      .rejects.toThrow("fixture admission refused");
    expect(runGovernedOperation).toHaveBeenLastCalledWith(expect.objectContaining({
      namespace: "bootc-release-source-verification", admissionClass: "process", dedicatedClient: true,
      demand: { fileDescriptors: 3 }, leaseTtlMs: 35000,
    }), expect.any(Function));
  });

  it("composes an AWS request the release gate accepts, and refuses a report for another image", async () => {
    const f = fixture();
    const { artifact } = await buildBootcImageArtifact({ inputFile: f.inputFile, repoRoot: f.repo, emit: "artifact" }, NOW);
    expect(artifact.release.bundleSha256).toBe(BUNDLE);
    expect(artifact.image.version).toBe(VERSION);
    const spec: WorkspaceHostCleanRoomInstallSpec = {
      fixtureId: "aws-bootc-clean-room",
      action: "install",
      provider: "aws",
      architecture: "x86_64",
      hostModel: "bootc-image",
      bootcBaseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
      observedAt: f.publishedAt,
      hostId: "clean-host-1",
      migrationId: "schema-1272",
      minimumNodeMajor: 22,
      service: { name: "papercusp-workspace", port: 3070 },
    };
    const cleanFixture = buildWorkspaceHostCleanRoomInstallFixture(artifact, spec);
    const report = {
      contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
      fixtureId: spec.fixtureId,
      image: artifact.image,
      passed: true,
      checks: ["artifact-identity", "compatibility-matrix", "deterministic-bootstrap-fixture", "exact-bootstrap-attestation"],
      issues: [],
      bootstrapScriptSha256: cleanFixture.bootstrapScriptSha256,
      attestation: workspaceHostCleanRoomFixtureAttestation(cleanFixture, spec.observedAt),
    };
    const reportFile = join(f.root, "clean-room.json");
    writeFileSync(reportFile, JSON.stringify({ cleanRoomReport: report }));
    const composed = await composeBootcAwsRequest({ inputFile: f.inputFile, repoRoot: f.repo, emit: "request", cleanRoomReportFile: reportFile }, NOW);
    expect(composed.request.releaseGate.bootcBakeManifest?.digest).toBe(DIGEST);
    expect(composed.request.cleanAccount.accountId).toBe("497149484242");

    writeFileSync(reportFile, JSON.stringify({ cleanRoomReport: { ...report, image: { ...report.image, version: "other" } } }));
    await expect(
      composeBootcAwsRequest({ inputFile: f.inputFile, repoRoot: f.repo, emit: "request", cleanRoomReportFile: reportFile }, NOW),
    ).rejects.toThrow(/clean-room report is for/);
  });
});
