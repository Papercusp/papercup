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
export { defineUITool } from './define-ui-tool';
export type { UIToolDefinitionInput, UIToolHandlerResult } from './define-ui-tool';
export { defineResource } from './define-resource';
export { definePrompt } from './define-prompt';
export {
  dispatch,
  getPrompt,
  listPrompts,
  listResources,
  readResource,
  startServer,
} from './server';
export { getCatalog, lookup } from './registry';
export {
  getResourceCatalog,
  lookupResource,
  matchResource,
} from './resource-registry';
export { getPromptCatalog, lookupPrompt } from './prompt-registry';
export { resolveBearer } from './auth';
export { tierFor } from './capability-tiers';

// Per-spawn URL-param parser — used by both projected-tool transports
// to extract harness/workspace/role/feature/chunk/run/spawn from the
// orchestrator-baked URL.
export {
  parseRequestContext,
  InvalidRequestContextError,
  type PluginRequestContext,
} from './spawn-context';

// Function-as-truth projected tool registry — every tool is a function;
// HTTP and MCP are projections of it. Spec: plugin-mcp-host-design.md.
export {
  registerProjectedTool,
  unregisterProjectedToolsForPlugin,
  lookupByMcpName,
  lookupByHttpPath,
  listAllProjectedTools,
  listMcpProjections,
  ToolRegistrationError,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
  type ToolFn,
  type ToolExposure,
  type ToolExposureHttp,
  type ToolExposureMcp,
  type UnifiedToolContext,
} from './tool-projection';

export {
  dispatchProjectedTool,
  computeProjectedQuotaWindowKey,
  UnauthorizedToolError,
  type DispatchProjectedDeps,
  type DispatchProjectedResult,
  type DispatchProjectedErrorCode,
} from './dispatch-projected';

export {
  handleHttpToolRequest,
  handleHttpToolRequestStreaming,
  buildHttpSpawnContext,
  PAPERCUSP_CONTEXT_HEADERS,
  type HttpToolRequest,
  type HttpToolResponse,
  type HttpToolResult,
  type HttpToolHostExtras,
  type HttpRequestContextInput,
} from './http-projection';
export type {
  Principal,
  PrincipalKind,
  CapabilityTier,
  ToolContext,
  ToolDefinition,
  ToolResponse,
  ResourceContext,
  ResourceContents,
  ResourceDefinition,
  ResourceListEntry,
  PromptContext,
  PromptDefinition,
  PromptMessage,
  PromptResult,
} from './types';

import './bootstrap';
