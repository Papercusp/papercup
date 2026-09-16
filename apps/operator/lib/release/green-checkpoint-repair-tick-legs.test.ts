/**
 * P-009 (gate-verdict-liveness-and-repair-reliability-2026-08-31) — repair-tick cheap legs.
 *
 * While a frozen repair queue is `awaiting-fixer`, a cron tick renders NO suite verdict for
 * hours; before P-009, every such hold also stamped `failingTestsMeasured:false`, and the
 * non-test legs (tsc/lint) were structurally invisible to test_runs — the exact staleness
 * that sent agents chasing stale failing names (D-001). These tests pin the two CLI-side
 * halves in `green-checkpoint.ts`:
 *
 *   · `measureRepairTickLegs` — the MEASUREMENT: every registry leg runs (no short-circuit;
 *     a first-failure floor would defeat the point), per-GATE-ID records, and an honest
 *     `null` when results cannot be attributed to the requested head.
 *   · `augmentWithRepairTickLegs` — the ONE choke point downstream of every hold-return
 *     site: attaches the measurement to exactly the `repair-in-progress` + `awaiting-fixer`
 *     result shape, additively and fail-safe.
 *
 * The routine-side consumption (ledger persist + gate_health refresh) is pinned in
 * packages/operator-core/lib/harness/routines/release-actions*.test.ts.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFrozenCandidateQueue } from "@papercusp/operator-core/lib/release/frozen-candidate-repair-queue";
import {
  augmentWithRepairTickLegs,
  checkNpmScript,
  measureRepairTickLegs,
  NON_TEST_GATE_SCRIPTS,
  type CheckpointResult,
  type RepairTickLegs,
} from "./green-checkpoint";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

function makeIo(overrides: Partial<Parameters<typeof measureRepairTickLegs>[0]> = {}) {
  return {
    setupTree: vi.fn(async () => undefined),
    resolveHead: vi.fn(async () => HEAD),
    runScript: vi.fn(async (_script: string) => ({ code: 0, tail: "" })),
    log: vi.fn(),
    now: () => 1_000,
    ...overrides,
  };
}

function awaitingFixerQueue(failingTests: string[] = ["a/one.test.ts"]) {
  return {
    ...createFrozenCandidateQueue({
      candidate: OTHER,
      base: null,
      nowMs: 1_000,
      failingTests,
    }),
    phase: "awaiting-fixer" as const,
    repairHead: HEAD,
  };
}

function holdResult(overrides: Partial<CheckpointResult> = {}): CheckpointResult {
  return {
    advanced: false,
    candidate: OTHER,
    from: null,
    green: null,
    reason: "repair-in-progress",
    summary: "held",
    repairQueue: awaitingFixerQueue(),
    ...overrides,
  };
}

describe("measureRepairTickLegs", () => {
  it("runs EVERY leg with no short-circuit and reports the complete failing set", async () => {
    const runScript = vi.fn(async (script: string) => {
      if (script === "s2a") return { code: 1, tail: "boom" };
      if (script === "s3") throw new Error("spawn failed");
      return { code: 0, tail: "" };
    });
    const io = makeIo({ runScript });
    const measured = await measureRepairTickLegs(io, HEAD, {
      a: ["s1"],
      b: ["s2a", "s2b"],
      c: ["s3"],
    });
    expect(measured).not.toBeNull();
    // Every script ran despite the mid-registry failure AND the throw — a measurement,
    // not a rescue: the value IS the complete failing set.
    expect(runScript.mock.calls.map((c) => c[0])).toEqual(["s1", "s2a", "s2b", "s3"]);
    expect(measured!.legs).toEqual([
      { id: "a", status: "pass", durationMs: 0 },
      { id: "b", status: "fail", durationMs: 0, outputTail: expect.stringContaining("s2a: exit 1") },
      { id: "c", status: "errored", durationMs: 0, outputTail: expect.stringContaining("spawn failed") },
    ]);
    expect(measured!.failingSignatures).toEqual(["b", "c"]);
    expect(measured!.ok).toBe(false);
    expect(measured!.head).toBe(HEAD);
  });

  it("reports ok with no outputTail noise when every leg passes", async () => {
    const io = makeIo();
    const measured = await measureRepairTickLegs(io, HEAD, { a: ["s1"], b: ["s2"] });
    expect(measured).toMatchObject({ ok: true, failingSignatures: [] });
    for (const leg of measured!.legs) {
      expect(leg.status).toBe("pass");
      expect(leg).not.toHaveProperty("outputTail");
    }
  });

  // WI-10001529: the measurement half. A queued `<ws> :: <script>` signature must run IN its
  // workspace and must NOT be filtered by the root-manifest availability pre-check — that
  // check reads the checkout root's package.json, so consulting it for a workspace script
  // returns "absent" and silently skips the one leg whose result can retire the queue.
  it("runs a workspace leg in its workspace, and never pre-checks it against the root manifest", async () => {
    const runScript = vi.fn(async (_script: string, _workspace: string | null) => ({
      code: 1,
      tail: "2 failed",
    }));
    // Would report every workspace script absent, as the real root-manifest check does.
    const scriptAvailability = vi.fn(() => "absent" as const);
    const measured = await measureRepairTickLegs(
      makeIo({ runScript, scriptAvailability }),
      HEAD,
      {
        "lint:tsc": ["lint:tsc"],
        "@papercusp/web :: test": [{ script: "test", workspace: "@papercusp/web" }],
      },
    );

    expect(scriptAvailability).toHaveBeenCalledTimes(1);
    expect(scriptAvailability).toHaveBeenCalledWith("lint:tsc");
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(runScript).toHaveBeenCalledWith("test", "@papercusp/web");
    expect(measured!.legs).toEqual([
      { id: "lint:tsc", status: "skipped", durationMs: 0 },
      {
        id: "@papercusp/web :: test",
        status: "fail",
        durationMs: 0,
        outputTail: "@papercusp/web :: test: exit 1 — 2 failed",
      },
    ]);
    expect(measured!.failingSignatures).toEqual(["@papercusp/web :: test"]);
  });

  it("passes workspace null for a bare root script, so the registry form is unchanged", async () => {
    const runScript = vi.fn(async (_script: string, _workspace: string | null) => ({
      code: 0,
      tail: "",
    }));
    await measureRepairTickLegs(makeIo({ runScript }), HEAD, { a: ["s1"] });
    expect(runScript).toHaveBeenCalledWith("s1", null);
  });

  it("skips absent platform scripts for a subject hive without false failures", async () => {
    const subjectRoot = mkdtempSync(join(tmpdir(), "repair-tick-subject-"));
    try {
      // A repo-less subject hive has ordinary build/typecheck/test scripts but none of
      // Papercusp's platform lint registry. This is the production shape that used to
      // turn every registry id into a false Missing script failure.
      writeFileSync(
        join(subjectRoot, "package.json"),
        JSON.stringify({ scripts: { build: "echo build", typecheck: "echo typecheck", test: "echo test" } }),
      );
      const runScript = vi.fn(async (_script: string) => ({ code: 1, tail: "Missing script" }));
      const measured = await measureRepairTickLegs(
        makeIo({
          runScript,
          scriptAvailability: (script) => checkNpmScript(subjectRoot, script),
        }),
        HEAD,
        {
          "lint:tsc": ["lint:tsc"],
          "lint:identity-leak": ["lint:no-owner-name-tags", "lint:no-box-identity"],
        },
      );

      expect(runScript).not.toHaveBeenCalled();
      expect(measured).toMatchObject({ ok: true, failingSignatures: [] });
      expect(measured?.legs).toEqual([
        { id: "lint:tsc", status: "skipped", durationMs: 0 },
        { id: "lint:identity-leak", status: "skipped", durationMs: 0 },
      ]);
    } finally {
      rmSync(subjectRoot, { recursive: true, force: true });
    }
  });

  it("still measures declared scripts when a registry id mixes absent and present scripts", async () => {
    const runScript = vi.fn(async (script: string) =>
      script === "real-fail" ? { code: 1, tail: "boom" } : { code: 0, tail: "" },
    );
    const scriptAvailability = vi.fn((script: string) =>
      script === "optional" ? ("absent" as const) : ("present" as const),
    );
    const measured = await measureRepairTickLegs(
      makeIo({ runScript, scriptAvailability }),
      HEAD,
      { gate: ["optional", "real-fail"] },
    );

    expect(runScript.mock.calls.map(([script]) => script)).toEqual(["real-fail"]);
    expect(measured?.legs).toEqual([
      { id: "gate", status: "fail", durationMs: 0, outputTail: "real-fail: exit 1 — boom" },
    ]);
    expect(measured?.failingSignatures).toEqual(["gate"]);
  });

  it("fails closed when the subject package metadata is unreadable", async () => {
    const runScript = vi.fn(async (_script: string) => ({ code: 0, tail: "" }));
    const measured = await measureRepairTickLegs(
      makeIo({ runScript, scriptAvailability: vi.fn(() => "unreadable" as const) }),
      HEAD,
      { gate: ["lint:tsc"] },
    );

    expect(runScript).not.toHaveBeenCalled();
    expect(measured?.legs).toEqual([
      { id: "gate", status: "errored", durationMs: 0, outputTail: "lint:tsc: package.json unreadable" },
    ]);
    expect(measured?.failingSignatures).toEqual(["gate"]);
    expect(measured?.ok).toBe(false);
  });

  it("returns null on a head mismatch — results must never be attributed to a sha the tree is not at", async () => {
    const io = makeIo({ resolveHead: vi.fn(async () => OTHER) });
    const measured = await measureRepairTickLegs(io, HEAD, { a: ["s1"] });
    expect(measured).toBeNull();
    expect(io.runScript).not.toHaveBeenCalled();
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining("head mismatch"));
  });

  it("returns null when setup fails, without running any script", async () => {
    const io = makeIo({
      setupTree: vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    });
    const measured = await measureRepairTickLegs(io, HEAD, { a: ["s1"] });
    expect(measured).toBeNull();
    expect(io.runScript).not.toHaveBeenCalled();
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining("setup failed"));
  });
});

describe("augmentWithRepairTickLegs", () => {
  const measured: RepairTickLegs = {
    head: HEAD,
    atMs: 1_000,
    ok: false,
    failingSignatures: ["lint:tsc"],
    legs: [{ id: "lint:tsc", status: "fail", durationMs: 5 }],
  };

  it("attaches the measurement on an awaiting-fixer repair hold, asking for the full registry at repairHead", async () => {
    const runRepairTickLegs = vi.fn(async () => measured);
    const log = vi.fn();
    const result = await augmentWithRepairTickLegs(holdResult(), { runRepairTickLegs, log });
    // A failing TEST FILE is the fixer's subject, not a cheap leg, so the asked-for set is
    // exactly the registry — this hold's queue holds `a/one.test.ts` and nothing re-runnable.
    expect(runRepairTickLegs).toHaveBeenCalledWith(HEAD, Object.keys(NON_TEST_GATE_SCRIPTS));
    expect(result.repairTickLegs).toEqual(measured);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("FAILING lint:tsc"));
  });

  // WI-10001529: the deadlock. The tick asked for the static registry ONLY, so a queued
  // workspace-task signature was never re-measured, `queue.failingTests` never lost it, and
  // the dispatch guard's signature comparison could never converge — an awaiting-fixer hold
  // that no fix to the subject could clear.
  it("also asks for a queued workspace-task signature — the only thing that can retire it", async () => {
    const runRepairTickLegs = vi.fn(async (_ref: string, _gateIds: readonly string[]) => measured);
    const queue = awaitingFixerQueue(["@papercusp/web :: test", "a/one.test.ts"]);
    expect(queue.failingTests).toContain("@papercusp/web :: test");
    await augmentWithRepairTickLegs(holdResult({ repairQueue: queue }), {
      runRepairTickLegs,
      log: vi.fn(),
    });
    const askedFor = runRepairTickLegs.mock.calls[0][1];
    expect(askedFor).toContain("@papercusp/web :: test");
    // Still the whole registry, and still no failing test FILE.
    expect(askedFor).toEqual(
      expect.arrayContaining(Object.keys(NON_TEST_GATE_SCRIPTS)),
    );
    expect(askedFor).not.toContain("a/one.test.ts");
  });

  it("asks for a queued signature exactly once even when it is already a registry id", async () => {
    const runRepairTickLegs = vi.fn(async (_ref: string, _gateIds: readonly string[]) => measured);
    const queue = awaitingFixerQueue(["lint:tsc"]);
    await augmentWithRepairTickLegs(holdResult({ repairQueue: queue }), {
      runRepairTickLegs,
      log: vi.fn(),
    });
    const askedFor = runRepairTickLegs.mock.calls[0][1];
    expect(askedFor.filter((id) => id === "lint:tsc")).toHaveLength(1);
  });

  it("does nothing for a non-hold reason", async () => {
    const runRepairTickLegs = vi.fn(async () => measured);
    const base = holdResult({ reason: "not-green", green: false });
    const result = await augmentWithRepairTickLegs(base, { runRepairTickLegs, log: vi.fn() });
    expect(runRepairTickLegs).not.toHaveBeenCalled();
    expect(result).toBe(base);
  });

  it("does nothing when the queue is past awaiting-fixer (verification owns the next measurement)", async () => {
    const runRepairTickLegs = vi.fn(async () => measured);
    const queue = { ...awaitingFixerQueue(), phase: "ready-to-verify" as const };
    const base = holdResult({ repairQueue: queue });
    const result = await augmentWithRepairTickLegs(base, { runRepairTickLegs, log: vi.fn() });
    expect(runRepairTickLegs).not.toHaveBeenCalled();
    expect(result).toBe(base);
  });

  it("does nothing when the dep is absent (stubs/older deps keep exact current behaviour)", async () => {
    const base = holdResult();
    const result = await augmentWithRepairTickLegs(base, { log: vi.fn() });
    expect(result).toBe(base);
    expect(result.repairTickLegs).toBeUndefined();
  });

  it("measures exactly once per tick — an auto-refire re-entry must not re-measure", async () => {
    const runRepairTickLegs = vi.fn(async () => measured);
    const base = holdResult({ repairTickLegs: measured });
    const result = await augmentWithRepairTickLegs(base, { runRepairTickLegs, log: vi.fn() });
    expect(runRepairTickLegs).not.toHaveBeenCalled();
    expect(result).toBe(base);
  });

  it("leaves the result untouched when the measurement is null (unmeasured, never green)", async () => {
    const runRepairTickLegs = vi.fn(async () => null);
    const base = holdResult();
    const result = await augmentWithRepairTickLegs(base, { runRepairTickLegs, log: vi.fn() });
    expect(result).toBe(base);
    expect(result.repairTickLegs).toBeUndefined();
  });

  it("swallows a thrown measurement — the hold verdict must never break on a leg run", async () => {
    const runRepairTickLegs = vi.fn(async () => {
      throw new Error("worktree busy");
    });
    const log = vi.fn();
    const base = holdResult();
    const result = await augmentWithRepairTickLegs(base, { runRepairTickLegs, log });
    expect(result).toBe(base);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("measurement failed"));
  });
});
