/**
 * lease-steal-semantics.test.ts — pure unit coverage for the P-004 adoption
 * rules (plan shared-hive-loop-e2e-testing-2026-06-10 D-007): single,
 * lease-current-wins (the steal rule — deliberately NOT earliest-acquire),
 * and the deterministic total-order fallback.
 */
import { describe, expect, it } from 'vitest';
import { adoptAll, adoptCompletion, type CompletionRecord } from './lease-steal-semantics';

const rec = (
  item: string,
  executor: string,
  claimId: string,
  acquiredTs: string,
  pubkey = `${executor}-pub`,
): CompletionRecord => ({
  workItemId: item,
  executor,
  claim: { workItemId: item, holderPubkey: pubkey, owner: executor, claimId, acquiredTs },
  completedAtMs: 0,
});

describe('adoptCompletion', () => {
  it('single record → adopted, rule single', () => {
    const v = adoptCompletion([rec('F-1', 'a', 'c-1', '2026-06-10T00:00:00Z')], 'c-1')!;
    expect(v).toMatchObject({ rule: 'single', adopted: { executor: 'a' }, superseded: [] });
  });

  it('THE STEAL RULE: the lease-current (later, stolen) claim beats the earlier zombie acquire', () => {
    const zombie = rec('F-1', 'a', 'c-old', '2026-06-10T00:00:00Z'); // earlier acquire
    const stealer = rec('F-1', 'b', 'c-new', '2026-06-10T01:00:00Z'); // stole after lapse
    const v = adoptCompletion([zombie, stealer], 'c-new')!;
    expect(v.rule).toBe('lease-current');
    expect(v.adopted.executor).toBe('b');
    expect(v.superseded.map((r) => r.executor)).toEqual(['a']);
    // The raw total order would have picked the zombie — the rule matters.
    const fallback = adoptCompletion([zombie, stealer], null)!;
    expect(fallback.rule).toBe('total-order');
    expect(fallback.adopted.executor).toBe('a');
  });

  it('no lease-current record → deterministic total-order fallback, input-order-independent', () => {
    const x = rec('F-1', 'a', 'c-2', '2026-06-10T00:00:05Z');
    const y = rec('F-1', 'b', 'c-3', '2026-06-10T00:00:05Z', 'a-aaa'); // ts tie → lowest pubkey
    const v1 = adoptCompletion([x, y], 'c-gone')!;
    const v2 = adoptCompletion([y, x], 'c-gone')!;
    expect(v1.rule).toBe('total-order');
    expect(v1.adopted.claim.claimId).toBe(v2.adopted.claim.claimId);
    expect(v1.adopted.executor).toBe('b'); // 'a-aaa' < 'a-pub'
  });

  it('throws on records spanning multiple items; null on empty', () => {
    expect(() => adoptCompletion([rec('F-1', 'a', 'c', 't'), rec('F-2', 'b', 'c2', 't')], null)).toThrow(
      /group first/,
    );
    expect(adoptCompletion([], null)).toBeNull();
  });
});

describe('adoptAll', () => {
  it('groups by item, adjudicates each against its current claim, sorts output', () => {
    const records = [
      rec('F-2', 'a', 'c-2a', '2026-06-10T00:00:00Z'),
      rec('F-1', 'a', 'c-1a', '2026-06-10T00:00:00Z'),
      rec('F-1', 'b', 'c-1b', '2026-06-10T01:00:00Z'),
    ];
    const verdicts = adoptAll(records, (item) => (item === 'F-1' ? 'c-1b' : null));
    expect(verdicts.map((v) => v.workItemId)).toEqual(['F-1', 'F-2']);
    expect(verdicts[0]).toMatchObject({ rule: 'lease-current', adopted: { executor: 'b' } });
    expect(verdicts[1]).toMatchObject({ rule: 'single', adopted: { executor: 'a' } });
  });
});
