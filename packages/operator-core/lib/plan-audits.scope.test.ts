import { beforeEach, describe, expect, it, vi } from "vitest";

const M = vi.hoisted(() => ({
  activeWorkspaceId: vi.fn(() => "ambient-workspace"),
  sql: vi.fn(),
}));

vi.mock("@papercusp/db-org", async (orig) => ({
  ...(await orig<typeof import("@papercusp/db-org")>()),
  getOrgPg: () => ({ sql: M.sql }),
}));

vi.mock("./workspace-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspace-registry")>()),
  activeWorkspaceId: M.activeWorkspaceId,
}));

import { getLatestActivationAudit, getLatestPlanAudit } from "./plan-audits";

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

  it("reads activation audits independently from completion audits", async () => {
    M.sql.mockResolvedValue([{
      ...row,
      audit_kind: "activation",
      activation: { sourceRanges: [], mappings: [], repairedOmissions: [], rejectedOrSuperseded: [], unresolvedBlockers: [] },
      audited_plan_revision_id: 17,
      audited_plan_revision_seq: 4,
      audited_plan_content_hash: "a".repeat(64),
    }]);

    const result = await getLatestActivationAudit("scoped-plan", { workspaceId: "papercusp-workspace" });

    expect(result).toMatchObject({
      auditKind: "activation",
      auditedPlanRevision: { id: 17, seq: 4, contentHash: "a".repeat(64) },
    });
    expect(M.sql.mock.calls[0]?.[0]?.join(" ")).toContain("audit_kind = 'activation'");
  });

  // EI-21124863090048444: plans:get omitted latestAudit for a "SideStage"-shaped plan
  // (a Hive with member/sub-harnesses) even though the canonical plan_audits row
  // existed. Root cause: plans:audit stores harness_slug as the CITATION-CONTEXT
  // harness it ran from (e.g. a member/sub-harness like "sidestage-mobile" or
  // "papercusp/libs/generic/rrf"), while plans:get was passing the plan's Hive-HOME
  // slug (e.g. "sidestage" / "papercusp") as a strict-equality filter — a value that
  // routinely disagrees with what was written, so the real row matched nothing.
  it("finds a canonical audit row even when its stored harness_slug is a member/sub-harness, not the plan's Hive home", async () => {
    const sideStageAudit = {
      ...row,
      plan_slug: "sidestage-plan",
      // The audit was recorded from a MEMBER harness of the "sidestage" Hive —
      // not from the Hive home itself.
      harness_slug: "sidestage-mobile",
    };
    M.sql.mockResolvedValue([sideStageAudit]);

    // The fixed call shape (plans/get.ts): workspaceId only, matching how
    // recordPlanAudit's own audit_seq computation and getEffectiveItemAudits both
    // already scope the audit ledger purely by (workspaceId, planSlug).
    const result = await getLatestPlanAudit("sidestage-plan", {
      workspaceId: "papercusp-workspace",
    });

    expect(result).toMatchObject({ planSlug: "sidestage-plan", harnessSlug: "sidestage-mobile" });

    // Pins the FIXED contract: the harness_slug predicate is passed NULL (the
    // real WHERE clause is `harness_slug = ${harnessSlug}::text IS NULL OR ...`,
    // so NULL means unfiltered). Before the fix, plans:get threaded the plan's
    // Hive-home slug ("sidestage") through here — a value that never equals the
    // stored citation-context slug ("sidestage-mobile") for a Hive with
    // member/sub-harnesses, so that predicate would have matched zero rows
    // against a real database even though this row is the canonical audit.
    expect(M.sql.mock.calls[0]?.[3]).toBeNull();
    expect(M.sql.mock.calls[0]?.[4]).toBeNull();
  });
});
