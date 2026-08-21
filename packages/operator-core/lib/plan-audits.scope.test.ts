import { beforeEach, describe, expect, it, vi } from "vitest";

const M = vi.hoisted(() => ({
  activeWorkspaceId: vi.fn(() => "ambient-workspace"),
  sql: vi.fn(),
}));

vi.mock("@papercusp/db-org", () => ({
  getOrgPg: () => ({ sql: M.sql }),
}));

vi.mock("./workspace-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspace-registry")>()),
  activeWorkspaceId: M.activeWorkspaceId,
}));

import { getLatestPlanAudit } from "./plan-audits";

const row = {
  plan_slug: "scoped-plan",
  harness_slug: "papercusp",
  audit_seq: 1,
  created_by: "su-auditor",
  created_at: "2026-08-21T01:01:02.607Z",
  audited_sha: "2cda0139fa8864763823af5ed7f38d413dd4b950",
  items: [],
  findings: [],
  summary: "verified",
};

describe("getLatestPlanAudit workspace scope", () => {
  beforeEach(() => {
    M.sql.mockReset();
    M.activeWorkspaceId.mockClear();
  });

  it("uses the explicit plan workspace and harness instead of ambient workspace", async () => {
    M.sql.mockResolvedValue([row]);

    const result = await getLatestPlanAudit("scoped-plan", {
      workspaceId: "papercusp-workspace",
      harnessSlug: "papercusp",
    });

    expect(result).toMatchObject({
      planSlug: "scoped-plan",
      harnessSlug: "papercusp",
      auditSeq: 1,
    });
    expect(M.activeWorkspaceId).not.toHaveBeenCalled();
    expect(M.sql).toHaveBeenCalledTimes(1);
    expect(M.sql.mock.calls[0]?.[1]).toEqual("papercusp-workspace");
    expect(M.sql.mock.calls[0]?.[2]).toEqual("scoped-plan");
    expect(M.sql.mock.calls[0]?.[3]).toEqual("papercusp");
    expect(M.sql.mock.calls[0]?.[4]).toEqual("papercusp");
  });

  it("retains the ambient fallback for acceptance-gate callers", async () => {
    M.sql.mockResolvedValue([row]);

    await getLatestPlanAudit("scoped-plan");

    expect(M.activeWorkspaceId).toHaveBeenCalledTimes(1);
    expect(M.sql.mock.calls[0]?.[1]).toEqual("ambient-workspace");
    expect(M.sql.mock.calls[0]?.[3]).toBeNull();
    expect(M.sql.mock.calls[0]?.[4]).toBeNull();
  });
});
