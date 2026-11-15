/**
 * The one wire format for a refused plan-start proof. Both throw sites (the readiness leg in
 * plan-execution-authority.ts and the owner-review leg in plan-start-owner-review.ts) format through
 * here, and plans:start parses through here, so the producer and the consumer cannot drift.
 *
 * Why it exists (EI-28846208842044311): plans:start used to fold the inner refusal into the tail of
 * a long promotion summary. When a door timeout or result spill swallowed that message, the caller
 * saw only the generic `plan_start_authority_unavailable` code and treated an actionable, permanent
 * refusal (`activation_audit_stale`) as a load-transient failure to retry.
 */
export const PLAN_START_PROOF_REFUSED_PREFIX = 'plan_start_proof_refused:';

export function formatPlanStartProofRefusal(blockers: readonly string[]): string {
  return `${PLAN_START_PROOF_REFUSED_PREFIX}${blockers.join(',')}`;
}

/** Blocker codes carried by a refusal message; `[]` when the message is not a proof refusal. */
export function parsePlanStartProofRefusal(message: string): string[] {
  if (!message.startsWith(PLAN_START_PROOF_REFUSED_PREFIX)) return [];
  return message.slice(PLAN_START_PROOF_REFUSED_PREFIX.length).split(',').map(code => code.trim()).filter(Boolean);
}

const REPAIR_BY_BLOCKER: Readonly<Record<string, string>> = {
  activation_audit_stale:
    'Re-run plans:audit { phase:"activation" } against the current revision, then retry plans:start with a NEW idempotency key.',
  activation_revision_unmeasured:
    'Record plans:audit { phase:"activation" } against the current revision, then retry plans:start with a NEW idempotency key.',
};

/** A caller-facing repair for known blockers; null when no specific repair is registered. */
export function planStartProofRepair(blockers: readonly string[]): string | null {
  const repairs = blockers.map(code => REPAIR_BY_BLOCKER[code]).filter((r): r is string => Boolean(r));
  return repairs.length ? [...new Set(repairs)].join(' ') : null;
}
