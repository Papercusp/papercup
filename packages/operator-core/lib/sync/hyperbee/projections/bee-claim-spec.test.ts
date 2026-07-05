/**
 * bee-claim-spec.test.ts — the P-016 projection decode + guard (pure).
 * The apply SQL is exercised end-to-end by the store integration test's
 * federation-capture case + the coord-message federation harness pattern.
 */
import { describe, it, expect } from 'vitest';
import { _testing } from './bee-claim-spec';

const { decodeValue, composeKey, isBeeClaimSpecRow } = _testing;

const good = {
  harness_slug: 'my-hive',
  bee_id: 'su-bee-1',
  spec: { specVersion: 1, revision: 3, view: { filter: {} }, rank: { mode: 'fifo', terms: [] } },
  revision: 3,
  updated_by: 'mug',
};

describe('bee-claim-spec projection decode/guard', () => {
  it('accepts a well-formed row; composeKey is the bee_id', () => {
    expect(decodeValue(good)).toEqual(good);
    expect(composeKey(good)).toBe('su-bee-1');
  });

  it('accepts a null updated_by', () => {
    expect(isBeeClaimSpecRow({ ...good, updated_by: null })).toBe(true);
  });

  it('rejects malformed rows (missing/empty slug, non-object spec, bad revision, array spec)', () => {
    expect(decodeValue({ ...good, harness_slug: '' })).toBeNull();
    expect(decodeValue({ ...good, bee_id: '' })).toBeNull();
    expect(decodeValue({ ...good, spec: 'nope' })).toBeNull();
    expect(decodeValue({ ...good, spec: [] })).toBeNull();
    expect(decodeValue({ ...good, revision: 'x' })).toBeNull();
    expect(decodeValue(null)).toBeNull();
    expect(decodeValue({ garbage: true })).toBeNull();
  });
});
