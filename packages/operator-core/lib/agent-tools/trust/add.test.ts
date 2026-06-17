/**
 * trust:add / trust:remove / trust:list handler unit tests (TR1) —
 * shared-hive-trust-admission-2026-06-14 / P-009.
 *
 * Trust is a SECURITY GRANT and the workspace it lands in is a PRIVILEGE
 * BOUNDARY. Each handler resolves the target workspace as
 * `principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId()`
 * (add.ts:37-38, remove.ts:31-32, list.ts:29-30). These PG-free tests pin that
 * resolution per-tool by mocking `../../workspace-registry` (activeWorkspaceId)
 * + `../../trust/user-trust-list` (the store), and assert the resolved ws is the
 * one threaded into the store call:
 *   (a) principal ws 'ws-1'         → store called with 'ws-1'
 *   (b) principal ws '*'            → falls back to activeWorkspaceId()  ← the
 *                                      security-sensitive branch
 *   (c) no principal                → falls back to activeWorkspaceId()
 *   (d) store rejects (add)         → { ok:false, reason, isError:true }
 *   (e) actor defaults to 'agent'   → store called with actor:'agent'
 *
 * The handlers `await import()` their deps, so we vi.resetModules() + vi.doMock
 * then dynamically import the tool (mirrors processes/__tests__/kill.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ACTIVE_WS = 'ws-active';

type Body = Record<string, unknown>;
const body = (r: { content: Array<{ text: string }> }): Body => JSON.parse(r.content[0]!.text);

/** A ctx with the given principal fields; pass `null` to omit the principal entirely. */
function ctxWith(principal: { workspaceId?: string; slug?: string } | null): unknown {
  return { principal: principal ?? undefined } as never;
}

let activeWorkspaceId: ReturnType<typeof vi.fn>;
let addTrustedUser: ReturnType<typeof vi.fn>;
let removeTrustedUser: ReturnType<typeof vi.fn>;
let listTrustedUsers: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  activeWorkspaceId = vi.fn(() => ACTIVE_WS);
  addTrustedUser = vi.fn(async () => ({ githubUserId: 42, note: null, createdTs: 1000 }));
  removeTrustedUser = vi.fn(async () => ({ removed: true }));
  listTrustedUsers = vi.fn(async () => [{ githubUserId: 42, note: null, createdTs: 1000 }]);
  vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId }));
  vi.doMock('../../trust/user-trust-list', () => ({ addTrustedUser, removeTrustedUser, listTrustedUsers }));
});

afterEach(() => {
  vi.doUnmock('../../workspace-registry');
  vi.doUnmock('../../trust/user-trust-list');
});

async function addTool() {
  return (await import('./add')).default as unknown as {
    handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  };
}
async function removeTool() {
  return (await import('./remove')).default as unknown as {
    handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  };
}
async function listTool() {
  return (await import('./list')).default as unknown as {
    handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  };
}

describe('trust:add — workspace resolution (privilege boundary)', () => {
  it('(a) principal workspace is honoured — store called with that ws', async () => {
    const tool = await addTool();
    const res = body(await tool.handler({ githubUserId: 42 }, ctxWith({ workspaceId: 'ws-1', slug: 'owner' })));
    expect(addTrustedUser).toHaveBeenCalledTimes(1);
    expect(addTrustedUser.mock.calls[0]![0]).toBe('ws-1');
    expect(activeWorkspaceId).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, workspaceId: 'ws-1' });
  });

  it("(b) SECURITY: principal workspace '*' falls back to the active workspace, NOT '*'", async () => {
    const tool = await addTool();
    const res = body(await tool.handler({ githubUserId: 42 }, ctxWith({ workspaceId: '*', slug: 'owner' })));
    expect(addTrustedUser.mock.calls[0]![0]).toBe(ACTIVE_WS);
    expect(addTrustedUser.mock.calls[0]![0]).not.toBe('*');
    expect(activeWorkspaceId).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: true, workspaceId: ACTIVE_WS });
  });

  it('(c) no principal falls back to the active workspace', async () => {
    const tool = await addTool();
    const res = body(await tool.handler({ githubUserId: 42 }, ctxWith(null)));
    expect(addTrustedUser.mock.calls[0]![0]).toBe(ACTIVE_WS);
    expect(res).toMatchObject({ ok: true, workspaceId: ACTIVE_WS });
  });

  it('(d) a rejecting store yields the error envelope { ok:false, reason, isError:true }', async () => {
    addTrustedUser.mockRejectedValueOnce(new Error('boom-add'));
    const tool = await addTool();
    const res = await tool.handler({ githubUserId: 42 }, ctxWith({ workspaceId: 'ws-1' }));
    expect(res.isError).toBe(true);
    expect(body(res)).toMatchObject({ ok: false, reason: 'boom-add' });
  });

  it('(e) actor defaults to "agent" when the principal has no slug', async () => {
    const tool = await addTool();
    await tool.handler({ githubUserId: 42 }, ctxWith({ workspaceId: 'ws-1' }));
    expect(addTrustedUser.mock.calls[0]![1]).toMatchObject({ actor: 'agent', githubUserId: 42, note: null });
  });

  it('threads the principal slug + note through as the audit actor', async () => {
    const tool = await addTool();
    await tool.handler({ githubUserId: 42, note: 'co-maintainer' }, ctxWith({ workspaceId: 'ws-1', slug: 'su-owner' }));
    expect(addTrustedUser.mock.calls[0]![1]).toMatchObject({ actor: 'su-owner', note: 'co-maintainer' });
  });
});

describe('trust:remove — workspace resolution (privilege boundary)', () => {
  it('(a) principal workspace is honoured', async () => {
    const tool = await removeTool();
    const res = body(await tool.handler({ githubUserId: 7 }, ctxWith({ workspaceId: 'ws-1', slug: 'owner' })));
    expect(removeTrustedUser).toHaveBeenCalledWith('ws-1', 7, 'owner');
    expect(activeWorkspaceId).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, workspaceId: 'ws-1', githubUserId: 7, removed: true });
  });

  it("(b) SECURITY: principal workspace '*' falls back to the active workspace", async () => {
    const tool = await removeTool();
    const res = body(await tool.handler({ githubUserId: 7 }, ctxWith({ workspaceId: '*', slug: 'owner' })));
    expect(removeTrustedUser).toHaveBeenCalledWith(ACTIVE_WS, 7, 'owner');
    expect(activeWorkspaceId).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: true, workspaceId: ACTIVE_WS });
  });

  it('(c) no principal falls back to the active workspace + actor "agent"', async () => {
    const tool = await removeTool();
    await tool.handler({ githubUserId: 7 }, ctxWith(null));
    expect(removeTrustedUser).toHaveBeenCalledWith(ACTIVE_WS, 7, 'agent');
  });

  it('projects removed:false from the store verbatim', async () => {
    removeTrustedUser.mockResolvedValueOnce({ removed: false });
    const tool = await removeTool();
    const res = body(await tool.handler({ githubUserId: 7 }, ctxWith({ workspaceId: 'ws-1' })));
    expect(res).toMatchObject({ ok: true, removed: false });
  });
});

describe('trust:list — workspace resolution (privilege boundary)', () => {
  it('(a) principal workspace is honoured', async () => {
    const tool = await listTool();
    const res = body(await tool.handler({}, ctxWith({ workspaceId: 'ws-1', slug: 'owner' })));
    expect(listTrustedUsers).toHaveBeenCalledWith('ws-1');
    expect(activeWorkspaceId).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, workspaceId: 'ws-1', count: 1 });
  });

  it("(b) SECURITY: principal workspace '*' falls back to the active workspace", async () => {
    const tool = await listTool();
    const res = body(await tool.handler({}, ctxWith({ workspaceId: '*', slug: 'owner' })));
    expect(listTrustedUsers).toHaveBeenCalledWith(ACTIVE_WS);
    expect(activeWorkspaceId).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: true, workspaceId: ACTIVE_WS });
  });

  it('(c) no principal falls back to the active workspace', async () => {
    const tool = await listTool();
    await tool.handler({}, ctxWith(null));
    expect(listTrustedUsers).toHaveBeenCalledWith(ACTIVE_WS);
  });

  it('reports the trusted-user count from the store', async () => {
    listTrustedUsers.mockResolvedValueOnce([
      { githubUserId: 1, note: null, createdTs: 1 },
      { githubUserId: 2, note: 'x', createdTs: 2 },
    ]);
    const tool = await listTool();
    const res = body(await tool.handler({}, ctxWith({ workspaceId: 'ws-1' })));
    expect(res).toMatchObject({ ok: true, count: 2 });
    expect((res.trusted as unknown[]).length).toBe(2);
  });
});
