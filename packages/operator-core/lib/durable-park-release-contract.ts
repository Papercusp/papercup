/**
 * durable-park-release-contract.ts — the ONE writer shape for a durable park's typed
 * release contract. Shared by `work_items:release { claimHold }` and the plan supersede
 * cascade (review-system-rework-reduction-2026-09-23 P-030), so both parkers resolve the
 * condition's live event status the same way.
 *
 * Deliberately its own module: it reads reachability through an IMPORT of
 * `readEventConditionReachability`, so a test that mocks `./external-condition-reachability`
 * governs this builder too (an intra-module call would bypass that mock).
 */
import { readEventConditionReachability } from './external-condition-reachability';
import type { DurableParkReleaseContract } from './work-items-durable-park-audit';

/** Reject incomplete durable parks at the shared write boundary, including internal producers. */
export function assertDurableParkReleaseContract(value: unknown): void {
  const contract = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const missing = ['condition', 'owner', 'trigger', 'evidence'].filter(
    (key) => typeof contract[key] !== 'string' || !(contract[key] as string).trim(),
  );
  if (!['reachable', 'blocked', 'unreachable', 'satisfied'].includes(String(contract.reachability))) {
    missing.push('reachability');
  }
  if (missing.length) {
    throw new Error(`durable park requires a complete release contract: ${missing.join(', ')}`);
  }
}

/** Resolve, rather than trust, the release condition. A fired latch is already satisfied;
 * an unregistered/unmeasured key is blocked, never guessed unreachable from age or prose. */
export async function buildDurableParkReleaseContract(
  input: { condition: string; trigger: string; owner?: string },
  defaultOwner: string,
): Promise<DurableParkReleaseContract> {
  const reachability = await readEventConditionReachability(input.trigger);
  return {
    condition: input.condition.trim(),
    owner: input.owner?.trim() || defaultOwner,
    trigger: input.trigger.trim(),
    reachability:
      reachability.basis === 'fired'
        ? 'satisfied'
        : reachability.verdict === 'reachable'
          ? 'reachable'
          : reachability.verdict === 'impossible'
            ? 'unreachable'
            : 'blocked',
    evidence: reachability.evidence,
  };
}
