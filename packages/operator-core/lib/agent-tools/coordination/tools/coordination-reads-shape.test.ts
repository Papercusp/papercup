/**
 * coordination-reads-shape.test.ts — payload-tier behavior for the
 * coordination reads (context-trimming-tiers-2026-07-01 P-022):
 *   - coord:presence / fleet:assignments — pure `shape` projections
 *     ({data}-converted; the pui reads them over HTTP → full).
 *   - coord:plan-events — ctx-tier-ADAPTIVE DEFAULTS on a hand-rolled JSON
 *     ToolResult (the OMP coord-hook JSON.parses it — coord:inbox precedent).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/coordination-reads-shape.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import {
  PRESENCE_RESPONSE_BUDGET_CHARS,
  PRESENCE_TIER_CAPS,
  shapeCoordPresence,
} from "./presence-shape";
import {
  ASSIGNMENTS_TIER_CAPS,
  shapeFleetAssignments,
} from "../../fleet/assignments-shape";

function rosterRow(i: number, overrides: Record<string, unknown> = {}) {
  return {
    ownerId: `su-${String(i).padStart(4, "0")}`,
    ownerLabel: `su · ${i}`,
    workspaceId: "papercusp",
    source: "presence",
    host: "dev-box",
    pid: 1000 + i,
    startedAt: "2026-07-01T00:00:00Z",
    agentRole: "su",
    potSlug: null,
    fleetSlug: i % 2 ? "backend" : null,
    fleetRole: null,
    model: "claude-fable-5",
    userId: "u1",
    federated: false,
    devicePubkey: "pk-abcdef",
    harnessSlug: "papercusp",
    intent: `working on thing ${i} with a description long enough to exceed the eighty character trimmed intent cap for sure`,
    currentPlanSlug: "some-plan",
    currentView: null,
    currentFiles: ["a.ts", "b.ts"],
    claimedItems: ["some-plan#P-001", "some-plan#P-002"],
    claimCount: 2,
    awaitingEvent: null,
    awaitingEventKey: null,
    awaitingNote: "waiting on the lock grant cascade to reach my ticket",
    wakeMode: "auto",
    revoked: false,
    lastActiveSecAgo: 12,
    lastActiveSource: "turn-parts",
    intentStale: false,
    sessionState: "live",
    wakeable: true,
    onDesktop: false,
    viewerAttached: false,
    isSelf: i === 0,
    ...overrides,
  };
}

describe("shapeCoordPresence (P-022)", () => {
  const snapshot = {
    as_of: "2026-07-02T00:00:00Z",
    scope: "workspace",
    summary: {
      active: 2,
      stale: 0,
      federated: 0,
      wakeable: 2,
      onDesktop: 0,
      viewerAttached: 0,
      byState: { live: 2, parked: 0, ended: 3, recorded: 0 },
    },
    self: "su-0000",
    active: [rosterRow(0), rosterRow(1)],
  };

  it("projects rows to the dispatch core; env detail (host/pid/devicePubkey) is gone", () => {
    const out = shapeCoordPresence(snapshot, "trimmed") as {
      active: Record<string, unknown>[];
      summary: unknown;
      self: unknown;
    };
    const r = out.active[0];
    expect(r.ownerId).toBe("su-0000");
    expect(r.state).toBe("live");
    expect(r.wakeable).toBe(true);
    expect(r.claims).toBe(2);
    expect(r.lastActiveSource).toBe("turn-parts");
    expect(r.isSelf).toBe(true);
    expect(String(r.intent).length).toBeLessThanOrEqual(
      PRESENCE_TIER_CAPS.trimmed.intent,
    );
    for (const gone of ["host", "pid", "devicePubkey", "startedAt", "userId"])
      expect(r).not.toHaveProperty(gone);
    // summary + self survive verbatim (counts contract / seeAlso input)
    expect(out.summary).toBe(snapshot.summary);
    expect(out.self).toBe("su-0000");
    expect(out).not.toHaveProperty("activeTruncated");
    // standard adds the wider lane
    const std = shapeCoordPresence(snapshot, "standard") as {
      active: Record<string, unknown>[];
    };
    expect(std.active[0].harness).toBe("papercusp");
    expect(std.active[0].claimRefs).toBe("some-plan#P-001,some-plan#P-002");
    expect(std.active[0].files).toBe(2);
  });

  it("uses the unified claimCount while retaining the plan-item claimRefs lane", () => {
    const out = shapeCoordPresence(
      {
        ...snapshot,
        active: [rosterRow(0, { claimedItems: [], claimCount: 2 })],
      },
      "standard",
    ) as { active: Record<string, unknown>[] };
    expect(out.active[0].claims).toBe(2);
    expect(out.active[0].claimRefs).toBeNull();
  });

  it("caps rows with a uniform-key notice row", () => {
    const cap = PRESENCE_TIER_CAPS.trimmed.rows;
    const big = {
      ...snapshot,
      summary: { ...snapshot.summary, active: cap + 5 },
      active: Array.from({ length: cap + 5 }, (_, i) => rosterRow(i)),
    };
    const out = shapeCoordPresence(big, "trimmed") as {
      active: Record<string, unknown>[];
      activeTruncated: {
        shown: number;
        censusCount: number;
        truncatedByLimit: boolean;
        limit: number;
        reason?: string;
        more: string;
      };
    };
    expect(out.active.length).toBeLessThanOrEqual(cap + 1);
    expect(out.active.length).toBeGreaterThan(1);
    expect(out.activeTruncated).toMatchObject({
      shown: out.active.length - 1,
      censusCount: cap + 5,
      truncatedByLimit: true,
      limit: cap,
      more: expect.stringContaining('coord:presence { owner }'),
    });
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(PRESENCE_RESPONSE_BUDGET_CHARS);
    if (out.activeTruncated.reason === "response_budget") {
      expect(out.active[out.active.length - 1].intent).toContain("response budget");
    }
    // The disclosure is serialized before the long roster, so it is not hidden
    // behind the result-door's tail clipping.
    expect(Object.keys(out).indexOf("activeTruncated")).toBeLessThan(
      Object.keys(out).indexOf("active"),
    );
    const notice = out.active.at(-1)!;
    expect(notice.ownerId).toBe("(truncated)");
    expect(notice.intent).toContain('payloadTier:"full"');
    const keys = Object.keys(out.active[0]).sort();
    for (const row of out.active) expect(Object.keys(row).sort()).toEqual(keys);
  });

  it("keeps detailed/cursor reads below the result-door budget", () => {
    const big = {
      ...snapshot,
      active: Array.from({ length: 130 }, (_, i) => ({
        ...rosterRow(i),
        heldFiles: Array.from({ length: 12 }, (_, n) => `packages/file-${n}.ts`),
        cursor: { terms: Array.from({ length: 20 }, (_, n) => `term-${n}`) },
      })),
    };
    const out = shapeCoordPresence(big, "trimmed") as {
      active: Record<string, unknown>[];
      activeTruncated: { reason?: string; shown: number };
    };

    expect(JSON.stringify(out).length).toBeLessThanOrEqual(PRESENCE_RESPONSE_BUDGET_CHARS);
    expect(out.activeTruncated.reason).toBe("response_budget");
    expect(out.activeTruncated.shown).toBe(out.active.length - 1);
    expect(out.active[0]).not.toHaveProperty("heldFiles");
    expect(out.active[0]).not.toHaveProperty("cursor");
  });

  it("non-conforming data passes through", () => {
    const weird = { error: "nope" };
    expect(shapeCoordPresence(weird, "trimmed")).toBe(weird);
  });

  // P-031 leg (d) — the appended coupling block (default-ON since D-098).
  describe("expanded[] (include_coupling)", () => {
    const longIntent =
      "Wiring the P-031 union consumer into coord:presence and re-verifying it live on the staging operator at :3170 before flipping anything";
    const coupled = {
      ...snapshot,
      expanded: [
        {
          ownerId: "su-0001",
          expandedBecause: "coupled — declared by su-0000: both editing sync-resolver",
          source: "declared",
          reason: "both editing sync-resolver",
          declaredBy: "su-0000",
          inRoster: true,
          ownerLabel: "su · 1",
          sessionState: "live",
          intent: longIntent,
          intentStale: false,
          lastActiveSecAgo: 7,
        },
      ],
      expandedTotal: 1,
    };

    it("survives every tier — the appended coupling block is never dropped by shaping", () => {
      for (const tier of ["trimmed", "standard"] as const) {
        const out = shapeCoordPresence(coupled, tier) as {
          expanded: Record<string, unknown>[];
          expandedTotal: number;
        };
        expect(out.expanded).toHaveLength(1);
        expect(out.expandedTotal).toBe(1);
        expect(out.expanded[0].ownerId).toBe("su-0001");
        // expandedBecause is the whole point of the block — never clipped away.
        expect(out.expanded[0].expandedBecause).toBe(coupled.expanded[0].expandedBecause);
      }
    });

    it("clips the block's intent to the SAME cap as the base rows, so the opt-in block is never heavier per entry", () => {
      for (const tier of ["trimmed", "standard"] as const) {
        const out = shapeCoordPresence(coupled, tier) as { expanded: Record<string, unknown>[] };
        expect(String(out.expanded[0].intent).length).toBeLessThanOrEqual(
          PRESENCE_TIER_CAPS[tier].intent,
        );
      }
    });

    it("leaves the base rows byte-identical whether the block is present or not (D-053)", () => {
      const withBlock = shapeCoordPresence(coupled, "trimmed") as Record<string, unknown>;
      const without = shapeCoordPresence(snapshot, "trimmed") as Record<string, unknown>;
      expect(JSON.stringify(withBlock.active)).toBe(JSON.stringify(without.active));
      expect(withBlock.summary).toBe(without.summary);
      // …and no block appears when the caller did not opt in.
      expect(without).not.toHaveProperty("expanded");
    });
  });
});

function agentRow(i: number, overrides: Record<string, unknown> = {}) {
  return {
    agentId: `su-${i}`,
    label: `su · ${i}`,
    name: null,
    present: true,
    alive: true,
    sessionState: "live",
    heartbeatAt: "2026-07-02T00:00:00Z",
    intent: `a long intent string for agent ${i} that certainly exceeds the eighty character trimmed cap on intent text`,
    declaredPlanSlug: "plan-x",
    fleetSlug: "backend",
    fleetRole: null,
    claims: [
      { type: "plan-item", planSlug: "plan-x", id: "P-001", status: null, activity: "alive" },
      { type: "work-item", planSlug: null, id: "WI-9", status: "open", activity: "alive" },
    ],
    orphaned: false,
    stalled: false,
    declaredUnclaimed: false,
    doing: { id: "WI-9", itemKind: "task", title: "Do the important thing with a very long title indeed", status: "open" },
    queued: [{ id: "WI-10" }, { id: "WI-11" }],
    load: 3,
    isSelf: i === 0,
    ...overrides,
  };
}

describe("shapeFleetAssignments (P-022)", () => {
  const data = {
    ok: true,
    self: "su-0",
    summary: { agents: 2, alive: 2, claims: 4, orphaned_claims: 1, stalled_claims: 0, declared_unclaimed: 0, work_item_load: 3 },
    orphaned: [{ source: "work_item_claim", agent: "su-9", id: "WI-1" }],
    stalled: [],
    coverage: Array.from({ length: 5 }, (_, i) => ({
      plan: "plan-x",
      item: `P-00${i}`,
      level: "full",
      workers: ["su-0"],
      links: [{ id: "WI-1", rel: "relates", activity: "alive", terminal: false }],
    })),
    agents: [agentRow(0), agentRow(1)],
  };

  it("trimmed = summary + reclaimables + compact agent rows; coverage collapses to a note", () => {
    const out = shapeFleetAssignments(data, "trimmed") as Record<string, unknown>;
    expect(out.summary).toBe(data.summary);
    expect(out.orphaned).toEqual(data.orphaned);
    expect(out).not.toHaveProperty("coverage");
    expect(String(out.coverage_note)).toContain("5 rows");
    const agents = out.agents as Record<string, unknown>[];
    expect(agents[0].claims).toBe(2);
    expect(agents[0].doing).toContain("WI-9");
    expect(agents[0].load).toBe(3);
    // EI-6077: sessionState rides at BOTH tiers (it's part of the placement-
    // decision core, not extra detail) so a caller never has to cross-call
    // coord:presence just to tell "really runnable" from "just looks alive".
    expect(agents[0].sessionState).toBe("live");
    expect(agents[0]).not.toHaveProperty("queued");
    expect(String(agents[0].intent).length).toBeLessThanOrEqual(
      ASSIGNMENTS_TIER_CAPS.trimmed.intent,
    );
  });

  it("standard restores a projected coverage table (no links) + wider agent rows", () => {
    const out = shapeFleetAssignments(data, "standard") as Record<string, unknown>;
    const cov = out.coverage as Record<string, unknown>[];
    expect(cov).toHaveLength(5);
    expect(cov[0]).toEqual({ plan: "plan-x", item: "P-000", level: "full", workers: "su-0" });
    expect(cov[0]).not.toHaveProperty("links");
    const agents = out.agents as Record<string, unknown>[];
    expect(agents[0].claimRefs).toBe("plan-x#P-001,WI-9");
    expect(agents[0].queued).toBe(2);
  });

  it("caps agents with a uniform-key notice row", () => {
    const cap = ASSIGNMENTS_TIER_CAPS.trimmed.agents;
    const big = { ...data, agents: Array.from({ length: cap + 3 }, (_, i) => agentRow(i)) };
    const out = shapeFleetAssignments(big, "trimmed") as {
      agents: Record<string, unknown>[];
    };
    expect(out.agents).toHaveLength(cap + 1);
    expect(out.agents.at(-1)!.agentId).toBe("(truncated)");
    const keys = Object.keys(out.agents[0]).sort();
    for (const row of out.agents) expect(Object.keys(row).sort()).toEqual(keys);
  });

  it("carries coverage_collisions through both tiers (EI-6074 — the reclaimable-grade smell)", () => {
    const withCollision = {
      ...data,
      summary: { ...data.summary, coverage_collisions: 1 },
      coverage_collisions: [
        {
          ref: "plan-x#P-004",
          directHolder: "su-A",
          workItemHolders: [{ workItemId: "WI-1347", holder: "su-B" }],
          principals: ["su-A", "su-B"],
        },
      ],
    };
    for (const tier of ["trimmed", "standard"] as const) {
      const out = shapeFleetAssignments(withCollision, tier) as Record<string, unknown>;
      expect(out.coverage_collisions).toEqual(withCollision.coverage_collisions);
      expect((out.summary as Record<string, unknown>).coverage_collisions).toBe(1);
    }
  });

  it("omits coverage_collisions when clean", () => {
    const out = shapeFleetAssignments(data, "trimmed") as Record<string, unknown>;
    expect(out).not.toHaveProperty("coverage_collisions");
  });

  it("carries same-principal coverage_duplicates through both tiers (EI-21188799646985672)", () => {
    const withDuplicate = {
      ...data,
      summary: { ...data.summary, coverage_duplicates: 1 },
      coverage_duplicates: [
        {
          ref: "plan-x#P-004",
          holder: "su-A",
          workItemIds: ["WI-1347", "WI-1348"],
        },
      ],
    };
    for (const tier of ["trimmed", "standard"] as const) {
      const out = shapeFleetAssignments(withDuplicate, tier) as Record<string, unknown>;
      expect(out.coverage_duplicates).toEqual(withDuplicate.coverage_duplicates);
      expect((out.summary as Record<string, unknown>).coverage_duplicates).toBe(1);
    }
  });

  it("omits coverage_duplicates when clean", () => {
    const out = shapeFleetAssignments(data, "trimmed") as Record<string, unknown>;
    expect(out).not.toHaveProperty("coverage_duplicates");
  });

  it("non-conforming data passes through", () => {
    const weird = { ok: false, error: "x" };
    expect(shapeFleetAssignments(weird, "trimmed")).toBe(weird);
  });

  it("preserves degraded assignment diagnostics at both payload tiers", () => {
    const degraded = {
      ...data,
      ok: false,
      summary: null,
      agents: [],
      degraded: true,
      degradedLeg: "fleet:assignments",
      degradedReason: "fleet:assignments read exceeded 8000ms",
      retryable: true,
    };
    for (const tier of ["trimmed", "standard"] as const) {
      const out = shapeFleetAssignments(degraded, tier) as Record<string, unknown>;
      expect(out).toMatchObject({
        ok: false,
        degraded: true,
        degradedLeg: "fleet:assignments",
        degradedReason: "fleet:assignments read exceeded 8000ms",
        retryable: true,
        agents: [],
      });
    }
  });

  it("sessionState defaults to null when the wakeability read was unavailable (EI-6077)", () => {
    const noSessionState = { ...data, agents: [agentRow(0, { sessionState: undefined })] };
    const out = shapeFleetAssignments(noSessionState, "trimmed") as {
      agents: Record<string, unknown>[];
    };
    expect(out.agents[0].sessionState).toBeNull();
  });
});

describe("coord:plan-events tier defaults (P-022 — ctx-tier-adaptive, hook-safe)", () => {
  const mkCtx = (contextTier?: string) => ({ contextTier, workspaceId: "ws-pe" });

  async function runPlanEvents(count: number, contextTier?: string, args: Record<string, unknown> = {}) {
    vi.resetModules();
    vi.doMock("../plan-events", () => ({
      readPlanEvents: async () =>
        Array.from({ length: count }, (_, i) => ({
          ts: `2026-07-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
          event: "now_updated",
          detail: "d".repeat(500),
          after: "a".repeat(500),
          plan_slug: `plan-${i}`,
        })),
    }));
    vi.doMock("../../../cache", () => ({
      cachedRead: async (_c: unknown, _o: unknown, factory: () => unknown) => factory(),
    }));
    const tool = (await import("./plan-events")).default;
    const res = (await tool.handler(args as never, mkCtx(contextTier) as never)) as {
      content: { text: string }[];
    };
    return JSON.parse(res.content[0].text) as {
      events: Array<Record<string, unknown>>;
      total: number;
      truncated: boolean;
      payload_tier?: string;
    };
  }

  it("no ctx tier (the OMP hook path) ⇒ full defaults, byte-identical fields", async () => {
    const out = await runPlanEvents(120);
    expect(out.events).toHaveLength(100); // today's default limit
    expect(String(out.events[0].detail)).toHaveLength(500); // no clip
    expect(out.payload_tier).toBeUndefined();
  });

  it("a trimmed session gets the smaller default limit + clipped event texts + a loud marker", async () => {
    const out = await runPlanEvents(120, "trimmed");
    expect(out.events).toHaveLength(30);
    expect(String(out.events[0].detail)).toHaveLength(200); // clipped, ellipsis included
    expect(String(out.events[0].detail).endsWith("…")).toBe(true);
    expect(out.total).toBe(120);
    expect(out.truncated).toBe(true);
    expect(out.payload_tier).toBe("trimmed");
  });

  it("an explicit limit arg beats the tier default", async () => {
    const out = await runPlanEvents(120, "trimmed", { limit: 80 });
    expect(out.events).toHaveLength(80);
  });

  // EI-21510692284064707 recurrence guard: limit:N over an ascending list must
  // keep the NEWEST N (slice(-N)), so the returned max timestamp equals the
  // SOURCE max timestamp — a bounded authority check that kept the oldest tail
  // would silently go stale while claiming `total`/`truncated` honesty.
  it("limit keeps the NEWEST tail — returned max ts equals source max ts", async () => {
    const out = await runPlanEvents(33, "full", { limit: 12 });
    expect(out.total).toBe(33);
    expect(out.truncated).toBe(true);
    expect(out.events).toHaveLength(12);
    // Source rows are i=0..32 ascending; the kept window is i=21..32.
    const slugs = out.events.map((e) => String(e.plan_slug));
    expect(slugs[0]).toBe("plan-21");
    expect(slugs[slugs.length - 1]).toBe("plan-32");
    const maxTs = out.events.map((e) => String(e.ts)).sort().at(-1);
    expect(maxTs).toBe("2026-07-01T00:32:00Z");
  });
});
