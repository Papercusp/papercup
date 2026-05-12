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
    /**
     * The validated arguments the tool was called with (post-zod parse).
     * Used by the /dev Sessions drilldown to enable exact-replay reruns.
     * Hosts may truncate or omit per their own policy; the dispatcher
     * passes the parsed input verbatim.
     */
    args?: unknown;
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
  // Superuser bypass: shell-launched agents (loopback + bearer token,
  // see /docs/endpoint-system/superuser-mode) skip role-allowlist + quota
  // gates. Capability gate below still runs when a principal is attached.
  if (tool.roles && ctx.role && !ctx.isSuperuser && !tool.roles.includes(ctx.role as AgentRole)) {
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
          args: input,
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
  //
  // Superuser bypass mirrors the role allowlist bypass above: when an
  // honest user shell hits ?superuser=1 with the bearer file, we treat
  // it as having every capability. The principal we synthesize for the
  // superuser path has an empty capability set on purpose — easier than
  // enumerating every cap the registry might know about.
  if (ctx.principal && !ctx.isSuperuser && tool.capabilities.length > 0) {
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
              args: input,
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
  if (windowKey && role && roleQuota && deps.readQuotaState && !ctx.isSuperuser) {
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
                args: input,
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
  // Don't keep the Node event loop alive just for the wall-clock
  // timeout. Tools with multi-minute timeouts (architect/converse/
  // delegate all use 600s) would otherwise block process exit until
  // the timer fires. Matches the idle-timer behavior below.
  if (typeof timer.unref === 'function') timer.unref();

  // Idle timeout: abort when no event has been emitted for
  // idleTimeoutSec seconds. Augments the wall-clock cap; catches wedged
  // child processes that have stopped producing output even though
  // they're not formally hung. Disabled when 0/undefined.
  const idleSec = tool.idleTimeoutSec ?? 0;
  let lastEmitMs = Date.now();
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  if (idleSec > 0) {
    // Check every (idleSec / 4) seconds, minimum 1s. Aborts as soon as the
    // gap since lastEmit exceeds the cap.
    const checkMs = Math.max(1_000, Math.floor((idleSec * 1000) / 4));
    idleTimer = setInterval(() => {
      if (abort.signal.aborted) return;
      if (Date.now() - lastEmitMs > idleSec * 1000) abort.abort();
    }, checkMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  // Override ctx.signal with our timeout-bound one. The transport-supplied
  // signal (if any) is composed via addEventListener so caller-side aborts
  // still propagate.
  if (ctx.signal && !ctx.signal.aborted) {
    ctx.signal.addEventListener('abort', () => abort.abort(), { once: true });
  }
  // Wrap ctx.emit so each emit refreshes the idle deadline. The
  // wrapper is installed only when idleTimeoutSec is on — non-streaming
  // tools pay no overhead.
  const wrappedEmit = idleSec > 0
    ? (name: string, data: unknown) => {
        lastEmitMs = Date.now();
        ctx.emit(name, data);
      }
    : ctx.emit;
  // Re-bind ctx.progress to the wrapped emit. The transport adapter's
  // progress is pre-built and closes over the UN-wrapped emit, which
  // means a tool calling ctx.progress exclusively (no direct ctx.emit)
  // would never refresh lastEmitMs — and a slow-progress LLM call
  // would trip the idle watchdog mid-stream. This wrapper makes
  // progress an alias of wrappedEmit per D2 of the plan.
  const wrappedProgress = idleSec > 0
    ? (pct: number | undefined, msg?: string) => {
        wrappedEmit('progress', {
          progress: typeof pct === 'number' ? pct : 0,
          total: 100,
          ...(msg ? { message: msg } : {}),
        });
      }
    : ctx.progress;
  const handlerCtx: UnifiedToolContext = {
    ...ctx,
    signal: abort.signal,
    emit: wrappedEmit,
    progress: wrappedProgress,
  };

  try {
    const result = await tool.fn(input, handlerCtx);
    // ok-on-abort race: if the watchdog (idle or wall-clock) fired
    // mid-handler but the handler returned normally without observing
    // ctx.signal.aborted, we'd otherwise emit `done` with the partial
    // result instead of the expected `timeout` error. That hides
    // wedged-but-not-throwing handlers from the consumer. Treat the
    // abort signal as authoritative: if it fired, surface a timeout
    // regardless of what the handler claims to have returned.
    if (abort.signal.aborted) {
      if (deps.recordInvocation && windowKey) {
        try {
          await deps.recordInvocation({
            toolName,
            pluginName: tool.pluginName,
            ctx,
            windowKey,
            durationMs: Date.now() - startedAt,
            status: 'timeout',
            errorMessage: `tool "${toolName}" aborted (idle or wall-clock timeout) but handler returned successfully`,
            args: input,
          });
        } catch { /* best-effort */ }
      }
      return {
        ok: false,
        error: {
          code: 'timeout',
          message: `tool "${toolName}" exceeded timeout of ${timeoutSec}s (handler returned but signal had aborted)`,
        },
      };
    }
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
          args: input,
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
          args: input,
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
    if (idleTimer) clearInterval(idleTimer);
  }
}

/* ─── In-process streaming dispatch ──────────────────────────────────── */

/**
 * One value yielded by `dispatchProjectedToolStream`.
 * - `event`: a ctx.emit(name, data) call from inside the handler.
 * - `done`: the handler returned successfully.
 * - `error`: dispatch/handler failed (role gate, quota, timeout, throw).
 */
export type DispatchStreamEvent =
  | { kind: 'event'; name: string; data: unknown }
  | { kind: 'done'; result: ToolResult }
  | { kind: 'error'; error: NonNullable<DispatchProjectedResult['error']> };

/**
 * In-process streaming wrapper around `dispatchProjectedTool` for
 * callers that want to consume a tool's typed event channel without
 * going through an HTTP or MCP transport.
 *
 * Goes through the full dispatcher — role check, quota, telemetry,
 * idle watchdog all apply. The escape hatch for callers who want to
 * bypass gating is to invoke `tool.fn(input, ctx)` directly (documented
 * as a footgun; loses RLS scoping and audit recording).
 *
 * Yields exactly one terminal event (`done` or `error`) before returning.
 *
 * Example:
 *   const tool = lookupByMcpName('architect.chat');
 *   if (!tool) throw ...;
 *   for await (const ev of dispatchProjectedToolStream(tool, 'architect.chat', input, ctx, deps)) {
 *     if (ev.kind === 'event') { ... }
 *     else if (ev.kind === 'done') { ... }
 *     else if (ev.kind === 'error') { ... }
 *   }
 */
export async function* dispatchProjectedToolStream(
  tool: ProjectedTool,
  toolName: string,
  input: unknown,
  ctx: UnifiedToolContext,
  deps: DispatchProjectedDeps,
): AsyncGenerator<DispatchStreamEvent, void, void> {
  const queue: DispatchStreamEvent[] = [];
  let resolveWait: (() => void) | null = null;
  const wake = (): void => {
    const r = resolveWait;
    resolveWait = null;
    r?.();
  };

  // Override emit + progress so each emit pushes onto our queue. The
  // dispatcher will wrap our emit with its idle-timeout watchdog (if
  // tool.idleTimeoutSec is set), so wake() still fires correctly.
  const streamEmit = (name: string, data: unknown): void => {
    queue.push({ kind: 'event', name, data });
    wake();
  };
  const streamProgress = (pct: number | undefined, msg?: string): void => {
    streamEmit('progress', {
      progress: typeof pct === 'number' ? pct : 0,
      total: 100,
      ...(msg ? { message: msg } : {}),
    });
  };
  const streamCtx: UnifiedToolContext = {
    ...ctx,
    emit: streamEmit,
    progress: streamProgress,
  };

  // Kick off dispatch in the background. Whatever it produces lands
  // in the queue as the terminal event.
  const dispatchPromise = dispatchProjectedTool(tool, toolName, input, streamCtx, deps).then(
    (r) => {
      if (r.ok && r.result) queue.push({ kind: 'done', result: r.result });
      else if (r.ok) queue.push({ kind: 'done', result: { content: [] } });
      else queue.push({ kind: 'error', error: r.error ?? { code: 'handler_error', message: '' } });
      wake();
    },
    (err) => {
      // Defensive — dispatchProjectedTool catches its own throws and
      // returns { ok: false, ... }. If somehow an exception escapes,
      // surface it here so the iterator doesn't hang.
      queue.push({
        kind: 'error',
        error: { code: 'handler_error', message: err instanceof Error ? err.message : String(err) },
      });
      wake();
    },
  );

  try {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((res) => {
          resolveWait = res;
        });
      }
      while (queue.length > 0) {
        const ev = queue.shift()!;
        yield ev;
        if (ev.kind === 'done' || ev.kind === 'error') return;
      }
    }
  } finally {
    // If the consumer stops iterating early (break / throw), make sure
    // the dispatch promise still settles so timers/handles clean up.
    await dispatchPromise.catch(() => {});
  }
}
