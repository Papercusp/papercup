"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.unregisterProjectedToolsForPlugin = exports.registerProjectedTool = exports.InvalidRequestContextError = exports.parseRequestContext = exports.papercuspTierFor = exports.setCapabilityTierResolver = exports.tierFor = exports._resetStateChannelForTests = exports._resetCardCorrelatorForTests = exports.cancelPendingCardsForWorkspaceSwitch = exports.cancelPendingCardsForRun = exports.resolveCardResponse = exports.registerCard = exports.dropStateSnapshotsForWorkspaceSwitch = exports.snapshotWorkspace = exports.subscribeWorkspace = exports.subscribeStateChannel = exports.getSnapshot = exports.setToolState = exports.setOpenCards = exports.closeRun = exports.openRun = exports.dispatchWorkspaceSwitch = exports.onWorkspaceSwitch = exports.sanitizeToolSchema = exports.resolveBearer = exports.lookupPrompt = exports.getPromptCatalog = exports.matchResource = exports.lookupResource = exports.getResourceCatalog = exports.hasToolManifest = exports.reloadToolManifest = exports.applyToolManifest = exports.formatOptsFromCtx = exports.serializeToolResponse = exports.lookup = exports.getCatalog = exports.startServer = exports.readResource = exports.listResources = exports.listPrompts = exports.getPrompt = exports.dispatch = exports.definePrompt = exports.defineResource = exports.defineUITool = exports.BRAIN_PRINCIPAL_ROLE = exports.AGENT_ROLES = exports.defineTool = void 0;
exports.toolOperationName = exports.assembleOpenApiDocument = exports.standardResponseComponents = exports.componentKey = exports.toolToOpenApiFragment = exports.PLUGIN_EVENT_REJECTED_KEYWORDS = exports.PLUGIN_EVENT_SUPPORTED_KEYWORDS = exports.PluginEventSchemaError = exports.classifyEventWireFromJsonSchema = exports.validateAndClassifyPluginEvents = exports.validatePluginEventSchema = exports.replayBufferStats = exports.closeReplayBuffer = exports.readReplayBuffer = exports.PAPERCUSP_CONTEXT_HEADERS = exports.buildHttpSpawnContext = exports.handleHttpToolRequestStreaming = exports.handleHttpToolRequest = exports.ownerOnly = exports.papercuspGateBypass = exports.papercuspComputeQuotaWindow = exports.PASS_THROUGH = exports.HarnessRequiredError = exports.UnauthorizedToolError = exports.defaultComputeQuotaWindow = exports.dispatchProjectedToolStream = exports.dispatchProjectedTool = exports._resetProjectionRegistryForTests = exports.isPapercuspBinaryEnvelope = exports.emitToSseSink = exports.ToolRegistrationError = exports.listMcpProjections = exports.listAllProjectedTools = exports.lookupByHttpPath = exports.lookupByMcpName = void 0;
// Register Papercusp's capability→tier policy (plan P-012) BEFORE anything
// imports `defineTool` and self-registers — `tier` is stamped eagerly at
// registration. Must stay above `import './bootstrap'` (and is reached first
// by operator tools, which import `defineTool` from this index).
require("./capability-tiers-papercusp");
var tooldef_1 = require("@papercusp/tooldef");
Object.defineProperty(exports, "defineTool", { enumerable: true, get: function () { return tooldef_1.defineTool; } });
// Papercusp's role config (plan P-010): exporting AGENT_ROLES pulls in
// role-config.ts, whose `declare module` augmentation registers the built-in
// roles with tooldef's `RoleRegistry` — so the re-exported `AgentRole` below
// resolves to Papercusp's suggestion-union program-wide.
var role_config_1 = require("./role-config");
Object.defineProperty(exports, "AGENT_ROLES", { enumerable: true, get: function () { return role_config_1.AGENT_ROLES; } });
Object.defineProperty(exports, "BRAIN_PRINCIPAL_ROLE", { enumerable: true, get: function () { return role_config_1.BRAIN_PRINCIPAL_ROLE; } });
var define_ui_tool_1 = require("./define-ui-tool");
Object.defineProperty(exports, "defineUITool", { enumerable: true, get: function () { return define_ui_tool_1.defineUITool; } });
var tooldef_2 = require("@papercusp/tooldef");
Object.defineProperty(exports, "defineResource", { enumerable: true, get: function () { return tooldef_2.defineResource; } });
var tooldef_3 = require("@papercusp/tooldef");
Object.defineProperty(exports, "definePrompt", { enumerable: true, get: function () { return tooldef_3.definePrompt; } });
var server_1 = require("./server");
Object.defineProperty(exports, "dispatch", { enumerable: true, get: function () { return server_1.dispatch; } });
Object.defineProperty(exports, "getPrompt", { enumerable: true, get: function () { return server_1.getPrompt; } });
Object.defineProperty(exports, "listPrompts", { enumerable: true, get: function () { return server_1.listPrompts; } });
Object.defineProperty(exports, "listResources", { enumerable: true, get: function () { return server_1.listResources; } });
Object.defineProperty(exports, "readResource", { enumerable: true, get: function () { return server_1.readResource; } });
Object.defineProperty(exports, "startServer", { enumerable: true, get: function () { return server_1.startServer; } });
var tooldef_4 = require("@papercusp/tooldef");
Object.defineProperty(exports, "getCatalog", { enumerable: true, get: function () { return tooldef_4.getCatalog; } });
Object.defineProperty(exports, "lookup", { enumerable: true, get: function () { return tooldef_4.lookup; } });
var tooldef_5 = require("@papercusp/tooldef");
Object.defineProperty(exports, "serializeToolResponse", { enumerable: true, get: function () { return tooldef_5.serializeToolResponse; } });
Object.defineProperty(exports, "formatOptsFromCtx", { enumerable: true, get: function () { return tooldef_5.formatOptsFromCtx; } });
var tool_manifest_1 = require("./tool-manifest");
Object.defineProperty(exports, "applyToolManifest", { enumerable: true, get: function () { return tool_manifest_1.applyToolManifest; } });
Object.defineProperty(exports, "reloadToolManifest", { enumerable: true, get: function () { return tool_manifest_1.reloadToolManifest; } });
Object.defineProperty(exports, "hasToolManifest", { enumerable: true, get: function () { return tool_manifest_1.hasToolManifest; } });
var tooldef_6 = require("@papercusp/tooldef");
Object.defineProperty(exports, "getResourceCatalog", { enumerable: true, get: function () { return tooldef_6.getResourceCatalog; } });
Object.defineProperty(exports, "lookupResource", { enumerable: true, get: function () { return tooldef_6.lookupResource; } });
Object.defineProperty(exports, "matchResource", { enumerable: true, get: function () { return tooldef_6.matchResource; } });
var tooldef_7 = require("@papercusp/tooldef");
Object.defineProperty(exports, "getPromptCatalog", { enumerable: true, get: function () { return tooldef_7.getPromptCatalog; } });
Object.defineProperty(exports, "lookupPrompt", { enumerable: true, get: function () { return tooldef_7.lookupPrompt; } });
var auth_1 = require("./auth");
Object.defineProperty(exports, "resolveBearer", { enumerable: true, get: function () { return auth_1.resolveBearer; } });
var tool_schema_sanitize_1 = require("./tool-schema-sanitize");
Object.defineProperty(exports, "sanitizeToolSchema", { enumerable: true, get: function () { return tool_schema_sanitize_1.sanitizeToolSchema; } });
var tooldef_8 = require("@papercusp/tooldef");
Object.defineProperty(exports, "onWorkspaceSwitch", { enumerable: true, get: function () { return tooldef_8.onWorkspaceSwitch; } });
Object.defineProperty(exports, "dispatchWorkspaceSwitch", { enumerable: true, get: function () { return tooldef_8.dispatchWorkspaceSwitch; } });
var tooldef_9 = require("@papercusp/tooldef");
Object.defineProperty(exports, "openRun", { enumerable: true, get: function () { return tooldef_9.openRun; } });
Object.defineProperty(exports, "closeRun", { enumerable: true, get: function () { return tooldef_9.closeRun; } });
Object.defineProperty(exports, "setOpenCards", { enumerable: true, get: function () { return tooldef_9.setOpenCards; } });
Object.defineProperty(exports, "setToolState", { enumerable: true, get: function () { return tooldef_9.setToolState; } });
Object.defineProperty(exports, "getSnapshot", { enumerable: true, get: function () { return tooldef_9.getSnapshot; } });
Object.defineProperty(exports, "subscribeStateChannel", { enumerable: true, get: function () { return tooldef_9.subscribeStateChannel; } });
Object.defineProperty(exports, "subscribeWorkspace", { enumerable: true, get: function () { return tooldef_9.subscribeWorkspace; } });
Object.defineProperty(exports, "snapshotWorkspace", { enumerable: true, get: function () { return tooldef_9.snapshotWorkspace; } });
Object.defineProperty(exports, "dropStateSnapshotsForWorkspaceSwitch", { enumerable: true, get: function () { return tooldef_9.dropStateSnapshotsForWorkspaceSwitch; } });
var tooldef_10 = require("@papercusp/tooldef");
Object.defineProperty(exports, "registerCard", { enumerable: true, get: function () { return tooldef_10.registerCard; } });
Object.defineProperty(exports, "resolveCardResponse", { enumerable: true, get: function () { return tooldef_10.resolveCardResponse; } });
Object.defineProperty(exports, "cancelPendingCardsForRun", { enumerable: true, get: function () { return tooldef_10.cancelPendingCardsForRun; } });
Object.defineProperty(exports, "cancelPendingCardsForWorkspaceSwitch", { enumerable: true, get: function () { return tooldef_10.cancelPendingCardsForWorkspaceSwitch; } });
Object.defineProperty(exports, "_resetCardCorrelatorForTests", { enumerable: true, get: function () { return tooldef_10._resetCardCorrelatorForTests; } });
var tooldef_11 = require("@papercusp/tooldef");
Object.defineProperty(exports, "_resetStateChannelForTests", { enumerable: true, get: function () { return tooldef_11._resetStateChannelForTests; } });
var tooldef_12 = require("@papercusp/tooldef");
Object.defineProperty(exports, "tierFor", { enumerable: true, get: function () { return tooldef_12.tierFor; } });
Object.defineProperty(exports, "setCapabilityTierResolver", { enumerable: true, get: function () { return tooldef_12.setCapabilityTierResolver; } });
// Papercusp's capability→tier policy (plan P-012) — the host impl registered
// as tooldef's tier resolver (see capability-tiers-papercusp.ts).
var capability_tiers_papercusp_1 = require("./capability-tiers-papercusp");
Object.defineProperty(exports, "papercuspTierFor", { enumerable: true, get: function () { return capability_tiers_papercusp_1.papercuspTierFor; } });
// Per-spawn URL-param parser — used by both projected-tool transports
// to extract harness/workspace/role/feature/chunk/run/spawn from the
// orchestrator-baked URL.
var spawn_context_1 = require("./spawn-context");
Object.defineProperty(exports, "parseRequestContext", { enumerable: true, get: function () { return spawn_context_1.parseRequestContext; } });
Object.defineProperty(exports, "InvalidRequestContextError", { enumerable: true, get: function () { return spawn_context_1.InvalidRequestContextError; } });
// Function-as-truth projected tool registry — every tool is a function;
// HTTP and MCP are projections of it. Spec: plugin-mcp-host-design.md.
var tooldef_13 = require("@papercusp/tooldef");
Object.defineProperty(exports, "registerProjectedTool", { enumerable: true, get: function () { return tooldef_13.registerProjectedTool; } });
Object.defineProperty(exports, "unregisterProjectedToolsForPlugin", { enumerable: true, get: function () { return tooldef_13.unregisterProjectedToolsForPlugin; } });
Object.defineProperty(exports, "lookupByMcpName", { enumerable: true, get: function () { return tooldef_13.lookupByMcpName; } });
Object.defineProperty(exports, "lookupByHttpPath", { enumerable: true, get: function () { return tooldef_13.lookupByHttpPath; } });
Object.defineProperty(exports, "listAllProjectedTools", { enumerable: true, get: function () { return tooldef_13.listAllProjectedTools; } });
Object.defineProperty(exports, "listMcpProjections", { enumerable: true, get: function () { return tooldef_13.listMcpProjections; } });
Object.defineProperty(exports, "ToolRegistrationError", { enumerable: true, get: function () { return tooldef_13.ToolRegistrationError; } });
Object.defineProperty(exports, "emitToSseSink", { enumerable: true, get: function () { return tooldef_13.emitToSseSink; } });
Object.defineProperty(exports, "isPapercuspBinaryEnvelope", { enumerable: true, get: function () { return tooldef_13.isPapercuspBinaryEnvelope; } });
Object.defineProperty(exports, "_resetProjectionRegistryForTests", { enumerable: true, get: function () { return tooldef_13._resetProjectionRegistryForTests; } });
var tooldef_14 = require("@papercusp/tooldef");
Object.defineProperty(exports, "dispatchProjectedTool", { enumerable: true, get: function () { return tooldef_14.dispatchProjectedTool; } });
Object.defineProperty(exports, "dispatchProjectedToolStream", { enumerable: true, get: function () { return tooldef_14.dispatchProjectedToolStream; } });
Object.defineProperty(exports, "defaultComputeQuotaWindow", { enumerable: true, get: function () { return tooldef_14.defaultComputeQuotaWindow; } });
Object.defineProperty(exports, "UnauthorizedToolError", { enumerable: true, get: function () { return tooldef_14.UnauthorizedToolError; } });
Object.defineProperty(exports, "HarnessRequiredError", { enumerable: true, get: function () { return tooldef_14.HarnessRequiredError; } });
Object.defineProperty(exports, "PASS_THROUGH", { enumerable: true, get: function () { return tooldef_14.PASS_THROUGH; } });
// Papercusp's quota windowing policy (plan P-011) — the host impl of
// tooldef's `computeQuotaWindow` seam. Wired into PROJECTED_DEPS.
var quota_policy_1 = require("./quota-policy");
Object.defineProperty(exports, "papercuspComputeQuotaWindow", { enumerable: true, get: function () { return quota_policy_1.papercuspComputeQuotaWindow; } });
// Papercusp's auth-tier → gate-bypass mapping (plan P-014) — the host impl of
// tooldef's neutral `ctx.gateBypass`, set by the HTTP + MCP transports.
var gate_bypass_1 = require("./gate-bypass");
Object.defineProperty(exports, "papercuspGateBypass", { enumerable: true, get: function () { return gate_bypass_1.papercuspGateBypass; } });
// Resource authorization (RFC tooldef-auth). The host supplies the decision
// (an `authorize` hook / PolicyDecisionPoint) and wires `deps.auditAuth` to a
// sink — Papercusp's is `apps/operator/lib/tool-authz-audit.ts`.
var tooldef_15 = require("@papercusp/tooldef");
Object.defineProperty(exports, "ownerOnly", { enumerable: true, get: function () { return tooldef_15.ownerOnly; } });
// HTTP transport adapter — extracted to @papercusp/tooldef-http (plan P-030).
// Re-exported here so existing `@papercusp/agent-mcp` consumers are untouched.
var tooldef_http_1 = require("@papercusp/tooldef-http");
Object.defineProperty(exports, "handleHttpToolRequest", { enumerable: true, get: function () { return tooldef_http_1.handleHttpToolRequest; } });
Object.defineProperty(exports, "handleHttpToolRequestStreaming", { enumerable: true, get: function () { return tooldef_http_1.handleHttpToolRequestStreaming; } });
Object.defineProperty(exports, "buildHttpSpawnContext", { enumerable: true, get: function () { return tooldef_http_1.buildHttpSpawnContext; } });
Object.defineProperty(exports, "PAPERCUSP_CONTEXT_HEADERS", { enumerable: true, get: function () { return tooldef_http_1.PAPERCUSP_CONTEXT_HEADERS; } });
var tooldef_16 = require("@papercusp/tooldef");
Object.defineProperty(exports, "readReplayBuffer", { enumerable: true, get: function () { return tooldef_16.readReplayBuffer; } });
Object.defineProperty(exports, "closeReplayBuffer", { enumerable: true, get: function () { return tooldef_16.closeReplayBuffer; } });
Object.defineProperty(exports, "replayBufferStats", { enumerable: true, get: function () { return tooldef_16.replayBufferStats; } });
var plugin_events_1 = require("./plugin-events");
Object.defineProperty(exports, "validatePluginEventSchema", { enumerable: true, get: function () { return plugin_events_1.validatePluginEventSchema; } });
Object.defineProperty(exports, "validateAndClassifyPluginEvents", { enumerable: true, get: function () { return plugin_events_1.validateAndClassifyPluginEvents; } });
Object.defineProperty(exports, "classifyEventWireFromJsonSchema", { enumerable: true, get: function () { return plugin_events_1.classifyEventWireFromJsonSchema; } });
Object.defineProperty(exports, "PluginEventSchemaError", { enumerable: true, get: function () { return plugin_events_1.PluginEventSchemaError; } });
Object.defineProperty(exports, "PLUGIN_EVENT_SUPPORTED_KEYWORDS", { enumerable: true, get: function () { return plugin_events_1.SUPPORTED_KEYWORDS; } });
Object.defineProperty(exports, "PLUGIN_EVENT_REJECTED_KEYWORDS", { enumerable: true, get: function () { return plugin_events_1.REJECTED_KEYWORDS; } });
var tooldef_17 = require("@papercusp/tooldef");
Object.defineProperty(exports, "toolToOpenApiFragment", { enumerable: true, get: function () { return tooldef_17.toolToOpenApiFragment; } });
Object.defineProperty(exports, "componentKey", { enumerable: true, get: function () { return tooldef_17.componentKey; } });
Object.defineProperty(exports, "standardResponseComponents", { enumerable: true, get: function () { return tooldef_17.standardResponseComponents; } });
var tooldef_18 = require("@papercusp/tooldef");
Object.defineProperty(exports, "assembleOpenApiDocument", { enumerable: true, get: function () { return tooldef_18.assembleOpenApiDocument; } });
Object.defineProperty(exports, "toolOperationName", { enumerable: true, get: function () { return tooldef_18.toolOperationName; } });
require("./bootstrap");
