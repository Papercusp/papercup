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
  it('200 on success (pubkeys revoked)', async () => {
    const deps: RevokeContributorEndpointDeps = {
      revoke: makeRevokeFn({ ok: true, revokedPubkeys: ['ed25519:k1', 'ed25519:k2'], live: true }),
    };
    const res = await handleRevokeContributor(VALID_INPUT, deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.revokedPubkeys).toEqual(['ed25519:k1', 'ed25519:k2']);
    expect(body.live).toBe(true);
  });

  it('200 on success when the live handle is not booted (live:false)', async () => {
    const deps: RevokeContributorEndpointDeps = {
      revoke: makeRevokeFn({ ok: true, revokedPubkeys: ['ed25519:k1'], live: false }),
    };
    const res = await handleRevokeContributor(VALID_INPUT, deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.live).toBe(false);
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

  it('404 on no_target (contributor has no device pubkeys)', async () => {
    const deps: RevokeContributorEndpointDeps = {
      revoke: makeRevokeFn({ ok: false, code: 'no_target' }),
    };
    const res = await handleRevokeContributor(VALID_INPUT, deps);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('no_target');
  });

  it('500 on revoke_failed (substrate publish failed)', async () => {
    const deps: RevokeContributorEndpointDeps = {
      revoke: makeRevokeFn({ ok: false, code: 'revoke_failed', detail: 'no booted handle' }),
    };
    const res = await handleRevokeContributor(VALID_INPUT, deps);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('revoke_failed');
    expect(body.detail).toBe('no booted handle');
  });

  it('passes workspaceId + harnessSlug + githubUserId through to the revoke seam', async () => {
    const revoke = makeRevokeFn({ ok: true, revokedPubkeys: ['ed25519:k1'], live: true });
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
