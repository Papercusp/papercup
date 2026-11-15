import { describe, expect, it } from 'vitest';
import {
  PLAN_START_PROOF_REFUSED_PREFIX,
  formatPlanStartProofRefusal,
  parsePlanStartProofRefusal,
  planStartProofRepair,
} from './plan-start-proof-refusal';

// EI-28846208842044311: plans:start must surface the inner proof refusal as structured blockers so
// an actionable refusal (activation_audit_stale) is never mistaken for a load-transient failure.
describe('plan-start proof refusal wire format', () => {
  it('round-trips the blockers the producer formats', () => {
    const blockers = ['activation_audit_stale', 'plan_spec_quality_blocked'];
    expect(parsePlanStartProofRefusal(formatPlanStartProofRefusal(blockers))).toEqual(blockers);
  });

  it('parses the exact message the readiness leg threw in the 2026-11-15 refusal', () => {
    expect(parsePlanStartProofRefusal('plan_start_proof_refused:activation_audit_stale'))
      .toEqual(['activation_audit_stale']);
  });

  it('returns no blockers for a non-proof failure, so callers fall back to the raw error', () => {
    expect(parsePlanStartProofRefusal('plan_not_found')).toEqual([]);
    expect(parsePlanStartProofRefusal('plan_start_promotion_incomplete')).toEqual([]);
    expect(parsePlanStartProofRefusal(PLAN_START_PROOF_REFUSED_PREFIX)).toEqual([]);
  });

  it('drops empty and whitespace-only codes without losing real ones', () => {
    expect(parsePlanStartProofRefusal(`${PLAN_START_PROOF_REFUSED_PREFIX}a,, b ,`)).toEqual(['a', 'b']);
  });

  it('names the activation re-audit repair for a stale activation audit', () => {
    const repair = planStartProofRepair(['activation_audit_stale']);
    expect(repair).toContain('phase:"activation"');
    expect(repair).toContain('NEW idempotency key');
  });

  it('returns null when no repair is registered, never a fabricated one', () => {
    expect(planStartProofRepair(['review_receipt_missing'])).toBeNull();
    expect(planStartProofRepair([])).toBeNull();
  });
});
