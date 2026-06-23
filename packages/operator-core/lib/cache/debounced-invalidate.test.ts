/**
 * Coarse/debounced invalidation for the append-heavy log family
 * (cache-expensive-tool-reads-2026-06-22 P-008 / D-006). Deterministic via an
 * injected scheduler + a recording fake Cache — no real timers.
 */
import { describe, it, expect } from "vitest";
import type { Cache } from "@papercusp/cache";
import {
  TagBumpDebouncer,
  coalescedInvalidateByTags,
  isAppendHeavyTag,
  tableOfTag,
  setTagBumpDebouncerForTests,
  APPEND_HEAVY_TABLES,
  type DebounceScheduler,
} from "./debounced-invalidate";

/** A recording fake Cache — only invalidateByTags is exercised. */
function fakeCache(): {
  cache: Cache;
  bumps: Array<{ ws: string; tags: readonly string[] }>;
} {
  const bumps: Array<{ ws: string; tags: readonly string[] }> = [];
  const cache = {
    invalidateByTags: (ws: string, tags: readonly string[]) =>
      bumps.push({ ws, tags: [...tags] }),
  } as unknown as Cache;
  return { cache, bumps };
}

/** A manual scheduler — captures the pending callback so a test fires the window end on demand. */
function manualScheduler(): {
  sched: DebounceScheduler;
  fireAll: () => void;
  pending: number;
} {
  const cbs = new Map<number, () => void>();
  let next = 1;
  const api = {
    sched: {
      setTimer: (fn: () => void) => {
        const id = next++;
        cbs.set(id, fn);
        return id;
      },
      clearTimer: (h: unknown) => cbs.delete(h as number),
    } as DebounceScheduler,
    fireAll: () => {
      const snapshot = [...cbs.entries()];
      cbs.clear();
      for (const [, fn] of snapshot) fn();
    },
    get pending() {
      return cbs.size;
    },
  };
  return api;
}

describe("append-heavy classification", () => {
  it("recognizes the log family by table + row tag", () => {
    expect(isAppendHeavyTag("coord_event_log")).toBe(true);
    expect(isAppendHeavyTag("coord_event_log:abc")).toBe(true);
    expect(isAppendHeavyTag("harness_plans")).toBe(false);
    expect(isAppendHeavyTag("harness_features_consolidated:WI-1")).toBe(false);
    expect(tableOfTag("coord_event_log:abc")).toBe("coord_event_log");
    expect(APPEND_HEAVY_TABLES.has("audit_log")).toBe(true);
  });
});

describe("TagBumpDebouncer — leading + trailing", () => {
  it("leading edge fires immediately; a burst within the window coalesces to ONE trailing bump", () => {
    const { cache, bumps } = fakeCache();
    const m = manualScheduler();
    const deb = new TagBumpDebouncer({ scheduler: m.sched });

    deb.bump(cache, "w1", "coord_event_log"); // leading → immediate
    expect(bumps.length).toBe(1);
    // 5 more bumps inside the window → all coalesced (no immediate bump)
    for (let i = 0; i < 5; i++) deb.bump(cache, "w1", "coord_event_log");
    expect(bumps.length).toBe(1);

    m.fireAll(); // window end → trailing flush (there was activity)
    expect(bumps.length).toBe(2);

    m.fireAll(); // next window end → quiet → no bump, window closes
    expect(bumps.length).toBe(2);
    expect(m.pending).toBe(0);
  });

  it("a quiet gap re-arms the leading edge (next bump fires immediately)", () => {
    const { cache, bumps } = fakeCache();
    const m = manualScheduler();
    const deb = new TagBumpDebouncer({ scheduler: m.sched });

    deb.bump(cache, "w1", "coord_event_log"); // leading
    m.fireAll(); // quiet window → closes (1 bump total)
    expect(bumps.length).toBe(1);

    deb.bump(cache, "w1", "coord_event_log"); // window re-armed → leading again
    expect(bumps.length).toBe(2);
  });

  it("keys are per (workspace, tag) — independent windows", () => {
    const { cache, bumps } = fakeCache();
    const m = manualScheduler();
    const deb = new TagBumpDebouncer({ scheduler: m.sched });
    deb.bump(cache, "w1", "coord_event_log"); // leading w1
    deb.bump(cache, "w2", "coord_event_log"); // leading w2 (separate)
    expect(bumps.length).toBe(2);
    expect(bumps.map((b) => b.ws).sort()).toEqual(["w1", "w2"]);
  });
});

describe("coalescedInvalidateByTags — routing", () => {
  it("bumps non-append-heavy tags immediately and debounces the append-heavy table tag", () => {
    const { cache, bumps } = fakeCache();
    const m = manualScheduler();
    setTagBumpDebouncerForTests(new TagBumpDebouncer({ scheduler: m.sched }));
    try {
      coalescedInvalidateByTags(cache, "w1", [
        "harness_plans",
        "harness_plans:PL-7",
        "coord_event_log",
        "coord_event_log:evt9",
      ]);
      // immediate: the two harness_plans tags in ONE call; debounced: the coord_event_log
      // TABLE tag (leading edge), and the coord_event_log:evt9 ROW tag is DROPPED.
      const immediate = bumps.find((b) => b.tags.includes("harness_plans"));
      expect(immediate?.tags).toEqual(["harness_plans", "harness_plans:PL-7"]);
      const debounced = bumps.find((b) => b.tags.includes("coord_event_log"));
      expect(debounced?.tags).toEqual(["coord_event_log"]); // table only, no :evt9 row tag
      expect(
        bumps.some((b) => b.tags.some((t) => t.startsWith("coord_event_log:"))),
      ).toBe(false);
    } finally {
      setTagBumpDebouncerForTests(null);
    }
  });

  it("a storm of coord_event_log changes collapses to ~one bump per window", () => {
    const { cache, bumps } = fakeCache();
    const m = manualScheduler();
    setTagBumpDebouncerForTests(new TagBumpDebouncer({ scheduler: m.sched }));
    try {
      for (let i = 0; i < 100; i++) {
        coalescedInvalidateByTags(cache, "w1", [
          "coord_event_log",
          `coord_event_log:e${i}`,
        ]);
      }
      expect(bumps.length).toBe(1); // 100 events → 1 leading bump
      m.fireAll();
      expect(bumps.length).toBe(2); // + 1 trailing flush for the burst
    } finally {
      setTagBumpDebouncerForTests(null);
    }
  });
});
