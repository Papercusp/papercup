/** Immutable shared-pot governance round records and deterministic rebuild (P-002). */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../authority/authority-rpc-envelope';
import { evaluatePlanAdmission, type PlanAdmissionPolicy, type PlanVote } from './plan-admission-policy';

export interface GovernanceRound {
  readonly roundId: string;
  readonly planRevisionHash: string;
  readonly policyVersion: number;
  readonly eligibleMemberIds: readonly string[];
  readonly createdAtMs: number;
}

export interface GovernanceVoteEvent {
  readonly eventId: string;
  readonly roundId: string;
  readonly memberId: string;
  readonly choice: PlanVote['choice'];
  readonly sequence: number;
  readonly signature: string;
}

export interface FinalizationCertificate {
  readonly roundId: string;
  readonly planRevisionHash: string;
  readonly policyVersion: number;
  readonly admitted: boolean;
  readonly reason: string;
  readonly voteEventIds: readonly string[];
  readonly finalizedAtMs: number;
  readonly certificateHash: string;
}

export type GovernanceRoundError = 'invalid-round' | 'duplicate-member' | 'unknown-member' | 'duplicate-event' | 'invalid-sequence';
export type RoundResult<T> = { ok: true; value: T } | { ok: false; code: GovernanceRoundError; detail: string };

export function createGovernanceRound(input: Omit<GovernanceRound, 'createdAtMs'> & { createdAtMs: number }): RoundResult<GovernanceRound> {
  if (!input.roundId.trim() || !input.planRevisionHash.trim() || !Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1 || !Number.isFinite(input.createdAtMs)) return { ok: false, code: 'invalid-round', detail: 'round id, plan revision, policy epoch, and timestamp are required' };
  if (input.eligibleMemberIds.length === 0 || new Set(input.eligibleMemberIds).size !== input.eligibleMemberIds.length || input.eligibleMemberIds.some((id) => !id.trim())) return { ok: false, code: 'duplicate-member', detail: 'eligible member snapshot must contain unique non-empty ids' };
  return { ok: true, value: Object.freeze({ ...input, eligibleMemberIds: [...input.eligibleMemberIds] }) };
}

export function appendGovernanceVote(round: GovernanceRound, events: readonly GovernanceVoteEvent[], event: GovernanceVoteEvent): RoundResult<GovernanceVoteEvent[]> {
  if (event.roundId !== round.roundId || !round.eligibleMemberIds.includes(event.memberId)) return { ok: false, code: 'unknown-member', detail: 'vote round or member does not match the immutable eligibility snapshot' };
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0 || !event.signature.trim()) return { ok: false, code: 'invalid-sequence', detail: 'vote sequence and signature are required' };
  if (events.some((e) => e.eventId === event.eventId || e.memberId === event.memberId)) return { ok: false, code: 'duplicate-event', detail: 'event id and member vote must be unique within a round' };
  return { ok: true, value: [...events, event].sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId)) };
}

function certificateHash(cert: Omit<FinalizationCertificate, 'certificateHash'>): string {
  return createHash('sha256').update(canonicalJson(cert)).digest('hex');
}

export function finalizeGovernanceRound(input: { round: GovernanceRound; events: readonly GovernanceVoteEvent[]; policy: PlanAdmissionPolicy; nowMs: number }): RoundResult<FinalizationCertificate> {
  const votes: PlanVote[] = input.events.map((e) => ({ memberId: e.memberId, choice: e.choice }));
  const verdict = evaluatePlanAdmission(input.policy, { planRevisionHash: input.round.planRevisionHash, policyVersion: input.round.policyVersion, eligibleMemberIds: [...input.round.eligibleMemberIds], votes, ratifiedAtMs: input.round.createdAtMs }, input.nowMs);
  const base: Omit<FinalizationCertificate, 'certificateHash'> = { roundId: input.round.roundId, planRevisionHash: input.round.planRevisionHash, policyVersion: input.round.policyVersion, admitted: verdict.admitted, reason: verdict.reason, voteEventIds: input.events.map((e) => e.eventId).sort(), finalizedAtMs: input.nowMs };
  return { ok: true, value: { ...base, certificateHash: certificateHash(base) } };
}

/** Recompute a certificate's hash and compare: any field edited after finalization fails this. */
export function verifyFinalizationCertificate(cert: FinalizationCertificate): boolean {
  const { certificateHash: claimed, ...base } = cert;
  return typeof claimed === 'string' && claimed.length > 0 && certificateHash(base) === claimed;
}

export function rebuildGovernanceRound(round: GovernanceRound, events: readonly GovernanceVoteEvent[]): RoundResult<GovernanceVoteEvent[]> {
  let current: GovernanceVoteEvent[] = [];
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId))) {
    const result = appendGovernanceVote(round, current, event);
    if (!result.ok) return result;
    current = result.value;
  }
  return { ok: true, value: current };
}
