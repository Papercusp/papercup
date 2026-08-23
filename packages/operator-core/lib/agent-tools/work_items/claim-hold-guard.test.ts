/**
 * claim-hold-guard.test.ts — WI-5946: pure-function unit coverage for assessClaimHoldGuard,
 * independent of work_items:claim's tool-layer wiring (see claim.test.ts's
 * "claim-hold guard (WI-5946)" block for the end-to-end tool behavior).
 */
import { describe, expect, it } from 'vitest';
import { assessClaimHoldGuard } from './claim-hold-guard';

describe('assessClaimHoldGuard (WI-5946)', () => {
  it('returns null (proceed) for a payload with no claim-hold at all', () => {
    expect(assessClaimHoldGuard(null, {})).toBeNull();
    expect(assessClaimHoldGuard({}, {})).toBeNull();
    expect(assessClaimHoldGuard({ _claimHold: false }, {})).toBeNull();
  });

  it('refuses a held_open lease without force, naming the holder + reason + convention', () => {
    const refusal = assessClaimHoldGuard(
      { _claimHold: true, held_open_by: 'su-leader', held_open_reason: 'still verifying', held_open_at: '2026-07-26T00:00:00Z' },
      {},
    );
    expect(refusal).toMatchObject({
      error: 'claim_hold_blocked',
      heldBy: 'su-leader',
      heldReason: 'still verifying',
      convention: 'held_open (lease)',
    });
    expect(refusal?.hint).toMatch(/force:true/);
  });

  it('refuses a durable claim_hold park without force', () => {
    const refusal = assessClaimHoldGuard(
      { _claimHold: true, claim_hold_by: 'su-leader', claim_hold_reason: 'recurring do-not-pick-up', claim_hold_at: '2026-07-26T00:00:00Z' },
      {},
    );
    expect(refusal).toMatchObject({ error: 'claim_hold_blocked', heldBy: 'su-leader', convention: 'claim_hold (durable park)' });
  });

  it('force:true clears a plain (non-policy) hold', () => {
    const refusal = assessClaimHoldGuard(
      { _claimHold: true, held_open_by: 'su-leader', held_open_reason: 'still verifying' },
      { force: true },
    );
    expect(refusal).toBeNull();
  });

  it('a D-NNN-cited reason is treated as policy-tier: force alone is refused', () => {
    const refusal = assessClaimHoldGuard(
      { _claimHold: true, claim_hold_by: 'su-leader', claim_hold_reason: 'D-003 explicit policy-tier human gate — owner sign-off required' },
      { force: true },
    );
    expect(refusal).toMatchObject({ error: 'policy_gate_requires_owner_override' });
    expect(refusal?.hint).toMatch(/ownerOverride/);
  });

  it('a policy-tier reason clears ONLY with BOTH force and ownerOverride', () => {
    const payload = { _claimHold: true, claim_hold_by: 'su-leader', claim_hold_reason: 'policy-tier gate, D-003' };
    expect(assessClaimHoldGuard(payload, { ownerOverride: true })?.error).toBe('claim_hold_blocked'); // force still missing
    expect(assessClaimHoldGuard(payload, { force: true, ownerOverride: true })).toBeNull();
  });

  it('matches the exact three policy-gate phrasings looksLikePolicyGate recognizes', () => {
    for (const reason of ['D-003 says no', 'triageDecision:"gate"', 'a policy-tier decision']) {
      const refusal = assessClaimHoldGuard({ _claimHold: true, held_open_by: 'x', held_open_reason: reason }, { force: true });
      expect(refusal?.error).toBe('policy_gate_requires_owner_override');
    }
  });

  it('appends durable role/fleet routing guidance when the holder session is dead', () => {
    const refusal = assessClaimHoldGuard(
      { _claimHold: true, claim_hold_by: 'su-dead-session', claim_hold_reason: 'still triaging' },
      { holderGuidance: '🔑 Use `@role:gate-recovery` or `@fleet-leader:drain`.' },
    );
    expect(refusal?.hint).toContain('@role:gate-recovery');
    expect(refusal?.hint).toContain('@fleet-leader:drain');
  });
});
