/**
 * Unit tests for the /api/gym/* control-plane routes (gym-ui-handoff backend).
 * Drives each handler directly with a hand-built RouteContext, mocking the
 * workspace seam (routeWithWorkspace / activeWorkspaceId) + the control-plane
 * SQL helpers — so the test asserts the ROUTE's own logic (param/body parsing,
 * response envelopes, validation 400s, analytics degradation) without a DB. The
 * SQL is covered by control-plane.integration.test.ts. summarizeGymStatus +
 * GYM_PROMPT_KEYS are kept real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

const getPrompts = vi.fn();
const setPrompt = vi.fn();
const listProposals = vi.fn();
const decideProposal = vi.fn();
const getAutoloop = vi.fn();
const setAutoloop = vi.fn();

vi.mock('@/lib/workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
// routeWithWorkspace just runs the callback with a dummy tx (the control-plane fns are mocked).
vi.mock('@/lib/route-workspace', () => ({
  routeWithWorkspace: (fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('@/lib/gym/control-plane', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/gym/control-plane')>()),
  getPrompts: (...a: unknown[]) => getPrompts(...a),
  setPrompt: (...a: unknown[]) => setPrompt(...a),
  listProposals: (...a: unknown[]) => listProposals(...a),
  decideProposal: (...a: unknown[]) => decideProposal(...a),
  getAutoloop: (...a: unknown[]) => getAutoloop(...a),
  setAutoloop: (...a: unknown[]) => setAutoloop(...a),
}));

type Route = { method: string; path: string; handler: (req: Request, ctx: RouteContext) => Promise<Response> };
const ctx = (params: Record<string, string> = {}): RouteContext => ({
  principal: null, input: undefined, params, log: () => {}, signal: new AbortController().signal,
});

async function route(method: string, path: string): Promise<Route> {
  const mod = await import('../routes/gym/control');
  const r = (mod.default as Route[]).find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`route ${method} ${path} not registered`);
  return r;
}
function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3070/api/gym${path}`, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  getPrompts.mockResolvedValue({ judgeRubric: '# r', roles: { worker: 'w' } });
  listProposals.mockResolvedValue([]);
  getAutoloop.mockResolvedValue(null);
  setAutoloop.mockResolvedValue({ enabled: true, status: 'idle', budgetUsd: 10, spentUsd: 0 });
  decideProposal.mockResolvedValue({ ok: true, promoted: true });
  setPrompt.mockResolvedValue(undefined);
});

describe('GET /gym/:slug', () => {
  it('returns harnessSlug + status + prompts + editableKeys', async () => {
    listProposals.mockResolvedValue([{ cycle: 2 }, { cycle: 1 }]);
    getAutoloop.mockResolvedValue({ enabled: true, status: 'running', budgetUsd: 5, spentUsd: 1, lastCycle: 0 });
    const r = await route('GET', '/gym/:slug');
    const res = await r.handler(req('/alpha'), ctx({ slug: 'alpha' }));
    const body = await res.json();
    expect(body.harnessSlug).toBe('alpha');
    expect(body.status.pendingCount).toBe(2);
    expect(body.status.lastCycle).toBe(2);
    expect(body.status.autoloop).toEqual({ enabled: true, status: 'running', budgetUsd: 5, spentUsd: 1 });
    expect(body.prompts.judgeRubric).toBe('# r');
    expect(Array.isArray(body.editableKeys)).toBe(true);
    expect(body.editableKeys).toContain('judge');
  });
});

describe('POST /gym/:slug/prompts', () => {
  it('sets a prompt and returns the updated prompts', async () => {
    const r = await route('POST', '/gym/:slug/prompts');
    const res = await r.handler(req('/alpha/prompts', { method: 'POST', body: JSON.stringify({ role: 'worker', md: 'new' }) }), ctx({ slug: 'alpha' }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(setPrompt).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-test', harnessSlug: 'alpha', role: 'worker', md: 'new' });
  });
  it('400s without a role', async () => {
    const r = await route('POST', '/gym/:slug/prompts');
    const res = await r.handler(req('/alpha/prompts', { method: 'POST', body: JSON.stringify({ md: 'x' }) }), ctx({ slug: 'alpha' }));
    expect(res.status).toBe(400);
  });
  it('400s when setPrompt rejects an invalid key', async () => {
    setPrompt.mockRejectedValue(new Error('not an editable prompt key'));
    const r = await route('POST', '/gym/:slug/prompts');
    const res = await r.handler(req('/alpha/prompts', { method: 'POST', body: JSON.stringify({ role: 'bogus', md: 'x' }) }), ctx({ slug: 'alpha' }));
    expect(res.status).toBe(400);
  });
});

describe('GET /gym/:slug/proposals', () => {
  it('lists pending by default', async () => {
    listProposals.mockResolvedValue([{ id: 'p1' }]);
    const r = await route('GET', '/gym/:slug/proposals');
    const res = await r.handler(req('/alpha/proposals'), ctx({ slug: 'alpha' }));
    const body = await res.json();
    expect(body.proposals).toHaveLength(1);
    expect(listProposals).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-test', harnessSlug: 'alpha', status: 'pending', variantId: undefined });
  });
});

describe('POST /gym/:slug/accept', () => {
  it('decides one proposal by id → promoted', async () => {
    const r = await route('POST', '/gym/:slug/accept');
    const res = await r.handler(req('/alpha/accept', { method: 'POST', body: JSON.stringify({ id: 'p1' }) }), ctx({ slug: 'alpha' }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.decided).toBe(1);
    expect(body.promoted).toBe(1);
    expect(decideProposal).toHaveBeenCalledWith(expect.anything(), { id: 'p1', workspaceId: 'ws-test', harnessSlug: 'alpha', decision: 'accepted' });
  });
  it('decides every pending proposal of a variantId', async () => {
    listProposals.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    const r = await route('POST', '/gym/:slug/accept');
    const res = await r.handler(req('/alpha/accept', { method: 'POST', body: JSON.stringify({ variantId: 'v-1' }) }), ctx({ slug: 'alpha' }));
    const body = await res.json();
    expect(body.decided).toBe(2);
    expect(decideProposal).toHaveBeenCalledTimes(2);
  });
  it('400s without id or variantId', async () => {
    const r = await route('POST', '/gym/:slug/accept');
    const res = await r.handler(req('/alpha/accept', { method: 'POST', body: '{}' }), ctx({ slug: 'alpha' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /gym/:slug/autoloop', () => {
  it('applies a partial patch', async () => {
    const r = await route('POST', '/gym/:slug/autoloop');
    const res = await r.handler(req('/alpha/autoloop', { method: 'POST', body: JSON.stringify({ enabled: true, budgetUsd: 25 }) }), ctx({ slug: 'alpha' }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(setAutoloop).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-test', harnessSlug: 'alpha', enabled: true, budgetUsd: 25 });
  });
});

describe('run-analytics degrade gracefully without a gym DB', () => {
  it('GET /gym/:slug/cycles → available:false, empty', async () => {
    const r = await route('GET', '/gym/:slug/cycles');
    const res = await r.handler(req('/alpha/cycles'), ctx({ slug: 'alpha' }));
    const body = await res.json();
    expect(body.cycles).toEqual([]);
    expect(body.available).toBe(false);
  });
  it('GET /gym/:slug/compare → 400 without a/b/rubricHash', async () => {
    const r = await route('GET', '/gym/:slug/compare');
    const res = await r.handler(req('/alpha/compare'), ctx({ slug: 'alpha' }));
    expect(res.status).toBe(400);
  });
});
