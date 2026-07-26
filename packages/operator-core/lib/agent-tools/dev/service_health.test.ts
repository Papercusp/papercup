/**
 * service_health.test.ts — the dev:service_health HANDLER (probeAll mocked). Thin, but
 * pins that the on-demand probe result is surfaced under { ok:true, services }. A
 * regression that drops the services payload is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/dev/service_health.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../service-health", () => ({ probeAll: vi.fn(), supervisedProcesses: vi.fn(() => []) }));
// EI-13221: probeServiceStart shells out to `systemctl`/`ps` — stub it so the
// handler tests never touch the real OS; default "not determinable" (ok:false)
// means the new restart-recency overlay is a no-op unless a test opts in.
vi.mock("./systemd-service-probe", () => ({ probeServiceStart: vi.fn(async () => ({ ok: false })) }));
vi.mock("../../projected-tool-deps", () => ({
  getTelemetryHealth: vi.fn(() => ({
    droppedRows: 2,
    insertErrorCount: 1,
    lastInsertErrorAt: "2026-07-05T15:00:00.000Z",
  })),
}));
// WI-6149: PARTIAL mock. `supervisionSnapshot` is stubbed (it reads the
// reconciler's module singleton), but `isActiveStateDown` must be the REAL
// implementation — it is the shared down-or-not oracle the overlay now calls, and
// stubbing it would let the tool and the reconciler drift apart again, which is
// the precise defect that oracle was extracted to prevent.
vi.mock("../../supervision/unit-reconciler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../supervision/unit-reconciler")>()),
  supervisionSnapshot: vi.fn(() => [
    { name: "mcp-proxy", layer: "systemd-user", autoRestart: true, criticality: "important", consecutiveProbeFailures: 0, lastRestartAt: null, restartsLast10m: 0, flapState: "ok" },
    { name: "substrate-sidecar", layer: "node-child", autoRestart: true, criticality: "important", consecutiveProbeFailures: 0, lastRestartAt: null, restartsLast10m: 0, flapState: "ok" },
    { name: "spawner-sidecar", layer: "node-child", autoRestart: true, criticality: "important", consecutiveProbeFailures: 0, lastRestartAt: null, restartsLast10m: 0, flapState: "ok" },
  ]),
}));
vi.mock("../../sync/hyperbee/substrate-sidecar-spawn", () => ({
  substrateSidecarSupervisionStatus: vi.fn(() => ({ running: true, respawnAttemptsInWindow: 2, gaveUp: false, lastRespawnScheduledAt: 1000 })),
}));
vi.mock("../../fleet/spawner-sidecar-spawn", () => ({
  spawnerSidecarSupervisionStatus: vi.fn(() => ({ running: false, respawnAttemptsInWindow: 5, gaveUp: true, lastRespawnScheduledAt: 2000 })),
}));

import { probeAll } from "../../service-health";
import { getTelemetryHealth } from "../../projected-tool-deps";
import { supervisionSnapshot } from "../../supervision/unit-reconciler";
import { substrateSidecarSupervisionStatus } from "../../sync/hyperbee/substrate-sidecar-spawn";
import { spawnerSidecarSupervisionStatus } from "../../fleet/spawner-sidecar-spawn";
import { buildServiceHealthDiagnostic, overlayNodeChildSupervision, overlaySystemdRestartRecency } from "./service_health";
const probeM = vi.mocked(probeAll);
const supervisionM = vi.mocked(supervisionSnapshot);
const substrateM = vi.mocked(substrateSidecarSupervisionStatus);
const spawnerM = vi.mocked(spawnerSidecarSupervisionStatus);
const tool = (await import("./service_health")).default;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe("dev:service_health handler", () => {
  it("surfaces the probe snapshot under { ok, services }", async () => {
    probeM.mockResolvedValue([
      { name: "operator", up: true, latencyMs: 12 },
      { name: "desktop", present: false },
    ] as never);
    const b = body((await tool.handler({} as never, {} as never)) as Out);
    expect(b).toMatchObject({
      ok: true,
      services: [
        { name: "operator", up: true, latencyMs: 12 },
        { name: "desktop", present: false },
      ],
      telemetry: {
        droppedRows: 2,
        insertErrorCount: 1,
        lastInsertErrorAt: "2026-07-05T15:00:00.000Z",
      },
      supervision: [
        { name: "mcp-proxy", layer: "systemd-user", autoRestart: true, criticality: "important", consecutiveProbeFailures: 0, lastRestartAt: null, restartsLast10m: 0, flapState: "ok" },
        // P-006: the node-child entries get OVERLAID with the sidecars' own respawn
        // status (mocked above) instead of the reconciler's all-zero defaults.
        { name: "substrate-sidecar", layer: "node-child", autoRestart: true, criticality: "important", consecutiveProbeFailures: 0, lastRestartAt: 1000, restartsLast10m: 2, flapState: "damping" },
        { name: "spawner-sidecar", layer: "node-child", autoRestart: true, criticality: "important", consecutiveProbeFailures: 0, lastRestartAt: 2000, restartsLast10m: 5, flapState: "gave-up" },
      ],
      configured: {
        services: ["operator", "desktop"],
        supervised: ["mcp-proxy", "substrate-sidecar", "spawner-sidecar"],
      },
      effective: { up: 1, down: 0, absent: 1, supervisionUnhealthy: 2 },
      rootCause: { component: "substrate-sidecar", reason: "supervisor state damping" },
      nextVerb: "dev:processes",
    });
    expect(getTelemetryHealth).toHaveBeenCalledTimes(1);
  });

  it("P-004: folds the additive supervision block without disturbing the pre-existing { ok, services, telemetry } shape", async () => {
    probeM.mockResolvedValue([{ name: "operator", up: true, latencyMs: 5 }] as never);
    const b = body((await tool.handler({} as never, {} as never)) as Out);
    // Old shape (pre-P-004 consumers) still parses unchanged.
    expect(b.ok).toBe(true);
    expect(b.services).toEqual([{ name: "operator", up: true, latencyMs: 5 }]);
    expect(b.telemetry).toBeDefined();
    // New, additive field.
    expect(supervisionM).toHaveBeenCalledTimes(1);
    expect(substrateM).toHaveBeenCalledTimes(1);
    expect(spawnerM).toHaveBeenCalledTimes(1);
    expect(b.supervision).toHaveLength(3);
  });
});

describe("buildServiceHealthDiagnostic", () => {
  it("names the first down service and the exact sanctioned recovery verb", () => {
    const out = buildServiceHealthDiagnostic(
      [{ name: "bg-host-ticker", up: false, status: null, latencyMs: 2, note: "routine engine stale" }],
      [],
    );
    expect(out.rootCause).toEqual({ component: "bg-host-ticker", reason: "routine engine stale" });
    expect(out.nextVerb).toBe('dev:restart { target:"bg-host" }');
    expect(out.evidence.failures).toHaveLength(1);
  });

  it("treats an intentionally absent desktop as absent, not down", () => {
    const out = buildServiceHealthDiagnostic(
      [{ name: "desktop", up: false, status: null, latencyMs: 1, present: false }],
      [],
    );
    expect(out.effective).toMatchObject({ up: 0, down: 0, absent: 1 });
    expect(out.rootCause).toBeNull();
    expect(out.nextVerb).toBeNull();
  });
});

describe("overlayNodeChildSupervision (P-006, pure)", () => {
  const base = [
    { name: "mcp-proxy", layer: "systemd-user" as const, autoRestart: true, criticality: "important" as const, consecutiveProbeFailures: 1, lastRestartAt: 999, restartsLast10m: 1, flapState: "damping" as const },
    { name: "substrate-sidecar", layer: "node-child" as const, autoRestart: true, criticality: "important" as const, consecutiveProbeFailures: 0, lastRestartAt: null, restartsLast10m: 0, flapState: "ok" as const },
    { name: "spawner-sidecar", layer: "node-child" as const, autoRestart: true, criticality: "important" as const, consecutiveProbeFailures: 0, lastRestartAt: null, restartsLast10m: 0, flapState: "ok" as const },
    { name: "desktop-shell", layer: "desktop-shell" as const, autoRestart: true, criticality: "critical" as const, consecutiveProbeFailures: 0, lastRestartAt: null, restartsLast10m: 0, flapState: "ok" as const },
  ];

  it("leaves non-sidecar entries (systemd-user, desktop-shell) completely untouched", () => {
    const out = overlayNodeChildSupervision(
      base,
      { running: true, respawnAttemptsInWindow: 0, gaveUp: false, lastRespawnScheduledAt: null },
      { running: true, respawnAttemptsInWindow: 0, gaveUp: false, lastRespawnScheduledAt: null },
    );
    expect(out[0]).toEqual(base[0]); // mcp-proxy (systemd-user)
    expect(out[3]).toEqual(base[3]); // desktop-shell
  });

  it("overlays substrate-sidecar and spawner-sidecar from their own respawn status", () => {
    const out = overlayNodeChildSupervision(
      base,
      { running: true, respawnAttemptsInWindow: 3, gaveUp: false, lastRespawnScheduledAt: 5000 },
      { running: false, respawnAttemptsInWindow: 6, gaveUp: true, lastRespawnScheduledAt: 9000 },
    );
    expect(out[1]).toEqual({ ...base[1], consecutiveProbeFailures: 0, lastRestartAt: 5000, restartsLast10m: 3, flapState: "damping" });
    expect(out[2]).toEqual({ ...base[2], consecutiveProbeFailures: 0, lastRestartAt: 9000, restartsLast10m: 6, flapState: "gave-up" });
  });

  it("derives flapState 'ok' when running with zero attempts, 'gave-up' takes priority over a nonzero attempt count", () => {
    const out = overlayNodeChildSupervision(
      [base[1]],
      { running: true, respawnAttemptsInWindow: 4, gaveUp: true, lastRespawnScheduledAt: 1 },
      { running: true, respawnAttemptsInWindow: 0, gaveUp: false, lastRespawnScheduledAt: null },
    );
    expect(out[0].flapState).toBe("gave-up");
  });
});

describe("overlaySystemdRestartRecency (EI-13221, pure given injected probeFn/registry)", () => {
  const stagingEntry = {
    name: "staging-api",
    layer: "systemd-user" as const,
    autoRestart: true,
    criticality: "important" as const,
    consecutiveProbeFailures: 0,
    lastRestartAt: null,
    restartsLast10m: 0,
    flapState: "ok" as const,
  };
  const registry = [{ name: "staging-api", unit: "papercup-staging-api" }];

  it("attaches secondsSinceStart + a recentRestartNote when the unit came up inside the window", async () => {
    const probeFn = vi.fn(async () => ({ ok: true, mainPid: 123, secondsSinceStart: 5, activeState: "active" }));
    const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
    expect(probeFn).toHaveBeenCalledWith("papercup-staging-api");
    expect(out[0]?.secondsSinceStart).toBe(5);
    expect(out[0]?.recentRestartNote).toMatch(/restarted 5s ago/);
    expect(out[0]?.active).toBe(true);
  });

  it("attaches secondsSinceStart WITHOUT a note once outside the recent-restart window", async () => {
    const probeFn = vi.fn(async () => ({ ok: true, mainPid: 123, secondsSinceStart: 600, activeState: "active" }));
    const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
    expect(out[0]?.secondsSinceStart).toBe(600);
    expect(out[0]?.recentRestartNote).toBeUndefined();
    expect(out[0]?.active).toBe(true);
  });

  it("leaves the entry untouched when the probe can't determine anything (fail-soft) — honest 'unknown', never active:false", async () => {
    const probeFn = vi.fn(async () => ({ ok: false }));
    const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
    expect(out[0]).toEqual(stagingEntry);
    expect(out[0]?.active).toBeUndefined();
  });

  it("leaves the entry untouched when the probe throws", async () => {
    const probeFn = vi.fn(async () => {
      throw new Error("systemctl not found");
    });
    const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
    expect(out[0]).toEqual(stagingEntry);
    expect(out[0]?.active).toBeUndefined();
  });

  it("leaves the entry untouched when ok:true but ActiveState itself couldn't be read (defensive edge case)", async () => {
    const probeFn = vi.fn(async () => ({ ok: true, mainPid: 123, secondsSinceStart: 5 }));
    const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
    expect(out[0]).toEqual(stagingEntry);
    expect(out[0]?.active).toBeUndefined();
  });

  it("skips non-systemd-user entries and units missing from the registry", async () => {
    const probeFn = vi.fn(async () => ({ ok: true, mainPid: 1, secondsSinceStart: 1, activeState: "active" }));
    const nodeChild = { ...stagingEntry, name: "substrate-sidecar", layer: "node-child" as const };
    const unregistered = { ...stagingEntry, name: "not-in-registry" };
    const out = await overlaySystemdRestartRecency([nodeChild, unregistered], probeFn, registry);
    expect(probeFn).not.toHaveBeenCalled();
    expect(out).toEqual([nodeChild, unregistered]);
  });

  // EI-18700974567040702: ActiveState (not MainPID) is systemd's DETERMINATE liveness
  // signal — it must be reported explicitly, not dropped alongside a genuine probe failure
  // (previously a stopped unit and "couldn't check" left the entry byte-identical).
  describe("ActiveState reports a determinate up/down, distinct from a probe failure (EI-18700974567040702)", () => {
    it("activeState: 'failed' sets active:false and carries no secondsSinceStart/recentRestartNote", async () => {
      const probeFn = vi.fn(async () => ({ ok: true, mainPid: 0, activeState: "failed" }));
      const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
      expect(out[0]?.active).toBe(false);
      expect(out[0]?.secondsSinceStart).toBeUndefined();
      expect(out[0]?.recentRestartNote).toBeUndefined();
    });

    /**
     * ⚠ RENAMED by WI-6149. This test was called "down is down, regardless of
     * WHY" — and that claim is exactly what item 4 disproved. Conflating
     * `inactive`, `activating` and `failed` into one boolean is what made a
     * healthy hourly oneshot read as "confirmed DOWN" through this very overlay.
     *
     * The raw `active` boolean is UNCHANGED (it still means "ActiveState is
     * literally 'active'"); what is new is that the WHY is now recoverable from
     * `activeState`, and the verdict from `healthy`. For a PERSISTENT unit like
     * staging-api the verdict is still unhealthy — the semantics did not soften,
     * they got a name. (The episodic case is in service-health-unit-coverage.test.ts,
     * where a registry row can carry `episodic`.)
     */
    it("activeState: 'inactive' on a persistent unit is unhealthy, and the WHY is now readable", async () => {
      const probeFn = vi.fn(async () => ({ ok: true, mainPid: 0, activeState: "inactive" }));
      const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
      expect(out[0]?.active).toBe(false);
      expect(out[0]?.activeState).toBe("inactive");
      expect(out[0]?.healthy).toBe(false);
      // and it is DISTINGUISHABLE from the other two states that share active:false
      const [failed] = await overlaySystemdRestartRecency(
        [stagingEntry],
        vi.fn(async () => ({ ok: true, mainPid: 0, activeState: "failed" })),
        registry,
      );
      const [starting] = await overlaySystemdRestartRecency(
        [stagingEntry],
        vi.fn(async () => ({ ok: true, mainPid: 0, activeState: "activating" })),
        registry,
      );
      expect(failed?.activeState).toBe("failed");
      expect(starting?.activeState).toBe("activating");
      // mid-start is NOT a fault — this is where the overlay used to disagree with
      // the reconciler's own isUnitDown.
      expect(starting?.healthy).toBe(true);
      expect(failed?.healthy).toBe(false);
    });

    it("DOWN (activeState:'failed') is distinguishable from a probe failure (ok:false) — different `active` values", async () => {
      const downProbe = vi.fn(async () => ({ ok: true, mainPid: 0, activeState: "failed" }));
      const failedProbe = vi.fn(async () => ({ ok: false }));
      const [down] = await overlaySystemdRestartRecency([stagingEntry], downProbe, registry);
      const [unknown] = await overlaySystemdRestartRecency([stagingEntry], failedProbe, registry);
      expect(down?.active).toBe(false);
      expect(unknown?.active).toBeUndefined();
      expect(down?.active).not.toBe(unknown?.active);
    });

    it("a live mainPid with no measurable secondsSinceStart still reports active:true (up, just couldn't time it)", async () => {
      const probeFn = vi.fn(async () => ({ ok: true, mainPid: 456, activeState: "active" }));
      const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
      expect(out[0]?.active).toBe(true);
      expect(out[0]?.secondsSinceStart).toBeUndefined();
    });

    // The concrete bug this fix kills: a `.timer` unit has NO MainPID concept at all, so a
    // MainPID-keyed liveness read (the old code) would call a healthy, running timer "down".
    it("a .timer unit (no MainPID at all) reports active:true from ActiveState alone — the exact case that motivated this fix", async () => {
      const timerEntry = { ...stagingEntry, name: "live-federation-gate-timer" };
      const timerRegistry = [{ name: "live-federation-gate-timer", unit: "papercup-live-federation-gate.timer" }];
      const probeFn = vi.fn(async () => ({ ok: true, activeState: "active" })); // mainPid omitted — a real .timer probe result
      const out = await overlaySystemdRestartRecency([timerEntry], probeFn, timerRegistry);
      expect(out[0]?.active).toBe(true);
      expect(out[0]?.secondsSinceStart).toBeUndefined();
    });

    it("a .timer unit reports active:false when its ActiveState is genuinely not 'active'", async () => {
      const timerEntry = { ...stagingEntry, name: "live-federation-gate-timer" };
      const timerRegistry = [{ name: "live-federation-gate-timer", unit: "papercup-live-federation-gate.timer" }];
      const probeFn = vi.fn(async () => ({ ok: true, activeState: "inactive" }));
      const out = await overlaySystemdRestartRecency([timerEntry], probeFn, timerRegistry);
      expect(out[0]?.active).toBe(false);
    });
  });
});
