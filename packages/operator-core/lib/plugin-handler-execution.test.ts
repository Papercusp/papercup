import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeApprovedHandler, prepareInstalledHandlerRuntime, snapshotInstalledHandlerFiles } from '@papercusp/plugin-loader/daemon';
import { createConfinedPluginInvoker, createInstalledConfinedPluginInvoker, executeInstalledPluginHandler as executeWithLease } from './plugin-handler-execution';
import { locatePluginEntry, createInvocationCapabilityContext, runWithInvocationCapabilities } from '@papercusp/plugin-loader';
import { getPluginHost } from './plugin-host-runtime';
import { makeSecretResolver } from './plugin-spawn-impl';
import { resolveOperatorAppRootFromModuleDir } from './operator-app-root';
import type { PluginHandlerExecutor } from './plugin-invocation-policy';
import { mockResolvedTyped } from './testing/typed-mock';

vi.mock('@papercusp/plugin-loader/daemon', async original => ({
  ...await original<typeof import('@papercusp/plugin-loader/daemon')>(),
  invokeApprovedHandler: vi.fn(), prepareInstalledHandlerRuntime: vi.fn(), snapshotInstalledHandlerFiles: vi.fn(),
}));
vi.mock('@papercusp/plugin-loader', async original => ({
  ...await original<typeof import('@papercusp/plugin-loader')>(), locatePluginEntry: vi.fn(),
}));
vi.mock('./plugin-host-runtime', async original => ({
  ...await original<typeof import('./plugin-host-runtime')>(), getPluginHost: vi.fn(),
}));
vi.mock('./plugin-spawn-impl', async original => ({
  ...await original<typeof import('./plugin-spawn-impl')>(), makeSecretResolver: vi.fn(),
}));
vi.mock('./operator-app-root', async original => ({
  ...await original<typeof import('./operator-app-root')>(), resolveOperatorAppRootFromModuleDir: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

type PluginHostState = Awaited<ReturnType<typeof getPluginHost>>;
const hostState = (loaded: PluginHostState['loaded']): PluginHostState => ({
  loaded, loadErrors: [], initialized: new Set(), registries: new Map(), grants: new Map(), wasmHandles: new Map(),
});

function fixture() {
  const installation = { version: '1.0.0', path: '/installed/fixture', source: 'global' as const };
  const request = { toolName: 'fixture:read', input: { principal: 'forged' },
    tool: { pluginName: 'fixture', pluginInstallation: { ...installation } },
    ctx: { signal: new AbortController().signal } } as Parameters<PluginHandlerExecutor>[0];
  const effect = vi.fn(async () => 'host-result');
  const options = { runtime: { sha256: 'a'.repeat(64) }, pluginName: 'fixture',
    installation, tools: ['fixture:read'], effects: () => ({ 'checked.read': effect }) };
  const invoke = createConfinedPluginInvoker(options);
  return { request, invoke, effect, options };
}

describe('production installed executor', () => {
  const executeInstalledPluginHandler = (request: Parameters<PluginHandlerExecutor>[0]) => executeWithLease(request, () => {});
  function productionFixture() {
    const f = fixture();
    f.request.toolName = 'fixture.read';
    f.request.tool.capabilities = ['secrets:read:ALLOWED'];
    f.request.ctx.harnessSlug = 'harness';
    const loaded = {
      plugin: {
        name: 'fixture',
        version: '1.0.0',
        papercusp: '^1.0.0',
        capabilities: ['secrets:read:ALLOWED'],
      },
      ...f.options.installation,
      runtime: { kind: 'js' },
      toolDefinitions: [{
        name: 'read',
        description: 'Reads fixture data',
        inputSchema: { type: 'object' },
        capabilities: ['secrets:read:ALLOWED'],
      }],
    } satisfies Awaited<ReturnType<typeof getPluginHost>>['loaded'][number];
    mockResolvedTyped(vi.mocked(getPluginHost), hostState([loaded]));
    vi.mocked(locatePluginEntry).mockResolvedValue('/installed/fixture/dist/index.cjs');
    vi.mocked(resolveOperatorAppRootFromModuleDir).mockReturnValue('/installed/apps/operator');
    vi.mocked(snapshotInstalledHandlerFiles).mockReturnValue([{ path: '/handler/entry.cjs',
      contents: Buffer.from('guest'), sha256: 'b'.repeat(64), executable: false }]);
    vi.mocked(prepareInstalledHandlerRuntime).mockResolvedValue({ sha256: 'c'.repeat(64) });
    const secret = vi.fn(async () => 'checked-secret');
    vi.mocked(makeSecretResolver).mockReturnValue(secret);
    vi.mocked(invokeApprovedHandler).mockResolvedValue({ content: [] });
    return { ...f, loaded, secret };
  }

  it('requires a host lease before reading any installed state', async () => {
    const f = productionFixture();
    await expect(executeWithLease(f.request)).rejects.toThrow(/host invocation lease/);
    expect(getPluginHost).not.toHaveBeenCalled();
    expect(prepareInstalledHandlerRuntime).not.toHaveBeenCalled();
  });

  it('checks the lease again after asynchronous runtime admission', async () => {
    const f = productionFixture(); let active = true;
    vi.mocked(prepareInstalledHandlerRuntime).mockImplementationOnce(async () => {
      active = false; return { sha256: 'c'.repeat(64) };
    });
    await expect(executeWithLease(f.request, () => { if (!active) throw new Error('revoked lease'); }))
      .rejects.toThrow(/revoked lease/);
    expect(invokeApprovedHandler).not.toHaveBeenCalled();
  });

  it('uses host package/entry/tool bindings despite forged routing arguments', async () => {
    const f = productionFixture();
    f.request.input = { runtimeDirectory: '/forged', entryPoint: 'evil.cjs', toolName: 'admin' };
    await executeInstalledPluginHandler(f.request);
    expect(locatePluginEntry).toHaveBeenCalledWith('/installed/fixture');
    expect(snapshotInstalledHandlerFiles).toHaveBeenCalledWith('/installed/fixture', 'dist/index.cjs', { name: 'fixture', version: '1.0.0' });
    expect(prepareInstalledHandlerRuntime).toHaveBeenCalledWith('/installed/handler-runtime', expect.any(Array));
    expect(invokeApprovedHandler).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'read', input: f.request.input }));
    expect(makeSecretResolver).toHaveBeenCalledWith({ harnessSlug: 'harness', pluginName: 'fixture' });
  });

  it.each(['missing', 'ambiguous', 'version', 'path', 'source', 'runtime', 'tool', 'entry'] as const)(
    'refuses %s installation binding without runtime admission or guest execution', async axis => {
      const f = productionFixture();
      if (axis === 'missing') mockResolvedTyped(vi.mocked(getPluginHost), hostState([]));
      else if (axis === 'ambiguous') {
        mockResolvedTyped(vi.mocked(getPluginHost), hostState([f.loaded, f.loaded]));
      }
      else if (axis === 'version') f.loaded.plugin.version = '2.0.0';
      else if (axis === 'path') f.loaded.path = '/other';
      else if (axis === 'source') Object.assign(f.loaded, { source: 'project' });
      else if (axis === 'runtime') Object.assign(f.loaded.runtime, { kind: 'daemon' });
      else if (axis === 'tool') f.loaded.toolDefinitions[0]!.name = 'other';
      else vi.mocked(locatePluginEntry).mockResolvedValue(null);
      await expect(executeInstalledPluginHandler(f.request)).rejects.toThrow(/installed/);
      expect(prepareInstalledHandlerRuntime).not.toHaveBeenCalled();
      expect(invokeApprovedHandler).not.toHaveBeenCalled();
    });

  it('translates an explicit wire name and refuses duplicate manifest mappings', async () => {
    const f = productionFixture();
    Object.assign(f.loaded.toolDefinitions[0]!, { expose: { mcp: { name: 'fixture.read' } } });
    f.loaded.toolDefinitions[0]!.name = 'local';
    await executeInstalledPluginHandler(f.request);
    expect(invokeApprovedHandler).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'local' }));
    vi.mocked(invokeApprovedHandler).mockClear();
    f.loaded.toolDefinitions.push({ ...f.loaded.toolDefinitions[0]! });
    await expect(executeInstalledPluginHandler(f.request)).rejects.toThrow(/tool mapping/);
    expect(invokeApprovedHandler).not.toHaveBeenCalled();
  });

  it('re-admits each invocation and never executes after receipt rejection', async () => {
    const f = productionFixture();
    await executeInstalledPluginHandler(f.request);
    vi.mocked(invokeApprovedHandler).mockClear();
    vi.mocked(prepareInstalledHandlerRuntime).mockRejectedValue(new Error('revoked receipt'));
    await expect(executeInstalledPluginHandler(f.request)).rejects.toThrow(/revoked/);
    expect(prepareInstalledHandlerRuntime).toHaveBeenCalledTimes(2);
    expect(invokeApprovedHandler).not.toHaveBeenCalled();
  });

  it('checks the live invocation before and after scoped secret IO and exposes no spawn', async () => {
    const f = productionFixture();
    let current = true;
    const capability = 'secrets:read:ALLOWED';
    const scope = createInvocationCapabilityContext({ pluginName: 'fixture', capabilities: [capability],
      granted: [capability], principal: { kind: 'system', authMethod: 'bearer-token', trust: 'verified', slug: 'agent',
        workspaceId: 'workspace', capabilities: new Set([capability]), allowedTools: new Set(['fixture.read']) },
      invocationId: 'call', declaration: { name: 'fixture.read', capabilities: [capability] },
      approvals: [capability], expiresAt: Date.now() + 60_000, isActive: () => current });
    vi.mocked(invokeApprovedHandler).mockImplementation(async options => {
      expect(await options.effect!('sdk.secret', { name: 'ALLOWED' }, options.signal)).toBe('checked-secret');
      await expect(Promise.resolve().then(() => options.effect!('sdk.secret', { name: 'OTHER' }, options.signal))).rejects.toThrow(/capability/);
      await expect(Promise.resolve().then(() => options.effect!('sdk.spawn', {}, options.signal))).rejects.toThrow(/not exposed/);
      f.secret.mockImplementationOnce(async () => { current = false; return 'must-not-return'; });
      await expect(Promise.resolve().then(() => options.effect!('sdk.secret', { name: 'ALLOWED' }, options.signal))).rejects.toThrow(/capability/);
      return { content: [] };
    });
    await runWithInvocationCapabilities(scope, () => executeInstalledPluginHandler(f.request));
    expect(f.secret).toHaveBeenCalledTimes(2);
  });
});

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

  it('pins the wire to SDK name mapping and exports only the SDK data context', async () => {
    const f = fixture(), mapping = { 'fixture:read': 'read' };
    const progress = vi.fn(), emit = vi.fn(), log = vi.fn();
    Object.assign(f.request.ctx, { workspaceId: 'workspace', harnessSlug: 'harness', projectDir: '/project',
      stateDir: '/project/.papercusp', role: 'su', runId: 'run', spawnId: 'spawn',
      principal: { token: 'HOST_PRIVATE' }, privateValue: 'HOST_PRIVATE', progress, emit, log });
    const invoke = createConfinedPluginInvoker({ ...f.options, tools: mapping });
    mapping['fixture:read'] = 'substituted';
    vi.mocked(invokeApprovedHandler).mockImplementation(async options => {
      Object.assign(f.request.ctx, { workspaceId: 'substituted', log: () => { throw new Error('substituted'); } });
      expect(options.toolName).toBe('read');
      expect(await options.effect!('sdk.context', null, options.signal)).toEqual({ workspaceId: 'workspace',
        harnessSlug: 'harness', projectDir: '/project', stateDir: '/project/.papercusp', role: 'su',
        runId: 'run', spawnId: 'spawn', featureId: null, chunkId: null, parentSpawnId: null });
      await options.effect!('sdk.progress', { pct: 50, msg: 'half' }, options.signal);
      await options.effect!('sdk.emit', { name: 'progress', data: { n: 1 } }, options.signal);
      await options.effect!('sdk.log', { msg: 'log' }, options.signal);
      await expect(Promise.resolve().then(() => options.effect!('sdk.secret', { name: 'PRIVATE' }, options.signal)))
        .rejects.toThrow(/not exposed/);
      await expect(Promise.resolve().then(() => options.effect!('sdk.progress', { pct: 'invalid' }, options.signal)))
        .rejects.toThrow(/invalid SDK/);
      return { content: [{ type: 'text', text: 'SDK' }] };
    });
    await invoke(f.request);
    expect(progress).toHaveBeenCalledWith(50, 'half');
    expect(emit).toHaveBeenCalledWith('progress', { n: 1 });
    expect(log).toHaveBeenCalledWith('log');
  });
});

describe('installed confined plugin binding', () => {
  it.each(['sdk.context', 'sdk.progress', 'sdk.emit', 'sdk.log'])(
    'checks the live host lease before the %s callback', async operation => {
      const f = fixture(); let active = true;
      const callback = vi.fn();
      Object.assign(f.request.ctx, { progress: callback, emit: callback, log: callback });
      const invoke = createConfinedPluginInvoker({ ...f.options, assertActive: () => {
        if (!active) throw new Error('revoked lease');
      } });
      vi.mocked(invokeApprovedHandler).mockImplementation(async options => {
        active = false;
        await expect(Promise.resolve().then(() => options.effect!(operation, {}, options.signal))).rejects.toThrow(/revoked lease/);
        return { content: [] };
      });
      await expect(invoke(f.request)).rejects.toThrow(/revoked lease/);
      expect(callback).not.toHaveBeenCalled();
    });

  it('checks the host lease after asynchronous effect completion', async () => {
    const f = fixture(); let active = true;
    const invoke = createConfinedPluginInvoker({ ...f.options,
      assertActive: () => { if (!active) throw new Error('revoked lease'); },
      effects: () => ({ 'checked.read': async () => { active = false; return 'must-not-return'; } }) });
    vi.mocked(invokeApprovedHandler).mockImplementation(async options => {
      await expect(Promise.resolve().then(() => options.effect!('checked.read', {}, options.signal))).rejects.toThrow(/revoked lease/);
      return { content: [] };
    });
    await expect(invoke(f.request)).rejects.toThrow(/revoked lease/);
  });

  it('rejects guest output settled after revocation without any callback', async () => {
    const f = fixture(); let active = true;
    const invoke = createConfinedPluginInvoker({ ...f.options,
      assertActive: () => { if (!active) throw new Error('revoked lease'); } });
    vi.mocked(invokeApprovedHandler).mockImplementation(async () => {
      active = false; return { content: [{ type: 'text', text: 'must-not-return' }] };
    });
    await expect(invoke(f.request)).rejects.toThrow(/revoked lease/);
  });

  const handler = () => ({ path: '/handler/entry.cjs', contents: Buffer.from('untrusted guest'),
    sha256: 'b'.repeat(64), executable: false });

  it('snapshots only the host-bound installation before asynchronous runtime admission', async () => {
    const f = fixture(), file = handler();
    vi.mocked(snapshotInstalledHandlerFiles).mockReturnValue([file]);
    vi.mocked(prepareInstalledHandlerRuntime).mockResolvedValue({ sha256: 'c'.repeat(64) });
    await createInstalledConfinedPluginInvoker({ ...f.options, runtimeDirectory: '/installed/runtime', entryPoint: 'dist/index.cjs' });
    expect(snapshotInstalledHandlerFiles).toHaveBeenCalledWith('/installed/fixture', 'dist/index.cjs', { name: 'fixture', version: '1.0.0' });
    expect(prepareInstalledHandlerRuntime).toHaveBeenCalledWith('/installed/runtime', [file]);
    expect(invokeApprovedHandler).not.toHaveBeenCalled();
  });

  it('never admits or imports a guest when the installed snapshot is refused', async () => {
    const f = fixture();
    vi.mocked(snapshotInstalledHandlerFiles).mockImplementation(() => { throw new Error('changing installation'); });
    await expect(createInstalledConfinedPluginInvoker({ ...f.options, runtimeDirectory: '/installed/runtime', entryPoint: 'index.cjs' }))
      .rejects.toThrow(/changing installation/);
    expect(prepareInstalledHandlerRuntime).not.toHaveBeenCalled();
    expect(invokeApprovedHandler).not.toHaveBeenCalled();
  });

  it.each(['empty', 'population', 'file-bytes', 'total-bytes', 'contents'] as const)(
    'refuses %s before copying guest bytes or starting installed admission', async axis => {
      const f = fixture();
      const sized = (size: number) => {
        const file = handler();
        // A synthetic length exercises allocation admission without consuming
        // hundreds of MiB. No copy may occur for any refused population.
        Object.defineProperty(file.contents, 'byteLength', { value: size });
        return file;
      };
      let files = [handler()];
      if (axis === 'empty') files = [];
      if (axis === 'population') files = Array.from({ length: 1024 }, handler);
      if (axis === 'file-bytes') files = [sized(256 * 1024 * 1024 + 1)];
      if (axis === 'total-bytes') files = Array.from({ length: 3 }, () => sized(200 * 1024 * 1024));
      if (axis === 'contents') files[0]!.contents = null as unknown as ReturnType<typeof handler>['contents'];
      const copy = vi.spyOn(Buffer, 'from');
      await expect(createInstalledConfinedPluginInvoker({ ...f.options,
        runtimeDirectory: '/installed/runtime', handlerFiles: files })).rejects.toThrow(/handler snapshot/);
      expect(copy).not.toHaveBeenCalled();
      expect(prepareInstalledHandlerRuntime).not.toHaveBeenCalled();
      expect(invokeApprovedHandler).not.toHaveBeenCalled();
    });

  it('uses only the runtime returned by installed admission and retains checked service binding', async () => {
    const f = fixture(), file = handler(), runtime = { sha256: 'c'.repeat(64) };
    vi.mocked(prepareInstalledHandlerRuntime).mockResolvedValue(runtime);
    const invoke = await createInstalledConfinedPluginInvoker({ ...f.options,
      runtimeDirectory: '/installed/runtime', handlerFiles: [file] });
    expect(prepareInstalledHandlerRuntime).toHaveBeenCalledWith('/installed/runtime', [file]);
    expect(invokeApprovedHandler).not.toHaveBeenCalled();
    vi.mocked(invokeApprovedHandler).mockImplementation(async options => {
      expect(options.runtime).toBe(runtime);
      expect(await options.effect!('checked.read', {}, options.signal)).toBe('host-result');
      return { content: [{ type: 'text', text: 'installed' }] };
    });
    expect(await invoke(f.request)).toEqual({ content: [{ type: 'text', text: 'installed' }] });
  });

  it('refuses failed installed admission without starting any guest or falling back to the supplied runtime', async () => {
    const f = fixture();
    vi.mocked(prepareInstalledHandlerRuntime).mockRejectedValue(new Error('revoked installed receipt'));
    await expect(createInstalledConfinedPluginInvoker({ ...f.options,
      runtimeDirectory: '/installed/runtime', handlerFiles: [handler()] })).rejects.toThrow(/revoked installed receipt/);
    expect(invokeApprovedHandler).not.toHaveBeenCalled();
    expect(f.effect).not.toHaveBeenCalled();
  });

  it('pins installation, tools, effects and guest bytes before asynchronous admission', async () => {
    const f = fixture(), file = handler(), original = Buffer.from(file.contents);
    const changedEffect = vi.fn(async () => 'substituted');
    let admit!: (value: { sha256: string }) => void;
    vi.mocked(prepareInstalledHandlerRuntime).mockImplementation(async (_directory, files) => {
      await new Promise<void>(resolve => { admit = () => resolve(); });
      expect(files[0]!.contents).toEqual(original);
      expect(files[0]!.path).toBe('/handler/entry.cjs');
      return { sha256: 'c'.repeat(64) };
    });
    const options = { ...f.options, runtimeDirectory: '/installed/runtime', handlerFiles: [file] };
    const pending = createInstalledConfinedPluginInvoker(options);
    options.installation.path = '/substituted'; options.tools.push('fixture:other');
    options.pluginName = 'other'; options.effects = () => ({ 'checked.read': changedEffect });
    file.path = '/handler/substituted.cjs'; file.contents.fill(0); options.handlerFiles.length = 0;
    admit({ sha256: 'ignored' });
    const invoke = await pending;
    vi.mocked(invokeApprovedHandler).mockImplementation(async options => {
      expect(await options.effect!('checked.read', {}, options.signal)).toBe('host-result');
      return { content: [{ type: 'text', text: 'original' }] };
    });
    expect(await invoke(f.request)).toEqual({ content: [{ type: 'text', text: 'original' }] });
    await expect(invoke({ ...f.request, toolName: 'fixture:other' })).rejects.toThrow(/installation binding mismatch/);
    expect(invokeApprovedHandler).toHaveBeenCalledOnce();
    expect(changedEffect).not.toHaveBeenCalled();
  });
});
