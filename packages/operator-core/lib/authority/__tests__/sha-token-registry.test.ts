/**
 * sha-token-registry.test.ts — the G-0 (P-033) per-(domain, path) sha-token
 * state machine, pure with an explicit clock.
 *
 * Run: cd packages/operator-core && npx vitest run lib/authority/__tests__/sha-token-registry.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  _shaTokenTesting,
  noteShaTokenGrant,
  noteShaTokenRelease,
  shaTokenForGrant,
} from '../sha-token-registry';

const DOM = '/repo/checkout';
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

describe('sha-token-registry (G-0 P-033)', () => {
  beforeEach(() => _shaTokenTesting.reset());

  it('unknown paths grant with no requiredSha and no risk (pre-protocol behavior)', () => {
    expect(shaTokenForGrant(DOM, ['x.ts'], 1_000)).toEqual({ requiredSha: null, unsyncedRisk: false });
  });

  it('publish-then-release carries the sha to the NEXT grant as requiredSha', () => {
    noteShaTokenGrant(DOM, ['x.ts'], 'agent-1', 10_000);
    noteShaTokenRelease(DOM, ['x.ts'], SHA1, 2_000);
    expect(shaTokenForGrant(DOM, ['x.ts'], 3_000)).toEqual({ requiredSha: SHA1, unsyncedRisk: false });
    // Newer publish supersedes.
    noteShaTokenGrant(DOM, ['x.ts'], 'agent-2', 20_000);
    noteShaTokenRelease(DOM, ['x.ts'], SHA2, 4_000);
    expect(shaTokenForGrant(DOM, ['x.ts'], 5_000)).toEqual({ requiredSha: SHA2, unsyncedRisk: false });
  });

  it('a clean release WITHOUT a published sha keeps the prior sha and stays risk-free', () => {
    noteShaTokenGrant(DOM, ['x.ts'], 'agent-1', 10_000);
    noteShaTokenRelease(DOM, ['x.ts'], SHA1, 2_000);
    noteShaTokenGrant(DOM, ['x.ts'], 'agent-2', 20_000);
    noteShaTokenRelease(DOM, ['x.ts'], null, 5_000);
    expect(shaTokenForGrant(DOM, ['x.ts'], 6_000)).toEqual({ requiredSha: SHA1, unsyncedRisk: false });
  });

  it('EXPIRY-RECLAIM: a grant that expired without a release marks the next grant unsyncedRisk:true', () => {
    noteShaTokenGrant(DOM, ['x.ts'], 'agent-1', 10_000);
    noteShaTokenRelease(DOM, ['x.ts'], SHA1, 2_000);
    // agent-2 takes the lock, then dies (no release) past its expiry.
    noteShaTokenGrant(DOM, ['x.ts'], 'agent-2', 8_000);
    expect(shaTokenForGrant(DOM, ['x.ts'], 9_000)).toEqual({ requiredSha: SHA1, unsyncedRisk: true });
    // Before expiry there is no reclaim signal.
    expect(shaTokenForGrant(DOM, ['x.ts'], 7_000)).toEqual({ requiredSha: SHA1, unsyncedRisk: false });
  });

  it('multi-path grants aggregate: newest published sha wins, risk ORs across paths', () => {
    noteShaTokenGrant(DOM, ['a.ts'], 'agent-1', 10_000);
    noteShaTokenRelease(DOM, ['a.ts'], SHA1, 1_000);
    noteShaTokenGrant(DOM, ['b.ts'], 'agent-2', 10_000);
    noteShaTokenRelease(DOM, ['b.ts'], SHA2, 2_000);
    // c.ts holder died past expiry.
    noteShaTokenGrant(DOM, ['c.ts'], 'agent-3', 3_000);
    const t = shaTokenForGrant(DOM, ['a.ts', 'b.ts', 'c.ts'], 5_000);
    expect(t).toEqual({ requiredSha: SHA2, unsyncedRisk: true });
  });

  it('domains are isolated', () => {
    noteShaTokenGrant(DOM, ['x.ts'], 'agent-1', 10_000);
    noteShaTokenRelease(DOM, ['x.ts'], SHA1, 2_000);
    expect(shaTokenForGrant('/other/repo', ['x.ts'], 3_000)).toEqual({ requiredSha: null, unsyncedRisk: false });
  });

  it('is bounded: entries FIFO-evict past the cap', () => {
    for (let i = 0; i < _shaTokenTesting.maxEntries + 10; i++) {
      noteShaTokenGrant(DOM, [`f${i}.ts`], 'agent', 10_000);
    }
    expect(_shaTokenTesting.size()).toBeLessThanOrEqual(_shaTokenTesting.maxEntries);
  });
});
