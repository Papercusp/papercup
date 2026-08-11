/**
 * recall-reads-shape.test.ts — payload-tier behavior for the recall reads
 * (context-trimming-tiers-2026-07-01 P-024):
 *   - memory:search — in-handler ctx-tier adaptation (byte-stable TUI
 *     contract → hand-rolled JSON kept; shapeMemoryHit is the unit).
 *
 * ⚠ This file USED TO also cover `pot:survey`'s pure `shape` projection
 * (`shapePotSurvey` / `SURVEY_TIER_CAPS` from `./pot/survey-shape`). Both the
 * tool and that helper were retired by retire-mug-kettle-su-only-2026-08-09
 * P-059 under D-080: `survey-shape.ts`'s only production consumer was the
 * retiring tool, so it went with it rather than being left as dead code with a
 * green test proving the dead code works. Per D-080 a SHARED test is NARROWED
 * to its surviving subjects, never deleted — which is why the memory:search
 * half below is untouched. To restore, see
 * `_retired/mug-kettle-deciders/RESTORE.md`.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/recall-reads-shape.test.ts
 */
import { describe, expect, it } from "vitest";
import { MEMORY_SEARCH_TIER_CAPS, shapeMemoryHit } from "./memory/search";

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
