/**
 * Unified dispatcher for projected tools.
 *
 * Both transports (MCP `tools/call` and HTTP catch-all) end up here.
 * Performs:
 *   1. Role allowlist check (when caller's role is known and the tool
 *      has a `roles` allowlist).
 *   2. Quota check — counts ok-status invocations of (workspace × tool ×
 *      role × window_key) against the manifest's rolesQuota limit.
 *   3. Input validation against `inputSchema` (best-effort — the
 *      transport may have already validated; this is a final defense).
 *   4. Per-tool timeout abort (default 60s, manifest-declared override).
 *   5. Function invocation with the unified context.
 *   6. Outcome recording — every call (ok / error / quota_exceeded /
 *      role_not_allowed / timeout) writes to tool_invocations.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */

import type { AgentRole, ToolResult } from '@papercusp/plugin-sdk';
import type { ProjectedTool, UnifiedToolContext } from './tool-projection';

/* ─── Quota window keying ────────────────────────────────────────────── */

/** Compute the quota window key from a context. */
export function computeProjectedQuotaWindowKey(ctx: UnifiedToolContext): string | null {
  if (ctx.role === 'worker') {
    if (!ctx.chunkId) return null;
    return `chunk:${ctx.chunkId}`;
  }
  if (!ctx.runId) return null;
  return `run:${ctx.runId}`;
}

/* ─── Dispatcher result ──────────────────────────────────────────────── */

export type DispatchProjectedErrorCode =
  | 'unknown_tool'
  | 'unauthorized'
  | 'role_not_allowed'
  | 'missing_capability'
  | 'quota_exceeded'
  | 'invalid_input'
  | 'handler_error'
  | 'timeout';

/**
 * Throw to signal that the request lacks the authentication the tool
 * requires (no principal, no workspace tx, etc). The dispatcher
 * surfaces this as `unauthorized` so HTTP transports return 401
 * instead of a generic 500.
 */
export class UnauthorizedToolError extends Error {
  override readonly name = 'UnauthorizedToolError';
}

export interface DispatchProjectedResult {
  ok: boolean;
  result?: ToolResult;
  error?: { code: DispatchProjectedErrorCode; message: string; meta?: Record<string, unknown> };
}

/* ─── Dispatch deps (DI surface) ─────────────────────────────────────── */

export interface DispatchProjectedDeps {
  /** Read current quota usage. Return null to disable quota enforcement. */
  readQuotaState?(
    toolName: string,
    ctx: UnifiedToolContext,
    windowKey: string,
  ): Promise<{ count: number } | null>;
  /** Persist a tool-invocation record. Best-effort. */
  recordInvocation?(input: {
    toolName: string;
    pluginName: string;
    ctx: UnifiedToolContext;
    windowKey: string;
    durationMs: number;
    status: 'ok' | 'error' | 'quota-exceeded' | 'role-not-allowed' | 'timeout' | 'invalid-input';
    outputRef?: string | null;
    outputSize?: number | null;
    errorMessage?: string | null;
  }): Promise<void>;
}

/* ─── Dispatcher ─────────────────────────────────────────────────────── */

export async function dispatchProjectedTool(
  tool: ProjectedTool,
  toolName: string,
  input: unknown,
  ctx: UnifiedToolContext,
  deps: DispatchProjectedDeps,
): Promise<DispatchProjectedResult> {
  const startedAt = Date.now();

  // 1. Role allowlist (only when both sides are known).
  if (tool.roles && ctx.role && !tool.roles.includes(ctx.role as AgentRole)) {
    if (deps.recordInvocation) {
      try {
        await deps.recordInvocation({
          toolName,
          pluginName: tool.pluginName,
          ctx,
          windowKey: computeProjectedQuotaWindowKey(ctx) ?? '',
          durationMs: Date.now() - startedAt,
          status: 'role-not-allowed',
          errorMessage: `role "${ctx.role}" not in allowlist`,
        });
      } catch { /* best-effort */ }
    }
    return {
      ok: false,
      error: {
        code: 'role_not_allowed',
        message: `Role "${ctx.role}" cannot call tool "${toolName}" (allowed roles: ${tool.roles.join(', ')})`,
      },
    };
  }

  // 1b. Capability check — only when a principal is attached (built-in
  // tools called via bearer auth). Plugin tools called via spawn URL
  // params don't have a principal; their gating happens via roles+quota
  // and the orchestrator's spawn-time guarantee that the URL is sealed.
  if (ctx.principal && tool.capabilities.length > 0) {
    for (const cap of tool.capabilities) {
      if (!ctx.principal.capabilities.has(cap)) {
        if (deps.recordInvocation) {
          try {
            await deps.recordInvocation({
              toolName,
              pluginName: tool.pluginName,
              ctx,
              windowKey: computeProjectedQuotaWindowKey(ctx) ?? '',
              durationMs: Date.now() - startedAt,
              status: 'role-not-allowed',
              errorMessage: `principal "${ctx.principal.slug}" lacks capability "${cap}"`,
            });
          } catch { /* best-effort */ }
        }
        return {
          ok: false,
          error: {
            code: 'missing_capability',
            message: `Principal "${ctx.principal.slug}" lacks capability "${cap}" (tool: ${toolName})`,
            meta: { tool: toolName, principal: ctx.principal.slug, missing: cap },
          },
        };
      }
    }
  }

  // 2. Quota.
  const windowKey = computeProjectedQuotaWindowKey(ctx);
  const role = ctx.role as AgentRole | undefined;
  const roleQuota = role && tool.rolesQuota?.[role];
  if (windowKey && role && roleQuota && deps.readQuotaState) {
    const limit = role === 'worker' ? roleQuota.perChunk : roleQuota.perRun;
    if (typeof limit === 'number' && limit > 0) {
      try {
        const state = await deps.readQuotaState(toolName, ctx, windowKey);
        if (state && state.count >= limit) {
          if (deps.recordInvocation) {
            try {
              await deps.recordInvocation({
                toolName,
                pluginName: tool.pluginName,
                ctx,
                windowKey,
                durationMs: Date.now() - startedAt,
                status: 'quota-exceeded',
                errorMessage: `quota ${state.count}/${limit} for role "${role}" in window "${windowKey}"`,
              });
            } catch { /* best-effort */ }
          }
          return {
            ok: false,
            error: {
              code: 'quota_exceeded',
              message: `Tool "${toolName}" exceeded ${role} quota (${state.count}/${limit}) in window "${windowKey}"`,
              meta: { tool: toolName, role, windowKey, used: state.count, limit },
            },
          };
        }
      } catch { /* fail-open on PG error */ }
    }
  }

  // 3. Per-tool timeout via AbortController. The ctx.signal we pass to
  //    the handler is from this controller; the handler can race against
  //    it (e.g. abort an HTTP fetch when timeout fires).
  const abort = new AbortController();
  const timeoutSec = tool.timeoutSec ?? 60;
  const timer = setTimeout(() => abort.abort(), timeoutSec * 1000);

  // Override ctx.signal with our timeout-bound one. The transport-supplied
  // signal (if any) is composed via addEventListener so caller-side aborts
  // still propagate.
  if (ctx.signal && !ctx.signal.aborted) {
    ctx.signal.addEventListener('abort', () => abort.abort(), { once: true });
  }
  const handlerCtx: UnifiedToolContext = { ...ctx, signal: abort.signal };

  try {
    const result = await tool.fn(input, handlerCtx);
    if (deps.recordInvocation && windowKey) {
      try {
        await deps.recordInvocation({
          toolName,
          pluginName: tool.pluginName,
          ctx,
          windowKey,
          durationMs: Date.now() - startedAt,
          status: 'ok',
          // Prefer the handler's explicit outputRef + outputSize when set
          // (large-output tools like repomix.pack write to scratch and
          // declare the path here). Fall back to inline content size.
          outputSize: result.outputSize ?? JSON.stringify(result.content).length,
          ...(result.outputRef ? { outputRef: result.outputRef } : {}),
        });
      } catch { /* best-effort */ }
    }
    return { ok: true, result };
  } catch (err) {
    const isTimeout = abort.signal.aborted;
    const status: 'timeout' | 'error' = isTimeout ? 'timeout' : 'error';
    if (deps.recordInvocation && windowKey) {
      try {
        await deps.recordInvocation({
          toolName,
          pluginName: tool.pluginName,
          ctx,
          windowKey,
          durationMs: Date.now() - startedAt,
          status,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      } catch { /* best-effort */ }
    }
    if (isTimeout) {
      return {
        ok: false,
        error: { code: 'timeout', message: `tool "${toolName}" exceeded timeout of ${timeoutSec}s` },
      };
    }
    if (err instanceof UnauthorizedToolError) {
      return {
        ok: false,
        error: { code: 'unauthorized', message: err.message },
      };
    }
    return {
      ok: false,
      error: { code: 'handler_error', message: err instanceof Error ? err.message : String(err) },
    };
  } finally {
    clearTimeout(timer);
  }
}
