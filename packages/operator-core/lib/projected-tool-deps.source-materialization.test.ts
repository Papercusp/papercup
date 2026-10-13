/**
 * WI-6554700010010307 — the projection audit record on the tool context must
 * reach `tool_invocations.metadata_json`.
 *
 * The flusher swallows insert errors (telemetry is best-effort), so a record
 * that never made it into the params would look exactly like a call with no
 * projection. Only asserting the INSERT params distinguishes the two.
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
vi.mock('./agent-tools/coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-materialization-test', ownerLabel: 'su · test' })),
}));

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

import { PROJECTED_DEPS, flushPendingTelemetry } from './projected-tool-deps';

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    workspaceId: 'ws-test',
    harnessSlug: 'papercusp',
    role: 'worker',
    spawnId: 's-materialization-test',
    log: vi.fn(),
    ...over,
  }) as never;

/** The metadata_json param, parsed — located by content so column order cannot drift it. */
async function recordAndReadMetadata(over: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  await PROJECTED_DEPS.recordInvocation!({
    toolName: 'x:probe',
    pluginName: 'agent-mcp',
    ctx: ctx(over),
    windowKey: 'w1',
    durationMs: 3,
    status: 'ok',
    args: { a: 1 },
    metadataJson: { handlerField: 'kept' },
  } as never);
  await flushPendingTelemetry();
  const insert = captured.find((c) => c.sql.includes('INSERT INTO harness_shared.tool_invocations'));
  expect(insert, 'no tool_invocations INSERT was issued').toBeDefined();
  const meta = insert!.params.find((p) => typeof p === 'string' && p.includes('handlerField'));
  return typeof meta === 'string' ? (JSON.parse(meta) as Record<string, unknown>) : null;
}

describe('sourceMaterialization reaches tool_invocations.metadata_json', () => {
  beforeEach(() => {
    captured.length = 0;
  });
  afterEach(async () => {
    await flushPendingTelemetry();
    captured.length = 0;
  });

  it('writes the projection audit record beside handler metadata', async () => {
    const record = { trigger: 'projection', pipeOps: ['grep'], promotedToFull: true, structuredSource: false };
    const meta = await recordAndReadMetadata({ sourceMaterialization: record });
    expect(meta).toMatchObject({ handlerField: 'kept', sourceMaterialization: record });
  });

  it('omits the key for a call with no projection', async () => {
    const meta = await recordAndReadMetadata({});
    expect(meta).toMatchObject({ handlerField: 'kept' });
    expect(meta).not.toHaveProperty('sourceMaterialization');
  });
});
