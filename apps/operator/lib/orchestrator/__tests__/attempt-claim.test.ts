/**
 * attemptClaimWithAudit — Model B Stage-5 pickup-helper tests.
 *
 * Mocks the recordClaimAttempt module boundary + uses an in-memory own-log
 * fake so the test exercises only the wrapper's wiring:
 *   - success → claimed:true + audit with outcome:'won'
 *   - audit failure → claim outcome still returned; audit_error set
 *   - claim throw (non-validation) → audit attempted as 'error', re-thrown
 *   - claim throw (validation) → propagates without audit
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attemptClaimWithAudit } from '../attempt-claim';
import { ClaimValidationError, type ClaimOwnLog } from '../feature-claim';
import type { PeerLogOp } from '../../sync/hyperbee/peer-log';

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

class FakeOwnLog implements ClaimOwnLog {
  public ops: PeerLogOp[] = [];
  constructor(public readonly keyHex: string) {}
  get length(): number {
    return this.ops.length;
  }
  async append(op: PeerLogOp): Promise<void> {
    this.ops.push(op);
  }
}

describe('attemptClaimWithAudit', () => {
  it('success: returns claimed:true + audit_outcome:won + appends one op', async () => {
    const ownLog = new FakeOwnLog('aa'.repeat(32));
    const r = await attemptClaimWithAudit(ownLog, {
      workspaceId: 'w', harnessSlug: 'sheets', feature_id: 'F-1',
      claimer_github_user_id: 42, now_ms: 1234,
    });
    expect(r.claimed).toBe(true);
    expect(r.audit_outcome).toBe('won');
    expect(r.audit_recorded).toBe(true);
    expect(r.audit_error).toBeUndefined();
    expect(ownLog.ops).toHaveLength(1);
    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0]).toMatchObject({
      workspaceId: 'w',
      harnessSlug: 'sheets',
      feature_id: 'F-1',
      claimer_pubkey: ownLog.keyHex,
      outcome: 'won',
      attempt_ts: 1234,
    });
  });

  it('audit failure: claim outcome still returns; audit_error is set', async () => {
    const audit = await import('../claim-audit');
    vi.mocked(audit.recordClaimAttempt).mockRejectedValueOnce(new Error('PG down'));
    const ownLog = new FakeOwnLog('aa'.repeat(32));
    const r = await attemptClaimWithAudit(ownLog, {
      workspaceId: 'w', harnessSlug: 'sheets', feature_id: 'F-1',
      claimer_github_user_id: 1,
    });
    expect(r.claimed).toBe(true);
    expect(r.audit_recorded).toBe(false);
    expect(r.audit_error).toBe('PG down');
  });

  it('claim validation error propagates without audit', async () => {
    const ownLog = new FakeOwnLog('aa'.repeat(32));
    await expect(
      attemptClaimWithAudit(ownLog, {
        workspaceId: 'w', harnessSlug: 'sheets', feature_id: '',
        claimer_github_user_id: 1,
      }),
    ).rejects.toBeInstanceOf(ClaimValidationError);
    expect(recordCalls).toHaveLength(0);
  });

  it('non-validation claim throw audits as error before re-throwing', async () => {
    const broken: ClaimOwnLog = {
      keyHex: 'aa'.repeat(32),
      get length() { return 0; },
      async append() { throw new Error('own-log append failed'); },
    };
    await expect(
      attemptClaimWithAudit(broken, {
        workspaceId: 'w', harnessSlug: 'sheets', feature_id: 'F-1',
        claimer_github_user_id: 1,
      }),
    ).rejects.toThrow(/own-log append failed/);
    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0]).toMatchObject({
      outcome: 'error',
      detail: 'own-log append failed',
      feature_id: 'F-1',
    });
  });

  it('non-validation throw with audit ALSO failing: re-throws the original claim error', async () => {
    const audit = await import('../claim-audit');
    vi.mocked(audit.recordClaimAttempt).mockRejectedValueOnce(new Error('PG down too'));
    const broken: ClaimOwnLog = {
      keyHex: 'aa'.repeat(32),
      get length() { return 0; },
      async append() { throw new Error('original claim error'); },
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
    const broken: ClaimOwnLog = {
      keyHex: 'aa'.repeat(32),
      get length() { return 0; },
      async append() { throw new Error(longMsg); },
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
