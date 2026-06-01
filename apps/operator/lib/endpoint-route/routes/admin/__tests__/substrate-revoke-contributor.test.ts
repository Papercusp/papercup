/**
 * substrate-revoke-contributor.test.ts — endpoint tests for handleRevokeContributor.
 *
 * Tests the HTTP-level mapping via `handleRevokeContributor(input, deps)`.
 * All deps injected — no PG, no GitHub, no gh-token.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  handleRevokeContributor,
  type RevokeContributorEndpointInput,
  type RevokeContributorEndpointDeps,
} from '../substrate-revoke-contributor';

const VALID_INPUT: RevokeContributorEndpointInput = {
  workspaceId: 'ws1',
  harnessSlug: 'papercup',
  githubUserId: 12345,
};

function makeRevokeFn(
  result: Awaited<ReturnType<RevokeContributorEndpointDeps['revoke']>>,
): RevokeContributorEndpointDeps['revoke'] {
  return vi.fn(async () => result);
}

describe('handleRevokeContributor', () => {
  it('200 on success (branch deleted)', async () => {
    const deps: RevokeContributorEndpointDeps = {
      revoke: makeRevokeFn({ ok: true, deletedBranch: 'user/12345' }),
    };
    const res = await handleRevokeContributor(VALID_INPUT, deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deletedBranch).toBe('user/12345');
  });

  it('200 on idempotent success (alreadyGone)', async () => {
    const deps: RevokeContributorEndpointDeps = {
      revoke: makeRevokeFn({ ok: true, deletedBranch: 'user/12345', alreadyGone: true }),
    };
    const res = await handleRevokeContributor(VALID_INPUT, deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.alreadyGone).toBe(true);
  });

  it('403 on not_admin', async () => {
    const deps: RevokeContributorEndpointDeps = {
      revoke: makeRevokeFn({ ok: false, code: 'not_admin' }),
    };
    const res = await handleRevokeContributor(VALID_INPUT, deps);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('not_admin');
    expect(body.error).toMatch(/admin/i);
  });

  it('404 on no_context', async () => {
    const deps: RevokeContributorEndpointDeps = {
      revoke: makeRevokeFn({ ok: false, code: 'no_context' }),
    };
    const res = await handleRevokeContributor(VALID_INPUT, deps);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('no_context');
  });

  it('502 on github_error', async () => {
    const deps: RevokeContributorEndpointDeps = {
      revoke: makeRevokeFn({
        ok: false,
        code: 'github_error',
        detail: 'Service Unavailable',
      }),
    };
    const res = await handleRevokeContributor(VALID_INPUT, deps);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('github_error');
    expect(body.detail).toBe('Service Unavailable');
  });

  it('passes workspaceId + harnessSlug + githubUserId through to the revoke seam', async () => {
    const revoke = makeRevokeFn({ ok: true, deletedBranch: 'user/99' });
    const deps: RevokeContributorEndpointDeps = { revoke };
    await handleRevokeContributor(
      { workspaceId: 'ws-test', harnessSlug: 'slug-test', githubUserId: 99 },
      deps,
    );
    expect(revoke).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      harnessSlug: 'slug-test',
      githubUserId: 99,
    });
  });
});
