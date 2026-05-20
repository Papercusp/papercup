/**
 * `defineRoute` — the endpoint-system's second projection.
 *
 * `defineTool` projects a typed function onto the agent tool catalog
 * (MCP + HTTP). `defineRoute` projects an HTTP endpoint onto the Hono
 * app — with the same cross-cutting machinery (auth, timeout, telemetry,
 * uniform errors) — but deliberately NOT onto the tool catalog. A
 * `defineRoute` is plumbing: the browser, the desktop shell, an
 * orchestrator, or an external webhook calls it. An agent cannot.
 *
 * This is the primitive the route audit (route-audit-2026-05-20.md)
 * proved was missing: 229 of 243 endpoints are plumbing that must not
 * be tools but also must not stay unmanaged raw Next handlers once
 * Next.js is removed. `defineRoute` is their home.
 *
 * Plan: apps/operator/docs/plans/endpoint-route-migration-2026-05-20.md
 *
 * Shape: a route file declares one (or an array of) `defineRoute(...)`
 * and `export default`s it. The registry (`registry.ts`) collects them;
 * `registerAllRoutes(app)` mounts every one onto the Hono `app`. The
 * route is then served by the existing `[[...route]]` catch-all — the
 * same mechanism `_hono/oracle.ts` etc. already use in production.
 */

import type { Hono } from 'hono';
import type { ZodTypeAny, z } from 'zod';
import type { Principal } from '@papercusp/agent-mcp';
import type { PrincipalRequirements } from '@/lib/auth/require-principal';
import { runRouteStack } from './route-stack';

/* ─── Types ──────────────────────────────────────────────────────────── */

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

/**
 * Auth stance — REQUIRED on every route, no default (RFC Q3). The type
 * forces an explicit decision: a `PrincipalRequirements` object gates the
 * route through `requirePrincipal`; `'public'` opts out (webhooks,
 * OAuth callbacks, routes with their own in-handler auth). A forgotten
 * `auth` field is a compile error, never a silent fail-open or
 * fail-closed.
 */
export type RouteAuth = 'public' | PrincipalRequirements;

/**
 * Per-call context handed to a route handler. Host-neutral: `req` and the
 * return value are Web-standard `Request`/`Response`, never
 * `NextRequest`/`NextResponse`. `params` carries the path parameters
 * (`:slug`) that aren't in the `Request` URL.
 */
export interface RouteContext<TInput = undefined> {
  /** Resolved principal, or null when `auth: 'public'`. */
  principal: Principal | null;
  /** Parsed + validated input when an `input` schema was declared; else undefined. */
  input: TInput;
  /** Path parameters (`/harness/:slug` → `{ slug }`). */
  params: Record<string, string>;
  /** Telemetry-bound logger. */
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
  /** Abort signal — fires at `timeoutSec`. Handlers racing I/O should pass it through. */
  signal: AbortSignal;
}

export interface RouteDefinition<TInputSchema extends ZodTypeAny | undefined = undefined> {
  method: RouteMethod;
  /**
   * Hono path. The Hono app's `.basePath('/api')` is implicit, so
   * `'/desktop/version'` serves at `/api/desktop/version`. Dynamic
   * segments use Hono syntax: `:slug`, `:path{.+}` (NOT Next's
   * `[slug]` / `[...path]`).
   */
  path: string;
  /** Auth stance — required, see `RouteAuth`. */
  auth: RouteAuth;
  /**
   * Optional Zod input schema. POST/PUT/PATCH parse from the JSON body;
   * GET/DELETE parse from the query string. Absent → the handler gets
   * `ctx.input === undefined` and reads `req` directly (freeform routes:
   * file-serving, SSE, qr.svg).
   */
  input?: TInputSchema;
  /** Wall-clock timeout. Default 30s. A wedged handler aborts. */
  timeoutSec?: number;
  /**
   * Telemetry sample rate, 0..1. Default 1 (record every call). High-
   * frequency polled routes set this < 1 so `route_invocations` doesn't
   * flood. 0 = never record (pure transport routes).
   */
  sampleRate?: number;
  /** The handler. Web-standard in, Web-standard out. */
  handler: (
    req: Request,
    ctx: RouteContext<TInputSchema extends ZodTypeAny ? z.infer<TInputSchema> : undefined>,
  ) => Response | Promise<Response>;
}

/**
 * Declare a route. Pure — returns the definition; mounting happens via
 * `registerRoute` / `registerAllRoutes`. Generic over the input schema so
 * `ctx.input` is fully typed in the handler.
 */
export function defineRoute<TInputSchema extends ZodTypeAny | undefined = undefined>(
  def: RouteDefinition<TInputSchema>,
): RouteDefinition<TInputSchema> {
  return def;
}

/**
 * Mount one route definition onto a Hono app. The Hono handler runs the
 * route through the route-stack (`route-stack.ts`) — auth, input
 * validation, timeout, invoke, telemetry.
 */
export function registerRoute(app: Hono, def: RouteDefinition<ZodTypeAny | undefined>): void {
  app.on(def.method, def.path, (c) => runRouteStack(def, c));
}
