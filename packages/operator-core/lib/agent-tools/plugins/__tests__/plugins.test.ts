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
  vi.doUnmock('../../../plugin-host-runtime');
  vi.doUnmock('../../../events/engine');
  vi.doUnmock('../../../harness-registry');
});

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('plugins:runtime_status', () => {
  it('returns pluginHostStatus output', async () => {
    const status = { loaded: 18, errors: 4, plugins: [] };
    vi.doMock('../../../plugin-host-runtime', () => ({
      pluginHostStatus: vi.fn(async () => status),
      invokePluginAction: vi.fn(),
      firePluginLifecycle: vi.fn(),
    }));
    const { default: tool } = await import('../runtime_status');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual(status);
  });
});

describe('plugins:invoke_action', () => {
  it('forwards plugin/action/slug + ctx-built dirs to invokePluginAction', async () => {
    const invokePluginAction = vi.fn(async () => ({ ok: true, result: 'x' }));
    vi.doMock('../../../plugin-host-runtime', () => ({
      pluginHostStatus: vi.fn(),
      invokePluginAction,
      firePluginLifecycle: vi.fn(),
    }));
    vi.doMock('../../../harness-registry', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [{ slug: 'sheets', path: '/tmp/sheets' }],
      })),
    }));
    const { default: tool } = await import('../invoke_action');
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
        stateDir: '/tmp/sheets/.papercusp',
        params: { x: 1 },
      }),
    );
    const payload = parsePayload(result as never);
    expect(payload.ok).toBe(true);
  });

  it('uses /tmp fallback when project not in registry', async () => {
    const invokePluginAction = vi.fn(async () => ({ ok: true }));
    vi.doMock('../../../plugin-host-runtime', () => ({
      pluginHostStatus: vi.fn(),
      invokePluginAction,
      firePluginLifecycle: vi.fn(),
    }));
    vi.doMock('../../../harness-registry', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    }));
    const { default: tool } = await import('../invoke_action');
    await tool.handler(
      { plugin: 'p', action: 'a', slug: 'unregistered' },
      MAKE_CTX(),
    );
    expect(invokePluginAction).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: '/tmp', stateDir: '/tmp' }),
    );
  });

  it('exposes architect+operator role gate', async () => {
    vi.doMock('../../../plugin-host-runtime', () => ({
      pluginHostStatus: vi.fn(),
      invokePluginAction: vi.fn(),
      firePluginLifecycle: vi.fn(),
    }));
    vi.doMock('../../../harness-registry', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      loadHarnessRegistry: vi.fn(),
    }));
    const { default: tool } = await import('../invoke_action');
    expect(tool.agentRoles).toEqual(['architect', 'operator']);
  });
});

describe('plugins:fire_event', () => {
  it('event mode feeds the reaction matcher via emitSystemEvent', async () => {
    const emitSystemEvent = vi.fn();
    vi.doMock('../../../plugin-host-runtime', () => ({
      pluginHostStatus: vi.fn(),
      invokePluginAction: vi.fn(),
      firePluginLifecycle: vi.fn(),
    }));
    vi.doMock('../../../events/engine', () => ({ emitSystemEvent }));
    vi.doMock('../../../harness-registry', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    }));
    const { default: tool } = await import('../fire_event');
    const result = await tool.handler(
      { mode: 'event', event: 'smoke-test', payload: { x: 1 } },
      MAKE_CTX(),
    );
    expect(emitSystemEvent).toHaveBeenCalledWith({ tool: 'smoke-test', args: { x: 1 } });
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, fired: 'smoke-test' });
  });

  it('lifecycle mode resolves slug via registry', async () => {
    const firePluginLifecycle = vi.fn(async () => undefined);
    vi.doMock('../../../plugin-host-runtime', () => ({
      pluginHostStatus: vi.fn(),
      invokePluginAction: vi.fn(),
      firePluginLifecycle,
    }));
    // fire_event top-level imports `emitSystemEvent` from ../../events/engine;
    // the lifecycle branch never uses it, but leaving it un-mocked eagerly loads
    // the REAL events/engine → … → p2p/revocation-reaper graph, whose
    // `import { deregisterEphemeralForeignHarness } from '../harness-registry'`
    // then reads THIS test's partial harness-registry mock. Relying on
    // `importOriginal` to carry that (and every other) export across is fragile
    // and flaked the gate 18× (EI-9039: "No 'deregisterEphemeralForeignHarness'
    // export is defined on the mock"). Mock events/engine here — exactly as the
    // sibling event-mode test does — so the deep graph never loads and the
    // registry mock only needs the one export fire_event actually calls.
    vi.doMock('../../../events/engine', () => ({ emitSystemEvent: vi.fn() }));
    vi.doMock('../../../harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [{ slug: 'sheets', path: '/tmp/sheets' }],
      })),
    }));
    const { default: tool } = await import('../fire_event');
    const result = await tool.handler(
      { mode: 'lifecycle', lifecycle: 'post-install', slug: 'sheets' },
      MAKE_CTX(),
    );
    expect(firePluginLifecycle).toHaveBeenCalled();
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, fired: 'post-install', slug: 'sheets' });
  });
});
