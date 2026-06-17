/**
 * decisions.test.ts — operator:decisions, the thin read over the
 * operator_decisions view (decisions.ts). __tests__/misc.test.ts covers the
 * limit-default + envelope; this dedicated file additionally pins the
 * `orderBy(desc(ts))` pass-through (newest-first is the tool's contract) and
 * re-pins the {decisions: rows} envelope shape + the explicit-limit path.
 *
 * The drizzle builder chain is stubbed so the handler is tested in isolation;
 * `desc` is replaced with an identity tag so we can assert it was called with
 * the view's `ts` column and that its result reaches `orderBy`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  }) as never;

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

interface Captured {
  limit: number | null;
  orderByArg: unknown;
  descArg: unknown;
}

async function setupMocks(rowsToReturn: unknown[]): Promise<Captured> {
  const cap: Captured = { limit: null, orderByArg: undefined, descArg: undefined };
  const builder = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockImplementation((arg: unknown) => {
      cap.orderByArg = arg;
      return builder;
    }),
    limit: vi.fn().mockImplementation((n: number) => {
      cap.limit = n;
      return Promise.resolve(rowsToReturn);
    }),
  };
  vi.doMock('drizzle-orm/postgres-js', () => ({ drizzle: vi.fn(() => builder) }));
  // `desc` → identity tag so we can prove it was called with `v.ts` AND that its
  // return value is what `orderBy` receives.
  vi.doMock('drizzle-orm', async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
      ...actual,
      desc: vi.fn((c: unknown) => {
        cap.descArg = c;
        return { __desc: c };
      }),
    };
  });
  vi.doMock('@papercusp/db-org', async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
      ...actual,
      withWorkspace: vi.fn(async (_w: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    };
  });
  vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));
  return cap;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('drizzle-orm/postgres-js');
  vi.doUnmock('drizzle-orm');
  vi.doUnmock('@papercusp/db-org');
  vi.doUnmock('../../workspace-registry');
});

describe('operator:decisions', () => {
  it('wraps rows in the {decisions: rows} envelope', async () => {
    const rows = [{ id: '1', ts: 1234, actor: 'u', action: 'a', target: 't', details: {} }];
    await setupMocks(rows);
    const { default: tool } = await import('./decisions');
    const result = await tool.handler({ limit: 5 }, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual({ decisions: rows });
  });

  it('defaults limit to 50 when none is passed', async () => {
    const cap = await setupMocks([]);
    const { default: tool } = await import('./decisions');
    await tool.handler({}, MAKE_CTX());
    expect(cap.limit).toBe(50);
  });

  it('passes an explicit limit through verbatim', async () => {
    const cap = await setupMocks([]);
    const { default: tool } = await import('./decisions');
    await tool.handler({ limit: 7 }, MAKE_CTX());
    expect(cap.limit).toBe(7);
  });

  it('orders by desc(ts) — desc is called with the view ts column, and its result reaches orderBy', async () => {
    const cap = await setupMocks([]);
    const { generated } = await import('@papercusp/db-org');
    const { default: tool } = await import('./decisions');
    await tool.handler({}, MAKE_CTX());
    // desc() was called with the operator_decisions view's `ts` column (newest-
    // first is the tool's contract). Compare by the column's `name` — drizzle
    // column objects are self-referential, so a reference/deep compare that fails
    // would recurse forever building the diff.
    const tsName = (generated.operatorDecisionsInHarnessShared.ts as { name: string }).name;
    expect(cap.descArg).toBeDefined();
    expect((cap.descArg as { name: string }).name).toBe(tsName);
    // and desc()'s wrapped return is exactly what orderBy received (identity of the
    // captured arg, no column re-import involved):
    expect((cap.orderByArg as { __desc: unknown }).__desc).toBe(cap.descArg);
  });
});
