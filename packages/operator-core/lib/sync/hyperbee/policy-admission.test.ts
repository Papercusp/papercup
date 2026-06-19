/**
 * policy-admission.test.ts — the EN-4 consolidation seam over the REAL EN-1 schema
 * (`hive-policy-schema`) + EN-3 predicates (`hive-membership-policy`). Teeth-verified
 * S0 properties (the EN-4-owned layers; rate is EN-2's nested wrapper, proven there):
 *  - no policy ⇒ passthrough; local ops never enforced;
 *  - banned author dropped (every mode);
 *  - allowlist mode: listed login admits, non-listed dropped;
 *  - unresolvable author under an author-rule fails CLOSED;
 *  - content size / disallowed-table / banned-pattern dropped;
 *  - takedown (injected EN-3 P-MOD predicate) dropped.
 *
 * TEETH: each drop assertion pairs with an admit assertion under the same setup
 * minus the offending field, so neutering a check flips the drop test RED.
 */

import { describe, it, expect } from 'vitest';
import {
  decidePolicyOp,
  makePolicyEnforcedApply,
  parseContentPolicy,
  contentAdmits,
  type AuthorIdentity,
} from './policy-admission';
import type { OpEnvelope } from './op-envelope-types';
import type { HivePolicy } from '../../hive-policy-schema';

const OWN = 'own-log-key';
const REMOTE = 'remote-log-key';

function op(over?: Partial<OpEnvelope>): OpEnvelope {
  return {
    type: 'put',
    table: 'features-by-id',
    hbKey: 'F-1',
    value: { id: 'F-1', body: 'hello' },
    ts: 1000,
    sourceLogKeyHex: REMOTE,
    ...over,
  };
}

const ALICE: AuthorIdentity = { githubUserId: 1, githubUsername: 'alice' };

describe('decidePolicyOp — ban (EN-3 isBannedGithubId)', () => {
  // EN-1 schema: bannedGithubIds is string[] of stable numeric ids.
  const policy: HivePolicy = { moderation: { bannedGithubIds: ['99'] } };
  it('DROPS a banned author', () => {
    expect(decidePolicyOp(op(), policy, { githubUserId: 99, githubUsername: 'mallory' })).toEqual({
      admit: false,
      reason: 'policy_banned',
    });
  });
  it('admits a non-banned author', () => {
    expect(decidePolicyOp(op(), policy, ALICE).admit).toBe(true);
  });
});

describe('decidePolicyOp — allowlist (EN-3 isAllowlisted)', () => {
  const policy: HivePolicy = { membership: 'allowlist', allowlist: ['alice', 'Bob'] };
  it('admits a listed login (case-insensitive)', () => {
    expect(decidePolicyOp(op(), policy, { githubUserId: 2, githubUsername: 'BOB' }).admit).toBe(true);
  });
  it('DROPS a non-listed login (teeth: neuter allowlist → RED)', () => {
    expect(decidePolicyOp(op(), policy, { githubUserId: 7, githubUsername: 'eve' })).toEqual({
      admit: false,
      reason: 'policy_not_allowlisted',
    });
  });
  it('approval mode is NOT decided per-op (passes — join gate owns it)', () => {
    const approval: HivePolicy = { membership: 'approval' };
    expect(decidePolicyOp(op(), approval, ALICE).admit).toBe(true);
  });
});

describe('decidePolicyOp — unresolved author fails closed', () => {
  it('DROPS when an author-rule is active and the author is null', () => {
    const policy: HivePolicy = { membership: 'allowlist', allowlist: ['alice'] };
    expect(decidePolicyOp(op(), policy, null)).toEqual({
      admit: false,
      reason: 'policy_unresolved_author',
    });
  });
  it('admits a null author when only author-free (content) rules exist', () => {
    const policy: HivePolicy = { content: { maxPayloadBytes: 10_000 } };
    expect(decidePolicyOp(op(), policy, null).admit).toBe(true);
  });
});

describe('decidePolicyOp — content (P-CONTENT)', () => {
  it('DROPS an oversize payload', () => {
    const policy: HivePolicy = { content: { maxPayloadBytes: 5 } };
    expect(decidePolicyOp(op({ value: { big: 'x'.repeat(1000) } }), policy, ALICE)).toEqual({
      admit: false,
      reason: 'policy_content',
    });
    expect(decidePolicyOp(op({ value: 1 }), { content: { maxPayloadBytes: 5 } }, ALICE).admit).toBe(
      true,
    );
  });
  it('DROPS a disallowed table tag', () => {
    const policy: HivePolicy = { content: { allowedTableTags: ['features-by-id'] } };
    expect(decidePolicyOp(op({ table: 'coord-messages' }), policy, ALICE)).toEqual({
      admit: false,
      reason: 'policy_content',
    });
    expect(decidePolicyOp(op({ table: 'features-by-id' }), policy, ALICE).admit).toBe(true);
  });
  it('DROPS a banned-pattern match; a malformed pattern is ignored', () => {
    const policy: HivePolicy = { content: { bannedPatterns: ['spammy', '(['] } };
    expect(decidePolicyOp(op({ value: { t: 'buy spammy thing' } }), policy, ALICE)).toEqual({
      admit: false,
      reason: 'policy_content',
    });
    expect(decidePolicyOp(op({ value: { t: 'fine' } }), policy, ALICE).admit).toBe(true);
  });
});

describe('decidePolicyOp — takedown (injected EN-3 P-MOD predicate)', () => {
  it('DROPS a taken-down op when the predicate is wired', () => {
    const policy: HivePolicy = {};
    const deps = { isContentTakenDown: (_p: HivePolicy, o: OpEnvelope) => o.hbKey === 'F-1' };
    expect(decidePolicyOp(op({ hbKey: 'F-1' }), policy, ALICE, deps)).toEqual({
      admit: false,
      reason: 'policy_takendown',
    });
    expect(decidePolicyOp(op({ hbKey: 'F-2' }), policy, ALICE, deps).admit).toBe(true);
  });
});

describe('parseContentPolicy / contentAdmits', () => {
  it('parses the typed view from EN-1 opaque content; null when absent/empty', () => {
    expect(parseContentPolicy(undefined)).toBeNull();
    expect(parseContentPolicy({})).toBeNull();
    expect(parseContentPolicy({ maxPayloadBytes: 10 })).toEqual({ maxPayloadBytes: 10 });
    expect(parseContentPolicy({ maxPayloadBytes: -1 })).toBeNull(); // invalid dropped
  });
  it('contentAdmits enforces each rule', () => {
    expect(contentAdmits(op({ value: 1 }), { maxPayloadBytes: 1 })).toBe(true);
    expect(contentAdmits(op({ value: { x: 'yy' } }), { maxPayloadBytes: 1 })).toBe(false);
  });
});

describe('makePolicyEnforcedApply — the applyImpl decorator', () => {
  function harness(policy: HivePolicy | null, resolve: (k: string) => AuthorIdentity | null) {
    const writes: OpEnvelope[] = [];
    const drops: string[] = [];
    const apply = makePolicyEnforcedApply({
      currentPolicy: () => policy,
      resolveAuthor: resolve,
      ownLogKeyHex: OWN,
      apply: async (o) => {
        writes.push(o);
        return true;
      },
      onDrop: (i) => drops.push(i.reason),
    });
    return { apply, writes, drops };
  }

  it('passes through when there is no policy', async () => {
    const h = harness(null, () => ALICE);
    expect(await h.apply(op())).toBe(true);
    expect(h.writes.length).toBe(1);
  });

  it('NEVER enforces a local (own-log) op even if it would violate', async () => {
    const policy: HivePolicy = { moderation: { bannedGithubIds: ['99'] } };
    const h = harness(policy, () => ({ githubUserId: 99, githubUsername: 'mallory' }));
    expect(await h.apply(op({ sourceLogKeyHex: OWN }))).toBe(true); // own log → passthrough
    expect(h.writes.length).toBe(1);
  });

  it('DROPS a remote banned author and fires onDrop', async () => {
    const policy: HivePolicy = { moderation: { bannedGithubIds: ['99'] } };
    const h = harness(policy, () => ({ githubUserId: 99, githubUsername: 'mallory' }));
    expect(await h.apply(op({ sourceLogKeyHex: REMOTE }))).toBe(false);
    expect(h.writes.length).toBe(0);
    expect(h.drops).toEqual(['policy_banned']);
  });

  it('fail-closed: allowlist mode + unresolvable author → dropped', async () => {
    const policy: HivePolicy = { membership: 'allowlist', allowlist: ['alice'] };
    const h = harness(policy, () => null);
    expect(await h.apply(op({ sourceLogKeyHex: REMOTE }))).toBe(false);
    expect(h.drops).toEqual(['policy_unresolved_author']);
  });

  it('admits a clean remote op from a listed author', async () => {
    const policy: HivePolicy = { membership: 'allowlist', allowlist: ['alice'] };
    const h = harness(policy, () => ALICE);
    expect(await h.apply(op({ sourceLogKeyHex: REMOTE }))).toBe(true);
    expect(h.writes.length).toBe(1);
  });
});
