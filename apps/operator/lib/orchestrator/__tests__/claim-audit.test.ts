/**
 * claim-audit — validation tests.
 *
 * PG writes are covered by integration suites; here we exercise
 * the validation shape so callers get clear errors at the boundary.
 */

import { describe, expect, it } from 'vitest';
import {
  ClaimAuditValidationError,
  recordClaimAttempt,
  _testing,
} from '../claim-audit';

describe('claim-audit validation', () => {
  it('rejects missing workspaceId', async () => {
    await expect(
      recordClaimAttempt({ workspaceId: '', harnessSlug: 's', feature_id: 'F-1', claimer_pubkey: 'p', outcome: 'won' }),
    ).rejects.toBeInstanceOf(ClaimAuditValidationError);
  });

  it('rejects missing harnessSlug', async () => {
    await expect(
      recordClaimAttempt({ workspaceId: 'w', harnessSlug: '', feature_id: 'F-1', claimer_pubkey: 'p', outcome: 'won' }),
    ).rejects.toBeInstanceOf(ClaimAuditValidationError);
  });

  it('rejects missing feature_id', async () => {
    await expect(
      recordClaimAttempt({ workspaceId: 'w', harnessSlug: 's', feature_id: '', claimer_pubkey: 'p', outcome: 'won' }),
    ).rejects.toBeInstanceOf(ClaimAuditValidationError);
  });

  it('rejects missing claimer_pubkey', async () => {
    await expect(
      recordClaimAttempt({ workspaceId: 'w', harnessSlug: 's', feature_id: 'F-1', claimer_pubkey: '', outcome: 'won' }),
    ).rejects.toBeInstanceOf(ClaimAuditValidationError);
  });

  it('rejects unknown outcome', async () => {
    await expect(
      recordClaimAttempt({
        workspaceId: 'w', harnessSlug: 's', feature_id: 'F-1', claimer_pubkey: 'p',
        outcome: 'not-a-real-outcome' as 'won',
      }),
    ).rejects.toBeInstanceOf(ClaimAuditValidationError);
  });

  it('OUTCOMES set covers exactly the documented four', () => {
    expect([..._testing.OUTCOMES].sort()).toEqual(['error', 'lost', 'timeout', 'won']);
  });
});
