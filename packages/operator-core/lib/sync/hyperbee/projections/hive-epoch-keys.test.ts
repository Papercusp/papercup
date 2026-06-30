/**
 * hive-epoch-keys projection — pure-function unit tests (shared-hive-rekey
 * P-005). The validator gates malformed remote ops; composeKey + decodeValue
 * are the apply-framework seams. The composeKey result must match the
 * generated `epoch_key_fed_key` column (mig 316) exactly: `${epoch}:${pubkey}`.
 */
import { describe, it, expect } from 'vitest';
import { _testing } from './hive-epoch-keys';

const { composeKey, decodeValue, isHiveEpochKeyRow } = _testing;

const valid = {
  harness_slug: 'myhive',
  epoch: 3,
  member_device_pubkey: 'cHVia2V5AAAA',
  wrapped_key: 'encryptedBlob==',
};

describe('hive-epoch-keys projection (pure)', () => {
  it('isHiveEpochKeyRow accepts a fully-formed row', () => {
    expect(isHiveEpochKeyRow(valid)).toBe(true);
  });

  it('rejects rows missing or malformed fields', () => {
    expect(isHiveEpochKeyRow({ ...valid, harness_slug: '' })).toBe(false);
    expect(isHiveEpochKeyRow({ ...valid, epoch: 'three' })).toBe(false);
    expect(isHiveEpochKeyRow({ ...valid, epoch: NaN })).toBe(false);
    expect(isHiveEpochKeyRow({ ...valid, epoch: -1 })).toBe(false);
    expect(isHiveEpochKeyRow({ ...valid, member_device_pubkey: '' })).toBe(false);
    expect(isHiveEpochKeyRow({ ...valid, wrapped_key: '' })).toBe(false);
    expect(isHiveEpochKeyRow(null)).toBe(false);
    expect(isHiveEpochKeyRow({})).toBe(false);
  });

  it('composeKey = epoch + ":" + member_device_pubkey (matches epoch_key_fed_key column)', () => {
    expect(composeKey(valid as never)).toBe('3:cHVia2V5AAAA');
    // epoch 0 is valid (first epoch)
    expect(composeKey({ ...valid, epoch: 0 } as never)).toBe('0:cHVia2V5AAAA');
    // base64 pubkeys with "/" are fine — ":" is the separator, never appears in base64
    expect(composeKey({ ...valid, member_device_pubkey: 'ab/cd==' } as never)).toBe('3:ab/cd==');
  });

  it('decodeValue returns the row when valid, null when invalid', () => {
    expect(decodeValue(valid)).toEqual(valid);
    expect(decodeValue({ bad: 1 })).toBeNull();
    expect(decodeValue(null)).toBeNull();
    expect(decodeValue({ ...valid, epoch: 'not-a-number' })).toBeNull();
  });
});
