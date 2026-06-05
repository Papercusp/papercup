/**
 * Misc tools — autoloop:status/control, snapshots:list/get,
 * wiki:backlinks, omp:config.
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
  } as never);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../autoloop');
  vi.doUnmock('../../snapshot-discovery');
  vi.doUnmock('@papercusp/flags/server');
  vi.doUnmock('../../wiki-backlinks');
  vi.doUnmock('../../omp-config');
});

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('autoloop:status', () => {
  it('returns getAutoLoopState rows', async () => {
    const rows = [{ harness_slug: 's', role: 'r' }];
    vi.doMock('../../autoloop', () => ({
      getAutoLoopState: vi.fn(async () => rows),
      startAutoLoopOnce: vi.fn(),
      stopAutoLoop: vi.fn(),
    }));
    const { default: tool } = await import('../autoloop/status');
    const result = await tool.handler({ harnessSlug: 'sheets' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ harnessSlug: 'sheets', rows });
  });

  it('rejects with precondition_failed when no slug (declarative requires: — D-006)', async () => {
    // The former in-handler `if (!slug) throw` guard is lifted into a
    // `requires:` precondition; the DISPATCHER rejects before the handler runs.
    vi.doMock('../../autoloop', () => ({
      getAutoLoopState: vi.fn(),
      startAutoLoopOnce: vi.fn(),
      stopAutoLoop: vi.fn(),
    }));
    const { default: tool } = await import('../autoloop/status');
    const { lookupByMcpName, dispatchProjectedTool } = await import('@papercusp/tooldef');
    // The tool declares the precondition…
    expect(tool.requires?.[0]?.id).toBe('harness-slug');
    // …and the dispatcher enforces it: no arg, no ctx slug → precondition_failed.
    const projected = lookupByMcpName('autoloop:status');
    expect(projected).toBeDefined();
    const denied = await dispatchProjectedTool(
      projected!,
      'autoloop:status',
      {},
      MAKE_CTX({ harnessSlug: undefined, emit: vi.fn() }),
      {},
    );
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('precondition_failed');
    expect(denied.error?.message).toMatch(/slug required/i);
    // A ctx-scoped slug satisfies it (the handler then runs).
    const allowed = await dispatchProjectedTool(
      projected!,
      'autoloop:status',
      {},
      MAKE_CTX({ emit: vi.fn() }),
      {},
    );
    expect(allowed.ok).toBe(true);
  });
});

describe('autoloop:control', () => {
  it('pause op calls stopAutoLoop', async () => {
    const stopAutoLoop = vi.fn(() => undefined);
    vi.doMock('../../autoloop', () => ({
      getAutoLoopState: vi.fn(),
      startAutoLoopOnce: vi.fn(),
      stopAutoLoop,
    }));
    const { default: tool } = await import('../autoloop/control');
    const result = await tool.handler({ op: 'pause' }, MAKE_CTX({ role: 'operator' }));
    expect(stopAutoLoop).toHaveBeenCalled();
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, op: 'pause' });
  });

  it('resume op calls startAutoLoopOnce', async () => {
    const startAutoLoopOnce = vi.fn(() => undefined);
    vi.doMock('../../autoloop', () => ({
      getAutoLoopState: vi.fn(),
      startAutoLoopOnce,
      stopAutoLoop: vi.fn(),
    }));
    const { default: tool } = await import('../autoloop/control');
    const result = await tool.handler({ op: 'resume' }, MAKE_CTX({ role: 'operator' }));
    expect(startAutoLoopOnce).toHaveBeenCalled();
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, op: 'resume' });
  });

  it('exposes operator-only role gate', async () => {
    vi.doMock('../../autoloop', () => ({
      getAutoLoopState: vi.fn(),
      startAutoLoopOnce: vi.fn(),
      stopAutoLoop: vi.fn(),
    }));
    const { default: tool } = await import('../autoloop/control');
    expect(tool.agentRoles).toEqual(['operator']);
  });
});

describe('snapshots:list', () => {
  it('returns listAllSnapshots output', async () => {
    const snaps = [{ id: 'snap1', slug: 'sheets', version: '0.1.0' }];
    vi.doMock('../../snapshot-discovery', () => ({
      listAllSnapshots: vi.fn(async () => snaps),
      findSnapshot: vi.fn(),
    }));
    // snapshots:* is flag-gated (cut for V1, default-off); enable it so the tool
    // runs its real path instead of returning {ok:false, reason:'feature-disabled'}.
    vi.doMock('@papercusp/flags/server', () => ({ getFlag: async () => true }));
    const { default: tool } = await import('../snapshots/list');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ snapshots: snaps });
  });
});

describe('snapshots:get', () => {
  it('returns found:true with snapshot when match', async () => {
    const snap = { id: 'snap1', slug: 'sheets' };
    vi.doMock('../../snapshot-discovery', () => ({
      listAllSnapshots: vi.fn(),
      findSnapshot: vi.fn(async () => snap),
    }));
    vi.doMock('@papercusp/flags/server', () => ({ getFlag: async () => true }));
    const { default: tool } = await import('../snapshots/get');
    const result = await tool.handler({ id: 'snap1' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ id: 'snap1', found: true, snapshot: snap });
  });

  it('returns found:false on null', async () => {
    vi.doMock('../../snapshot-discovery', () => ({
      listAllSnapshots: vi.fn(),
      findSnapshot: vi.fn(async () => null),
    }));
    vi.doMock('@papercusp/flags/server', () => ({ getFlag: async () => true }));
    const { default: tool } = await import('../snapshots/get');
    const result = await tool.handler({ id: 'missing' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload.found).toBe(false);
  });
});

describe('wiki:backlinks', () => {
  it('forwards target + harness to findWikiBacklinks', async () => {
    const result_fixture = { target: 'doc', harness: null, hits: [] };
    const findWikiBacklinks = vi.fn(async () => result_fixture);
    vi.doMock('../../wiki-backlinks', () => ({ findWikiBacklinks }));
    const { default: tool } = await import('../wiki/backlinks');
    const result = await tool.handler({ target: 'doc' }, MAKE_CTX());
    expect(findWikiBacklinks).toHaveBeenCalledWith('doc', null);
    const payload = parsePayload(result as never);
    expect(payload).toEqual(result_fixture);
  });

  it('passes harness when provided', async () => {
    const findWikiBacklinks = vi.fn(async () => ({ target: '', harness: '', hits: [] }));
    vi.doMock('../../wiki-backlinks', () => ({ findWikiBacklinks }));
    const { default: tool } = await import('../wiki/backlinks');
    await tool.handler({ target: 'd', harness: 'sheets' }, MAKE_CTX());
    expect(findWikiBacklinks).toHaveBeenCalledWith('d', 'sheets');
  });
});

describe('omp:config', () => {
  it('get op returns sections', async () => {
    const sections = [{ name: 's', settings: [] }];
    vi.doMock('../../omp-config', () => ({
      readOmpConfig: vi.fn(async () => sections),
      setOmpConfig: vi.fn(),
      unsetOmpConfig: vi.fn(),
    }));
    const { default: tool } = await import('../omp/config');
    const result = await tool.handler({ op: 'get' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, sections });
  });

  it('set rejects non-operator', async () => {
    vi.doMock('../../omp-config', () => ({
      readOmpConfig: vi.fn(),
      setOmpConfig: vi.fn(),
      unsetOmpConfig: vi.fn(),
    }));
    const { default: tool } = await import('../omp/config');
    await expect(
      tool.handler({ op: 'set', key: 'k', value: 'v' }, MAKE_CTX({ role: 'architect' })),
    ).rejects.toThrow(/operator role/i);
  });

  it('set as operator persists', async () => {
    const setOmpConfig = vi.fn(async () => ({ raw: 'v' }));
    vi.doMock('../../omp-config', () => ({
      readOmpConfig: vi.fn(),
      setOmpConfig,
      unsetOmpConfig: vi.fn(),
    }));
    const { default: tool } = await import('../omp/config');
    const result = await tool.handler(
      { op: 'set', key: 'k', value: 'v' },
      MAKE_CTX({ role: 'operator' }),
    );
    expect(setOmpConfig).toHaveBeenCalledWith('k', 'v');
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, raw: 'v' });
  });

  it('unset op as operator', async () => {
    const unsetOmpConfig = vi.fn(async () => undefined);
    vi.doMock('../../omp-config', () => ({
      readOmpConfig: vi.fn(),
      setOmpConfig: vi.fn(),
      unsetOmpConfig,
    }));
    const { default: tool } = await import('../omp/config');
    const result = await tool.handler(
      { op: 'unset', key: 'k' },
      MAKE_CTX({ role: 'operator' }),
    );
    expect(unsetOmpConfig).toHaveBeenCalledWith('k');
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, unset: true, key: 'k' });
  });
});
