import { describe, expect, it } from 'vitest';
import { reduceGovernanceVotes } from './governance-voting';

describe('governance voting reducer', () => {
  it('counts weighted votes and explicit delegation deterministically', () => {
    const result = reduceGovernanceVotes({ members: [{ memberId: 'a' }, { memberId: 'b' }, { memberId: 'c', weight: 2 }], events: [{ memberId: 'a', choice: 'approve', sequence: 1, keyEpoch: 1 }, { memberId: 'b', choice: 'approve', sequence: 1, keyEpoch: 1 }, { memberId: 'c', choice: 'abstain', sequence: 1, keyEpoch: 1 }], delegations: [{ from: 'c', to: 'a', epoch: 1 }], nowMs: 1_000 });
    expect(result).toMatchObject({ ok: true, value: { approveWeight: 4, abstainWeight: 0, totalEligibleWeight: 4 } });
  });

  it('supports replacement and fails closed for cycles, revocation, and stale keys', () => {
    const replaced = reduceGovernanceVotes({ members: [{ memberId: 'a' }], events: [{ memberId: 'a', choice: 'reject', sequence: 1, keyEpoch: 1 }, { memberId: 'a', choice: 'approve', sequence: 2, keyEpoch: 1 }], nowMs: 0 });
    expect(replaced).toMatchObject({ ok: true, value: { approveWeight: 1, replacements: 1 } });
    expect(reduceGovernanceVotes({ members: [{ memberId: 'a' }, { memberId: 'b' }], events: [], delegations: [{ from: 'a', to: 'b', epoch: 1 }, { from: 'b', to: 'a', epoch: 1 }], nowMs: 0 })).toMatchObject({ ok: false, code: 'delegation-cycle' });
    expect(reduceGovernanceVotes({ members: [{ memberId: 'a', revoked: true }], events: [{ memberId: 'a', choice: 'approve', sequence: 1, keyEpoch: 1 }], nowMs: 0 })).toMatchObject({ ok: false, code: 'revoked-member' });
    expect(reduceGovernanceVotes({ members: [{ memberId: 'a', keyEpoch: 2 }], events: [{ memberId: 'a', choice: 'approve', sequence: 1, keyEpoch: 1 }], nowMs: 0 })).toMatchObject({ ok: false, code: 'stale-key-epoch' });
  });
});
