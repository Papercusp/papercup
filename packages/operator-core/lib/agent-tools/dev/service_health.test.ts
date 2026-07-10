/**
 * service_health.test.ts — the dev:service_health HANDLER (probeAll mocked). Thin, but
 * pins that the on-demand probe result is surfaced under { ok:true, services }. A
 * regression that drops the services payload is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/dev/service_health.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../service-health", () => ({ probeAll: vi.fn() }));
vi.mock("../../projected-tool-deps", () => ({
  getTelemetryHealth: vi.fn(() => ({
    droppedRows: 2,
    insertErrorCount: 1,
    lastInsertErrorAt: "2026-07-05T15:00:00.000Z",
  })),
}));
vi.mock("../../supervision/unit-reconciler", () => ({
  supervisionSnapshot: vi.fn(() => [
    { name: "mcp-proxy", layer: "systemd-user", autoRestart: true, criticality: "important", consecutiveProbeFailures: 0, lastRestartAt: null, restartsLast10m: 0, flapState: "ok" },
  ]),
}));

import { probeAll } from "../../service-health";
import { getTelemetryHealth } from "../../projected-tool-deps";
import { supervisionSnapshot } from "../../supervision/unit-reconciler";
const probeM = vi.mocked(probeAll);
const supervisionM = vi.mocked(supervisionSnapshot);
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
      ],
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
    expect(b.supervision).toEqual([
      { name: "mcp-proxy", layer: "systemd-user", autoRestart: true, criticality: "important", consecutiveProbeFailures: 0, lastRestartAt: null, restartsLast10m: 0, flapState: "ok" },
    ]);
  });
});
