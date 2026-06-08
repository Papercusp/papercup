/**
 * Tests for resolveClaimStatus — the pure HarnessClaimHeader view-model
 * (binding-cache row + viewer id → badge/claimant/summary + viewer predicates).
 * Run with: cd packages/operator-core && npx vitest run lib/harness/claim-status-resolver.test.ts
 */
import { describe, expect, it } from 'vitest';
import { resolveClaimStatus, type ClaimStatusRow } from './claim-status-resolver';

const row = (over: Partial<ClaimStatusRow> = {}): ClaimStatusRow => ({
  github_repository_id: 555,
  claim_status: 'unclaimed',
  provisional_owner_github_user_id: 1,
  provisional_owner_github_login: 'owner',
  claimed_by_github_user_ids: [],
  claimant_logins: {},
  ...over,
});

describe('resolveClaimStatus — no binding', () => {
  it('returns the no-binding shape for a null row', () => {
    const r = resolveClaimStatus(null, 42);
    expect(r.status).toBe('unclaimed');
    expect(r.bindingId).toBeNull();
    expect(r.claimants).toEqual([]);
    expect(r.viewerCanClaim).toBe(false);
    expect(r.claimantSummary).toBe('This harness has no shared binding yet.');
  });
});

describe('resolveClaimStatus — unclaimed', () => {
  it('lets a known viewer claim and flags the provisional owner', () => {
    const r = resolveClaimStatus(row({ provisional_owner_github_user_id: 42, provisional_owner_github_login: 'me' }), 42);
    expect(r.bindingId).toBe('github:555');
    expect(r.isProvisionalOwner).toBe(true);
    expect(r.viewerCanClaim).toBe(true);
    expect(r.claimantSummary).toBe("Unclaimed — you're the provisional owner.");
  });

  it('shows the owner login when the viewer is someone else', () => {
    const r = resolveClaimStatus(row(), 99);
    expect(r.isProvisionalOwner).toBe(false);
    expect(r.viewerCanClaim).toBe(true);
    expect(r.claimantSummary).toBe('Unclaimed — @owner is the provisional owner.');
  });

  it('does not offer the CTA to an anonymous viewer', () => {
    expect(resolveClaimStatus(row(), null).viewerCanClaim).toBe(false);
  });
});

describe('resolveClaimStatus — claimed', () => {
  it('resolves claimant logins, the lead, and the viewer-is-claimant flag', () => {
    const r = resolveClaimStatus(
      row({ claim_status: 'claimed', claimed_by_github_user_ids: [10, 20], claimant_logins: { 10: 'alice', 20: 'bob' } }),
      20,
    );
    expect(r.status).toBe('claimed');
    expect(r.claimantLogin).toBe('alice');
    expect(r.claimants).toEqual([
      { githubUserId: 10, login: 'alice' },
      { githubUserId: 20, login: 'bob' },
    ]);
    expect(r.isClaimant).toBe(true);
    expect(r.viewerCanClaim).toBe(false); // claimed is not claimable
    expect(r.claimantSummary).toBe('Claimed by @alice + 1 other.');
  });

  it('falls back to "user <id>" when a claimant has no login mapping', () => {
    const r = resolveClaimStatus(row({ claim_status: 'claimed', claimed_by_github_user_ids: [10], claimant_logins: {} }), null);
    expect(r.claimantLogin).toBeNull();
    expect(r.claimantSummary).toBe('Claimed by user 10.');
  });

  it('pluralizes "others" for 3+ claimants', () => {
    const r = resolveClaimStatus(
      row({ claim_status: 'claimed', claimed_by_github_user_ids: [1, 2, 3], claimant_logins: { 1: 'a' } }),
      null,
    );
    expect(r.claimantSummary).toBe('Claimed by @a + 2 others.');
  });
});

describe('resolveClaimStatus — stale & superseded', () => {
  it('stale is claimable and carries the re-enabled copy', () => {
    const r = resolveClaimStatus(row({ claim_status: 'stale' }), 7);
    expect(r.viewerCanClaim).toBe(true);
    expect(r.claimantSummary).toMatch(/lost their GitHub permission/);
  });

  it('superseded resolves a successor href', () => {
    const r = resolveClaimStatus(row({ claim_status: 'superseded', superseded_by_harness_topic: 'topic-x' }), 7);
    expect(r.supersededByHref).toBe('papercusp://harness?topic=topic-x');
    expect(r.viewerCanClaim).toBe(false);
    expect(r.claimantSummary).toMatch(/superseded/);
  });
});
