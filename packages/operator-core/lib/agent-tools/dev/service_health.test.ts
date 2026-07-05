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

import { probeAll } from "../../service-health";
import { getTelemetryHealth } from "../../projected-tool-deps";
const probeM = vi.mocked(probeAll);
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
    });
    expect(getTelemetryHealth).toHaveBeenCalledTimes(1);
  });
});
