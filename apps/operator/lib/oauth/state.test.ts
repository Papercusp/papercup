import { afterEach, describe, expect, it } from 'vitest';
import { __resetForTest, signState, verifyAndConsumeState } from './state';

const baseClaims = {
  plugin: 'github-repo',
  harness: 'demo',
  field: 'github_token',
  providerHost: 'github.com',
  provider: 'github',
};

afterEach(() => __resetForTest());

describe('OAuth state token', () => {
  it('round-trips a valid state token', () => {
    const token = signState(baseClaims);
    const result = verifyAndConsumeState(token);
    expect(result.ok).toBe(true);
    expect(result.claims?.plugin).toBe('github-repo');
    expect(result.claims?.harness).toBe('demo');
  });

  it('rejects a tampered signature', () => {
    const token = signState(baseClaims);
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    const result = verifyAndConsumeState(tampered);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('bad-signature');
  });

  it('rejects malformed tokens', () => {
    expect(verifyAndConsumeState('').ok).toBe(false);
    expect(verifyAndConsumeState('garbage').error).toBe('malformed');
    expect(verifyAndConsumeState('a.b.c').error).toBe('bad-signature');
  });

  it('rejects expired tokens', () => {
    const token = signState(baseClaims, -1000);
    const result = verifyAndConsumeState(token);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('expired');
  });

  it('rejects already-consumed nonces (replay protection)', () => {
    const token = signState(baseClaims);
    const first = verifyAndConsumeState(token);
    expect(first.ok).toBe(true);
    const second = verifyAndConsumeState(token);
    expect(second.ok).toBe(false);
    expect(second.error).toBe('already-consumed');
  });

  it('issues independent tokens for concurrent flows', () => {
    const a = signState({ ...baseClaims, plugin: 'plugin-a' });
    const b = signState({ ...baseClaims, plugin: 'plugin-b' });
    expect(a).not.toBe(b);
    const ra = verifyAndConsumeState(a);
    const rb = verifyAndConsumeState(b);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(ra.claims?.plugin).toBe('plugin-a');
    expect(rb.claims?.plugin).toBe('plugin-b');
  });
});
