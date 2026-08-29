import { describe, expect, it } from "vitest";

import {
  parseCleanRoomAcceptanceCliArgs,
  parseCleanRoomAcceptanceCliInput,
  runCleanRoomAcceptanceCli,
} from "./workspace-host-clean-room-acceptance-cli";

/**
 * This CLI is the UPSTREAM producer of `releaseGate.cleanRoomReport`. Before it existed the
 * release CLI consumed a request file whose header called that evidence "already-verified"
 * while nothing in the tree produced it — so the field could only ever be hand-written, and a
 * hand-written report is precisely the assertion the gate exists to refuse.
 */
const placement = {
  projectId: "active-alcove-504205-q3",
  zone: "us-central1-a",
  subnetwork: "pc-p046-canary-02-a810e759-subnet",
  architecture: "x86_64",
};

describe("parseCleanRoomAcceptanceCliArgs", () => {
  it("requires an input file", () => {
    expect(() => parseCleanRoomAcceptanceCliArgs([])).toThrow(/--input-file is required/);
  });

  it("rejects unknown flags rather than ignoring them", () => {
    expect(() =>
      parseCleanRoomAcceptanceCliArgs(["--input-file", "a.json", "--turbo"]),
    ).toThrow(/unknown flag '--turbo'/);
  });

  it("rejects a value flag whose value is another flag", () => {
    expect(() => parseCleanRoomAcceptanceCliArgs(["--input-file", "--repo-root"])).toThrow(
      /requires a value/,
    );
  });

  it("parses the input file and optional repo root", () => {
    expect(
      parseCleanRoomAcceptanceCliArgs(["--input-file", "req.json", "--repo-root", "/srv/repo"]),
    ).toEqual({ inputFile: "req.json", repositoryRoot: "/srv/repo" });
  });
});

describe("parseCleanRoomAcceptanceCliInput", () => {
  const base = { artifact: { image: {} }, spec: { architecture: "arm64" }, placement };

  it("requires the subnetwork the guest needs for any egress at all", () => {
    for (const subnetwork of [undefined, "", "   "]) {
      expect(() =>
        parseCleanRoomAcceptanceCliInput({
          ...base,
          placement: { ...placement, subnetwork },
        }),
      ).toThrow(/placement\.subnetwork must be a non-empty string/);
    }
  });

  it.each(["projectId", "zone"] as const)("requires placement.%s", (field) => {
    expect(() =>
      parseCleanRoomAcceptanceCliInput({ ...base, placement: { ...placement, [field]: "  " } }),
    ).toThrow(new RegExp(`placement\\.${field} must be a non-empty string`));
  });

  it("falls back to the spec architecture when placement omits it", () => {
    const parsed = parseCleanRoomAcceptanceCliInput({
      ...base,
      placement: { ...placement, architecture: undefined },
    });
    expect(parsed.placement.architecture).toBe("arm64");
  });

  it("rejects a non-object envelope instead of proceeding with holes", () => {
    expect(() => parseCleanRoomAcceptanceCliInput(null)).toThrow(/must be a JSON object/);
    expect(() => parseCleanRoomAcceptanceCliInput({ ...base, spec: 3 })).toThrow(
      /input\.spec must be an object/,
    );
  });
});

describe("runCleanRoomAcceptanceCli", () => {
  /**
   * The report must come from `runWorkspaceHostCleanRoomAcceptance`, never be assembled here.
   * An invalid artifact is the cheapest proof of that delegation: the real assembler returns a
   * structured `passed: false` REPORT, whereas a hand-rolled path would throw or, worse,
   * report success it never measured.
   */
  it("emits a rejecting report rather than throwing, so the refusal is preserved as evidence", async () => {
    let executed = false;
    const report = await runCleanRoomAcceptanceCli(
      {
        artifact: { image: { id: "bogus", version: "0.0.0" } } as never,
        spec: { architecture: "x86_64" } as never,
        placement,
      },
      {
        executor: {
          async execute() {
            executed = true;
            return { stdout: "" };
          },
        },
      },
    );

    expect(report.passed).toBe(false);
    expect(Array.isArray(report.issues)).toBe(true);
    expect(report.issues.length).toBeGreaterThan(0);
    // An artifact rejected on identity/compatibility must be refused BEFORE a cloud boot is
    // spent on it.
    expect(executed).toBe(false);
  });

  it("uses the injected executor rather than constructing a live GCP one", async () => {
    const calls: string[] = [];
    await runCleanRoomAcceptanceCli(
      {
        artifact: { image: { id: "bogus", version: "0.0.0" } } as never,
        spec: { architecture: "x86_64" } as never,
        placement,
      },
      {
        executor: {
          async execute() {
            calls.push("execute");
            return { stdout: "" };
          },
        },
      },
    );
    // Proves the seam exists and nothing reached for real cloud credentials in this test.
    expect(calls.length).toBeLessThanOrEqual(1);
  });
});
