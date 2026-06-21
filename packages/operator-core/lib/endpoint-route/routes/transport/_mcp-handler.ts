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
  isSlashPromptName,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  dynamicSlashListings,
  resolveSlashToolForPrompt,
  slashToolVisibleTo,
  renderSlashPromptForTool,
  auditSlashPromptGet,
} from './_mcp-slash-prompts';
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
import {
  validIdempotencyKey,
  lookupStoredMcpResult,
  storeMcpResult,
  type StoredMcpResult,
} from './_mcp-result-replay';
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
 * scoped-superuser-workspace-clamp exemption (EI-1810). A `crossWorkspace: true`
 * tool normally bypasses the per-workspace tx (getOrgPg admin handle) so an
 * UNSCOPED superuser session can call it — which is exactly why the clamp denies
 * such tools from a SCOPED superuser session (they could read across workspaces).
 * These specific tools are the exception: they are crossWorkspace ONLY to support
 * the unscoped path, but when called from a SCOPED session they confine themselves
 * to the caller's OWN workspace (resolve ctx.principal.workspaceId) and are
 * read-only — so a scoped session calling them never reads another workspace.
 *
 * The exemption lives HERE, in the gate, not as a self-asserted per-tool flag: a
 * tool author must not be able to bypass workspace isolation by setting a boolean on
 * their own def — each entry is reviewed as part of this security boundary.
 *
 *   - autonomy:decide — a pure advisory gate (capability intel:read, never mutates)
 *     that resolves the caller's workspace and reads only THAT workspace's autonomy
 *     policy. The Overwatch role runs workspace-scoped and its prompt mandates this
 *     tool, so the clamp made it deterministically unusable for the role (EI-1810).
 */
const SCOPED_SAFE_CROSSWORKSPACE: ReadonlySet<string> = new Set(['autonomy:decide']);

/** Whether a crossWorkspace tool is safe to call from a SCOPED superuser session —
 *  it self-confines to the caller's own workspace and is read-only (EI-1810). */
function isScopedSafeCrossWorkspaceTool(toolName: string): boolean {
  return SCOPED_SAFE_CROSSWORKSPACE.has(toolName);
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
  /**
   * True when this ctx's spawn-URL HMAC was VERIFIED (branch 2 below) — never
   * set on the unsigned soft-warn path. resolveAgentIdentity's 'signed-spawn'
   * branch keys on it to attribute client=-less invoke-route agents to the
   * stable harness slug (promote-policy-and-waves-2026-05-30 D-002, owner
   * option (c): least privilege — no su/power grant, never spawnId/runId).
   */
  sigVerifiedSpawn?: boolean;
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
  profile?: 'engineer' | 'power' | 'generic';
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
    // scoped-superuser-workspace-clamp-2026-06-18 (P-006 / D-004), flag-gated:
    // safe-by-default. When the clamp flag is ON, a superuser session must resolve
    // to a CONCRETE workspace (which the existing effectiveDispatchWorkspace then
    // confines — a concrete workspaceId ignores any per-call `workspace` arg) OR
    // explicitly opt into unscoped god-mode. An UNRESOLVED workspace no longer
    // SILENTLY becomes '*' (the root of the demonstrated cross-workspace reach) —
    // it is rejected, so psu passes a workspace, or opts in via ?workspace=* /
    // ?all_workspaces=1 for deliberate cross-workspace admin. Flag OFF → unchanged
    // (the `workspaceId || '*'` fallback below), byte-identical.
    if (await getFlag(FLAGS.SCOPED_SUPERUSER_CLAMP, 'system')) {
      const optedUnscoped =
        workspaceId === '*' || url.searchParams.get('all_workspaces') === '1';
      if (!workspaceId && !optedUnscoped) {
        return { kind: 'failed', reason: 'scoped_superuser_workspace_unresolved' };
      }
    }
    // Profile: header (OMP) > URL param (claude env-expanded / install-baked).
    const headerProfile = (headers.get('x-papercusp-profile') ?? '').trim();
    const profileParam = headerProfile || url.searchParams.get('profile');
    // Role: an OPTIONAL catalog-narrowing param (token-usage-reduction P-011).
    // An operator-initiated SU-bearer spawn (writeSignedSpawnMcp branch 1)
    // carries the spawned agent's actual role here so tools/list advertises
    // that role's catalog instead of the full operator-tier surface (392
    // tools / ~291KB) — dispatch capability is unchanged (isSuperuser still
    // bypasses role gates), only the ADVERTISED surface narrows. Absent →
    // 'operator', the historical psu behavior.
    const roleParam = (url.searchParams.get('role') ?? '').trim();
    const buf = new Uint8Array(8);
    globalThis.crypto.getRandomValues(buf);
    return {
      kind: 'ok',
      ctx: {
        workspaceId: workspaceId || '*',
        harnessSlug: harnessParam || '*',
        role: (roleParam || 'operator') as AgentRole,
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

  let sigVerified = false;
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
    sigVerified = true;
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
        sigVerifiedSpawn: sigVerified,
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
    sigVerifiedSpawn: spawn.sigVerifiedSpawn ?? false,
    planRunSessionId: spawn.planRunSessionId ?? null,
    isSuperuser: spawn.isSuperuser ?? false,
    isPowerUser: spawn.isPowerUser ?? false,
    gateBypass: papercuspGateBypass({
      isSuperuser: spawn.isSuperuser ?? false,
      isPowerUser: spawn.isPowerUser ?? false,
      // EI-2048: testing-phase full tool access for trusted roles (queen/bee/
      // overwatch/sentinel/scout/operator) — they get the same role+capability
      // bypass as superuser so a missing grant can't masquerade as another bug.
      role: spawn.role,
    }),
    // Tool-list filtering only distinguishes power-vs-not (slashToolVisibleTo:
    // `profile === 'power'`), so the GENERIC profile (domain-generic-hive P-025) maps to
    // engineer-like visibility here — its DISTINCT behavior (no papercup CLAUDE.md splice)
    // lives in the playbook path (role-launch-spec), not tool gating. Coerce so the
    // narrow UnifiedToolContext.profile never has to carry 'generic'.
    profile: spawn.profile === 'generic' ? 'engineer' : (spawn.profile ?? 'engineer'),
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
seen this run), bootstrap in ONE call:

  **\`coord:orient { intent }\`** — pass your one-line intent for the
  task. In a SINGLE round-trip it returns your current assignments
  (+ lane + load), the claimable backlog, your unread inbox summary,
  the recent plan-events delta, AND a mem0 recall for \`intent\` — and
  it DECLARES \`intent\` to peers so they see what you're working on.
  This replaces the old four-call ritual (memory:search + coord:inbox +
  coord:plan-events + coord:declare-intent); reach for those individually
  only for detail orient deliberately bounds.

  - **Claim your lane.** When the work is plan items, pass them:
    \`coord:orient { intent, planSlug, planItems: ['P-001', …] }\` CLAIMS
    those items for you (and releases ones you've moved off). An unclaimed
    lane is invisible to the Queen and peers, so work gets double-placed.
    (Flipping an item \`wip\` via \`plans:set-status\` also auto-claims;
    \`done\` releases. A \`claim_conflict\` means a live peer holds it —
    coordinate with the holder, don't take it.)
  - **mem0 (what you know).** orient's recall uses \`intent\` as the query;
    pass \`harness\` for project-specific facts. Each mem0 hit carries an
    \`id\` — if the user later contradicts something, \`memory:forget\`
    that id. Use \`memoryQuery\` for a different query, or call
    \`memory:search\` directly.
  - **insights (how things work).** When you hit a confusing failure,
    \`docs:search\` the \`agent-insights/\` section before grepping code —
    many "weird bugs" already have a written runbook.

Memory writes belong in the right layer: stable facts → mem0
(\`memory:remember\`), in-flight state → coord, long-form runbooks → a new
MDX in \`apps/operator-docs/src/content/docs/agent-insights/\`. See the
plans \`papercusp-su-memory-2026-05-25\` and
\`tool-call-batching-wrappers-2026-06-21\`.`;

function mcpInstructionsForServer(): string | undefined {
  if (process.env.PAPERCUSP_SU_MEMORY_INJECTION === 'off') return undefined;
  return PAPERCUSP_MCP_INSTRUCTIONS;
}

/**
 * Resolve the MCP tool listings visible to THIS session — the single walk
 * shared by `tools/list` and the dynamic slash projection on `prompts/list`,
 * so the slash surface mirrors the tool surface by construction
 * (slash-exposure-tool-catalog-2026-06-12 P-004).
 *
 * Strict mode (default since 2026-05-11): listings mirror tools/call — a
 * FAILED spawn context yields nothing. Returning the full catalog to an
 * unsigned/forged URL would:
 *   1. leak the tool surface to probing without an audit trail
 *      (tools/list failures aren't logged); and
 *   2. let `role=operator` in an unsigned URL surface the operator-tier
 *      catalog without role-allowlist filtering, because
 *      tryBuildSpawnContext returns kind=failed and role falls back to
 *      `undefined` (no filter applied).
 * Soft-warn behavior is preserved when kind='none' (no spawn params at
 * all — e.g. a bare /api/mcp probe).
 *
 * Listing shape notes carried from the original tools/list body:
 *   - The projected-tool registry mirrors every built-in (defineTool
 *     auto-registers there) AND carries plugin tools — one iteration
 *     covers both; iterating getCatalog() on top would double-emit.
 *   - `applyToolManifest` pins the surface to the tool manifest (if
 *     configured) so the catalog the SDK inlines is byte-stable across
 *     reconnects/reloads; `manifestBypass=1` returns the full set so the
 *     snapshot generator can (re)write the manifest. See tool-manifest.ts.
 *   - `?tools=a:b,c:d` (voice-persona P-009) is an opt-in listing
 *     allowlist — a caller naming a small working set sees ONLY those
 *     tools. Listing hint only; tools/call is unaffected. tool-allowlist.ts.
 */
async function resolveVisibleToolListings(extra: unknown): Promise<
  | { kind: 'failed' }
  | {
      kind: 'ok' | 'none';
      spawnRes: TrySpawnContextResult;
      listings: ReturnType<typeof listMcpProjections>;
    }
> {
  const spawnRes = await tryBuildSpawnContext(extra);
  if (spawnRes.kind === 'failed') return { kind: 'failed' };
  const role = spawnRes.kind === 'ok' ? spawnRes.ctx.role : undefined;
  const rawProfile = spawnRes.kind === 'ok' ? spawnRes.ctx.profile : undefined;
  // GENERIC profile (P-025) → engineer-like tool visibility (the manifest filter only gates
  // power); coerce so the narrow listMcpProjections param need not carry 'generic'.
  const profile = rawProfile === 'generic' ? 'engineer' : rawProfile;
  const bypass = urlFromExtra(extra)?.searchParams.get('manifestBypass') === '1';
  const result = applyToolManifest(listMcpProjections(role, profile), { bypass });
  const allow = parseToolsAllowlist(urlFromExtra(extra)?.searchParams.get('tools'));
  return {
    kind: spawnRes.kind,
    spawnRes,
    listings: filterListingsByAllowlist(result, allow),
  };
}

/**
 * prompts/get for the dynamic `tool:*` namespace (slash-exposure P-005):
 * resolve the slash-exposed tool, re-check session visibility with the SAME
 * predicates listMcpProjections applies, render the invoke-with-elicitation
 * instruction, and record slash-origin telemetry. Context requirements
 * mirror tools/call: a failed spawn ctx is rejected, and a bare probe with
 * no spawn params gets invalid_request_context. Mechanics live in
 * `_mcp-slash-prompts.ts` (testable without an HTTP harness).
 */
async function getSlashPrompt(
  promptName: string,
  args: Record<string, string>,
  extra: unknown,
): Promise<{ description?: string; messages: unknown[] }> {
  const spawnRes = await tryBuildSpawnContext(extra);
  if (spawnRes.kind === 'failed') {
    throw new Error(`request_rejected: ${spawnRes.reason}`);
  }
  if (spawnRes.kind === 'none') {
    throw new Error(
      'invalid_request_context: slash prompts require harness/workspace/role/run/spawn URL query params, or ?superuser=1 + bearer',
    );
  }
  const tool = resolveSlashToolForPrompt(promptName);
  if (!tool || !slashToolVisibleTo(tool, spawnRes.ctx.role, spawnRes.ctx.profile)) {
    throw new Error(`unknown_prompt: no slash-exposed tool for "${promptName}" in this session`);
  }
  const rendered = renderSlashPromptForTool(tool, args);
  void auditSlashPromptGet(spawnRes.ctx, tool.expose.mcp!.name, Object.keys(args));
  return { description: rendered.description, messages: rendered.messages };
}

const handler = createMcpHandler(
  (server) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@modelcontextprotocol/sdk/types.js');

    server.server.setRequestHandler(
      sdk.ListToolsRequestSchema,
      async (_req: unknown, extra: unknown) => {
        // Shared visibility walk — see resolveVisibleToolListings above
        // (strict-mode + manifest + allowlist semantics documented there).
        const vis = await resolveVisibleToolListings(extra);
        if (vis.kind === 'failed') {
          return { tools: [] };
        }
        const filtered = vis.listings;
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
            _meta?: { progressToken?: string | number; format?: string; idempotencyKey?: string };
          };
        },
        extra: unknown,
      ) => {
        const toolName = req.params.name;
        const args = req.params.arguments ?? {};
        const progressToken = req.params._meta?.progressToken;
        // Write idempotency / result replay (audit P-046 / EI-68): a caller
        // that passes `_meta.idempotencyKey` gets its result persisted under
        // that key; re-calling with the SAME key replays the stored outcome
        // instead of re-executing — so a write whose response died on a
        // dropped connection is recoverable, not re-fired. Opt-in per call.
        const idempotencyKey = validIdempotencyKey(req.params._meta?.idempotencyKey);
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
          // scoped-superuser-workspace-clamp (P-006/P-007), flag-gated. A SCOPED
          // superuser session (concrete workspaceId, not '*') is confined to its
          // workspace: (a) a crossWorkspace tool — which bypasses the workspace tx
          // (getOrgPg) and spans workspaces by design (see the P-062 admin-ctx
          // branch below) — is DENIED, UNLESS it is on the scoped-safe allowlist
          // (self-confines to the caller's own workspace + read-only; EI-1810);
          // (b) its per-call `workspace` arg is overwritten with the clamped
          // workspace (mirrors the power-user clamp). Only an UNSCOPED ('*')
          // superuser may span. Flag OFF → no-op.
          const scopedSuperuserClamp =
            spawnRes.ctx.isSuperuser === true &&
            spawnRes.ctx.workspaceId !== '*' &&
            (await getFlag(FLAGS.SCOPED_SUPERUSER_CLAMP, 'system'));
          if (
            scopedSuperuserClamp &&
            projected.crossWorkspace === true &&
            !isScopedSafeCrossWorkspaceTool(toolName)
          ) {
            return {
              isError: true,
              content: [{
                type: 'text' as const,
                text: `workspace_forbidden: "${toolName}" spans workspaces, but this session is scoped to workspace "${spawnRes.ctx.workspaceId}". Use an unscoped (--all-workspaces) superuser session to span workspaces.`,
              }],
            };
          }
          // scoped-superuser-workspace-clamp (P-008, security half): a scoped session
          // may NOT use the harness:'all'/'*' GLOBAL escape — resolvePlanScope maps it
          // to PAPERCUSP_WORKSPACE_ID/papercup, a cross-scope read. Reject it; the
          // session names a concrete harness in scope. (The nicer "re-resolve 'all' to
          // the active workspace's plans" is F-A1 in workspace-data-isolation-leaks.)
          if (scopedSuperuserClamp) {
            const ah =
              args && typeof args === 'object' && typeof (args as Record<string, unknown>).harness === 'string'
                ? ((args as Record<string, unknown>).harness as string).trim()
                : '';
            if (ah === 'all' || ah === '*') {
              return {
                isError: true,
                content: [{
                  type: 'text' as const,
                  text: `harness_forbidden: harness:'${ah}' is the unscoped global escape; this session is scoped to workspace "${spawnRes.ctx.workspaceId}". Name a concrete harness in scope, or use an unscoped (--all-workspaces) session.`,
                }],
              };
            }
          }
          // Hive tier (P-014a; owner-ratified 2026-06-18 — AUTO-CONFINE on harness).
          // When a scoped-superuser session's concrete harness belongs to a hive,
          // it is confined to THAT hive's subtree: (a) cross_harness:* tools (which
          // read OTHER harnesses) are denied; (b) a per-call `harness` arg that
          // escapes the hive — harness:'all'/'*', or a harness in a different hive —
          // is rejected. Subtree membership = hiveHomeSlugForHarness(harness) ===
          // scopeHive (the hive home AND each member resolve to the home; D-006).
          // The harder half — confining the workspace-global coord/fleet/search/
          // memory surfaces per-hive (P-014b) — is a separate multi-subsystem change.
          if (scopedSuperuserClamp && spawnRes.ctx.harnessSlug !== '*') {
            const { hiveHomeSlugForHarness } = await import('../../../hive-federation');
            const scopeHive = await hiveHomeSlugForHarness(
              spawnRes.ctx.workspaceId,
              spawnRes.ctx.harnessSlug,
            );
            if (scopeHive) {
              if (toolName.startsWith('cross_harness:')) {
                return {
                  isError: true,
                  content: [{
                    type: 'text' as const,
                    text: `harness_forbidden: "${toolName}" reads other harnesses, but this session is confined to hive "${scopeHive}".`,
                  }],
                };
              }
              const argHarness =
                args && typeof args === 'object' && typeof (args as Record<string, unknown>).harness === 'string'
                  ? ((args as Record<string, unknown>).harness as string).trim()
                  : '';
              if (argHarness) {
                const escapes =
                  argHarness === 'all' ||
                  argHarness === '*' ||
                  (await hiveHomeSlugForHarness(spawnRes.ctx.workspaceId, argHarness)) !== scopeHive;
                if (escapes) {
                  return {
                    isError: true,
                    content: [{
                      type: 'text' as const,
                      text: `harness_forbidden: harness "${argHarness}" is outside this session's hive "${scopeHive}".`,
                    }],
                  };
                }
              }
            }
          }
          // Power-user / scoped-superuser workspace clamp (defense in depth). The
          // ctx's workspaceId is already clamped, so any tool reading
          // ctx.workspaceId is safe. But a handful of tools accept an explicit
          // `workspace` ARG used as a filter (audit 2026-05-20: ui:list_clients is
          // the only current one). We overwrite that arg with the clamped
          // workspace before the tool sees it — this defends every tool, present
          // and future, without a per-tool audit.
          const dispatchArgs =
            (spawnRes.ctx.isPowerUser || scopedSuperuserClamp) && args && typeof args === 'object' && 'workspace' in args
              ? { ...args, workspace: spawnRes.ctx.workspaceId }
              : args;
          // Replay lookup (P-046 / EI-68) — placed after the profile gate so a
          // replay grants nothing a fresh call wouldn't. Keys are scoped to the
          // caller's STABLE identity: uiClientId (the per-session SID for
          // SU/power sessions, where spawnId is per-request) falling back to
          // spawnId (stable for signed orchestrator spawns). Best-effort: a
          // store outage degrades to normal execution, never an error.
          const replayOwnerKey = spawnRes.ctx.uiClientId ?? spawnRes.ctx.spawnId;
          if (idempotencyKey) {
            try {
              const stored = await lookupStoredMcpResult(replayOwnerKey, idempotencyKey);
              if (stored) {
                return stored as {
                  content: Array<{ type: 'text'; text: string } | Record<string, unknown>>;
                  isError?: boolean;
                  _meta?: Record<string, unknown>;
                  structuredContent?: unknown;
                };
              }
            } catch (err) {
              // eslint-disable-next-line no-console
              console.warn(
                `[mcp-replay] lookup failed for ${toolName} (key=${idempotencyKey}): ` +
                  (err instanceof Error ? err.message : String(err)),
              );
            }
          }
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
          type McpCallResult = {
            content: Array<{ type: 'text'; text: string } | Record<string, unknown>>;
            isError?: boolean;
            // Format tag + envelope (P-006) and lossless structuredContent (P-010)
            // — forwarded to the MCP SDK's tools/call result so clients see them.
            _meta?: Record<string, unknown>;
            structuredContent?: unknown;
          };
          const runDispatch = async (ctx: UnifiedToolContext): Promise<McpCallResult> => {
            // The tool execution + idempotent persistence as ONE promise, so the P2-5
            // deadline can return a clean client error WITHOUT cancelling it: it
            // completes server-side + persists (P-046/EI-68), so a retry with the same
            // idempotencyKey replays the outcome instead of re-running.
            const execute = async (): Promise<McpCallResult> => {
              const result = (await dispatchProjectedToolToMcp(
                projected,
                toolName,
                dispatchArgs,
                ctx,
                PROJECTED_DEPS,
              )) as McpCallResult;
              // Persist the outcome BEFORE the response hits the (possibly
              // already-closed) stream — the whole point of P-046/EI-68: the
              // result must survive the transport. Best-effort.
              if (idempotencyKey) {
                try {
                  await storeMcpResult({
                    ownerKey: replayOwnerKey,
                    idempotencyKey,
                    toolName,
                    workspaceId: dispatchSpawnCtx.workspaceId,
                    result: result as StoredMcpResult,
                  });
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.warn(
                    `[mcp-replay] store failed for ${toolName} (key=${idempotencyKey}): ` +
                      (err instanceof Error ? err.message : String(err)),
                  );
                }
              }
              return result;
            };
            // P2-5 deadline: a tool exceeding MCP_DEADLINE_MS returns a clean error to
            // the client (no silent tunnel drop); it keeps running + persists for an
            // idempotent retry to replay.
            return raceDeadline<McpCallResult>(MCP_DEADLINE_MS, execute, () => ({
              isError: true,
              content: [{
                type: 'text' as const,
                text: idempotencyKey
                  ? `request_timeout: tool "${toolName}" exceeded ${MCP_DEADLINE_MS}ms (still running server-side; retry with the same _meta.idempotencyKey to replay its result once it completes).`
                  : `request_timeout: tool "${toolName}" exceeded ${MCP_DEADLINE_MS}ms (still running server-side; pass _meta.idempotencyKey to make a retry replay-safe instead of re-executing).`,
              }],
            }));
          };
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
    // Two prompt sources share prompts/list + prompts/get:
    //   1. STATIC definePrompt prompts (agent:role, …) — bearer-gated via
    //      listPrompts/getPrompt, unchanged.
    //   2. DYNAMIC slash projection (slash-exposure-tool-catalog-2026-06-12):
    //      every tool this session can see (the exact tools/list walk)
    //      surfaces as a `tool:*` prompt so agent clients render the whole
    //      catalog as slash commands. Flag-gated (SLASH_EXPOSURE, default ON).
    server.server.setRequestHandler(
      sdk.ListPromptsRequestSchema,
      async (_req: unknown, extra: unknown) => {
        const bearer = bearerFromExtra(extra);
        const prompts: Array<{
          name: string;
          description?: string;
          arguments?: unknown;
        }> = [];
        const publicStatic = () =>
          getPromptCatalog()
            .filter((p) => !p.capability)
            .map((p) => ({ name: p.name, description: p.description, arguments: p.arguments }));
        if (!bearer) {
          prompts.push(...publicStatic());
        } else {
          const { listPrompts } = await import('@papercusp/agent-mcp');
          const r = await listPrompts(bearer);
          if (r.ok && r.prompts) {
            prompts.push(...r.prompts);
          } else {
            // The bearer didn't resolve to a principal — true of the
            // ?superuser=1 token, which is not a bearer-principal (see
            // superuser-mode docs). The pre-slash behavior returned NOTHING
            // here; serve the public (capability-less) static set instead so
            // superuser sessions keep agent:role etc.
            prompts.push(...publicStatic());
          }
        }
        if (await getFlag(FLAGS.SLASH_EXPOSURE, 'system')) {
          const vis = await resolveVisibleToolListings(extra);
          if (vis.kind !== 'failed') {
            prompts.push(...dynamicSlashListings(vis.listings));
          }
        }
        return { prompts };
      },
    );
    server.server.setRequestHandler(
      sdk.GetPromptRequestSchema,
      async (
        req: { params: { name: string; arguments?: Record<string, string> } },
        extra: unknown,
      ) => {
        const name = req.params.name;
        const args = (req.params.arguments ?? {}) as Record<string, string>;
        if (isSlashPromptName(name)) {
          if (!(await getFlag(FLAGS.SLASH_EXPOSURE, 'system'))) {
            throw new Error(
              'slash_exposure_disabled: the papercusp-slash-exposure flag is off',
            );
          }
          return await getSlashPrompt(name, args, extra);
        }
        const bearer = bearerFromExtra(extra);
        const r = await getPrompt({ name, args, bearer });
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

/**
 * SSE header-flush priming: a streamable-HTTP tools/call that BLOCKS inside
 * the tool (chat:ask_choice awaiting the user's pick) opens a text/event-stream
 * response and then writes NOTHING until the tool resolves. Direct clients see
 * the 200 headers immediately (node flushes them), but any intermediary built
 * on node http-proxy — the :3055 Vite dev proxy, most reverse proxies — holds
 * the response headers until the FIRST BODY BYTE arrives, so the client sees
 * a connection that never responds at all. Prepending one SSE comment line
 * (spec-legal; eventsource parsers ignore `:`-prefixed lines) pushes the
 * headers through every hop the moment the stream opens.
 * Pinned by ask-choice-e2e.integration.test.ts ("tool reachable" case).
 */
const SSE_PRIME = new TextEncoder().encode(':stream-open\n\n');

// P2-2 (operator-scalability-event-loop-2026-06-16): a spec-legal SSE comment used as
// an application-level keepalive. While a blocking / long tools/call holds the
// streamable-HTTP event-stream OPEN but silent, the cloudflared tunnel + the client's
// ~60s idle timers fire and drop the connection mid-call (the MCP-tooling drops seen
// under load). Emitting this comment on a cadence well under 60s resets both timers.
// Like SSE_PRIME it rides the PER-REQUEST stream (NOT the Redis-backed SSE transport,
// which stays disabled) and is ignored by the MCP client's SSE parser (`:`-prefixed =
// comment). Tunable/disable-able via PAPERCUSP_MCP_KEEPALIVE_MS (0 = off).
const SSE_KEEPALIVE = new TextEncoder().encode(': keepalive\n\n');
const DEFAULT_KEEPALIVE_MS = Number(process.env.PAPERCUSP_MCP_KEEPALIVE_MS) || 20_000;

// P2-5 (operator-scalability-event-loop-2026-06-16): a server-side tool-call deadline.
// A tool exceeding this returns a CLEAN JSON-RPC error to the client instead of
// hanging to maxDuration / a silent tunnel drop. Set UNDER maxDuration (60s). 0
// disables. Env-tunable (PAPERCUSP_MCP_DEADLINE_MS).
const MCP_DEADLINE_MS = Number(process.env.PAPERCUSP_MCP_DEADLINE_MS) || 55_000;

/**
 * Race a tool dispatch against a deadline (P2-5). On expiry, resolve to `onTimeout()`
 * — a clean error result — so the client gets a definitive response, not a silent
 * drop. The `run()` promise is deliberately NOT cancelled: the tool finishes
 * server-side and (via runDispatch) persists its result, so a retry with the same
 * `_meta.idempotencyKey` replays the completed outcome rather than re-executing or
 * leaving a half-applied mutating write. `deadlineMs<=0` ⇒ no race (await run).
 */
export async function raceDeadline<T>(
  deadlineMs: number,
  run: () => Promise<T>,
  onTimeout: () => T,
): Promise<T> {
  const p = run();
  if (!(deadlineMs > 0)) return p;
  // Once the race settles on the timeout branch, the orphaned tool promise is still
  // in flight; its eventual rejection must not surface as an unhandledRejection.
  p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), deadlineMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function primeSseResponse(res: Response, keepaliveMs: number = DEFAULT_KEEPALIVE_MS): Response {
  const ctype = res.headers.get('content-type') ?? '';
  if (!res.body || !ctype.includes('text/event-stream')) return res;
  const reader = res.body.getReader();
  let cancelled = false;
  let closed = false;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const stopKeepalive = (): void => {
    if (keepalive) {
      clearInterval(keepalive);
      keepalive = undefined;
    }
  };
  // Tracks the latest in-flight inner read so the disconnect-drain (cancel)
  // never issues a `reader.read()` concurrent with a pending pull read — that
  // throws "read while another read is in progress".
  let lastRead: Promise<unknown> = Promise.resolve();
  const primed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(SSE_PRIME);
      // P2-2: keep the open-but-idle stream alive past the 60s tunnel/client timers.
      // Fires independently of pull() (which blocks on the inner read while the tool
      // runs), so a pending consumer read is satisfied by the comment — resetting the
      // idle timers — without waiting on the tool to produce.
      if (keepaliveMs > 0) {
        keepalive = setInterval(() => {
          if (cancelled || closed) return;
          try {
            controller.enqueue(SSE_KEEPALIVE);
          } catch {
            stopKeepalive(); // controller closed/errored between checks — stop pinging
          }
        }, keepaliveMs);
        (keepalive as { unref?: () => void }).unref?.();
      }
    },
    pull(controller) {
      const p = (async () => {
        const { done, value } = await reader.read();
        if (done) {
          closed = true;
          stopKeepalive();
          controller.close();
          return;
        }
        // Outer consumer already gone (cancel ran): stop forwarding. The
        // background drain below consumes the rest of the inner stream.
        if (cancelled) return;
        try {
          controller.enqueue(value);
        } catch {
          /* outer controller already closed — client raced us; ignore */
        }
      })();
      lastRead = p.catch(() => {});
      return p;
    },
    // Client disconnect. Do NOT cancel the inner reader: cancelling it closes
    // mcp-handler's ServerResponse-adapter controller, and that library's
    // detached write pump (createServerResponseAdapter → res.write →
    // controller.enqueue, node_modules/mcp-handler) then throws
    // TypeError[ERR_INVALID_STATE] "Controller is already closed" on the next
    // frame it writes after the client left. That throw is voided (an
    // unhandledRejection) and, under MCP load, crash-loops the whole operator
    // host (EI-12). Instead DRAIN the inner stream to completion in the
    // background — mcp-handler's OWN res.end() then stays the only thing that
    // closes its controller, so no enqueue-after-close ever happens. The
    // disconnect still reaches the tool + transport via the request
    // AbortSignal (mcp-handler wires request.signal → "close" →
    // transport.onclose), which is what makes the inner stream end.
    cancel() {
      cancelled = true;
      closed = true;
      stopKeepalive();
      void (async () => {
        try {
          await lastRead; // let any in-flight pull read settle first
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {
          /* inner stream torn down — nothing left to drain */
        }
      })();
    },
  });
  return new Response(primed, res);
}

const mcpHandler = async (req: Request): Promise<Response> =>
  primeSseResponse(await handler(req));

export { mcpHandler };
