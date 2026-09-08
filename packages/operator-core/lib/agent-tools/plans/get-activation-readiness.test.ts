/**
 * Side-effect-free activation-readiness wiring. The helper owns the dynamic
 * production imports so plans:get and plans:audit can expose the same
 * plans:start candidate preview without opening a consult thread.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({
  getOrgPg: vi.fn(),
  routeConsult: vi.fn(),
  buildQueryEmbedder: vi.fn(),
  resolveSessionStates: vi.fn(),
  planStartConsult: vi.fn(),
  fetchTurnExcerpts: vi.fn(),
}));

vi.mock('@papercusp/db-org', () => ({ getOrgPg: M.getOrgPg }));
vi.mock('../../consult/relevance-router', () => ({ routeConsult: M.routeConsult }));
vi.mock('../search/embedder', () => ({ buildQueryEmbedder: M.buildQueryEmbedder }));
vi.mock('../coordination/liveness-oracle', () => ({ resolveSessionStates: M.resolveSessionStates }));
vi.mock('../../consult/plan-start-consult', () => ({
  planStartConsult: M.planStartConsult,
  fetchTurnExcerpts: M.fetchTurnExcerpts,
}));

import { previewPlanStartConsult } from './get-activation-readiness';

const params = {
  workspaceId: 'workspace-a',
  requesterId: 'su-reader',
  planSlug: 'plan-a',
  planContent: '---\nslug: plan-a\n---\n\n## Now\nship it',
};

beforeEach(() => {
  vi.clearAllMocks();
  const sql = vi.fn();
  M.getOrgPg.mockReturnValue({ sql });
  M.buildQueryEmbedder.mockResolvedValue('embedder');
  M.resolveSessionStates.mockResolvedValue(
    new Map([['peer-live', { ownerId: 'peer-live', sessionState: 'live' }]]),
  );
  M.routeConsult.mockImplementation(async (_routeParams, options) => {
    options.getSql();
    const liveness = await options.getLiveness(['peer-live']);
    return { liveness };
  });
  M.fetchTurnExcerpts.mockResolvedValue([
    {
      ownerId: 'peer-dead',
      session_id: 'session-dead',
      turn_idx: 4,
      ts: null,
      sim: 0.7,
      excerpt: 'prior attempt',
    },
  ]);
});

describe('previewPlanStartConsult', () => {
  it('wires production routing, liveness, and excerpt callbacks without opening a consult', async () => {
    M.planStartConsult.mockImplementation(async (consultParams, deps) => {
      await deps.route({
        workspaceId: consultParams.workspaceId,
        requesterId: consultParams.requesterId,
        question: 'plan query',
      });
      const excerpts = await deps.getExcerpts([{
        ownerId: 'peer-dead',
        evidence: [{ session_id: 'session-dead', turn_idx: 4, ts: null, sim: 0.7 }],
      }]);
      return { outcome: 'proceed_with_excerpts', candidates: [], excerpts };
    });

    const result = await previewPlanStartConsult(params);

    expect(result).toMatchObject({
      outcome: 'proceed_with_excerpts',
      excerpts: [{ ownerId: 'peer-dead', excerpt: 'prior attempt' }],
    });
    expect(M.buildQueryEmbedder).toHaveBeenCalledTimes(1);
    expect(M.planStartConsult).toHaveBeenCalledWith(params, expect.any(Object));
    expect(M.routeConsult).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-a',
        requesterId: 'su-reader',
        question: 'plan query',
      },
      expect.any(Object),
    );
    expect(M.resolveSessionStates).toHaveBeenCalledWith(
      [{ ownerId: 'peer-live' }],
      { hydratePerId: true },
    );
    expect(M.fetchTurnExcerpts).toHaveBeenCalledWith(
      expect.any(Function),
      'workspace-a',
      [{ ownerId: 'peer-dead', evidence: [{ session_id: 'session-dead', turn_idx: 4, ts: null, sim: 0.7 }] }],
    );
  });

  it('reports an unavailable advisory outcome when production wiring cannot initialize', async () => {
    M.buildQueryEmbedder.mockRejectedValue(new Error('embedder unavailable'));

    const result = await previewPlanStartConsult(params);

    expect(result).toEqual({
      outcome: 'unavailable',
      error: 'consult_preview_unavailable',
      message: 'Consult candidate preview could not be evaluated (embedder unavailable).',
    });
    expect(M.planStartConsult).not.toHaveBeenCalled();
  });
});
