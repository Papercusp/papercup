/**
 * processes:kill — Tier 1 principal-bound tool that calls killProcess(), now a
 * bulk keyed-array tool (bulk-endpoint-standardization-2026-06-21 P-006).
 *
 * Tests stub the lib function to verify the tool projects each result correctly
 * (keyed by pid) and threads the principal slug + workspace into the call. n=1
 * `{ pid }` returns the SAME { ok, results:[…], counts } envelope as `{ pids:[…] }`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function parseEnvelope(result: { content: Array<{ text: string }> }): {
  ok: boolean;
  results: any[];
  counts: { ok: number; failed: number };
} {
  return (result.data);
}

const MAKE_PRINCIPAL_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    principal: {
      kind: 'system',
      slug: 'system:dev-page',
      workspaceId: 'default',
      capabilities: new Set(['processes:kill']),
      authMethod: 'process-internal',
      trust: 'trusted',
    },
    tx: null,
    ...over,
  } as never);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../../process-kill');
});

describe('processes:kill (bulk keyed-array, P-006)', () => {
  it('n=1 { pid }: passes pid + signal + actor + workspace through; one keyed result', async () => {
    const mock = vi.fn(async () => ({ ok: true, pid: 1234, kind: 'omp', signal: 'SIGTERM' }));
    vi.doMock('../../../process-kill', () => ({ killProcess: mock }));
    const { default: tool } = await import('../kill');
    const b = parseEnvelope(await tool.handler({ pid: 1234, signal: 'SIGTERM' }, MAKE_PRINCIPAL_CTX()) as never);
    expect(mock).toHaveBeenCalledWith({
      pid: 1234,
      signal: 'SIGTERM',
      actorSlug: 'system:dev-page',
      workspaceId: 'default',
    });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toEqual({ ok: true, pid: 1234, kind: 'omp', signal: 'SIGTERM' });
  });

  it('forwards a killProcess failure as that item\'s { ok:false, pid, error } (batch ok:true)', async () => {
    vi.doMock('../../../process-kill', () => ({
      killProcess: vi.fn(async () => ({
        ok: false,
        pid: 1234,
        kind: 'paperclip',
        error: 'protected_kind',
        detail: "kind 'paperclip' is in the protected list",
      })),
    }));
    const { default: tool } = await import('../kill');
    const b = parseEnvelope(await tool.handler({ pid: 1234 }, MAKE_PRINCIPAL_CTX()) as never);
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, pid: 1234, error: 'protected_kind' });
  });

  it('omitting signal lets killProcess default to SIGTERM', async () => {
    const mock = vi.fn(async () => ({ ok: true, pid: 1, kind: 'omp', signal: 'SIGTERM' }));
    vi.doMock('../../../process-kill', () => ({ killProcess: mock }));
    const { default: tool } = await import('../kill');
    await tool.handler({ pid: 1 }, MAKE_PRINCIPAL_CTX());
    expect(mock).toHaveBeenCalledWith({
      pid: 1,
      signal: undefined,
      actorSlug: 'system:dev-page',
      workspaceId: 'default',
    });
  });

  it('pids:[…] signals many, each result keyed by pid; one protected pid fails only itself', async () => {
    vi.doMock('../../../process-kill', () => ({
      killProcess: vi.fn(async ({ pid }: { pid: number }) =>
        pid === 99
          ? { ok: false, pid, kind: 'paperclip', error: 'protected_kind' }
          : { ok: true, pid, kind: 'omp', signal: 'SIGTERM' },
      ),
    }));
    const { default: tool } = await import('../kill');
    const b = parseEnvelope(await tool.handler({ pids: [10, 99, 20] }, MAKE_PRINCIPAL_CTX()) as never);
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r) => [r.pid, r.ok])).toEqual([
      [10, true],
      [99, false],
      [20, true],
    ]);
    expect(b.results[1].error).toBe('protected_kind');
  });
});
