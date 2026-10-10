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

/** WI-10007568: completing the task that carries out a pause is not a resume.
 * Keep this legacy contradiction narrow: other terminal dependencies remain valid,
 * and an explicit owner disposition can still repair/clear the malformed contract. */
export function pauseCompletionResumeContradiction(condition: string, trigger: string): string | null {
  if (!/^work-item:done:[^\s]+$/.test(trigger.trim())) return null;
  const normalized = condition.normalize('NFKC').toLowerCase().replace(/[‐‑‒–—]/g, '-');
  if (!/\b(?:ending|ends?|lifting|lifts?)\s+(?:this|the)\s+system[ -]wide\s+pause\b/.test(normalized)) return null;
  return 'completion of a pause task does not verify an explicit owner resume; repair the release condition and supply resume authority';
}

/** SPEC-BQL-P-004-CLEARER: a park whose trigger is the parked item's OWN terminal event can
 * never release the park. `work-item:done:<id>` fires only once the item is already finished,
 * and the catalogue's live resolver reports it reachable regardless (measured 2026-10-10:
 * four live parks, each stamped 'reachable'). That is a reservation encoded as a park, so it
 * is an unverified contract to repair, not a reachable one. */
export function selfReleaseTriggerContradiction(trigger: string, parkId: string | null | undefined): string | null {
  const id = parkId?.trim();
  if (!id || trigger.trim() !== `work-item:done:${id}`) return null;
  return `trigger ${trigger.trim()} is the parked item's own terminal event; it fires only after the item is finished, so it can never release this park. Declare the condition that permits resumption, or assign the item to its reserving owner instead of parking it`;
}

/** Every contract shape that can never verify its own release, in precedence order. */
export function releaseContractContradiction(
  condition: string,
  trigger: string,
  parkId?: string | null,
): string | null {
  return pauseCompletionResumeContradiction(condition, trigger) ?? selfReleaseTriggerContradiction(trigger, parkId);
}

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

/** Resolve, rather than trust, the release condition. Only a specific condition's
 * fired latch is satisfied; broad wakes and unmeasured keys remain unverified. */
export async function buildDurableParkReleaseContract(
  input: { condition: string; trigger: string; owner?: string; parkId?: string | null },
  defaultOwner: string,
): Promise<DurableParkReleaseContract> {
  const contradiction = releaseContractContradiction(input.condition, input.trigger, input.parkId);
  if (contradiction) {
    return {
      condition: input.condition.trim(), owner: input.owner?.trim() || defaultOwner,
      trigger: input.trigger.trim(), reachability: 'blocked', evidence: contradiction,
    };
  }
  const reachability = await readEventConditionReachability(input.trigger, { requireSpecificCondition: true });
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
