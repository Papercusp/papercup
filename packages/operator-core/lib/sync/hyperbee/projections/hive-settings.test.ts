/**
 * hive-settings projection — pure-function unit tests (shared-hive-federation
 * P-005). The validator gates malformed remote ops; composeKey + decodeValue are
 * the apply-framework seams.
 */
import { describe, it, expect } from 'vitest';
import { _testing } from './hive-settings';

const { composeKey, decodeValue, isHiveSettingRow } = _testing;
const valid = { harness_slug: 'myhive', setting_key: 'budget', value: '{"usd":5}' };

describe('hive-settings projection (pure)', () => {
  it('isHiveSettingRow accepts a valid row (null value ok)', () => {
    expect(isHiveSettingRow(valid)).toBe(true);
    expect(isHiveSettingRow({ ...valid, value: null })).toBe(true);
  });

  it('rejects malformed rows', () => {
    expect(isHiveSettingRow({ ...valid, harness_slug: '' })).toBe(false);
    expect(isHiveSettingRow({ ...valid, setting_key: 123 })).toBe(false);
    expect(isHiveSettingRow({ ...valid, value: 5 })).toBe(false);
    expect(isHiveSettingRow(null)).toBe(false);
    expect(isHiveSettingRow({})).toBe(false);
  });

  it('composeKey = setting_key; decodeValue gates', () => {
    expect(composeKey(valid as never)).toBe('budget');
    expect(decodeValue(valid)).toEqual(valid);
    expect(decodeValue({ bad: 1 })).toBeNull();
  });
});
