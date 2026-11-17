/**
 * _bulk.ts — the ONE keyed-array bulk I/O contract for agent-facing tools
 * (bulk-endpoint-standardization-2026-06-21, D-001).
 *
 * The schema-neutral executor lives in `@papercusp/tooldef/_bulk` (universal
 * framework tool batching P-002), below both operator-core and agent-mcp.
 * `@papercusp/agent-mcp/_bulk` re-exports the same executor and schema helpers.
 * This module preserves that compatibility API verbatim so existing importers
 * (`import { … } from '../_bulk'`) are unchanged. Import the contract from here
 * (operator-core) or from `@papercusp/agent-mcp` (agent-mcp) — same symbols.
 *
 * Re-export from the LEAF subpath (`@papercusp/agent-mcp/_bulk`), NOT the barrel
 * (`@papercusp/agent-mcp`): the barrel index pulls the whole package, and through
 * some tools' import graphs (the memory tools) that forms an ESM circular init in
 * which the barrel's `_bulk` re-exports are still `undefined` when the consumer's
 * module body runs (`mergeIds is not a function` / `bulkContent is not a function`
 * — the b1-timeout green-gate red). The leaf only re-exports tooldef helpers,
 * avoiding the agent-mcp barrel cycle.
 */
export { scalarOrArray, toList, mergeIds, runBulk, mergeBulkEnvelopes, bulkContent, bulkEnvelopeSchema } from '@papercusp/agent-mcp/_bulk';
export type { BulkItemResult, BulkEnvelope } from '@papercusp/agent-mcp/_bulk';
