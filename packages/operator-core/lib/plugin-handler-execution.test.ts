import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeApprovedHandler } from '@papercusp/plugin-loader/daemon';
import { createConfinedPluginInvoker } from './plugin-handler-execution';
import type { PluginHandlerExecutor } from './plugin-invocation-policy';

vi.mock('@papercusp/plugin-loader/daemon', async original => ({
  ...await original<typeof import('@papercusp/plugin-loader/daemon')>(), invokeApprovedHandler: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

function fixture() {
  const installation = { version: '1.0.0', path: '/installed/fixture', source: 'global' as const };
  const request = { toolName: 'fixture:read', input: { principal: 'forged' },
    tool: { pluginName: 'fixture', pluginInstallation: { ...installation } },
    ctx: { signal: new AbortController().signal } } as Parameters<PluginHandlerExecutor>[0];
  const effect = vi.fn(async () => 'host-result');
  const invoke = createConfinedPluginInvoker({ runtime: { sha256: 'a'.repeat(64) }, pluginName: 'fixture',
    installation, tools: ['fixture:read'], effects: () => ({ 'checked.read': effect }) });
  return { request, invoke, effect };
}

describe('confined plugin installation binding', () => {
  it('passes only invocation data and explicit checked services to the supervisor', async () => {
    const f = fixture();
    vi.mocked(invokeApprovedHandler).mockImplementation(async options => {
      expect(options.input).toEqual({ principal: 'forged' });
      expect(options).not.toHaveProperty('principal'); expect(options).not.toHaveProperty('ctx');
      expect(await options.effect!('checked.read', {}, options.signal)).toBe('host-result');
      await expect(Promise.resolve().then(() => options.effect!('toString', {}, options.signal))).rejects.toThrow(/not exposed/);
      return { content: [{ type: 'text', text: 'allowed' }] };
    });
    expect(await f.invoke(f.request)).toEqual({ content: [{ type: 'text', text: 'allowed' }] });
    expect(f.effect).toHaveBeenCalledOnce();
  });

  it.each(['plugin', 'version', 'path', 'source', 'tool'] as const)('refuses %s substitution before starting the guest', async axis => {
    const f = fixture();
    if (axis === 'plugin') f.request.tool.pluginName = 'other';
    else if (axis === 'tool') f.request.toolName = 'other:read';
    else f.request.tool.pluginInstallation = { ...f.request.tool.pluginInstallation!, [axis]: 'other' };
    await expect(f.invoke(f.request)).rejects.toThrow(/installation binding mismatch/);
    expect(invokeApprovedHandler).not.toHaveBeenCalled();
  });

  it('refuses malformed guest output', async () => {
    const f = fixture(); vi.mocked(invokeApprovedHandler).mockResolvedValue({ content: [{ type: 'text', text: 1 }] });
    await expect(f.invoke(f.request)).rejects.toThrow();
  });
});
