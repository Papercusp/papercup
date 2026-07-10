/**
 * Explicit harness-scope resolution for harness-scoped tools.
 *
 * Background (su-prompt-audit-fixes / the all-sentinel design): harness-scoped
 * readers (`docs:*`, `plans:*`) used to SILENTLY fall back to Papercusp's own
 * docs/plans when no harness was in context — so a caller who simply forgot to
 * scope got the wrong data with no signal. We make "operate without a specific
 * harness" an EXPLICIT choice instead: a caller passes the `all` sentinel (or a
 * concrete slug) deliberately; omitting it at operator scope is an error.
 *
 * The crux is the `'*'` auto-default: `http-projection` sets
 * `ctx.harnessSlug = '*'` for every superuser/operator-scope call. That makes
 * "no harness picked" indistinguishable from "all" at the ctx level — so we
 * treat a bare ctx `'*'` (or unset) as **no explicit choice** (`'none'`), and
 * require the caller to pass `all`/`'*'` as an explicit ARG to opt into
 * operator/cross-harness scope. A session launched scoped to a real harness
 * (concrete `ctx.harnessSlug`) resolves to that harness with no arg needed.
 *
 * Pure + returning (no throw) so each tool maps the result onto its own error
 * shape — `docs:*` return `{ error: { code: 'harness_required' } }`; the plans
 * resolvers wrap this and throw `HarnessRequiredError` for the dispatcher.
 */

import { z } from 'zod';
import { HarnessRequiredError } from '@papercusp/agent-mcp';

/** Canonical "all harnesses / operator scope" sentinel. `'*'` can't collide
 *  with a real slug; `'all'` is an accepted friendly alias. */
export const HARNESS_ALL = '*';

/**
 * Reusable `harness` arg for harness-scoped tools — keeps the
 * description identical everywhere it's spread into an args schema
 * (`args: z.object({ harness: harnessArg, … })`).
 *
 * OPTIONAL at the schema level: harness-scoped sessions can omit it
 * (it's in ctx); operator-scoped calls must pass a concrete slug. The `all`
 * sentinel is available only to an unscoped (--all-workspaces) session.
 * The runtime check (harnessScopedCtx) enforces this and throws a proper
 * error message when a harness cannot be resolved.
 */
export const harnessArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Harness slug to operate on. In a workspace-scoped operator/superuser session, " +
      "pass the concrete in-scope harness slug (for example, 'papercusp' for " +
      "Papercusp's own plans). 'all' is only valid in an unscoped (--all-workspaces) " +
      "session. A harness-scoped session supplies this automatically.",
  );

/** True when a value is the explicit all/operator-scope sentinel. */
export function isAllHarnessSentinel(v: string | null | undefined): boolean {
  const s = v?.trim().toLowerCase();
  return s === '*' || s === 'all';
}

export type HarnessScope =
  | { kind: 'harness'; slug: string }
  | { kind: 'all' }
  | { kind: 'none' };

/**
 * Resolve harness scope from an explicit per-call `harness` arg + the session
 * ctx. Precedence:
 *   1. explicit arg `all`/`'*'`            → `{ kind: 'all' }`   (deliberate operator/cross scope)
 *   2. explicit arg concrete slug          → `{ kind: 'harness', slug }`
 *   3. no arg, concrete `ctx.harnessSlug`  → `{ kind: 'harness', slug }`   (scoped session)
 *   4. no arg, ctx `'*'`/`'all'`/unset     → `{ kind: 'none' }`   (caller must opt in)
 */
export function resolveHarnessScope(
  argHarness: string | null | undefined,
  ctx: { harnessSlug?: string | null } | null | undefined,
): HarnessScope {
  const arg = argHarness?.trim();
  if (arg) {
    return isAllHarnessSentinel(arg) ? { kind: 'all' } : { kind: 'harness', slug: arg };
  }
  const c = ctx?.harnessSlug?.trim();
  if (c && !isAllHarnessSentinel(c)) return { kind: 'harness', slug: c };
  return { kind: 'none' };
}

/** Shared detail string for the `harness_required` error every gated tool returns. */
export const HARNESS_REQUIRED_DETAIL =
  "No harness specified. `harness` is a per-call arg — pass it on THIS call " +
  "(you don't need a differently-scoped session): a concrete slug for that " +
  "harness, or `harness: 'all'` for operator / cross-harness scope (e.g. " +
  "Papercusp's own plans/docs). Writing a plan? Decide which project it's " +
  'about and pass that harness. (A harness-scoped session supplies this ' +
  'automatically.)';

/**
 * Bulk harness-scope resolution (bulk-endpoint-standardization-2026-06-21): the
 * harness_docs:* writers are bulk (single | items[]), each item with an OPTIONAL
 * per-item `harness` override over the batch `harness` default. Resolve every
 * item's effective scope here, and decide the ONE top-level gate: if NOT A SINGLE
 * item can resolve to a concrete harness (batch default is non-harness AND no item
 * overrides), the whole batch can't run → `gate:true` so the handler returns the
 * top-level `{ ok:false, error:'harness_required' }` (isError) — the same shape
 * the pre-bulk single tools returned, so the harness-scope-gate test holds. When
 * at least one item resolves, the batch runs and an item whose own scope is
 * non-harness becomes that item's `{ ok:false, error:'harness_required' }`.
 */
export function resolveBulkHarnessScopes<T extends { harness?: string }>(
  items: readonly T[],
  batchHarness: string | undefined,
  ctx: { harnessSlug?: string | null } | null | undefined,
): { gate: boolean; scopes: HarnessScope[] } {
  const scopes = items.map((it) => resolveHarnessScope(it.harness ?? batchHarness, ctx));
  const gate = scopes.length === 0 || scopes.every((s) => s.kind !== 'harness');
  return { gate, scopes };
}

/**
 * For tools that resolve their harness through a **ctx-taking** helper (the
 * `plans:*` resolvers `ctxToPlanSourceOpts` / `resolveCtxHarnessSlug`): apply
 * the per-call `harness` arg by returning a ctx whose `harnessSlug` is the
 * resolved scope, and **throw `HarnessRequiredError`** (→ dispatcher
 * `harness_required`) when none is resolvable.
 *
 * `'all'` maps to the `'*'` wildcard — which those resolvers already treat as
 * "operator scope" (Papercusp's own plans). A concrete slug passes through.
 * So the existing resolvers stay UNCHANGED; the gate lives here, in the
 * handler, exactly as the `docs:*` tools gate before `resolveAdapter`.
 */
export function harnessScopedCtx<T extends { harnessSlug?: string | null }>(
  argHarness: string | null | undefined,
  ctx: T,
): T & { harnessSlug: string } {
  const scope = resolveHarnessScope(argHarness, ctx);
  if (scope.kind === 'none') throw new HarnessRequiredError(HARNESS_REQUIRED_DETAIL);
  return { ...ctx, harnessSlug: scope.kind === 'all' ? HARNESS_ALL : scope.slug };
}

/**
 * Resolve a single CONCRETE harness slug for a tool that operates on exactly ONE
 * harness — routed through the fail-loud {@link resolveHarnessScope}. Returns the
 * slug, or `null` when no single harness is resolvable: a bare/unset ctx, the
 * operator/superuser `'*'` auto-default, OR an explicit `all`/`'*'` arg (a
 * cross-harness scope is meaningless for a single-harness op).
 *
 * This is the durable fix for the `args.x ?? ctx.harnessSlug ?? ''` band-aid
 * family (workspace-data-isolation-leaks-2026-06-17 P-004): a `?? ''` guarded by
 * `if (!slug)` — or a `truthy:` requires-precondition — rejects the empty string
 * but NOT the `'*'` wildcard, so under operator scope those tools silently
 * read/wrote a nonexistent `'*'` bucket (empty results / no-op success) instead
 * of failing. Callers turn a `null` into {@link harnessRequiredResult}.
 */
export function resolveConcreteHarnessSlug(
  argHarness: string | null | undefined,
  ctx: { harnessSlug?: string | null } | null | undefined,
): string | null {
  const scope = resolveHarnessScope(argHarness, ctx);
  return scope.kind === 'harness' ? scope.slug : null;
}

/**
 * The standard MCP `harness_required` error result a harness-scoped tool returns
 * when no concrete harness can be resolved (mirrors `docs:get`). Fail LOUD — the
 * caller gets a clear, actionable error instead of an empty/wrong-scope success.
 */
export function harnessRequiredResult(toolName?: string): {
  isError: true;
  content: { type: 'text'; text: string }[];
} {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: 'harness_required',
          ...(toolName ? { tool: toolName } : {}),
          detail: HARNESS_REQUIRED_DETAIL,
        }),
      },
    ],
  };
}
