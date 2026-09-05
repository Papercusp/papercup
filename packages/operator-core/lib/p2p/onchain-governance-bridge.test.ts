import { describe, expect, it, vi } from 'vitest';
import {
  appendGovernanceVote,
  createGovernanceRound,
  finalizeGovernanceRound,
  verifyFinalizationCertificate,
  type FinalizationCertificate,
  type GovernanceVoteEvent,
} from '../agent-tools/plans/governance-round';
import { DEFAULT_PLAN_ADMISSION_POLICY } from '../agent-tools/plans/plan-admission-policy';
import { createPaymentChannel } from './payment-channel';
import type { SafeTreasuryConfig } from './treasury-controls';
import type { EvmSettlementConfig } from './evm-settlement';
import {
  createInMemoryMirrorLedger,
  executeOnChainMirror,
  isMirrorableActionKind,
  planOnChainMirror,
  P2P_ONLY_DECISION_KINDS,
  type BridgeAction,
  type MirrorPlan,
  type OnChainSubmitter,
} from './onchain-governance-bridge';

const token = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const CREATED_AT_MS = 1_000;
const NOW_MS = 2_000;

const treasury: SafeTreasuryConfig = {
  chainId: 42161,
  safeAddress: '0x3333333333333333333333333333333333333333',
  owners: ['0x4444444444444444444444444444444444444444', '0x5555555555555555555555555555555555555555'],
  threshold: 2,
  roles: {
    settlement: { enabled: true, maxAmountMicros: 1_000n, allowedRecipients: [recipient], allowedTokens: [token] },
    'host-payout': { enabled: false, maxAmountMicros: 100n, allowedRecipients: [recipient], allowedTokens: [token] },
    'reserve-transfer': { enabled: false, maxAmountMicros: 100n, allowedRecipients: [recipient], allowedTokens: [token] },
    'emergency-pause': { enabled: true, maxAmountMicros: 0n, allowedRecipients: [recipient], allowedTokens: [token] },
  },
};

const evm: EvmSettlementConfig = {
  chainId: 8453,
  settlementContract: '0x7777777777777777777777777777777777777777',
  stablecoin: '0x8888888888888888888888888888888888888888',
  maxBatchSize: 10,
};

function certificate(choices: readonly GovernanceVoteEvent['choice'][]): FinalizationCertificate {
  const memberIds = choices.map((_, i) => `member-${i}`);
  const round = createGovernanceRound({
    roundId: 'round-1',
    planRevisionHash: 'plan-rev-hash',
    policyVersion: DEFAULT_PLAN_ADMISSION_POLICY.policyVersion,
    eligibleMemberIds: memberIds,
    createdAtMs: CREATED_AT_MS,
  });
  if (!round.ok) throw new Error(round.detail);
  let events: GovernanceVoteEvent[] = [];
  choices.forEach((choice, i) => {
    const appended = appendGovernanceVote(round.value, events, {
      eventId: `event-${i}`,
      roundId: 'round-1',
      memberId: memberIds[i]!,
      choice,
      sequence: i,
      signature: `sig-${i}`,
    });
    if (!appended.ok) throw new Error(appended.detail);
    events = appended.value;
  });
  const finalized = finalizeGovernanceRound({ round: round.value, events, policy: DEFAULT_PLAN_ADMISSION_POLICY, nowMs: NOW_MS });
  if (!finalized.ok) throw new Error(finalized.detail);
  return finalized.value;
}

const admitted = () => certificate(['approve', 'approve', 'approve']);
const rejected = () => certificate(['approve', 'reject', 'reject']);

const transfer: BridgeAction = {
  kind: 'treasury-transfer',
  treasury,
  request: { role: 'settlement', token, recipient, amountMicros: 750n, settlementReceiptHash: 'receipt-hash', policyApproved: true },
};

const settlementBatch: BridgeAction = {
  kind: 'settlement-batch',
  evm,
  channel: createPaymentChannel('channel-1', 'evm-x402', 10_000n),
  amountMicros: 900n,
  voucherDigests: ['digest-a', 'digest-b'],
};

function mirror(action: BridgeAction, cert: FinalizationCertificate = admitted()) {
  return planOnChainMirror({ certificate: cert, authorizedByCertificateHash: cert.certificateHash, action });
}

function recordingSubmitter(txHash = '0xtx'): OnChainSubmitter & { calls: MirrorPlan[] } {
  const calls: MirrorPlan[] = [];
  return {
    calls,
    submit: async (plan) => {
      calls.push(plan);
      return { ok: true, txHash };
    },
  };
}

describe('finalization certificate verification', () => {
  it('accepts an untouched certificate and rejects one edited after finalization', () => {
    const cert = rejected();
    expect(verifyFinalizationCertificate(cert)).toBe(true);
    expect(verifyFinalizationCertificate({ ...cert, admitted: true })).toBe(false);
    expect(verifyFinalizationCertificate({ ...cert, reason: 'approved' })).toBe(false);
    expect(verifyFinalizationCertificate({ ...cert, certificateHash: '' })).toBe(false);
  });
});

describe('on-chain governance bridge — what may reach a chain', () => {
  it('mirrors a ratified treasury transfer through the bounded Safe adapter', () => {
    const result = mirror(transfer);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.plan).toMatchObject({ kind: 'treasury-transfer', roundId: 'round-1', chainId: treasury.chainId, settlement: null });
    expect(result.plan.safeTxHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.plan.mirrorId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mirrors a ratified settlement batch through the EVM adapter', () => {
    const result = mirror(settlementBatch);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.plan).toMatchObject({ kind: 'settlement-batch', chainId: evm.chainId, safeTxHash: null });
    expect(result.plan.settlement?.calldata.startsWith('0x')).toBe(true);
  });

  it('refuses a decision the pot did not admit', () => {
    const cert = rejected();
    expect(cert.admitted).toBe(false);
    expect(mirror(transfer, cert)).toMatchObject({ ok: false, code: 'certificate-not-admitted' });
  });

  it('refuses a certificate whose contents were edited after finalization', () => {
    const forged = { ...rejected(), admitted: true };
    const result = planOnChainMirror({ certificate: forged, authorizedByCertificateHash: forged.certificateHash, action: transfer });
    expect(result).toMatchObject({ ok: false, code: 'certificate-tampered' });
  });

  it('refuses an action authorized under a different round', () => {
    const cert = admitted();
    const result = planOnChainMirror({ certificate: cert, authorizedByCertificateHash: 'some-other-round-hash', action: transfer });
    expect(result).toMatchObject({ ok: false, code: 'action-not-bound-to-certificate' });
  });

  it('never mirrors a P2P-authoritative decision kind, even when ratified', () => {
    for (const kind of P2P_ONLY_DECISION_KINDS) {
      expect(isMirrorableActionKind(kind)).toBe(false);
      expect(mirror({ kind })).toMatchObject({ ok: false, code: 'decision-not-mirrorable' });
    }
  });

  it('does not let ratification bypass the bounded treasury role caps', () => {
    const overCap: BridgeAction = { kind: 'treasury-transfer', treasury, request: { role: 'settlement', token, recipient, amountMicros: 5_000n, settlementReceiptHash: 'r', policyApproved: true } };
    expect(mirror(overCap)).toMatchObject({ ok: false, code: 'treasury-refused' });
    const disabledRole: BridgeAction = { kind: 'treasury-transfer', treasury, request: { role: 'host-payout', token, recipient, amountMicros: 10n, settlementReceiptHash: 'r', policyApproved: true } };
    expect(mirror(disabledRole)).toMatchObject({ ok: false, code: 'treasury-refused' });
  });

  it('refuses a settlement batch the EVM adapter rejects', () => {
    const wrongRail: BridgeAction = { kind: 'settlement-batch', evm, channel: createPaymentChannel('channel-2', 'lightning', 10_000n), amountMicros: 10n, voucherDigests: ['d'] };
    expect(mirror(wrongRail)).toMatchObject({ ok: false, code: 'settlement-refused' });
  });
});

describe('on-chain governance bridge — execution is at-most-once and one-way', () => {
  it('submits once and replays the recorded mirror instead of double-executing', async () => {
    const submitter = recordingSubmitter('0xdeadbeef');
    const ledger = createInMemoryMirrorLedger();
    const cert = admitted();
    const request = { certificate: cert, authorizedByCertificateHash: cert.certificateHash, action: transfer };

    const first = await executeOnChainMirror({ request, submitter, ledger });
    expect(first).toMatchObject({ ok: true, txHash: '0xdeadbeef', replayed: false, decisionStanding: true });

    const second = await executeOnChainMirror({ request, submitter, ledger });
    expect(second).toMatchObject({ ok: true, replayed: true, decisionStanding: true });
    expect(submitter.calls).toHaveLength(1);
    expect(ledger.entries().size).toBe(1);
  });

  it('produces the same mirrorId for the same certificate and action, and a different one per round', () => {
    const a = mirror(transfer);
    const b = mirror(transfer);
    const otherRound = certificate(['approve', 'approve', 'approve', 'approve']);
    const c = planOnChainMirror({ certificate: otherRound, authorizedByCertificateHash: otherRound.certificateHash, action: transfer });
    // Every leg must have produced a plan, or the comparisons below prove nothing.
    if (!a.ok || !b.ok || !c.ok) throw new Error('expected all three mirrors to plan successfully');

    expect(a.plan.mirrorId).toBe(b.plan.mirrorId);
    expect(a.plan.certificateHash).not.toBe(c.plan.certificateHash);
    expect(a.plan.mirrorId).not.toBe(c.plan.mirrorId);
  });

  it('keeps the ratified decision standing when the chain submission fails, and retries cleanly', async () => {
    const failing: OnChainSubmitter = { submit: vi.fn(async () => ({ ok: false as const, detail: 'rpc timeout' })) };
    const ledger = createInMemoryMirrorLedger();
    const cert = admitted();
    const request = { certificate: cert, authorizedByCertificateHash: cert.certificateHash, action: transfer };

    const failed = await executeOnChainMirror({ request, submitter: failing, ledger });
    expect(failed).toMatchObject({ ok: false, code: 'submission-failed', decisionStanding: true });
    expect(ledger.entries().size).toBe(0);

    const retry = await executeOnChainMirror({ request, submitter: recordingSubmitter('0xretry'), ledger });
    expect(retry).toMatchObject({ ok: true, txHash: '0xretry', replayed: false });
  });

  it('reports decisionStanding false only when it refused before reaching the chain', async () => {
    const submitter = recordingSubmitter();
    const cert = rejected();
    const refused = await executeOnChainMirror({
      request: { certificate: cert, authorizedByCertificateHash: cert.certificateHash, action: transfer },
      submitter,
      ledger: createInMemoryMirrorLedger(),
    });
    expect(refused).toMatchObject({ ok: false, code: 'certificate-not-admitted', decisionStanding: false });
    expect(submitter.calls).toHaveLength(0);
  });
});
