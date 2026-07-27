import { describe, expect, it } from "vitest";
import { snapshotFault } from "./snapshot-fault";

describe("snapshotFault", () => {
  it("reports no fault for a healthy snapshot", () => {
    expect(snapshotFault(null, { }, "EKG")).toEqual({
      failed: false,
      source: null,
      message: null,
    });
  });

  // The defect WI-6382 exists to close: an OBSERVED empty is not a fault. The
  // panel's calm "nothing yet" state is CORRECT here, and must stay reachable.
  it("reports no fault for a genuinely empty snapshot", () => {
    expect(snapshotFault(null, undefined, "EKG").failed).toBe(false);
  });

  // The panels have a standing decision that transport internals never reach
  // the screen; the data-layer branch is the deliberate exception, because that
  // reason is authored by our own resolver about our own substrate.
  it("fires on a transport error WITHOUT leaking its detail", () => {
    const f = snapshotFault(new Error("socket secret"), {}, "EKG");
    expect(f.failed).toBe(true);
    expect(f.source).toBe("transport");
    expect(f.message).toBe("EKG unavailable");
    expect(f.message).not.toContain("socket secret");
  });

  // THE reachability fix: before this, a data-layer failure produced a
  // successful empty snapshot, `sync.error` stayed null, and the panel's error
  // branch could not fire for the class it appeared to handle.
  it("fires on a DEGRADED snapshot even though there is no transport error", () => {
    const f = snapshotFault(
      null,
      { unavailable: true, unavailableKind: "read-failed", unavailableReason: "permission denied" },
      "EKG",
    );
    expect(f.failed).toBe(true);
    expect(f.source).toBe("data");
    expect(f.message).toContain("permission denied");
  });

  it("distinguishes pre-migration from a read failure in the copy the user sees", () => {
    const pre = snapshotFault(
      null,
      { unavailable: true, unavailableKind: "pre-migration", unavailableReason: "relation does not exist" },
      "Throughput",
    );
    expect(pre.message).toContain("not available yet");
    expect(pre.message).not.toContain("recorded yet"); // never the idle-empty copy

    const failed = snapshotFault(
      null,
      { unavailable: true, unavailableKind: "read-failed", unavailableReason: "boom" },
      "Throughput",
    );
    expect(failed.message).toContain("Throughput unavailable");
    expect(failed.message).not.toContain("not available yet");
  });

  it("never renders a bare 'unavailable' when a reason exists", () => {
    const f = snapshotFault(
      null,
      { unavailable: true, unavailableKind: "read-failed", unavailableReason: "Cannot find package mem0ai" },
      "Shared memory",
    );
    expect(f.message).toContain("Cannot find package mem0ai");
  });

  it("still degrades gracefully when a reason is missing", () => {
    const f = snapshotFault(null, { unavailable: true }, "EKG");
    expect(f.failed).toBe(true);
    expect(f.message).toBe("EKG unavailable");
  });

  it("transport error takes precedence over snapshot provenance", () => {
    const f = snapshotFault(new Error("down"), { unavailable: true }, "EKG");
    expect(f.source).toBe("transport");
  });
});
