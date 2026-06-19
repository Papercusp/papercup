/**
 * hive-policy projection — pure-function unit tests (shared-hive-owner-enforcement
 * EN-1). The validator gates malformed remote ops; composeKey + decodeValue are the
 * apply-framework seams. (The signature-verify + LWW are exercised in the integration
 * test against real PG; here we pin the wire-shape contract.)
 */
import { describe, it, expect } from 'vitest';
import { _testing } from './hive-policy';

const { composeKey, decodeValue, isHivePolicyRow } = _testing;
const valid = {
  harness_slug: 'myhive',
  policy_json: '{"membership":"open"}',
  owner_pubkey: 'cHVia2V5',
  signature: 'c2ln',
  policy_version: 3,
};

describe('hive-policy projection (pure)', () => {
  it('isHivePolicyRow accepts a fully-formed signed row', () => {
    expect(isHivePolicyRow(valid)).toBe(true);
  });

  it('rejects rows missing any signed field', () => {
    expect(isHivePolicyRow({ ...valid, harness_slug: '' })).toBe(false);
    expect(isHivePolicyRow({ ...valid, policy_json: '' })).toBe(false);
    expect(isHivePolicyRow({ ...valid, owner_pubkey: '' })).toBe(false);
    expect(isHivePolicyRow({ ...valid, signature: '' })).toBe(false);
    expect(isHivePolicyRow({ ...valid, policy_version: 'three' })).toBe(false);
    expect(isHivePolicyRow({ ...valid, policy_version: NaN })).toBe(false);
    expect(isHivePolicyRow(null)).toBe(false);
    expect(isHivePolicyRow({})).toBe(false);
  });

  it('composeKey = harness_slug (singleton per Hive); decodeValue gates', () => {
    expect(composeKey(valid as never)).toBe('myhive');
    expect(decodeValue(valid)).toEqual(valid);
    expect(decodeValue({ bad: 1 })).toBeNull();
  });
});
