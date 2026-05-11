/**
 * delegates:* + agents:list tools.
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
  vi.doUnmock('@/lib/delegates');
  vi.doUnmock('@/lib/delegate-inbox');
  vi.doUnmock('@/lib/agents-list');
  vi.doUnmock('@/lib/workspace-registry');
});

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('delegates:list', () => {
  it('id arg → getDelegate', async () => {
    const getDelegate = vi.fn(async () => ({ id: 'sess1', title: 't' }));
    vi.doMock('@/lib/delegates', () => ({
      getDelegate,
      listDelegates: vi.fn(),
      searchDelegates: vi.fn(),
    }));
    vi.doMock('@/lib/workspace-registry', () => ({
      activeWorkspaceId: vi.fn(() => 'default'),
    }));
    const { default: tool } = await import('@/lib/agent-tools/delegates/list');
    const result = await tool.handler({ id: 'sess1' }, MAKE_CTX());
    expect(getDelegate).toHaveBeenCalledWith('default', 'sess1');
    const payload = parsePayload(result as never);
    expect((payload.session as Record<string, unknown>).id).toBe('sess1');
  });

  it('query arg → searchDelegates', async () => {
    const searchDelegates = vi.fn(async () => []);
    vi.doMock('@/lib/delegates', () => ({
      getDelegate: vi.fn(),
      listDelegates: vi.fn(),
      searchDelegates,
    }));
    vi.doMock('@/lib/workspace-registry', () => ({
      activeWorkspaceId: vi.fn(() => 'default'),
    }));
    const { default: tool } = await import('@/lib/agent-tools/delegates/list');
    await tool.handler({ query: 'foo' }, MAKE_CTX());
    expect(searchDelegates).toHaveBeenCalledWith({
      workspace: 'default',
      query: 'foo',
      limit: 20,
    });
  });

  it('default → listDelegates', async () => {
    const listDelegates = vi.fn(async () => []);
    vi.doMock('@/lib/delegates', () => ({
      getDelegate: vi.fn(),
      listDelegates,
      searchDelegates: vi.fn(),
    }));
    vi.doMock('@/lib/workspace-registry', () => ({
      activeWorkspaceId: vi.fn(() => 'default'),
    }));
    const { default: tool } = await import('@/lib/agent-tools/delegates/list');
    await tool.handler({ status: 'archived' }, MAKE_CTX());
    expect(listDelegates).toHaveBeenCalledWith({
      workspace: 'default',
      status: 'archived',
      limit: 20,
    });
  });

  it('returns empty list gracefully if tables missing', async () => {
    vi.doMock('@/lib/delegates', () => ({
      getDelegate: vi.fn(),
      listDelegates: vi.fn(async () => {
        throw new Error('relation "claude_sessions" does not exist');
      }),
      searchDelegates: vi.fn(),
    }));
    vi.doMock('@/lib/workspace-registry', () => ({
      activeWorkspaceId: vi.fn(() => 'default'),
    }));
    const { default: tool } = await import('@/lib/agent-tools/delegates/list');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ sessions: [] });
  });
});

describe('delegates:inbox', () => {
  it('peek op', async () => {
    const peekDelegateInbox = vi.fn(async () => ({ pending: 3 }));
    vi.doMock('@/lib/delegate-inbox', () => ({
      peekDelegateInbox,
      drainDelegateInbox: vi.fn(),
      pushDelegateInbox: vi.fn(),
    }));
    vi.doMock('@/lib/workspace-registry', () => ({
      activeWorkspaceId: vi.fn(() => 'default'),
    }));
    const { default: tool } = await import('@/lib/agent-tools/delegates/inbox');
    const result = await tool.handler({ op: 'peek' }, MAKE_CTX());
    expect(peekDelegateInbox).toHaveBeenCalledWith({ workspaceId: 'default' });
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ pending: { pending: 3 } });
  });

  it('drain op', async () => {
    const items = [{ id: 'i1' }];
    const drainDelegateInbox = vi.fn(async () => items);
    vi.doMock('@/lib/delegate-inbox', () => ({
      peekDelegateInbox: vi.fn(),
      drainDelegateInbox,
      pushDelegateInbox: vi.fn(),
    }));
    vi.doMock('@/lib/workspace-registry', () => ({
      activeWorkspaceId: vi.fn(() => 'default'),
    }));
    const { default: tool } = await import('@/lib/agent-tools/delegates/inbox');
    const result = await tool.handler({ op: 'drain' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ items });
  });

  it('push op', async () => {
    const pushDelegateInbox = vi.fn(async () => undefined);
    vi.doMock('@/lib/delegate-inbox', () => ({
      peekDelegateInbox: vi.fn(),
      drainDelegateInbox: vi.fn(),
      pushDelegateInbox,
    }));
    vi.doMock('@/lib/workspace-registry', () => ({
      activeWorkspaceId: vi.fn(() => 'default'),
    }));
    const { default: tool } = await import('@/lib/agent-tools/delegates/inbox');
    await tool.handler(
      { op: 'push', headline: 'hi', kind: 'todo', agentSessionId: 'cs1' },
      MAKE_CTX(),
    );
    expect(pushDelegateInbox).toHaveBeenCalledWith({
      workspaceId: 'default',
      headline: 'hi',
      kind: 'todo',
      agentSessionId: 'cs1',
    });
  });
});

describe('agents:list', () => {
  it('forwards slug + limit to listAgentsAcrossWorkspace', async () => {
    const agents = [{ slug: 'sheets', role: 'worker' }];
    const listAgentsAcrossWorkspace = vi.fn(async () => agents);
    vi.doMock('@/lib/agents-list', () => ({ listAgentsAcrossWorkspace }));
    const { default: tool } = await import('@/lib/agent-tools/agents/list');
    const result = await tool.handler({ slug: 'sheets', limit: 5 }, MAKE_CTX());
    expect(listAgentsAcrossWorkspace).toHaveBeenCalledWith({ slug: 'sheets', limit: 5 });
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ agents });
  });

  it('default limit is 40', async () => {
    const listAgentsAcrossWorkspace = vi.fn(async () => []);
    vi.doMock('@/lib/agents-list', () => ({ listAgentsAcrossWorkspace }));
    const { default: tool } = await import('@/lib/agent-tools/agents/list');
    await tool.handler({}, MAKE_CTX());
    expect(listAgentsAcrossWorkspace).toHaveBeenCalledWith({ slug: undefined, limit: 40 });
  });
});
