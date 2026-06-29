import { describe, it, expect, vi, beforeEach } from 'vitest';

const resetMock = vi.fn();
vi.mock('../../../harness/git-reset-to-remote-main', () => ({
  resetToRemoteMain: (...args: unknown[]) => resetMock(...args),
}));

import routes from './git-remote-main';

const post = (routes as unknown as Array<{ method: string; handler: (req: unknown) => Promise<Response> }>).find(
  (r) => r.method === 'POST',
)!;

function jsonReq(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1/api/desktop/git/reset-to-remote-main', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => resetMock.mockReset());

describe('POST /desktop/git/reset-to-remote-main', () => {
  it('refuses a cross-site request with 403 (no reset runs)', async () => {
    const res = await post.handler(jsonReq({}, { 'sec-fetch-site': 'cross-site' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'cross_site_forbidden' });
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('defaults the slug to the papercusp hive and returns 200 on ok', async () => {
    resetMock.mockResolvedValue({ ok: true, slug: 'papercusp', newHead: 'X', recoveryBranch: 'b' });
    const res = await post.handler(jsonReq({}));
    expect(res.status).toBe(200);
    expect(resetMock).toHaveBeenCalledWith(expect.objectContaining({ slug: 'papercusp' }));
    expect(await res.json()).toMatchObject({ ok: true, recoveryBranch: 'b' });
  });

  it('passes an explicit slug + remote/branch through', async () => {
    resetMock.mockResolvedValue({ ok: true, slug: 'myhive' });
    await post.handler(jsonReq({ slug: 'myhive', remote: 'upstream', branch: 'release' }));
    expect(resetMock).toHaveBeenCalledWith({ slug: 'myhive', remote: 'upstream', branch: 'release' });
  });

  it('maps unknown_project→404, git_sync_busy→409, git_failed→500', async () => {
    resetMock.mockResolvedValueOnce({ ok: false, slug: 'x', error: 'unknown_project' });
    expect((await post.handler(jsonReq({ slug: 'x' }))).status).toBe(404);
    resetMock.mockResolvedValueOnce({ ok: false, slug: 'papercusp', error: 'git_sync_busy' });
    expect((await post.handler(jsonReq({}))).status).toBe(409);
    resetMock.mockResolvedValueOnce({ ok: false, slug: 'papercusp', error: 'git_failed:boom' });
    expect((await post.handler(jsonReq({}))).status).toBe(500);
  });
});
