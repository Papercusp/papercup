/**
 * harness:configure (WI-1563) — the non-hive counterpart of pot:update's
 * configOverrides half.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'ws-active',
    harnessSlug: 'coding-harness',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  } as never);

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../../harness-registry');
  vi.doUnmock('../../../workspace-registry');
  vi.doUnmock('../../coordination/identity');
});

describe('harness:configure', () => {
  it('merges configOverrides onto an existing non-hive harness and persists', async () => {
    const projects = [
      { slug: 'coding-harness', harness_kind: 'coding', configOverrides: { maxCostUsd: 5 } },
    ];
    const saveHarnessRegistry = vi.fn(async () => {});
    vi.doMock('../../../harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects })),
      saveHarnessRegistry,
    }));
    vi.doMock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));
    vi.doMock('../../coordination/identity', () => ({
      resolveAgentIdentity: () => ({ source: 'principal' }),
    }));

    const { default: tool } = await import('../configure');
    const result = await tool.handler(
      { slug: 'coding-harness', configOverrides: { parallelWorkers: 3 } },
      MAKE_CTX(),
    );
    const payload = parsePayload(result as never);
    expect(payload.ok).toBe(true);
    expect(payload.config).toMatchObject({ maxCostUsd: 5, parallelWorkers: 3 });

    expect(saveHarnessRegistry).toHaveBeenCalledTimes(1);
    const [savedReg] = saveHarnessRegistry.mock.calls[0] as [{ projects: Array<Record<string, unknown>> }];
    expect(savedReg.projects[0].configOverrides).toEqual({ maxCostUsd: 5, parallelWorkers: 3 });
  });

  it('rejects a hive slug — use pot:update instead', async () => {
    const projects = [{ slug: 'my-hive', harness_kind: 'hive' }];
    vi.doMock('../../../harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects })),
      saveHarnessRegistry: vi.fn(),
    }));
    vi.doMock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));
    vi.doMock('../../coordination/identity', () => ({
      resolveAgentIdentity: () => ({ source: 'principal' }),
    }));

    const { default: tool } = await import('../configure');
    const result = await tool.handler(
      { slug: 'my-hive', configOverrides: { maxCostUsd: 5 } },
      MAKE_CTX(),
    );
    const payload = parsePayload(result as never);
    expect(payload).toEqual({
      ok: false,
      error: 'is_a_hive',
      message: "'my-hive' is a hive harness — use pot:update to change its configOverrides instead.",
    });
  });

  it('returns harness_not_found for an unknown slug', async () => {
    vi.doMock('../../../harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
      saveHarnessRegistry: vi.fn(),
    }));
    vi.doMock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));
    vi.doMock('../../coordination/identity', () => ({
      resolveAgentIdentity: () => ({ source: 'principal' }),
    }));

    const { default: tool } = await import('../configure');
    const result = await tool.handler(
      { slug: 'nope', configOverrides: { maxCostUsd: 5 } },
      MAKE_CTX(),
    );
    const payload = parsePayload(result as never);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('harness_not_found');
  });

  it('rejects an empty configOverrides object', async () => {
    vi.doMock('../../../harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
      saveHarnessRegistry: vi.fn(),
    }));
    vi.doMock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));
    vi.doMock('../../coordination/identity', () => ({
      resolveAgentIdentity: () => ({ source: 'principal' }),
    }));

    const { default: tool } = await import('../configure');
    const result = await tool.handler({ slug: 'coding-harness', configOverrides: {} }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({
      ok: false,
      error: 'nothing_to_update',
      message: 'Pass at least one key in `configOverrides`.',
    });
  });

  it('is root-only — rejects a fleet-spawn (bee) caller', async () => {
    vi.doMock('../../../harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
      saveHarnessRegistry: vi.fn(),
    }));
    vi.doMock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));
    vi.doMock('../../coordination/identity', () => ({
      resolveAgentIdentity: () => ({ source: 'fleet-spawn' }),
    }));

    const { default: tool } = await import('../configure');
    const result = await tool.handler(
      { slug: 'coding-harness', configOverrides: { maxCostUsd: 5 } },
      MAKE_CTX(),
    );
    const payload = parsePayload(result as never);
    expect(payload).toEqual({
      ok: false,
      error: 'harness_configure_root_only',
      message:
        'harness:configure cannot be called from a bee (a spawned/parented agent). Only the operator/user edits a harness config.',
    });
  });
});
