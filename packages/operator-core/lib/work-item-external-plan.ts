import { z } from 'zod';
import { sessionOutsidePlanRefSchema } from './session-outside-plan';

// The external system owns the spelling. Validate without trimming or parsing it.
export const externalPlanRefSchema = z.string().refine(
  value => value.trim().length > 0 && !value.includes('\0'),
  'An external plan reference must contain text and must be representable in PostgreSQL.',
);

// The new launch/create spelling has a contractual limit. Historical references
// retain their original spelling and length through external_plan_ref and reads.
export const workItemPlanRefSchema = sessionOutsidePlanRefSchema;

// Persisted identities have no new length cap. The legacy argument above keeps
// its original validation; newly launched opaque labels may consist of spaces.
const storedExternalPlanRefSchema = z.string().min(1).refine(value => !value.includes('\0'));

export function resolveWorkItemOutsidePlanRef(
  input: { planRef?: string; external_plan_ref?: string; payload?: unknown; plan_item?: unknown },
  defaultRef?: string | null,
): string | undefined {
  if (input.planRef !== undefined) workItemPlanRefSchema.parse(input.planRef);
  if (input.external_plan_ref !== undefined) externalPlanRefSchema.parse(input.external_plan_ref);
  if (input.planRef !== undefined && input.external_plan_ref !== undefined && input.planRef !== input.external_plan_ref) {
    throw new Error('Conflicting planRef and external_plan_ref; provide the same outside plan reference or only one spelling');
  }
  const explicit = input.planRef ?? input.external_plan_ref;
  const payloadRef = externalPlanRefFromPayload(input.payload);
  const ref = explicit ?? payloadRef ?? defaultRef ?? undefined;
  if (ref !== undefined) {
    // Preserve the preexisting explicit-field/payload conflict check.
    payloadWithExternalPlanRef(input.payload, ref);
    const payload = input.payload as Record<string, unknown> | null | undefined;
    if (input.plan_item != null || payload?.plan_item != null || payload?.planItem != null ||
        payload?.source_plan_slug != null ||
        (Array.isArray(payload?.source_plan_item_ids) && payload.source_plan_item_ids.length > 0)) {
      throw new Error('A work-item cannot carry both plan_item and an outside plan reference (planRef / external_plan_ref)');
    }
  }
  return ref;
}

export function externalPlanRefFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || !('externalPlanRef' in payload)) return undefined;
  const ref = payload.externalPlanRef;
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined;
}

export function payloadWithExternalPlanRef(payload: unknown, ref?: string): unknown {
  if (ref === undefined) return payload;
  storedExternalPlanRefSchema.parse(ref);
  if (payload != null && (typeof payload !== 'object' || Array.isArray(payload))) {
    throw new Error('An externally referenced work item requires an object payload');
  }
  const source = payload as Record<string, unknown> | null | undefined;
  if (source?.externalPlanRef !== undefined && source.externalPlanRef !== ref) {
    throw new Error('Conflicting external plan references in create input and payload');
  }
  return { ...source, externalPlanRef: ref };
}
