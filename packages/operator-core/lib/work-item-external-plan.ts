import { z } from 'zod';

// The external system owns the spelling. Validate without trimming or parsing it.
export const externalPlanRefSchema = z.string().refine(
  value => value.trim().length > 0 && !value.includes('\0'),
  'An external plan reference must contain text and must be representable in PostgreSQL.',
);

export function externalPlanRefFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || !('externalPlanRef' in payload)) return undefined;
  const ref = payload.externalPlanRef;
  return typeof ref === 'string' && ref.trim().length > 0 ? ref : undefined;
}

export function payloadWithExternalPlanRef(payload: unknown, ref?: string): unknown {
  if (ref === undefined) return payload;
  externalPlanRefSchema.parse(ref);
  if (payload != null && (typeof payload !== 'object' || Array.isArray(payload))) {
    throw new Error('An externally referenced work item requires an object payload');
  }
  const source = payload as Record<string, unknown> | null | undefined;
  if (source?.externalPlanRef !== undefined && source.externalPlanRef !== ref) {
    throw new Error('Conflicting external plan references in create input and payload');
  }
  return { ...source, externalPlanRef: ref };
}
