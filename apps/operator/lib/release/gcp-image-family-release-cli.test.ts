import { describe, expect, it, vi } from "vitest";

import {
  executionOptions,
  parseGcpImageFamilyReleaseCliArgs,
  parseGcpImageFamilyReleaseCliInput,
  runGcpImageFamilyReleaseCli,
} from "./gcp-image-family-release-cli";

const request = { projectId: "active-alcove-504205-q3" } as never;
const candidateImageId =
  "projects/active-alcove-504205-q3/global/images/papercusp-workspace-host-0-0-19-candidate";
const connection = {
  target: "gcp",
  cloudCredentialRef: { kind: "cloud", ref: "gcloud://active-user" },
  scope: { kind: "project", id: "active-alcove-504205-q3" },
} as never;

describe("gcp image-family release CLI", () => {
  it("requires a request file and parses optional file arguments", () => {
    expect(() => parseGcpImageFamilyReleaseCliArgs([])).toThrow(
      /--request-file/,
    );
    expect(
      parseGcpImageFamilyReleaseCliArgs([
        "--request-file",
        "/tmp/release.json",
        "--repo-root",
        "/repo",
        "--guest-tool-versions-file",
        "/tmp/tools.json",
        "--json",
      ]),
    ).toEqual({
      requestFile: "/tmp/release.json",
      repositoryRoot: "/repo",
      guestToolVersionsFile: "/tmp/tools.json",
      json: true,
    });
  });

  it("rejects unknown flags and malformed input envelopes", () => {
    expect(() =>
      parseGcpImageFamilyReleaseCliArgs(["--request-file", "/tmp/r", "--typo"]),
    ).toThrow(/unknown argument/);
    expect(() => parseGcpImageFamilyReleaseCliInput({ request })).toThrow(
      /request and connection/,
    );
    expect(parseGcpImageFamilyReleaseCliInput({ request, connection })).toEqual(
      { request, connection },
    );
  });

  it("routes parsed input through the production composition call path", async () => {
    const execute = vi.fn(
      async (receivedRequest, receivedConnection, options) => ({
        contractVersion: "papercusp-gcp-image-family-release-v1",
        receivedRequest,
        receivedConnection,
        options,
      }),
    ) as never;
    const result = await runGcpImageFamilyReleaseCli(
      { request, connection },
      { repositoryRoot: "/repo" },
      {},
      { execute },
    );
    expect(execute).toHaveBeenCalledWith(
      request,
      connection,
      { repositoryRoot: "/repo" },
      {},
    );
    expect(result).toMatchObject({
      receivedRequest: request,
      receivedConnection: connection,
    });
  });

  // WI-1613086: the resume flags exist so the executor's resume path is reachable from a real
  // release. Composition options and execution options travel as separate arguments, so a
  // regression that folds one into the other fails here rather than silently rebuilding.
  it("parses the resume flags and forwards them as execution options", async () => {
    const args = parseGcpImageFamilyReleaseCliArgs([
      "--request-file",
      "/tmp/release.json",
      "--candidate-image-id",
      candidateImageId,
      "--resume-phase",
      "scan",
    ]);
    expect(args).toMatchObject({
      candidateImageId,
      resumePhase: "scan",
    });
    expect(executionOptions(args)).toEqual({
      candidateImageId,
      resumePhase: "scan",
    });

    const execute = vi.fn(async () => ({
      contractVersion: "papercusp-gcp-image-family-release-v1",
    })) as never;
    await runGcpImageFamilyReleaseCli(
      { request, connection },
      { repositoryRoot: "/repo" },
      executionOptions(args),
      { execute },
    );
    expect(execute).toHaveBeenCalledWith(
      request,
      connection,
      { repositoryRoot: "/repo" },
      { candidateImageId, resumePhase: "scan" },
    );
  });

  it("rejects an unsupported resume phase and omits absent resume flags", () => {
    expect(() =>
      parseGcpImageFamilyReleaseCliArgs([
        "--request-file",
        "/tmp/release.json",
        "--resume-phase",
        "teardown",
      ]),
    ).toThrow(/--resume-phase must be one of scan, publish/);

    // The pairing rule stays with the executor: the parser accepts a lone flag and lets the
    // library refuse it, so there is exactly one authority on what a valid resume looks like.
    const lonePhase = parseGcpImageFamilyReleaseCliArgs([
      "--request-file",
      "/tmp/release.json",
      "--resume-phase",
      "publish",
    ]);
    expect(executionOptions(lonePhase)).toEqual({ resumePhase: "publish" });
    expect(
      executionOptions(
        parseGcpImageFamilyReleaseCliArgs([
          "--request-file",
          "/tmp/release.json",
        ]),
      ),
    ).toEqual({});
  });
});
