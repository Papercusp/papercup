/**
 * _bulk.ts — the ONE keyed-array bulk I/O contract for agent-facing tools
 * (bulk-endpoint-standardization-2026-06-21, D-001).
 *
 * RELOCATED to `@papercusp/agent-mcp` (bulk-endpoint-standardization P-005): the
 * canonical implementation now lives in `packages/agent-mcp/src/_bulk.ts`, the
 * lowest package both operator-core's tools AND agent-mcp's read-side tools
 * (artifacts/features) can import — agent-mcp cannot import a helper that lives up
 * in operator-core (dep direction is operator-core → agent-mcp). This module
 * re-exports it verbatim so the ~64 existing operator-core importers
 * (`import { … } from '../_bulk'`) are unchanged. Import the contract from here
 * (operator-core) or from `@papercusp/agent-mcp` (agent-mcp) — same symbols.
 */
export { scalarOrArray, toList, mergeIds, runBulk, bulkContent } from '@papercusp/agent-mcp';
export type { BulkItemResult, BulkEnvelope } from '@papercusp/agent-mcp';
