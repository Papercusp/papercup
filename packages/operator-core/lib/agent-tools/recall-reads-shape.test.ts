/**
 * recall-reads-shape.test.ts — payload-tier behavior for the recall/survey
 * reads (context-trimming-tiers-2026-07-01 P-024):
 *   - pot:survey — pure `shape` projection ({data}-converted).
 *   - memory:search — in-handler ctx-tier adaptation (byte-stable TUI
 *     contract → hand-rolled JSON kept; shapeMemoryHit is the unit).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/recall-reads-shape.test.ts
 */
import { describe, expect, it } from "vitest";
import { SURVEY_TIER_CAPS, shapePotSurvey } from "./pot/survey-shape";
import { MEMORY_SEARCH_TIER_CAPS, shapeMemoryHit } from "./memory/search";

function ranked(i: number) {
  return {
    id: `WI-${1000 + i}`,
    harness: "papercusp",
    title: `Ranked candidate ${i} with a title long enough to get clipped by the trimmed ninety character cap for sure`,
    importance: "normal",
    score: 12.34,
    why: ["reason one that is fairly long and explains the score in detail beyond sixty chars", "reason two", "reason three"],
    openItems: 3,
  };
}

describe("shapePotSurvey (P-024)", () => {
  const single = {
    ok: true,
    home: "papercusp-hive",
    members: ["papercusp"],
    scope: "hive",
    counts: { plans: 30, frontier: 40, frontierBlocked: 2 },
    plans: Array.from({ length: 20 }, (_, i) => ranked(i)),
    frontier: Array.from({ length: 20 }, (_, i) => ranked(100 + i)),
    ranker: { features: [{ name: "affinity", weight: 2 }] },
  };

  it("caps rows per view, collapses why to the top reason, drops the ranker spec at trimmed", () => {
    const out = shapePotSurvey(single, "trimmed") as Record<string, unknown>;
    const plans = out.plans as Record<string, unknown>[];
    expect(plans).toHaveLength(SURVEY_TIER_CAPS.trimmed.rows + 1); // + notice
    expect(plans.at(-1)!.id).toBe("(truncated)");
    const why = plans[0].why as string[];
    expect(why).toHaveLength(1);
    expect(why[0].length).toBeLessThanOrEqual(SURVEY_TIER_CAPS.trimmed.whyChars);
    expect(out).not.toHaveProperty("ranker");
    expect(String(out.ranker_note)).toContain('payloadTier:"full"');
    expect(out.counts).toEqual(single.counts); // true totals survive
    // standard keeps the ranker + two reasons
    const std = shapePotSurvey(single, "standard") as Record<string, unknown>;
    expect(std.ranker).toEqual(single.ranker);
    expect((std.plans as Record<string, unknown>[])[0].why).toHaveLength(2);
  });

  it("shapes the workspace scope too (crossHive + perHive nodes)", () => {
    const ws = {
      ok: true,
      scope: "workspace",
      hives: ["a", "b"],
      counts: { hives: 2, plans: 25, frontier: 30, frontierBlocked: 0 },
      crossHive: {
        plans: Array.from({ length: 15 }, (_, i) => ranked(i)),
        frontier: Array.from({ length: 15 }, (_, i) => ranked(50 + i)),
      },
      perHive: [
        {
          hive: "a",
          home: "a-hive",
          members: ["a"],
          scope: "hive",
          counts: { plans: 15, frontier: 15, frontierBlocked: 0 },
          plans: Array.from({ length: 15 }, (_, i) => ranked(i)),
          frontier: [],
        },
      ],
      ranker: { features: [] },
    };
    const out = shapePotSurvey(ws, "trimmed") as Record<string, unknown>;
    const cross = out.crossHive as { plans: unknown[] };
    expect(cross.plans).toHaveLength(SURVEY_TIER_CAPS.trimmed.rows + 1);
    const per = (out.perHive as Record<string, unknown>[])[0];
    expect(per.plans as unknown[]).toHaveLength(SURVEY_TIER_CAPS.trimmed.rows + 1);
    expect(per.hive).toBe("a");
  });

  it("error envelopes pass through untouched", () => {
    const err = { ok: false, error: "no_home_harness" };
    expect(shapePotSurvey(err, "trimmed")).toBe(err);
  });
});

describe("shapeMemoryHit (P-024 — memory:search in-handler tier adaptation)", () => {
  const hit = {
    id: "m-1",
    memory: "M".repeat(1_000),
    metadata: { kind: "project", workspace_id: "papercusp", source: "mem0" },
    score: 0.42,
  };

  it("trimmed clips the text loudly and reduces metadata to kind", () => {
    const out = shapeMemoryHit(hit, "trimmed");
    expect(String(out.memory)).toHaveLength(MEMORY_SEARCH_TIER_CAPS.trimmed.text);
    expect(out.memory_truncated).toBe(true);
    expect(out.memory_full_chars).toBe(1_000);
    expect(out.metadata).toEqual({ kind: "project" });
    expect(out.score).toBe(0.42);
  });

  it("standard keeps full metadata with a wider text cap; short hits untouched", () => {
    const out = shapeMemoryHit(hit, "standard");
    expect(String(out.memory)).toHaveLength(MEMORY_SEARCH_TIER_CAPS.standard.text);
    expect(out.metadata).toEqual(hit.metadata);
    const short = shapeMemoryHit({ id: "m-2", memory: "short fact" }, "trimmed");
    expect(short.memory).toBe("short fact");
    expect(short).not.toHaveProperty("memory_truncated");
    expect(short).not.toHaveProperty("metadata");
  });
});
