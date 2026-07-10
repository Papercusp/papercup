/**
 * Unit tests for work_items:park (modes-and-intake-ux-2026-07-05 P-004).
 * The store (setWorkItemCheckpoint/releaseWorkItem/getWorkItem/sendMessage) is
 * mocked — this exercises the tool's contract, in particular the EI-8824
 * workspaceId-wildcard-normalization fix shared with work_items:checkpoint.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const setWorkItemCheckpoint = vi.fn();
const getWorkItem = vi.fn();
const releaseWorkItem = vi.fn();
const sendMessage = vi.fn();

vi.mock('../../work-item-checkpoint', () => ({
  setWorkItemCheckpoint: (...a: unknown[]) => setWorkItemCheckpoint(...a),
}));
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  releaseWorkItem: (...a: unknown[]) => releaseWorkItem(...a),
}));
vi.mock('../coordination/messages', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));
import park from './park';

const parse = (x: unknown) => (park.args as { parse: (x: unknown) => unknown }).parse(x);
const call = async (x: unknown, ctx: unknown) => {
  const res = (await park.handler(parse(x) as never, ctx as never)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

// EI-8824: force activeWorkspaceId()'s deterministic env-pin precedence (workspace-registry.ts
// precedence #2) instead of mocking the workspace-registry module — resolveConcreteWorkspaceId
// and activeWorkspaceId are same-module internal calls, so overriding the module's exports via
// vi.mock does NOT intercept the internal call resolveConcreteWorkspaceId makes to
// activeWorkspaceId(); only an out-of-module signal (the env var) actually steers it.
const PRIOR_WS_ENV = process.env.PAPERCUSP_WORKSPACE_ID;
afterAll(() => {
  if (PRIOR_WS_ENV === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = PRIOR_WS_ENV;
});

beforeEach(() => {
  process.env.PAPERCUSP_WORKSPACE_ID = 'resolved-concrete-ws';
  setWorkItemCheckpoint.mockReset();
  getWorkItem.mockReset();
  releaseWorkItem.mockReset();
  sendMessage.mockReset();
  getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
  setWorkItemCheckpoint.mockResolvedValue('state');
  releaseWorkItem.mockResolvedValue(true);
  sendMessage.mockResolvedValue(undefined);
});

describe('work_items:park', () => {
  it('persists the checkpoint under a concrete workspace for an ordinary scoped session', async () => {
    const ctx = { uiClientId: 'a1', sigVerifiedSpawn: true, workspaceId: 'default', harnessSlug: 'papercup' };
    const out = await call({ id: 'WI-7', checkpoint: 'did x; left y for continuity', reason: 'redirect' }, ctx);
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: 'papercup', workItemId: 'WI-7', workspaceId: 'default' },
      'did x; left y for continuity',
    );
    expect(out).toMatchObject({ ok: true, id: 'WI-7', released: true });
  });

  it('EI-8824: an unscoped superuser session (ctx.workspaceId "*") never persists the literal wildcard', async () => {
    // Same bug class as work_items:checkpoint — a truthy '*' must never win over the
    // concrete-workspace fallback, or the parked checkpoint silently orphans itself
    // from any concrete-workspace read (e.g. the next claim's re-injection).
    const ctx = { uiClientId: 'su-1', sigVerifiedSpawn: true, workspaceId: '*', harnessSlug: 'papercup' };
    await call({ id: 'WI-7', checkpoint: 'did x; left y for continuity', reason: 'redirect' }, ctx);
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: 'papercup', workItemId: 'WI-7', workspaceId: 'resolved-concrete-ws' },
      'did x; left y for continuity',
    );
  });

  it('releases the claim and sends a best-effort lifecycle note', async () => {
    const ctx = { uiClientId: 'a1', sigVerifiedSpawn: true, workspaceId: 'default', harnessSlug: 'papercup' };
    await call({ id: 'WI-7', checkpoint: 'did x; left y for continuity', reason: 'higher-priority item' }, ctx);
    expect(releaseWorkItem).toHaveBeenCalledWith('WI-7', { harness: 'papercup' });
    expect(sendMessage).toHaveBeenCalled();
  });

  it('a coord note failure never un-parks the item (fail-soft)', async () => {
    sendMessage.mockRejectedValue(new Error('coord down'));
    const ctx = { uiClientId: 'a1', sigVerifiedSpawn: true, workspaceId: 'default', harnessSlug: 'papercup' };
    const out = await call({ id: 'WI-7', checkpoint: 'did x; left y for continuity', reason: 'r' }, ctx);
    expect(out).toMatchObject({ ok: true, released: true, noted: false });
  });
});
