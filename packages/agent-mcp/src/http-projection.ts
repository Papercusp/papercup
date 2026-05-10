/**
 * HTTP transport adapter for projected tools.
 *
 * The dynamic catch-all route at apps/operator/app/api/plugins/[...path]
 * (and any other catch-alls per agent-tools etc.) delegates to
 * `handleHttpToolRequest()`. This module is the pure routing logic —
 * isolated for testability without a Next.js / Hono runtime.
 *
 * Flow (per inbound HTTP request):
 *   1. Look up the tool by URL pathname via lookupByHttpPath.
 *   2. Verify request method is in tool.expose.http.methods (default POST).
 *   3. Build a UnifiedToolContext from request headers + URL query params:
 *        - bearer → resolveBearer → principal/tx (built-in tools)
 *        - X-Papercusp-* headers → spawn context (workspace, role, …)
 *        - urlSearchParams → fallback for the spawn context (parity with
 *          MCP transport's URL-param model)
 *   4. Validate input against tool.inputSchema (TODO: wire ajv when we
 *      build it; v1 trusts the route to validate or trusts the fn).
 *   5. Branch on the tool's expose.http content-type preference:
 *        - JSON (default): build sync response from dispatch result.
 *        - SSE (when tool.expose.mcp?.streaming and Accept includes
 *          text/event-stream): stream {progress, result} events.
 *   6. dispatchProjectedTool with the right deps.
 *   7. Shape result back to HTTP response.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */

import type { AgentRole } from '@papercusp/plugin-sdk';
import {
  dispatchProjectedTool,
  type DispatchProjectedDeps,
  type DispatchProjectedResult,
} from './dispatch-projected';
import {
  lookupByHttpPath,
  type ProjectedTool,
  type UnifiedToolContext,
} from './tool-projection';

/* ─── Request context derivation ─────────────────────────────────────── */

/** Headers we read from inbound HTTP requests to populate the spawn ctx. */
export const PAPERCUSP_CONTEXT_HEADERS = {
  workspace: 'x-papercusp-workspace',
  harness: 'x-papercusp-harness',
  role: 'x-papercusp-role',
  feature: 'x-papercusp-feature',
  chunk: 'x-papercusp-chunk',
  run: 'x-papercusp-run',
  spawn: 'x-papercusp-spawn',
  parentSpawn: 'x-papercusp-parent-spawn',
} as const;

/** Headers and URL params an HTTP caller can supply. */
export interface HttpRequestContextInput {
  /** Lowercased header map. */
  headers: Record<string, string | undefined>;
  /** Parsed URL query string (for parity with MCP URL-param transport). */
  searchParams: URLSearchParams;
}

/**
 * Build a partial UnifiedToolContext from HTTP request inputs. The
 * caller (route handler) layers in `log`, `signal`, `progress`, `tx`,
 * and `principal` from its own auth/PG path; this fn populates only the
 * spawn context fields that are derivable from headers/query.
 */
export function buildHttpSpawnContext(input: HttpRequestContextInput): {
  workspaceId?: string;
  harnessSlug?: string;
  role?: AgentRole;
  featureId?: string | null;
  chunkId?: string | null;
  runId?: string;
  spawnId?: string;
  parentSpawnId?: string | null;
  projectDir?: string;
  stateDir?: string;
} {
  const get = (k: keyof typeof PAPERCUSP_CONTEXT_HEADERS): string | null => {
    const headerVal = input.headers[PAPERCUSP_CONTEXT_HEADERS[k]];
    if (headerVal && headerVal.trim()) return headerVal.trim();
    const queryVal = input.searchParams.get(
      k === 'workspace' ? 'workspace'
        : k === 'harness' ? 'harness'
          : k === 'role' ? 'role'
            : k === 'feature' ? 'feature'
              : k === 'chunk' ? 'chunk'
                : k === 'run' ? 'run'
                  : k === 'spawn' ? 'spawn'
                    : 'parent_spawn',
    );
    return queryVal && queryVal.trim() ? queryVal.trim() : null;
  };
  const out: ReturnType<typeof buildHttpSpawnContext> = {};
  const ws = get('workspace'); if (ws) out.workspaceId = ws;
  const slug = get('harness'); if (slug) out.harnessSlug = slug;
  const role = get('role'); if (role) out.role = role as AgentRole;
  out.featureId = get('feature');
  out.chunkId = get('chunk');
  const runId = get('run'); if (runId) out.runId = runId;
  const spawnId = get('spawn'); if (spawnId) out.spawnId = spawnId;
  out.parentSpawnId = get('parentSpawn');
  return out;
}

/* ─── HTTP request handler ───────────────────────────────────────────── */

export interface HttpToolRequest {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface HttpToolResponse {
  status: number;
  body: Record<string, unknown> | { error: { code: string; message: string; meta?: Record<string, unknown> } };
}

export type HttpToolResult =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'stream'; tool: ProjectedTool; ctx: UnifiedToolContext; input: unknown };

/**
 * Resolve a request to a ProjectedTool via lookupByHttpPath, build the
 * UnifiedToolContext, and dispatch.
 *
 * The host wires `extras` — a dependency surface giving us access to
 * bearer-auth resolution (for built-in tools), PG (for tx + quota +
 * recording), and a logger. The host also constructs the function-side
 * `progress` callback (no-op for non-streaming HTTP, SSE writer for
 * streaming).
 */
export interface HttpToolHostExtras {
  /** Resolves a bearer token to a principal + tx; null on auth failure. */
  resolvePrincipalAndTx?(bearer: string): Promise<{
    principal: NonNullable<UnifiedToolContext['principal']>;
    tx: UnifiedToolContext['tx'];
  } | null>;
  /** Wraps a fn in a workspace-bound transaction. v1: optional. */
  withWorkspace?<T>(workspaceId: string, fn: (tx: UnifiedToolContext['tx']) => Promise<T>): Promise<T>;
  /** Quota + invocation persistence. */
  deps: DispatchProjectedDeps;
  /** Per-tool logger; receives line + plugin/tool/ctx for routing. */
  log?(line: string, ctx: UnifiedToolContext): void;
  /** Progress writer — for non-streaming HTTP, this is no-op. */
  progress?(pct: number | undefined, msg: string | undefined, ctx: UnifiedToolContext): void;
  /**
   * Capability-gated subprocess helper. Plugin tools that need to shell
   * out (repomix, code2prompt, …) call `ctx.spawn(bin, argv, opts)`. The
   * host owns the impl so it can route through its capability check
   * + PATH resolution. Same shape used by the MCP transport.
   */
  spawn?: NonNullable<UnifiedToolContext['spawn']>;
  /** Secret resolver for plugin tools needing API keys (FIRECRAWL_API_KEY etc). */
  secret?: NonNullable<UnifiedToolContext['secret']>;
  /**
   * Resolve a harness slug + workspace id to project + state dirs. The
   * MCP transport already does this via the operator's
   * `resolveHarnessPaths`; HTTP needs the same resolver so plugin tools
   * (repomix, code2prompt, …) get a populated `ctx.projectDir`.
   */
  resolveHarnessPaths?(
    harnessSlug: string,
    workspaceId: string,
  ): Promise<{ projectDir: string; stateDir: string }>;
}

/**
 * Resolve the inbound tool request to a ProjectedTool + UnifiedToolContext
 * before dispatch. Shared by both `handleHttpToolRequest` (JSON path) and
 * `handleHttpToolRequestStreaming` (SSE path).
 */
async function resolveToolAndContext(
  req: HttpToolRequest,
  extras: HttpToolHostExtras,
): Promise<
  | { ok: true; tool: ProjectedTool; ctx: UnifiedToolContext }
  | { ok: false; status: number; body: HttpToolResponse['body'] }
> {
  const tool = lookupByHttpPath(req.pathname);
  if (!tool) {
    return {
      ok: false,
      status: 404,
      body: { error: { code: 'unknown_tool', message: `No tool at path "${req.pathname}"` } },
    };
  }
  const allowedMethods = tool.expose.http?.methods ?? ['POST'];
  if (!allowedMethods.includes(req.method as 'POST')) {
    return {
      ok: false,
      status: 405,
      body: { error: { code: 'method_not_allowed', message: `Tool "${req.pathname}" does not accept ${req.method}` } },
    };
  }
  const spawnCtx = buildHttpSpawnContext({ headers: req.headers, searchParams: req.searchParams });
  // Resolve project + state dirs from harness slug + workspace id when
  // both are present and the host supplied a resolver. Without this the
  // ctx fields stay undefined and tools needing `ctx.projectDir` (repomix,
  // code2prompt) fail with a transport-layer error.
  if (extras.resolveHarnessPaths && spawnCtx.harnessSlug && spawnCtx.workspaceId) {
    try {
      const paths = await extras.resolveHarnessPaths(spawnCtx.harnessSlug, spawnCtx.workspaceId);
      (spawnCtx as { projectDir?: string }).projectDir = paths.projectDir;
      (spawnCtx as { stateDir?: string }).stateDir = paths.stateDir;
    } catch { /* leave undefined; tool will surface a clear error */ }
  }
  const abort = new AbortController();
  const ctx: UnifiedToolContext = {
    log: (msg) => {
      const fullCtx: UnifiedToolContext = { ...spawnCtx, log: () => {}, signal: abort.signal, progress: () => {} };
      extras.log?.(msg, fullCtx);
    },
    signal: abort.signal,
    progress: (pct, msg) => {
      const fullCtx: UnifiedToolContext = { ...spawnCtx, log: () => {}, signal: abort.signal, progress: () => {} };
      extras.progress?.(pct, msg, fullCtx);
    },
    ...spawnCtx,
    ...(extras.spawn ? { spawn: extras.spawn } : {}),
    ...(extras.secret ? { secret: extras.secret } : {}),
  };
  const auth = req.headers['authorization'];
  if (auth && extras.resolvePrincipalAndTx) {
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    try {
      const resolved = await extras.resolvePrincipalAndTx(bearer);
      if (resolved) {
        ctx.principal = resolved.principal;
        ctx.tx = resolved.tx;
      }
    } catch { /* continue anonymous */ }
  }
  return { ok: true, tool, ctx };
}

function statusForErrorCode(code: string | undefined): number {
  return (
    code === 'unauthorized' ? 401
      : code === 'role_not_allowed' ? 403
        : code === 'missing_capability' ? 403
          : code === 'quota_exceeded' ? 429
            : code === 'invalid_input' ? 400
              : code === 'timeout' ? 504
                : code === 'unknown_tool' ? 404
                  : code === 'method_not_allowed' ? 405
                    : 500
  );
}

export async function handleHttpToolRequest(
  req: HttpToolRequest,
  extras: HttpToolHostExtras,
): Promise<HttpToolResponse> {
  const resolved = await resolveToolAndContext(req, extras);
  if (!resolved.ok) return { status: resolved.status, body: resolved.body };

  const r: DispatchProjectedResult = await dispatchProjectedTool(
    resolved.tool,
    resolved.tool.expose.mcp?.name ?? req.pathname,
    req.body,
    resolved.ctx,
    extras.deps,
  );

  if (!r.ok) {
    return { status: statusForErrorCode(r.error?.code), body: { error: r.error! } };
  }
  return { status: 200, body: { content: r.result?.content ?? [] } };
}

/* ─── Streaming variant (SSE) ────────────────────────────────────────── */

/**
 * Handle a streaming tool request — same flow as `handleHttpToolRequest`
 * but instead of returning a JSON body, emits Server-Sent Events:
 *
 *   event: progress
 *   data: { "progress": 50, "total": 100, "message": "..." }
 *
 *   event: result
 *   data: { "content": [...] }
 *
 *   event: error
 *   data: { "code": "...", "message": "..." }
 *
 * Caller wraps the returned `Response` in their framework's streaming
 * response (Next.js Response with ReadableStream, Hono c.body(stream),
 * etc.). The caller is responsible for setting Content-Type:
 * text/event-stream and the matching headers.
 *
 * Returns a ReadableStream<string> producing the SSE event text. The
 * stream emits at least one `result` or `error` event before closing.
 */
export function handleHttpToolRequestStreaming(
  req: HttpToolRequest,
  extras: HttpToolHostExtras,
): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      const enqueue = (event: string, data: unknown) => {
        controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const resolved = await resolveToolAndContext(req, extras);
      if (!resolved.ok) {
        const body = resolved.body as { error: { code: string; message: string } };
        enqueue('error', { code: body.error.code, message: body.error.message });
        controller.close();
        return;
      }

      // Override progress to fan SSE events to the client.
      resolved.ctx.progress = (pct, msg) => {
        try {
          enqueue('progress', {
            progress: typeof pct === 'number' ? pct : 0,
            total: 100,
            ...(msg ? { message: msg } : {}),
          });
        } catch { /* controller closed */ }
      };

      const r = await dispatchProjectedTool(
        resolved.tool,
        resolved.tool.expose.mcp?.name ?? req.pathname,
        req.body,
        resolved.ctx,
        extras.deps,
      );
      if (!r.ok) {
        enqueue('error', r.error!);
      } else {
        enqueue('result', { content: r.result?.content ?? [] });
      }
      controller.close();
    },
  });
}
