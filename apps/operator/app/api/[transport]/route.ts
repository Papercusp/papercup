/**
 * HTTP/SSE MCP transport — exposes the @papercusp/agent-mcp catalog
 * (tools + resources + prompts) over HTTP so external MCP clients can
 * connect.
 *
 * Two parallel tool pipelines coexist on the same MCP endpoint:
 *
 *   1. Built-in tools — defined under `packages/agent-mcp/src/tools/`
 *      via `defineTool()` and registered into the agent-mcp legacy
 *      catalog. Auth: bearer header → Principal → existing dispatch().
 *      Migrated to the projected-tool registry in PR 0c.D.
 *
 *   2. Projected tools (PR 0c.A/B) — functions registered via
 *      registerProjectedTool() with manifest-declared expose.mcp.
 *      Auth: per-spawn URL query params (the seven from the
 *      orchestrator's per-spawn mcp.json). Routed via
 *      dispatchProjectedTool with role-allowlist and quota gates.
 *
 * Both pipelines share `tools/list` and `tools/call`; the dispatcher
 * routes by name (legacy catalog first, projected registry second).
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */

import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import {
  getCatalog,
  getPromptCatalog,
  getResourceCatalog,
  dispatch,
  getPrompt,
  listResources,
  readResource,
  parseRequestContext,
  InvalidRequestContextError,
  lookupByMcpName,
  listMcpProjections,
  dispatchProjectedTool,
  type DispatchProjectedDeps,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import type { AgentRole } from '@papercusp/plugin-sdk';
import { getOrgPg, withWorkspace } from '@restart/db-org';
import { isLoopbackRequest, isValidSuperuserBearer } from '@/lib/superuser-token';
import { logVerificationFailure, verifySpawnParams } from '@/lib/spawn-signing';
// Side-effect: register every operator-side first-party tool into the
// projected-tool registry. Required on dev (next dev compiles routes
// lazily — without this import, MCP requests would arrive before any
// other route has triggered the agent-tools/index side-effect load).
// On the standalone production build all routes are bundled together
// so this is a no-op there.
import '@/lib/agent-tools/index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ─── Helpers ────────────────────────────────────────────────────────── */

function bearerFromExtra(extra: unknown): string {
  const e = extra as { requestInfo?: { headers?: Record<string, string | string[] | undefined> } };
  const raw = e?.requestInfo?.headers?.authorization;
  const auth = Array.isArray(raw) ? raw[0] : raw;
  if (!auth) return '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : auth;
}

function urlFromExtra(extra: unknown): URL | null {
  const e = extra as { requestInfo?: { url?: string } };
  const raw = e?.requestInfo?.url;
  if (!raw) return null;
  try { return new URL(raw); } catch { return null; }
}

function headersFromExtra(extra: unknown): Headers {
  const raw = (extra as { requestInfo?: { headers?: Record<string, string | string[] | undefined> } })
    ?.requestInfo?.headers ?? {};
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    const flat = Array.isArray(v) ? v.join(', ') : v;
    if (typeof flat === 'string') h.set(k, flat);
  }
  return h;
}

/**
 * Parse the seven per-spawn URL params and return a partial
 * UnifiedToolContext fragment. Returns null if any required params are
 * missing — the caller falls back to built-in-only listing (e.g. dev
 * pings against /api/mcp without harness context).
 */
export interface BuiltSpawnContext {
  workspaceId: string;
  harnessSlug: string;
  role: AgentRole;
  featureId: string | null;
  chunkId: string | null;
  runId: string;
  spawnId: string;
  parentSpawnId: string | null;
  uiClientId: string | null;
  isSuperuser?: boolean;
}

/**
 * Outcome of building a spawn ctx from an inbound MCP request:
 *   - `none` — no URL params at all; legacy bearer dispatch may apply.
 *   - `ok` — verified (or superuser-bypassed) spawn ctx.
 *   - `failed` — URL claimed a spawn ctx but verification failed.
 *               Caller MUST reject (do NOT fall through to bearer).
 */
export type TrySpawnContextResult =
  | { kind: 'none' }
  | { kind: 'ok'; ctx: BuiltSpawnContext }
  | { kind: 'failed'; reason: string };

/**
 * Build the per-call spawn context from URL params + headers.
 *
 * Three entry shapes:
 *   1. `?superuser=1` + loopback + valid bearer → operator-tier ctx,
 *      no signature check (the bearer file IS the credential).
 *   2. Per-spawn URL with `harness=&workspace=&role=&run=&spawn=&exp=&sig=`
 *      — sig is verified via HMAC against the PG-stored signing key.
 *      Failures are logged to spawn_sig_verification_failures.
 *   3. Unsigned URL (no sig, no exp) — only honored when
 *      PAPERCUSP_REQUIRE_SPAWN_SIG != '1'. As of 2026-05-11 the
 *      operator runs with PAPERCUSP_REQUIRE_SPAWN_SIG=1 by default
 *      (apps/operator/.env.local), so unsigned URLs hard-reject and
 *      the soft-warn fallback below is dead code unless someone
 *      explicitly unsets the env var. Kept for the (uncommon) case
 *      of re-rolling out a new signing scheme.
 */
async function tryBuildSpawnContext(extra: unknown): Promise<TrySpawnContextResult> {
  const url = urlFromExtra(extra);
  if (!url) return { kind: 'none' };

  // ── (1) Superuser ───────────────────────────────────────────────
  if (url.searchParams.get('superuser') === '1') {
    const headers = headersFromExtra(extra);
    if (!isLoopbackRequest(headers)) return { kind: 'failed', reason: 'superuser_non_loopback' };
    const bearer = bearerFromExtra(extra);
    if (!isValidSuperuserBearer(bearer)) return { kind: 'failed', reason: 'superuser_invalid_bearer' };
    const wsParam = (url.searchParams.get('workspace') ?? '').trim();
    const harnessParam = (url.searchParams.get('harness') ?? '').trim();
    const clientParam = (url.searchParams.get('client') ?? '').trim();
    const buf = new Uint8Array(8);
    globalThis.crypto.getRandomValues(buf);
    return {
      kind: 'ok',
      ctx: {
        workspaceId: wsParam || '*',
        harnessSlug: harnessParam || '*',
        role: 'operator' as AgentRole,
        featureId: null,
        chunkId: null,
        runId: 'standalone',
        spawnId: `ephemeral-${Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('')}`,
        parentSpawnId: null,
        uiClientId: clientParam.length > 0 ? clientParam : null,
        isSuperuser: true,
      },
    };
  }

  // ── (2) / (3) Per-spawn URL — verify signature if present ───────
  const hasSig = url.searchParams.has('sig');
  const hasExp = url.searchParams.has('exp');
  const requireSig = process.env.PAPERCUSP_REQUIRE_SPAWN_SIG === '1';
  const headers = headersFromExtra(extra);
  const remoteAddr = pickHeader(headers, 'x-forwarded-for') ?? null;
  const userAgent = pickHeader(headers, 'user-agent') ?? null;

  // A URL "claims a spawn context" if it carries any of the load-bearing
  // params an attacker would need to escalate (role/spawn/workspace).
  // Bare /api/mcp with no params at all isn't trying to escalate
  // anything — it's a probe / health check / pre-spawn discovery — so
  // we shouldn't audit-log it as a sig-missing failure in strict mode.
  // (Calling tools/list on it returns an empty list per the handler
  // above; tools/call falls through to the "none" path which rejects
  // with invalid_request_context.)
  const claimsSpawn =
    url.searchParams.has('role') ||
    url.searchParams.has('spawn') ||
    url.searchParams.has('workspace');

  if (hasSig || hasExp) {
    const v = await verifySpawnParams(url);
    if (!v.ok) {
      await logVerificationFailure({
        reason: v.reason,
        claimedRole: url.searchParams.get('role'),
        claimedHarness: url.searchParams.get('harness'),
        claimedWorkspace: url.searchParams.get('workspace'),
        claimedSpawn: url.searchParams.get('spawn'),
        expClaim: hasExp ? Number(url.searchParams.get('exp')) : null,
        remoteAddr,
        userAgent,
      });
      // eslint-disable-next-line no-console
      console.warn(
        `[spawn-signing] rejected MCP request: ${v.reason} (role=${url.searchParams.get('role')}, ` +
          `harness=${url.searchParams.get('harness')}, spawn=${url.searchParams.get('spawn')})`,
      );
      return { kind: 'failed', reason: `spawn_sig_${v.reason}` };
    }
  } else if (requireSig && claimsSpawn) {
    await logVerificationFailure({
      reason: 'missing_sig_required_mode',
      claimedRole: url.searchParams.get('role'),
      claimedHarness: url.searchParams.get('harness'),
      claimedWorkspace: url.searchParams.get('workspace'),
      claimedSpawn: url.searchParams.get('spawn'),
      remoteAddr,
      userAgent,
    });
    return { kind: 'failed', reason: 'spawn_sig_missing_sig_required_mode' };
  } else {
    // Soft-warn period: allow unsigned URLs but log so we can see the
    // transition progress.
    if (url.searchParams.has('role') || url.searchParams.has('spawn')) {
      // eslint-disable-next-line no-console
      console.warn(
        '[spawn-signing] accepting UNSIGNED spawn URL (set PAPERCUSP_REQUIRE_SPAWN_SIG=1 to reject). ' +
          `role=${url.searchParams.get('role')} harness=${url.searchParams.get('harness')} ` +
          `spawn=${url.searchParams.get('spawn')}`,
      );
    }
  }

  try {
    const parsed = parseRequestContext(url);
    return {
      kind: 'ok',
      ctx: {
        workspaceId: parsed.workspaceId,
        harnessSlug: parsed.harnessSlug,
        role: parsed.role as AgentRole,
        featureId: parsed.featureId,
        chunkId: parsed.chunkId,
        runId: parsed.runId,
        spawnId: parsed.spawnId,
        parentSpawnId: parsed.parentSpawnId,
        uiClientId: parsed.uiClientId,
      },
    };
  } catch (err) {
    if (err instanceof InvalidRequestContextError) return { kind: 'none' };
    throw err;
  }
}

function pickHeader(
  headers: Record<string, string | string[] | undefined> | null,
  name: string,
): string | null {
  if (!headers) return null;
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function builtinInputSchema(tool: ReturnType<typeof getCatalog>[number]): Record<string, unknown> {
  // Zod 4: use built-in z.toJSONSchema. The legacy `zod-to-json-schema`
  // package returns just `{ $schema }` against zod 4 schemas — produces
  // empty inputSchemas for every built-in.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (z as any).toJSONSchema(tool.args) as Record<string, unknown>;
  delete (json as Record<string, unknown>).$schema;
  return json;
}

/* ─── Resolved tool-context helpers ──────────────────────────────────── */

// Harness paths resolution is shared with the HTTP catch-all so both
// transports give plugin tools a populated ctx.projectDir.
import { resolveHarnessPaths as resolveHarnessPathsImpl } from '@/lib/resolve-harness-paths';

// Plugin spawn + secret impls are shared with the HTTP catch-all
// (apps/operator/app/api/plugins/[...path]/route.ts) so both transports
// see the same ctx.spawn / ctx.secret behavior.
import { pluginSpawnImpl, secretImpl } from '@/lib/plugin-spawn-impl';

/* ─── Quota + invocation persistence ─────────────────────────────────── */

async function readQuotaStateImpl(
  toolName: string,
  ctx: UnifiedToolContext,
  windowKey: string,
): Promise<{ count: number } | null> {
  if (!ctx.workspaceId) return null;
  try {
    const { sql } = getOrgPg();
    const result = await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [ctx.workspaceId]);
      return await tx.unsafe(
        `SELECT count(*)::int AS n FROM harness_shared.tool_invocations
          WHERE workspace_id = $1
            AND tool_name = $2
            AND role = $3
            AND window_key = $4
            AND status = 'ok'`,
        [ctx.workspaceId, toolName, ctx.role ?? '', windowKey],
      );
    });
    const n = (result as Array<{ n: number }>)[0]?.n ?? 0;
    return { count: n };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[mcp-route] readQuotaState failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function recordInvocationImpl(input: {
  toolName: string;
  pluginName: string;
  ctx: UnifiedToolContext;
  windowKey: string;
  durationMs: number;
  status: 'ok' | 'error' | 'quota-exceeded' | 'role-not-allowed' | 'timeout' | 'invalid-input';
  outputRef?: string | null;
  outputSize?: number | null;
  errorMessage?: string | null;
}): Promise<void> {
  if (!input.ctx.workspaceId) return;
  try {
    const { sql } = getOrgPg();
    await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [input.ctx.workspaceId]);
      await tx.unsafe(
        `INSERT INTO harness_shared.tool_invocations
           (workspace_id, harness_slug, plugin_name, tool_name, role,
            feature_id, chunk_id, run_id, spawn_id, parent_spawn_id,
            window_key, duration_ms, status, output_ref, output_size, error_message, args_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
        [
          input.ctx.workspaceId,
          input.ctx.harnessSlug ?? '',
          input.pluginName,
          input.toolName,
          input.ctx.role ?? '',
          input.ctx.featureId ?? null,
          input.ctx.chunkId ?? null,
          input.ctx.runId ?? null,
          input.ctx.spawnId ?? '',
          input.ctx.parentSpawnId ?? null,
          input.windowKey,
          input.durationMs,
          input.status,
          input.outputRef ?? null,
          input.outputSize ?? null,
          input.errorMessage ?? null,
          (() => {
            if (input.args === undefined || input.args === null) return null;
            try {
              const s = JSON.stringify(input.args);
              if (s.length > 32768) {
                return JSON.stringify({ _truncated: true, _size: s.length });
              }
              return s;
            } catch {
              return null;
            }
          })(),
        ],
      );
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[mcp-route] recordInvocation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const PROJECTED_DEPS: DispatchProjectedDeps = {
  readQuotaState: readQuotaStateImpl,
  recordInvocation: recordInvocationImpl,
};

/**
 * Build a full UnifiedToolContext for an MCP tool invocation. Combines:
 *   - spawn fields parsed from URL
 *   - per-call helpers (log, progress, spawn, secret)
 *   - resolved harness paths
 *   - per-call AbortSignal (dispatcher composes its own timeout signal)
 *   - progress wired to MCP `notifications/progress` when the calling
 *     client supplied a progressToken in `_meta`
 */
async function buildMcpToolContext(
  spawn: BuiltSpawnContext,
  progressToken: string | number | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendNotification: ((notif: { method: string; params: Record<string, unknown> }) => Promise<void>) | undefined,
): Promise<UnifiedToolContext> {
  // Superuser context: workspaceId/harnessSlug may be '*'. Skip path
  // resolution; per-tool fallbacks ("workspace= arg required") will fire.
  const paths = (spawn.isSuperuser && (spawn.workspaceId === '*' || spawn.harnessSlug === '*'))
    ? { projectDir: undefined as unknown as string, stateDir: undefined as unknown as string }
    : await resolveHarnessPathsImpl(spawn.harnessSlug, spawn.workspaceId);
  // Plugin handlers call ctx.progress(pct, msg). When the MCP client
  // supplied a progressToken, fan each call to a notifications/progress
  // event keyed by that token. Otherwise no-op (client opted out).
  const progress: UnifiedToolContext['progress'] =
    progressToken !== undefined && sendNotification
      ? (pct, msg) => {
          sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: typeof pct === 'number' ? pct : 0,
              total: 100,
              ...(msg ? { message: msg } : {}),
            },
          }).catch((err) => {
            // eslint-disable-next-line no-console
            console.warn(`[mcp-tool] sendNotification failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      : () => { /* progress disabled by client */ };
  return {
    workspaceId: spawn.workspaceId,
    harnessSlug: spawn.harnessSlug,
    projectDir: paths.projectDir,
    stateDir: paths.stateDir,
    role: spawn.role,
    featureId: spawn.featureId,
    chunkId: spawn.chunkId,
    runId: spawn.runId,
    spawnId: spawn.spawnId,
    parentSpawnId: spawn.parentSpawnId,
    uiClientId: spawn.uiClientId,
    isSuperuser: spawn.isSuperuser ?? false,
    log: (msg) => {
      // eslint-disable-next-line no-console
      console.log(`[mcp-tool][${spawn.harnessSlug}/${spawn.role}/${spawn.spawnId}] ${msg}`);
    },
    progress,
    spawn: pluginSpawnImpl,
    secret: secretImpl,
    signal: new AbortController().signal,
  };
}

/* ─── MCP handler ────────────────────────────────────────────────────── */

const handler = createMcpHandler(
  (server) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@modelcontextprotocol/sdk/types.js');

    server.server.setRequestHandler(
      sdk.ListToolsRequestSchema,
      async (_req: unknown, extra: unknown) => {
        // The projected-tool registry mirrors every built-in (defineTool
        // auto-registers its result there) AND carries plugin-contributed
        // tools, so a single iteration covers both. Iterating getCatalog()
        // on top would emit each built-in twice.
        //
        // Strict mode (default since 2026-05-11): tools/list mirrors
        // tools/call — a failed spawn context returns an empty list.
        // Returning the full catalog to an unsigned/forged URL would:
        //   1. leak the tool surface to probing without an audit trail
        //      (tools/list failures aren't logged); and
        //   2. let `role=operator` in an unsigned URL surface the
        //      operator-tier catalog without role-allowlist filtering,
        //      because tryBuildSpawnContext returns kind=failed and
        //      role falls back to `undefined` (no filter applied).
        // Soft-warn behavior is preserved when kind='none' (no spawn
        // params at all — e.g. a bare /api/mcp probe).
        const spawnRes = await tryBuildSpawnContext(extra);
        if (spawnRes.kind === 'failed') {
          return { tools: [] };
        }
        const role = spawnRes.kind === 'ok' ? spawnRes.ctx.role : undefined;
        return { tools: listMcpProjections(role).map((t) => ({ ...t })) };
      },
    );

    server.server.setRequestHandler(
      sdk.CallToolRequestSchema,
      async (
        req: {
          params: {
            name: string;
            arguments?: Record<string, unknown>;
            _meta?: { progressToken?: string | number };
          };
        },
        extra: unknown,
      ) => {
        const toolName = req.params.name;
        const args = req.params.arguments ?? {};
        const progressToken = req.params._meta?.progressToken;
        // mcp-handler passes the protocol's RequestHandlerExtra here,
        // which exposes a sendNotification function bound to the right
        // session. Use it to fire notifications/progress events.
        const sendNotification = (extra as {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>;
        })?.sendNotification;

        // Dispatch priority:
        //   1. Projected dispatcher when a spawn ctx is present (per-spawn
        //      URL OR ?superuser=1 + bearer). This is the path that
        //      honors isSuperuser bypass + role allowlist + per-window
        //      quota. Every defineTool() entry is in the projected
        //      registry, so this covers all first-party tools too.
        //   2. Legacy bearer-only dispatch ONLY when no spawn ctx — e.g.
        //      in-process callers or one-off bearer-authed hits that
        //      don't supply URL params.
        //   3. Unknown.
        //
        // Prior to 2026-05-11 the order was reversed: the legacy bearer
        // dispatch ran first for anything in getCatalog(), which made
        // ?superuser=1 fail with `invalid_bearer` for ~24 first-party
        // tools (harness:*, tasks:*, messages:*, intel:*, features:*,
        // papercusp:list_workspaces, …) because the superuser token
        // isn't a registered principal. See docs/endpoint-system/
        // superuser-mode.mdx — the bypass logic lives in
        // dispatch-projected.ts, never in dispatch().
        const projected = lookupByMcpName(toolName);
        const spawnRes = await tryBuildSpawnContext(extra);

        // Hard-fail spawn ctx with invalid signature — do NOT fall through
        // to legacy bearer dispatch. That's the whole point of the
        // verification step.
        if (spawnRes.kind === 'failed') {
          return {
            isError: true,
            content: [{
              type: 'text' as const,
              text: `request_rejected: ${spawnRes.reason}`,
            }],
          };
        }

        if (projected && spawnRes.kind === 'ok') {
          const baseCtx = await buildMcpToolContext(spawnRes.ctx, progressToken, sendNotification);
          // Legacy first-party tools (defineTool with default
          // requirePrincipal=true) hard-require ctx.principal + ctx.tx
          // in their projected wrapper (see registerLegacyAsProjected
          // in packages/agent-mcp/src/define-tool.ts:198). For
          // ?superuser=1 calls with a concrete workspace, synthesize a
          // system principal and open a workspace tx so those tools
          // run. workspaceId='*' (no workspace chosen) still fails
          // those tools — caller must pass ?workspace=X.
          const needsTx =
            spawnRes.ctx.isSuperuser &&
            spawnRes.ctx.workspaceId &&
            spawnRes.ctx.workspaceId !== '*';
          const runDispatch = async (ctx: UnifiedToolContext) => {
            const r = await dispatchProjectedTool(projected, toolName, args, ctx, PROJECTED_DEPS);
            if (!r.ok) {
              return {
                isError: true,
                content: [{ type: 'text' as const, text: `${r.error?.code}: ${r.error?.message}` }],
              };
            }
            return { content: r.result!.content as never };
          };
          if (needsTx) {
            return await withWorkspace(spawnRes.ctx.workspaceId, async (tx) => {
              const ctx: UnifiedToolContext = {
                ...baseCtx,
                tx,
                principal: {
                  slug: 'system:operator',
                  workspaceId: spawnRes.ctx.workspaceId,
                  capabilities: new Set<string>(),
                },
              };
              return await runDispatch(ctx);
            });
          }
          return await runDispatch(baseCtx);
        }

        // Legacy bearer-only fallback (no spawn ctx supplied).
        const builtin = getCatalog().find((t) => t.name === toolName);
        if (builtin) {
          const bearer = bearerFromExtra(extra);
          const r = await dispatch({ toolName, args, bearer });
          if (!r.ok) {
            return {
              isError: true,
              content: [{ type: 'text' as const, text: `${r.error?.code}: ${r.error?.message}` }],
            };
          }
          const content: Array<Record<string, unknown>> = [
            { type: 'text' as const, text: JSON.stringify(r.response?.data ?? r.response) },
          ];
          if (Array.isArray(r.response?.uiResources)) {
            for (const ui of r.response.uiResources) {
              content.push(ui as unknown as Record<string, unknown>);
            }
          }
          return { content };
        }

        // Projected tool exists but caller didn't supply a spawn ctx —
        // tell them what's missing instead of falling through to 'unknown'.
        if (projected && spawnRes.kind === 'none') {
          return {
            isError: true,
            content: [{
              type: 'text' as const,
              text: 'invalid_request_context: projected tool calls require harness/workspace/role/run/spawn URL query params, or ?superuser=1 + bearer',
            }],
          };
        }

        return {
          isError: true,
          content: [{ type: 'text' as const, text: `unknown_tool: no tool named "${toolName}"` }],
        };
      },
    );

    // ── Resources ────────────────────────────────────────────────────
    server.server.setRequestHandler(
      sdk.ListResourcesRequestSchema,
      async (_req: unknown, extra: unknown) => {
        const bearer = bearerFromExtra(extra);
        const r = await listResources(bearer);
        return { resources: r.ok ? (r.resources ?? []) : [] };
      },
    );
    server.server.setRequestHandler(
      sdk.ReadResourceRequestSchema,
      async (req: { params: { uri: string } }, extra: unknown) => {
        const bearer = bearerFromExtra(extra);
        const r = await readResource({ uri: req.params.uri, bearer });
        if (!r.ok) throw new Error(`${r.error?.code}: ${r.error?.message}`);
        return { contents: [r.contents!] };
      },
    );

    // ── Prompts ─────────────────────────────────────────────────────
    server.server.setRequestHandler(
      sdk.ListPromptsRequestSchema,
      async (_req: unknown, extra: unknown) => {
        const bearer = bearerFromExtra(extra);
        if (!bearer) {
          return {
            prompts: getPromptCatalog()
              .filter((p) => !p.capability)
              .map((p) => ({ name: p.name, description: p.description, arguments: p.arguments })),
          };
        }
        const { listPrompts } = await import('@papercusp/agent-mcp');
        const r = await listPrompts(bearer);
        return { prompts: r.ok ? (r.prompts ?? []) : [] };
      },
    );
    server.server.setRequestHandler(
      sdk.GetPromptRequestSchema,
      async (
        req: { params: { name: string; arguments?: Record<string, string> } },
        extra: unknown,
      ) => {
        const bearer = bearerFromExtra(extra);
        const r = await getPrompt({
          name: req.params.name,
          args: (req.params.arguments ?? {}) as Record<string, string>,
          bearer,
        });
        if (!r.ok) throw new Error(`${r.error?.code}: ${r.error?.message}`);
        return { description: r.result!.description, messages: r.result!.messages };
      },
    );

    void getResourceCatalog;
  },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
  {
    basePath: '/api',
    maxDuration: 60,
    verboseLogs: process.env.NODE_ENV !== 'production',
    // mcp-handler defaults to enabling its SSE transport, which requires
    // Redis (REDIS_URL or KV_URL env) for cross-process pub/sub. We don't
    // run a Redis here in dev, so leaving SSE on means every SSE-bound
    // client triggers `Error: redisUrl is required` — which surfaces as
    // an unhandledRejection and (under recent Node defaults) eventually
    // takes the whole operator process down with rc=0 silently.
    // Streamable-HTTP transport doesn't need Redis; turn SSE off.
    disableSse: true,
  },
);

export { handler as GET, handler as POST, handler as DELETE };
