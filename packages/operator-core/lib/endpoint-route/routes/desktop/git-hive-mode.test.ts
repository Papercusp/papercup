/**
 * GET/POST /desktop/git/hive-mode — the hiveGit.mode ops lever (P-306, WI-3500).
 * `hive-git-mode.ts`'s accessors are mocked; the route's guards + dispatch are the
 * unit under test (mirrors git-pot-green-cmd.test.ts's shape).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getModeMock = vi.fn();
const setModeMock = vi.fn();

vi.mock('../../../harness/git-sync/hive-git-mode', async () => {
  const actual = await vi.importActual<typeof import('../../../harness/git-sync/hive-git-mode')>(
    '../../../harness/git-sync/hive-git-mode',
  );
  return {
    ...actual,
    getPotGitMode: (...a: unknown[]) => getModeMock(...a),
    setPotGitMode: (...a: unknown[]) => setModeMock(...a),
  };
});

import routes from './git-hive-mode';

type RouteEntry = { method: string; handler: (req: unknown) => Promise<Response> };
const routeList = routes as unknown as RouteEntry[];
const get = routeList.find((r) => r.method === 'GET')!;
const post = routeList.find((r) => r.method === 'POST')!;

function jsonReq(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1/api/desktop/git/hive-mode', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function getReq(qs: string) {
  return new Request(`http://127.0.0.1/api/desktop/git/hive-mode${qs}`, { method: 'GET' });
}

beforeEach(() => {
  getModeMock.mockReset();
  setModeMock.mockReset().mockResolvedValue(undefined);
});

describe('GET /desktop/git/hive-mode', () => {
  it('400 on a missing slug', async () => {
    const res = await get.handler(getReq(''));
    expect(res.status).toBe(400);
    expect(getModeMock).not.toHaveBeenCalled();
  });

  it('reads the mode for the default workspace', async () => {
    getModeMock.mockResolvedValue('bridged');
    const res = await get.handler(getReq('?slug=shared-hive-test-hive-2'));
    expect(res.status).toBe(200);
    expect(getModeMock).toHaveBeenCalledWith('default', 'shared-hive-test-hive-2');
    expect(await res.json()).toMatchObject({ ok: true, slug: 'shared-hive-test-hive-2', mode: 'bridged' });
  });

  it('honors an explicit ?workspace=', async () => {
    getModeMock.mockResolvedValue('legacy');
    await get.handler(getReq('?slug=h&workspace=papercusp-workspace'));
    expect(getModeMock).toHaveBeenCalledWith('papercusp-workspace', 'h');
  });
});

describe('POST /desktop/git/hive-mode', () => {
  it('refuses a cross-site request with 403 (no write)', async () => {
    const res = await post.handler(jsonReq({ slug: 'h', mode: 'bridged' }, { 'sec-fetch-site': 'cross-site' }));
    expect(res.status).toBe(403);
    expect(setModeMock).not.toHaveBeenCalled();
  });

  it('400 on a missing slug', async () => {
    expect((await post.handler(jsonReq({ mode: 'bridged' }))).status).toBe(400);
    expect(setModeMock).not.toHaveBeenCalled();
  });

  it('400 on an invalid mode', async () => {
    const res = await post.handler(jsonReq({ slug: 'h', mode: 'yolo' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_mode' });
    expect(setModeMock).not.toHaveBeenCalled();
  });

  it('sets the mode (explicit workspace) and returns the re-read value', async () => {
    getModeMock.mockResolvedValue('bridged');
    const res = await post.handler(
      jsonReq({ slug: 'shared-hive-test-hive-2', mode: 'bridged', workspace: 'papercusp-workspace' }),
    );
    expect(res.status).toBe(200);
    expect(setModeMock).toHaveBeenCalledWith('papercusp-workspace', 'shared-hive-test-hive-2', 'bridged');
    expect(await res.json()).toMatchObject({ ok: true, mode: 'bridged', cleared: false });
  });

  it('a null/omitted mode CLEARS the row (rollback to legacy)', async () => {
    getModeMock.mockResolvedValue('legacy');
    const res = await post.handler(jsonReq({ slug: 'h', mode: null }));
    expect(res.status).toBe(200);
    expect(setModeMock).toHaveBeenCalledWith('default', 'h', null);
    expect(await res.json()).toMatchObject({ ok: true, mode: 'legacy', cleared: true });
  });

  it('409 when the write fails (e.g. no such Hive)', async () => {
    setModeMock.mockRejectedValue(new Error('no Hive'));
    const res = await post.handler(jsonReq({ slug: 'nope', mode: 'bridged' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'mode_write_failed' });
  });
});
