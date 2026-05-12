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

import { z, type ZodTypeAny } from 'zod';
import type {
  AgentRole,
  Capability,
  EmitCallback,
  PluginSpawn,
  ProgressCallback,
  RolesQuota,
  ToolResult,
} from '@papercusp/plugin-sdk';

/* ─── Event schema types ─────────────────────────────────────────────── */

/** Schema for a tool's typed event channel. Keys are wire-level event names. */
export type EventsSchema = Record<string, ZodTypeAny>;

/**
 * Reserved event names — names the framework emits internally OR has
 * semantics around. Tools declaring an `events` schema must not use
 * these as keys. The TS-level guard `UserEvents<T>` enforces this at
 * compile time on `defineTool`'s generic parameter.
 *
 * - `done`: framework auto-emits when the handler returns successfully.
 * - `progress`: emitted via `ctx.progress` (the alias); reserved so
 *   tools don't redefine its payload shape.
 * - `heartbeat`: @restart/sse emits this every 15s to keep the
 *   connection alive; never a tool event.
 * - `result`: legacy pre-2026-05-12 terminal-event name; reserved for
 *   collision avoidance even though the framework no longer emits it.
 *
 * `error` is intentionally NOT reserved — the framework auto-emits it
 * on handler throw, but tools may also emit it mid-stream for non-fatal
 * errors (dual-mode; canonical example is runAgentChat's mid-stream
 * 'error' yields). See ToolContext.emit doc for the contract.
 */
export type ReservedEventNames = 'done' | 'progress' | 'heartbeat' | 'result';

/** Compile-time guard: a user-declared events schema cannot contain reserved names. */
export type UserEvents<T extends EventsSchema> = T & { [K in ReservedEventNames]?: never };

/**
 * How an event's payload is encoded on the SSE wire:
 *  - `'string'`: the payload IS a string; emit as `data: <text>\n` (multi-line `data:`
 *    when text contains newlines, joined back by parseSseStream per SSE spec).
 *    Use for token streams (LLM deltas, log lines) where the event payload
 *    has no inherent structure and JSON-wrapping is overhead.
 *  - `'json'`: emit as `data: <JSON.stringify(payload)>\n`. Use for everything
 *    structured (suggestions, tool_calls, progress payloads).
 *
 * Inferred from the declared Zod schema at tool registration:
 *  - `z.string()` schemas → 'string'
 *  - everything else → 'json'
 *
 * The MCP transport always JSON-serializes (JSON-RPC carries strings as
 * JSON-quoted strings inside notifications/papercusp/event); the
 * classification only affects the HTTP/SSE wire shape.
 */
/**
 * On-wire encoding for a single event name.
 *
 * - `'string'` — payload is the raw text of the event (no JSON wrapping).
 *   Picked when the event schema is `z.string()`. SSE `data:` line, IPC
 *   EVENT_JSON frame with the string as the `data` field.
 * - `'json'` — payload is `JSON.stringify(data)`. The default for object
 *   / number / array event schemas.
 * - `'binary'` — payload is raw bytes (Uint8Array). On SSE this falls
 *   back to base64 + a `content-encoding: base64` header (not currently
 *   implemented; would be a separate addition). On the IPC transport,
 *   this triggers an EVENT_BIN self-describing frame. Picked when the
 *   event schema is `z.instanceof(Uint8Array)`.
 *
 * See `apps/operator/content/docs/endpoint-system/transports.mdx`
 * § "Schema-inferred wire format".
 */
export type EventWireKind = 'string' | 'json' | 'binary';

/**
 * Inspect a Zod schema and decide whether the wire payload for events
 * of that shape should be raw text (`'string'`) or JSON-encoded (`'json'`).
 *
 * Cheap one-time call per declared event at register time; result is
 * cached on the tool entry so emit-time has no schema-introspection cost.
 */
export function classifyEventWire(schema: ZodTypeAny): EventWireKind {
  // Binary check: detect `z.instanceof(Uint8Array)` by probing the
  // schema with a real Uint8Array. Zod 4 represents instanceof as
  // `{ type: 'custom', fn }` with the Class captured in the fn closure,
  // so structural _def sniffing isn't reliable. The probe is cheap
  // (one parse) and runs once per declared event at register time.
  //
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)?._def;
  if (def?.type === 'custom') {
    try {
      const probe = schema.safeParse(new Uint8Array(0));
      const rejectsObject = !schema.safeParse({}).success;
      if (probe.success && rejectsObject) return 'binary';
    } catch {
      /* fall through to JSON */
    }
  }

  try {
    // Zod 4: built-in toJSONSchema — same path as inputSchema serialization.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = (z as any).toJSONSchema(schema) as { type?: string };
    return json.type === 'string' ? 'string' : 'json';
  } catch {
    // Schema rejected json conversion; default to JSON on the wire so
    // the dispatcher never produces an under-defined string fallback.
    return 'json';
  }
}

/**
 * Wire-kind-aware sink dispatch — the single source of truth for
 * "given a ctx.emit(name, data) and a tool's declared events schema,
 * how does that land on the SSE wire?"
 *
 * Used by:
 *   - HTTP transport adapter (`handleHttpToolRequestStreaming`).
 *   - Route shims that bypass the HTTP transport and call
 *     `dispatchProjectedToolStream` themselves (architect/brainstorm
 *     in `apps/operator/app/api/_hono/harness.ts`, operator-scan /
 *     operator-converse / delegate-chat).
 *
 * Centralizing here prevents the wire-format-drift class of bug:
 *   - z.string() events going through JSON.stringify (round-2 silent
 *     mis-encoding for tools added new z.string() events post-pilot).
 *   - z.instanceof(Uint8Array) → JSON.stringify producing
 *     `{"0":..., "1":..., ...}` corruption (round-5 HTTP, round-6 MCP).
 *
 * Mirrored emit-shape per transport:
 *   - HTTP/SSE (this helper):           z.string() → sink.eventRaw raw text
 *                                       z.instanceof(Uint8Array) → sink.eventRaw base64
 *                                       else → sink.event JSON
 *   - MCP (notifications/papercusp/event in [transport]/route.ts):
 *                                       Uint8Array → {$papercuspBinary, encoding, data}
 *                                       else → params.data
 *   - IPC (server.ts):                  string event kind: EVENT_JSON with data as string
 *                                       binary: EVENT_BIN raw bytes
 *                                       else: EVENT_JSON JSON
 *
 * The shape of the SSE sink interface is the @restart/sse SseSink; we
 * don't import the type here to keep this file dependency-free, so
 * we declare a structural minimum: `eventRaw(name, string)` for raw-text
 * payloads and `event(name, value)` for JSON-encoded ones.
 */
export interface MinimalEventSink {
  event(name: string, value: unknown): void;
  eventRaw(name: string, value: string): void;
}

export function emitToSseSink(
  sink: MinimalEventSink,
  tool: Pick<ProjectedTool, 'eventWireKinds'>,
  name: string,
  data: unknown,
): void {
  const kind = tool.eventWireKinds?.[name];
  if (kind === 'string') {
    sink.eventRaw(name, typeof data === 'string' ? data : String(data));
  } else if (kind === 'binary' && data instanceof Uint8Array) {
    sink.eventRaw(name, Buffer.from(data).toString('base64'));
  } else {
    sink.event(name, data);
  }
}

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
  /**
   * Stream progress events. Thin alias over `emit('progress', { progress, total, message? })`.
   * Tools using the standard pct/msg shape should prefer this; tools
   * emitting richer typed events should use `emit` directly.
   * No-op when transport doesn't support streaming.
   */
  progress: ProgressCallback;
  /**
   * Emit a typed named event. The active transport adapter decides what
   * happens:
   *   - HTTP/SSE → `event: <name>\ndata: <JSON(data)>` via @restart/sse.
   *   - MCP → `notifications/papercusp/event` with `{ event: name, data }`.
   *   - In-process (`fnStream`) → next value of the async iterator.
   *   - Non-streaming HTTP → no-op.
   *
   * Reserved names: 'done' | 'progress' | 'heartbeat' | 'result'. The
   * framework emits 'done' automatically when the handler returns and
   * 'error' automatically when it throws. Handlers may also emit 'error'
   * mid-stream for non-fatal errors (dual-mode by design — preserves
   * runAgentChat's non-terminal error event semantics).
   *
   * Always populated; transport adapter installs the right impl.
   */
  emit: EmitCallback;

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

  /**
   * When the agent was spawned from a browser tab (chat surfaces), the
   * tab's UI client_id is passed through here so `ui:*` tools default
   * to it. Null/undefined for headless spawns and CLI callers.
   */
  uiClientId?: string | null;

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
  /**
   * Idle timeout — abort if no event has been emitted for this many
   * seconds. Augments `timeoutSec` (the wall-clock cap). 0 or undefined
   * disables idle-watchdog. Default off. Useful for streaming tools that
   * spawn child processes — wedged children stop emitting; this catches
   * them sooner than the wall-clock cap.
   */
  idleTimeoutSec?: number;
  /**
   * Typed event channel — Zod schemas keyed by event name. Surfaced
   * via tools/list as JSON-Schema for client discovery. No runtime
   * validation of outgoing events (trusted code path). Undefined for
   * tools that don't stream typed events; they may still call
   * `ctx.progress` (the alias) which goes through the 'progress' wire
   * event reserved for that purpose.
   *
   * Plugins declaring this on their JSON manifest currently get a
   * runtime warning — plugin events are a Phase 4+ feature.
   */
  events?: EventsSchema;
  /**
   * Per-event wire classification — `'string'` for z.string() schemas
   * (raw text on SSE), `'json'` for everything else. Computed once at
   * register time from `events`; cached so emit-time is constant-cost.
   * Absent when `events` is undefined.
   */
  eventWireKinds?: Record<string, EventWireKind>;
  /** Where to project this function — at least one of http/mcp required. */
  expose: ToolExposure;
  /** The function. Source of truth. */
  fn: ToolFn;
  /**
   * Per-tool guidance for system-prompt assembly + `agent_tools:list`
   * introspection. Plumbed from `defineTool({ guidance })` (or the
   * plugin SDK's same slot). See `ToolGuidance` in types.ts.
   *
   * Shape mirrors `ToolGuidance` but without a `byRole` type-import to
   * keep this module free of role-enum imports. Plumbed-through opaque.
   */
  guidance?: {
    when?: string;
    notWhen?: string;
    chaining?: string;
    byRole?: Record<string, { when?: string; notWhen?: string; chaining?: string }>;
  };
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
  // Pre-classify event wire kinds so emit-time is constant-cost.
  // Caller might set eventWireKinds explicitly (some tests do); only
  // compute when absent.
  if (tool.events && !tool.eventWireKinds) {
    const kinds: Record<string, EventWireKind> = {};
    for (const [name, schema] of Object.entries(tool.events)) {
      kinds[name] = classifyEventWire(schema);
    }
    tool.eventWireKinds = kinds;
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
 *
 * The `events` field surfaces the tool's typed event vocabulary as
 * JSON-Schema entries — discoverable by any MCP client. This is the
 * Papercusp MCP extension that lets clients render typed event streams
 * (deltas, suggestions, etc.) without out-of-band knowledge of each
 * tool. Standard MCP clients that don't know about this field simply
 * ignore it.
 */
export interface McpToolListing {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Map of event-name → JSON-Schema. Absent when the tool declares no events. */
  events?: Record<string, Record<string, unknown>>;
}

/**
 * Memoise the JSON-Schema serialization per ProjectedTool reference.
 * Same `events` object identity means same serialized output, so the
 * weak-keyed cache avoids re-running `z.toJSONSchema` on every
 * `tools/list` call.
 */
const EVENTS_JSON_CACHE = new WeakMap<EventsSchema, Record<string, Record<string, unknown>>>();

function serializeEventsSchema(events: EventsSchema): Record<string, Record<string, unknown>> {
  const cached = EVENTS_JSON_CACHE.get(events);
  if (cached) return cached;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, schema] of Object.entries(events)) {
    const kind = classifyEventWire(schema);
    if (kind === 'binary') {
      // z.toJSONSchema throws on z.instanceof(Uint8Array) ("Custom types
      // cannot be represented in JSON Schema"). Surface binary events
      // explicitly so MCP clients can decode the EVENT_BIN wire frame.
      out[name] = {
        type: 'string',
        contentEncoding: 'base64',
        description: 'Binary payload — base64 over JSON transports; raw bytes over IPC EVENT_BIN.',
      };
      continue;
    }
    try {
      // Zod 4: use built-in z.toJSONSchema (zod-to-json-schema@3 returns
      // empty schemas on zod 4 — same reason define-tool uses this path).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = (z as any).toJSONSchema(schema) as Record<string, unknown>;
      // Drop $schema — MCP clients don't need it and it's noise in tools/list.
      delete json.$schema;
      out[name] = json;
    } catch {
      // Any other unrepresentable schema (custom check, lazy refs to
      // self, etc.) → emit a permissive placeholder so tools/list never
      // 500s. The tool still works; clients just lose the typed view.
      out[name] = { description: 'Schema not representable in JSON Schema.' };
    }
  }
  EVENTS_JSON_CACHE.set(events, out);
  return out;
}

export function listMcpProjections(role?: AgentRole): McpToolListing[] {
  const out: McpToolListing[] = [];
  for (const tool of REGISTRY.values()) {
    if (!tool.expose.mcp) continue;
    if (role && tool.roles && !tool.roles.includes(role)) continue;
    const listing: McpToolListing = {
      name: tool.expose.mcp.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
    if (tool.events && Object.keys(tool.events).length > 0) {
      listing.events = serializeEventsSchema(tool.events);
    }
    out.push(listing);
  }
  return out;
}

/** Test-only — flushes the registry between tests. */
export function _resetProjectionRegistryForTests(): void {
  REGISTRY.clear();
  BY_MCP_NAME.clear();
  BY_HTTP_PATH.clear();
}
