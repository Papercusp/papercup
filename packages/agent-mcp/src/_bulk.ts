/**
 * Compatibility leaf and Zod authoring adapters for the shared bulk helpers.
 *
 * The neutral implementation lives below the host in @papercusp/tooldef/_bulk so
 * framework definition and dispatch reuse it without a dependency cycle.
 * Keep this leaf (rather than the host barrel) for existing imports.
 * Schema authoring stays here so the executor does not load Zod.
 */
import { z } from 'zod';

export {
  toList, mergeIds, runBulk, mergeBulkEnvelopes, bulkContent,
} from '@papercusp/tooldef/_bulk';
export type { BulkItemResult, BulkEnvelope } from '@papercusp/tooldef/_bulk';

/** Accept a scalar or an array of the same logical item. Normalize with toList. */
export function scalarOrArray<T extends z.ZodTypeAny>(item: T) {
  return z.union([item, z.array(item)]);
}

/**
 * Zod projection of the shared BulkEnvelope contract. Existing callers keep
 * this adapter while execution and envelope types stay schema-neutral below it.
 * The default item is open because tools add their own correlation/result fields.
 */
export function bulkEnvelopeSchema<T extends z.ZodTypeAny>(item?: T) {
  return z.object({
    // Partial failure remains representable; runBulk derives this value from counts.
    ok: z.boolean(),
    results: z.array(
      item ??
        z
          .object({
            ok: z.boolean(),
            error: z.string().optional(),
          })
          .passthrough(),
    ),
    counts: z.object({
      ok: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
  });
}
