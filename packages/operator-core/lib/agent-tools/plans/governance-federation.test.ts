import { describe, expect, it } from 'vitest';
import {
  appendGovernanceVote,
  createGovernanceRound,
  finalizeGovernanceRound,
  type FinalizationCertificate,
  type GovernanceRound,
  type GovernanceVoteEvent,
} from './governance-round';
import { DEFAULT_PLAN_ADMISSION_POLICY } from './plan-admission-policy';
import {
  admissibleCertificate,
  governanceEventDigest,
  ingestGovernanceEvents,
  projectGovernanceFederation,
  projectionDigest,
  selectFederatableEvents,
  type FederatedGovernanceEvent,
  type GovernanceEventBody,
  type PotBoundary,
} from './governance-federation';

const POT = 'pot-alpha';
const PEER_A = 'peer-a';
const PEER_B = 'peer-b';
const OUTSIDER = 'peer-outsider';

const shared: PotBoundary = { potId: POT, visibility: 'shared', memberPeerIds: [PEER_A, PEER_B] };
const priv: PotBoundary = { potId: POT, visibility: 'private', memberPeerIds: [PEER_A, PEER_B] };

let seq = 0;
function event(body: GovernanceEventBody, over: Partial<FederatedGovernanceEvent> = {}): FederatedGovernanceEvent {
  seq += 1;
  const base = { eventId: `evt-${seq}`, potId: POT, roundId: 'round-1', originPeerId: PEER_A, occurredAtMs: 1_000 + seq, body, ...over };
  return { ...base, signature: `sig-${governanceEventDigest(base).slice(0, 8)}` };
}

function buildRound(roundId: string, choices: readonly GovernanceVoteEvent['choice'][]): { round: GovernanceRound; votes: GovernanceVoteEvent[]; cert: FinalizationCertificate } {
  const memberIds = choices.map((_, i) => `member-${i}`);
  const created = createGovernanceRound({ roundId, planRevisionHash: `rev-${roundId}`, policyVersion: DEFAULT_PLAN_ADMISSION_POLICY.policyVersion, eligibleMemberIds: memberIds, createdAtMs: 1_000 });
  if (!created.ok) throw new Error(created.detail);
  let votes: GovernanceVoteEvent[] = [];
  choices.forEach((choice, i) => {
    const appended = appendGovernanceVote(created.value, votes, { eventId: `${roundId}-vote-${i}`, roundId, memberId: memberIds[i]!, choice, sequence: i, signature: `s-${i}` });
    if (!appended.ok) throw new Error(appended.detail);
    votes = appended.value;
  });
  const finalized = finalizeGovernanceRound({ round: created.value, events: votes, policy: DEFAULT_PLAN_ADMISSION_POLICY, nowMs: 2_000 });
  if (!finalized.ok) throw new Error(finalized.detail);
  return { round: created.value, votes, cert: finalized.value };
}

/** A ratified round-1: open + three approving votes + its certificate. */
function ratifiedRoundEvents(): { events: FederatedGovernanceEvent[]; cert: FinalizationCertificate } {
  const { round, votes, cert } = buildRound('round-1', ['approve', 'approve', 'approve']);
  return {
    cert,
    events: [event({ kind: 'round-open', round }), ...votes.map((vote) => event({ kind: 'vote', vote })), event({ kind: 'finalize', certificate: cert })],
  };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((item, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([item, ...rest]);
  });
  return out;
}

describe('governance federation — immutable events and offline convergence', () => {
  it('projects a ratified round as finalized and admissible', () => {
    const { events, cert } = ratifiedRoundEvents();
    const projection = projectGovernanceFederation(POT, events);
    expect(projection.rounds.get('round-1')).toMatchObject({ status: 'finalized', roundOpened: true, paused: false });
    expect(admissibleCertificate(projection, 'round-1')?.certificateHash).toBe(cert.certificateHash);
  });

  it('converges on the same projection for every delivery order', () => {
    const { events } = ratifiedRoundEvents();
    const digests = new Set(permutations(events).map((order) => projectionDigest(projectGovernanceFederation(POT, order))));
    expect(events).toHaveLength(5);
    expect(permutations(events)).toHaveLength(120);
    expect(digests.size).toBe(1);
  });

  it('projectionDigest DISCRIMINATES — the convergence assertions above are not vacuous', () => {
    // Every convergence test asserts two digests are EQUAL, which a constant digest
    // would also satisfy. These pairs must differ, or none of those tests prove anything.
    const { events } = ratifiedRoundEvents();
    const finalized = projectGovernanceFederation(POT, events);
    const revoked = projectGovernanceFederation(POT, [...events, event({ kind: 'revoke', reason: 'r' }, { occurredAtMs: 5_000 })]);
    const paused = projectGovernanceFederation(POT, [...events, event({ kind: 'pause' }, { occurredAtMs: 5_000 })]);
    const partial = projectGovernanceFederation(POT, events.slice(0, 2));

    const digests = [finalized, revoked, paused, partial].map(projectionDigest);
    expect(new Set(digests).size).toBe(4);
  });

  it('converges when two offline replicas see disjoint halves and later merge', () => {
    const { events } = ratifiedRoundEvents();
    const left = events.filter((_, i) => i % 2 === 0);
    const right = events.filter((_, i) => i % 2 === 1);

    const mergedLeftFirst = ingestGovernanceEvents({ boundary: shared, known: left, incoming: right });
    const mergedRightFirst = ingestGovernanceEvents({ boundary: shared, known: right, incoming: left });
    expect(projectionDigest(mergedLeftFirst.projection)).toBe(projectionDigest(mergedRightFirst.projection));
    expect(projectionDigest(mergedLeftFirst.projection)).toBe(projectionDigest(projectGovernanceFederation(POT, events)));

    // A partial replica must NOT admit on its own — it has not seen the certificate.
    expect(admissibleCertificate(projectGovernanceFederation(POT, right), 'round-1')).toBeNull();
    expect(admissibleCertificate(mergedLeftFirst.projection, 'round-1')).not.toBeNull();
  });

  it('is idempotent on re-delivery and refuses to mutate an existing event id', () => {
    const { events } = ratifiedRoundEvents();
    const first = ingestGovernanceEvents({ boundary: shared, known: [], incoming: events });
    expect(first.accepted).toHaveLength(events.length);
    expect(first.dropped).toEqual([]);

    const replay = ingestGovernanceEvents({ boundary: shared, known: events, incoming: events });
    expect(replay.accepted).toEqual([]);
    expect(replay.dropped).toEqual([]);
    expect(projectionDigest(replay.projection)).toBe(projectionDigest(first.projection));

    const mutated: FederatedGovernanceEvent = { ...events[0]!, occurredAtMs: 9_999 };
    const conflict = ingestGovernanceEvents({ boundary: shared, known: events, incoming: [mutated] });
    expect(conflict.dropped).toMatchObject([{ eventId: events[0]!.eventId, reason: 'immutable-conflict' }]);
    expect(projectionDigest(conflict.projection)).toBe(projectionDigest(first.projection));
  });

  it('drops events whose signature does not verify', () => {
    const { events } = ratifiedRoundEvents();
    const result = ingestGovernanceEvents({ boundary: shared, known: [], incoming: events, verifySignature: (e) => e.body.kind !== 'finalize' });
    expect(result.dropped).toMatchObject([{ reason: 'unverified-signature' }]);
    expect(admissibleCertificate(result.projection, 'round-1')).toBeNull();
  });
});

describe('governance federation — conflicting finalizations are quarantined', () => {
  it('quarantines a round with two different certificates and never picks a winner', () => {
    const { events, cert } = ratifiedRoundEvents();
    const rival = buildRound('round-1', ['approve', 'approve', 'approve', 'approve']).cert;
    expect(rival.certificateHash).not.toBe(cert.certificateHash);

    const forked = [...events, event({ kind: 'finalize', certificate: rival })];
    const projection = projectGovernanceFederation(POT, forked);
    const round = projection.rounds.get('round-1');
    expect(round).toMatchObject({ status: 'quarantined' });
    expect(round?.certificates).toHaveLength(2);
    expect(round?.quarantineReason).toContain('conflicting finalizations');
    expect(admissibleCertificate(projection, 'round-1')).toBeNull();
  });

  it('quarantines regardless of which fork arrives first', () => {
    const { events, cert } = ratifiedRoundEvents();
    const rival = buildRound('round-1', ['approve', 'approve', 'approve', 'approve']).cert;
    const rivalEvent = event({ kind: 'finalize', certificate: rival });
    const a = projectGovernanceFederation(POT, [...events, rivalEvent]);
    const b = projectGovernanceFederation(POT, [rivalEvent, ...events]);
    expect(projectionDigest(a)).toBe(projectionDigest(b));
    expect(a.rounds.get('round-1')?.status).toBe('quarantined');
    expect(a.rounds.get('round-1')?.certificates.map((c) => c.certificateHash).sort()).toEqual([cert.certificateHash, rival.certificateHash].sort());
  });

  it('treats a re-sent identical certificate as one finalization, not a fork', () => {
    const { events, cert } = ratifiedRoundEvents();
    const duplicate = event({ kind: 'finalize', certificate: cert });
    const projection = projectGovernanceFederation(POT, [...events, duplicate]);
    expect(projection.rounds.get('round-1')).toMatchObject({ status: 'finalized' });
    expect(projection.rounds.get('round-1')?.certificates).toHaveLength(1);
  });
});

describe('governance federation — pause and revoke', () => {
  it('stops a paused round from admitting, even when the certificate arrives later', () => {
    const { round, votes, cert } = buildRound('round-1', ['approve', 'approve', 'approve']);
    const paused = projectGovernanceFederation(POT, [
      event({ kind: 'round-open', round }),
      ...votes.map((vote) => event({ kind: 'vote', vote })),
      event({ kind: 'pause' }, { occurredAtMs: 5_000 }),
      event({ kind: 'finalize', certificate: cert }, { occurredAtMs: 6_000 }),
    ]);
    expect(paused.rounds.get('round-1')).toMatchObject({ status: 'paused', paused: true });
    expect(admissibleCertificate(paused, 'round-1')).toBeNull();
  });

  it('re-admits after a resume', () => {
    const { events } = ratifiedRoundEvents();
    const resumed = projectGovernanceFederation(POT, [
      ...events,
      event({ kind: 'pause' }, { occurredAtMs: 5_000 }),
      event({ kind: 'resume' }, { occurredAtMs: 6_000 }),
    ]);
    expect(resumed.rounds.get('round-1')).toMatchObject({ status: 'finalized', paused: false });
    expect(admissibleCertificate(resumed, 'round-1')).not.toBeNull();
  });

  it('makes revoke terminal — a later resume cannot resurrect a revoked round', () => {
    const { events } = ratifiedRoundEvents();
    const revoked = projectGovernanceFederation(POT, [
      ...events,
      event({ kind: 'revoke', reason: 'policy breach' }, { occurredAtMs: 5_000 }),
      event({ kind: 'resume' }, { occurredAtMs: 6_000 }),
      event({ kind: 'finalize', certificate: ratifiedRoundEvents().cert }, { occurredAtMs: 7_000 }),
    ]);
    expect(revoked.rounds.get('round-1')).toMatchObject({ status: 'revoked', revokedReason: 'policy breach' });
    expect(admissibleCertificate(revoked, 'round-1')).toBeNull();
  });

  it('revokes deterministically whatever order the control events arrive in', () => {
    const { events } = ratifiedRoundEvents();
    const revoke = event({ kind: 'revoke', reason: 'policy breach' }, { occurredAtMs: 5_000 });
    const resume = event({ kind: 'resume' }, { occurredAtMs: 6_000 });
    const a = projectGovernanceFederation(POT, [...events, revoke, resume]);
    const b = projectGovernanceFederation(POT, [resume, revoke, ...events]);
    expect(projectionDigest(a)).toBe(projectionDigest(b));
    expect(a.rounds.get('round-1')?.status).toBe('revoked');
  });
});

describe('governance federation — private-pot boundaries', () => {
  it('drops events belonging to another pot', () => {
    const { events } = ratifiedRoundEvents();
    const foreign = event({ kind: 'pause' }, { potId: 'pot-beta' });
    const result = ingestGovernanceEvents({ boundary: shared, known: [], incoming: [...events, foreign] });
    expect(result.dropped).toMatchObject([{ eventId: foreign.eventId, reason: 'foreign-pot' }]);
    expect(result.projection.eventCount).toBe(events.length);
  });

  it('drops non-member peers inbound for a private pot but accepts them for a shared one', () => {
    const outsider = event({ kind: 'pause' }, { originPeerId: OUTSIDER });
    expect(ingestGovernanceEvents({ boundary: priv, known: [], incoming: [outsider] }).dropped).toMatchObject([
      { eventId: outsider.eventId, reason: 'non-member-peer' },
    ]);
    expect(ingestGovernanceEvents({ boundary: shared, known: [], incoming: [outsider] }).dropped).toEqual([]);
  });

  it('emits nothing outbound to a non-member of a private pot', () => {
    const { events } = ratifiedRoundEvents();
    expect(selectFederatableEvents({ boundary: priv, events, toPeerId: OUTSIDER })).toEqual([]);
    expect(selectFederatableEvents({ boundary: priv, events, toPeerId: PEER_B })).toHaveLength(events.length);
    // A shared pot has no such restriction — this is what makes the private case a real boundary.
    expect(selectFederatableEvents({ boundary: shared, events, toPeerId: OUTSIDER })).toHaveLength(events.length);
  });

  it('never emits a foreign pot’s events outbound, whatever the visibility', () => {
    const { events } = ratifiedRoundEvents();
    const foreign = event({ kind: 'pause' }, { potId: 'pot-beta' });
    for (const boundary of [priv, shared]) {
      const selected = selectFederatableEvents({ boundary, events: [...events, foreign], toPeerId: PEER_B });
      expect(selected.some((e) => e.potId !== POT)).toBe(false);
      expect(selected).toHaveLength(events.length);
    }
  });
});
