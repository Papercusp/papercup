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

// Register Papercusp's capability→tier policy (plan P-012) BEFORE anything
// imports `defineTool` and self-registers — `tier` is stamped eagerly at
// registration. Must stay above `import './bootstrap'` (and is reached first
// by operator tools, which import `defineTool` from this index).
import './capability-tiers-papercusp';

export { defineTool } from '@papercusp/tooldef';
// code-execution-tool-orchestration (B-CX-2A): the code-mode runtime, re-exported so the
// operator-core `code:run` agent tool can compose it.
export { runToolOrchestration } from '@papercusp/tooldef';
export type { OrchestrateOptions, OrchestrateResult, PlannedMutation } from '@papercusp/tooldef';
// The role-scoped allowed-set helper BOTH code:run + code:tools use to build the facade envelope
// (mirrors the dispatcher role-allowlist; the meta-tools exclude themselves so a script can't nest
// code-mode). One definition, unit-tested in tool-facade.test.ts.
export { roleScopedToolNames } from '@papercusp/tooldef';
// code-execution-tool-orchestration B-CX-API: typed `tools.ns.verb(args)` signatures generated
// from the projected registry + the on-demand namespace index — composed by the `code:tools`
// lookup so the model loads signatures on demand instead of paying the full catalog per prompt.
export { generateToolFacadeTypes, listFacadeNamespaces, toolArgsType } from '@papercusp/tooldef';
export type {
  GenerateFacadeTypesOptions,
  FacadeNamespaceIndexEntry,
  ToolArgsType,
} from '@papercusp/tooldef';
// Papercusp's role config (plan P-010): exporting AGENT_ROLES pulls in
// role-config.ts, whose `declare module` augmentation registers the built-in
// roles with tooldef's `RoleRegistry` — so the re-exported `AgentRole` below
// resolves to Papercusp's suggestion-union program-wide.
export {
  AGENT_ROLES,
  BRAIN_PRINCIPAL_ROLE,
  SU_ROLES,
  SU_WRITE_ROLES,
  OPERATOR_CONFIG_WRITE_ROLES,
  isOperatorConfigWriteRole,
  FROZEN_OVERLAY_ROLES,
} from './role-config';
export type { BuiltinAgentRole } from './role-config';
// hive-agent-tabs-psu-tui P-001: the shared AgentPaneKind taxonomy — one source
// of truth for the backend roster shaping + pui pane render/color.
export { classifyAgentPane, AGENT_PANE_KINDS, DRIVE_MODES } from './agent-pane-kind';
export type { AgentPaneKind, DriveMode, AgentPaneClass, AgentLaunchHint } from './agent-pane-kind';
export type { AgentRole, RoleRegistry } from '@papercusp/tooldef';
export { defineUITool } from './define-ui-tool';
export type { UIToolDefinitionInput, UIToolHandlerResult } from './define-ui-tool';
export { defineResource } from '@papercusp/tooldef';
export { definePrompt } from '@papercusp/tooldef';
export {
  dispatch,
  getPrompt,
  listPrompts,
  listResources,
  readResource,
  startServer,
} from './server';
export { getCatalog, lookup } from '@papercusp/tooldef';
export {
  serializeToolResponse,
  formatOptsFromCtx,
  type SerializeFormatOpts,
  type SerializedToolResult,
} from '@papercusp/tooldef';
export {
  applyToolManifest,
  reloadToolManifest,
  hasToolManifest,
} from './tool-manifest';
export {
  getResourceCatalog,
  lookupResource,
  matchResource,
} from '@papercusp/tooldef';
export { getPromptCatalog, lookupPrompt } from '@papercusp/tooldef';
export {
  SLASH_PROMPT_PREFIX,
  resolveSlashExposure,
  slashPromptNameFor,
  isSlashPromptName,
  slashPromptToolName,
  deriveSlashPromptArguments,
  slashPromptListingFor,
  renderSlashPrompt,
} from '@papercusp/tooldef';
export type { SlashPromptListing } from '@papercusp/tooldef';
export { resolveBearer } from './auth';
export { sanitizeToolSchema } from './tool-schema-sanitize';
export {
  onWorkspaceSwitch,
  dispatchWorkspaceSwitch,
} from '@papercusp/tooldef';
export type { WorkspaceSwitchCallback } from '@papercusp/tooldef';
export {
  openRun,
  closeRun,
  setOpenCards,
  setToolState,
  getSnapshot,
  subscribeStateChannel,
  subscribeWorkspace,
  snapshotWorkspace,
  dropStateSnapshotsForWorkspaceSwitch,
} from '@papercusp/tooldef';
export type {
  StateSnapshot,
  VersionedSnapshot,
} from '@papercusp/tooldef';
export {
  registerCard,
  resolveCardResponse,
  cancelPendingCardsForRun,
  cancelPendingCardsForWorkspaceSwitch,
  _resetCardCorrelatorForTests,
} from '@papercusp/tooldef';
export { _resetStateChannelForTests } from '@papercusp/tooldef';
export { tierFor, setCapabilityTierResolver } from '@papercusp/tooldef';
// Papercusp's capability→tier policy (plan P-012) — the host impl registered
// as tooldef's tier resolver (see capability-tiers-papercusp.ts).
export { papercuspTierFor } from './capability-tiers-papercusp';

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
  type ToolExposureSlash,
  type UnifiedToolContext,
  type MinimalEventSink,
  type PapercuspBinaryEnvelope,
} from '@papercusp/tooldef';

export {
  dispatchProjectedTool,
  dispatchProjectedToolStream,
  defaultComputeQuotaWindow,
  UnauthorizedToolError,
  HarnessRequiredError,
  PASS_THROUGH,
  type QuotaWindow,
  type DispatchProjectedDeps,
  type DispatchProjectedResult,
  type DispatchProjectedErrorCode,
  type DispatchStreamEvent,
  type PostInvokeEvent,
  type CapabilityEnvelopeVerdict,
  type ToolDispatchOverrideFn,
} from '@papercusp/tooldef';
// Declarative preconditions (`requires:` — autoloop-pot-operator-rebuild D-006):
// the preInvoke mirror of `emits:`. The host wires `deps.firePrecondition` to
// its dispatcher (Papercusp's: `lib/events` → fireReactionInProcess).
export type {
  ToolRequireSpec,
  ToolPreInvokeEvent,
  PreconditionFireRequest,
} from '@papercusp/tooldef';
// Papercusp's quota windowing policy (plan P-011) — the host impl of
// tooldef's `computeQuotaWindow` seam. Wired into PROJECTED_DEPS.
export { papercuspComputeQuotaWindow } from './quota-policy';
// Papercusp's auth-tier → gate-bypass mapping (plan P-014) — the host impl of
// tooldef's neutral `ctx.gateBypass`, set by the HTTP + MCP transports.
export { papercuspGateBypass, testingFullAccess, TESTING_FULL_ACCESS_ROLES } from './gate-bypass';
export type { GateBypass } from '@papercusp/tooldef';

// Resource authorization (RFC tooldef-auth). The host supplies the decision
// (an `authorize` hook / PolicyDecisionPoint) and wires `deps.auditAuth` to a
// sink — Papercusp's is `apps/operator/lib/tool-authz-audit.ts`.
export { ownerOnly } from '@papercusp/tooldef';
export type {
  AuthzQuery,
  AuthDecision,
  PolicyDecisionPoint,
  AuthAuditEvent,
  Authorizer,
} from '@papercusp/tooldef';

// HTTP transport adapter — extracted to @papercusp/tooldef-http (plan P-030).
// Re-exported here so existing `@papercusp/agent-mcp` consumers are untouched.
export {
  handleHttpToolRequest,
  handleHttpToolRequestStreaming,
  buildHttpSpawnContext,
  PAPERCUSP_CONTEXT_HEADERS,
  type HttpToolRequest,
  type HttpToolResponse,
  type HttpToolResult,
  type HttpToolHostExtras,
  type ToolScope,
  type HttpRequestContextInput,
} from '@papercusp/tooldef-http';
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
} from '@papercusp/tooldef';

export {
  readReplayBuffer,
  closeReplayBuffer,
  replayBufferStats,
  type ReplayBufferedEvent,
} from '@papercusp/tooldef';

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
  componentKey,
  standardResponseComponents,
  type OpenApiFragment,
} from '@papercusp/tooldef';
export {
  assembleOpenApiDocument,
  toolOperationName,
  type OpenApiDocumentOptions,
} from '@papercusp/tooldef';

import './bootstrap';
