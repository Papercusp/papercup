/**
 * registry-reads-shape.test.ts — payload-tier shapers for the registry/list
 * reads (context-trimming-tiers-2026-07-01 P-023: locks:list /
 * agent_tools:list / harness_docs:list). Pure projections; the D-004
 * loud-cap contract is under test: uniform TOON keys, visible truncation
 * notices, true totals preserved.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/registry-reads-shape.test.ts
 */
import { describe, expect, it } from "vitest";
import { LOCKS_LIST_TIER_CAPS, shapeLocksList } from "./locks/list-shape";
import { AGENT_TOOLS_TIER_CAPS, shapeAgentToolsList } from "./agent_tools/list-shape";
import { HARNESS_DOCS_TIER_CAPS, shapeHarnessDocsList } from "./harness_docs/list-shape";

describe("shapeLocksList (P-023)", () => {
  const data = {
    ok: true,
    resources: Array.from({ length: 3 }, (_, i) => ({
      resource: `res-${i}`,
      description: "d".repeat(300),
      rule_text: "r".repeat(300),
      enforcement: "block",
    })),
    holders: [
      {
        owner: "su-1",
        owner_label: "su · 1",
        mode: "shared",
        status: "held",
        reason: "x".repeat(300),
        acquired_ts: "2026-07-01T00:00:00Z",
        expires_ts: "2026-07-01T01:00:00Z",
      },
    ],
    draining: [],
  };

  it("clips registry rules; trimmed drops description + holder reason", () => {
    const out = shapeLocksList(data, "trimmed") as {
      resources: Record<string, unknown>[];
      holders: Record<string, unknown>[];
    };
    expect(String(out.resources[0].rule).length).toBeLessThanOrEqual(
      LOCKS_LIST_TIER_CAPS.trimmed.rule,
    );
    expect(out.resources[0]).not.toHaveProperty("description");
    expect(out.holders[0]).not.toHaveProperty("reason");
    expect(out.holders[0]).not.toHaveProperty("acquired_ts");
    const std = shapeLocksList(data, "standard") as {
      resources: Record<string, unknown>[];
      holders: Record<string, unknown>[];
    };
    expect(String(std.resources[0].description).length).toBeLessThanOrEqual(
      LOCKS_LIST_TIER_CAPS.standard.description,
    );
    expect(String(std.holders[0].reason).length).toBeLessThanOrEqual(
      LOCKS_LIST_TIER_CAPS.standard.reason,
    );
  });

  it("caps resources with a uniform-key notice row", () => {
    const cap = LOCKS_LIST_TIER_CAPS.trimmed.resources;
    const big = {
      ...data,
      resources: Array.from({ length: cap + 4 }, (_, i) => ({
        resource: `r${i}`,
        rule_text: "x",
        enforcement: "warn",
        description: null,
      })),
    };
    const out = shapeLocksList(big, "trimmed") as {
      resources: Record<string, unknown>[];
    };
    expect(out.resources).toHaveLength(cap + 1);
    expect(out.resources.at(-1)!.resource).toBe("(truncated)");
    const keys = Object.keys(out.resources[0]).sort();
    for (const r of out.resources) expect(Object.keys(r).sort()).toEqual(keys);
  });

  it("non-conforming data passes through", () => {
    const weird = { ok: false };
    expect(shapeLocksList(weird, "trimmed")).toBe(weird);
  });
});

describe("shapeAgentToolsList (P-023)", () => {
  const tool = (i: number) => ({
    name: `group:verb-${i}`,
    description: "a tool description ".repeat(20),
    capability: "x:read",
    roles: ["operator", "worker"],
    tier: null,
    timeoutSec: null,
    rolesQuota: { operator: { perRun: 60 } },
    allowed: i % 2 === 0,
    reason: i % 2 === 0 ? null : "role_not_allowed: …",
    guidance: { when: "w".repeat(400), notWhen: "n".repeat(400), chaining: "c" },
    composition: "primitive",
    replaces: null,
  });
  const data = { callerRole: "su", isSuperuser: false, count: 4, tools: [tool(0), tool(1), tool(2), tool(3)] };

  it("trimmed keeps name/capability/allowed + a description excerpt; guidance is gone", () => {
    const out = shapeAgentToolsList(data, "trimmed") as {
      count: number;
      tools: Record<string, unknown>[];
    };
    expect(out.count).toBe(4); // true total survives
    const r = out.tools[0];
    expect(r.name).toBe("group:verb-0");
    expect(r.allowed).toBe(true);
    expect(String(r.description).length).toBeLessThanOrEqual(
      AGENT_TOOLS_TIER_CAPS.trimmed.description,
    );
    for (const gone of ["guidance", "roles", "rolesQuota", "replaces", "reason"])
      expect(r).not.toHaveProperty(gone);
    // standard restores reason + a `when` excerpt
    const std = shapeAgentToolsList(data, "standard") as {
      tools: Record<string, unknown>[];
    };
    expect(std.tools[1].reason).toContain("role_not_allowed");
    expect(String(std.tools[0].when).length).toBeLessThanOrEqual(
      AGENT_TOOLS_TIER_CAPS.standard.when,
    );
  });

  it("caps rows with a notice row pointing at filter/tools:find/full", () => {
    const cap = AGENT_TOOLS_TIER_CAPS.trimmed.rows;
    const big = { ...data, tools: Array.from({ length: cap + 9 }, (_, i) => tool(i)) };
    const out = shapeAgentToolsList(big, "trimmed") as {
      tools: Record<string, unknown>[];
    };
    expect(out.tools).toHaveLength(cap + 1);
    const notice = out.tools.at(-1)!;
    expect(notice.name).toBe("(truncated)");
    expect(notice.description).toContain("tools:find");
    const keys = Object.keys(out.tools[0]).sort();
    for (const r of out.tools) expect(Object.keys(r).sort()).toEqual(keys);
  });
});

describe("shapeHarnessDocsList (P-023)", () => {
  const entry = (i: number) => ({
    docId: `docs/d${i}.md`,
    source: "manual",
    status: "fresh",
    statusDetail: "verified at HEAD",
    subjectRef: [{ kind: "path", value: "src/a.ts" }],
    subjectLabel: "src/a.ts",
    anchorPaths: ["src/a.ts"],
    generatedFromSha: null,
    lastVerifiedSha: "abc123",
    lastVerifiedAt: "2026-07-01T00:00:00Z",
    hasOverlay: false,
    title: `Doc ${i}`,
    bodyMissing: false,
    tracked: true,
  });
  const data = {
    ok: true,
    projectPath: "/x",
    docsRoot: "/x/docs",
    files: ["docs/d0.md", "docs/d1.md"],
    entries: [entry(0), entry(1)],
    activePath: "docs/d0.md",
    content: "B".repeat(10_000),
    activeEntry: { ...entry(0), overlay: "O".repeat(2_000) },
  };

  it("clips the body loudly, collapses files to a count, leans the entries", () => {
    const out = shapeHarnessDocsList(data, "trimmed") as Record<string, unknown>;
    expect(out.filesCount).toBe(2);
    expect(out).not.toHaveProperty("files");
    expect(String(out.content)).toHaveLength(HARNESS_DOCS_TIER_CAPS.trimmed.content);
    expect(out.content_truncated).toBe(true);
    expect(out.content_full_chars).toBe(10_000);
    expect(String(out.content_hint)).toContain('payloadTier:"full"');
    const entries = out.entries as Record<string, unknown>[];
    for (const gone of ["subjectRef", "anchorPaths", "lastVerifiedSha", "generatedFromSha"])
      expect(entries[0]).not.toHaveProperty(gone);
    const ae = out.activeEntry as Record<string, unknown>;
    expect(String(ae.overlay).length).toBeLessThanOrEqual(HARNESS_DOCS_TIER_CAPS.trimmed.overlay);
    expect(ae.overlay_truncated).toBe(true);
  });

  it("a short body is untouched (no truncation flags)", () => {
    const small = { ...data, content: "short body", activeEntry: null };
    const out = shapeHarnessDocsList(small, "standard") as Record<string, unknown>;
    expect(out.content).toBe("short body");
    expect(out).not.toHaveProperty("content_truncated");
    expect(out.activeEntry).toBeNull();
  });

  it("non-conforming data (error shape) passes through", () => {
    const err = { ok: false, error: "harness_required" };
    expect(shapeHarnessDocsList(err, "trimmed")).toBe(err);
  });
});
