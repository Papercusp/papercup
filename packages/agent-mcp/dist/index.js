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
exports.resolveSlashExposure = exports.SLASH_PROMPT_PREFIX = exports.lookupPrompt = exports.getPromptCatalog = exports.matchResource = exports.lookupResource = exports.getResourceCatalog = exports.hasToolManifest = exports.reloadToolManifest = exports.applyToolManifest = exports.formatOptsFromCtx = exports.serializeToolResponse = exports.lookup = exports.getCatalog = exports.startServer = exports.readResource = exports.listResources = exports.listPrompts = exports.getPrompt = exports.dispatch = exports.definePrompt = exports.defineResource = exports.defineUITool = exports.DRIVE_MODES = exports.AGENT_PANE_KINDS = exports.classifyAgentPane = exports.FROZEN_OVERLAY_ROLES = exports.isOperatorConfigWriteRole = exports.OPERATOR_CONFIG_WRITE_ROLES = exports.SU_WRITE_ROLES = exports.SU_ROLES = exports.BRAIN_PRINCIPAL_ROLE = exports.AGENT_ROLES = exports.bulkContent = exports.runBulk = exports.mergeIds = exports.toList = exports.scalarOrArray = exports.toolArgsType = exports.listFacadeNamespaces = exports.generateToolFacadeTypes = exports.roleScopedToolNames = exports.runToolOrchestration = exports.PAYLOAD_TIERS = exports.resetPayloadTierRatchet = exports.resolvePayloadTier = exports.parsePayloadTier = exports.extractPayloadTier = exports.applyPayloadTier = exports.defineTool = void 0;
exports.registerProjectedTool = exports.InvalidRequestContextError = exports.parseRequestContext = exports.setCapabilityTierOverride = exports.papercuspTierFor = exports.setCapabilityTierResolver = exports.tierFor = exports._resetStateChannelForTests = exports._resetCardCorrelatorForTests = exports.cancelPendingCardsForWorkspaceSwitch = exports.cancelPendingCardsForRun = exports.resolveCardResponse = exports.registerCard = exports.isSemanticDeltaEnabled = exports.resetSemanticDeltaEnabledResolver = exports.setSemanticDeltaEnabledResolver = exports.applyResultAnnotator = exports.resetResultAnnotator = exports.setResultAnnotator = exports.readJsonResult = exports.renderSeeAlsoText = exports.resolveSeeAlso = exports.applySeeAlso = exports.dispatchWithConveyedDelta = exports.dispatchWithDelta = exports.DeltaToolClient = exports.chooseSnapshotEmission = exports.applySnapshotDelta = exports.diffSnapshot = exports.dropStateSnapshotsForWorkspaceSwitch = exports.snapshotWorkspace = exports.subscribeWorkspace = exports.subscribeStateChannel = exports.getSnapshot = exports.setToolState = exports.setOpenCards = exports.closeRun = exports.openRun = exports.dispatchWorkspaceSwitch = exports.onWorkspaceSwitch = exports.nearestByLevenshtein = exports.fuzzyEnum = exports.sanitizeToolSchema = exports.resolveBearer = exports.renderSlashPrompt = exports.slashPromptListingFor = exports.deriveSlashPromptArguments = exports.slashPromptToolName = exports.isSlashPromptName = exports.slashPromptNameFor = void 0;
exports.evalSnapshotTransition = exports.applyListDelta = exports.computeListDelta = exports.checksumRows = exports.tokens = exports.toolOperationName = exports.assembleOpenApiDocument = exports.standardResponseComponents = exports.componentKey = exports.toolToOpenApiFragment = exports.PLUGIN_EVENT_REJECTED_KEYWORDS = exports.PLUGIN_EVENT_SUPPORTED_KEYWORDS = exports.PluginEventSchemaError = exports.classifyEventWireFromJsonSchema = exports.validateAndClassifyPluginEvents = exports.validatePluginEventSchema = exports.replayBufferStats = exports.closeReplayBuffer = exports.readReplayBuffer = exports.PAPERCUSP_CONTEXT_HEADERS = exports.buildHttpSpawnContext = exports.handleHttpToolRequestStreaming = exports.handleHttpToolRequest = exports.ownerOnly = exports.setTestingFullAccessResolver = exports.TESTING_FULL_ACCESS_ROLES = exports.testingFullAccess = exports.papercuspGateBypass = exports.papercuspComputeQuotaWindow = exports.PASS_THROUGH = exports.HarnessRequiredError = exports.UnauthorizedToolError = exports.defaultComputeQuotaWindow = exports.dispatchProjectedToolStream = exports.dispatchProjectedTool = exports._resetProjectionRegistryForTests = exports.isPapercuspBinaryEnvelope = exports.emitToSseSink = exports.ToolRegistrationError = exports.listMcpProjections = exports.listAllProjectedTools = exports.lookupByHttpPath = exports.lookupByMcpName = exports.unregisterProjectedToolsForPlugin = void 0;
// Register Papercusp's capability→tier policy (plan P-012) BEFORE anything
// imports `defineTool` and self-registers — `tier` is stamped eagerly at
// registration. Must stay above `import './bootstrap'` (and is reached first
// by operator tools, which import `defineTool` from this index).
require("./capability-tiers-papercusp");
var tooldef_1 = require("@papercusp/tooldef");
Object.defineProperty(exports, "defineTool", { enumerable: true, get: function () { return tooldef_1.defineTool; } });
// Payload tiers (context-trimming-tiers-2026-07-01 D-004): the trimmed/standard/full
// axis over WHAT a tool returns. Hosts parse the session tier (parsePayloadTier) into
// ctx.contextTier; tools declare per-tier `shape` projections on defineTool.
var tooldef_2 = require("@papercusp/tooldef");
Object.defineProperty(exports, "applyPayloadTier", { enumerable: true, get: function () { return tooldef_2.applyPayloadTier; } });
Object.defineProperty(exports, "extractPayloadTier", { enumerable: true, get: function () { return tooldef_2.extractPayloadTier; } });
Object.defineProperty(exports, "parsePayloadTier", { enumerable: true, get: function () { return tooldef_2.parsePayloadTier; } });
Object.defineProperty(exports, "resolvePayloadTier", { enumerable: true, get: function () { return tooldef_2.resolvePayloadTier; } });
Object.defineProperty(exports, "resetPayloadTierRatchet", { enumerable: true, get: function () { return tooldef_2.resetPayloadTierRatchet; } });
Object.defineProperty(exports, "PAYLOAD_TIERS", { enumerable: true, get: function () { return tooldef_2.PAYLOAD_TIERS; } });
// code-execution-tool-orchestration (B-CX-2A): the code-mode runtime, re-exported so the
// operator-core `code:run` agent tool can compose it.
var tooldef_3 = require("@papercusp/tooldef");
Object.defineProperty(exports, "runToolOrchestration", { enumerable: true, get: function () { return tooldef_3.runToolOrchestration; } });
// The role-scoped allowed-set helper BOTH code:run + code:tools use to build the facade envelope
// (mirrors the dispatcher role-allowlist; the meta-tools exclude themselves so a script can't nest
// code-mode). One definition, unit-tested in tool-facade.test.ts.
var tooldef_4 = require("@papercusp/tooldef");
Object.defineProperty(exports, "roleScopedToolNames", { enumerable: true, get: function () { return tooldef_4.roleScopedToolNames; } });
// code-execution-tool-orchestration B-CX-API: typed `tools.ns.verb(args)` signatures generated
// from the projected registry + the on-demand namespace index — composed by the `code:tools`
// lookup so the model loads signatures on demand instead of paying the full catalog per prompt.
var tooldef_5 = require("@papercusp/tooldef");
Object.defineProperty(exports, "generateToolFacadeTypes", { enumerable: true, get: function () { return tooldef_5.generateToolFacadeTypes; } });
Object.defineProperty(exports, "listFacadeNamespaces", { enumerable: true, get: function () { return tooldef_5.listFacadeNamespaces; } });
Object.defineProperty(exports, "toolArgsType", { enumerable: true, get: function () { return tooldef_5.toolArgsType; } });
// The shared keyed-array bulk I/O contract (bulk-endpoint-standardization D-001).
// Lives here — the lowest package both operator-core tools AND the agent-mcp
// read-side tools (artifacts/features) can import (dep direction is
// operator-core → agent-mcp). operator-core/lib/agent-tools/_bulk.ts re-exports it.
var _bulk_1 = require("./_bulk");
Object.defineProperty(exports, "scalarOrArray", { enumerable: true, get: function () { return _bulk_1.scalarOrArray; } });
Object.defineProperty(exports, "toList", { enumerable: true, get: function () { return _bulk_1.toList; } });
Object.defineProperty(exports, "mergeIds", { enumerable: true, get: function () { return _bulk_1.mergeIds; } });
Object.defineProperty(exports, "runBulk", { enumerable: true, get: function () { return _bulk_1.runBulk; } });
Object.defineProperty(exports, "bulkContent", { enumerable: true, get: function () { return _bulk_1.bulkContent; } });
// Papercusp's role config (plan P-010): exporting AGENT_ROLES pulls in
// role-config.ts, whose `declare module` augmentation registers the built-in
// roles with tooldef's `RoleRegistry` — so the re-exported `AgentRole` below
// resolves to Papercusp's suggestion-union program-wide.
var role_config_1 = require("./role-config");
Object.defineProperty(exports, "AGENT_ROLES", { enumerable: true, get: function () { return role_config_1.AGENT_ROLES; } });
Object.defineProperty(exports, "BRAIN_PRINCIPAL_ROLE", { enumerable: true, get: function () { return role_config_1.BRAIN_PRINCIPAL_ROLE; } });
Object.defineProperty(exports, "SU_ROLES", { enumerable: true, get: function () { return role_config_1.SU_ROLES; } });
Object.defineProperty(exports, "SU_WRITE_ROLES", { enumerable: true, get: function () { return role_config_1.SU_WRITE_ROLES; } });
Object.defineProperty(exports, "OPERATOR_CONFIG_WRITE_ROLES", { enumerable: true, get: function () { return role_config_1.OPERATOR_CONFIG_WRITE_ROLES; } });
Object.defineProperty(exports, "isOperatorConfigWriteRole", { enumerable: true, get: function () { return role_config_1.isOperatorConfigWriteRole; } });
Object.defineProperty(exports, "FROZEN_OVERLAY_ROLES", { enumerable: true, get: function () { return role_config_1.FROZEN_OVERLAY_ROLES; } });
// hive-agent-tabs-psu-tui P-001: the shared AgentPaneKind taxonomy — one source
// of truth for the backend roster shaping + pui pane render/color.
var agent_pane_kind_1 = require("./agent-pane-kind");
Object.defineProperty(exports, "classifyAgentPane", { enumerable: true, get: function () { return agent_pane_kind_1.classifyAgentPane; } });
Object.defineProperty(exports, "AGENT_PANE_KINDS", { enumerable: true, get: function () { return agent_pane_kind_1.AGENT_PANE_KINDS; } });
Object.defineProperty(exports, "DRIVE_MODES", { enumerable: true, get: function () { return agent_pane_kind_1.DRIVE_MODES; } });
var define_ui_tool_1 = require("./define-ui-tool");
Object.defineProperty(exports, "defineUITool", { enumerable: true, get: function () { return define_ui_tool_1.defineUITool; } });
var tooldef_6 = require("@papercusp/tooldef");
Object.defineProperty(exports, "defineResource", { enumerable: true, get: function () { return tooldef_6.defineResource; } });
var tooldef_7 = require("@papercusp/tooldef");
Object.defineProperty(exports, "definePrompt", { enumerable: true, get: function () { return tooldef_7.definePrompt; } });
var server_1 = require("./server");
Object.defineProperty(exports, "dispatch", { enumerable: true, get: function () { return server_1.dispatch; } });
Object.defineProperty(exports, "getPrompt", { enumerable: true, get: function () { return server_1.getPrompt; } });
Object.defineProperty(exports, "listPrompts", { enumerable: true, get: function () { return server_1.listPrompts; } });
Object.defineProperty(exports, "listResources", { enumerable: true, get: function () { return server_1.listResources; } });
Object.defineProperty(exports, "readResource", { enumerable: true, get: function () { return server_1.readResource; } });
Object.defineProperty(exports, "startServer", { enumerable: true, get: function () { return server_1.startServer; } });
var tooldef_8 = require("@papercusp/tooldef");
Object.defineProperty(exports, "getCatalog", { enumerable: true, get: function () { return tooldef_8.getCatalog; } });
Object.defineProperty(exports, "lookup", { enumerable: true, get: function () { return tooldef_8.lookup; } });
var tooldef_9 = require("@papercusp/tooldef");
Object.defineProperty(exports, "serializeToolResponse", { enumerable: true, get: function () { return tooldef_9.serializeToolResponse; } });
Object.defineProperty(exports, "formatOptsFromCtx", { enumerable: true, get: function () { return tooldef_9.formatOptsFromCtx; } });
var tool_manifest_1 = require("./tool-manifest");
Object.defineProperty(exports, "applyToolManifest", { enumerable: true, get: function () { return tool_manifest_1.applyToolManifest; } });
Object.defineProperty(exports, "reloadToolManifest", { enumerable: true, get: function () { return tool_manifest_1.reloadToolManifest; } });
Object.defineProperty(exports, "hasToolManifest", { enumerable: true, get: function () { return tool_manifest_1.hasToolManifest; } });
var tooldef_10 = require("@papercusp/tooldef");
Object.defineProperty(exports, "getResourceCatalog", { enumerable: true, get: function () { return tooldef_10.getResourceCatalog; } });
Object.defineProperty(exports, "lookupResource", { enumerable: true, get: function () { return tooldef_10.lookupResource; } });
Object.defineProperty(exports, "matchResource", { enumerable: true, get: function () { return tooldef_10.matchResource; } });
var tooldef_11 = require("@papercusp/tooldef");
Object.defineProperty(exports, "getPromptCatalog", { enumerable: true, get: function () { return tooldef_11.getPromptCatalog; } });
Object.defineProperty(exports, "lookupPrompt", { enumerable: true, get: function () { return tooldef_11.lookupPrompt; } });
var tooldef_12 = require("@papercusp/tooldef");
Object.defineProperty(exports, "SLASH_PROMPT_PREFIX", { enumerable: true, get: function () { return tooldef_12.SLASH_PROMPT_PREFIX; } });
Object.defineProperty(exports, "resolveSlashExposure", { enumerable: true, get: function () { return tooldef_12.resolveSlashExposure; } });
Object.defineProperty(exports, "slashPromptNameFor", { enumerable: true, get: function () { return tooldef_12.slashPromptNameFor; } });
Object.defineProperty(exports, "isSlashPromptName", { enumerable: true, get: function () { return tooldef_12.isSlashPromptName; } });
Object.defineProperty(exports, "slashPromptToolName", { enumerable: true, get: function () { return tooldef_12.slashPromptToolName; } });
Object.defineProperty(exports, "deriveSlashPromptArguments", { enumerable: true, get: function () { return tooldef_12.deriveSlashPromptArguments; } });
Object.defineProperty(exports, "slashPromptListingFor", { enumerable: true, get: function () { return tooldef_12.slashPromptListingFor; } });
Object.defineProperty(exports, "renderSlashPrompt", { enumerable: true, get: function () { return tooldef_12.renderSlashPrompt; } });
var auth_1 = require("./auth");
Object.defineProperty(exports, "resolveBearer", { enumerable: true, get: function () { return auth_1.resolveBearer; } });
var tool_schema_sanitize_1 = require("./tool-schema-sanitize");
Object.defineProperty(exports, "sanitizeToolSchema", { enumerable: true, get: function () { return tool_schema_sanitize_1.sanitizeToolSchema; } });
var fuzzy_enum_1 = require("./fuzzy-enum");
Object.defineProperty(exports, "fuzzyEnum", { enumerable: true, get: function () { return fuzzy_enum_1.fuzzyEnum; } });
Object.defineProperty(exports, "nearestByLevenshtein", { enumerable: true, get: function () { return fuzzy_enum_1.nearestByLevenshtein; } });
var tooldef_13 = require("@papercusp/tooldef");
Object.defineProperty(exports, "onWorkspaceSwitch", { enumerable: true, get: function () { return tooldef_13.onWorkspaceSwitch; } });
Object.defineProperty(exports, "dispatchWorkspaceSwitch", { enumerable: true, get: function () { return tooldef_13.dispatchWorkspaceSwitch; } });
var tooldef_14 = require("@papercusp/tooldef");
Object.defineProperty(exports, "openRun", { enumerable: true, get: function () { return tooldef_14.openRun; } });
Object.defineProperty(exports, "closeRun", { enumerable: true, get: function () { return tooldef_14.closeRun; } });
Object.defineProperty(exports, "setOpenCards", { enumerable: true, get: function () { return tooldef_14.setOpenCards; } });
Object.defineProperty(exports, "setToolState", { enumerable: true, get: function () { return tooldef_14.setToolState; } });
Object.defineProperty(exports, "getSnapshot", { enumerable: true, get: function () { return tooldef_14.getSnapshot; } });
Object.defineProperty(exports, "subscribeStateChannel", { enumerable: true, get: function () { return tooldef_14.subscribeStateChannel; } });
Object.defineProperty(exports, "subscribeWorkspace", { enumerable: true, get: function () { return tooldef_14.subscribeWorkspace; } });
Object.defineProperty(exports, "snapshotWorkspace", { enumerable: true, get: function () { return tooldef_14.snapshotWorkspace; } });
Object.defineProperty(exports, "dropStateSnapshotsForWorkspaceSwitch", { enumerable: true, get: function () { return tooldef_14.dropStateSnapshotsForWorkspaceSwitch; } });
var tooldef_15 = require("@papercusp/tooldef");
Object.defineProperty(exports, "diffSnapshot", { enumerable: true, get: function () { return tooldef_15.diffSnapshot; } });
Object.defineProperty(exports, "applySnapshotDelta", { enumerable: true, get: function () { return tooldef_15.applySnapshotDelta; } });
Object.defineProperty(exports, "chooseSnapshotEmission", { enumerable: true, get: function () { return tooldef_15.chooseSnapshotEmission; } });
var tooldef_16 = require("@papercusp/tooldef");
Object.defineProperty(exports, "DeltaToolClient", { enumerable: true, get: function () { return tooldef_16.DeltaToolClient; } });
Object.defineProperty(exports, "dispatchWithDelta", { enumerable: true, get: function () { return tooldef_16.dispatchWithDelta; } });
Object.defineProperty(exports, "dispatchWithConveyedDelta", { enumerable: true, get: function () { return tooldef_16.dispatchWithConveyedDelta; } });
// Result-aware guidance.seeAlso cross-links (presence-coord-unification-2026-07-01
// D-003): the dispatch layer applies these; adopters using the callback form read
// their content-encoded result with readJsonResult.
var tooldef_17 = require("@papercusp/tooldef");
Object.defineProperty(exports, "applySeeAlso", { enumerable: true, get: function () { return tooldef_17.applySeeAlso; } });
Object.defineProperty(exports, "resolveSeeAlso", { enumerable: true, get: function () { return tooldef_17.resolveSeeAlso; } });
Object.defineProperty(exports, "renderSeeAlsoText", { enumerable: true, get: function () { return tooldef_17.renderSeeAlsoText; } });
Object.defineProperty(exports, "readJsonResult", { enumerable: true, get: function () { return tooldef_17.readJsonResult; } });
// Host ambient result-annotator seam (agent-managed-compaction P-013) — the operator
// wires its banded context gauge via context-gauge-wiring.ts, same as delta-flag-wiring.
var tooldef_18 = require("@papercusp/tooldef");
Object.defineProperty(exports, "setResultAnnotator", { enumerable: true, get: function () { return tooldef_18.setResultAnnotator; } });
Object.defineProperty(exports, "resetResultAnnotator", { enumerable: true, get: function () { return tooldef_18.resetResultAnnotator; } });
Object.defineProperty(exports, "applyResultAnnotator", { enumerable: true, get: function () { return tooldef_18.applyResultAnnotator; } });
// Tool-result SEMANTIC-delta flag seam (agent-tool-delta-protocol-2026-06-22, the
// flag-bite): tooldef gates the `mode:'delta'` upgrade behind this resolver, the
// host wires it to FLAGS.TOOL_DELTA_PROTOCOL (see operator-core's
// agent-tools/delta-flag-wiring.ts — the resolver needs @papercusp/flags, which
// agent-mcp doesn't depend on, so the wiring lives operator-side).
var tooldef_19 = require("@papercusp/tooldef");
Object.defineProperty(exports, "setSemanticDeltaEnabledResolver", { enumerable: true, get: function () { return tooldef_19.setSemanticDeltaEnabledResolver; } });
Object.defineProperty(exports, "resetSemanticDeltaEnabledResolver", { enumerable: true, get: function () { return tooldef_19.resetSemanticDeltaEnabledResolver; } });
Object.defineProperty(exports, "isSemanticDeltaEnabled", { enumerable: true, get: function () { return tooldef_19.isSemanticDeltaEnabled; } });
var tooldef_20 = require("@papercusp/tooldef");
Object.defineProperty(exports, "registerCard", { enumerable: true, get: function () { return tooldef_20.registerCard; } });
Object.defineProperty(exports, "resolveCardResponse", { enumerable: true, get: function () { return tooldef_20.resolveCardResponse; } });
Object.defineProperty(exports, "cancelPendingCardsForRun", { enumerable: true, get: function () { return tooldef_20.cancelPendingCardsForRun; } });
Object.defineProperty(exports, "cancelPendingCardsForWorkspaceSwitch", { enumerable: true, get: function () { return tooldef_20.cancelPendingCardsForWorkspaceSwitch; } });
Object.defineProperty(exports, "_resetCardCorrelatorForTests", { enumerable: true, get: function () { return tooldef_20._resetCardCorrelatorForTests; } });
var tooldef_21 = require("@papercusp/tooldef");
Object.defineProperty(exports, "_resetStateChannelForTests", { enumerable: true, get: function () { return tooldef_21._resetStateChannelForTests; } });
var tooldef_22 = require("@papercusp/tooldef");
Object.defineProperty(exports, "tierFor", { enumerable: true, get: function () { return tooldef_22.tierFor; } });
Object.defineProperty(exports, "setCapabilityTierResolver", { enumerable: true, get: function () { return tooldef_22.setCapabilityTierResolver; } });
// Papercusp's capability→tier policy (plan P-012) — the host impl registered
// as tooldef's tier resolver (see capability-tiers-papercusp.ts).
var capability_tiers_papercusp_1 = require("./capability-tiers-papercusp");
Object.defineProperty(exports, "papercuspTierFor", { enumerable: true, get: function () { return capability_tiers_papercusp_1.papercuspTierFor; } });
Object.defineProperty(exports, "setCapabilityTierOverride", { enumerable: true, get: function () { return capability_tiers_papercusp_1.setCapabilityTierOverride; } });
// Per-spawn URL-param parser — used by both projected-tool transports
// to extract harness/workspace/role/feature/chunk/run/spawn from the
// orchestrator-baked URL.
var spawn_context_1 = require("./spawn-context");
Object.defineProperty(exports, "parseRequestContext", { enumerable: true, get: function () { return spawn_context_1.parseRequestContext; } });
Object.defineProperty(exports, "InvalidRequestContextError", { enumerable: true, get: function () { return spawn_context_1.InvalidRequestContextError; } });
// Function-as-truth projected tool registry — every tool is a function;
// HTTP and MCP are projections of it. Spec: plugin-mcp-host-design.md.
var tooldef_23 = require("@papercusp/tooldef");
Object.defineProperty(exports, "registerProjectedTool", { enumerable: true, get: function () { return tooldef_23.registerProjectedTool; } });
Object.defineProperty(exports, "unregisterProjectedToolsForPlugin", { enumerable: true, get: function () { return tooldef_23.unregisterProjectedToolsForPlugin; } });
Object.defineProperty(exports, "lookupByMcpName", { enumerable: true, get: function () { return tooldef_23.lookupByMcpName; } });
Object.defineProperty(exports, "lookupByHttpPath", { enumerable: true, get: function () { return tooldef_23.lookupByHttpPath; } });
Object.defineProperty(exports, "listAllProjectedTools", { enumerable: true, get: function () { return tooldef_23.listAllProjectedTools; } });
Object.defineProperty(exports, "listMcpProjections", { enumerable: true, get: function () { return tooldef_23.listMcpProjections; } });
Object.defineProperty(exports, "ToolRegistrationError", { enumerable: true, get: function () { return tooldef_23.ToolRegistrationError; } });
Object.defineProperty(exports, "emitToSseSink", { enumerable: true, get: function () { return tooldef_23.emitToSseSink; } });
Object.defineProperty(exports, "isPapercuspBinaryEnvelope", { enumerable: true, get: function () { return tooldef_23.isPapercuspBinaryEnvelope; } });
Object.defineProperty(exports, "_resetProjectionRegistryForTests", { enumerable: true, get: function () { return tooldef_23._resetProjectionRegistryForTests; } });
var tooldef_24 = require("@papercusp/tooldef");
Object.defineProperty(exports, "dispatchProjectedTool", { enumerable: true, get: function () { return tooldef_24.dispatchProjectedTool; } });
Object.defineProperty(exports, "dispatchProjectedToolStream", { enumerable: true, get: function () { return tooldef_24.dispatchProjectedToolStream; } });
Object.defineProperty(exports, "defaultComputeQuotaWindow", { enumerable: true, get: function () { return tooldef_24.defaultComputeQuotaWindow; } });
Object.defineProperty(exports, "UnauthorizedToolError", { enumerable: true, get: function () { return tooldef_24.UnauthorizedToolError; } });
Object.defineProperty(exports, "HarnessRequiredError", { enumerable: true, get: function () { return tooldef_24.HarnessRequiredError; } });
Object.defineProperty(exports, "PASS_THROUGH", { enumerable: true, get: function () { return tooldef_24.PASS_THROUGH; } });
// Papercusp's quota windowing policy (plan P-011) — the host impl of
// tooldef's `computeQuotaWindow` seam. Wired into PROJECTED_DEPS.
var quota_policy_1 = require("./quota-policy");
Object.defineProperty(exports, "papercuspComputeQuotaWindow", { enumerable: true, get: function () { return quota_policy_1.papercuspComputeQuotaWindow; } });
// Papercusp's auth-tier → gate-bypass mapping (plan P-014) — the host impl of
// tooldef's neutral `ctx.gateBypass`, set by the HTTP + MCP transports.
var gate_bypass_1 = require("./gate-bypass");
Object.defineProperty(exports, "papercuspGateBypass", { enumerable: true, get: function () { return gate_bypass_1.papercuspGateBypass; } });
Object.defineProperty(exports, "testingFullAccess", { enumerable: true, get: function () { return gate_bypass_1.testingFullAccess; } });
Object.defineProperty(exports, "TESTING_FULL_ACCESS_ROLES", { enumerable: true, get: function () { return gate_bypass_1.TESTING_FULL_ACCESS_ROLES; } });
Object.defineProperty(exports, "setTestingFullAccessResolver", { enumerable: true, get: function () { return gate_bypass_1.setTestingFullAccessResolver; } });
// Resource authorization (RFC tooldef-auth). The host supplies the decision
// (an `authorize` hook / PolicyDecisionPoint) and wires `deps.auditAuth` to a
// sink — Papercusp's is `apps/operator/lib/tool-authz-audit.ts`.
var tooldef_25 = require("@papercusp/tooldef");
Object.defineProperty(exports, "ownerOnly", { enumerable: true, get: function () { return tooldef_25.ownerOnly; } });
// HTTP transport adapter — extracted to @papercusp/tooldef-http (plan P-030).
// Re-exported here so existing `@papercusp/agent-mcp` consumers are untouched.
var tooldef_http_1 = require("@papercusp/tooldef-http");
Object.defineProperty(exports, "handleHttpToolRequest", { enumerable: true, get: function () { return tooldef_http_1.handleHttpToolRequest; } });
Object.defineProperty(exports, "handleHttpToolRequestStreaming", { enumerable: true, get: function () { return tooldef_http_1.handleHttpToolRequestStreaming; } });
Object.defineProperty(exports, "buildHttpSpawnContext", { enumerable: true, get: function () { return tooldef_http_1.buildHttpSpawnContext; } });
Object.defineProperty(exports, "PAPERCUSP_CONTEXT_HEADERS", { enumerable: true, get: function () { return tooldef_http_1.PAPERCUSP_CONTEXT_HEADERS; } });
var tooldef_26 = require("@papercusp/tooldef");
Object.defineProperty(exports, "readReplayBuffer", { enumerable: true, get: function () { return tooldef_26.readReplayBuffer; } });
Object.defineProperty(exports, "closeReplayBuffer", { enumerable: true, get: function () { return tooldef_26.closeReplayBuffer; } });
Object.defineProperty(exports, "replayBufferStats", { enumerable: true, get: function () { return tooldef_26.replayBufferStats; } });
var plugin_events_1 = require("./plugin-events");
Object.defineProperty(exports, "validatePluginEventSchema", { enumerable: true, get: function () { return plugin_events_1.validatePluginEventSchema; } });
Object.defineProperty(exports, "validateAndClassifyPluginEvents", { enumerable: true, get: function () { return plugin_events_1.validateAndClassifyPluginEvents; } });
Object.defineProperty(exports, "classifyEventWireFromJsonSchema", { enumerable: true, get: function () { return plugin_events_1.classifyEventWireFromJsonSchema; } });
Object.defineProperty(exports, "PluginEventSchemaError", { enumerable: true, get: function () { return plugin_events_1.PluginEventSchemaError; } });
Object.defineProperty(exports, "PLUGIN_EVENT_SUPPORTED_KEYWORDS", { enumerable: true, get: function () { return plugin_events_1.SUPPORTED_KEYWORDS; } });
Object.defineProperty(exports, "PLUGIN_EVENT_REJECTED_KEYWORDS", { enumerable: true, get: function () { return plugin_events_1.REJECTED_KEYWORDS; } });
var tooldef_27 = require("@papercusp/tooldef");
Object.defineProperty(exports, "toolToOpenApiFragment", { enumerable: true, get: function () { return tooldef_27.toolToOpenApiFragment; } });
Object.defineProperty(exports, "componentKey", { enumerable: true, get: function () { return tooldef_27.componentKey; } });
Object.defineProperty(exports, "standardResponseComponents", { enumerable: true, get: function () { return tooldef_27.standardResponseComponents; } });
var tooldef_28 = require("@papercusp/tooldef");
Object.defineProperty(exports, "assembleOpenApiDocument", { enumerable: true, get: function () { return tooldef_28.assembleOpenApiDocument; } });
Object.defineProperty(exports, "toolOperationName", { enumerable: true, get: function () { return tooldef_28.toolOperationName; } });
var delta_eval_harness_1 = require("./delta-eval-harness");
Object.defineProperty(exports, "tokens", { enumerable: true, get: function () { return delta_eval_harness_1.tokens; } });
Object.defineProperty(exports, "checksumRows", { enumerable: true, get: function () { return delta_eval_harness_1.checksumRows; } });
Object.defineProperty(exports, "computeListDelta", { enumerable: true, get: function () { return delta_eval_harness_1.computeListDelta; } });
Object.defineProperty(exports, "applyListDelta", { enumerable: true, get: function () { return delta_eval_harness_1.applyListDelta; } });
Object.defineProperty(exports, "evalSnapshotTransition", { enumerable: true, get: function () { return delta_eval_harness_1.evalSnapshotTransition; } });
require("./bootstrap");
