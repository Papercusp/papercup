/**
 * Unit tests for the `?features=1` branch of GET
 * /api/agent-mcp/console/bootstrap-su/options — the psu --role feature
 * picker source.
 *
 * The sibling bootstrap-su.test.ts covers the no-query (workspace/harness
 * list) + `?harness` (plan-list) branches but NOT the
 * `?harness=X&features=1` branch. This file fills that gap: it asserts the
 * branch maps id/title/status from listFeaturesForHarness, prefers
 * id→feature_id and title→description fallbacks, drops empty-id entries, and
 * surfaces a listing error as a 400.
 *
 * Mocks the heavy leaves (auth, the workspace registry, the feature source)
 * and drives the route handler directly with a hand-built RouteContext —
 * the same harness the sibling test uses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

const listFeaturesForHarnessMock = vi.fn();

vi.mock('../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => {}),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    status = 401;
    reason = 'denied';
  },
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'default',
  readRegistry: () => ({ current: 'default', workspaces: [{ id: 'default', name: 'Default' }] }),
  workspaceById: (id: string) => (id === 'default' ? { id, name: 'Default' } : undefined),
}));
// The branch under test dynamically imports this; mock the feature source.
vi.mock('../../harness-readers', () => ({
  listFeaturesForHarness: (...a: unknown[]) => listFeaturesForHarnessMock(...a),
}));

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

type Route = { method: string; handler: (req: Request, ctx: RouteContext) => Promise<Response> };

async function getRoute(): Promise<Route> {
  const mod = await import('../routes/agent-mcp/bootstrap-su');
  return (mod.default as Route[]).find((r) => r.method === 'GET')!;
}

async function callGet(query: string): Promise<Response> {
  const get = await getRoute();
  const req = new Request(`http://localhost:3070/api/agent-mcp/console/bootstrap-su/options${query}`, {
    method: 'GET',
  });
  return get.handler(req, CTX);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('bootstrap-su options — ?harness=X&features=1', () => {
  it('maps id/title/status from listFeaturesForHarness (staging phase)', async () => {
    listFeaturesForHarnessMock.mockResolvedValue({
      ok: true,
      data: {
        features: [
          { id: 'F-001', title: 'First feature', status: 'in_progress' },
          { id: 'F-002', title: 'Second feature', status: 'passed' },
        ],
      },
    });

    const res = await callGet('?harness=papercup&features=1');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.harness).toBe('papercup');
    expect(json.workspace).toBe('default');
    expect(json.features).toEqual([
      { id: 'F-001', title: 'First feature', status: 'in_progress' },
      { id: 'F-002', title: 'Second feature', status: 'passed' },
    ]);
    // Reads the STAGING phase (the psu --role picker's source).
    expect(listFeaturesForHarnessMock).toHaveBeenCalledWith('papercup', 'staging');
  });

  it('falls back id→feature_id and title→description, and filters out empty-id rows', async () => {
    listFeaturesForHarnessMock.mockResolvedValue({
      ok: true,
      data: {
        features: [
          { feature_id: 'F-010', description: 'Desc-only feature' }, // id/title via fallbacks
          { title: 'No id at all', status: 'blocked' }, // dropped (empty id)
          { id: '', title: 'Empty id' }, // dropped (empty id)
          { id: 'F-011', title: 'Has both', status: null },
        ],
      },
    });

    const json = await (await callGet('?harness=papercup&features=1')).json();
    expect(json.features).toEqual([
      { id: 'F-010', title: 'Desc-only feature', status: null },
      { id: 'F-011', title: 'Has both', status: null },
    ]);
  });

  it('returns an empty feature list when the read is not ok', async () => {
    listFeaturesForHarnessMock.mockResolvedValue({ ok: false, status: 404, error: 'unknown project' });

    const res = await callGet('?harness=ghost&features=1');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.features).toEqual([]);
  });

  it('surfaces a thrown listing error as a 400', async () => {
    listFeaturesForHarnessMock.mockRejectedValue(new Error('features listing blew up'));

    const res = await callGet('?harness=papercup&features=1');
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.status).toBe('error');
    expect(json.error).toBe('features listing blew up');
  });

  it('honors an explicit ?workspace alongside features=1', async () => {
    listFeaturesForHarnessMock.mockResolvedValue({ ok: true, data: { features: [] } });

    const json = await (await callGet('?workspace=default&harness=papercup&features=1')).json();
    expect(json.workspace).toBe('default');
    expect(json.harness).toBe('papercup');
    expect(json.features).toEqual([]);
  });
});
