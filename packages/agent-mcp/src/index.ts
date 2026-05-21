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
export {
  onWorkspaceSwitch,
  dispatchWorkspaceSwitch,
} from './workspace-lifecycle';
export type { WorkspaceSwitchCallback } from './workspace-lifecycle';
export {
  openRun,
  closeRun,
  setOpenCards,
  setToolState,
  getSnapshot,
  subscribe as subscribeStateChannel,
  subscribeWorkspace,
  snapshotWorkspace,
  dropStateSnapshotsForWorkspaceSwitch,
} from './state-channel';
export type {
  StateSnapshot,
  VersionedSnapshot,
} from './state-channel';
export {
  registerCard,
  resolveCardResponse,
  cancelPendingCardsForRun,
  cancelPendingCardsForWorkspaceSwitch,
  _resetCardCorrelatorForTests,
} from './card-correlator';
export { _resetStateChannelForTests } from './state-channel';
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
  emitToSseSink,
  isPapercuspBinaryEnvelope,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
  type ToolFn,
  type ToolExposure,
  type ToolExposureHttp,
  type ToolExposureMcp,
  type UnifiedToolContext,
  type MinimalEventSink,
  type PapercuspBinaryEnvelope,
} from './tool-projection';

export {
  dispatchProjectedTool,
  dispatchProjectedToolStream,
  computeProjectedQuotaWindowKey,
  UnauthorizedToolError,
  PASS_THROUGH,
  type DispatchProjectedDeps,
  type DispatchProjectedResult,
  type DispatchProjectedErrorCode,
  type DispatchStreamEvent,
  type ToolDispatchOverrideFn,
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
  PrincipalAuthMethod,
  PrincipalTrust,
  PrincipalRequirements,
  RouteAuth,
  RouteMethod,
  RouteContext,
  RouteDefinition,
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
  CardSpec,
  CardResponse,
  CardPresentation,
  CardOption,
  OpenCardSnapshot,
} from './types';

export {
  readBuffer as readReplayBuffer,
  closeBuffer as closeReplayBuffer,
  replayBufferStats,
  type BufferedEvent as ReplayBufferedEvent,
} from './replay-buffer';

export {
  validatePluginEventSchema,
  validateAndClassifyPluginEvents,
  classifyEventWireFromJsonSchema,
  PluginEventSchemaError,
  SUPPORTED_KEYWORDS as PLUGIN_EVENT_SUPPORTED_KEYWORDS,
  REJECTED_KEYWORDS as PLUGIN_EVENT_REJECTED_KEYWORDS,
} from './plugin-events';

export {
  toolToOpenApiFragment,
  standardResponseComponents,
  type OpenApiFragment,
} from './openapi-fragments';
export {
  assembleOpenApiDocument,
  toolOperationName,
  type OpenApiDocumentOptions,
} from './openapi-assemble';

import './bootstrap';
