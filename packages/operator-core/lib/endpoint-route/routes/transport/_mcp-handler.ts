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
  applyToolManifest,
  papercuspGateBypass,
  sanitizeToolSchema,
  serializeToolResponse,
  formatOptsFromCtx,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import type { AgentRole } from '@papercusp/plugin-sdk';
// Generic MCP↔dispatcher bridge primitives (plan P-031). The auth/spawn-context
// assembly below stays host-side; only the reusable, host-agnostic glue moved.
import {
  bearerFromExtra,
  urlFromExtra,
  headersFromExtra,
  dispatchProjectedToolToMcp,
} from '@papercusp/tooldef-mcp';
import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { dispatchNeedsTx, effectiveDispatchWorkspace, synthesizeDispatchPrincipal } from './role-principal-caps';
import { runWithWorkspaceIfConcrete } from '../../../workspace-als';
import { isLoopbackRequest, isValidSuperuserBearer } from '../../../superuser-token';
import { workspaceForCoordOwner } from '../../../adv-sessions';
import { logVerificationFailure, verifySpawnParams } from '../../../spawn-signing';
import { verifyAccessToken } from '../../../power-user-token';
import {
  parseToolsAllowlist,
  filterListingsByAllowlist,
} from './tool-allowlist';
import { advertisedArgsSchema } from '@papercusp/result-encoding';
// Side-effect: register every operator-side first-party tool into the
// projected-tool registry. Required on dev (next dev compiles routes
// lazily — without this import, MCP requests would arrive before any
// other route has triggered the agent-tools/index side-effect load).
// On the standalone production build all routes are bundled together
// so this is a no-op there.
import '../../../agent-tools/index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ─── Helpers ────────────────────────────────────────────────────────── */
// `bearerFromExtra` / `urlFromExtra` / `headersFromExtra` are imported from
// `@papercusp/tooldef-mcp` (P-031) — generic mcp-handler `extra` extractors.

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
  /**
   * Plan-run conversation id, from `?plan_run=<uuid>` on the MCP URL.
   * Set by the plan-agent runner (plan-agent-launch-2026-05-21, P-011)
   * so `plans:*` write verbs attribute revisions to the launched run.
   * Null for every non-plan-run caller. Provenance label only.
   */
  planRunSessionId?: string | null;
  isSuperuser?: boolean;
  /**
   * True for the `workspace-power-user` tier (`?power_user=1`). These
   * calls run at the dispatch layer like superuser (`isSuperuser` is
   * also set) for the role-allowlist + capability bypass, but differ
   * in two ways: `workspaceId` is clamped to the verified token's
   * claim (never the URL), and the quota gate is NOT bypassed —
   * workspace quotas apply to power-users. See dispatch-stack.ts
   * quotaStep and the host quota policy (agent-mcp quota-policy.ts
   * papercuspComputeQuotaWindow, wired via PROJECTED_DEPS).
   */
  isPowerUser?: boolean;
  /**
   * Resolved caller profile — `'power'` for power-user tokens or SU
   * callers passing `?profile=power`; `'engineer'` otherwise.
   * Forwarded to `UnifiedToolContext.profile` for tool-list filtering
   * and call gating in the dispatcher.
   */
  profile?: 'engineer' | 'power';
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

  // Plan-run provenance (plan-agent-launch-2026-05-21, P-006). Folded
  // onto every built ctx below; the plan-agent runner (P-011) sets it,
  // it is null for all other callers. A provenance label for plan
  // revisions, never a gate — read anywhere is safe.
  const planRunSessionId = (url.searchParams.get('plan_run') ?? '').trim() || null;

  // ── (1) Superuser ───────────────────────────────────────────────
  if (url.searchParams.get('superuser') === '1') {
    const headers = headersFromExtra(extra);
    if (!isLoopbackRequest(headers)) return { kind: 'failed', reason: 'superuser_non_loopback' };
    const bearer = bearerFromExtra(extra);
    if (!isValidSuperuserBearer(bearer)) return { kind: 'failed', reason: 'superuser_invalid_bearer' };
    const wsParam = (url.searchParams.get('workspace') ?? '').trim();
    const harnessParam = (url.searchParams.get('harness') ?? '').trim();
    const clientParam = (url.searchParams.get('client') ?? '').trim();
    // Per-session identity for SU agents (su-locks coordination), sourced
    // in precedence order:
    //   1. `x-papercusp-client` header — the per-launch PAPERCUSP_SID.
    //      Claude/Codex bake the SID into `?client=` directly (they can
    //      env-interpolate the MCP url); OMP can't interpolate its url, but
    //      it DOES resolve header values at connect time, so its mcp.json
    //      carries `x-papercusp-client: !printf %s "$PAPERCUSP_SID"`
    //      (install-standalone-mcp.sh). This is the deliberate, stable
    //      per-launch owner — and it's the SAME PAPERCUSP_SID the OMP/cc
    //      lock hook reads, so a shell's interactive calls + its hook share
    //      one owner (no manual-claim-vs-hook self-deadlock). Header-first
    //      so it overrides OMP's static per-machine `?client=`.
    //   2. `Mcp-Session-Id` — the Streamable-HTTP transport's per-connection
    //      id, if the server assigned one. Kept as a fallback, but it is
    //      per-CONNECTION (interactive calls and the hook are separate
    //      connections → different ids → would re-introduce the self-
    //      deadlock), which is why the explicit SID header outranks it.
    //   3. `?client=` — the per-machine baked id; also what the channel
    //      hooks (one-shot POSTs, no MCP session) use to pass a per-session
    //      id directly.
    const headerClient = (headers.get('x-papercusp-client') ?? '').trim();
    const mcpSessionId = (headers.get('mcp-session-id') ?? '').trim();
    const suIdentity = headerClient || mcpSessionId || clientParam;
    // Workspace, in precedence order (psu-workspace-scoping fix — without
    // this, every claude/omp SU session ran as '*' and workspace-scoped
    // tools failed "no workspace transaction" regardless of the psu picker):
    //   1. `x-papercusp-workspace` header — OMP's per-launch carrier (it
    //      can't env-interpolate its mcp.json url; headers resolve at
    //      connect time via `!printf`).
    //   2. `?workspace=` URL param — claude's `${PAPERCUSP_WORKSPACE:-}`
    //      env-expanded user-level template, codex's baked per-session
    //      config, and the per-launch .mcp.json writers.
    //   3. The adv_sessions row recorded for this SID at launch — covers
    //      stale user-level configs and resumed sessions whose env lost
    //      PAPERCUSP_WORKSPACE. SID sources only (mcp-session-id is a
    //      transport id, never an adv row key).
    //   4. '*' — unscoped, exactly the pre-fix behavior.
    const headerWs = (headers.get('x-papercusp-workspace') ?? '').trim();
    let workspaceId = headerWs || wsParam;
    const sidForLookup = headerClient || clientParam;
    if (!workspaceId && sidForLookup) {
      workspaceId = (await workspaceForCoordOwner(sidForLookup)) ?? '';
    }
    // Profile: header (OMP) > URL param (claude env-expanded / install-baked).
    const headerProfile = (headers.get('x-papercusp-profile') ?? '').trim();
    const profileParam = headerProfile || url.searchParams.get('profile');
    const buf = new Uint8Array(8);
    globalThis.crypto.getRandomValues(buf);
    return {
      kind: 'ok',
      ctx: {
        workspaceId: workspaceId || '*',
        harnessSlug: harnessParam || '*',
        role: 'operator' as AgentRole,
        featureId: null,
        chunkId: null,
        // Per-request UUID, not the 'standalone' sentinel — see
        // http-projection.ts:~233 (audit5) for the cross-cancellation
        // hazard that the shared sentinel created.
        runId: globalThis.crypto.randomUUID(),
        spawnId: `ephemeral-${Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('')}`,
        parentSpawnId: null,
        uiClientId: suIdentity.length > 0 ? suIdentity : null,
        planRunSessionId,
        isSuperuser: true,
        // gateBypass is computed in buildMcpToolContext from isSuperuser/isPowerUser.
        // SU callers testing the power profile pass ?profile=power (or the
        // x-papercusp-profile header — psu's per-launch --profile carrier).
        profile: profileParam === 'power' ? 'power' : 'engineer',
      },
    };
  }

  // ── (1b) Power-user ─────────────────────────────────────────────
  // `?power_user=1` + loopback + valid HMAC access token. Unlike
  // superuser, the workspace is clamped to the token's claim — any
  // `?workspace=` in the URL is ignored. See power-user-token.ts and
  // docs/plans/omp-power-user-bundle-2026-05-20.md §4.1.
  if (url.searchParams.get('power_user') === '1') {
    const headers = headersFromExtra(extra);
    if (!isLoopbackRequest(headers)) {
      return { kind: 'failed', reason: 'power_user_non_loopback' };
    }
    const claims = await verifyAccessToken(bearerFromExtra(extra));
    if (!claims) {
      return { kind: 'failed', reason: 'power_user_invalid_token' };
    }
    const harnessParam = (url.searchParams.get('harness') ?? '').trim();
    const clientParam = (url.searchParams.get('client') ?? '').trim();
    // Same per-session source as the superuser path (highest precedence):
    // an OMP power-user launch carries its PAPERCUSP_SID via the
    // x-papercusp-client header (it can't interpolate the SID into the url).
    const headerClient = (headers.get('x-papercusp-client') ?? '').trim();
    const buf = new Uint8Array(8);
    globalThis.crypto.getRandomValues(buf);
    return {
      kind: 'ok',
      ctx: {
        // Clamp: workspace comes from the verified token, NOT the URL.
        workspaceId: claims.workspaceId,
        // Harness is within-workspace; resolveHarnessPaths resolves it
        // against the clamped workspace, so reading it from the URL
        // can't cross the workspace boundary.
        harnessSlug: harnessParam || '*',
        role: 'operator' as AgentRole,
        featureId: null,
        chunkId: null,
        runId: globalThis.crypto.randomUUID(),
        spawnId: `poweruser-${Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('')}`,
        parentSpawnId: null,
        // Coordination owner identity (file-locking #2). Default: the
        // token's auth_session_id — stable per power-user session. But
        // the OMP coord hook mints a per-PROCESS owner and passes it
        // via `?client=`; when present we honor it so per-process lock
        // identity is UNCONDITIONAL — not contingent on the bundle
        // token being minted fresh per OMP launch. `uiClientId` is the
        // coordination owner LABEL only (locks / presence / messages);
        // it is NOT a security boundary — the workspace clamp above
        // (from the verified token) is. So an explicit `?client=` is
        // safe to honor: it relabels the owner, it cannot escalate.
        uiClientId:
          headerClient || (clientParam.length > 0 ? clientParam : claims.authSessionId),
        planRunSessionId,
        // Dispatch-layer parity with superuser (operator-tier catalog
        // + synthesized system principal + workspace tx). The clamp
        // above is the security boundary that distinguishes the tiers.
        isSuperuser: true,
        isPowerUser: true,
        // gateBypass (role+cap, NOT quota for power-user) is computed in
        // buildMcpToolContext from isSuperuser/isPowerUser.
        // Power-user tokens always imply the power profile.
        profile: 'power',
      },
    };
  }

  // ── (2) / (3) Per-spawn URL — verify signature if present ───────
  const hasSig = url.searchParams.has('sig');
  const hasExp = url.searchParams.has('exp');
  const requireSig = process.env.PAPERCUSP_REQUIRE_SPAWN_SIG === '1';
  const headers = headersFromExtra(extra);
  // `headers` is a Headers — use .get() (case-insensitive). The old
  // pickHeader() took a plain record and bracket-indexed it; on a
  // Headers instance that silently returned undefined every time.
  const remoteAddr = headers.get('x-forwarded-for');
  const userAgent = headers.get('user-agent');

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
        planRunSessionId,
      },
    };
  } catch (err) {
    if (err instanceof InvalidRequestContextError) return { kind: 'none' };
    throw err;
  }
}

function builtinInputSchema(tool: ReturnType<typeof getCatalog>[number]): Record<string, unknown> {
  // Zod 4: use built-in z.toJSONSchema. The legacy `zod-to-json-schema`
  // package returns just `{ $schema }` against zod 4 schemas — produces
  // empty inputSchemas for every built-in.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (z as any).toJSONSchema(tool.args) as Record<string, unknown>;
  delete (json as Record<string, unknown>).$schema;
  // Registry write-positional tools advertise a single `row` string (P-008).
  const advertised = advertisedArgsSchema(tool.name, json);
  // Objectify boolean sub-schemas (z.unknown() → `true`) so strict consumers
  // (Ollama's Go tool-schema parser) accept the surface. See tool-schema-sanitize.ts.
  return sanitizeToolSchema(advertised);
}

/* ─── Resolved tool-context helpers ──────────────────────────────────── */

// Harness paths resolution is shared with the HTTP catch-all so both
// transports give plugin tools a populated ctx.projectDir.
import { resolveHarnessPaths as resolveHarnessPathsImpl } from '../../../resolve-harness-paths';

// Plugin spawn + secret impls are shared with the HTTP catch-all
// (apps/operator/app/api/plugins/[...path]/route.ts) so both transports
// see the same ctx.spawn / ctx.secret behavior.
import { pluginSpawnImpl, secretImpl, makeSecretResolver } from '../../../plugin-spawn-impl';

/* ─── Quota + invocation persistence ─────────────────────────────────── */
// PROJECTED_DEPS lives in @/lib/projected-tool-deps so the IPC server
// (and any future transport) can reuse the same telemetry + quota
// implementation. Don't fork the SQL across transports.
import { PROJECTED_DEPS } from '../../../projected-tool-deps';

/**
 * Build a full UnifiedToolContext for an MCP tool invocation. Combines:
 *   - spawn fields parsed from URL
 *   - per-call helpers (log, progress, spawn, secret)
 *   - resolved harness paths
 *   - per-call AbortSignal (dispatcher composes its own timeout signal)
 *   - progress wired to MCP `notifications/progress` when the calling
 *     client supplied a progressToken in `_meta`
 */
// Exported for tests; not part of the route's public surface.
// eslint-disable-next-line @typescript-eslint/naming-convention
export async function __buildMcpToolContext_forTests(
  ...args: Parameters<typeof buildMcpToolContext>
): Promise<UnifiedToolContext> {
  return buildMcpToolContext(...args);
}

async function buildMcpToolContext(
  spawn: BuiltSpawnContext,
  progressToken: string | number | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendNotification: ((notif: { method: string; params: Record<string, unknown> }) => Promise<void>) | undefined,
  // The projected tool's owning plugin (revive-plugin-system D-004). When the
  // call targets a real plugin tool, ctx.secret resolves through that plugin's
  // encrypted plugin_configs (then env); first-party tools ('agent-mcp') and
  // tool-less probes get the env-only resolver.
  pluginName?: string,
  // Client-negotiated result format (token-efficient-tool-result-formats P-009),
  // from `_meta.format` on the tools/call params or `?format=` on the MCP URL.
  // The result serializer reads it; absent ⇒ the MCP transport default (compact).
  requestedFormat?: string,
  // Opt-in for lossless `structuredContent` alongside the compact text (P-010),
  // from `_meta.structured` / `?structured=1`. OFF by default.
  requestedStructured?: boolean,
): Promise<UnifiedToolContext> {
  // Unscoped context: workspaceId/harnessSlug may be '*' — the superuser door,
  // or a WORKSPACE-LEVEL signed role session (operator/planner launched without
  // a harness, hive-agent-tabs P-003). Skip path resolution; per-tool fallbacks
  // ("workspace=/harness= arg required") will fire.
  const paths = (spawn.workspaceId === '*' || spawn.harnessSlug === '*')
    ? { projectDir: undefined as unknown as string, stateDir: undefined as unknown as string }
    : await resolveHarnessPathsImpl(spawn.harnessSlug, spawn.workspaceId);
  // Plugin handlers call ctx.emit / ctx.progress. When the MCP client
  // supplied a progressToken, fan each call to JSON-RPC notifications
  // over the agent's MCP session. Otherwise no-op (client opted out).
  //
  // emit('<name>', data) → notifications/papercusp/event with { event, data }
  //   (Papercusp-specific extension; standard MCP clients ignore unknown methods.)
  // emit('progress', payload) → ALSO fires notifications/progress
  //   (MCP-spec-compliant; built-in MCP UIs use this for progress bars.)
  //
  // ctx.progress(pct, msg) is a thin alias over emit('progress', { progress, total, message? }).
  const emit: UnifiedToolContext['emit'] =
    progressToken !== undefined && sendNotification
      ? (name, data) => {
          // JSON-RPC can't carry binary natively. Uint8Array would
          // JSON.stringify to {"0":...} (one numeric key per byte) —
          // corrupted on the wire. Match the HTTP transport's behavior:
          // base64-encode binary payloads. Structural check is cheap
          // and catches both schema-declared and schema-undeclared
          // binary emits.
          let wireData: unknown = data;
          if (data instanceof Uint8Array) {
            wireData = {
              $papercuspBinary: true,
              encoding: 'base64',
              data: Buffer.from(data).toString('base64'),
            };
          }
          // Papercusp extension notification — always fires.
          sendNotification({
            method: 'notifications/papercusp/event',
            params: { progressToken, event: name, data: wireData },
          }).catch((err) => {
            // eslint-disable-next-line no-console
            console.warn(`[mcp-tool] sendNotification(papercusp/event) failed: ${err instanceof Error ? err.message : String(err)}`);
          });
          // Spec-compliance: also fire the standard progress notification
          // for the 'progress' wire event so MCP-aware clients that only
          // know about notifications/progress still get a progress signal.
          if (name === 'progress' && data !== null && typeof data === 'object' && !(data instanceof Uint8Array)) {
            sendNotification({
              method: 'notifications/progress',
              params: { progressToken, ...(data as Record<string, unknown>) },
            }).catch((err) => {
              // eslint-disable-next-line no-console
              console.warn(`[mcp-tool] sendNotification(progress) failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        }
      : () => { /* streaming disabled by client (no progressToken) */ };
  const progress: UnifiedToolContext['progress'] = (pct, msg) => {
    emit('progress', {
      progress: typeof pct === 'number' ? pct : 0,
      total: 100,
      ...(msg ? { message: msg } : {}),
    });
  };
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
    planRunSessionId: spawn.planRunSessionId ?? null,
    isSuperuser: spawn.isSuperuser ?? false,
    isPowerUser: spawn.isPowerUser ?? false,
    gateBypass: papercuspGateBypass({
      isSuperuser: spawn.isSuperuser ?? false,
      isPowerUser: spawn.isPowerUser ?? false,
    }),
    profile: spawn.profile ?? 'engineer',
    requestedFormat,
    requestedStructured,
    log: (msg) => {
      // eslint-disable-next-line no-console
      console.log(`[mcp-tool][${spawn.harnessSlug}/${spawn.role}/${spawn.spawnId}] ${msg}`);
    },
    progress,
    emit,
    transport: 'mcp',
    spawn: pluginSpawnImpl,
    secret:
      pluginName && pluginName !== 'agent-mcp'
        ? makeSecretResolver({ harnessSlug: spawn.harnessSlug, pluginName })
        : secretImpl,
    signal: new AbortController().signal,
  };
}

/* ─── MCP handler ────────────────────────────────────────────────────── */

/**
 * Server capabilities declared in the MCP `initialize` response. Includes
 * the Papercusp typed-events extension so third-party MCP clients can
 * discover that this server emits `notifications/papercusp/event` frames
 * outside the JSON-RPC core spec.
 *
 * Exported for the regression test in `mcp-notifications.test.ts` —
 * inlining the object made the capability a string-grep target instead
 * of a unit-testable contract.
 */
export const MCP_SERVER_CAPABILITIES = {
  tools: {},
  resources: {},
  prompts: {},
  experimental: {
    'papercusp/typedEvents': { version: '1' },
  },
} as const;

/**
 * Static MCP `initialize.instructions` field — surfaced to LLM clients
 * (Claude Code, OMP) at session start as additional system-prompt
 * context.
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 1, P-003).
 *
 * Nudges agents toward the three-layer memory pattern. Per-session
 * dynamic injection (mem0 fan-out + coord backlog + insights index)
 * is deferred — the SDK Server doesn't expose a clean hook for
 * per-session instructions without overwriting the protocol-version
 * negotiation in _oninitialize. Static text lands the user-visible
 * behavior now; the dynamic enrichment ships later as a follow-up.
 *
 * Disabled via PAPERCUSP_SU_MEMORY_INJECTION=off when needed.
 */
const PAPERCUSP_MCP_INSTRUCTIONS = `At the start of any session-with-context (a user task you have not
seen this run), establish your three-layer memory state:

  1. **mem0 (what you know)** — call \`memory:search\` with the user's
     intent as the query. Pass \`harness_slug\` for project-specific
     facts. Each result carries \`id\` — remember it; if the user later
     contradicts something, call \`memory:forget\` on that id.

  2. **coord (what's happening)** — call \`coord:inbox\` for messages
     addressed to you and \`coord:plan-events\` for recent plan changes
     (use \`since_ts\` to get only deltas). Then call
     \`coord:declare-intent\` so peers see what you're working on.

  3. **insights (how things work)** — when you hit a confusing failure,
     \`docs:search\` the \`agent-insights/\` section before grepping
     code — many "weird bugs" already have a written runbook.

Memory writes belong in the right layer: stable facts → mem0,
in-flight state → coord, long-form runbooks → a new MDX in
\`apps/operator-docs/src/content/docs/agent-insights/\`. See the plan
\`papercusp-su-memory-2026-05-25\` for the full design.`;

function mcpInstructionsForServer(): string | undefined {
  if (process.env.PAPERCUSP_SU_MEMORY_INJECTION === 'off') return undefined;
  return PAPERCUSP_MCP_INSTRUCTIONS;
}

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
        const profile = spawnRes.kind === 'ok' ? spawnRes.ctx.profile : undefined;
        // Pin the exposed surface to the tool manifest (if configured) so the
        // catalog the SDK inlines is byte-stable across reconnects/reloads —
        // adding tools during development no longer busts a live session's
        // upstream prompt cache. `manifestBypass=1` returns the full set so the
        // snapshot generator can (re)write the manifest. See tool-manifest.ts.
        const bypass =
          urlFromExtra(extra)?.searchParams.get('manifestBypass') === '1';
        const result = applyToolManifest(listMcpProjections(role, profile), {
          bypass,
        });
        // Opt-in `?tools=a:b,c:d` allowlist (voice-persona P-009). When a
        // caller (operator:converse) names a small working set, serve ONLY
        // those tools — shrinking the operator's ~300-tool surface to ~50 so
        // the spawn's `ENABLE_TOOL_SEARCH=false` (disableToolSearch) can load
        // them DIRECTLY without flooding the prompt. Absent/empty `?tools=` →
        // no filtering; worker/scoper/probe spawns keep their full role
        // surface. Listing hint only — tools/call is unaffected. See
        // tool-allowlist.ts.
        const allow = parseToolsAllowlist(
          urlFromExtra(extra)?.searchParams.get('tools'),
        );
        const filtered = filterListingsByAllowlist(result, allow);
        // Objectify boolean sub-schemas (z.unknown() → `true`) so strict
        // consumers (Ollama) can parse the surface. This is THE tools/list
        // the HTTP MCP transport serves (OMP/Claude/Codex bundles); applied
        // post-manifest so pinned schemas are covered too. tool-schema-sanitize.ts.
        return {
          tools: filtered.map((t) => {
            const tt = t as { name?: string; inputSchema?: unknown; outputSchema?: unknown };
            const out: Record<string, unknown> = { ...t };
            if (tt.inputSchema) {
              // Registry write-positional tools advertise a single `row` string
              // (token-efficient-agent-io P-008) so the model emits a positional
              // row; every other tool advertises its real args schema. Applied
              // before sanitize so the swapped schema is objectified too.
              const advertised =
                typeof tt.name === 'string'
                  ? advertisedArgsSchema(tt.name, tt.inputSchema as Record<string, unknown>)
                  : (tt.inputSchema as Record<string, unknown>);
              out.inputSchema = sanitizeToolSchema(advertised);
            }
            // outputSchema (P-010) gets the same boolean-subschema objectification.
            if (tt.outputSchema) out.outputSchema = sanitizeToolSchema(tt.outputSchema);
            return out;
          }),
        };
      },
    );

    server.server.setRequestHandler(
      sdk.CallToolRequestSchema,
      async (
        req: {
          params: {
            name: string;
            arguments?: Record<string, unknown>;
            _meta?: { progressToken?: string | number; format?: string };
          };
        },
        extra: unknown,
      ) => {
        const toolName = req.params.name;
        const args = req.params.arguments ?? {};
        const progressToken = req.params._meta?.progressToken;
        // Result-format negotiation (P-009): per-call `_meta.format` wins over a
        // connection-level `?format=` on the MCP URL (how a client declares
        // compact/json once at setup). Absent ⇒ the transport default (compact).
        const requestedFormat =
          req.params._meta?.format ?? urlFromExtra(extra)?.searchParams.get('format') ?? undefined;
        const requestedStructured =
          (req.params._meta as { structured?: boolean } | undefined)?.structured === true ||
          urlFromExtra(extra)?.searchParams.get('structured') === '1';
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
          // Profile gate: power-profile callers cannot invoke Group A tools
          // even if they know the name. Mirrors the tools/list filter so
          // direct-name calls can't bypass the listing restriction.
          if (
            spawnRes.ctx.profile === 'power' &&
            projected.profile === 'engineer'
          ) {
            return {
              isError: true,
              content: [{
                type: 'text' as const,
                text: `tool_not_available_for_profile: "${toolName}" is not available in the power-engineer profile`,
              }],
            };
          }
          // Power-user workspace clamp (defense in depth). The ctx's
          // workspaceId is already token-clamped, so any tool reading
          // ctx.workspaceId is safe. But a handful of tools accept an
          // explicit `workspace` ARG used as a filter (audit 2026-05-20:
          // ui:list_clients is the only current one). For the
          // power-user tier we overwrite that arg with the clamped
          // workspace before the tool sees it — this defends every
          // tool, present and future, without a per-tool audit.
          const dispatchArgs =
            spawnRes.ctx.isPowerUser && args && typeof args === 'object' && 'workspace' in args
              ? { ...args, workspace: spawnRes.ctx.workspaceId }
              : args;
          // Superuser per-call workspace scoping (EI-30) — the inverse of the
          // power-user clamp. An unscoped superuser session (workspaceId '*')
          // that passes a concrete `workspace` arg dispatches under THAT
          // workspace (tx synthesis + ALS pin below), exactly as ?workspace=X
          // would have. See effectiveDispatchWorkspace for the rationale.
          const effectiveWs = effectiveDispatchWorkspace(spawnRes.ctx, dispatchArgs);
          const dispatchSpawnCtx =
            effectiveWs === spawnRes.ctx.workspaceId ? spawnRes.ctx : { ...spawnRes.ctx, workspaceId: effectiveWs };
          const baseCtx = await buildMcpToolContext(dispatchSpawnCtx, progressToken, sendNotification, projected.pluginName, requestedFormat, requestedStructured);
          // Legacy first-party tools (defineTool with default
          // requirePrincipal=true) hard-require ctx.principal + ctx.tx
          // in their projected wrapper (see registerLegacyAsProjected
          // in packages/agent-mcp/src/define-tool.ts:198). ANY concrete-
          // workspace call — ?superuser=1 OR a signed role-scoped agent —
          // synthesizes a principal + opens a workspace tx so those tools
          // run (a role-scoped caller is authenticated by its verified
          // signed URL). workspaceId='*' (no workspace chosen) still fails
          // those tools — caller must pass ?workspace=X.
          const needsTx = dispatchNeedsTx(dispatchSpawnCtx);
          // Generic projected-dispatch → MCP-result mapping (P-031,
          // @papercusp/tooldef-mcp). Same shape/behavior as before: success →
          // { content }, failure → { isError, content:["<code>: <message>"] }.
          // tooldef-mcp returns an SDK-neutral McpToolCallResult; cast it to the
          // mutable shape the MCP SDK's setRequestHandler accepts (same shape the
          // legacy branch below returns) at this host boundary.
          const runDispatch = (ctx: UnifiedToolContext) =>
            dispatchProjectedToolToMcp(projected, toolName, dispatchArgs, ctx, PROJECTED_DEPS) as Promise<{
              content: Array<{ type: 'text'; text: string } | Record<string, unknown>>;
              isError?: boolean;
              // Format tag + envelope (P-006) and lossless structuredContent (P-010)
              // — forwarded to the MCP SDK's tools/call result so clients see them.
              _meta?: Record<string, unknown>;
              structuredContent?: unknown;
            }>;
          // Establish the request-scoped workspace ALS for the duration of the
          // tool call (P-022) so handlers that resolve via `activeWorkspaceId()`
          // — harness resolution, not just the PG GUC `withWorkspace` sets — see
          // the CALLER's workspace, not the process-global `reg.current`. '*'
          // (superuser with no chosen workspace) stays unpinned.
          // P-062 — crossWorkspace tools span workspaces: hand them the admin
          // (rolbypassrls) handle, never a workspace-scoped harness_app tx, so
          // RLS never hides another workspace's rows. Mirrors the HTTP catchall's
          // chooseScopedHandle. Checked before needsTx so it also covers the
          // superuser/'*' discovery case (e.g. papercusp:list_workspaces). Tools
          // that read getOrgPg() directly are unaffected (they ignore ctx.tx).
          if (projected.crossWorkspace === true) {
            const { sql: adminTx } = getOrgPg();
            const ctx: UnifiedToolContext = {
              ...baseCtx,
              tx: adminTx,
              principal: await synthesizeDispatchPrincipal(adminTx, dispatchSpawnCtx),
            };
            return await runWithWorkspaceIfConcrete(dispatchSpawnCtx.workspaceId, () => runDispatch(ctx));
          }
          if (needsTx) {
            const ctxWs = dispatchSpawnCtx.workspaceId;
            return await runWithWorkspaceIfConcrete(ctxWs, () =>
              withWorkspace(ctxWs, async (tx) => {
                const ctx: UnifiedToolContext = {
                  ...baseCtx,
                  tx,
                  principal: await synthesizeDispatchPrincipal(tx, dispatchSpawnCtx),
                };
                return await runDispatch(ctx);
              }),
            );
          }
          return await runWithWorkspaceIfConcrete(dispatchSpawnCtx.workspaceId, () =>
            runDispatch(baseCtx),
          );
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
          // Format-aware serialization (P-005) — parity with the projected path.
          // This bearer-only legacy branch is still an MCP (agent) transport, so
          // it defaults to compact; honor `_meta.format`/`?format=` overrides.
          const serialized = serializeToolResponse(
            r.response!,
            formatOptsFromCtx({ requestedFormat, transport: 'mcp' }, lookupByMcpName(toolName)?.resultEligibility),
          );
          return {
            content: serialized.content,
            ...(Object.keys(serialized._meta).length > 0 ? { _meta: serialized._meta } : {}),
            ...(serialized.structuredContent !== undefined ? { structuredContent: serialized.structuredContent } : {}),
          };
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
  {
    capabilities: MCP_SERVER_CAPABILITIES,
    instructions: mcpInstructionsForServer(),
  },
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

export { handler as mcpHandler };
