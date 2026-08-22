/**
 * EI-19389431406847252 — backfillResultDoorOutputRef unit coverage.
 *
 * The result-door's spill (packages/operator-core/lib/result-door.ts) runs in
 * _mcp-handler.ts's execute(), STRICTLY AFTER runDispatchStack's `finally` has
 * already snapshotted+queued the tool_invocations telemetry row for that call —
 * so the door's spill path never reaches output_ref without this explicit
 * best-effort backfill. This pins: (1) the required-field early return (no PG
 * call at all when workspaceId/spawnId are missing), (2) the happy path issues
 * the expected set_config + correlated UPDATE with the right bind values, and
 * (3) a PG failure is swallowed (never thrown) and logged, matching the rest of
 * this file's telemetry writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('./sync-sse', () => ({
  notifySyncInvalidate: vi.fn(async () => {}),
}));

// Captures every `tx.unsafe(sql, params)` call made inside `sql.begin(fn)`, and
// lets a test flip the resolved tx (or throw) per-case.
const unsafeCalls = vi.hoisted(() => [] as Array<{ sql: string; params: unknown[] }>);
const beginImpl = vi.hoisted(() => ({
  fn: async (cb: (tx: { unsafe: (sql: string, params: unknown[]) => Promise<unknown> }) => Promise<unknown>) => {
    const tx = {
      unsafe: vi.fn(async (sql: string, params: unknown[]) => {
        unsafeCalls.push({ sql, params });
        return [];
      }),
    };
    return cb(tx);
  },
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({
    sql: {
      begin: (cb: (tx: { unsafe: (sql: string, params: unknown[]) => Promise<unknown> }) => Promise<unknown>) =>
        beginImpl.fn(cb),
    },
    db: {
      insert: () => ({ values: vi.fn(async () => {}) }),
    },
  }),
}));

import { backfillResultDoorOutputRef, flushPendingTelemetry } from './projected-tool-deps';

describe('backfillResultDoorOutputRef (EI-19389431406847252)', () => {
  beforeEach(() => {
    unsafeCalls.length = 0;
    beginImpl.fn = async (cb) => {
      const tx = {
        unsafe: vi.fn(async (sql: string, params: unknown[]) => {
          unsafeCalls.push({ sql, params });
          return [];
        }),
      };
      return cb(tx);
    };
  });

  afterEach(async () => {
    await flushPendingTelemetry().catch(() => {});
    vi.clearAllMocks();
  });

  it('is a no-op (no PG call) when workspaceId is missing', async () => {
    await backfillResultDoorOutputRef({
      workspaceId: null,
      spawnId: 's-1',
      toolName: 'x:one',
      outputRef: 'papercusp://scratch/x',
      outputSize: 123,
    });
    expect(unsafeCalls).toHaveLength(0);
  });

  it('is a no-op (no PG call) when spawnId is missing', async () => {
    await backfillResultDoorOutputRef({
      workspaceId: 'ws-test',
      spawnId: undefined,
      toolName: 'x:one',
      outputRef: 'papercusp://scratch/x',
      outputSize: 123,
    });
    expect(unsafeCalls).toHaveLength(0);
  });

  it('issues set_config + a correlated UPDATE with the expected bind values', async () => {
    await backfillResultDoorOutputRef({
      workspaceId: 'ws-test',
      spawnId: 's-test',
      toolName: 'x:one',
      runId: 'run-abc',
      outputRef: 'papercusp://scratch/papercusp-workspace/x:one/result-door-1.md',
      outputSize: 4200,
      metadataJson: { returnedContextBytes: 512, spilledBytes: 4200 },
    });

    expect(unsafeCalls).toHaveLength(2);

    // 1) set_config('app.workspace_id', workspaceId, true)
    expect(unsafeCalls[0].sql).toContain('set_config');
    expect(unsafeCalls[0].params).toEqual(['ws-test']);

    // 2) the correlated UPDATE — outputRef/outputSize first, then the
    //    workspaceId/spawnId/toolName/runId correlation key, in that order.
    expect(unsafeCalls[1].sql).toContain('UPDATE harness_shared.tool_invocations');
    expect(unsafeCalls[1].sql).toContain('output_ref IS NULL');
    expect(unsafeCalls[1].sql).toContain("metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb");
    expect(unsafeCalls[1].params).toEqual([
      'papercusp://scratch/papercusp-workspace/x:one/result-door-1.md',
      4200,
      JSON.stringify({ returnedContextBytes: 512, spilledBytes: 4200 }),
      'ws-test',
      's-test',
      'x:one',
      'run-abc',
    ]);
  });

  it('defaults runId to null when omitted', async () => {
    await backfillResultDoorOutputRef({
      workspaceId: 'ws-test',
      spawnId: 's-test',
      toolName: 'x:two',
      outputRef: 'papercusp://scratch/x',
      outputSize: 1,
    });
    expect(unsafeCalls[1].params[6]).toBeNull();
  });

  it('supports a metadata-only post-door merge when spill persistence failed', async () => {
    await backfillResultDoorOutputRef({
      workspaceId: 'ws-test',
      spawnId: 's-test',
      toolName: 'code:run',
      metadataJson: {
        returnedContextBytes: 600,
        spilledBytes: 0,
        aggregateOutputEscape: true,
      },
    });
    expect(unsafeCalls[1].params.slice(0, 3)).toEqual([
      null,
      null,
      JSON.stringify({ returnedContextBytes: 600, spilledBytes: 0, aggregateOutputEscape: true }),
    ]);
  });

  it('swallows a PG failure and logs a warning instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    beginImpl.fn = async () => {
      throw new Error('backfill UPDATE exploded');
    };

    await expect(
      backfillResultDoorOutputRef({
        workspaceId: 'ws-test',
        spawnId: 's-test',
        toolName: 'x:three',
        outputRef: 'papercusp://scratch/x',
        outputSize: 1,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('backfillResultDoorOutputRef failed for x:three'));
  });
});
