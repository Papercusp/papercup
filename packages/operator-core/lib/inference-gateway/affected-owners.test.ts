import { describe, it, expect } from 'vitest';
import {
  selectAffectedOwners,
  formatAtRiskAlertSuffix,
  AFFECTED_OWNER_RECENCY_MS,
  type OwnerRouteSnapshot,
} from './affected-owners';

const now = 1_000_000_000_000;
const snap = (ownerId: string, lastAccount: string | null, agoMs: number): OwnerRouteSnapshot => ({
  ownerId,
  lastAccount,
  lastAt: now - agoMs,
});

describe('selectAffectedOwners (EI-15153 — at-risk sessions on account disable)', () => {
  it('selects owners whose LAST route was the disabled account and who were recently active (the incident case)', () => {
    const entries = [
      snap('su-b621dc7f', 'aviynw7', 30_000), // on the dead account, 30s ago → at risk
      snap('su-18f2fc5d', 'aviynw7', 60_000), // on the dead account, 60s ago → at risk
      snap('su-other', 'aviynw3', 10_000), // on a different account → safe
    ];
    expect(selectAffectedOwners(entries, 'aviynw7', now)).toEqual(['su-18f2fc5d', 'su-b621dc7f']); // sorted
  });

  it('excludes an owner who FAILED OVER off the dead account (lastAccount is now something else)', () => {
    const entries = [
      snap('su-moved', 'aviynw3', 5_000), // was on aviynw7 but moved → lastAccount != dead → excluded
      snap('su-stuck', 'aviynw7', 5_000),
    ];
    expect(selectAffectedOwners(entries, 'aviynw7', now)).toEqual(['su-stuck']);
  });

  it('excludes stale ledger entries beyond the recency window', () => {
    const entries = [
      snap('su-live', 'aviynw7', 2 * 60_000),
      snap('su-stale', 'aviynw7', AFFECTED_OWNER_RECENCY_MS + 60_000), // too old → not a live session
    ];
    expect(selectAffectedOwners(entries, 'aviynw7', now)).toEqual(['su-live']);
  });

  it('boundary: exactly at the recency window is still included (<=)', () => {
    const entries = [snap('su-edge', 'aviynw7', AFFECTED_OWNER_RECENCY_MS)];
    expect(selectAffectedOwners(entries, 'aviynw7', now)).toEqual(['su-edge']);
  });

  it('de-duplicates repeated owner ids and honours a custom recency window', () => {
    const entries = [
      snap('su-dup', 'aviynw7', 1_000),
      snap('su-dup', 'aviynw7', 2_000),
      snap('su-old', 'aviynw7', 90_000),
    ];
    expect(selectAffectedOwners(entries, 'aviynw7', now)).toEqual(['su-dup', 'su-old']);
    // 60s window drops su-old (90s ago)
    expect(selectAffectedOwners(entries, 'aviynw7', now, 60_000)).toEqual(['su-dup']);
  });

  it('returns [] for an empty ledger, an empty accountId, or a null lastAccount', () => {
    expect(selectAffectedOwners([], 'aviynw7', now)).toEqual([]);
    expect(selectAffectedOwners([snap('su-x', 'aviynw7', 0)], '', now)).toEqual([]);
    expect(selectAffectedOwners([snap('su-null', null, 0)], 'aviynw7', now)).toEqual([]);
  });

  it('ignores entries with a blank ownerId', () => {
    expect(selectAffectedOwners([snap('', 'aviynw7', 0)], 'aviynw7', now)).toEqual([]);
  });
});

describe('formatAtRiskAlertSuffix', () => {
  it('names the at-risk owners in the alert suffix', () => {
    const s = formatAtRiskAlertSuffix(['su-b621dc7f', 'su-18f2fc5d']);
    expect(s).toMatch(/ORPHANED/);
    expect(s).toContain('su-b621dc7f');
    expect(s).toContain('su-18f2fc5d');
    expect(s).toMatch(/reclaim/i);
  });

  it('is EMPTY when no owner is at risk (enrichment stays additive / alert unchanged)', () => {
    expect(formatAtRiskAlertSuffix([])).toBe('');
    expect(formatAtRiskAlertSuffix(['', ''])).toBe('');
  });
});
