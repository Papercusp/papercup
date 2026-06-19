/**
 * operator-rate-key.test.ts — the per-operator anti-spam bucket key (PR-4 (c)6 /
 * EN-2 P-RATE). One human (gh user id) = one bucket. Derived from the same
 * identity resolution the producer + audit use, so the rate key and the
 * attribution row name the same human.
 */
import { describe, expect, it } from 'vitest';
import {
  operatorRateKeyForGithubUserId,
  resolveOperatorRateKey,
  OPERATOR_RATE_KEY_PREFIX,
} from './operator-rate-key';

describe('operatorRateKeyForGithubUserId', () => {
  it('namespaces the github id', () => {
    expect(operatorRateKeyForGithubUserId(4242)).toBe(`${OPERATOR_RATE_KEY_PREFIX}:4242`);
  });
});

describe('resolveOperatorRateKey', () => {
  it('resolves THIS operator key from the local gh identity', async () => {
    const key = await resolveOperatorRateKey({
      getToken: async () => ({ kind: 'ok', token: 'ghs_x' }),
      getUser: async () => ({ id: 999, login: 'avi' }),
    });
    expect(key).toBe(`${OPERATOR_RATE_KEY_PREFIX}:999`);
  });

  it('returns null when gh is not authenticated (no key to bucket on)', async () => {
    const key = await resolveOperatorRateKey({
      getToken: async () => ({ kind: 'error' }),
      getUser: async () => null,
    });
    expect(key).toBeNull();
  });

  it('two agents under one human resolve to the SAME bucket (anti-spam granularity)', async () => {
    const id = { getToken: async () => ({ kind: 'ok', token: 't' }), getUser: async () => ({ id: 7, login: 'h' }) };
    const a = await resolveOperatorRateKey(id);
    const b = await resolveOperatorRateKey(id);
    expect(a).toBe(b);
  });
});
