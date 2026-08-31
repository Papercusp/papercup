/**
 * P-009 (unified-agent-state-plane-2026-07-27) — the declaration stamp must
 * actually reach the `tool_invocations` INSERT.
 *
 * The write path is deliberately silent: the flusher swallows insert errors by
 * design (telemetry is best-effort), so a stamp that never made it into the
 * params would look EXACTLY like an agent that declared nothing — three NULLs,
 * no error anywhere. Only asserting the params directly distinguishes them.
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

/**
 * The stamp is keyed off the SAME owner id the dispatcher writes to
 * `coord_owner_id`, so the test has to control it. A synthetic ctx does not
 * resolve to a real agent (resolveAgentIdentity throws → coord_owner_id null),
 * which would leave every stamp legitimately null and the assertions vacuous.
 */
const TEST_OWNER = 'su-stamp-test-owner';
vi.mock('./agent-tools/coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveAgentIdentity: vi.fn(() => ({ ownerId: TEST_OWNER, ownerLabel: 'su · stamp-test' })),
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
import {
  noteIntentDeclared,
  noteAssumptionAsserted,
  noteGoalClaimed,
  resetAgentStateStamps,
} from './agent-state-stamp';

/** Column order in TELEMETRY_INSERT_SQL — the stamp is the last three. */
const P_COORD_OWNER = 24;
const P_INTENT_EVENT = 26;
const P_ASSUMPTION_SET = 27;
const P_GOAL_REF = 28;

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    workspaceId: 'ws-test',
    harnessSlug: 'papercusp',
    role: 'worker',
    spawnId: 's-stamp-test',
    log: vi.fn(),
    ...over,
  }) as never;

function record(toolName: string, over: Record<string, unknown> = {}): Promise<void> | void {
  return PROJECTED_DEPS.recordInvocation!({
    toolName,
    pluginName: 'agent-mcp',
    ctx: ctx(over),
    windowKey: 'w1',
    durationMs: 3,
    status: 'ok',
    args: { a: 1 },
  } as never);
}

async function recordAndRead(): Promise<{ sql: string; params: unknown[] }> {
  await record('x:probe');
  await flushPendingTelemetry();
  const insert = captured.find((c) => c.sql.includes('INSERT INTO harness_shared.tool_invocations'));
  expect(insert, 'no tool_invocations INSERT was issued').toBeDefined();
  return insert!;
}

describe('P-009 declaration stamp on tool_invocations', () => {
  beforeEach(() => {
    captured.length = 0;
    resetAgentStateStamps();
  });
  afterEach(async () => {
    await flushPendingTelemetry();
    captured.length = 0;
    resetAgentStateStamps();
  });

  it('names all three columns and keeps placeholders == params', async () => {
    const insert = await recordAndRead();
    expect(insert.sql).toContain('intent_event_id');
    expect(insert.sql).toContain('assumption_set_id');
    expect(insert.sql).toContain('goal_ref');
    expect(insert.sql).toContain('goal_id');
    expect(insert.sql).toContain('goal_actor_class');
    expect(insert.sql).toContain('harness_shared.agent_modes');
    expect(insert.sql).toContain('harness_shared.session_briefs');
    expect(insert.sql).toContain('harness_shared.fleet_membership_events');
    // Adding params without adding placeholders (or vice versa) breaks ALL
    // telemetry silently, because the flush swallows the insert error.
    const placeholders = new Set(insert.sql.match(/\$\d+/g)).size;
    expect(placeholders).toBe(insert.params.length);
  });

  it('stamps three NULLs for an agent that has declared nothing', async () => {
    // The common case, and the one that must never throw: a cache miss is
    // written as NULL rather than blocking or failing the call.
    const insert = await recordAndRead();
    expect(insert.params[P_INTENT_EVENT]).toBeNull();
    expect(insert.params[P_ASSUMPTION_SET]).toBeNull();
    expect(insert.params[P_GOAL_REF]).toBeNull();
  });

  it('stamps the declared intent, assumption watermark and goal of THIS caller', async () => {
    noteIntentDeclared(TEST_OWNER, 12331);
    noteAssumptionAsserted(TEST_OWNER, 3368);
    noteGoalClaimed(TEST_OWNER, 'WI-6393');

    const insert = await recordAndRead();
    // Guard the premise: if the stamp were keyed off a different id than the one
    // written to coord_owner_id, the assertions below could pass for the wrong
    // reason (or silently go vacuous).
    expect(insert.params[P_COORD_OWNER]).toBe(TEST_OWNER);
    expect(insert.params[P_INTENT_EVENT]).toBe(12331);
    expect(insert.params[P_ASSUMPTION_SET]).toBe(3368);
    expect(insert.params[P_GOAL_REF]).toBe('WI-6393');
  });

  it('does not leak one agent declarations onto another agent calls', async () => {
    // The cache is process-global and shared by every concurrent agent on this
    // host, so a key mix-up would attribute one agent's calls to another's goal
    // — worse than no stamp at all, because it reads as evidence.
    noteGoalClaimed('su-someone-else', 'WI-9999');
    noteIntentDeclared('su-someone-else', 777);
    const insert = await recordAndRead();
    expect(insert.params[P_GOAL_REF]).toBeNull();
    expect(insert.params[P_INTENT_EVENT]).toBeNull();
  });

  it('clears the goal once released, so later calls are not attributed to it', async () => {
    noteGoalClaimed(TEST_OWNER, 'WI-6393');
    expect((await recordAndRead()).params[P_GOAL_REF]).toBe('WI-6393');
    captured.length = 0;

    noteGoalClaimed(TEST_OWNER, null);
    expect((await recordAndRead()).params[P_GOAL_REF]).toBeNull();
  });
});
