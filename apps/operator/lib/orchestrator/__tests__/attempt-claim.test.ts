/**
 * attemptClaimWithAudit — orchestrator pickup helper tests.
 *
 * Mocks both the Autobase handle and the recordClaimAttempt module
 * boundary so the test exercises only the wrapper's wiring:
 *   - won case → audit with outcome:'won', no detail
 *   - lost case → audit with outcome:'lost', detail includes winner
 *   - audit failure → claim outcome still returned; audit_error set
 *   - claim throw (non-validation) → audit attempted as 'error', re-thrown
 *   - claim throw (validation) → propagates without audit
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attemptClaimWithAudit } from '../attempt-claim';
import { ClaimValidationError, type ClaimAutobaseHandle, type MergedClaim, type FeatureClaimRecord } from '../feature-claim';
import { CURRENT_SCHEMA_VERSION } from '../../sync/hyperbee/schema-version';

const recordCalls: Array<Record<string, unknown>> = [];

vi.mock('../claim-audit', async () => {
  const actual = await vi.importActual<typeof import('../claim-audit')>('../claim-audit');
  return {
    ...actual,
    recordClaimAttempt: vi.fn(async (attempt: unknown) => {
      recordCalls.push(attempt as Record<string, unknown>);
    }),
  };
});

beforeEach(() => {
  recordCalls.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

class FakeBase implements ClaimAutobaseHandle {
  ledger: MergedClaim[] = [];
  appended: FeatureClaimRecord[] = [];
  private nextSeq = 1;

  constructor(public myPubkey: string, seedLedger: MergedClaim[] = []) {
    this.ledger = [...seedLedger];
    for (const c of seedLedger) {
      if (c.seq >= this.nextSeq) this.nextSeq = c.seq + 1;
    }
  }

  async appendClaim(record: FeatureClaimRecord): Promise<{ seq: number }> {
    this.appended.push(record);
    const seq = this.nextSeq++;
    this.ledger.push({ record, seq });
    return { seq };
  }

  async readClaimsForFeature(feature_id: string): Promise<MergedClaim[]> {
    return this.ledger.filter((c) => c.record.feature_id === feature_id);
  }
}

function rec(over: Partial<FeatureClaimRecord> = {}): FeatureClaimRecord {
  return {
    kind: 'feature_claim',
    feature_id: 'F-1',
    claimer_pubkey: 'aaa',
    claimer_github_user_id: 1,
    ts: 1700000000000,
    schema_version: CURRENT_SCHEMA_VERSION,
    ...over,
  };
}

describe('attemptClaimWithAudit', () => {
  it('won case: returns won + audit_outcome:won + no detail', async () => {
    const base = new FakeBase('mypubkey');
    const r = await attemptClaimWithAudit(base, {
      workspaceId: 'w', harnessSlug: 'sheets', feature_id: 'F-1',
      claimer_github_user_id: 42, now_ms: 1234,
    });
    expect(r.won).toBe(true);
    expect(r.audit_outcome).toBe('won');
    expect(r.audit_recorded).toBe(true);
    expect(r.audit_error).toBeUndefined();
    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0]).toMatchObject({
      workspaceId: 'w',
      harnessSlug: 'sheets',
      feature_id: 'F-1',
      claimer_pubkey: 'mypubkey',
      outcome: 'won',
      detail: undefined,
      attempt_ts: 1234,
    });
  });

  it('lost case: returns lost + audit_outcome:lost + detail includes winner', async () => {
    const seeded: MergedClaim[] = [
      { record: rec({ feature_id: 'F-1', claimer_pubkey: 'AAA' }), seq: 1 },
    ];
    const base = new FakeBase('mypubkey', seeded);
    const r = await attemptClaimWithAudit(base, {
      workspaceId: 'w', harnessSlug: 'sheets', feature_id: 'F-1',
      claimer_github_user_id: 7,
    });
    expect(r.won).toBe(false);
    expect(r.audit_outcome).toBe('lost');
    expect(r.winner_pubkey).toBe('AAA');
    expect(recordCalls[0].outcome).toBe('lost');
    expect(recordCalls[0].detail).toBe('winner=AAA');
  });

  it('audit failure: claim outcome still returns; audit_error is set', async () => {
    const audit = await import('../claim-audit');
    vi.mocked(audit.recordClaimAttempt).mockRejectedValueOnce(new Error('PG down'));
    const base = new FakeBase('mypubkey');
    const r = await attemptClaimWithAudit(base, {
      workspaceId: 'w', harnessSlug: 'sheets', feature_id: 'F-1',
      claimer_github_user_id: 1,
    });
    expect(r.won).toBe(true);
    expect(r.audit_recorded).toBe(false);
    expect(r.audit_error).toBe('PG down');
  });

  it('claim validation error propagates without audit', async () => {
    const base = new FakeBase('mypubkey');
    await expect(
      attemptClaimWithAudit(base, {
        workspaceId: 'w', harnessSlug: 'sheets', feature_id: '',
        claimer_github_user_id: 1,
      }),
    ).rejects.toBeInstanceOf(ClaimValidationError);
    expect(recordCalls).toHaveLength(0);
  });

  it('non-validation claim throw audits as error before re-throwing', async () => {
    const broken: ClaimAutobaseHandle = {
      myPubkey: 'mypubkey',
      async appendClaim() { throw new Error('autobase append failed'); },
      async readClaimsForFeature() { return []; },
    };
    await expect(
      attemptClaimWithAudit(broken, {
        workspaceId: 'w', harnessSlug: 'sheets', feature_id: 'F-1',
        claimer_github_user_id: 1,
      }),
    ).rejects.toThrow(/autobase append failed/);
    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0]).toMatchObject({
      outcome: 'error',
      detail: 'autobase append failed',
      feature_id: 'F-1',
    });
  });

  it('non-validation throw with audit ALSO failing: re-throws the original claim error', async () => {
    const audit = await import('../claim-audit');
    vi.mocked(audit.recordClaimAttempt).mockRejectedValueOnce(new Error('PG down too'));
    const broken: ClaimAutobaseHandle = {
      myPubkey: 'mypubkey',
      async appendClaim() { throw new Error('original claim error'); },
      async readClaimsForFeature() { return []; },
    };
    await expect(
      attemptClaimWithAudit(broken, {
        workspaceId: 'w', harnessSlug: 'sheets', feature_id: 'F-1',
        claimer_github_user_id: 1,
      }),
    ).rejects.toThrow(/original claim error/);
  });

  it('long error message truncated to 500 chars in audit detail', async () => {
    const longMsg = 'x'.repeat(2000);
    const broken: ClaimAutobaseHandle = {
      myPubkey: 'mypubkey',
      async appendClaim() { throw new Error(longMsg); },
      async readClaimsForFeature() { return []; },
    };
    await expect(
      attemptClaimWithAudit(broken, {
        workspaceId: 'w', harnessSlug: 'sheets', feature_id: 'F-1',
        claimer_github_user_id: 1,
      }),
    ).rejects.toThrow();
    expect(String(recordCalls[0].detail)).toHaveLength(500);
  });
});
