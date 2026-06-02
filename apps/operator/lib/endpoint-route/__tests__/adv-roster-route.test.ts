/**
 * Unit tests for GET /api/adv/roster (plan adv-sessions-live-roster, P-003).
 *
 * Drives the route handler directly with a hand-built RouteContext, mocking the
 * two data sources (mergeRoster + listEndedAdvSessions) so the test asserts the
 * route's OWN logic: the {active, ended} envelope, the real dedup wiring, and
 * the ?workspace= scope parsing. mergeRoster's join + dedup internals are unit-
 * tested separately (adv-roster.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

const mergeRosterMock = vi.fn();
const listEndedMock = vi.fn();

// Keep the REAL dedupeEndedAgainstActive (we want to exercise it through the
// handler); override only mergeRoster.
vi.mock('@/lib/adv-roster', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/adv-roster')>()),
  mergeRoster: (...a: unknown[]) => mergeRosterMock(...a),
}));
// Override only listEndedAdvSessions; the handler uses no other adv-sessions fn.
vi.mock('@/lib/adv-sessions', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/adv-sessions')>()),
  listEndedAdvSessions: (...a: unknown[]) => listEndedMock(...a),
}));
// The other routes in the module import these; the roster handler never calls
// them, so stub them to avoid loading the heavy real modules.
vi.mock('@/lib/omp-config', () => ({ readOmpConfig: vi.fn(async () => []) }));
vi.mock('@/lib/omp-sessions', () => ({
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

async function rosterRoute(): Promise<Route> {
  const mod = await import('../routes/adv/sessions');
  const route = (mod.default as Route[]).find((r) => r.method === 'GET' && r.path === '/adv/roster');
  if (!route) throw new Error('GET /adv/roster route not registered');
  return route;
}

async function callRoster(query = ''): Promise<Response> {
  const route = await rosterRoute();
  return route.handler(new Request(`http://localhost:3070/api/adv/roster${query}`, { method: 'GET' }), CTX);
}

beforeEach(() => {
  vi.clearAllMocks();
  mergeRosterMock.mockResolvedValue([]);
  listEndedMock.mockResolvedValue([]);
});

describe('GET /adv/roster', () => {
  it('returns the { active, ended } envelope', async () => {
    mergeRosterMock.mockResolvedValue([{ ownerId: 'su-1', label: 'a' }]);
    listEndedMock.mockResolvedValue([{ id: 9, coordOwnerId: null }]);
    const res = await callRoster();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.active).toEqual([{ ownerId: 'su-1', label: 'a' }]);
    expect(json.ended.map((r: { id: number }) => r.id)).toEqual([9]);
  });

  it('dedupes an ended terminal whose owner is still live in the active roster', async () => {
    mergeRosterMock.mockResolvedValue([{ ownerId: 'su-1' }]);
    listEndedMock.mockResolvedValue([
      { id: 1, coordOwnerId: 'su-1' }, // live above → dropped
      { id: 2, coordOwnerId: 'su-2' }, // genuinely ended → kept
    ]);
    const json = await (await callRoster()).json();
    expect(json.ended.map((r: { id: number }) => r.id)).toEqual([2]);
  });

  it('scopes to the requested workspace; "all"/none → null (every workspace)', async () => {
    await callRoster('?workspace=ws1');
    expect(mergeRosterMock).toHaveBeenLastCalledWith({ workspaceId: 'ws1' });
    expect(listEndedMock).toHaveBeenLastCalledWith({ workspaceId: 'ws1', limit: 50 });

    await callRoster('?workspace=all');
    expect(mergeRosterMock).toHaveBeenLastCalledWith({ workspaceId: null });

    await callRoster();
    expect(mergeRosterMock).toHaveBeenLastCalledWith({ workspaceId: null });
  });

  it('honors a valid endedLimit and ignores a bad one (falls back to 50)', async () => {
    await callRoster('?endedLimit=5');
    expect(listEndedMock).toHaveBeenLastCalledWith({ workspaceId: null, limit: 5 });
    await callRoster('?endedLimit=-3');
    expect(listEndedMock).toHaveBeenLastCalledWith({ workspaceId: null, limit: 50 });
  });
});
