import { describe, expect, it } from 'vitest';
import {
  SIGNED_PROTOCOL_SCHEMA_VERSION,
  deriveStoreGeneration,
  isSignedProtocolContext,
  makeSignedProtocolContext,
  signedProtocolContextMatches,
} from './signed-context';

describe('signed pot-git protocol context (P-513/F2)', () => {
  it('derives one stable context from the federated hive/repository identity', () => {
    const context = makeSignedProtocolContext('hello-world-3-pot', 'gh-1303510992');
    expect(SIGNED_PROTOCOL_SCHEMA_VERSION).toBe(2);
    expect(isSignedProtocolContext(context)).toBe(true);
    expect(context).toEqual(makeSignedProtocolContext('hello-world-3-pot', 'gh-1303510992'));
    expect(context.store_generation).toBe(deriveStoreGeneration(context.hive_id, context.repo_key));
    expect(signedProtocolContextMatches(context, context)).toBe(true);
  });

  it('rejects context drift and malformed/control-character values', () => {
    const context = makeSignedProtocolContext('hive', 'repo');
    expect(signedProtocolContextMatches({ ...context, repo_key: 'other' }, context)).toBe(false);
    expect(isSignedProtocolContext({ ...context, store_generation: '' })).toBe(false);
    expect(isSignedProtocolContext({ ...context, hive_id: 'bad\u0000id' })).toBe(false);
    expect(isSignedProtocolContext({ ...context, repo_key: 42 })).toBe(false);
  });
});
