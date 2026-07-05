/**
 * EI-7431 — telemetry flush failures must be visible outside the console.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@papercusp/flags/server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFlag: vi.fn(async () => false),
}));
vi.mock("@papercusp/testing-shell/llm", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOverride: vi.fn(() => undefined),
}));
vi.mock("./decision-ledger/emit", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordDecisionLedger: vi.fn(),
}));
vi.mock("./agent-tools/coordination/dispatch-heartbeat", () => ({
  maybeBeatPresenceOnDispatch: vi.fn(),
}));
vi.mock("./sync-sse", () => ({
  notifySyncInvalidate: vi.fn(async () => {}),
}));

const failingBegin = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("telemetry insert exploded");
  }),
);

vi.mock("@papercusp/db-org", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({
    sql: {
      begin: failingBegin,
    },
    db: {
      insert: () => ({
        values: vi.fn(async () => {}),
      }),
    },
  }),
}));

import {
  __resetTelemetryHealthForTests,
  flushPendingTelemetry,
  getTelemetryHealth,
  PROJECTED_DEPS,
} from "./projected-tool-deps";

const ctx = () =>
  ({
    workspaceId: "ws-test",
    harnessSlug: "papercusp",
    role: "worker",
    spawnId: "s-test",
    log: vi.fn(),
  }) as never;

function record(toolName: string): Promise<void> | void {
  return PROJECTED_DEPS.recordInvocation!({
    toolName,
    pluginName: "agent-mcp",
    ctx: ctx(),
    windowKey: "w1",
    durationMs: 3,
    status: "ok",
    args: { a: 1 },
  } as never);
}

describe("telemetry health counters (EI-7431)", () => {
  beforeEach(() => {
    __resetTelemetryHealthForTests();
    failingBegin.mockClear();
  });

  afterEach(async () => {
    await flushPendingTelemetry().catch(() => {});
    __resetTelemetryHealthForTests();
  });

  it("counts swallowed telemetry insert failures and stamps the last failure time", async () => {
    // WI-2995: the flush path intentionally console.warns on a swallowed
    // insert failure (that's what this test exercises) — spy it so the
    // expected warning doesn't trip vitest's fail-on-console.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(getTelemetryHealth()).toEqual({
      droppedRows: 0,
      insertErrorCount: 0,
      lastInsertErrorAt: null,
    });

    await record("x:one");
    await flushPendingTelemetry();

    const health = getTelemetryHealth();
    expect(failingBegin).toHaveBeenCalledTimes(1);
    expect(health.droppedRows).toBe(0);
    expect(health.insertErrorCount).toBe(1);
    expect(Date.parse(health.lastInsertErrorAt ?? "")).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
  });
});
