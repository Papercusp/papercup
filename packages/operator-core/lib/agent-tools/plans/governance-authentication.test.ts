import { describe, expect, it } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import type { FederatedGovernanceEvent, GovernanceEventBody } from './governance-federation';
import { createGovernanceRound, type GovernanceRound, type GovernanceVoteEvent } from './governance-round';
import { DEFAULT_PLAN_ADMISSION_POLICY } from './plan-admission-policy';
import { authenticateGovernanceEvent, governanceAuthorityHash, governanceEventSigningBytes,
  governanceVoteSigningBytes, validGovernanceSigningAuthority, type GovernanceSigningAuthority } from './governance-authentication';

function fixture() {
  const a = generateEd25519KeypairDer();
  const b = generateEd25519KeypairDer();
  const authority: GovernanceSigningAuthority = { potId: 'pot', policy: DEFAULT_PLAN_ADMISSION_POLICY,
    members: [
      { memberId: 'a', publicKey: a.pubkeyBase64, keyEpoch: 1, originPeerIds: ['peer-a'], roles: ['round-open', 'vote', 'finalize', 'pause', 'resume', 'revoke'] },
      { memberId: 'b', publicKey: b.pubkeyBase64, keyEpoch: 1, originPeerIds: ['peer-b'], roles: ['vote'] },
    ],
  };
  const created = createGovernanceRound({ roundId: 'round', planRevisionHash: 'revision', policyVersion: 1,
    eligibleMemberIds: ['a', 'b'], createdAtMs: 1000, authorityHash: governanceAuthorityHash(authority) });
  if (!created.ok) throw new Error(created.detail);
  const round = created.value;
  function sign(body: GovernanceEventBody, over: Partial<Omit<FederatedGovernanceEvent, 'signature'>> = {}, key = a) {
    const unsigned = { eventId: 'outer', potId: 'pot', roundId: 'round', originPeerId: 'peer-a',
      occurredAtMs: 1100, body, authorization: { memberId: 'a', keyEpoch: 1 }, ...over };
    return { ...unsigned, signature: signWithPrivateKeyDer(key.privateKeyDer, governanceEventSigningBytes(unsigned)).toString('base64') };
  }
  const unsignedVote = { eventId: 'ballot', roundId: 'round', memberId: 'a', choice: 'approve' as const, sequence: 1, keyEpoch: 1 };
  const vote: GovernanceVoteEvent = { ...unsignedVote,
    signature: signWithPrivateKeyDer(a.privateKeyDer, governanceVoteSigningBytes(authority, round, unsignedVote)).toString('base64') };
  const verify = (event: FederatedGovernanceEvent, pinned = authority, r: GovernanceRound = round, nowMs = 1200) =>
    authenticateGovernanceEvent({ authority: pinned, event, round: r, nowMs });
  return { a, b, authority, round, vote, sign, verify };
}

describe('eligible governance keys and signed domains', () => {
  it('authenticates a real round, control and independently signed ballot', () => {
    const f = fixture();
    expect(f.verify(f.sign({ kind: 'round-open', round: f.round }))).toEqual({ ok: true });
    expect(f.verify(f.sign({ kind: 'pause' }))).toEqual({ ok: true });
    expect(f.verify(f.sign({ kind: 'vote', vote: f.vote }))).toEqual({ ok: true });
  });

  it('refuses legacy and forged nonempty signatures', () => {
    const f = fixture();
    const event = f.sign({ kind: 'vote', vote: f.vote });
    expect(f.verify({ ...event, authorization: undefined })).toMatchObject({ ok: false, code: 'missing-authorization' });
    expect(f.verify({ ...event, signature: 'forged' })).toMatchObject({ ok: false, code: 'unverified-signature' });
  });

  it('fails closed on malformed decoded events and electorate records', () => {
    const f = fixture();
    for (const event of [null, {}, { ...f.sign({ kind: 'pause' }), body: null },
      { ...f.sign({ kind: 'pause' }), body: { kind: 'vote' } }]) {
      expect(f.verify(event as FederatedGovernanceEvent)).toMatchObject({ ok: false, code: 'invalid-event' });
    }
    const event = f.sign({ kind: 'pause' });
    expect(f.verify(event, f.authority, { ...f.round, eligibleMemberIds: undefined } as unknown as GovernanceRound))
      .toMatchObject({ ok: false, code: 'invalid-round-binding' });
    expect(f.verify(event, f.authority, { ...f.round, eligibleMemberIds: ['a', 'a'] }))
      .toMatchObject({ ok: false, code: 'invalid-round-binding' });
  });

  it('rejects outer payload edits and a re-signed outer envelope with a forged inner ballot', () => {
    const f = fixture();
    const event = f.sign({ kind: 'vote', vote: f.vote });
    expect(f.verify({ ...event, eventId: 'edited' })).toMatchObject({ ok: false, code: 'unverified-signature' });
    expect(f.verify(f.sign({ kind: 'vote', vote: { ...f.vote, choice: 'reject' } })))
      .toMatchObject({ ok: false, code: 'unverified-ballot' });
  });

  it('does not let a governor sign another member ballot', () => {
    const f = fixture();
    expect(f.verify(f.sign({ kind: 'vote', vote: { ...f.vote, memberId: 'b' } })))
      .toMatchObject({ ok: false, code: 'unverified-ballot' });
  });

  it('requires the permitted control role, authenticated origin and exact key epoch', () => {
    const f = fixture();
    expect(f.verify(f.sign({ kind: 'revoke', reason: 'halt' }, { originPeerId: 'peer-b', authorization: { memberId: 'b', keyEpoch: 1 } }, f.b)))
      .toMatchObject({ ok: false, code: 'unauthorized-role' });
    expect(f.verify(f.sign({ kind: 'pause' }, { originPeerId: 'peer-b' })))
      .toMatchObject({ ok: false, code: 'wrong-origin-peer' });
    expect(f.verify(f.sign({ kind: 'pause' }, { authorization: { memberId: 'a', keyEpoch: 2 } })))
      .toMatchObject({ ok: false, code: 'stale-key-epoch' });
  });

  it('refuses revoked, expired and future authority', () => {
    const f = fixture();
    const event = f.sign({ kind: 'pause' });
    expect(f.verify(event, { ...f.authority, members: [{ ...f.authority.members[0]!, revoked: true }, f.authority.members[1]!] }))
      .toMatchObject({ ok: false, code: 'ineligible-signer' });
    expect(f.verify(event, { ...f.authority, members: [{ ...f.authority.members[0]!, expiresAtMs: 1200 }, f.authority.members[1]!] }))
      .toMatchObject({ ok: false, code: 'expired-signer' });
    expect(f.verify(f.sign({ kind: 'pause' }, { occurredAtMs: 1300 }))).toMatchObject({ ok: false, code: 'invalid-time' });
    expect(f.verify(event, f.authority, f.round, NaN)).toMatchObject({ ok: false, code: 'invalid-time' });
  });

  it('binds ballots to the exact pot, round, revision, policy, action and electorate', () => {
    const f = fixture();
    const event = f.sign({ kind: 'vote', vote: f.vote });
    expect(f.verify({ ...event, potId: 'foreign' })).toMatchObject({ ok: false, code: 'foreign-pot' });
    for (const over of [{ roundId: 'another' }, { planRevisionHash: 'edited' }, { policyVersion: 2 },
      { approvedActionHash: 'another-action' }, { eligibleMemberIds: ['a'] }, { authorityHash: 'forged' }]) {
      expect(f.verify(event, f.authority, { ...f.round, ...over })).toMatchObject({ ok: false });
    }
  });

  it('rejects duplicate signer identities or a key reused as several voters', () => {
    const f = fixture();
    expect(validGovernanceSigningAuthority({ ...f.authority, members: [f.authority.members[0]!, f.authority.members[0]!] })).toBe(false);
    expect(validGovernanceSigningAuthority({ ...f.authority, members: [f.authority.members[0]!, { ...f.authority.members[1]!, publicKey: f.a.pubkeyBase64 }] })).toBe(false);
    expect(validGovernanceSigningAuthority({ ...f.authority, members: [{ ...f.authority.members[0]!, keyEpoch: NaN }] })).toBe(false);
  });

  it('normalizes roster order and commits changed role, weight or policy semantics', () => {
    const f = fixture();
    expect(governanceAuthorityHash({ ...f.authority, members: [...f.authority.members].reverse() })).toBe(governanceAuthorityHash(f.authority));
    for (const changed of [
      { ...f.authority, policy: { ...f.authority.policy, approvalBps: 9000 } },
      { ...f.authority, members: [{ ...f.authority.members[0]!, weight: 2 }, f.authority.members[1]!] },
      { ...f.authority, members: [{ ...f.authority.members[0]!, roles: ['vote' as const] }, f.authority.members[1]!] },
    ]) expect(governanceAuthorityHash(changed)).not.toBe(governanceAuthorityHash(f.authority));
  });
});
