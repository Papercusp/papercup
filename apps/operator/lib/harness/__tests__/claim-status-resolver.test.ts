/**
 * claim-status-resolver.test.ts — Phase 8 P-069 (a/b/e).
 *
 * Pure logic for turning a `shared_repo_binding_cache` row (or absence
 * thereof) + the local viewer's github id into the view-model the live
 * `/adv` HarnessClaimHeader renders: status, claimants, provisional
 * owner, and the viewer-scoped booleans (am I the provisional owner /
 * a claimant / can I claim).
 */

import { describe, it, expect } from 'vitest';
import {
  resolveClaimStatus,
  type ClaimStatusRow,
} from '../claim-status-resolver';

function row(over: Partial<ClaimStatusRow> = {}): ClaimStatusRow {
  return {
    github_repository_id: 12345,
    claim_status: 'unclaimed',
    provisional_owner_github_user_id: 99,
    provisional_owner_github_login: 'octocat',
    claimed_by_github_user_ids: [],
    claimant_logins: {},
    ...over,
  };
}

describe('resolveClaimStatus — no binding row', () => {
  it('null row → unclaimed, no claimants, no binding id, viewer flags false', () => {
    const r = resolveClaimStatus(null, 99);
    expect(r.status).toBe('unclaimed');
    expect(r.claimants).toEqual([]);
    expect(r.bindingId).toBeNull();
    expect(r.provisionalOwnerLogin).toBeNull();
    expect(r.isProvisionalOwner).toBe(false);
    expect(r.isClaimant).toBe(false);
    expect(r.viewerCanClaim).toBe(false);
  });
});

describe('resolveClaimStatus — unclaimed binding', () => {
  it('exposes the provisional owner + binding id; viewer who is the owner sees isProvisionalOwner', () => {
    const r = resolveClaimStatus(row(), 99);
    expect(r.status).toBe('unclaimed');
    expect(r.bindingId).toBe('github:12345');
    expect(r.provisionalOwnerLogin).toBe('octocat');
    expect(r.isProvisionalOwner).toBe(true);
    expect(r.isClaimant).toBe(false);
  });

  it('a different viewer is NOT the provisional owner', () => {
    const r = resolveClaimStatus(row(), 7);
    expect(r.isProvisionalOwner).toBe(false);
  });

  it('anonymous viewer (null id) → all viewer flags false', () => {
    const r = resolveClaimStatus(row(), null);
    expect(r.isProvisionalOwner).toBe(false);
    expect(r.isClaimant).toBe(false);
    expect(r.viewerCanClaim).toBe(false);
  });
});

describe('resolveClaimStatus — claimed binding', () => {
  const claimed = row({
    claim_status: 'claimed',
    claimed_by_github_user_ids: [42, 7],
    claimant_logins: { 42: 'alice', 7: 'bob' },
  });

  it('lead claimant login is the first claimant; claimants list resolves logins', () => {
    const r = resolveClaimStatus(claimed, 999);
    expect(r.status).toBe('claimed');
    expect(r.claimantLogin).toBe('alice');
    expect(r.claimants).toEqual([
      { githubUserId: 42, login: 'alice' },
      { githubUserId: 7, login: 'bob' },
    ]);
  });

  it('a claimant viewer sees isClaimant=true', () => {
    expect(resolveClaimStatus(claimed, 7).isClaimant).toBe(true);
    expect(resolveClaimStatus(claimed, 999).isClaimant).toBe(false);
  });

  it('falls back to a synthetic login when a claimant id has no login mapping', () => {
    const r = resolveClaimStatus(
      row({ claim_status: 'claimed', claimed_by_github_user_ids: [555], claimant_logins: {} }),
      1,
    );
    expect(r.claimants).toEqual([{ githubUserId: 555, login: null }]);
    expect(r.claimantLogin).toBeNull();
  });
});

describe('resolveClaimStatus — viewerCanClaim hint', () => {
  it('unclaimed → viewerCanClaim true for a known viewer (server gates the real perm check)', () => {
    expect(resolveClaimStatus(row({ claim_status: 'unclaimed' }), 99).viewerCanClaim).toBe(true);
  });

  it('stale → viewerCanClaim true (re-claim path)', () => {
    expect(resolveClaimStatus(row({ claim_status: 'stale' }), 99).viewerCanClaim).toBe(true);
  });

  it('claimed → viewerCanClaim false (no double-claim CTA)', () => {
    expect(
      resolveClaimStatus(
        row({ claim_status: 'claimed', claimed_by_github_user_ids: [1], claimant_logins: { 1: 'x' } }),
        99,
      ).viewerCanClaim,
    ).toBe(false);
  });

  it('superseded → viewerCanClaim false', () => {
    expect(resolveClaimStatus(row({ claim_status: 'superseded' }), 99).viewerCanClaim).toBe(false);
  });

  it('anonymous viewer never canClaim even when unclaimed', () => {
    expect(resolveClaimStatus(row({ claim_status: 'unclaimed' }), null).viewerCanClaim).toBe(false);
  });
});

describe('claimantSummary copy', () => {
  it('describes a single claimant', () => {
    const r = resolveClaimStatus(
      row({ claim_status: 'claimed', claimed_by_github_user_ids: [1], claimant_logins: { 1: 'alice' } }),
      9,
    );
    expect(r.claimantSummary).toBe('Claimed by @alice.');
  });

  it('describes a claimant + others', () => {
    const r = resolveClaimStatus(
      row({
        claim_status: 'claimed',
        claimed_by_github_user_ids: [1, 2, 3],
        claimant_logins: { 1: 'alice', 2: 'bob', 3: 'carol' },
      }),
      9,
    );
    expect(r.claimantSummary).toBe('Claimed by @alice + 2 others.');
  });

  it('unclaimed → provisional-owner summary', () => {
    const r = resolveClaimStatus(row({ claim_status: 'unclaimed' }), 9);
    expect(r.claimantSummary).toBe('Unclaimed — @octocat is the provisional owner.');
  });

  it('unclaimed + viewer IS the provisional owner → "you are" copy', () => {
    const r = resolveClaimStatus(row({ claim_status: 'unclaimed' }), 99);
    expect(r.claimantSummary).toBe("Unclaimed — you're the provisional owner.");
  });

  it('null row → unclaimed (no binding yet) copy', () => {
    expect(resolveClaimStatus(null, 9).claimantSummary).toBe('This harness has no shared binding yet.');
  });
});
