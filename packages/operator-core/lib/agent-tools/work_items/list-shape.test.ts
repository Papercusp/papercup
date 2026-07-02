/**
 * list-shape.test.ts — work_items:list payload-tier shapers
 * (context-trimming-tiers-2026-07-01 P-012).
 *
 * Contract: trimmed/standard rows keep a UNIFORM key set (TOON tabular safe),
 * the payload subtree is flattened to a `plan_ref` string, and a sliced list
 * appends a visible `(truncated)` notice row — never a silent cap (D-004).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/list-shape.test.ts
 */
import { describe, expect, it } from "vitest";
import { shapeWorkItemsList } from "./list";

const row = (i: number) => ({
  id: `WI-${i}`,
  kind: "feature",
  family: "feature",
  harness: "papercusp",
  title: `Task ${i} — ${"t".repeat(200)}`,
  summary: `dup ${"s".repeat(300)}`,
  state: "todo",
  assignee: null,
  assignedBy: null,
  severity: null,
  parent: null,
  payload: {
    plan_item: { item_id: `P-${100 + i}`, plan_slug: "some-plan" },
    other: "x".repeat(400),
  },
  priority: i,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
});

describe("shapeWorkItemsList", () => {
  it("trimmed projects rows to placement essentials with uniform keys", () => {
    const rows = shapeWorkItemsList([row(1), row(2)], "trimmed") as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(2);
    const r = rows[0]!;
    expect(r.id).toBe("WI-1");
    expect(r.plan_ref).toBe("some-plan#P-101");
    expect((r.title as string).length).toBeLessThanOrEqual(90);
    // dropped token sinks
    expect(r.summary).toBeUndefined();
    expect(r.payload).toBeUndefined();
    expect(r.createdAt).toBeUndefined();
    expect(r.family).toBeUndefined();
    // uniform key set across rows (TOON tabular)
    expect(Object.keys(rows[0]!)).toEqual(Object.keys(rows[1]!));
  });

  it("standard keeps a capped summary", () => {
    const rows = shapeWorkItemsList([row(1)], "standard") as Array<
      Record<string, unknown>
    >;
    expect(typeof rows[0]!.summary).toBe("string");
    expect((rows[0]!.summary as string).length).toBeLessThanOrEqual(140);
  });

  it("caps rows loudly with a notice row, never silently", () => {
    const data = Array.from({ length: 60 }, (_, i) => row(i));
    const rows = shapeWorkItemsList(data, "trimmed") as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(41); // 40 + the notice row
    const notice = rows[40]!;
    expect(notice.id).toBe("(truncated)");
    expect(notice.title).toContain("showing 40 of 60");
    expect(Object.keys(notice)).toEqual(Object.keys(rows[0]!));
  });

  it("shrinks the incident-shaped payload substantially", () => {
    const data = Array.from({ length: 40 }, (_, i) => row(i));
    const before = JSON.stringify(data).length;
    const after = JSON.stringify(shapeWorkItemsList(data, "trimmed")).length;
    expect(after).toBeLessThan(before / 4);
  });

  it("passes through junk shapes", () => {
    expect(shapeWorkItemsList(null, "trimmed")).toBeNull();
    expect(shapeWorkItemsList({ not: "array" }, "trimmed")).toEqual({
      not: "array",
    });
  });
});
