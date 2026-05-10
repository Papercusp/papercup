/**
 * Tool projection registry — the function-as-truth abstraction.
 *
 * A "projected tool" is a typed async function plus a manifest entry
 * declaring how that function should be exposed:
 *
 *   - `expose.http`: framework auto-mounts at the declared path.
 *   - `expose.mcp`:  framework auto-registers as an MCP tool.
 *
 * Both projections call the same function. Capability + role + quota
 * gates run identically. Tests target the function with a mock ctx;
 * neither transport needs to be running.
 *
 * This module is the registry + lookup APIs. Transport adapters
 * (the dynamic HTTP catch-all route, the MCP `tools/list` + `tools/call`
 * handlers) consume this registry to do their work.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */

import type {
  AgentRole,
  Capability,
  PluginSpawn,
  ProgressCallback,
  RolesQuota,
  ToolResult,
} from '@papercusp/plugin-sdk';

/* ─── Unified context ────────────────────────────────────────────────── */

/**
 * The single context passed to every projected tool function — same shape
 * regardless of which transport invoked it. Fields are populated by the
 * relevant transport adapter:
 *
 *   - HTTP transport (built-in tools, in-process callers): populates
 *     `principal`, `tx`, `log`. Spawn fields are populated only if the
 *     caller sent the X-Papercusp-* headers (e.g. orchestrator-spawned
 *     OMP via the bridge).
 *
 *   - MCP transport (agent calls): populates `workspaceId`, `harnessSlug`,
 *     `role`, `featureId`, `chunkId`, `runId`, `spawnId`, `parentSpawnId`,
 *     `progress`, `spawn`, `secret`, `signal`. Built-in fields like
 *     `principal`/`tx` are populated when the bearer also resolves to one.
 *
 * Tool functions opt into whichever fields they need. The framework
 * doesn't care which transport triggered the call.
 */
export interface UnifiedToolContext {
  /** Tool-bound logger. Always populated. */
  log: (msg: string) => void;
  /** Aborts on per-tool timeout, parent cancellation, or shutdown. */
  signal: AbortSignal;
  /** Stream progress events. No-op when transport doesn't support streaming. */
  progress: ProgressCallback;

  /* ── Auth / db (typically built-in tools) ─────────────────────────── */
  /** Auth principal resolved from bearer. Null when caller is anonymous. */
  principal?: { slug: string; workspaceId: string; capabilities: Set<string> } | null;
  /**
   * Transaction-bound Sql client with `app.workspace_id` GUC set. Built-in
   * tools rely on this; plugin tools may use it. Null when call wasn't
   * wrapped in `withWorkspace`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx?: any;

  /**
   * True when the call entered through the superuser endpoint
   * (loopback + bearer-token auth — see apps/operator/lib/superuser-token.ts
   * and apps/operator/content/docs/endpoint-system/superuser-mode.mdx).
   * Bypasses role-allowlist and quota gates; capability gate still runs
   * when a principal is attached.
   */
  isSuperuser?: boolean;

  /* ── Spawn context (typically agent-driven calls) ─────────────────── */
  workspaceId?: string;
  harnessSlug?: string;
  projectDir?: string;
  stateDir?: string;
  role?: AgentRole;
  featureId?: string | null;
  chunkId?: string | null;
  runId?: string;
  spawnId?: string;
  parentSpawnId?: string | null;

  /* ── Capability-gated helpers ─────────────────────────────────────── */
  spawn?: PluginSpawn;
  secret?: (name: string) => Promise<string | null>;
}

/** A tool function — one shape for every transport. */
export type ToolFn<TInput = unknown> = (
  input: TInput,
  ctx: UnifiedToolContext,
) => Promise<ToolResult>;

/* ─── Manifest declarations ──────────────────────────────────────────── */

export interface ToolExposureHttp {
  /** Path the catch-all HTTP route serves; e.g. '/api/plugins/repomix/pack'. */
  path: string;
  /** Allowed methods. Default: ['POST']. */
  methods?: ReadonlyArray<'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE'>;
}

export interface ToolExposureMcp {
  /** MCP tool name; must use dotted naming (e.g. 'repomix.pack'). */
  name: string;
  /**
   * If true, the tool may emit progress events via `ctx.progress(...)`.
   * The MCP transport translates them to `notifications/progress` events.
   * No effect on the HTTP transport (which uses SSE differently).
   */
  streaming?: boolean;
  /**
   * If true, the tool may produce an output too large to inline; result
   * shaping should write to `<stateDir>/scratch/<...>` and return `{ path }`.
   * Hint to the framework's content-shaper, not enforced.
   */
  largeOutput?: boolean;
}

/** Per-tool exposure config — at least one of `http`/`mcp` must be set. */
export interface ToolExposure {
  http?: ToolExposureHttp;
  mcp?: ToolExposureMcp;
}

/**
 * One entry in the projection registry. Combines the function (truth)
 * with manifest metadata (gates + exposure).
 */
export interface ProjectedTool {
  /** Owning plugin name. Built-in tools use 'agent-mcp' or similar. */
  pluginName: string;
  /** One-line description shown in tool listings. */
  description: string;
  /** JSON Schema for tool input. Validated before invocation. */
  inputSchema: Record<string, unknown>;
  /**
   * Capabilities required to invoke. The dispatcher checks these against
   * the calling principal's grants (built-in path) AND against the
   * plugin's manifest-declared `capabilities` (plugin path). Empty array
   * means no capability gate.
   */
  capabilities: Capability[];
  /**
   * Allowed agent roles. Empty/undefined means any role can call. Used
   * primarily by the MCP transport (agent calls); HTTP callers gate via
   * principal capabilities instead.
   */
  roles?: AgentRole[];
  /** Per-role quota windows. Roles without an entry are unlimited. */
  rolesQuota?: Partial<Record<AgentRole, RolesQuota>>;
  /** Per-call wall-clock timeout, default 60s. */
  timeoutSec?: number;
  /** Where to project this function — at least one of http/mcp required. */
  expose: ToolExposure;
  /** The function. Source of truth. */
  fn: ToolFn;
}

/* ─── Registry ───────────────────────────────────────────────────────── */

// Anchor on globalThis so multiple module instances (Next standalone +
// Turbopack chunking sometimes resolves @papercusp/agent-mcp into more
// than one CJS instance — e.g. one for app routes, one for plugin-loader's
// dynamic import) share a single registry. Without this, plugin-loader's
// `registerProjectedTool(...)` writes to instance A's Map while
// `/api/plugins/tools` reads instance B's Map, and plugin tools appear to
// register but are never reachable. Bug regressed twice before this
// comment landed; please don't switch back without solving the
// module-instance-singleton story first.
interface RegistryStore {
  REGISTRY: Map<string, ProjectedTool>;
  BY_MCP_NAME: Map<string, ProjectedTool>;
  BY_HTTP_PATH: Map<string, ProjectedTool>;
}
const __PAPERCUSP_PROJECTED_TOOL_REGISTRY = '__papercuspProjectedToolRegistry';
const __g = globalThis as unknown as Record<string, RegistryStore>;
if (!__g[__PAPERCUSP_PROJECTED_TOOL_REGISTRY]) {
  __g[__PAPERCUSP_PROJECTED_TOOL_REGISTRY] = {
    REGISTRY: new Map<string, ProjectedTool>(),
    BY_MCP_NAME: new Map<string, ProjectedTool>(),
    BY_HTTP_PATH: new Map<string, ProjectedTool>(),
  };
}
const REGISTRY = __g[__PAPERCUSP_PROJECTED_TOOL_REGISTRY].REGISTRY;
const BY_MCP_NAME = __g[__PAPERCUSP_PROJECTED_TOOL_REGISTRY].BY_MCP_NAME;
const BY_HTTP_PATH = __g[__PAPERCUSP_PROJECTED_TOOL_REGISTRY].BY_HTTP_PATH;

/** Stable unique key for a tool entry. */
function entryKey(tool: ProjectedTool): string {
  // Prefer mcp.name; fall back to http.path; last resort plugin/<idx>.
  if (tool.expose.mcp?.name) return `mcp:${tool.expose.mcp.name}`;
  if (tool.expose.http?.path) return `http:${tool.expose.http.path}`;
  return `${tool.pluginName}:?`;
}

export class ToolRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistrationError';
  }
}

/**
 * Register a projected tool. Validates the manifest:
 *   - At least one of `expose.http` / `expose.mcp` must be set.
 *   - `expose.mcp.name` must use dotted naming and be unique across the
 *     registry.
 *   - `expose.http.path` must be unique across the registry.
 */
export function registerProjectedTool(tool: ProjectedTool): void {
  if (!tool.expose.http && !tool.expose.mcp) {
    throw new ToolRegistrationError(
      `tool from plugin "${tool.pluginName}" must declare at least one of expose.http / expose.mcp`,
    );
  }
  if (tool.expose.mcp) {
    const name = tool.expose.mcp.name;
    // Require a namespace separator (dot or colon) to prevent collisions
    // with bare names. Both conventions in use:
    //   - dotted (plugin tools, our preference): 'repomix.pack'
    //   - colon (built-in agent-mcp tools): 'tasks:list', 'audit:list'
    if (!name || (!name.includes('.') && !name.includes(':'))) {
      throw new ToolRegistrationError(
        `MCP tool name "${name}" must include a namespace separator ("." or ":") — e.g. "${tool.pluginName.replace(/^@.*\//, '')}.verb"`,
      );
    }
    const prior = BY_MCP_NAME.get(name);
    if (prior && prior.pluginName !== tool.pluginName) {
      throw new ToolRegistrationError(
        `MCP tool name "${name}" claimed by plugins "${prior.pluginName}" and "${tool.pluginName}"`,
      );
    }
    BY_MCP_NAME.set(name, tool);
  }
  if (tool.expose.http) {
    const p = tool.expose.http.path;
    if (!p.startsWith('/')) {
      throw new ToolRegistrationError(`HTTP path "${p}" must start with "/"`);
    }
    const prior = BY_HTTP_PATH.get(p);
    if (prior && prior.pluginName !== tool.pluginName) {
      throw new ToolRegistrationError(
        `HTTP path "${p}" claimed by plugins "${prior.pluginName}" and "${tool.pluginName}"`,
      );
    }
    BY_HTTP_PATH.set(p, tool);
  }
  REGISTRY.set(entryKey(tool), tool);
}

/**
 * Remove all entries for a plugin from the registry. Used by the host's
 * `/api/plugins/host/refresh` flow so re-discovery can re-register without
 * tripping the cross-plugin name-collision guard against its own prior
 * entries.
 */
export function unregisterProjectedToolsForPlugin(pluginName: string): number {
  let removed = 0;
  for (const [k, t] of Array.from(REGISTRY.entries())) {
    if (t.pluginName === pluginName) { REGISTRY.delete(k); removed++; }
  }
  for (const [k, t] of Array.from(BY_MCP_NAME.entries())) {
    if (t.pluginName === pluginName) BY_MCP_NAME.delete(k);
  }
  for (const [k, t] of Array.from(BY_HTTP_PATH.entries())) {
    if (t.pluginName === pluginName) BY_HTTP_PATH.delete(k);
  }
  return removed;
}

/** Look up by MCP name (e.g. 'repomix.pack'). */
export function lookupByMcpName(name: string): ProjectedTool | undefined {
  return BY_MCP_NAME.get(name);
}

/** Look up by HTTP path (e.g. '/api/plugins/repomix/pack'). */
export function lookupByHttpPath(path: string): ProjectedTool | undefined {
  return BY_HTTP_PATH.get(path);
}

/** Snapshot of all registered projected tools. */
export function listAllProjectedTools(): readonly ProjectedTool[] {
  return Array.from(REGISTRY.values());
}

/**
 * MCP-protocol tool listings, optionally filtered by calling role.
 * Returns only tools with `expose.mcp` set; tools that are HTTP-only are
 * invisible to the agent.
 */
export interface McpToolListing {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function listMcpProjections(role?: AgentRole): McpToolListing[] {
  const out: McpToolListing[] = [];
  for (const tool of REGISTRY.values()) {
    if (!tool.expose.mcp) continue;
    if (role && tool.roles && !tool.roles.includes(role)) continue;
    out.push({
      name: tool.expose.mcp.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
  }
  return out;
}

/** Test-only — flushes the registry between tests. */
export function _resetProjectionRegistryForTests(): void {
  REGISTRY.clear();
  BY_MCP_NAME.clear();
  BY_HTTP_PATH.clear();
}
