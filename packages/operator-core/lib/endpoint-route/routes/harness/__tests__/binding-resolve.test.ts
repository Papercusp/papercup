/**
 * binding-resolve.test.ts — unit tests for resolveBinding + httpForBindingError
 * (P-068 route). Deps injected (no GitHub/PG): asserts the identity→wizard-shape
 * mapping, the publisher_github_login pass-through, input rejection before any
 * GitHub call, and the BindingServiceError→HTTP status mapping.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  resolveBinding,
  httpForBindingError,
  ResolveBindingError,
  type ResolveBindingDeps,
} from '../binding-resolve';
import type { RepoIdentity } from '../../../../harness/binding-service';
import type { BindingRecord } from '../../../../harness/binding-types';

const REMOTE = 'git@github.com:Papercusp/papercup.git';

function identity(over: Partial<RepoIdentity> = {}): RepoIdentity {
  return {
    github_repository_id: 12345,
    github_owner: 'Papercusp',
    github_repo: 'papercup',
    github_full_name: 'Papercusp/papercup',
    private: false,
    existing_binding: null,
    ...over,
  };
}

function binding(over: Partial<BindingRecord> = {}): BindingRecord {
  return {
    provider: 'github',
    github_repository_id: 12345,
    github_full_name: 'Papercusp/papercup',
    harness_topic: 'a'.repeat(64),
    harness_slug: 'papercup',
    harness_link: 'papercusp://harness?topic=...',
    privacy: 'shared-private',
    claim_status: 'unclaimed',
    provisional_owner_github_user_id: 99,
    provisional_owner_github_login: 'octocat',
    claimed_by_github_user_ids: [],
    created_at: '2026-05-30T00:00:00Z',
    ...over,
  };
}

function deps(over: Partial<ResolveBindingDeps> = {}) {
  const resolveIdentity = vi.fn(async (_url: string) => identity());
  const d: ResolveBindingDeps = { resolveIdentity, ...over };
  return { d, resolveIdentity };
}

describe('resolveBinding', () => {
  it('maps identity with no binding → existing_binding null', async () => {
    const { d, resolveIdentity } = deps();
    const r = await resolveBinding(REMOTE, d);
    expect(resolveIdentity).toHaveBeenCalledWith(REMOTE);
    expect(r).toEqual({
      github_repository_id: 12345,
      github_owner: 'Papercusp',
      github_repo: 'papercup',
      private: false,
      existing_binding: null,
    });
  });

  it('maps an existing binding → publisher_github_login from provisional_owner_github_login', async () => {
    const resolveIdentity = vi.fn(async () =>
      identity({
        existing_binding: binding({ provisional_owner_github_login: 'alice', claim_status: 'claimed' }),
      }),
    );
    const r = await resolveBinding(REMOTE, { resolveIdentity });
    expect(r.existing_binding).toEqual({
      harness_topic: 'a'.repeat(64),
      harness_slug: 'papercup',
      claim_status: 'claimed',
      publisher_github_login: 'alice',
    });
  });

  it('rejects an empty remote (400, no GitHub call)', async () => {
    const { d, resolveIdentity } = deps();
    await expect(resolveBinding('', d)).rejects.toMatchObject({ status: 400 });
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it('rejects an unparseable remote (400, no GitHub call)', async () => {
    const { d, resolveIdentity } = deps();
    await expect(resolveBinding('not-a-github-url', d)).rejects.toBeInstanceOf(ResolveBindingError);
    expect(resolveIdentity).not.toHaveBeenCalled();
  });
});

describe('httpForBindingError', () => {
  it('maps known GitHub error codes to HTTP statuses', () => {
    expect(httpForBindingError({ code: 'GITHUB_REPO_NOT_FOUND' }).status).toBe(404);
    expect(httpForBindingError({ code: 'GITHUB_REPO_PRIVATE_NO_ACCESS' }).status).toBe(403);
    expect(httpForBindingError({ code: 'GITHUB_API_DOWN', message: 'x' }).status).toBe(502);
    const rl = httpForBindingError({ code: 'GITHUB_API_RATE_LIMIT', retry_after_ms: 5000 });
    expect(rl.status).toBe(429);
    expect(rl.retryAfterSec).toBe(5);
  });

  it('maps unexpected (BINDING_*) errors to 500', () => {
    expect(httpForBindingError({ code: 'BINDING_NOT_FOUND' }).status).toBe(500);
  });
});
