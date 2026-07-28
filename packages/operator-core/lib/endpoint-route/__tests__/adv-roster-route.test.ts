/**
 * Unit tests for GET /api/adv/roster (plan adv-sessions-live-roster, P-003).
 *
 * Drives the route handler directly with a hand-built RouteContext, mocking the
 * two data sources (mergeRosterWithAssignments + listEndedAdvSessions) so the
 * test asserts the route's OWN logic: the {active, ended, orphanedClaims}
 * envelope, the real dedup wiring, and the ?workspace= scope parsing. The
 * merge's join + dedup + claims internals are unit-tested separately
 * (adv-roster.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

const mergeRosterMock = vi.fn();
const listEndedMock = vi.fn();
const listPendingMock = vi.fn();
const listStartingMock = vi.fn();
const getAgentDetailMock = vi.fn();

// Keep the REAL dedupeEndedAgainstActive (we want to exercise it through the
// handler); override only mergeRosterWithAssignments.
vi.mock('../../adv-roster', async (importActual) => ({
  ...(await importActual<typeof import('../../adv-roster')>()),
  mergeRosterWithAssignments: (...a: unknown[]) => mergeRosterMock(...a),
}));
// Override the adv-sessions data sources the /adv/roster handler calls:
// listEndedAdvSessions AND listPendingWorkbenchLaunches (the handler Promise.all's
// both). Mocking both keeps this a pure UNIT test — without the listPending mock the
// handler opens a real PG connection (ECONNREFUSED off the dev box), so the suite
// silently depended on a live Postgres.
vi.mock('../../adv-sessions', async (importActual) => ({
  ...(await importActual<typeof import('../../adv-sessions')>()),
  listEndedAdvSessions: (...a: unknown[]) => listEndedMock(...a),
  listPendingWorkbenchLaunches: (...a: unknown[]) => listPendingMock(...a),
  // WI-6376: the handler Promise.all's this one too — unmocked it would hit real
  // PG, the exact live-Postgres dependency the listPending mock above exists to
  // remove.
  listStartingTerminalLaunches: (...a: unknown[]) => listStartingMock(...a),
}));
// The /adv/roster/agent handler delegates wholesale to getAgentDetail; its
// locks + coord internals are unit-tested in adv-agent-detail.test.ts.
vi.mock('../../adv-agent-detail', () => ({
  getAgentDetail: (...a: unknown[]) => getAgentDetailMock(...a),
}));
// The other routes in the module import these; the roster handler never calls
// them, so stub them to avoid loading the heavy real modules.
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

async function agentDetailRoute(): Promise<Route> {
  const mod = await import('../routes/adv/sessions');
  const route = (mod.default as Route[]).find(
    (r) => r.method === 'GET' && r.path === '/adv/roster/agent',
  );
  if (!route) throw new Error('GET /adv/roster/agent route not registered');
  return route;
}

async function callAgentDetail(query = ''): Promise<Response> {
  const route = await agentDetailRoute();
  return route.handler(
    new Request(`http://localhost:3070/api/adv/roster/agent${query}`, { method: 'GET' }),
    CTX,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mergeRosterMock.mockResolvedValue({ active: [], orphanedClaims: [] });
  listEndedMock.mockResolvedValue([]);
  // Unmocked vi.fn() resolves to undefined, which pendingLaunchesToRosterEntries
  // (called unconditionally by the handler) then .map()s over and throws — every
  // test in this file crashed on this until a default was added here.
  listPendingMock.mockResolvedValue([]);
  listStartingMock.mockResolvedValue([]); // same reason as listPendingMock above
  getAgentDetailMock.mockResolvedValue({ ownerId: 'su-1', locks: {}, coord: {} });
});

describe('GET /adv/roster', () => {
  it('returns the { active, ended, orphanedClaims } envelope', async () => {
    mergeRosterMock.mockResolvedValue({
      active: [{ ownerId: 'su-1', label: 'a' }],
      orphanedClaims: [{ source: 'plan_item_claim', agent: 'su-dead', id: 'P-001' }],
    });
    listEndedMock.mockResolvedValue([{ id: 9, coordOwnerId: null }]);
    const res = await callRoster();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.active).toEqual([{ ownerId: 'su-1', label: 'a' }]);
    expect(json.ended.map((r: { id: number }) => r.id)).toEqual([9]);
    // The claim-keyed canonical half (state-not-chat-fleet-state D-002) rides along.
    expect(json.orphanedClaims).toEqual([
      { source: 'plan_item_claim', agent: 'su-dead', id: 'P-001' },
    ]);
  });

  describe('the `starting` tier (WI-6376 — terminal launches during their boot window)', () => {
    const startingRow = (over: Record<string, unknown> = {}) => ({
      id: 77,
      workspaceId: 'ws1',
      planSlug: null,
      agent: 'claude',
      role: null,
      feature: null,
      mode: 'console',
      terminalBin: 'gnome-terminal',
      pid: 999,
      windowId: null,
      ompThreadId: null,
      label: 'claude',
      cwd: null,
      coordOwnerId: 'su-booting',
      sessionId: null,
      display: 'terminal',
      launchArgv: ['psu', '--no-picker'],
      launchedAt: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      ...over,
    });

    it('surfaces a terminal launch that has not registered yet', async () => {
      listStartingMock.mockResolvedValue([startingRow()]);
      const json = await (await callRoster()).json();
      expect(json.starting.map((r: { ownerId: string }) => r.ownerId)).toEqual(['su-booting']);
      expect(json.starting[0].liveness).toBe('pending');
    });

    it('drops it once the session comes online, so the board never double-cards it', async () => {
      mergeRosterMock.mockResolvedValue({ active: [{ ownerId: 'su-booting' }], orphanedClaims: [] });
      listStartingMock.mockResolvedValue([startingRow()]);
      const json = await (await callRoster()).json();
      expect(json.starting).toEqual([]);
      expect(json.active.map((r: { ownerId: string }) => r.ownerId)).toEqual(['su-booting']);
    });

    it('keeps terminal launches OUT of `pending` — that tier is the pui pane queue (D-006)', async () => {
      listStartingMock.mockResolvedValue([startingRow()]);
      const json = await (await callRoster()).json();
      expect(json.pending).toEqual([]);
      expect(json.starting).toHaveLength(1);
    });

    it('scopes to the requested workspace like every other tier', async () => {
      await callRoster('?workspace=ws1');
      expect(listStartingMock).toHaveBeenLastCalledWith({ workspaceId: 'ws1' });
    });
  });

  it('dedupes an ended terminal whose owner is still live in the active roster', async () => {
    mergeRosterMock.mockResolvedValue({ active: [{ ownerId: 'su-1' }], orphanedClaims: [] });
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

  it('round-trips per-agent fleetSlug + fleetColor on active roster rows (WI-1294)', async () => {
    // The merge stamps fleetSlug + the fleet's accent color from fleetByOwner
    // (unit-tested in adv-roster.test.ts). This asserts the route serializes
    // both fields through GET /api/adv/roster to the pui without stripping them,
    // so the fleet-tab agent-row coloring has the data it consumes.
    mergeRosterMock.mockResolvedValue({
      active: [
        { ownerId: 'su-1', label: 'a', fleetSlug: 'atlas', fleetColor: '#86efac' },
        { ownerId: 'su-2', label: 'b', fleetSlug: null, fleetColor: null },
      ],
      orphanedClaims: [],
    });
    const json = await (await callRoster()).json();
    expect(json.active[0]).toMatchObject({ fleetSlug: 'atlas', fleetColor: '#86efac' });
    expect(json.active[1]).toMatchObject({ fleetSlug: null, fleetColor: null });
  });
});

describe('GET /adv/roster/agent', () => {
  it('400s with owner_required when no owner is given', async () => {
    const res = await callAgentDetail();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('owner_required');
    expect(getAgentDetailMock).not.toHaveBeenCalled();
  });

  it('returns the dossier for the requested owner', async () => {
    getAgentDetailMock.mockResolvedValue({
      ownerId: 'su-7',
      locks: { held: [], waiting: [], error: null },
      // `unread` is REQUIRED on the coord detail (adv-agent-detail.ts); this fixture predates
      // it. Empty against a count of 3 is legal — `unreadCount` is the true total, `unread` is
      // bounded server-side, and the surface renders "showing N of M" when they differ.
      coord: { lastMessage: null, unreadCount: 3, unread: [], openHandoffs: [], openEscalations: [], error: null },
    });
    const res = await callAgentDetail('?owner=su-7');
    expect(res.status).toBe(200);
    expect(getAgentDetailMock).toHaveBeenCalledWith('su-7');
    const json = await res.json();
    expect(json.ownerId).toBe('su-7');
    expect(json.coord.unreadCount).toBe(3);
  });

  it('trims whitespace around the owner param', async () => {
    await callAgentDetail('?owner=%20su-7%20');
    expect(getAgentDetailMock).toHaveBeenCalledWith('su-7');
  });
});
