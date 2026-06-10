/**
 * The route-stack — the dispatch pipeline for `defineTool` endpoints.
 *
 * Mirrors the Phase 3a tool dispatch-stack (`packages/agent-mcp/src/
 * dispatch-stack.ts`): named, ordered steps; a mutable per-call
 * execution object; an orchestrator that runs the steps and records
 * telemetry in `finally`. It does NOT reuse the tool stack's types —
 * `DispatchExecution` is tool-shaped (a `ProjectedTool`, `ctx.emit`, a
 * replay buffer). A route has none of those. So this is a parallel,
 * deliberately smaller stack: 3 steps, no role/quota/replay/streaming.
 *
 *   auth → input → invoke   (telemetry runs in finally)
 *
 * Plan: apps/operator/docs/plans/endpoint-route-migration-2026-05-20.md
 */

import type { Context } from 'hono';
import type { ZodTypeAny } from 'zod';
import type { Principal } from '@papercusp/agent-mcp';
import { PrincipalCheckError, requirePrincipal } from '../auth/require-principal';
import type { RouteDefinition } from './define-route';
import { recordRouteInvocation } from './telemetry';

/* ─── Step names ─────────────────────────────────────────────────────── */

export type RouteStepName = 'auth' | 'input' | 'invoke';

/* ─── Per-call mutable state ─────────────────────────────────────────── */

export interface RouteExecution {
  readonly def: RouteDefinition<ZodTypeAny | undefined>;
  /** The Hono context — the route-stack's only Hono coupling. */
  readonly hono: Context;
  /** Web-standard Request, lifted off the Hono context. */
  readonly req: Request;
  readonly startedAt: number;

  // ── written by 'auth' ──
  principal: Principal | null;
  // ── written by 'input' ──
  input: unknown;
  // ── written by the orchestrator ──
  abort: AbortController;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  /** Terminal status, for telemetry. */
  status: 'ok' | 'unauthorized' | 'forbidden' | 'invalid-input' | 'timeout' | 'error';
}

/* ─── Step contract ──────────────────────────────────────────────────── */

/**
 * A route step. Returns a `Response` to short-circuit (auth denied,
 * bad input, handler result) or `null` to continue. `invoke` is always
 * terminal — it returns the handler's `Response`.
 */
export interface RouteStep {
  name: RouteStepName;
  run(exec: RouteExecution): Promise<Response | null>;
}

/* ─── Error envelope ─────────────────────────────────────────────────── */

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/* ─── Steps ──────────────────────────────────────────────────────────── */

/**
 * The headers `requirePrincipal` resolves against. Normally the request's
 * own headers; when the route's `auth.tokenIn` admits `'query'` and no
 * `Authorization` header is present, the `?token=` query param is lifted
 * into a synthetic `Authorization: Bearer` so the standard bearer
 * resolvers see it unchanged. Opt-in per route — query tokens leak into
 * access logs (see `PrincipalRequirements.tokenIn`).
 */
function authHeaders(exec: RouteExecution): Headers {
  const auth = exec.def.auth;
  if (
    typeof auth === 'object' &&
    auth.tokenIn?.includes('query') &&
    !exec.req.headers.get('authorization')
  ) {
    const qToken = new URL(exec.req.url).searchParams.get('token');
    if (qToken) {
      const h = new Headers(exec.req.headers);
      h.set('authorization', `Bearer ${qToken}`);
      return h;
    }
  }
  return exec.req.headers;
}

const authStep: RouteStep = {
  name: 'auth',
  async run(exec) {
    if (exec.def.auth === 'public') {
      exec.principal = null;
      return null;
    }
    try {
      exec.principal = await requirePrincipal(authHeaders(exec), exec.def.auth);
      return null;
    } catch (err) {
      if (err instanceof PrincipalCheckError) {
        exec.status = err.status === 401 ? 'unauthorized' : 'forbidden';
        return errorResponse(err.status, err.status === 401 ? 'unauthorized' : 'forbidden', err.reason);
      }
      throw err;
    }
  },
};

const inputStep: RouteStep = {
  name: 'input',
  async run(exec) {
    const schema = exec.def.input;
    if (!schema) {
      exec.input = undefined;
      return null;
    }
    // POST/PUT/PATCH read the JSON body; GET/DELETE read the query string.
    let raw: unknown;
    const m = exec.def.method;
    if (m === 'POST' || m === 'PUT' || m === 'PATCH') {
      try {
        raw = await exec.req.clone().json();
      } catch {
        exec.status = 'invalid-input';
        return errorResponse(400, 'invalid_input', 'request body is not valid JSON');
      }
    } else {
      raw = Object.fromEntries(new URL(exec.req.url).searchParams);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      exec.status = 'invalid-input';
      return errorResponse(
        400,
        'invalid_input',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    exec.input = parsed.data;
    return null;
  },
};

const invokeStep: RouteStep = {
  name: 'invoke',
  async run(exec) {
    // `timeoutSec: null` = no watchdog — long-lived SSE/streaming routes
    // whose handler legitimately outlives any fixed budget (EI-110: the 30s
    // default turned healthy streams into 408s).
    const timeoutSec = exec.def.timeoutSec === null ? null : exec.def.timeoutSec ?? 30;
    if (timeoutSec !== null) {
      const timer = setTimeout(() => exec.abort.abort(), timeoutSec * 1000);
      if (typeof timer.unref === 'function') timer.unref();
      exec.timeoutTimer = timer;
    }

    try {
      const result = exec.def.handler(exec.req, {
        principal: exec.principal,
        input: exec.input,
        params: exec.hono.req.param() as Record<string, string>,
        log: (level, msg, meta) => {
          // R1: console. R2 routes this through the telemetry logger.
          const line = `[route ${exec.def.method} ${exec.def.path}] ${msg}`;
          if (level === 'error') console.error(line, meta ?? '');
          else if (level === 'warn') console.warn(line, meta ?? '');
          else console.log(line, meta ?? '');
        },
        signal: exec.abort.signal,
      });
      const response = await Promise.resolve(result);
      // ok-on-abort: the watchdog fired but the handler returned anyway.
      if (exec.abort.signal.aborted) {
        exec.status = 'timeout';
        return errorResponse(408, 'timeout', `route exceeded ${timeoutSec}s`);
      }
      exec.status = 'ok';
      return response;
    } catch (err) {
      if (exec.abort.signal.aborted) {
        exec.status = 'timeout';
        return errorResponse(408, 'timeout', `route exceeded ${timeoutSec}s`);
      }
      exec.status = 'error';
      return errorResponse(
        500,
        'handler_error',
        err instanceof Error ? err.message : String(err),
      );
    }
  },
};

/* ─── Default stack ──────────────────────────────────────────────────── */

/**
 * The route dispatch stack. Order is load-bearing: `auth` before
 * `input` (don't parse a body for a caller we'll reject), `input`
 * before `invoke`. Frozen — production callers don't mutate it.
 */
export const DEFAULT_ROUTE_STACK: ReadonlyArray<RouteStep> = Object.freeze([
  authStep,
  inputStep,
  invokeStep,
]);

/* ─── Orchestrator ───────────────────────────────────────────────────── */

/**
 * Run a route definition through the stack and return the `Response`.
 * Telemetry records in `finally` on every termination path. Never
 * throws — an unexpected error becomes a 500.
 */
export async function runRouteStack(
  def: RouteDefinition<ZodTypeAny | undefined>,
  hono: Context,
  stack: ReadonlyArray<RouteStep> = DEFAULT_ROUTE_STACK,
): Promise<Response> {
  const exec: RouteExecution = {
    def,
    hono,
    req: hono.req.raw,
    startedAt: Date.now(),
    principal: null,
    input: undefined,
    abort: new AbortController(),
    timeoutTimer: null,
    status: 'error',
  };
  let response: Response;
  try {
    let short: Response | null = null;
    for (const step of stack) {
      short = await step.run(exec);
      if (short) break;
    }
    // `invoke` is terminal — the loop always ends with a Response.
    response = short ?? errorResponse(500, 'handler_error', 'route stack produced no response');
  } catch (err) {
    exec.status = 'error';
    response = errorResponse(500, 'handler_error', err instanceof Error ? err.message : String(err));
  } finally {
    if (exec.timeoutTimer) clearTimeout(exec.timeoutTimer);
    try {
      recordRouteInvocation(exec);
    } catch {
      /* telemetry is best-effort */
    }
  }
  return response;
}
