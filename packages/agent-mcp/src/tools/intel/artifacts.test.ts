/**
 * intel:artifacts — pure shaping + predicate-arg tests.
 *
 * intel:artifacts is a LEGACY (principal-gated) tool: it has no
 * `requirePrincipal: false`, so the projection wrapper hard-requires
 * `ctx.principal` + `ctx.tx` and passes the handler a legacy ctx whose
 * `tx` is our mock sql template tag. We feed crafted rows through `tx`
 * and capture the bound `${...}` values so we can assert the pure
 * argument-shaping logic WITHOUT a real Postgres:
 *   - the `kind` row classifier: '*.pack' → 'pack', '*.diff' → 'diff',
 *     anything else → 'other'
 *   - `kind` arg default 'all' → BOTH includePack + includeDiff predicates true
 *   - kind='pack' / kind='diff' flip exactly one predicate
 *   - `invokedAtMs` = `new Date(invoked_at).getTime()`
 *   - `sinceMs` default = now − 7 days (bound as the 2nd query value)
 *   - snake→camel field remap + empty-rows envelope
 *
 * The SQL text itself is NOT under test (no live PG) — only the JS
 * shaping that surrounds it.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupByMcpName, dispatchProjectedTool, type UnifiedToolContext } from '@papercusp/tooldef';

// Mock sql template tag standing in for ctx.tx. Records every call's
// interpolated values; returns whatever the test queued.
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
  // Legacy/principal-gated tool: principal + tx are mandatory, and the
  // capability gate checks principal.capabilities, so include 'intel:read'.
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
  const tool = lookupByMcpName('intel:artifacts')!;
  const r = await dispatchProjectedTool(tool, 'intel:artifacts', args, MAKE_CTX(), {});
  expect(r.ok).toBe(true);
  return JSON.parse((r.result!.content[0] as { text: string }).text) as Payload;
}

const ROW = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1,
  plugin_name: 'repomix',
  tool_name: 'repomix.pack',
  role: 'worker',
  feature_id: 'F-1',
  run_id: 'r1',
  spawn_id: 's1',
  invoked_at: new Date('2026-06-01T00:00:00.000Z'),
  duration_ms: 42,
  output_ref: 'ref/abc',
  output_size: 1234,
  ...over,
});

beforeAll(async () => {
  await import('./artifacts');
});

beforeEach(() => {
  lastValues = [];
  nextRows = [];
});

describe('intel:artifacts — registration', () => {
  it('is registered with the intel:read capability', () => {
    const tool = lookupByMcpName('intel:artifacts')!;
    expect(tool).toBeDefined();
    expect(tool.capabilities).toContain('intel:read');
  });
});

describe('intel:artifacts — kind classifier', () => {
  it("classifies a '*.pack' tool_name as kind:'pack'", async () => {
    const out = await call({ harness: 'sheets' }, [ROW({ tool_name: 'repomix.pack' })]);
    expect(out[0].kind).toBe('pack');
    expect(out[0].toolName).toBe('repomix.pack');
  });

  it("classifies a '*.diff' tool_name as kind:'diff'", async () => {
    const out = await call({ harness: 'sheets' }, [ROW({ tool_name: 'code2prompt.diff' })]);
    expect(out[0].kind).toBe('diff');
  });

  it("classifies anything else as kind:'other'", async () => {
    const out = await call({ harness: 'sheets' }, [ROW({ tool_name: 'some.other-tool' })]);
    expect(out[0].kind).toBe('other');
  });
});

describe('intel:artifacts — kind predicates bound to the query', () => {
  // The handler binds includePack + includeDiff as the 3rd + 4th `${}`
  // values: [harness, sinceMs, includePack, includeDiff, limit].
  it("default kind 'all' sets BOTH predicates true", async () => {
    await call({ harness: 'sheets' });
    expect(lastValues[2]).toBe(true); // includePack
    expect(lastValues[3]).toBe(true); // includeDiff
  });

  it("kind 'pack' sets only includePack", async () => {
    await call({ harness: 'sheets', kind: 'pack' });
    expect(lastValues[2]).toBe(true);
    expect(lastValues[3]).toBe(false);
  });

  it("kind 'diff' sets only includeDiff", async () => {
    await call({ harness: 'sheets', kind: 'diff' });
    expect(lastValues[2]).toBe(false);
    expect(lastValues[3]).toBe(true);
  });
});

describe('intel:artifacts — sinceMs default + passthrough', () => {
  it('defaults sinceMs to ~now − 7 days when omitted', async () => {
    const before = Date.now() - 7 * 24 * 60 * 60 * 1000;
    await call({ harness: 'sheets' });
    const after = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const bound = lastValues[1] as number;
    expect(bound).toBeGreaterThanOrEqual(before - 5_000);
    expect(bound).toBeLessThanOrEqual(after + 5_000);
  });

  it('passes an explicit sinceMs straight through', async () => {
    await call({ harness: 'sheets', sinceMs: 1_700_000_000_000 });
    expect(lastValues[1]).toBe(1_700_000_000_000);
  });

  it('binds the limit (default 100) as the last value', async () => {
    await call({ harness: 'sheets' });
    expect(lastValues[4]).toBe(100);
    await call({ harness: 'sheets', limit: 25 });
    expect(lastValues[4]).toBe(25);
  });

  it('binds the harness slug as the first value', async () => {
    await call({ harness: 'my-harness' });
    expect(lastValues[0]).toBe('my-harness');
  });
});

describe('intel:artifacts — row shaping', () => {
  it('remaps snake_case columns to camelCase and converts invoked_at → invokedAtMs', async () => {
    const ts = new Date('2026-06-01T00:00:00.000Z');
    const out = await call({ harness: 'sheets' }, [
      ROW({ invoked_at: ts, plugin_name: 'code2prompt', tool_name: 'code2prompt.diff', output_size: 999 }),
    ]);
    expect(out[0]).toMatchObject({
      id: 1,
      pluginName: 'code2prompt',
      toolName: 'code2prompt.diff',
      role: 'worker',
      featureId: 'F-1',
      runId: 'r1',
      spawnId: 's1',
      invokedAtMs: ts.getTime(),
      durationMs: 42,
      outputRef: 'ref/abc',
      outputSize: 999,
      kind: 'diff',
    });
  });

  it('preserves null feature_id / run_id / duration / output fields', async () => {
    const out = await call({ harness: 'sheets' }, [
      ROW({ feature_id: null, run_id: null, duration_ms: null, output_ref: null, output_size: null }),
    ]);
    expect(out[0].featureId).toBeNull();
    expect(out[0].runId).toBeNull();
    expect(out[0].durationMs).toBeNull();
    expect(out[0].outputRef).toBeNull();
    expect(out[0].outputSize).toBeNull();
  });

  it('empty rows → empty array payload', async () => {
    const out = await call({ harness: 'sheets' }, []);
    expect(out).toEqual([]);
  });
});

describe('intel:artifacts — input validation', () => {
  it('rejects a missing harness arg', async () => {
    const tool = lookupByMcpName('intel:artifacts')!;
    const r = await dispatchProjectedTool(tool, 'intel:artifacts', {}, MAKE_CTX(), {});
    expect(r.ok).toBe(false);
    expect(r.error?.message ?? '').toMatch(/invalid_args|harness|required/i);
  });
});
