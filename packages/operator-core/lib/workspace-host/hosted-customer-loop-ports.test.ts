import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectedTool, DispatchProjectedDeps } from '@papercusp/tooldef';
import { buildLoopbackIdentitySpawn } from '@papercusp/papercusp-shared/agent';
import { createHostedPrincipal } from '../auth/hosted-principal';
import type { HostedPrincipalResolver, HostedPrincipalResolution } from '../auth/hosted-principal-resolver';
import type { ModelPort, ModelRequest } from '../agent-loop/model-port';
import { beginSyncEnrolment, completeSyncEnrolment, finishSyncEnrolment } from '../task-manager/enroll-sync';
import { notifyTaskKillRequested } from '../task-manager/kill-notify';
import { bindHostedCustomerLoopPorts } from './hosted-customer-loop-ports';

vi.mock('../task-manager/enroll-sync', () => ({
  beginSyncEnrolment: vi.fn(() => ({ taskId: 'testcustomertask', enrolled: true })),
  completeSyncEnrolment: vi.fn(), finishSyncEnrolment: vi.fn(),
}));

let root: string, project: string;
beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'customer-loop-ports-'));
  project = join(root, 'project'); mkdirSync(project);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function fixture(options: { tool?: Partial<ProjectedTool>; deps?: DispatchProjectedDeps;
  modelFactory?: (session: unknown, signal?: AbortSignal) => ModelPort | Promise<ModelPort> } = {}) {
  let current = createHostedPrincipal({ workspaceId: 'control-workspace', userId: 'customer-user',
    activeOrganizationId: 'customer-org', selectedWorkspaceId: 'customer-workspace',
    sessionId: 'authenticated-session', sessionVersion: 1, permissions: ['workspace:operate'] });
  const resolve: HostedPrincipalResolver = vi.fn(async () => ({ ok: true, principal: current } as HostedPrincipalResolution));
  const localHandler = vi.fn(async () => ({ content: [{ type: 'text', text: 'operator-local' }] }));
  const tool: ProjectedTool = { pluginName: 'fixture', description: 'shell',
    capabilities: ['capability:bash'], expose: { mcp: { name: 'capability:bash' } },
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, cmd: { type: 'string' },
      cwd: { type: 'string' }, timeout: { type: 'number' }, run_in_background: { type: 'boolean' },
      integration_env: { type: 'object' } }, additionalProperties: false },
    agentRoles: ['worker'], fn: localHandler, ...options.tool };
  // REAL wrapper/process/dispatcher, same UID test transport. No customer OS acceptance claim.
  const transform = vi.fn(buildLoopbackIdentitySpawn({ transportCommand: '/bin/bash', transportArgs: ['-c'],
    identity: 'test-customer', nodePath: process.execPath, remoteHome: root,
    spawnRoot: join(root, 'spawns'), localHome: root, baseEnv: process.env, remotePath: ['/usr/bin', '/bin'] }));
  const controller = new AbortController();
  const modelStream = vi.fn(async function* (_request: ModelRequest) { yield { type: 'text_delta' as const, text: 'model' }; });
  const modelFactory = vi.fn(options.modelFactory ?? (() => ({ stream: modelStream })));
  const telemetry = vi.fn();
  const ports = await bindHostedCustomerLoopPorts({ resolvePrincipal: resolve, sessionHeaders: new Headers(),
    customerWorkspaceId: 'customer-workspace', projectDir: project, transform,
    signal: controller.signal, lookupTool: () => tool, dispatchDeps: { recordInvocation: telemetry, ...options.deps },
    createModelPort: modelFactory });
  return { ports, resolve, transform, controller, modelFactory, modelStream, localHandler, telemetry,
    change: (patch: Partial<typeof current>) => { current = { ...current, ...patch }; } };
}

const request: ModelRequest = { model: 'fixture/model', messages: [] };
async function consume(port: ModelPort, req = request) {
  const events = []; for await (const event of port.stream(req)) events.push(event); return events;
}

describe('private customer loop port composition', () => {
  it('uses the registry dispatcher gates and customer transport, with exact derived authority', async () => {
    const f = await fixture();
    const result = await f.ports.dispatch('capability:bash', { command: 'printf customer' });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content![0] as { text: string }).text)).toMatchObject({
      output: 'customer', exit_code: 0, task_id: 'testcustomertask', task_enrolled: true });
    expect(f.localHandler).not.toHaveBeenCalled();
    expect(f.telemetry).toHaveBeenCalledWith(expect.objectContaining({ ctx: expect.objectContaining({
      workspaceId: 'control-workspace', role: 'worker',
      principal: expect.objectContaining({ slug: 'customer-user', capabilities: new Set(['capability:bash']),
        allowedTools: new Set(['capability:bash']) }) }) }));
    expect(f.ports.toolNames).toEqual(['capability:bash']);
    expect(completeSyncEnrolment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      launchedBy: 'customer-user', sessionId: 'authenticated-session',
      detail: { customerWorkspaceId: 'customer-workspace', organizationId: 'customer-org', foreground: true } }),
    expect.any(Number), { workspaceId: 'control-workspace' });
    expect(finishSyncEnrolment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: 'exited', exitCode: 0 }));
  });

  it.each(['capability:read', 'tools:invoke', 'processes:kill'])('never falls through for %s', async name => {
    const ambient = vi.fn(); const f = await fixture({ deps: { overrideTool: ambient } });
    expect((await f.ports.dispatch(name, {})).isError).toBe(true);
    expect(f.transform).not.toHaveBeenCalled(); expect(f.localHandler).not.toHaveBeenCalled();
    expect(ambient).not.toHaveBeenCalled();
  });

  it.each([{ command: 42 }, { command: 'touch forbidden', principal: '*' },
    { command: 'touch forbidden', run_in_background: true },
    { command: 'touch forbidden', integration_env: { OPENROUTER_API_KEY: 'private' } },
    { command: 'touch forbidden', cmd: 'touch different' }, { command: 'touch forbidden', timeout: -1 }])(
    'refuses invalid or unsupported shell arguments before launch: %j', async args => {
      const f = await fixture(); expect((await f.ports.dispatch('capability:bash', args)).isError).toBe(true);
      expect(f.transform).not.toHaveBeenCalled(); expect(f.localHandler).not.toHaveBeenCalled();
      expect(existsSync(join(project, 'forbidden'))).toBe(false);
    });

  it('preserves resource authorization and role gates before the transport override', async () => {
    for (const tool of [{ authorize: async () => ({ allow: false }) }, { agentRoles: ['architect'] }]) {
      const f = await fixture({ tool });
      expect((await f.ports.dispatch('capability:bash', { command: 'touch forbidden' })).isError).toBe(true);
      expect(f.transform).not.toHaveBeenCalled(); expect(f.localHandler).not.toHaveBeenCalled();
    }
  });

  it('resolves relative cwd on the customer side and accepts the existing cmd alias', async () => {
    mkdirSync(join(project, 'sub'));
    const f = await fixture(); const result = await f.ports.dispatch('capability:bash', { cmd: 'pwd', cwd: 'sub' });
    expect(JSON.parse((result.content![0] as { text: string }).text).output).toBe(`${project}/sub\n`);
  });

  it.each(['userId', 'sessionId', 'sessionVersion', 'activeOrganizationId', 'selectedWorkspaceId', 'workspaceId'])(
    'refuses changed %s for both tools and models', async key => {
      const f = await fixture();
      f.change({ [key]: key === 'sessionVersion' ? 2 : 'foreign' });
      await expect(f.ports.dispatch('capability:bash', { command: 'touch forbidden' })).rejects.toThrow('hosted_customer_execution_denied');
      await expect(consume(f.ports.modelPort)).rejects.toThrow('hosted_customer_execution_denied');
      expect(f.transform).not.toHaveBeenCalled(); expect(f.modelFactory).not.toHaveBeenCalled();
    });

  it('creates a fresh separately bound model port on every request and drops caller account/owner labels', async () => {
    const f = await fixture();
    await consume(f.ports.modelPort, { ...request, account: 'operator-account', ownerId: 'operator-owner' });
    await consume(f.ports.modelPort);
    expect(f.modelFactory).toHaveBeenCalledTimes(2);
    expect(f.modelFactory).toHaveBeenCalledWith(expect.objectContaining({ userId: 'customer-user',
      sessionId: 'authenticated-session', activeOrganizationId: 'customer-org', selectedWorkspaceId: 'customer-workspace' }),
    expect.any(AbortSignal));
    expect(f.modelStream).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'customer-user' }));
    expect(f.modelStream.mock.calls[0][0]).not.toHaveProperty('account');
  });

  it('rechecks session changes while model admission is pending', async () => {
    let release!: (port: ModelPort) => void;
    const f = await fixture({ modelFactory: () => new Promise<ModelPort>(resolve => { release = resolve; }) });
    const pending = consume(f.ports.modelPort);
    await vi.waitFor(() => expect(f.modelFactory).toHaveBeenCalled());
    f.change({ sessionId: 'rotated-session' }); release({ stream: f.modelStream });
    await expect(pending).rejects.toThrow('hosted_customer_execution_denied');
    expect(f.modelStream).not.toHaveBeenCalled();
  });

  it('cancels stalled model admission and never starts a late port', async () => {
    let release!: (port: ModelPort) => void;
    const f = await fixture({ modelFactory: () => new Promise<ModelPort>(resolve => { release = resolve; }) });
    const pending = consume(f.ports.modelPort);
    await vi.waitFor(() => expect(f.modelFactory).toHaveBeenCalled());
    const rejected = expect(pending).rejects.toThrow('hosted_customer_model_unavailable');
    f.controller.abort(); await rejected; release({ stream: f.modelStream }); await Promise.resolve();
    expect(f.modelStream).not.toHaveBeenCalled();
  });

  it('cancels a running customer command through the dispatcher signal and closes its task', async () => {
    const f = await fixture();
    const pending = f.ports.dispatch('capability:bash', { command: 'sleep 30' });
    await vi.waitFor(() => expect(completeSyncEnrolment).toHaveBeenCalled());
    f.controller.abort(); expect((await pending).isError).toBe(true);
    expect(finishSyncEnrolment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: 'killed' }));
  });

  it('propagates an external task kill through the remote wrapper and removes its listener after close', async () => {
    const f = await fixture();
    const pending = f.ports.dispatch('capability:bash', { command: 'sleep 30' });
    await vi.waitFor(() => expect(completeSyncEnrolment).toHaveBeenCalled());
    notifyTaskKillRequested('unrelated-task', 'SIGTERM');
    expect(finishSyncEnrolment).not.toHaveBeenCalled();
    notifyTaskKillRequested('testcustomertask', 'SIGTERM');
    expect((await pending).isError).toBe(true);
    expect(finishSyncEnrolment).toHaveBeenCalledTimes(1);
    notifyTaskKillRequested('testcustomertask', 'SIGTERM');
    expect(finishSyncEnrolment).toHaveBeenCalledTimes(1);
  });

  it('records deadline expiry distinctly from caller cancellation', async () => {
    const f = await fixture();
    expect((await f.ports.dispatch('capability:bash', { command: 'sleep 30', timeout: 100 })).isError).toBe(true);
    expect(beginSyncEnrolment).toHaveBeenCalled();
    expect(finishSyncEnrolment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: 'timed_out' }));
  });
});
