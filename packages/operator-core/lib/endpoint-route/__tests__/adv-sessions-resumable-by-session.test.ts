import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WI-10003198 (plan review-routing-through-relevance-router-2026-09-26, P-002):
 * `GET /adv/sessions/resumable?sessionId=<uuid>` resolves a native session to its
 * tracked row through resolveResumeTarget — the session_turns owner bridge the
 * consult dispatcher uses — and asks listResumableSessions for exactly that row.
 *
 * Why it exists: psu found a consult source's transcript on disk but could not
 * find its row. An earlier carry-respawn incarnation has no row of its own (a
 * respawn rewrites its owner's row in place), and older rows fall outside the
 * bounded window, so every fork/convert of such a source was refused (measured
 * 2026-09-26: 52 of 52 refused sources were one of the two).
 */

const state = vi.hoisted(() => ({
  resolveCalls: [] as unknown[],
  listCalls: [] as Array<{ limit: number; opts: unknown }>,
  resolve: null as null | ((ref: unknown) => unknown),
}));

vi.mock('../../agent-launch-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-launch-core')>()),
  resolveResumeTarget: async (ref: unknown) => {
    state.resolveCalls.push(ref);
    return state.resolve?.(ref);
  },
}));
vi.mock('../../adv-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../adv-sessions')>()),
  listResumableSessions: async (limit: number, opts: unknown) => {
    state.listCalls.push({ limit, opts });
    return [{ id: 29793, agent: 'claude', sessionId: 'f56ecb13-112b-4e1b-931b-34af1c6f274b', cwd: '/repo', coordOwnerId: 'su-5078d176' }];
  },
}));
vi.mock('../../session-archive', () => ({
  pgSessionArchiveStore: () => ({ readStamp: async () => null }),
}));

type Route = { method: string; path: string; handler: (request: Request) => Promise<Response> };
const EARLIER = 'fa2b9674-2646-42fa-9135-3909f93fcd9a';

async function get(query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const routes = (await import('../routes/adv/sessions')).default as Route[];
  const route = routes.find((r) => r.method === 'GET' && r.path === '/adv/sessions/resumable');
  if (!route) throw new Error('resumable route was not registered');
  const res = await route.handler(new Request(`http://localhost:3170/api/adv/sessions/resumable${query}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  state.resolveCalls = [];
  state.listCalls = [];
  state.resolve = () => ({ ok: true, advSessionId: 29793, ownerId: 'su-5078d176' });
});

describe('adv/sessions resumable ?sessionId= (WI-10003198)', () => {
  it('bridges a native session to its tracked row and returns that row as `exact`', async () => {
    const { status, body } = await get(`?sessionId=${EARLIER}`);
    expect(status).toBe(200);
    expect(state.resolveCalls).toEqual([{ sessionId: EARLIER }]);
    expect(state.listCalls).toEqual([{ limit: 30, opts: { exactId: 29793 } }]);
    expect(body.exact).toEqual({ id: 29793, ownerId: 'su-5078d176', requestedSessionId: EARLIER });
  });

  it('an unresolvable session reads exactly as before: no exact row, no `exact` key', async () => {
    state.resolve = () => ({ ok: false, error: 'not_found', detail: 'no row' });
    const { body } = await get(`?sessionId=${EARLIER}`);
    expect(state.listCalls).toEqual([{ limit: 30, opts: { exactId: null } }]);
    expect(body).not.toHaveProperty('exact');
  });

  it('never resolves a non-uuid value, and an explicit ?id= wins without a session lookup', async () => {
    await get('?sessionId=not-a-uuid');
    expect(state.resolveCalls).toEqual([]);
    expect(state.listCalls.at(-1)).toEqual({ limit: 30, opts: { exactId: null } });

    const { body } = await get(`?id=41&sessionId=${EARLIER}`);
    expect(state.resolveCalls).toEqual([]);
    expect(state.listCalls.at(-1)).toEqual({ limit: 30, opts: { exactId: 41 } });
    expect(body).not.toHaveProperty('exact');
  });
});
