/**
 * cachedRead — the operator-side getOrSet wrapper (cache-expensive-tool-reads-2026-06-22
 * P-001). Exercised against the REAL singleton cache; only the flag backend is stubbed.
 *
 * Covers the five contracts the wrapper standardizes:
 *   - key stability (stableKey is key-order invariant; drops undefined fields)
 *   - workspace-scope (per-ctx isolation; the empty-resolve guard throws)
 *   - tag invalidation (a bumpTags on a tag busts the entry)
 *   - the CACHE_LAYER kill-switch (bypass ⇒ factory runs every call, byte-identical)
 *   - per-tool telemetry (hit/miss/stale/bypass attributed to the tool name)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setFlagOverridesForTest } from "@papercusp/flags/test";
import { getL2Store, installL2StoreForTests, setL2EnabledForTests, __resetL2StateForTests } from "./l2-tier";

import {
  getOperatorCache,
  setOperatorCache,
  resetOperatorCacheForTests,
  _refreshCacheLayerForTests,
} from "./instance";
import {
  cachedRead,
  stableKey,
  resolveCacheWorkspaceId,
  snapshotCachedReadStats,
  resetCachedReadStatsForTests,
  __setCachedReadEnabledForTests,
  DEFAULT_CACHED_READ_HARD_TTL_MS,
} from "./cached-read";

const CACHE_LAYER = "papercusp-cache-layer";

const ctx = (workspaceId: string): { workspaceId: string } => ({ workspaceId });

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true); // opt in: cachedRead bypasses under vitest by default
  setFlagOverridesForTest({ [CACHE_LAYER]: true });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  __setCachedReadEnabledForTests(false);
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  vi.restoreAllMocks();
});

describe("stableKey — deterministic, key-order-stable serialization", () => {
  it("is invariant to object key order", () => {
    expect(stableKey({ a: 1, b: 2, c: 3 })).toBe(
      stableKey({ c: 3, b: 2, a: 1 }),
    );
  });

  it("sorts nested object keys recursively", () => {
    expect(stableKey({ x: { p: 1, q: 2 } })).toBe(
      stableKey({ x: { q: 2, p: 1 } }),
    );
  });

  it("drops undefined object fields (an absent arg == an undefined arg)", () => {
    expect(stableKey({ a: 1, b: undefined })).toBe(stableKey({ a: 1 }));
  });

  it("preserves array order (order is significant for arrays)", () => {
    expect(stableKey([1, 2, 3])).not.toBe(stableKey([3, 2, 1]));
  });

  it("distinguishes different scalar values", () => {
    expect(stableKey({ status: "active" })).not.toBe(
      stableKey({ status: "ready" }),
    );
  });
});

describe("cachedRead — basic caching + key stability", () => {
  it("keeps an own __proto__ argument in the cache identity", async () => {
    const first = JSON.parse('{"nested":{"__proto__":{"view":"first"}},"id":"same"}');
    const second = JSON.parse('{"nested":{"__proto__":{"view":"second"}},"id":"same"}');
    const read = (key: unknown, value: string) => cachedRead(ctx("w1"), {
      tool: "identity", key, tags: [],
    }, () => value);
    expect(await read(first, "first")).toBe("first");
    expect(await read(second, "second")).toBe("second");
    expect(JSON.parse(stableKey(first))).toEqual(first);
    expect(stableKey(first)).not.toBe(stableKey(second));
  });

  it("runs the factory once and serves the cached value on repeat reads", async () => {
    let builds = 0;
    const read = (): Promise<string> =>
      cachedRead(
        ctx("w1"),
        {
          tool: "plans:list",
          key: { status: "active" },
          tags: ["harness_plans"],
        },
        () => {
          builds++;
          return `v${builds}`;
        },
      );
    expect(await read()).toBe("v1");
    expect(await read()).toBe("v1");
    expect(builds).toBe(1);
  });

  it("keys identically regardless of arg object key-order (same entry)", async () => {
    let builds = 0;
    const factory = (): string => `v${++builds}`;
    await cachedRead(
      ctx("w1"),
      { tool: "t", key: { a: 1, b: 2 }, tags: [] },
      factory,
    );
    await cachedRead(
      ctx("w1"),
      { tool: "t", key: { b: 2, a: 1 }, tags: [] },
      factory,
    );
    expect(builds).toBe(1); // second call hit the same entry
  });

  it("a different arg key produces a separate entry (no cross-arg leak)", async () => {
    let builds = 0;
    const factory = (): string => `v${++builds}`;
    const a = await cachedRead(
      ctx("w1"),
      { tool: "t", key: { status: "active" }, tags: [] },
      factory,
    );
    const b = await cachedRead(
      ctx("w1"),
      { tool: "t", key: { status: "ready" }, tags: [] },
      factory,
    );
    expect(a).toBe("v1");
    expect(b).toBe("v2");
    expect(builds).toBe(2);
  });

  it("namespaces by tool — same key under two tools never collides", async () => {
    let builds = 0;
    const factory = (): string => `v${++builds}`;
    const a = await cachedRead(
      ctx("w1"),
      { tool: "plans:list", key: "k", tags: [] },
      factory,
    );
    const b = await cachedRead(
      ctx("w1"),
      { tool: "plans:attention", key: "k", tags: [] },
      factory,
    );
    expect(a).toBe("v1");
    expect(b).toBe("v2");
  });
});

describe("cachedRead — workspace scoping (D-010)", () => {
  it("keeps identical keys independent across ctx workspaces", async () => {
    let builds = 0;
    const factory = (): string => `v${++builds}`;
    const a = await cachedRead(
      ctx("w1"),
      { tool: "t", key: "k", tags: [] },
      factory,
    );
    const b = await cachedRead(
      ctx("w2"),
      { tool: "t", key: "k", tags: [] },
      factory,
    );
    expect(a).toBe("v1");
    expect(b).toBe("v2"); // different workspace ⇒ separate entry
    // and each is independently cached
    expect(
      await cachedRead(ctx("w1"), { tool: "t", key: "k", tags: [] }, factory),
    ).toBe("v1");
    expect(
      await cachedRead(ctx("w2"), { tool: "t", key: "k", tags: [] }, factory),
    ).toBe("v2");
  });

  it("prefers ctx.workspaceId, then principal.workspaceId, then activeWorkspaceId", () => {
    expect(resolveCacheWorkspaceId({ workspaceId: "direct" })).toBe("direct");
    expect(
      resolveCacheWorkspaceId({
        workspaceId: null,
        principal: { workspaceId: "viaPrincipal" },
      }),
    ).toBe("viaPrincipal");
  });

  it("throws when no workspace can be resolved (the cross-workspace guard)", async () => {
    // Force activeWorkspaceId() to return empty so the guard fires.
    const reg = await import("../workspace-registry");
    vi.spyOn(reg, "activeWorkspaceId").mockReturnValue("");
    expect(() =>
      resolveCacheWorkspaceId({ workspaceId: null, principal: null }),
    ).toThrow(/workspace/i);
  });
});

describe("cachedRead — tag invalidation", () => {
  it("a bumpTags on a depended-on table busts the entry (rebuild on next read)", async () => {
    let builds = 0;
    const read = (): Promise<string> =>
      cachedRead(
        ctx("w1"),
        { tool: "plans:list", key: "k", tags: ["harness_plans"] },
        () => `v${++builds}`,
      );
    expect(await read()).toBe("v1");
    expect(await read()).toBe("v1"); // cached
    getOperatorCache().invalidateByTags("w1", ["harness_plans"]); // simulate an ECA bump
    expect(await read()).toBe("v2"); // rebuilt after invalidation
  });

  it("a bump in one workspace does not invalidate another's entry", async () => {
    let builds = 0;
    const read = (w: string): Promise<string> =>
      cachedRead(
        ctx(w),
        { tool: "t", key: "k", tags: ["harness_plans"] },
        () => `v${++builds}`,
      );
    await read("w1");
    await read("w2");
    getOperatorCache().invalidateByTags("w1", ["harness_plans"]);
    expect(await read("w1")).toBe("v3"); // w1 rebuilt
    expect(await read("w2")).toBe("v2"); // w2 untouched
  });
});

describe("cachedRead — stale-while-revalidate (softTtl backstop)", () => {
  it("past softTtl serves the stale value, then revalidates in the background", async () => {
    let now = 1000;
    setOperatorCache({ clock: () => now }); // singleton with an injected clock
    let builds = 0;
    const read = (): Promise<string> =>
      cachedRead(
        ctx("w1"),
        { tool: "t", key: "k", tags: [], softTtlMs: 100 },
        () => `v${++builds}`,
      );

    expect(await read()).toBe("v1"); // miss → build
    now = 1050; // within the soft window
    expect(await read()).toBe("v1"); // fresh hit
    expect(builds).toBe(1);

    now = 1200; // past softTtl (100ms) → serve stale + background rebuild
    expect(await read()).toBe("v1"); // STALE value still served
    await new Promise((r) => setTimeout(r, 0)); // let the bg rebuild settle
    expect(builds).toBe(2); // rebuilt in the background

    expect(await read()).toBe("v2"); // now serves the revalidated value
    expect(snapshotCachedReadStats()["t"]).toMatchObject({ stale: 1 });
  });
});

describe("cachedRead — CACHE_LAYER kill-switch", () => {
  it("flag OFF ⇒ bypass: the factory runs every call, byte-identical to no cache", async () => {
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();
    setOperatorCache(); // rebuild the singleton so it picks up the now-OFF bypass seam

    let builds = 0;
    const read = (): Promise<number> =>
      cachedRead(
        ctx("w1"),
        { tool: "t", key: "k", tags: ["harness_plans"] },
        () => ++builds,
      );
    expect(await read()).toBe(1);
    expect(await read()).toBe(2);
    expect(await read()).toBe(3); // every call ran the factory
    // and every call was attributed as a bypass
    expect(snapshotCachedReadStats()["t"]).toMatchObject({
      bypass: 3,
      hits: 0,
      misses: 0,
    });
  });
});

describe("cachedRead — per-tool telemetry", () => {
  it("attributes hit/miss to the tool name", async () => {
    const read = (): Promise<string> =>
      cachedRead(
        ctx("w1"),
        { tool: "plans:list", key: "k", tags: [] },
        () => "v",
      );
    await read(); // miss (build)
    await read(); // hit
    await read(); // hit
    expect(snapshotCachedReadStats()["plans:list"]).toMatchObject({
      misses: 1,
      hits: 2,
    });
  });

  it("keeps per-tool counters separate", async () => {
    await cachedRead(
      ctx("w1"),
      { tool: "plans:list", key: "k", tags: [] },
      () => "a",
    );
    await cachedRead(
      ctx("w1"),
      { tool: "plans:attention", key: "k", tags: [] },
      () => "b",
    );
    await cachedRead(
      ctx("w1"),
      { tool: "plans:attention", key: "k", tags: [] },
      () => "b",
    );
    const stats = snapshotCachedReadStats();
    expect(stats["plans:list"]).toMatchObject({ misses: 1, hits: 0 });
    expect(stats["plans:attention"]).toMatchObject({ misses: 1, hits: 1 });
  });
});

describe("cachedRead rebuild telemetry", () => {
  it("does not charge an L2 hit as factory work", async () => {
    installL2StoreForTests({
      get: async () => ({ value: "from-l2", tags: [], generation: 0, expiresAt: null }),
    } as unknown as ReturnType<typeof getL2Store>);
    setL2EnabledForTests(true);
    try {
      const factory = vi.fn(() => "rebuilt");
      const value = await cachedRead(ctx("w1"), {
        tool: "measured-l2", key: "key", tags: [], l2: true, softTtlMs: 1000,
      }, factory);
      expect(value).toBe("from-l2");
      expect(factory).not.toHaveBeenCalled();
      expect(snapshotCachedReadStats()["measured-l2"]).toMatchObject({
        misses: 1, missAbsent: 1, l2Hits: 1, builds: 0, buildsCompleted: 0, buildMs: 0,
      });
    } finally {
      __resetL2StateForTests();
    }
  });

  it("attributes invalidation and hard expiry separately from an absent key", async () => {
    let now = 0;
    setOperatorCache({ clock: () => now });
    const opts = { tool: "measured", key: "key", tags: ["rows"], hardTtlMs: 10 };
    await cachedRead(ctx("w1"), opts, () => 1);
    getOperatorCache().invalidateByTag("w1", "rows");
    await cachedRead(ctx("w1"), opts, () => 2);
    now = 11;
    await cachedRead(ctx("w1"), opts, () => 3);
    await cachedRead(ctx("w1"), opts, () => 4);
    expect(snapshotCachedReadStats().measured).toMatchObject({
      misses: 3, hits: 1, missAbsent: 1, missInvalidated: 1, missHardExpired: 1, builds: 3,
    });
  });

  it("counts and times factory work once for joined readers, including failed work", async () => {
    let time = 0;
    vi.spyOn(performance, "now").mockImplementation(() => time);
    let resolve!: (value: number) => void;
    const pending = new Promise<number>((done) => { resolve = done; });
    const opts = { tool: "measured", key: "key", tags: [] };
    const a = cachedRead(ctx("w1"), opts, () => pending);
    const b = cachedRead(ctx("w1"), opts, () => { throw new Error("joined factory must not run"); });
    expect(snapshotCachedReadStats().measured).toMatchObject({ builds: 1, buildsCompleted: 0, buildMs: 0 });
    time = 40;
    resolve(1);
    expect(await Promise.all([a, b])).toEqual([1, 1]);
    expect(await cachedRead(ctx("w1"), opts, () => 2)).toBe(1);
    await expect(cachedRead(ctx("w1"), { ...opts, key: "error" }, () => {
      time = 60;
      throw new Error("failed build");
    })).rejects.toThrow("failed build");
    expect(snapshotCachedReadStats().measured).toMatchObject({
      misses: 3, hits: 1, missAbsent: 3, builds: 2, buildsCompleted: 2, buildErrors: 1, buildMs: 60, maxBuildMs: 40,
    });
  });
});

describe("EI-184 — deadlineMs bounds the caller's wait on a genuinely-blocking build", () => {
  it("a fresh hit resolves immediately regardless of deadlineMs", async () => {
    let builds = 0;
    const read = (): Promise<string> =>
      cachedRead(
        ctx("w1"),
        { tool: "t:deadline-hit", key: "k", tags: [], deadlineMs: 10, onDeadline: () => "DEGRADED" },
        () => `v${++builds}`,
      );
    expect(await read()).toBe("v1"); // miss → build (fast, well under deadline)
    expect(await read()).toBe("v1"); // fresh hit — deadline never relevant
    expect(builds).toBe(1);
    expect(snapshotCachedReadStats()["t:deadline-hit"]).toMatchObject({ deadline: 0 });
  });

  it("a cold-miss build slower than deadlineMs degrades to onDeadline(), and the build still lands in cache for the next caller", async () => {
    let builds = 0;
    let resolveSlow: (() => void) | undefined;
    const factory = (): Promise<string> =>
      new Promise((resolve) => {
        builds++;
        resolveSlow = () => resolve(`slow${builds}`);
      });
    const read = (): Promise<string> =>
      cachedRead(
        ctx("w1"),
        { tool: "t:deadline-slow", key: "k", tags: [], deadlineMs: 20, onDeadline: () => "DEGRADED" },
        factory,
      );
    const p = read();
    expect(await p).toBe("DEGRADED"); // deadline (20ms) fires before the factory resolves
    expect(snapshotCachedReadStats()["t:deadline-slow"]).toMatchObject({ deadline: 1 });
    resolveSlow?.(); // let the background build finish
    await new Promise((r) => setTimeout(r, 0));
    // the build landed in cache — a fresh read now hits it without re-building
    expect(await read()).toBe("slow1");
    expect(builds).toBe(1);
  });

  it("deadlineMs without onDeadline throws (never silently returns undefined)", async () => {
    await expect(
      cachedRead(ctx("w1"), { tool: "t:deadline-missing", key: "k", tags: [], deadlineMs: 10 }, () => "v"),
    ).rejects.toThrow(/onDeadline/);
  });

  it("a factory error still rejects (deadlineMs does not swallow real errors)", async () => {
    await expect(
      cachedRead(
        ctx("w1"),
        { tool: "t:deadline-error", key: "k", tags: [], deadlineMs: 1000, onDeadline: () => "DEGRADED" },
        () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
  });
});

describe("WI-1547 — default hard TTL bounds worst-case staleness", () => {
  // The defect shape: the cache-ECA invalidation rail silently inert in a process
  // (its lazily-SSE-started LISTEN never started), so an SWR entry was served stale
  // at ANY age (a ~45-min-old plans:get snapshot). The default hard TTL is the
  // defense-in-depth bound: past it, the read REBUILDS BLOCKING even when no
  // invalidation ever arrived.
  const OLD = DEFAULT_CACHED_READ_HARD_TTL_MS + 60_000;

  it("an un-invalidated entry past the default hard TTL rebuilds BLOCKING (not a stale serve)", async () => {
    let now = 0;
    setOperatorCache({ clock: () => now });
    let n = 0;
    const f = (): string => `v${++n}`;
    const opts = { tool: "t:hard", key: "k", tags: ["x"], softTtlMs: 45_000 };
    expect(await cachedRead(ctx("w1"), opts, f)).toBe("v1");
    now = OLD; // soft TTL long expired AND past the default hard TTL; no bumpTags ever fired
    // Without the WI-1547 default this would SWR-serve the stale "v1".
    expect(await cachedRead(ctx("w1"), opts, f)).toBe("v2");
  });

  it("an explicit hardTtlMs overrides the default (a long explicit TTL still stale-serves)", async () => {
    let now = 0;
    setOperatorCache({ clock: () => now });
    let n = 0;
    const f = (): string => `v${++n}`;
    const opts = {
      tool: "t:hard-explicit",
      key: "k",
      tags: ["x"],
      softTtlMs: 45_000,
      hardTtlMs: OLD * 10,
    };
    expect(await cachedRead(ctx("w1"), opts, f)).toBe("v1");
    now = OLD; // past the default, but the caller's explicit hard TTL wins
    expect(await cachedRead(ctx("w1"), opts, f)).toBe("v1"); // SWR stale serve
  });

  it("PAPERCUSP_CACHED_READ_HARD_TTL_MS=0 disables the default (opt-out preserved)", async () => {
    vi.stubEnv("PAPERCUSP_CACHED_READ_HARD_TTL_MS", "0");
    try {
      let now = 0;
      setOperatorCache({ clock: () => now });
      let n = 0;
      const f = (): string => `v${++n}`;
      const opts = { tool: "t:hard-off", key: "k", tags: ["x"], softTtlMs: 45_000 };
      expect(await cachedRead(ctx("w1"), opts, f)).toBe("v1");
      now = OLD;
      expect(await cachedRead(ctx("w1"), opts, f)).toBe("v1"); // stale serve — default disabled
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("PAPERCUSP_CACHED_READ_HARD_TTL_MS tunes the bound", async () => {
    vi.stubEnv("PAPERCUSP_CACHED_READ_HARD_TTL_MS", "1000");
    try {
      let now = 0;
      setOperatorCache({ clock: () => now });
      let n = 0;
      const f = (): string => `v${++n}`;
      const opts = { tool: "t:hard-env", key: "k", tags: ["x"] };
      expect(await cachedRead(ctx("w1"), opts, f)).toBe("v1");
      now = 1_500; // past the env bound
      expect(await cachedRead(ctx("w1"), opts, f)).toBe("v2");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
