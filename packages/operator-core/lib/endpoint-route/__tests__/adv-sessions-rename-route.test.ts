/**
 * POST /api/adv/sessions/rename — the human half of the display-name write path
 * (plan hud-session-display-names-2026-08-31, P-007).
 *
 * Drives the route handler directly, with the store mocked, so these assert the
 * ROUTE's own logic rather than the SQL (which store.test.ts owns): which
 * workspace the name is written under, that `set_by` says a human did it, that
 * a keyless request is refused rather than guessed at, and that the roster is
 * invalidated so an open board updates without a reload.
 *
 * The workspace resolution is the one worth pinning. The READERS key by the
 * owner's coord_presence workspace, so a route that wrote under the operator's
 * ambient workspace would store the name where nothing looks for it — a rename
 * that silently does nothing, which looks exactly like one that worked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

const setAgentDisplayNameMock = vi.fn();
const resolveOwnerWorkspaceIdMock = vi.fn();
const activeWorkspaceIdMock = vi.fn();
const notifySyncInvalidateMock = vi.fn(async (..._args: unknown[]) => {});

vi.mock('../../display-names/store', () => ({
  setAgentDisplayName: (...a: unknown[]) => setAgentDisplayNameMock(...a),
  resolveOwnerWorkspaceId: (...a: unknown[]) => resolveOwnerWorkspaceIdMock(...a),
}));
vi.mock('../../workspace-registry', async (importActual) => ({
  ...(await importActual<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: (...a: unknown[]) => activeWorkspaceIdMock(...a),
}));
vi.mock('../../sync-sse', () => ({
  notifySyncInvalidate: (...a: unknown[]) => notifySyncInvalidateMock(...a),
}));
// Imported by sibling routes in the same module; the rename handler never calls
// them, so stub them rather than load the heavy real modules.
vi.mock('../../omp-config', () => ({ readOmpConfig: vi.fn(async () => []) }));
vi.mock('../../omp-sessions', () => ({
  findOmpSessionNear: vi.fn(),
  getOmpSessionRowSummary: vi.fn(),
  getOmpSessionState: vi.fn(),
  searchOmpSessions: vi.fn(),
}));

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

type Route = { method: string; path: string; handler: (req: Request, ctx: RouteContext) => Promise<Response> };

async function callRename(body: unknown): Promise<Response> {
  const mod = await import('../routes/adv/sessions');
  const route = (mod.default as Route[]).find(
    (r) => r.method === 'POST' && r.path === '/adv/sessions/rename',
  );
  if (!route) throw new Error('POST /adv/sessions/rename route not registered');
  return route.handler(
    new Request('http://localhost:3070/api/adv/sessions/rename', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    CTX,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveOwnerWorkspaceIdMock.mockResolvedValue('owner-ws');
  activeWorkspaceIdMock.mockReturnValue('ambient-ws');
  setAgentDisplayNameMock.mockResolvedValue({
    ownerId: 'su-a',
    displayName: 'release wrangler',
    cleared: false,
  });
});

describe('POST /adv/sessions/rename', () => {
  it('writes under the OWNER’s presence workspace, not the operator’s ambient one', async () => {
    const res = await callRename({ ownerId: 'su-a', name: 'release wrangler' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: 'ok',
      workspaceId: 'owner-ws',
      displayName: 'release wrangler',
      cleared: false,
    });
    expect(setAgentDisplayNameMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'owner-ws', ownerId: 'su-a', name: 'release wrangler' }),
    );
    expect(activeWorkspaceIdMock).not.toHaveBeenCalled();
  });

  it('falls back to the ambient workspace only when the owner has no presence row', async () => {
    resolveOwnerWorkspaceIdMock.mockResolvedValue(null);
    await callRename({ ownerId: 'su-a', name: 'n' });
    expect(setAgentDisplayNameMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ambient-ws' }),
    );
  });

  it('survives a presence-read failure rather than failing the rename', async () => {
    resolveOwnerWorkspaceIdMock.mockRejectedValue(new Error('pg down'));
    const res = await callRename({ ownerId: 'su-a', name: 'n' });
    expect(res.status).toBe(200);
    expect(setAgentDisplayNameMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ambient-ws' }),
    );
  });

  it('honours an explicit workspace over both', async () => {
    await callRename({ ownerId: 'su-a', name: 'n', workspace: 'pinned-ws' });
    expect(setAgentDisplayNameMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'pinned-ws' }),
    );
    expect(resolveOwnerWorkspaceIdMock).not.toHaveBeenCalled();
  });

  // A human at the popup. An agent naming itself goes through sessions:rename,
  // which stamps its own coord ownerId — that difference is the only thing a
  // later surface has to tell the two apart.
  it('stamps set_by as the owner', async () => {
    await callRename({ ownerId: 'su-a', name: 'n' });
    expect(setAgentDisplayNameMock).toHaveBeenCalledWith(
      expect.objectContaining({ setBy: 'owner' }),
    );
  });

  // R6: the store owns the blank-clears rule, so the route must hand a blank
  // THROUGH rather than filtering it — filtering it here would make the popup's
  // clear silently do nothing.
  it('passes a blank name through to the store, which clears', async () => {
    setAgentDisplayNameMock.mockResolvedValue({ ownerId: 'su-a', displayName: null, cleared: true });
    const res = await callRename({ ownerId: 'su-a', name: '   ' });
    expect(setAgentDisplayNameMock).toHaveBeenCalledWith(expect.objectContaining({ name: '   ' }));
    await expect(res.json()).resolves.toMatchObject({ displayName: null, cleared: true });
  });

  it('treats an omitted name as a clear', async () => {
    setAgentDisplayNameMock.mockResolvedValue({ ownerId: 'su-a', displayName: null, cleared: true });
    await callRename({ ownerId: 'su-a' });
    expect(setAgentDisplayNameMock).toHaveBeenCalledWith(expect.objectContaining({ name: null }));
  });

  it('invalidates the roster so an open board updates without a reload', async () => {
    await callRename({ ownerId: 'su-a', name: 'n' });
    expect(notifySyncInvalidateMock).toHaveBeenCalledWith('roster');
  });

  const invalidRenameInputs: Array<[unknown, string]> = [
    [{ name: 'n' }, 'no ownerId'],
    [{ ownerId: '   ', name: 'n' }, 'a blank ownerId'],
    ['not json at all', 'an unparseable body'],
  ];
  it.each(invalidRenameInputs)('refuses %j (%s) with a 400 instead of guessing a target', async (body) => {
    const res = await callRename(body);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ status: 'error' });
    expect(setAgentDisplayNameMock).not.toHaveBeenCalled();
  });

  it('reports a store failure as a 500 rather than a silent ok', async () => {
    setAgentDisplayNameMock.mockRejectedValue(new Error('constraint violated'));
    const res = await callRename({ ownerId: 'su-a', name: 'n' });
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('constraint violated'),
    });
    // Nothing changed, so nothing should tell the board it did.
    expect(notifySyncInvalidateMock).not.toHaveBeenCalled();
  });
});
