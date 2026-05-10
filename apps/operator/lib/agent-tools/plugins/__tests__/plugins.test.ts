/**
 * plugins:* tools — runtime_status, invoke_action, fire_event.
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
  vi.doUnmock('@/lib/plugin-host-runtime');
  vi.doUnmock('@/lib/harness-registry');
});

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('plugins:runtime_status', () => {
  it('returns pluginHostStatus output', async () => {
    const status = { loaded: 18, errors: 4, plugins: [] };
    vi.doMock('@/lib/plugin-host-runtime', () => ({
      pluginHostStatus: vi.fn(async () => status),
      invokePluginAction: vi.fn(),
      firePluginEvent: vi.fn(),
      firePluginLifecycle: vi.fn(),
    }));
    const { default: tool } = await import('@/lib/agent-tools/plugins/runtime_status');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual(status);
  });
});

describe('plugins:invoke_action', () => {
  it('forwards plugin/action/slug + ctx-built dirs to invokePluginAction', async () => {
    const invokePluginAction = vi.fn(async () => ({ ok: true, result: 'x' }));
    vi.doMock('@/lib/plugin-host-runtime', () => ({
      pluginHostStatus: vi.fn(),
      invokePluginAction,
      firePluginEvent: vi.fn(),
      firePluginLifecycle: vi.fn(),
    }));
    vi.doMock('@/lib/harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [{ slug: 'sheets', path: '/tmp/sheets' }],
      })),
    }));
    const { default: tool } = await import('@/lib/agent-tools/plugins/invoke_action');
    const result = await tool.handler(
      { plugin: '@papercupai/repomix', action: 'pack', slug: 'sheets', params: { x: 1 } },
      MAKE_CTX(),
    );
    expect(invokePluginAction).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginName: '@papercupai/repomix',
        actionName: 'pack',
        installSlug: 'sheets',
        projectDir: '/tmp/sheets',
        stateDir: '/tmp/sheets/.harness',
        params: { x: 1 },
      }),
    );
    const payload = parsePayload(result as never);
    expect(payload.ok).toBe(true);
  });

  it('uses /tmp fallback when project not in registry', async () => {
    const invokePluginAction = vi.fn(async () => ({ ok: true }));
    vi.doMock('@/lib/plugin-host-runtime', () => ({
      pluginHostStatus: vi.fn(),
      invokePluginAction,
      firePluginEvent: vi.fn(),
      firePluginLifecycle: vi.fn(),
    }));
    vi.doMock('@/lib/harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    }));
    const { default: tool } = await import('@/lib/agent-tools/plugins/invoke_action');
    await tool.handler(
      { plugin: 'p', action: 'a', slug: 'unregistered' },
      MAKE_CTX(),
    );
    expect(invokePluginAction).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: '/tmp', stateDir: '/tmp' }),
    );
  });

  it('exposes architect+operator role gate', async () => {
    vi.doMock('@/lib/plugin-host-runtime', () => ({
      pluginHostStatus: vi.fn(),
      invokePluginAction: vi.fn(),
      firePluginEvent: vi.fn(),
      firePluginLifecycle: vi.fn(),
    }));
    vi.doMock('@/lib/harness-registry', () => ({ loadHarnessRegistry: vi.fn() }));
    const { default: tool } = await import('@/lib/agent-tools/plugins/invoke_action');
    expect(tool.roles).toEqual(['architect', 'operator']);
  });
});

describe('plugins:fire_event', () => {
  it('event mode calls firePluginEvent', async () => {
    const firePluginEvent = vi.fn(async () => undefined);
    vi.doMock('@/lib/plugin-host-runtime', () => ({
      pluginHostStatus: vi.fn(),
      invokePluginAction: vi.fn(),
      firePluginEvent,
      firePluginLifecycle: vi.fn(),
    }));
    vi.doMock('@/lib/harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    }));
    const { default: tool } = await import('@/lib/agent-tools/plugins/fire_event');
    const result = await tool.handler(
      { mode: 'event', event: 'smoke-test', payload: { x: 1 } },
      MAKE_CTX(),
    );
    expect(firePluginEvent).toHaveBeenCalledWith('smoke-test', { x: 1 });
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, fired: 'smoke-test' });
  });

  it('lifecycle mode resolves slug via registry', async () => {
    const firePluginLifecycle = vi.fn(async () => undefined);
    vi.doMock('@/lib/plugin-host-runtime', () => ({
      pluginHostStatus: vi.fn(),
      invokePluginAction: vi.fn(),
      firePluginEvent: vi.fn(),
      firePluginLifecycle,
    }));
    vi.doMock('@/lib/harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [{ slug: 'sheets', path: '/tmp/sheets' }],
      })),
    }));
    const { default: tool } = await import('@/lib/agent-tools/plugins/fire_event');
    const result = await tool.handler(
      { mode: 'lifecycle', lifecycle: 'post-install', slug: 'sheets' },
      MAKE_CTX(),
    );
    expect(firePluginLifecycle).toHaveBeenCalled();
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, fired: 'post-install', slug: 'sheets' });
  });
});
