/**
 * EI-7040 — invoked_at must be the DISPATCH-SETTLE time, stamped per row, not
 * the batch-flush time. The writer is deferred + batched and Postgres now() is
 * transaction-stable, so before the explicit $26 stamp every row in one flush
 * shared a single microsecond timestamp — which (a) skewed time-series reads by
 * up to debounceMs and (b) made batch-mates look like duplicate inserts (the
 * statusline double-call read as "2 identical rows").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Partial mocks (importOriginal) so a mock can never strip a sibling export.
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFlag: vi.fn(async () => false),
}));
vi.mock('@papercusp/testing-shell/llm', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOverride: vi.fn(() => undefined),
}));
vi.mock('./decision-ledger/emit', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordDecisionLedger: vi.fn(),
}));
vi.mock('./agent-tools/coordination/dispatch-heartbeat', () => ({
  maybeBeatPresenceOnDispatch: vi.fn(),
}));

// Capture every tx.unsafe(sql, params) the flush issues.
const captured: Array<{ sql: string; params: unknown[] }> = [];
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({
    sql: {
      begin: async (cb: (tx: unknown) => Promise<void>) =>
        cb({
          unsafe: async (sql: string, params: unknown[]) => {
            captured.push({ sql, params });
          },
        }),
    },
  }),
}));

import { PROJECTED_DEPS } from './projected-tool-deps';
import { flushPendingTelemetry } from './projected-tool-deps';

const ctx = () =>
  ({
    workspaceId: 'ws-test',
    harnessSlug: 'papercusp',
    role: 'worker',
    spawnId: 's-test',
    log: vi.fn(),
  }) as never;

function record(toolName: string): Promise<void> | void {
  return PROJECTED_DEPS.recordInvocation!({
    toolName,
    pluginName: 'agent-mcp',
    ctx: ctx(),
    windowKey: 'w1',
    durationMs: 3,
    status: 'ok',
    args: { a: 1 },
  } as never);
}

describe('telemetry invoked_at stamping (EI-7040)', () => {
  beforeEach(() => {
    captured.length = 0;
  });
  afterEach(async () => {
    await flushPendingTelemetry();
    captured.length = 0;
  });

  it('stamps a per-row dispatch-time invoked_at; placeholder count matches params', async () => {
    const before = Date.now();
    await record('x:one');
    await new Promise((r) => setTimeout(r, 15));
    await record('x:two');
    const after = Date.now();
    await flushPendingTelemetry();

    const inserts = captured.filter((c) => c.sql.includes('INSERT INTO harness_shared.tool_invocations'));
    expect(inserts).toHaveLength(2);
    for (const ins of inserts) {
      // $n placeholder count must match the params array — drift here silently
      // breaks ALL telemetry (the flush swallows insert errors by design).
      const placeholders = new Set(ins.sql.match(/\$\d+/g)).size;
      expect(placeholders).toBe(ins.params.length);
      expect(ins.sql).toContain('invoked_at');
    }
    const [t1, t2] = inserts.map((i) => Date.parse(String(i.params[i.params.length - 1])));
    // Both timestamps are real dispatch-window times…
    expect(t1).toBeGreaterThanOrEqual(before - 5);
    expect(t2).toBeLessThanOrEqual(after + 5);
    // …and they DIFFER (per-row stamping) even though both rows share one flush.
    expect(t2).toBeGreaterThan(t1);
  });
});
