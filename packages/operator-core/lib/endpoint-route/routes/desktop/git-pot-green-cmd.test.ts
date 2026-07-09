/**
 * POST /desktop/git/pot-green-cmd — the /admin/git per-hive green-command edit (P-014).
 * The resolver + the override store are mocked; the route's guards + set/clear dispatch are
 * the unit under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveEnvMock = vi.fn();
const setMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('../../../harness/routines/hive-release-env', () => ({
  resolveHiveReleaseEnv: (...a: unknown[]) => resolveEnvMock(...a),
}));
vi.mock('../../../hive-settings-store', () => ({
  setReleaseGreenCmdOverride: (...a: unknown[]) => setMock(...a),
  deleteReleaseGreenCmdOverride: (...a: unknown[]) => deleteMock(...a),
}));

import routes from './git-pot-green-cmd';

const post = (routes as unknown as Array<{ method: string; handler: (req: unknown) => Promise<Response> }>).find(
  (r) => r.method === 'POST',
)!;

function jsonReq(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1/api/desktop/git/pot-green-cmd', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resolveEnvMock.mockReset();
  setMock.mockReset().mockResolvedValue(undefined);
  deleteMock.mockReset().mockResolvedValue(true);
});

describe('POST /desktop/git/pot-green-cmd', () => {
  it('refuses a cross-site request with 403 (no write)', async () => {
    const res = await post.handler(jsonReq({ slug: 'h', greenCmd: 'x' }, { 'sec-fetch-site': 'cross-site' }));
    expect(res.status).toBe(403);
    expect(setMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('400 on a missing slug', async () => {
    expect((await post.handler(jsonReq({}))).status).toBe(400);
    expect(resolveEnvMock).not.toHaveBeenCalled();
  });

  it('404 when the hive is not gated', async () => {
    resolveEnvMock.mockResolvedValue({ enabled: false, reason: 'gate_disabled', isOperatorHome: false });
    const res = await post.handler(jsonReq({ slug: 'work-hive', greenCmd: 'x' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: 'not_gated', reason: 'gate_disabled' });
    expect(setMock).not.toHaveBeenCalled();
  });

  it('400 for the operator-home (no override — regression-safe)', async () => {
    resolveEnvMock.mockResolvedValue({ enabled: true, isOperatorHome: true });
    const res = await post.handler(jsonReq({ slug: 'papercusp', greenCmd: 'x' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'operator_home' });
    expect(setMock).not.toHaveBeenCalled();
  });

  it('sets the override and returns the re-resolved command', async () => {
    resolveEnvMock
      .mockResolvedValueOnce({ enabled: true, isOperatorHome: false }) // guard
      .mockResolvedValueOnce({ enabled: true, isOperatorHome: false, greenCmd: 'npm run gate:custom', greenCmdOverridden: true }); // after
    const res = await post.handler(jsonReq({ slug: 'c-hive', greenCmd: 'npm run gate:custom' }));
    expect(res.status).toBe(200);
    expect(setMock).toHaveBeenCalledWith('default', 'c-hive', 'npm run gate:custom');
    expect(deleteMock).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({
      ok: true,
      slug: 'c-hive',
      greenCmd: 'npm run gate:custom',
      greenCmdOverridden: true,
      cleared: false,
    });
  });

  it('a blank greenCmd CLEARS the override (revert to detected default)', async () => {
    resolveEnvMock
      .mockResolvedValueOnce({ enabled: true, isOperatorHome: false })
      .mockResolvedValueOnce({ enabled: true, isOperatorHome: false, greenCmd: 'npm run test:affected', greenCmdOverridden: false });
    const res = await post.handler(jsonReq({ slug: 'c-hive', greenCmd: '   ' }));
    expect(res.status).toBe(200);
    expect(deleteMock).toHaveBeenCalledWith('default', 'c-hive');
    expect(setMock).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ ok: true, cleared: true, greenCmdOverridden: false });
  });

  it('409 when the override write fails (slug is a code member, not a hive home)', async () => {
    resolveEnvMock.mockResolvedValue({ enabled: true, isOperatorHome: false });
    setMock.mockRejectedValue(new Error('no Hive'));
    const res = await post.handler(jsonReq({ slug: 'oddsmith', greenCmd: 'x' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'override_write_failed' });
  });
});
