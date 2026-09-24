import { describe, expect, it } from 'vitest';
import {
  isLegacyGovernorReceiptSnapshotValue,
  shouldDropGovernorReceiptSnapshotRow,
  type GovernorReceiptSnapshotFilter,
} from '../governor-receipt-snapshot-filter';

const receipt = (state = 'completed') => ({
  payload: { resource_governor: { schemaVersion: 1, state } },
});
const filter: GovernorReceiptSnapshotFilter = {
  maxSourceIndexExclusive: 100,
  liveQualifiedKeys: ['papercusp/WI-LIVE'],
};

describe('P-530 governor receipt snapshot filter', () => {
  it('drops only an absent qualified pre-census receipt', () => {
    expect(
      shouldDropGovernorReceiptSnapshotRow(
        receipt(),
        { table: 'engineer-issues', hbKey: 'papercusp/WI-DEAD', sourceIndex: 99 },
        filter,
      ),
    ).toBe(true);
  });

  it('never drops a current live row or a post-census append', () => {
    expect(
      shouldDropGovernorReceiptSnapshotRow(
        receipt(),
        { table: 'engineer-issues', hbKey: 'papercusp/WI-LIVE', sourceIndex: 20 },
        filter,
      ),
    ).toBe(false);
    expect(
      shouldDropGovernorReceiptSnapshotRow(
        receipt(),
        { table: 'engineer-issues', hbKey: 'papercusp/WI-NEW', sourceIndex: 100 },
        filter,
      ),
    ).toBe(false);
  });

  it('fails safe for ordinary issues, bare legacy keys, tombstones, and unknown indices', () => {
    const cases = [
      [{ payload: { normal: true } }, { table: 'engineer-issues', hbKey: 'papercusp/WI-NORMAL', sourceIndex: 1 }],
      [receipt(), { table: 'engineer-issues', hbKey: 'WI-BARE', sourceIndex: 1 }],
      [null, { table: 'engineer-issues', hbKey: 'papercusp/WI-TOMBSTONE', sourceIndex: 1 }],
      [receipt(), { table: 'engineer-issues', hbKey: 'papercusp/WI-UNKNOWN' }],
      [receipt(), { table: 'features-by-id', hbKey: 'papercusp/WI-WRONG-TABLE', sourceIndex: 1 }],
    ] as const;
    for (const [value, context] of cases) {
      expect(shouldDropGovernorReceiptSnapshotRow(value, context, filter)).toBe(false);
    }
  });

  it('recognizes only the object-shaped resource_governor payload', () => {
    expect(isLegacyGovernorReceiptSnapshotValue(receipt())).toBe(true);
    expect(isLegacyGovernorReceiptSnapshotValue({ payload: { resource_governor: null } })).toBe(false);
    expect(isLegacyGovernorReceiptSnapshotValue({ payload: { resource_governor: 'x' } })).toBe(false);
  });
});
