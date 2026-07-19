/**
 * EI-1625 — a shared-hive MEMBER's claim-status read falls back to the
 * Cupboard central listing when the local `shared_repo_binding_cache` row is
 * absent (the common case: the cache is workspace-scoped and never
 * federates, so a joiner never gets a row for the owner's claim and the
 * route previously always rendered "unclaimed" — an active falsehood for a
 * hive the owner HAS claimed).
 */
import { describe, test, expect, vi } from 'vitest';
import { resolveCupboardClaimFallback } from './claim-status';

function fakeRegistry(projects: Array<{ slug: string; github_repository_id?: number }>) {
  return async () => ({
    projects: projects.map((p) => ({ path: `/tmp/${p.slug}`, ...p })),
  });
}

function fakeFetch(body: unknown, ok = true) {
  return vi.fn(async () => ({
    ok,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('resolveCupboardClaimFallback (EI-1625)', () => {
  test('no github_repository_id on the registry entry → null (no fallback possible)', async () => {
    const result = await resolveCupboardClaimFallback('some-slug', 'ws-1', null, {
      loadRegistry: fakeRegistry([{ slug: 'some-slug' }]),
      fetchFn: fakeFetch({ exists: false }),
    });
    expect(result).toBeNull();
  });

  test('slug not found in the registry → null', async () => {
    const result = await resolveCupboardClaimFallback('missing-slug', 'ws-1', null, {
      loadRegistry: fakeRegistry([{ slug: 'other-slug', github_repository_id: 42 }]),
      fetchFn: fakeFetch({ exists: false }),
    });
    expect(result).toBeNull();
  });

  test('Cupboard reports the hive CLAIMED — a member now sees the real status', async () => {
    const result = await resolveCupboardClaimFallback('acme-web', 'ws-2', null, {
      loadRegistry: fakeRegistry([{ slug: 'acme-web', github_repository_id: 12345 }]),
      fetchFn: fakeFetch({
        exists: true,
        harness: {
          claim_status: 'claimed',
          claimant_github_login: 'alice',
          publisher_github_login: 'alice',
        },
      }),
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe('claimed');
    expect(result!.claimant_login).toBe('alice');
    expect(result!.summary).toBe('Claimed by @alice.');
    // Viewer-scoped predicates stay conservatively false — Cupboard gives
    // logins, not numeric ids, so we never fabricate a claim-CTA state.
    expect(result!.viewer_is_provisional_owner).toBe(false);
    expect(result!.viewer_is_claimant).toBe(false);
    expect(result!.viewer_can_claim).toBe(false);
  });

  test('Cupboard has no listing for this repo → null (caller falls back to no-binding)', async () => {
    const result = await resolveCupboardClaimFallback('local-only', 'ws-3', null, {
      loadRegistry: fakeRegistry([{ slug: 'local-only', github_repository_id: 999 }]),
      fetchFn: fakeFetch({ exists: false }),
    });
    expect(result).toBeNull();
  });

  test('Cupboard unreachable (fetch throws) → null, never throws', async () => {
    const result = await resolveCupboardClaimFallback('acme-web', 'ws-4', null, {
      loadRegistry: fakeRegistry([{ slug: 'acme-web', github_repository_id: 12345 }]),
      fetchFn: vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  test('Cupboard HTTP error status → null', async () => {
    const result = await resolveCupboardClaimFallback('acme-web', 'ws-5', null, {
      loadRegistry: fakeRegistry([{ slug: 'acme-web', github_repository_id: 12345 }]),
      fetchFn: fakeFetch({}, false),
    });
    expect(result).toBeNull();
  });

  test('registry load throws → null, never throws', async () => {
    const result = await resolveCupboardClaimFallback('acme-web', 'ws-6', null, {
      loadRegistry: async () => {
        throw new Error('registry read failed');
      },
      fetchFn: fakeFetch({ exists: false }),
    });
    expect(result).toBeNull();
  });

  test('Cupboard reports UNCLAIMED with a known provisional owner', async () => {
    const result = await resolveCupboardClaimFallback('acme-web', 'ws-7', null, {
      loadRegistry: fakeRegistry([{ slug: 'acme-web', github_repository_id: 777 }]),
      fetchFn: fakeFetch({
        exists: true,
        harness: {
          claim_status: 'unclaimed',
          claimant_github_login: null,
          publisher_github_login: 'bob',
        },
      }),
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe('unclaimed');
    expect(result!.summary).toBe('Unclaimed — @bob is the provisional owner.');
  });
});
