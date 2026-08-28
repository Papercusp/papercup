import { describe, expect, it, vi } from "vitest";

import {
  parseGcpImageFamilyReleaseCliArgs,
  parseGcpImageFamilyReleaseCliInput,
  runGcpImageFamilyReleaseCli,
} from "./gcp-image-family-release-cli";

const request = { projectId: "active-alcove-504205-q3" } as never;
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
      { execute },
    );
    expect(execute).toHaveBeenCalledWith(request, connection, {
      repositoryRoot: "/repo",
    });
    expect(result).toMatchObject({
      receivedRequest: request,
      receivedConnection: connection,
    });
  });
});
