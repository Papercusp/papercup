import { describe, expect, it, vi } from "vitest";
import {
  measureTargetedGateRuns,
  validateTargetedGateOutcomes,
  type TargetedGateResult,
} from "./green-checkpoint";

const HEAD = "a".repeat(40);

describe("targeted gate outcome evidence", () => {
  it("runs beyond the first failure and retains each task's actual result", async () => {
    const run = vi.fn(async (script: string) => ({ code: script === "lint:broken" ? 1 : 0 }));
    const result = await measureTargetedGateRuns(["lint:before", "lint:broken", "lint:after"], run);
    expect(run.mock.calls.map(([script]) => script)).toEqual(["lint:before", "lint:broken", "lint:after"]);
    expect(result).toMatchObject({
      pass: false,
      coverageComplete: true,
      perGate: [
        { id: "lint:before", status: "pass" },
        { id: "lint:broken", status: "fail" },
        { id: "lint:after", status: "pass" },
      ],
    });
  });

  it("executes a duplicate physical task once without duplicating its outcome", async () => {
    const run = vi.fn(async () => ({ code: 0 }));
    const result = await measureTargetedGateRuns(["lint:tsc", "lint:tsc"], run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.perGate).toEqual([{ id: "lint:tsc", status: "pass" }]);
  });

  it("reports thrown and unmapped tasks as unmeasured, never successful coverage", async () => {
    const run = vi.fn(async (script: string) => {
      if (script === "lint:throws") throw new Error("spawn failed");
      return { code: 0 };
    });
    const result = await measureTargetedGateRuns(["lint:throws", "unmapped", "lint:after"], run);
    expect(result).toMatchObject({
      pass: false,
      coverageComplete: false,
      perGate: [
        { id: "lint:throws", status: "errored" },
        { id: "unmapped", status: "errored" },
        { id: "lint:after", status: "pass" },
      ],
    });
  });

  const valid = (): TargetedGateResult => ({
    pass: false,
    summary: "one failure",
    measuredHead: HEAD,
    perGate: [{ id: "lint:a", status: "pass" }, { id: "lint:b", status: "fail" }],
  });

  it("accepts exact complete head-bound outcomes with matching aggregate", () => {
    const result = valid();
    expect(validateTargetedGateOutcomes(result, ["lint:a", "lint:b"], HEAD)).toEqual(result.perGate);
  });

  it("does not accept an arbitrary gating task relabeled NOT CHECKED", () => {
    const result = valid();
    result.perGate![0]!.status = "not-checked";
    expect(validateTargetedGateOutcomes(result, ["lint:a", "lint:b"], HEAD)).toBeNull();
  });

  it.each(["missing", "duplicate", "foreign", "head", "aggregate", "status"] as const)(
    "rejects %s evidence without discharging obligations",
    (kind) => {
      const result = valid();
      if (kind === "missing") result.perGate!.pop();
      if (kind === "duplicate") result.perGate![1] = result.perGate![0]!;
      if (kind === "foreign") result.perGate![1]!.id = "lint:foreign";
      if (kind === "head") result.measuredHead = "b".repeat(40);
      if (kind === "aggregate") result.pass = true;
      if (kind === "status") (result.perGate![0] as { status: string }).status = "unknown";
      expect(validateTargetedGateOutcomes(result, ["lint:a", "lint:b"], HEAD)).toBeNull();
    },
  );
});
