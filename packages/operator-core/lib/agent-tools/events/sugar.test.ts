import { describe, it, expect, vi, beforeEach } from 'vitest';

const definedTools = vi.hoisted(() => [] as Array<{ name: string; handler: (args: never, ctx: never) => Promise<{ content: Array<{ text: string }> }> }>);

vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: (typeof definedTools)[number]) => {
    definedTools.push(def);
    return def;
  },
  SU_ROLES: ['operator'],
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-awaiter', ownerLabel: 'a', source: 'static-client', workspaceId: 'ws-x', userId: null }),
}));

vi.mock('../../events/await/handle', () => ({
  captureWakeHandleForOwner: vi.fn(async () => ({ handle: { kind: 'adv-session', advSessionId: 1, agent: 'codex', sessionId: 's', ompThreadId: null, cwd: '/r', pid: 1 } })),
}));

vi.mock('../../events/await/store', () => ({
  registerAwait: vi.fn(async (i: Record<string, unknown>) => ({ id: 99, eventKey: i.eventKey, expiresTs: '2030-01-01', timeoutBehavior: i.timeoutBehavior })),
}));

vi.mock('../../events/await/engine', () => ({ startAwaitSweeper: vi.fn() }));

vi.mock('../../dev-deploy-state', () => ({
  devDeployState: vi.fn(async () => ({ integrationRoot: '/home/x/papercupai-workspace/papercusp' })),
}));

await import('./sugar');

import { registerAwait } from '../../events/await/store';
import { devDeployState } from '../../dev-deploy-state';
import { checkpointPipelineName } from './sugar';

const checkpointTool = definedTools.find((tool) => tool.name === 'checkpoint:await');
if (!checkpointTool) throw new Error('checkpoint:await tool was not registered');

const ctx = { workspaceId: 'ws-x' } as never;
const call = async (args: Record<string, unknown>) => {
  const res = await checkpointTool.handler(args as never, ctx);
  return JSON.parse(res.content[0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkpoint:await sugar', () => {
  it('defaults to the current pipeline-scoped gate keys', async () => {
    const out = await call({});

    expect(devDeployState).toHaveBeenCalledTimes(1);
    expect(vi.mocked(registerAwait).mock.calls.map((call) => call[0].eventKey)).toEqual([
      'release:green:papercusp',
      'green-checkpoint:red:papercusp',
    ]);
    expect(out.events).toEqual(['release:green:papercusp', 'green-checkpoint:red:papercusp']);
    expect(out.advice).toContain('End your turn');
  });

  it('uses an explicit pipeline without reading deploy state', async () => {
    await call({ pipeline: 'papercup' });

    expect(devDeployState).not.toHaveBeenCalled();
    expect(vi.mocked(registerAwait).mock.calls.map((call) => call[0].eventKey)).toEqual([
      'release:green:papercup',
      'green-checkpoint:red:papercup',
    ]);
  });

  it('keeps an explicit global escape hatch for cross-pipeline monitors', async () => {
    await call({ global: true });

    expect(devDeployState).not.toHaveBeenCalled();
    expect(vi.mocked(registerAwait).mock.calls.map((call) => call[0].eventKey)).toEqual([
      'release:green',
      'green-checkpoint:red',
    ]);
  });

  it('sanitizes pipeline names the same way checkpoint emitters do', () => {
    expect(checkpointPipelineName('/weird/dir with spaces!')).toBe('dir-with-spaces-');
  });
});
