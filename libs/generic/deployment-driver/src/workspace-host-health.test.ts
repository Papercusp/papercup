import { describe, expect, it } from "vitest";
import { resolveWorkspaceHostHealthStatus, unmeasuredHealthCheck } from "./workspace-host-health";
import type { WorkspaceHostHealthCheck } from "./workspace-host-types";

const measured = (name: string, ok: boolean): WorkspaceHostHealthCheck => ({ name, ok });

describe("resolveWorkspaceHostHealthStatus", () => {
  it("reports healthy only when every check was measured AND passed", () => {
    expect(
      resolveWorkspaceHostHealthStatus({
        reachable: true,
        checks: [measured("a", true), measured("b", true)],
      }),
    ).toBe("healthy");
  });

  it("reports unknown — never healthy — when any check was not measured", () => {
    // The property that makes the WI-2143924 class unreachable: a passing check set with a
    // single unmeasured signal in it cannot resolve to 'healthy'. Attesting healthy off a
    // field nobody wrote is what let `attestHealth` be wrong in silence.
    expect(
      resolveWorkspaceHostHealthStatus({
        reachable: true,
        checks: [measured("a", true), unmeasuredHealthCheck("b", "no producer")],
      }),
    ).toBe("unknown");
  });

  it("reports unknown for a check set that is entirely unmeasured", () => {
    expect(
      resolveWorkspaceHostHealthStatus({ reachable: true, checks: [unmeasuredHealthCheck("a", "no producer")] }),
    ).toBe("unknown");
  });

  it("prefers degraded over unknown — a measured failure outranks a gap in coverage", () => {
    expect(
      resolveWorkspaceHostHealthStatus({
        reachable: true,
        checks: [measured("a", false), unmeasuredHealthCheck("b", "no producer")],
      }),
    ).toBe("degraded");
  });

  it("reports unreachable regardless of what the other checks say", () => {
    for (const checks of [
      [measured("a", true)],
      [measured("a", false)],
      [unmeasuredHealthCheck("a", "no producer")],
      [],
    ]) {
      expect(resolveWorkspaceHostHealthStatus({ reachable: false, checks })).toBe("unreachable");
    }
  });

  it("reports healthy for an empty measured set — nothing failing, nothing unmeasured", () => {
    expect(resolveWorkspaceHostHealthStatus({ reachable: true, checks: [] })).toBe("healthy");
  });

  it("does not treat an unmeasured check as a failing one", () => {
    // `ok: null` is falsy, so any reader written as `if (check.ok)` would fold it into the
    // failing branch. The resolver must distinguish them, which is the whole point.
    const unmeasured = unmeasuredHealthCheck("a", "no producer");
    expect(unmeasured.ok).toBeNull();
    expect(unmeasured.ok).not.toBe(false);
    expect(resolveWorkspaceHostHealthStatus({ reachable: true, checks: [unmeasured] })).not.toBe("degraded");
  });

  it("keeps the unmeasured check in the set instead of dropping it", () => {
    // Dropping the check would resolve 'healthy' off the survivors — a quieter version of
    // the same lie. The signal stays, carrying why it could not be measured.
    const check = unmeasuredHealthCheck("workspace-agent-online", "no producer writes agentOnline");
    expect(check).toEqual({
      name: "workspace-agent-online",
      ok: null,
      detail: "no producer writes agentOnline",
    });
  });
});
