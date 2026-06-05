/**
 * binding-claim.test.ts — Phase 8 P-069e. Unit tests for the pure
 * claim-then-map logic (`runClaim`) + the BindingServiceError → HTTP
 * mapping (`httpForClaimError`). claimBinding injected (no GitHub/PG):
 * asserts the body-validation, the structured-error pass-through, and
 * the status mapping for the permission-denied case the CTA surfaces.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runClaim,
  httpForClaimError,
  parseClaimBody,
  ClaimInputError,
} from '../binding-claim';
import {
  BindingServiceErrorThrowable,
  type BindingRecord,
} from '../../../../harness/binding-types';

function binding(over: Partial<BindingRecord> = {}): BindingRecord {
  return {
    provider: 'github',
    github_repository_id: 12345,
    github_full_name: 'Papercusp/papercup',
    harness_topic: 'a'.repeat(64),
    harness_slug: 'papercup',
    harness_link: 'papercusp://harness?topic=...',
    privacy: 'shared-private',
    claim_status: 'claimed',
    provisional_owner_github_user_id: 99,
    provisional_owner_github_login: 'octocat',
    claimed_by_github_user_ids: [42],
    created_at: '2026-05-30T00:00:00Z',
    ...over,
  };
}

describe('parseClaimBody', () => {
  it('accepts a github binding id', () => {
    expect(parseClaimBody({ binding_id: 'github:12345' })).toEqual({ ok: true, bindingId: 'github:12345' });
  });
  it('rejects a missing binding id', () => {
    expect(parseClaimBody({}).ok).toBe(false);
    expect(parseClaimBody(null).ok).toBe(false);
  });
  it('rejects a non-string binding id', () => {
    expect(parseClaimBody({ binding_id: 5 }).ok).toBe(false);
  });
});

describe('runClaim', () => {
  it('returns the updated binding on success', async () => {
    const claimBinding = vi.fn(async () => binding());
    const r = await runClaim('github:12345', { claimBinding });
    expect(claimBinding).toHaveBeenCalledWith({ binding_id: 'github:12345' });
    expect(r.binding.claim_status).toBe('claimed');
  });

  it('rejects an empty binding id without calling claimBinding', async () => {
    const claimBinding = vi.fn(async () => binding());
    await expect(runClaim('', { claimBinding })).rejects.toBeInstanceOf(ClaimInputError);
    expect(claimBinding).not.toHaveBeenCalled();
  });

  it('propagates a BindingServiceErrorThrowable from claimBinding', async () => {
    const claimBinding = vi.fn(async () => {
      throw new BindingServiceErrorThrowable({
        code: 'CLAIM_PERMISSION_DENIED',
        actual: 'read',
        required: 'maintain or admin',
      });
    });
    await expect(runClaim('github:12345', { claimBinding })).rejects.toBeInstanceOf(
      BindingServiceErrorThrowable,
    );
  });
});

describe('httpForClaimError', () => {
  it('maps CLAIM_PERMISSION_DENIED → 403 with the structured perm detail', () => {
    const r = httpForClaimError({
      code: 'CLAIM_PERMISSION_DENIED',
      actual: 'read',
      required: 'maintain or admin',
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: 'CLAIM_PERMISSION_DENIED', actual: 'read', required: 'maintain or admin' });
  });

  it('maps BINDING_NOT_FOUND → 404', () => {
    expect(httpForClaimError({ code: 'BINDING_NOT_FOUND' }).status).toBe(404);
  });

  it('maps BINDING_NOT_CLAIMABLE → 409', () => {
    expect(httpForClaimError({ code: 'BINDING_NOT_CLAIMABLE', reason: 'superseded' }).status).toBe(409);
  });

  it('maps GITHUB_API_DOWN → 502', () => {
    expect(httpForClaimError({ code: 'GITHUB_API_DOWN', message: 'x' }).status).toBe(502);
  });

  it('maps GITHUB_API_RATE_LIMIT → 429 with Retry-After seconds', () => {
    const r = httpForClaimError({ code: 'GITHUB_API_RATE_LIMIT', retry_after_ms: 5000 });
    expect(r.status).toBe(429);
    expect(r.retryAfterSec).toBe(5);
  });
});
