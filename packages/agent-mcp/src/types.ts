/**
 * Core types for the Agent MCP server.
 */

import type { AgentRole, RolesQuota, ToolResult } from '@papercusp/plugin-sdk';
import type { Sql } from 'postgres';
import type { z, ZodTypeAny } from 'zod';
import type { UnifiedToolContext } from './tool-projection';

/** A Papercusp capability tier per spec/capabilities §10.6.1. */
export type CapabilityTier = 'low' | 'medium' | 'high';

/** Principal kinds resolved from a bearer token. */
export type PrincipalKind = 'harness' | 'system' | 'pi';

/** Resolved caller identity. */
export interface Principal {
  kind: PrincipalKind;
  /** e.g. `"system:operator"`, `"pi:abc123"`, `"harness-foo"`. */
  slug: string;
  workspaceId: string;
  /** Granted capability strings (e.g. `tasks:read`). */
  capabilities: ReadonlySet<string>;
}

/** Per-call request context. */
export interface ToolContext {
  principal: Principal;
  /**
   * Transaction-bound Sql client with `app.workspace_id` GUC set.
   * Tools must use this; never reach for the bare-pool db.
   */
  tx: Sql;
  /** Logger bound to the tool name + principal. */
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * mcp-ui UIResource — interactive UI fragment a tool can return alongside
 * its data. Spec: https://github.com/idosal/mcp-ui. Shape mirrors
 * `@mcp-ui/server`'s `UIResource` so it round-trips through the MCP
 * transport without rewriting.
 */
export interface UIResourceContent {
  type: 'resource';
  resource: {
    uri: string;
    mimeType: string;
    text?: string;
    blob?: string;
    _meta?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/** Standard envelope for any tool response. */
export interface ToolResponse<T = unknown> {
  data: T;
  /** True when one or more sources were unavailable; partial result still useful. */
  degraded?: boolean;
  degradedReasons?: string[];
  /** Pagination cursor (for list tools that support it). */
  nextCursor?: string;
  /**
   * Optional mcp-ui UI fragments returned alongside the JSON `data`.
   * The HTTP MCP transport pushes these into the tool result's `content`
   * array; clients with a UIResource renderer (Oracle dock, Claude
   * Desktop, Cline, …) display them inline. Null/empty for tools that
   * only return data.
   */
  uiResources?: UIResourceContent[];
}

/** Tool definition produced by `defineTool`. */
export interface ToolDefinition<TArgs extends ZodTypeAny = ZodTypeAny> {
  /** Tool name, e.g. `"tasks:list"`. Defaults to file-path-derived. */
  name: string;
  /** TSDoc-derived description for MCP `tools/list`. */
  description: string;
  /** Capability gate (e.g. `"tasks:read"`). One per tool. */
  capability: string;
  /** Tier looked up from the capability per §10.6.1's table. */
  tier: CapabilityTier;
  /** Argument schema. Doubles as runtime validation and JSON-schema source. */
  args: TArgs;
  /** Implementation. Tools may return any data shape inside ToolResponse. */
  handler: (args: z.infer<TArgs>, ctx: ToolContext) => Promise<ToolResponse>;
}

/** Input shape for `defineTool` — same as ToolDefinition minus derived fields. */
export interface ToolDefinitionInput<TArgs extends ZodTypeAny = ZodTypeAny> {
  /** Optional explicit name; defaults to file-path-derived. */
  name?: string;
  /** Optional explicit description; defaults to caller's TSDoc. */
  description?: string;
  capability: string;
  args: TArgs;
  handler: (args: z.infer<TArgs>, ctx: ToolContext) => Promise<ToolResponse>;
}

/**
 * Role-gated first-party tool definition.
 *
 * Same registry as principal-gated `defineTool`, different gate. Used for
 * first-party operator behavior that spawned agents must be able to call
 * (operator scan, harness phases, voice config, …) — those callers have
 * a URL spawn-context but no bearer token, so principal+capability gating
 * doesn't apply.
 *
 * Keep first-party tools in `packages/agent-mcp/src/tools/<group>/<verb>.ts`
 * even when role-gated; do NOT shape-shift them into a fake "operator-core"
 * plugin (that would mix removable third-party plugins with core papercusp
 * code in the catalog forever).
 */
export interface RoleToolDefinition<TArgs extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  /** Capability string for tier classification + descriptive listings. Not enforced. */
  capability: string;
  tier: CapabilityTier;
  /** Marker — read by the projection wrapper to skip the principal check. */
  requirePrincipal: false;
  /** Allowed agent roles. Empty/undefined means any role. */
  roles?: AgentRole[];
  /** Per-role quota windows. Roles without an entry are unlimited. */
  rolesQuota?: Partial<Record<AgentRole, RolesQuota>>;
  /** Per-call wall-clock timeout, default 60s. */
  timeoutSec?: number;
  args: TArgs;
  /**
   * Handler receives the unified context (no principal). May return either
   * a raw `ToolResult` (MCP shape) or a `ToolResponse` envelope; the
   * wrapper adapts both.
   */
  handler: (
    args: z.infer<TArgs>,
    ctx: UnifiedToolContext,
  ) => Promise<ToolResult | ToolResponse>;
}

/** Input shape for role-gated `defineTool` — same as RoleToolDefinition minus derived fields. */
export interface RoleToolDefinitionInput<TArgs extends ZodTypeAny = ZodTypeAny> {
  name?: string;
  description?: string;
  capability: string;
  requirePrincipal: false;
  roles?: AgentRole[];
  rolesQuota?: Partial<Record<AgentRole, RolesQuota>>;
  timeoutSec?: number;
  args: TArgs;
  handler: (
    args: z.infer<TArgs>,
    ctx: UnifiedToolContext,
  ) => Promise<ToolResult | ToolResponse>;
}

// ──────────────────────────────────────────────────────────────────────
// Resources (MCP `resources/*`).
//
// Symmetric to tools, but for read-only browsable URIs. A resource is
// either:
//   - concrete: one URI, e.g. `papercusp://workspace/harnesses`
//   - templated: an RFC 6570-style URI with `{var}` segments that the
//     `list` callback expands at runtime, e.g.
//       template `papercusp://harness/{slug}/issues`
//       expanded `papercusp://harness/foo/issues`,
//                `papercusp://harness/bar/issues`, …
// ──────────────────────────────────────────────────────────────────────

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

export interface ResourceListEntry {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** Per-call resource read context. Same shape as ToolContext. */
export type ResourceContext = ToolContext;

/** Resource definition produced by `defineResource`. */
export interface ResourceDefinition {
  /** Concrete URI or RFC 6570 template (`{var}` segments). */
  uri: string;
  /** Stable name for `resources/list` UX. */
  name: string;
  description: string;
  /** Default mime, e.g. `application/json`. */
  mimeType: string;
  /** Capability gate; same vocabulary as tools. */
  capability: string;
  /** Tier inferred from capability per §10.6.1. */
  tier: CapabilityTier;
  /**
   * For templated resources: expand the template into concrete URIs
   * for `resources/list`. Omit for concrete (single-URI) resources.
   */
  list?: (ctx: ResourceContext) => Promise<ResourceListEntry[]>;
  /** Read a specific URI matching this resource's template/uri. */
  read: (uri: string, ctx: ResourceContext) => Promise<ResourceContents>;
}

/** Input shape for `defineResource`. */
export interface ResourceDefinitionInput {
  /** Optional explicit name; defaults to file-path-derived. */
  name?: string;
  /** Optional explicit description; defaults to caller's TSDoc. */
  description?: string;
  uri: string;
  mimeType?: string;
  capability: string;
  list?: (ctx: ResourceContext) => Promise<ResourceListEntry[]>;
  read: (uri: string, ctx: ResourceContext) => Promise<ResourceContents>;
}

// ──────────────────────────────────────────────────────────────────────
// Prompts (MCP `prompts/*`).
//
// Discoverable, parameterized prompt templates. Clients call
// `prompts/list` to see what's available, then `prompts/get(name, args)`
// to instantiate one. A prompt renders to an array of role/content
// messages — same shape MCP itself uses for completion requests.
// ──────────────────────────────────────────────────────────────────────

export interface PromptArgumentSchema {
  /** Stable name (used in `prompts/get` arg map). */
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptMessage {
  role: 'user' | 'assistant' | 'system';
  content: { type: 'text'; text: string };
}

export interface PromptResult {
  description?: string;
  messages: PromptMessage[];
}

/** Per-call prompt render context. Same shape as ToolContext. */
export type PromptContext = ToolContext;

export interface PromptDefinition {
  name: string;
  description: string;
  /**
   * Capability gate. Optional — many prompts are public (no gate).
   * If present, callers without the capability won't see the prompt
   * in `prompts/list` and `prompts/get` will deny.
   */
  capability?: string;
  /** Tier inferred from capability per §10.6.1, or 'low' if no capability. */
  tier: CapabilityTier;
  /** Argument schema as MCP prompts/list expects. */
  arguments?: PromptArgumentSchema[];
  /** Render the prompt with provided arguments. */
  render: (
    args: Record<string, string>,
    ctx: PromptContext,
  ) => Promise<PromptResult>;
}

export type { UIResourceContent as UIResource };

export interface PromptDefinitionInput {
  name?: string;
  description?: string;
  capability?: string;
  arguments?: PromptArgumentSchema[];
  render: (
    args: Record<string, string>,
    ctx: PromptContext,
  ) => Promise<PromptResult>;
}
