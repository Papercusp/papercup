import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolvePhasedProject = vi.fn();
const readGitStats = vi.fn();

vi.mock('../../../harness-core', () => ({
  resolvePhasedProject: (...args: unknown[]) => resolvePhasedProject(...args),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'private-own' }));
vi.mock('../../../harness/git-stats', async () => {
  const actual = await vi.importActual<typeof import('../../../harness/git-stats')>(
    '../../../harness/git-stats',
  );
  return { ...actual, readGitStats: (...args: unknown[]) => readGitStats(...args) };
});

import routes from './git';

type RouteEntry = {
  path: string;
  handler: (req: Request, ctx: { params: Record<string, string> }) => Promise<Response>;
};

const route = (routes as unknown as RouteEntry[]).find((entry) => entry.path === '/harness/:slug/git/stats')!;

function call(query = ''): Promise<Response> {
  return route.handler(
    new Request(`http://127.0.0.1:3070/api/harness/demo/git/stats${query}`),
    { params: { slug: 'demo' } },
  );
}

beforeEach(() => {
  resolvePhasedProject.mockReset().mockResolvedValue({ slug: 'demo', path: '/repos/demo' });
  readGitStats.mockReset().mockResolvedValue({ measuredAt: '2026-08-13T00:00:00.000Z' });
});

describe('GET /harness/:slug/git/stats', () => {
  it('returns 404 for an unknown pot', async () => {
    resolvePhasedProject.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(readGitStats).not.toHaveBeenCalled();
  });

  it('passes the selected pot path and explicit refresh request to the service', async () => {
    const response = await call('?refresh=1');
    expect(response.status).toBe(200);
    expect(readGitStats).toHaveBeenCalledWith('/repos/demo', { refresh: true });
    expect(await response.json()).toEqual({ stats: { measuredAt: '2026-08-13T00:00:00.000Z' } });
  });

  it('returns an explicit empty state for a non-Git pot', async () => {
    const { NotGitRepositoryError } = await import('../../../harness/git-stats');
    readGitStats.mockRejectedValue(new NotGitRepositoryError());
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stats: null, notAGitRepo: true });
  });

  it('returns a bounded error payload when inspection fails', async () => {
    readGitStats.mockRejectedValue(new Error('git timed out'));
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'git timed out' });
  });
});

describe('Git HTTP workspace boundary', () => {
  it.each(routes as unknown as RouteEntry[])('denies foreign targets on $path before repository inspection', async entry => {
    // The generic resolver can find a foreign slug when no workspace is pinned.
    resolvePhasedProject.mockImplementation(async (_slug, _phase, workspace) =>
      workspace === 'private-own' ? null : { slug: 'foreign', path: '/repos/foreign' });
    const response = await entry.handler(
      new Request('http://127.0.0.1:3070/api/harness/foreign/git/stats?ws=private-foreign'),
      { params: { slug: 'foreign', sha: 'abc1234' } },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'unknown project' });
    expect(readGitStats).not.toHaveBeenCalled();
  });
});
