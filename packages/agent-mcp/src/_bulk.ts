/**
 * Compatibility leaf for the shared bulk helpers.
 *
 * The implementation lives below the host in @papercusp/tooldef/_bulk so
 * framework definition and dispatch reuse it without a dependency cycle.
 * Keep this leaf (rather than the host barrel) for existing imports.
 */
export {
  scalarOrArray, toList, mergeIds, runBulk, mergeBulkEnvelopes,
  bulkContent, bulkEnvelopeSchema,
} from '@papercusp/tooldef/_bulk';
export type { BulkItemResult, BulkEnvelope } from '@papercusp/tooldef/_bulk';
