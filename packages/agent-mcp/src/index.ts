/**
 * @papercusp/agent-mcp public surface.
 *
 * This package provides:
 *   - `defineTool({ ... })` for declaring MCP tools that self-register.
 *   - `dispatch({ toolName, args, bearer })` for in-process callers
 *     (Operator/Oracle) to invoke tools without an MCP transport.
 *   - `startServer()` for stdio MCP transport (out-of-process consumers
 *     like pi sessions).
 *
 * Tools live under `src/tools/<group>/<verb>.ts`. Importing `bootstrap`
 * (or running `startServer`) imports them all and populates the catalog.
 */

export { defineTool } from './define-tool';
export { dispatch, startServer } from './server';
export { getCatalog, lookup } from './registry';
export { resolveBearer } from './auth';
export { tierFor } from './capability-tiers';
export type {
  Principal,
  PrincipalKind,
  CapabilityTier,
  ToolContext,
  ToolDefinition,
  ToolResponse,
} from './types';

import './bootstrap';
