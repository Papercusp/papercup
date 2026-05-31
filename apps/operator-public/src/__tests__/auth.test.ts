/**
 * auth.test.ts — Cupboard GitHub-bearer auth + repo-permission gating
 * (Plan 2 Phase A, P-005).
 *
 * The cupboard's write paths (publish a harness, claim/supersede) are gated by
 * `resolveGithubBearer` (validate the token via GitHub /user) and
 * `checkRepoPermission` (the caller must have maintain/admin on the repo). Both
 * are pure over `fetch`, so this covers every branch with a mocked fetch — the
 * authorization gates that keep a random token from claiming someone's repo.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveGithubBearer, checkRepoPermission, extractBearer } from '../auth.ts';

const ghRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const reqWith = (auth?: string) =>
  new Request('http://cupboard.example/x', auth ? { headers: { authorization: auth } } : {});

afterEach(() => vi.restoreAllMocks());

describe('resolveGithubBearer', () => {
  it('rejects a missing bearer token', async () => {
    await expect(resolveGithubBearer(reqWith())).rejects.toMatchObject({ reason: 'missing_bearer' });
  });

  it('rejects a malformed authorization header', async () => {
    await expect(resolveGithubBearer(reqWith('token abc'))).rejects.toMatchObject({ reason: 'missing_bearer' });
  });

  it('rejects when GitHub returns 401 (bad token)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ghRes({}, 401));
    await expect(resolveGithubBearer(reqWith('Bearer t'))).rejects.toMatchObject({ reason: 'github_rejected' });
  });

  it('rejects when GitHub returns 403', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ghRes({}, 403));
    await expect(resolveGithubBearer(reqWith('Bearer t'))).rejects.toMatchObject({ reason: 'github_rejected' });
  });

  it('treats a 500 as unreachable (not a rejection)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ghRes({}, 500));
    await expect(resolveGithubBearer(reqWith('Bearer t'))).rejects.toMatchObject({ reason: 'github_unreachable' });
  });

  it('treats a fetch throw as unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    await expect(resolveGithubBearer(reqWith('Bearer t'))).rejects.toMatchObject({ reason: 'github_unreachable' });
  });

  it('rejects a 200 that is missing id/login', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ghRes({ login: 'u' })); // no numeric id
    await expect(resolveGithubBearer(reqWith('Bearer t'))).rejects.toMatchObject({ reason: 'github_rejected' });
  });

  it('resolves a valid token to {id, login}', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ghRes({ id: 42, login: 'octocat' }));
    expect(await resolveGithubBearer(reqWith('Bearer t'))).toEqual({ id: 42, login: 'octocat' });
  });
});

describe('checkRepoPermission', () => {
  const perm = (permissions: Record<string, boolean>) => ghRes({ permissions });

  it('grants maintain when the user has maintain', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(perm({ maintain: true }));
    expect(await checkRepoPermission('t', 'o', 'r', 'maintain')).toMatchObject({ has_permission: true, permission: 'maintain' });
  });

  it('grants maintain when the user is admin (admin implies maintain)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(perm({ admin: true }));
    expect(await checkRepoPermission('t', 'o', 'r', 'maintain')).toMatchObject({ has_permission: true, permission: 'admin' });
  });

  it('denies maintain when the user has neither', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(perm({ push: true }));
    expect((await checkRepoPermission('t', 'o', 'r', 'maintain')).has_permission).toBe(false);
  });

  it('requires admin STRICTLY — maintain is not enough', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(perm({ maintain: true }));
    expect((await checkRepoPermission('t', 'o', 'r', 'admin')).has_permission).toBe(false);
  });

  it('grants admin when the user is admin', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(perm({ admin: true }));
    expect((await checkRepoPermission('t', 'o', 'r', 'admin')).has_permission).toBe(true);
  });

  it('denies on a non-ok repo response (private/unknown → 404)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ghRes({}, 404));
    expect((await checkRepoPermission('t', 'o', 'r', 'maintain')).has_permission).toBe(false);
  });
});

describe('extractBearer', () => {
  it('returns the raw token', () => expect(extractBearer(reqWith('Bearer abc123'))).toBe('abc123'));
  it('returns empty string when absent', () => expect(extractBearer(reqWith())).toBe(''));
});
