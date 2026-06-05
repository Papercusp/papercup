/**
 * processes:kill — Tier 1 principal-bound tool that calls killProcess().
 *
 * Tests stub the lib function to verify the tool projects the result
 * correctly and threads the principal slug + workspace into the call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function parsePayload(result: { data: unknown }): Record<string, unknown> {
  return result.data as Record<string, unknown>;
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

describe('processes:kill', () => {
  it('passes pid + signal + actor + workspace through to killProcess', async () => {
    const mock = vi.fn(async () => ({ ok: true, pid: 1234, kind: 'omp', signal: 'SIGTERM' }));
    vi.doMock('../../../process-kill', () => ({ killProcess: mock }));
    const { default: tool } = await import('../kill');
    const result = await tool.handler({ pid: 1234, signal: 'SIGTERM' }, MAKE_PRINCIPAL_CTX());
    expect(mock).toHaveBeenCalledWith({
      pid: 1234,
      signal: 'SIGTERM',
      actorSlug: 'system:dev-page',
      workspaceId: 'default',
    });
    expect(parsePayload(result as never)).toEqual({
      ok: true,
      pid: 1234,
      kind: 'omp',
      signal: 'SIGTERM',
    });
  });

  it('forwards killProcess error envelope verbatim', async () => {
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
    const result = await tool.handler({ pid: 1234 }, MAKE_PRINCIPAL_CTX());
    const payload = parsePayload(result as never) as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('protected_kind');
  });

  it('omits signal arg lets killProcess default to SIGTERM', async () => {
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
});
