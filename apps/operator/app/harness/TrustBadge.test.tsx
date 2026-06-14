// TrustBadge classifier coverage (shared-hive-trust-admission-2026-06-14 Phase 4 /
// P-011, Trust A4): the work-item author trust-state chip. Pure — tests the
// trustBadgeState classifier over the WorkItem provenance fields (origin /
// auditVerdict / verifiedAuthorGithubUserId) + the trust-list membership flag.
import { describe, expect, it } from 'vitest';
import { trustBadgeState } from './TrustBadge';

const remote = { origin: 'remote' as string | null, auditVerdict: null as string | null, verifiedAuthorGithubUserId: null as number | null, trusted: false };

describe('trustBadgeState (Trust A4 work-item badge)', () => {
  it('renders NO badge for local-origin work (no cross-author trust dimension)', () => {
    expect(trustBadgeState({ ...remote, origin: 'local' })).toBeNull();
    expect(trustBadgeState({ ...remote, origin: null })).toBeNull();
  });

  it('trusted: remote + verified author on the owner trust list', () => {
    const s = trustBadgeState({ origin: 'remote', auditVerdict: 'admit', verifiedAuthorGithubUserId: 42, trusted: true });
    expect(s?.label).toBe('trusted');
    expect(s?.title).toContain('42');
  });

  it('admitted: remote, auditor admitted, author NOT trusted', () => {
    expect(trustBadgeState({ ...remote, auditVerdict: 'admit', verifiedAuthorGithubUserId: 42 })?.label).toBe('admitted');
  });

  it('rejected: remote, auditor rejected', () => {
    expect(trustBadgeState({ ...remote, auditVerdict: 'reject' })?.label).toBe('rejected');
  });

  it('pending audit: remote, no verdict yet (null or pending)', () => {
    expect(trustBadgeState({ ...remote, auditVerdict: null })?.label).toBe('pending audit');
    expect(trustBadgeState({ ...remote, auditVerdict: 'pending' })?.label).toBe('pending audit');
  });

  it('trusted takes precedence over an adverse verdict (the grant auto-runs verified work)', () => {
    expect(
      trustBadgeState({ origin: 'remote', auditVerdict: 'reject', verifiedAuthorGithubUserId: 7, trusted: true })?.label,
    ).toBe('trusted');
  });
});
