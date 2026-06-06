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
import './capability-tiers-papercusp';
export { defineTool } from '@papercusp/tooldef';
export { AGENT_ROLES, BRAIN_PRINCIPAL_ROLE } from './role-config';
export type { BuiltinAgentRole } from './role-config';
export type { AgentRole, RoleRegistry } from '@papercusp/tooldef';
export { defineUITool } from './define-ui-tool';
export type { UIToolDefinitionInput, UIToolHandlerResult } from './define-ui-tool';
export { defineResource } from '@papercusp/tooldef';
export { definePrompt } from '@papercusp/tooldef';
export { dispatch, getPrompt, listPrompts, listResources, readResource, startServer, } from './server';
export { getCatalog, lookup } from '@papercusp/tooldef';
export { serializeToolResponse, formatOptsFromCtx, type SerializeFormatOpts, type SerializedToolResult, } from '@papercusp/tooldef';
export { applyToolManifest, reloadToolManifest, hasToolManifest, } from './tool-manifest';
export { getResourceCatalog, lookupResource, matchResource, } from '@papercusp/tooldef';
export { getPromptCatalog, lookupPrompt } from '@papercusp/tooldef';
export { resolveBearer } from './auth';
export { sanitizeToolSchema } from './tool-schema-sanitize';
export { onWorkspaceSwitch, dispatchWorkspaceSwitch, } from '@papercusp/tooldef';
export type { WorkspaceSwitchCallback } from '@papercusp/tooldef';
export { openRun, closeRun, setOpenCards, setToolState, getSnapshot, subscribeStateChannel, subscribeWorkspace, snapshotWorkspace, dropStateSnapshotsForWorkspaceSwitch, } from '@papercusp/tooldef';
export type { StateSnapshot, VersionedSnapshot, } from '@papercusp/tooldef';
export { registerCard, resolveCardResponse, cancelPendingCardsForRun, cancelPendingCardsForWorkspaceSwitch, _resetCardCorrelatorForTests, } from '@papercusp/tooldef';
export { _resetStateChannelForTests } from '@papercusp/tooldef';
export { tierFor, setCapabilityTierResolver } from '@papercusp/tooldef';
export { papercuspTierFor } from './capability-tiers-papercusp';
export { parseRequestContext, InvalidRequestContextError, type PluginRequestContext, } from './spawn-context';
export { registerProjectedTool, unregisterProjectedToolsForPlugin, lookupByMcpName, lookupByHttpPath, listAllProjectedTools, listMcpProjections, ToolRegistrationError, emitToSseSink, isPapercuspBinaryEnvelope, _resetProjectionRegistryForTests, type ProjectedTool, type ToolFn, type ToolExposure, type ToolExposureHttp, type ToolExposureMcp, type UnifiedToolContext, type MinimalEventSink, type PapercuspBinaryEnvelope, } from '@papercusp/tooldef';
export { dispatchProjectedTool, dispatchProjectedToolStream, defaultComputeQuotaWindow, UnauthorizedToolError, HarnessRequiredError, PASS_THROUGH, type QuotaWindow, type DispatchProjectedDeps, type DispatchProjectedResult, type DispatchProjectedErrorCode, type DispatchStreamEvent, type PostInvokeEvent, type ToolDispatchOverrideFn, } from '@papercusp/tooldef';
export type { ToolRequireSpec, ToolPreInvokeEvent, PreconditionFireRequest, } from '@papercusp/tooldef';
export { papercuspComputeQuotaWindow } from './quota-policy';
export { papercuspGateBypass } from './gate-bypass';
export type { GateBypass } from '@papercusp/tooldef';
export { ownerOnly } from '@papercusp/tooldef';
export type { AuthzQuery, AuthDecision, PolicyDecisionPoint, AuthAuditEvent, Authorizer, } from '@papercusp/tooldef';
export { handleHttpToolRequest, handleHttpToolRequestStreaming, buildHttpSpawnContext, PAPERCUSP_CONTEXT_HEADERS, type HttpToolRequest, type HttpToolResponse, type HttpToolResult, type HttpToolHostExtras, type ToolScope, type HttpRequestContextInput, } from '@papercusp/tooldef-http';
export type { Principal, PrincipalKind, PrincipalAuthMethod, PrincipalTrust, PrincipalRequirements, RouteAuth, RouteMethod, RouteContext, RouteDefinition, CapabilityTier, ToolContext, ToolDefinition, ToolResponse, ResourceContext, ResourceContents, ResourceDefinition, ResourceListEntry, PromptContext, PromptDefinition, PromptMessage, PromptResult, CardSpec, CardResponse, CardPresentation, CardOption, OpenCardSnapshot, } from '@papercusp/tooldef';
export { readReplayBuffer, closeReplayBuffer, replayBufferStats, type ReplayBufferedEvent, } from '@papercusp/tooldef';
export { validatePluginEventSchema, validateAndClassifyPluginEvents, classifyEventWireFromJsonSchema, PluginEventSchemaError, SUPPORTED_KEYWORDS as PLUGIN_EVENT_SUPPORTED_KEYWORDS, REJECTED_KEYWORDS as PLUGIN_EVENT_REJECTED_KEYWORDS, } from './plugin-events';
export { toolToOpenApiFragment, componentKey, standardResponseComponents, type OpenApiFragment, } from '@papercusp/tooldef';
export { assembleOpenApiDocument, toolOperationName, type OpenApiDocumentOptions, } from '@papercusp/tooldef';
import './bootstrap';
