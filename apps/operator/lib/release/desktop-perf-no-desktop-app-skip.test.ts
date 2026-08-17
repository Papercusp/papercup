/**
 * WI-39672 / cutover-plan D-007: the desktop-perf gate must not hold promotion for a
 * hive that ships NO desktop app.
 *
 * The live incident: `desktop_perf_runs` has NO harness/hive scoping column at all, so
 * `runDesktopPerfGate` reads ONE workspace-global row (workspace_id 'default') and
 * judges EVERY hive's candidate by it. A Papercusp desktop measure recorded
 * `invariant:webview-http-egress = -1` — the UNMEASURABLE sentinel, not a real egress —
 * and the resulting hold froze `main` on sidestage, a hive with no desktop app for that
 * measure to describe.
 *
 * Two properties are asserted here, and they are the FALSIFIABLE PAIR D-007 requires —
 * either one alone is satisfiable by a broken implementation:
 *   1. a hive with no desktop app SKIPS the gate (an inert `pass`), and
 *   2. a hive that DOES ship one still EVALUATES it (the real gate is invoked and its
 *      decision returned unchanged) — i.e. the safety gate is not weakened, only scoped.
 *
 * Fail-CLOSED is asserted separately (case 3): a probe that throws keeps the gate ARMED.
 * Wrongly skipping is fail-OPEN (a real regression ships unjudged); wrongly evaluating
 * only reproduces today's behaviour. This mirrors the WI-6056 asymmetry — "unreadable"
 * must never read as "the hive opts out".
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockRunDesktopPerfGate = vi.fn();

vi.mock("./desktop-perf-gate", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    runDesktopPerfGate: (...args: unknown[]) => mockRunDesktopPerfGate(...args),
    desktopPerfGatePolicyFromFlags: async () => ({ enabled: true, block: false }),
  };
});

const { hiveShipsDesktopApp, realCheckpointDeps } = await import("./green-checkpoint");
const { releaseConfig } = await import("./release-config");

const SHA = "d8cf3aa0c00b1111222233334444555566667777";

function hiveTree(withDesktopApp: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "wi39672-hive-"));
  if (withDesktopApp) mkdirSync(join(root, "papercusp-desktop"));
  return root;
}

describe("hiveShipsDesktopApp (WI-39672 / D-007)", () => {
  it("is FALSE for a hive with no papercusp-desktop directory", () => {
    expect(hiveShipsDesktopApp("/hive", () => false)).toBe(false);
  });

  it("is TRUE for a hive that ships a desktop app", () => {
    const seen: string[] = [];
    const result = hiveShipsDesktopApp("/hive", (p) => {
      seen.push(p);
      return true;
    });
    expect(result).toBe(true);
    expect(seen).toEqual([join("/hive", "papercusp-desktop")]);
  });

  it("FAILS CLOSED — a probe that throws keeps the gate ARMED, never skipped", () => {
    expect(
      hiveShipsDesktopApp("/hive", () => {
        throw new Error("EACCES");
      }),
    ).toBe(true);
  });

  it("FAILS CLOSED on an empty integrationRoot (unknown tree is not an opt-out)", () => {
    expect(hiveShipsDesktopApp("", () => false)).toBe(true);
  });
});

describe("realCheckpointDeps.desktopPerfGate scoping (WI-39672 / D-007)", () => {
  const trees: string[] = [];

  beforeEach(() => {
    mockRunDesktopPerfGate.mockReset();
  });

  afterAll(() => {
    for (const t of trees) rmSync(t, { recursive: true, force: true });
  });

  it("SKIPS the gate for a hive that ships no desktop app — inert pass, real gate never called", async () => {
    const root = hiveTree(false);
    trees.push(root);
    const deps = realCheckpointDeps(releaseConfig({ integrationRoot: root }));

    const decision = await deps.desktopPerfGate!(SHA);

    // `pass` is inert at the call site (green-checkpoint only acts when action !== "pass"),
    // so this neither logs, broadcasts, nor holds promotion. The CheckpointDeps contract
    // narrows the decision to { action, summary } — assert the consumed surface, not the
    // wider internal DesktopPerfGateDecision the real gate happens to return.
    expect(decision.action).toBe("pass");
    expect(decision.summary).toMatch(/no desktop app/i);
    expect(decision.summary).toContain("WI-39672");
    expect(mockRunDesktopPerfGate).not.toHaveBeenCalled();
  });

  it("STILL EVALUATES the gate for a hive that ships a desktop app — decision passed through unchanged", async () => {
    const root = hiveTree(true);
    trees.push(root);
    const armed = {
      action: "block" as const,
      reasons: ["invariant:webview-http-egress"],
      summary: "🚫 desktop-perf-gate: INVARIANT BREACHED",
      verdictStatus: "crit" as const,
      pressure: null,
    };
    mockRunDesktopPerfGate.mockResolvedValue(armed);
    const deps = realCheckpointDeps(releaseConfig({ integrationRoot: root }));

    const decision = await deps.desktopPerfGate!(SHA);

    expect(mockRunDesktopPerfGate).toHaveBeenCalledTimes(1);
    expect(decision).toEqual(armed);
  });
});
