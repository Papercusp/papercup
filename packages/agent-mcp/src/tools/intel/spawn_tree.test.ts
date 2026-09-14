/**
 * intel:spawn_tree — pure shaping + arg tests.
 *
 * Legacy (principal-gated) tool reading `ctx.tx`. We mock `tx` as a sql
 * template tag, capture the interpolated `${...}` values, and feed
 * crafted rows. The pure logic under test:
 *   - the `status` enum arg: a bad value is rejected by zod (invalid_args)
 *   - `sinceMs` default = now − 24 hours (bound as the 2nd query value)
 *   - optional exact `spawnId` is bound after the limit
 *   - the full snake→camel field remap, including the `depth` and
 *     `root_spawn_id` (→ rootSpawnId) passthrough columns from the view
 *   - empty-rows → empty array envelope
 *
 * SQL semantics aren't exercised (no live PG) — only the JS shaping.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupByMcpName, dispatchProjectedTool, type UnifiedToolContext } from '@papercusp/tooldef';

let lastValues: unknown[] = [];
let nextRows: Array<Record<string, unknown>> = [];
const tx = (_strings: TemplateStringsArray, ...values: unknown[]) => {
  lastValues = values;
  return Promise.resolve(nextRows);
};

const MAKE_CTX = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'ws_1',
  harnessSlug: 'sheets',
  role: 'architect',
  runId: 'run_T',
  spawnId: 'spw_T',
  principal: { slug: 'p1', workspaceId: 'ws_1', capabilities: new Set(['intel:read']) },
  tx,
  ...over,
});

type Payload = Array<Record<string, unknown>>;

async function call(
  args: Record<string, unknown>,
  rows: Array<Record<string, unknown>> = [],
): Promise<Payload> {
  nextRows = rows;
  lastValues = [];
  const tool = lookupByMcpName('intel:spawn_tree')!;
  const r = await dispatchProjectedTool(tool, 'intel:spawn_tree', args, MAKE_CTX(), {});
  expect(r.ok).toBe(true);
  return JSON.parse((r.result!.content[0] as { text: string }).text) as Payload;
}

const ROW = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1,
  tool_name: 'repomix.pack',
  plugin_name: 'repomix',
  role: 'worker',
  feature_id: 'F-1',
  chunk_id: 'ck-1',
  run_id: 'r1',
  spawn_id: 's1',
  parent_spawn_id: null,
  window_key: 'run:r1',
  invoked_at: new Date('2026-06-01T00:00:00.000Z'),
  duration_ms: 42,
  status: 'ok',
  output_ref: 'ref/abc',
  output_size: 1234,
  error_message: null,
  depth: 0,
  root_spawn_id: 's1',
  ...over,
});

beforeAll(async () => {
  await import('./spawn_tree');
});

beforeEach(() => {
  lastValues = [];
  nextRows = [];
});

describe('intel:spawn_tree — registration', () => {
  it('is registered with the intel:read capability', () => {
    const tool = lookupByMcpName('intel:spawn_tree')!;
    expect(tool).toBeDefined();
    expect(tool.capabilities).toContain('intel:read');
  });
});

describe('intel:spawn_tree — status enum arg', () => {
  it('rejects an unknown status value (zod invalid_args)', async () => {
    const tool = lookupByMcpName('intel:spawn_tree')!;
    const r = await dispatchProjectedTool(
      tool,
      'intel:spawn_tree',
      { harness: 'sheets', status: 'bogus' },
      MAKE_CTX(),
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message ?? '').toMatch(/invalid_args|status|enum/i);
  });

  it.each(['ok', 'error', 'timeout', 'quota-exceeded', 'role-not-allowed'])(
    "accepts the valid status %s and binds it to the query",
    async (status) => {
      await call({ harness: 'sheets', status });
      // query values (WI-1671, tool_invocations_spawn_tree_filtered call):
      // [harness, sinceMs, status, limit, spawnId] — status is now a single named
      // function arg (p_status), not duplicated across an `IS NULL OR =` pair.
      expect(lastValues[2]).toBe(status);
    },
  );

  it('binds null for status when omitted (the p_status NULL default branch)', async () => {
    await call({ harness: 'sheets' });
    expect(lastValues[2]).toBeNull();
  });
});

describe('intel:spawn_tree — sinceMs default', () => {
  it('defaults sinceMs to ~now − 24 hours when omitted', async () => {
    const before = Date.now() - 24 * 60 * 60 * 1000;
    await call({ harness: 'sheets' });
    const after = Date.now() - 24 * 60 * 60 * 1000;
    const bound = lastValues[1] as number;
    expect(bound).toBeGreaterThanOrEqual(before - 5_000);
    expect(bound).toBeLessThanOrEqual(after + 5_000);
  });

  it('passes an explicit sinceMs straight through', async () => {
    await call({ harness: 'sheets', sinceMs: 1_700_000_000_000 });
    expect(lastValues[1]).toBe(1_700_000_000_000);
  });

  it('binds the harness slug first, limit fourth, and omitted spawnId last', async () => {
    await call({ harness: 'my-harness' });
    expect(lastValues[0]).toBe('my-harness');
    expect(lastValues[3]).toBe(200);
    expect(lastValues[4]).toBeNull();
  });

  it('accepts an exact spawnId and binds it after the limit', async () => {
    await call({ harness: 'sheets', spawnId: 's-1788197074659-c70affab' });
    expect(lastValues[0]).toBe('sheets');
    expect(lastValues[3]).toBe(200);
    expect(lastValues[4]).toBe('s-1788197074659-c70affab');
  });
});

describe('intel:spawn_tree — row shaping', () => {
  it('remaps every snake_case column to camelCase, incl. depth + root_spawn_id', async () => {
    const ts = new Date('2026-06-01T00:00:00.000Z');
    const out = await call({ harness: 'sheets' }, [
      ROW({ invoked_at: ts, parent_spawn_id: 'parent-1', depth: 2, root_spawn_id: 'root-9', status: 'error', error_message: 'boom' }),
    ]);
    expect(out[0]).toEqual({
      id: 1,
      toolName: 'repomix.pack',
      pluginName: 'repomix',
      role: 'worker',
      featureId: 'F-1',
      chunkId: 'ck-1',
      runId: 'r1',
      spawnId: 's1',
      parentSpawnId: 'parent-1',
      windowKey: 'run:r1',
      invokedAtMs: ts.getTime(),
      durationMs: 42,
      status: 'error',
      outputRef: 'ref/abc',
      outputSize: 1234,
      errorMessage: 'boom',
      depth: 2,
      rootSpawnId: 'root-9',
    });
  });

  it('passes depth + root_spawn_id straight through (forward-compat for Phase 9)', async () => {
    const out = await call({ harness: 'sheets' }, [
      ROW({ depth: 0, root_spawn_id: 's1' }),
      ROW({ id: 2, spawn_id: 's2', parent_spawn_id: 's1', depth: 1, root_spawn_id: 's1' }),
    ]);
    expect(out.map((r) => r.depth)).toEqual([0, 1]);
    expect(out.map((r) => r.rootSpawnId)).toEqual(['s1', 's1']);
  });

  it('empty rows → empty array payload', async () => {
    const out = await call({ harness: 'sheets' }, []);
    expect(out).toEqual([]);
  });
});

describe('intel:spawn_tree — input validation', () => {
  it('rejects a missing harness arg', async () => {
    const tool = lookupByMcpName('intel:spawn_tree')!;
    const r = await dispatchProjectedTool(tool, 'intel:spawn_tree', {}, MAKE_CTX(), {});
    expect(r.ok).toBe(false);
    expect(r.error?.message ?? '').toMatch(/invalid_args|harness|required/i);
  });

  it('rejects a blank or oversized spawnId', async () => {
    const tool = lookupByMcpName('intel:spawn_tree')!;
    for (const spawnId of ['', ' '.repeat(2), 'x'.repeat(257)]) {
      const r = await dispatchProjectedTool(tool, 'intel:spawn_tree', { harness: 'sheets', spawnId }, MAKE_CTX(), {});
      expect(r.ok).toBe(false);
      expect(r.error?.message ?? '').toMatch(/invalid_args|spawnId|spawn/i);
    }
  });
});
