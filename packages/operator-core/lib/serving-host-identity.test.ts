/**
 * WI-1565914 — the serving-host identity must actually reach the
 * `tool_invocations` INSERT, and its NULLs must stay honest.
 *
 * Both halves are things no runtime error would reveal. The telemetry flusher
 * swallows insert errors by design, so a value that never made it into the params
 * looks EXACTLY like a host that could not be identified — a NULL, no error
 * anywhere. And a `serving_build_sha` that quietly fell back to the current
 * checkout's HEAD would look exactly like a correctly-identified one, while
 * asserting something the process cannot prove: that is the precise
 * false-confidence failure these columns exist to end, so it gets a test of its own
 * rather than a comment.
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
  hostIdentity,
  resolveServingHostIdentity,
  getServingHostIdentity,
  _resetServingHostIdentityForTest,
} from './serving-host-identity';

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    workspaceId: 'ws-test',
    harnessSlug: 'papercusp',
    role: 'worker',
    spawnId: 's-serving-host-test',
    log: vi.fn(),
    ...over,
  }) as never;

async function recordAndRead(): Promise<{ sql: string; params: unknown[] }> {
  await PROJECTED_DEPS.recordInvocation!({
    toolName: 'x:probe',
    pluginName: 'agent-mcp',
    ctx: ctx(),
    windowKey: 'w1',
    durationMs: 3,
    status: 'ok',
    args: { a: 1 },
  } as never);
  await flushPendingTelemetry();
  const insert = captured.find((c) => c.sql.includes('INSERT INTO harness_shared.tool_invocations'));
  expect(insert, 'no tool_invocations INSERT was issued').toBeDefined();
  return insert!;
}

describe('hostIdentity — one shared vocabulary', () => {
  it('prefers PAPERCUSP_HONO_PORT, then PORT', () => {
    expect(hostIdentity({ PAPERCUSP_HONO_PORT: '3170', PORT: '3055' } as NodeJS.ProcessEnv, 42)).toBe('port-3170');
    expect(hostIdentity({ PORT: '3070' } as NodeJS.ProcessEnv, 42)).toBe('port-3070');
  });

  it('falls back to a pid label when no port is resolvable', () => {
    expect(hostIdentity({} as NodeJS.ProcessEnv, 4242)).toBe('pid-4242');
  });

  /**
   * The watchdog keys its escalations and coord_event_log condition keys off this
   * SAME string. If the two were computed separately they could drift, and a
   * drifted label cannot be joined — the staleness page and the calls that host
   * actually served would silently stop lining up.
   */
  it('is the identity the stale-routine-executor watchdog uses', async () => {
    const { executorIdentity } = await import('./harness/routines/stale-routine-executor-watchdog');
    expect(executorIdentity()).toBe(hostIdentity());
  });
});

describe('resolveServingHostIdentity — NULL stays honest', () => {
  /**
   * The load-bearing guarantee. `build-info` deliberately reports null for a
   * bundled artifact carrying no baked sha rather than reading the checkout's
   * HEAD; that refusal has to survive this indirection. A plausible-but-unproven
   * sha is worse than no sha, because it is indistinguishable from a real one.
   */
  it('reports a null build sha rather than substituting anything', () => {
    const id = resolveServingHostIdentity({
      env: { PORT: '3070' } as NodeJS.ProcessEnv,
      pid: 7,
      processId: () => 'linux:boot-abc:99',
      buildSha: () => null,
    });
    expect(id.buildSha).toBeNull();
    expect(id.host).toBe('port-3070');
    expect(id.processId).toBe('linux:boot-abc:99');
  });

  it('treats an empty-string sha as unknown, not as a value', () => {
    const id = resolveServingHostIdentity({ buildSha: () => '', processId: () => '' });
    expect(id.buildSha).toBeNull();
    expect(id.processId).toBeNull();
  });

  /** Telemetry is best-effort and must never break a tool call. */
  it('survives a throwing probe on either field', () => {
    const id = resolveServingHostIdentity({
      env: { PORT: '3070' } as NodeJS.ProcessEnv,
      processId: () => {
        throw new Error('proc read failed');
      },
      buildSha: () => {
        throw new Error('git failed');
      },
    });
    expect(id).toEqual({ host: 'port-3070', processId: null, buildSha: null });
  });

  it('caches — the dispatch path pays a property read, not a syscall', () => {
    _resetServingHostIdentityForTest();
    expect(getServingHostIdentity()).toBe(getServingHostIdentity());
  });
});

describe('serving-host identity reaches the tool_invocations INSERT', () => {
  beforeEach(() => {
    captured.length = 0;
  });
  afterEach(async () => {
    await flushPendingTelemetry();
    captured.length = 0;
  });

  it('names all three columns', async () => {
    const insert = await recordAndRead();
    expect(insert.sql).toContain('serving_host');
    expect(insert.sql).toContain('serving_process_id');
    expect(insert.sql).toContain('serving_build_sha');
  });

  /**
   * Adding params without placeholders (or vice versa) shifts EVERY column and
   * breaks all telemetry silently, because the flush swallows the insert error.
   */
  it('keeps placeholders == params', async () => {
    const insert = await recordAndRead();
    const placeholders = new Set(insert.sql.match(/\$\d+/g)).size;
    expect(placeholders).toBe(insert.params.length);
  });

  /**
   * Positional, not just present: the three values must land in the LAST three
   * slots, matching the column list. A value in the wrong slot is the failure the
   * placeholder count above cannot see.
   */
  it('stamps the live identity into the last three params', async () => {
    const insert = await recordAndRead();
    const live = getServingHostIdentity();
    expect(insert.params.slice(-3)).toEqual([live.host, live.processId, live.buildSha]);
    // And the host is a real label, so the column is never uniformly null in
    // practice — an all-null column would make the whole GROUP BY vacuous.
    expect(insert.params.at(-3)).toMatch(/^(port|pid)-/);
  });
});
