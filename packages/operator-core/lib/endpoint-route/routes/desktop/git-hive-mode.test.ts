/**
 * GET/POST /desktop/git/hive-mode — the hiveGit.mode ops lever (P-306, WI-3500).
 * `hive-git-mode.ts`'s accessors are mocked; the route's guards + dispatch are the
 * unit under test (mirrors git-pot-green-cmd.test.ts's shape).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readModeMock = vi.fn();
const setModeMock = vi.fn();

vi.mock('../../../harness/git-sync/hive-git-mode', async () => {
  const actual = await vi.importActual<typeof import('../../../harness/git-sync/hive-git-mode')>(
    '../../../harness/git-sync/hive-git-mode',
  );
  return {
    ...actual,
    readPotGitMode: (...a: unknown[]) => readModeMock(...a),
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
  readModeMock.mockReset();
  setModeMock.mockReset().mockResolvedValue(undefined);
});

describe('GET /desktop/git/hive-mode', () => {
  it('400 on a missing slug', async () => {
    const res = await get.handler(getReq(''));
    expect(res.status).toBe(400);
    expect(readModeMock).not.toHaveBeenCalled();
  });

  it('400 on a missing workspace (EI-14076: no silent default-tenant fallback)', async () => {
    const res = await get.handler(getReq('?slug=shared-hive-test-hive-2'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'missing_workspace' });
    expect(readModeMock).not.toHaveBeenCalled();
  });

  it('reads the mode for an explicit ?workspace=', async () => {
    readModeMock.mockResolvedValue({ mode: 'legacy', source: 'absent' });
    const res = await get.handler(getReq('?slug=h&workspace=papercusp-workspace'));
    expect(res.status).toBe(200);
    expect(readModeMock).toHaveBeenCalledWith('papercusp-workspace', 'h');
    expect(await res.json()).toMatchObject({
      ok: true,
      slug: 'h',
      workspaceId: 'papercusp-workspace',
      mode: 'legacy',
      source: 'absent',
    });
  });

  it('503 instead of presenting a settings-store failure as owner-chosen legacy', async () => {
    readModeMock.mockResolvedValue({ mode: 'legacy', source: 'error' });
    const res = await get.handler(getReq('?slug=h&workspace=papercusp-workspace'));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, error: 'mode_read_failed' });
  });
});

describe('POST /desktop/git/hive-mode', () => {
  it('refuses a cross-site request with 403 (no write)', async () => {
    const res = await post.handler(jsonReq({ slug: 'h', mode: 'bridged' }, { 'sec-fetch-site': 'cross-site' }));
    expect(res.status).toBe(403);
    expect(setModeMock).not.toHaveBeenCalled();
  });

  it('400 on a missing slug', async () => {
    expect((await post.handler(jsonReq({ mode: 'bridged', workspace: 'papercusp-workspace' }))).status).toBe(400);
    expect(setModeMock).not.toHaveBeenCalled();
  });

  it('400 on a missing workspace (EI-14076: no silent default-tenant fallback)', async () => {
    const res = await post.handler(jsonReq({ slug: 'h', mode: 'bridged' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'missing_workspace' });
    expect(setModeMock).not.toHaveBeenCalled();
  });

  it('400 on an invalid mode', async () => {
    const res = await post.handler(jsonReq({ slug: 'h', mode: 'yolo', workspace: 'papercusp-workspace' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_mode' });
    expect(setModeMock).not.toHaveBeenCalled();
  });

  it('sets the mode (explicit workspace) and returns the re-read value', async () => {
    readModeMock.mockResolvedValue({ mode: 'bridged', source: 'set' });
    const res = await post.handler(
      jsonReq({ slug: 'shared-hive-test-hive-2', mode: 'bridged', workspace: 'papercusp-workspace' }),
    );
    expect(res.status).toBe(200);
    expect(setModeMock).toHaveBeenCalledWith('papercusp-workspace', 'shared-hive-test-hive-2', 'bridged');
    expect(await res.json()).toMatchObject({ ok: true, mode: 'bridged', source: 'set', cleared: false });
  });

  it('a null/omitted mode CLEARS the row (rollback to legacy)', async () => {
    readModeMock.mockResolvedValue({ mode: 'legacy', source: 'absent' });
    const res = await post.handler(jsonReq({ slug: 'h', mode: null, workspace: 'papercusp-workspace' }));
    expect(res.status).toBe(200);
    expect(setModeMock).toHaveBeenCalledWith('papercusp-workspace', 'h', null);
    expect(await res.json()).toMatchObject({ ok: true, mode: 'legacy', source: 'absent', cleared: true });
  });

  it('fails closed when the post-write verification read is unavailable', async () => {
    readModeMock.mockResolvedValue({ mode: 'legacy', source: 'error' });
    const res = await post.handler(
      jsonReq({ slug: 'h', mode: 'bridged', workspace: 'papercusp-workspace' }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, error: 'mode_verify_failed', writeApplied: true });
  });

  it('reports a post-write mismatch instead of claiming the requested mode', async () => {
    readModeMock.mockResolvedValue({ mode: 'legacy', source: 'absent' });
    const res = await post.handler(
      jsonReq({ slug: 'h', mode: 'bridged', workspace: 'papercusp-workspace' }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: 'mode_verify_mismatch',
      expected: 'bridged',
      actual: 'legacy',
      source: 'absent',
      writeApplied: true,
    });
  });

  it('409 when the write fails (e.g. no such Hive)', async () => {
    setModeMock.mockRejectedValue(new Error('no Hive'));
    const res = await post.handler(jsonReq({ slug: 'nope', mode: 'bridged', workspace: 'papercusp-workspace' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'mode_write_failed' });
  });
});
