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
import { openBuffer as openReplayBuffer } from './replay-buffer';
import {
  cancelPendingCardsForRun,
  registerCard,
} from './card-correlator';
import { openRun, closeRun, setToolState } from './state-channel';
import type { CardResponse, CardSpec } from './types';
import type { ZodTypeAny } from 'zod';

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
    /**
     * Number of events the tool emitted via ctx.emit / ctx.progress
     * before completion. Used to size replay buffers from empirical
     * p99 (Phase 4 T2.2). 0 for non-streaming tools and tools that
     * never emit. Hosts persist into harness_shared.tool_invocations
     * .event_count (migration 066).
     */
    eventCount?: number;
    /**
     * Per-call structured metadata set by the handler via
     * ctx.metadata({...}). The dispatcher captures the last payload
     * before completion and passes it here. Hosts persist into
     * harness_shared.tool_invocations.metadata_json (migration 068).
     * Null when handler never called ctx.metadata.
     */
    metadataJson?: Record<string, unknown> | null;
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
  // T2.2 — events emitted via ctx.emit (declared here so gate-failure
  // paths can record it as 0 without forward-referencing). The
  // wrappedEmit defined later bumps it on every emit.
  let eventCount = 0;

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

          eventCount,
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

              eventCount,
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

                eventCount,
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

  // Phase 4 T2.2 — replay ring buffer. When a tool declares
  // `replayBufferSize > 0`, push every emit into a per-call buffer
  // keyed on (workspaceId, toolName, runId) so a reconnecting client
  // (with `Last-Event-ID` + `X-Papercusp-Run-Id` headers) can resume
  // mid-stream. Disabled by default (0/undefined) — non-streaming
  // tools and tools that don't care about resume pay no overhead.
  //
  // The dispatcher's monotonic counter mirrors the SSE sink's
  // id-allocator: each ctx.emit increments BOTH (the sink's
  // allocator runs in the wire layer; the dispatcher's runs here).
  // They stay in lockstep because ctx.emit is the only producer of
  // sink.event() calls during the stream — heartbeats and the
  // framework's auto-`done` use their own paths. eventCount is
  // declared at the top of this function so gate-failure paths
  // record it as 0 without a forward reference.
  // M5: state-shaped tools (those declaring `state` schema) skip the
  // ring buffer entirely. Their reconnect strategy is "latest snapshot,"
  // not "event history" — keeping a buffer would be dead weight.
  const replayCap = tool.state ? 0 : (tool.replayBufferSize ?? 0);
  const bufferWriter =
    replayCap > 0 && ctx.workspaceId && ctx.runId
      ? openReplayBuffer({
          workspaceId: ctx.workspaceId,
          toolName,
          runId: ctx.runId,
          capacity: replayCap,
          onEvict: (ev) => {
            // eslint-disable-next-line no-console
            console.warn(
              `[replay-buffer] ${toolName}/${ctx.runId}: evicted event id=${ev.id} name=${ev.name} (capacity ${replayCap})`,
            );
          },
        })
      : null;

  // Wrap ctx.emit so each emit refreshes the idle deadline (when on)
  // AND pushes into the replay buffer (when on). The wrapper is always
  // installed — both features are conditional inside.
  const wrappedEmit = (name: string, data: unknown): void => {
    if (idleSec > 0) lastEmitMs = Date.now();
    eventCount += 1;
    if (bufferWriter) bufferWriter.push({ id: eventCount, name, data });
    ctx.emit(name, data);
  };
  // Re-bind ctx.progress to the wrapped emit. The transport adapter's
  // progress is pre-built and closes over the UN-wrapped emit, which
  // means a tool calling ctx.progress exclusively (no direct ctx.emit)
  // would never refresh lastEmitMs OR land in the replay buffer.
  // This wrapper makes progress an alias of wrappedEmit per D2.
  const wrappedProgress = (pct: number | undefined, msg?: string): void => {
    wrappedEmit('progress', {
      progress: typeof pct === 'number' ? pct : 0,
      total: 100,
      ...(msg ? { message: msg } : {}),
    });
  };
  // ctx.askUser — installed when the call has both a workspace and a run
  // identity, which is what the card-correlator needs to scope cleanup.
  let askUser: UnifiedToolContext['askUser'] | undefined;
  if (ctx.workspaceId && ctx.runId) {
    const wsId = ctx.workspaceId;
    const runId = ctx.runId;
    openRun({ workspaceId: wsId, runId });
    askUser = async <TSchema extends ZodTypeAny>(
      spec: CardSpec<TSchema>,
    ): Promise<CardResponse<TSchema>> => {
      const { result } = registerCard({
        workspaceId: wsId,
        runId,
        spec,
      });
      // Race the response against the run's abort signal so a cancel/timeout
      // resolves with {action:'cancel'} without leaking the deferred.
      return await new Promise<CardResponse<TSchema>>((resolve) => {
        const onAbort = () => {
          abort.signal.removeEventListener('abort', onAbort);
          resolve({ action: 'cancel' } as CardResponse<TSchema>);
        };
        if (abort.signal.aborted) return onAbort();
        abort.signal.addEventListener('abort', onAbort);
        void result.then((r) => {
          abort.signal.removeEventListener('abort', onAbort);
          resolve(r);
        });
      });
    };
  }

  // ctx.publishState — installed when (a) the tool declared a state
  // schema and (b) ctx has a workspaceId + runId. State-shaped tools
  // get a state channel; tools without `state` see ctx.publishState
  // undefined and must use ctx.emit instead.
  let publishState: UnifiedToolContext['publishState'] | undefined;
  if (tool.state && ctx.workspaceId && ctx.runId) {
    const stateSchema = tool.state;
    const runIdLocal = ctx.runId;
    publishState = (snapshot: unknown) => {
      // v1: snapshot-only. JSON-Patch deltas (Array shape) deferred to v1.1.
      if (Array.isArray(snapshot)) {
        throw new Error(
          'ctx.publishState v1 is snapshot-only; pass a full state object, not a JSON-Patch array',
        );
      }
      const parsed = stateSchema.safeParse(snapshot);
      if (!parsed.success) {
        throw new Error(
          `ctx.publishState: snapshot does not match tool.state schema: ${parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        );
      }
      setToolState(runIdLocal, parsed.data);
    };
  }

  // Per-call metadata accumulator. The handler may call ctx.metadata
  // multiple times; we keep the most recent payload (overwrite, not
  // merge) and hand it to recordInvocation at completion. NULL when
  // the handler never called it.
  let metadataJson: Record<string, unknown> | null = null;
  const metadataCallback = (data: Record<string, unknown>): void => {
    metadataJson = { ...data };
  };

  const handlerCtx: UnifiedToolContext = {
    ...ctx,
    signal: abort.signal,
    emit: wrappedEmit,
    progress: wrappedProgress,
    metadata: metadataCallback,
    ...(askUser ? { askUser } : {}),
    ...(publishState ? { publishState } : {}),
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

            eventCount,
            metadataJson,
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
    // Phase 4 T2.3: when the handler declares outputRef, the
    // framework auto-emits a `chunk` event on the typed-event
    // channel so the consumer sees the resource link in-band with
    // the rest of the stream. `chunk` is reserved (registry rejects
    // tool-declared events: { chunk: ... }) so this only fires
    // here in the framework path.
    if (result.outputRef) {
      wrappedEmit('chunk', {
        ref: result.outputRef,
        ...(typeof result.outputSize === 'number' ? { byteSize: result.outputSize } : {}),
      });
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

          eventCount,
          metadataJson,
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

          eventCount,
          metadataJson,
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
    // Cancel any pending askUser cards for this run + close the
    // state-channel run entry (keeps the snapshot for 5min for late
    // reconnects, then GCs).
    if (ctx.runId) {
      cancelPendingCardsForRun(ctx.runId);
      closeRun(ctx.runId);
    }
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
