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
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
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
  resolveMcpName,
  listMcpProjections,
  applyToolManifest,
  papercuspGateBypass,
  sanitizeToolSchema,
  serializeToolResponse,
  formatOptsFromCtx,
  isSlashPromptName,
  DeltaToolClient,
  dispatchWithConveyedDelta,
  parsePayloadTier,
  type PayloadTier,
  type UnifiedToolContext,
  type RequestOriginMetadata,
  type DeltaResponse,
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
import { capabilityMapText } from '../../../agent-tools/tools/capability-map';
import { unknownToolReferral } from '../../../agent-tools/tools/unknown-tool-referral';
import { maybeBatchNudge, maybeOrientDedupNudge, canRoleActOnCodeRun } from '../../../code-run-batch-nudge';
import { recordBatchNudgeFire } from '../../../code-run-nudge-telemetry';
import { authSafeToolsRemoveSet } from '../../../auth-config-overrides';
import { isLoopbackRequest, isValidSuperuserBearer } from '../../../superuser-token';
import { workspaceForCoordOwner } from '../../../adv-sessions';
import { activeWorkspaceId } from '../../../workspace-registry';
import { loopPressure } from '../../../event-loop-lag-monitor';
import { evaluateAdmission, ADMISSION_CONTROL_ENABLED } from './mcp-admission';
import {
  classifyAndConsumeFailure,
  logVerificationFailure,
  recordVerifiedSpawn,
  spawnSigFailureGuidance,
  verifySpawnParams,
} from '../../../spawn-signing';
import { verifyAccessToken } from '../../../power-user-token';
import {
  parseToolsAllowlist,
  filterListingsByAllowlist,
  getSessionSurface,
  activateSessionTools,
} from './tool-allowlist';
import {
  validIdempotencyKey,
  lookupStoredMcpResult,
  storeMcpResult,
  type StoredMcpResult,
} from './_mcp-result-replay';
import {
  takeStoredInitializeHandler,
  wrapInitializeWithInstructions,
} from './_mcp-initialize-enrich';
import { buildMcpPrelude } from '../../../memory/mcp-prelude';
import { INSIGHTS_DIR } from '../../../memory/knowledge-read';
import { getSessionUserOrDefault } from '../../../auth';
import { advertisedArgsSchema, decode, type ResultFormat } from '@papercusp/result-encoding';
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

type McpCallResult = {
  content: Array<{ type: 'text'; text: string } | Record<string, unknown>>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
};

const REQUEST_ORIGIN_QUERY_KEYS = new Set([
  'superuser',
  'power_user',
  'workspace',
  'harness',
  'role',
  'client',
  'agent',
  'model',
  'profile',
  'ctx_tier',
  'tools',
  'format',
  'structured',
  'delta',
  'plan_run',
  'all_workspaces',
]);

const REQUEST_ORIGIN_HEADER_KEYS = [
  'host',
  'user-agent',
  'origin',
  'referer',
  'sec-fetch-site',
  'x-papercusp-client',
  'x-papercusp-workspace',
  'x-papercusp-profile',
  'x-papercusp-agent',
  'x-papercusp-model',
  'mcp-session-id',
] as const;

function buildMcpRequestOrigin(extra: unknown): RequestOriginMetadata | undefined {
  const url = urlFromExtra(extra);
  if (!url) return undefined;
  const headers = headersFromExtra(extra);
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (REQUEST_ORIGIN_QUERY_KEYS.has(key)) query[key] = value;
  }
  const headerMeta: Record<string, string> = {};
  for (const key of REQUEST_ORIGIN_HEADER_KEYS) {
    const value = (headers.get(key) ?? '').trim();
    if (value) headerMeta[key] = value;
  }
  return {
    transport: 'mcp',
    path: url.pathname,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(Object.keys(headerMeta).length > 0 ? { headers: headerMeta } : {}),
  };
}

interface DeltaProxySession {
  client: DeltaToolClient;
  fields: Map<string, string>;
}

const DELTA_PROXY_SESSIONS = new Map<string, DeltaProxySession>();

function deltaProxySession(sessionKey: string): DeltaProxySession {
  let session = DELTA_PROXY_SESSIONS.get(sessionKey);
  if (!session) {
    session = { client: new DeltaToolClient(), fields: new Map<string, string>() };
    DELTA_PROXY_SESSIONS.set(sessionKey, session);
  }
  return session;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseToolText(text: string): unknown {
  const marker = /^format: (\w+)\n/.exec(text);
  if (!marker) return JSON.parse(text);
  return decode(text.slice(marker[0].length), marker[1] as ResultFormat);
}

function resultRows(result: McpCallResult): unknown[] {
  if (Array.isArray(result.structuredContent)) return result.structuredContent;
  const text = (result.content[0] as { text?: unknown } | undefined)?.text;
  if (typeof text !== 'string') throw new Error('delta proxy cannot parse non-text tool result');
  const parsed = parseToolText(text);
  if (!Array.isArray(parsed)) {
    // Some semantic tools diff a flattened row set while returning a grouped object
    // (for example plans:attention). A generic proxy cannot reconstruct that
    // original body from row deltas, so it must leave those calls on the raw path.
    throw new Error('delta proxy supports array-shaped tool results only');
  }
  return parsed;
}

function resultDelta(result: McpCallResult): Record<string, unknown> | undefined {
  const delta = result._meta?.delta;
  return delta && typeof delta === 'object' ? delta as Record<string, unknown> : undefined;
}

function adaptDeltaResponse(result: McpCallResult): DeltaResponse {
  const delta = resultDelta(result);
  const mode = typeof delta?.mode === 'string' ? delta.mode : 'full';
  const cursor = typeof delta?.cursor === 'string' ? delta.cursor : undefined;
  const itemKeyField = typeof delta?.itemKeyField === 'string' ? delta.itemKeyField : undefined;
  if (mode === 'not_modified') return { mode: 'not_modified', cursor };
  if (mode === 'delta') {
    const text = (result.content[0] as { text?: unknown } | undefined)?.text;
    if (typeof text !== 'string') throw new Error('delta proxy cannot parse non-text delta result');
    return {
      mode: 'delta',
      cursor,
      checksum: typeof delta?.checksum === 'string' ? delta.checksum : undefined,
      changes: parseToolText(text) as never,
      itemKeyField,
    };
  }
  return { mode: 'full', cursor, rows: resultRows(result), itemKeyField };
}

async function maybeRunWithDeltaProxy(input: {
  sessionKey: string;
  toolName: string;
  args: unknown;
  requestedFormat: string | undefined;
  explicitDelta: boolean;
  itemKeyField: string | undefined;
  runRaw: (requestedDelta: string | undefined, overrideDelta?: boolean) => Promise<McpCallResult>;
}): Promise<McpCallResult> {
  if (input.explicitDelta || !input.itemKeyField) return input.runRaw(undefined, false);
  const viewKey = `${input.toolName}:${input.requestedFormat ?? ''}:${stableJson(input.args ?? null)}`;
  const session = deltaProxySession(input.sessionKey);
  let last: McpCallResult | null = null;
  try {
    const out = await dispatchWithConveyedDelta(
      session.client,
      session.fields,
      viewKey,
      async (requestedDelta) => {
        // DeltaToolClient stores the opaque server cursor only; the tool protocol
        // expects the request mode plus cursor on the wire.
        last = await input.runRaw(requestedDelta ? `not_modified~${requestedDelta}` : undefined, true);
        return adaptDeltaResponse(last);
      },
    );
    if (!last || last.isError || out.mode === 'full') return last ?? input.runRaw(undefined, true);
    const meta = resultDelta(last);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(out.rows) }],
      _meta: {
        ...(last._meta ?? {}),
        delta: {
          ...(meta ?? {}),
          mode: 'full',
          reason: 'proxy_reconstructed',
        },
        deltaProxy: {
          servedMode: out.mode,
          reconstructedFull: true,
        },
      },
    };
  } catch {
    session.client.forget(viewKey);
    session.fields.delete(viewKey);
    return input.runRaw(undefined, true);
  }
}

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
 *   - memory:* (search/list/remember/update/forget) — the memory store is partitioned
 *     by USER-ID / HARNESS-SLUG, NOT by workspace (the handler reads getMemoryBackend,
 *     never ctx.tx). A scoped session calling these touches only its OWN user's /
 *     harness's memory — it never reads or writes another WORKSPACE's tenant data, so
 *     the clamp's threat model (cross-workspace tenant-data access) simply does not
 *     apply. They are crossWorkspace:true only so an UNSCOPED ('*') psu gets the admin
 *     handle (EI-2378); denying them from a scoped session would break legitimate
 *     same-user memory recall/writes for no isolation benefit. (Reads AND writes are
 *     listed: a write lands in the caller's own user/harness memory, crossing no
 *     workspace boundary — the "read-only" note above is autonomy:decide-specific.)
 */
const SCOPED_SAFE_CROSSWORKSPACE: ReadonlySet<string> = new Set([
  'autonomy:decide',
  'memory:search',
  'memory:list',
  'memory:remember',
  'memory:update',
  'memory:forget',
  // search:* prose recall (session-search-scope-2026-07-05 live-smoke finding) —
  // read-only; crossWorkspace ONLY so an unscoped psu gets the admin handle for
  // the non-workspace-scoped operator_turns table (P-062 Phase 4). From a SCOPED
  // session the engine confines every source by the ctx workspaceId it is handed
  // (runFullTextSearch/runHybridSearch `workspaceId:` — each SearchSource's SQL
  // filters on it); operator_turns is host-global operator history, not another
  // workspace's tenant data. Denying these made prose recall (and the EI-6984
  // work_item dedup check) deterministically unusable for every workspace-scoped
  // psu session — the same failure shape as autonomy:decide (EI-1810).
  'search:fulltext',
  'search:semantic',
  // sessions:* (session-search-scope-2026-07-05 P-005/P-006) — read-only session
  // recall. session_turns confines to (workspace_id = $ws OR 'default') — the
  // 'default' rows are THIS HOST's local transcript files (claude/omp/codex
  // JSONL), which carry no workspace identity and are not tenant data (same
  // class as memory:*, partitioned by owner not workspace). The flagship flow —
  // `sessions:search { session:'self' }` compaction recovery — runs from
  // workspace-scoped psu sessions, exactly the caller the clamp would deny.
  'sessions:search',
  'sessions:read',
  'sessions:list',
  'sessions:timeline',
]);

/** Whether a crossWorkspace tool is safe to call from a SCOPED superuser session —
 *  it self-confines to the caller's own workspace and is read-only (EI-1810).
 *  P-019: the runtime clamp:set_safe_tools dial can NARROW this allowlist (tighten-only) — a tool in
 *  the operator's safeToolsRemove set is treated as NOT safe (the clamp then denies it from a scoped
 *  session). It can only REMOVE entries, never add, so it can only tighten the cross-workspace gate. */
function isScopedSafeCrossWorkspaceTool(toolName: string): boolean {
  return SCOPED_SAFE_CROSSWORKSPACE.has(toolName) && !authSafeToolsRemoveSet().has(toolName);
}

/**
 * GLOBAL-config superuser admin tools exempt from the clamp's crossWorkspace denial.
 *
 * RATIONALE (security review — scoped-superuser-clamp follow-up). The clamp's threat
 * model is a scoped superuser reading another workspace's tenant DATA (a `crossWorkspace`
 * tool runs on the getOrgPg admin handle, which bypasses per-workspace RLS). The
 * `flags:*` family is categorically different: it is the ONE GLOBAL feature-flag store —
 * there is no per-workspace flag data, so confining it to a workspace protects no tenant
 * data. And denying it creates a CIRCULAR LOCKOUT: `flags:set` is the very control that
 * GOVERNS the clamp — a scoped superuser otherwise cannot disable the clamp (or flip any
 * global flag) without it, locking the operator out of its own controls. A superuser is
 * already god-mode at dispatch (`isSuperuser` bypasses role gates); managing GLOBAL config
 * is squarely within that authority. So the flag-admin family is reachable even from a
 * scoped superuser session. This widens NO per-workspace DATA reach — only the
 * global-config meta-controls. (Reviewed in the gate, not a self-asserted per-tool flag,
 * per the SCOPED_SAFE_CROSSWORKSPACE convention above.)
 */
const SUPERUSER_GLOBAL_FLAG_ADMIN: ReadonlySet<string> = new Set([
  'flags:get',
  'flags:set',
  'flags:list',
]);

/** Whether a tool is a GLOBAL-config superuser meta-control (the flag system) that a
 *  scoped superuser may reach despite the clamp — no tenant-data reach (see above). */
function isSuperuserGlobalFlagAdmin(toolName: string): boolean {
  return SUPERUSER_GLOBAL_FLAG_ADMIN.has(toolName);
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
   * The CALLING agent's CLI backend + model, stamped by the launcher onto the session MCP URL
   * (`?agent=`/`?model=`; omp also via the `x-papercusp-agent`/`-model` headers). Folded onto the
   * tool ctx so fleet:launch-on-plan can inherit the caller's backend/model for a fleet it spawns
   * (fleet-launch-agent-inheritance-2026-07-03). Null when the launcher didn't stamp them.
   */
  callerAgent?: string | null;
  callerModel?: string | null;
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
  /**
   * Session payload tier (context-trimming-tiers D-004), from `?ctx_tier=`
   * on the MCP URL — env-expanded from PAPERCUSP_CONTEXT_TIER by psu (the
   * same channel as `?tools=`). Forwarded to `UnifiedToolContext.contextTier`
   * so defineTool `shape` projections apply; absent/invalid ⇒ 'full'
   * (unshaped — today's behavior, byte-identical).
   */
  contextTier?: PayloadTier;
  requestOrigin?: RequestOriginMetadata;
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
  const requestOrigin = buildMcpRequestOrigin(extra);

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
    const harnessUrlParam = (url.searchParams.get('harness') ?? '').trim();
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
    //   2. `?client=` — the SID claude/codex bake into the url via env
    //      expansion (`?client=${PAPERCUSP_SID}`), and what the channel
    //      hooks (one-shot POSTs, no MCP session) use to pass a per-session
    //      id directly. EXPLICIT-SID-BEFORE-TRANSPORT-ID (EI-7066,
    //      2026-07-03): this used to rank BELOW Mcp-Session-Id, so a claude
    //      session that reconnected mid-life (a cold-loop RECYCLE respawn, a
    //      dropped MCP transport) silently swapped to a fresh per-connection
    //      identity — loop:arm keyed one ownerId but the post-reconnect
    //      loop:checkpoint keyed another, the carry-note anchored on the
    //      wrong owner, and the cold loop silently stayed warm. An explicit
    //      per-launch SID — header OR param — always outranks the transport id.
    //   3. `Mcp-Session-Id` — the Streamable-HTTP transport's per-connection
    //      id, if the server assigned one. LAST resort: it is per-CONNECTION
    //      (interactive calls and the hook are separate connections →
    //      different ids → the lock self-deadlock; reconnects → identity
    //      fracture), so it only identifies callers that supplied no SID at all.
    const headerClient = (headers.get('x-papercusp-client') ?? '').trim();
    const mcpSessionId = (headers.get('mcp-session-id') ?? '').trim();
    const suIdentity = headerClient || clientParam || mcpSessionId;
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
    // Harness, same precedence as workspace above (WI-4393): `x-papercusp-harness`
    // header (OMP's per-launch carrier — omp-integration.ts's buildMcpEntry) first,
    // then `?harness=` (claude's `${PAPERCUSP_HARNESS_SLUG:-}` env-expanded url —
    // claude-integration.ts's buildClaudeMcpEntry). Without the header leg, every
    // OMP session baked a static harness-less URL and the initialize-time memory
    // prelude (buildMcpPrelude) never fired a harness-scoped recall for su-* OMP
    // sessions (zero port=initialize ledger stamps, live-verified in the WI).
    const headerHarness = (headers.get('x-papercusp-harness') ?? '').trim();
    const harnessParam = headerHarness || harnessUrlParam;
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
        // mcp-outage-triage-2026-07-02: an UNTRACKED session (resumed claude whose
        // env lost PAPERCUSP_WORKSPACE and whose fresh SID has no adv row — the hole
        // resumeEnvFor's doc names) used to hard-fail here, leaving the session
        // permanently TOOLLESS (the client gives up after ~4 tools/list retries).
        // Scope it to the box's active workspace instead: ONE concrete workspace
        // (registry `current` / PAPERCUSP_WORKSPACE_ID pin — never '*'), so the
        // clamp's no-silent-god-mode guarantee is intact while the session stays
        // usable. The reject remains only for the can't-happen empty resolution.
        const active = activeWorkspaceId();
        if (active) {
          console.warn(
            `[mcp] superuser session '${suIdentity || '(no sid)'}' carried no workspace and the SID→adv-row ` +
              `fallback missed — scoping to the active workspace '${active}' (registry fallback).`,
          );
          workspaceId = active;
        } else {
          return { kind: 'failed', reason: 'scoped_superuser_workspace_unresolved' };
        }
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
        // Caller backend + model (fleet-launch-agent-inheritance-2026-07-03): psu stamps them onto
        // the per-session MCP URL (omp: applyOmpMcpUrlParams; claude/codex: env-interpolated URL),
        // with the `x-papercusp-agent`/`-model` headers as a parallel carrier. fleet:launch-on-plan
        // reads these to default a spawned fleet's backend/model to the CURRENT caller's own.
        callerAgent:
          (headers.get('x-papercusp-agent') ?? '').trim() ||
          (url.searchParams.get('agent') ?? '').trim() ||
          null,
        callerModel:
          (headers.get('x-papercusp-model') ?? '').trim() ||
          (url.searchParams.get('model') ?? '').trim() ||
          null,
        planRunSessionId,
        isSuperuser: true,
        // gateBypass is computed in buildMcpToolContext from isSuperuser/isPowerUser.
        // SU callers testing the power profile pass ?profile=power (or the
        // x-papercusp-profile header — psu's per-launch --profile carrier).
        profile: profileParam === 'power' ? 'power' : 'engineer',
        // Session payload tier (context-trimming-tiers D-004) — env-expanded by
        // psu into the user-level MCP URL, like `tools=`.
        contextTier: parsePayloadTier(url.searchParams.get('ctx_tier')),
        requestOrigin,
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
        contextTier: parsePayloadTier(url.searchParams.get('ctx_tier')),
        requestOrigin,
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
      const spawn = url.searchParams.get('spawn');
      const role = url.searchParams.get('role');
      const harness = url.searchParams.get('harness');
      // WI-3190: classify a strand (a spawn this process previously authenticated,
      // now rejected because its key was rotated) apart from an attack, and dedupe
      // the alert. This is the single mutating consume — do it once.
      const classification = classifyAndConsumeFailure(v.reason, spawn);
      await logVerificationFailure({
        reason: v.reason,
        claimedRole: role,
        claimedHarness: harness,
        claimedWorkspace: url.searchParams.get('workspace'),
        claimedSpawn: spawn,
        expClaim: hasExp ? Number(url.searchParams.get('exp')) : null,
        remoteAddr,
        userAgent,
        classification,
      });
      if (classification === 'rotation_strand') {
        // A previously-working session just lost all tool access to a key rotation.
        // Loud + structured (console.error, not warn) so it stands out in the
        // operator journal as an actionable re-spawn, not routine escalation noise.

        console.error(
          `[spawn-signing][INCIDENT] rotation_strand — a previously-authenticated spawn was just ` +
            `rejected (signing key rotated out from under it). spawn=${spawn} role=${role} ` +
            `harness=${harness}. It will ZOMBIE unless re-spawned or switched to scripts/mcp-call.mjs.`,
        );
      } else {

        console.warn(
          `[spawn-signing] rejected MCP request: ${v.reason} (role=${role}, ` +
            `harness=${harness}, spawn=${spawn})`,
        );
      }
      // Enrich the agent-visible reason with actionable self-recovery guidance
      // (WI-3190 ask c) while keeping the stable `spawn_sig_<reason>` token prefix
      // that surfaces at both tools/call and tools/list.
      return { kind: 'failed', reason: `spawn_sig_${v.reason} — ${spawnSigFailureGuidance(v.reason)}` };
    }
    sigVerified = true;
    // WI-3190: remember this spawn so a later rotation-strand is recognisable.
    recordVerifiedSpawn({
      spawn: url.searchParams.get('spawn'),
      role: url.searchParams.get('role'),
      harness: url.searchParams.get('harness'),
      workspace: url.searchParams.get('workspace'),
    });
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
    return {
      kind: 'failed',
      reason: `spawn_sig_missing_sig_required_mode — ${spawnSigFailureGuidance('missing_sig_required_mode')}`,
    };
  } else {
    // Soft-warn period: allow unsigned URLs but log so we can see the
    // transition progress.
    if (url.searchParams.has('role') || url.searchParams.has('spawn')) {
       
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
        // Spawned agents get their tier from the per-spawn mcp.json URL
        // (context-trimming-tiers D-004; the orchestrator threads it).
        contextTier: parsePayloadTier(url.searchParams.get('ctx_tier')),
        requestOrigin,
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
 * Bind the tx + principal a projected tool needs, then run `run` under that ctx.
 * The ONE place the "how does a projected tool get its workspace tx" decision
 * lives — shared by the direct tools/call path AND the tools:invoke re-dispatch
 * (dispatchTool), so the two can never drift apart again:
 *   - crossWorkspace tool → the admin (rolbypassrls) handle, so it spans
 *     workspaces (RLS never hides another workspace's rows).
 *   - needsTx tool (concrete workspace) → a withWorkspace(ws) harness_app tx +
 *     a least-privilege synthesized principal.
 *   - unscoped ('*') non-crossWorkspace tool → runs tx-less (its own
 *     "workspace= arg required" fallback fires).
 *
 * EI-6982: tools:invoke previously reused the OUTER call's ctx (built for
 * tools:invoke itself — requirePrincipal:false, so NO tx/principal was
 * synthesized), which made EVERY crossWorkspace/needsTx target (memory:*,
 * flags:set, harness:list, …) throw "requires a workspace-scoped call" from an
 * unscoped psu/fleet session. Routing both dispatch paths through this helper is
 * the durable fix.
 */
async function dispatchWithSynthesizedTx<T>(
  tool: { crossWorkspace?: boolean },
  spawnCtx: BuiltSpawnContext,
  baseCtx: UnifiedToolContext,
  run: (ctx: UnifiedToolContext) => Promise<T>,
): Promise<T> {
  // P-062 — crossWorkspace tools span workspaces: hand them the admin
  // (rolbypassrls) handle, never a workspace-scoped harness_app tx. Checked
  // before needsTx so it also covers the superuser/'*' discovery case
  // (e.g. papercusp:list_workspaces). Tools that read getOrgPg() directly are
  // unaffected (they ignore ctx.tx).
  if (tool.crossWorkspace === true) {
    const { sql: adminTx } = getOrgPg();
    const ctx: UnifiedToolContext = {
      ...baseCtx,
      tx: adminTx,
      principal: await synthesizeDispatchPrincipal(adminTx, spawnCtx),
    };
    return runWithWorkspaceIfConcrete(spawnCtx.workspaceId, () => run(ctx));
  }
  if (dispatchNeedsTx(spawnCtx)) {
    const ctxWs = spawnCtx.workspaceId;
    return runWithWorkspaceIfConcrete(ctxWs, () =>
      withWorkspace(ctxWs, async (tx) => {
        const ctx: UnifiedToolContext = {
          ...baseCtx,
          tx,
          principal: await synthesizeDispatchPrincipal(tx, spawnCtx),
        };
        return run(ctx);
      }),
    );
  }
  return runWithWorkspaceIfConcrete(spawnCtx.workspaceId, () => run(baseCtx));
}

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
  // Client-negotiated freshness request (agent-tool-delta-protocol D-001), from
  // `_meta.delta` / `?delta=` on the MCP URL. Threaded to ctx.requestedDelta so
  // the result serializer can honor a `not_modified` request on a delta-capable tool.
  requestedDelta?: string,
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
  // activateTools — expand THIS session's live tool surface at runtime
  // (dynamic-tool-surface-2026-07-01). Grows the session's mutable allowlist
  // (keyed by the su session identity uiClientId, seeded from the connect-time
  // ?tools=) and, if something new was added, fires the standard
  // notifications/tools/list_changed so a listChanged-capable client (omp,
  // codex) re-fetches tools/list and can call the surfaced tools. Gated only on
  // sendNotification (session-level, NOT progressToken like emit/progress).
  // No-op for un-seeded (full-catalog / Claude) sessions: activateSessionTools
  // returns false when no surface entry exists, so no notification is sent.
  const activateTools: UnifiedToolContext['activateTools'] = (toolNames) => {
    const added = activateSessionTools(spawn.uiClientId, toolNames);
    if (added && sendNotification) {
      sendNotification({
        method: 'notifications/tools/list_changed',
        params: {},
      }).catch((err) => {
         
        console.warn(`[mcp-tool] sendNotification(tools/list_changed) failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return added;
  };
  // dispatchTool — the engine behind the tools:invoke meta-tool
  // (dynamic-tool-surface-2026-07-01). Routes a call to ANY projected tool
  // server-side under THIS caller's context (via the ctxRef holder, so the
  // target is gated EXACTLY as a direct call — dispatchProjectedToolToMcp
  // applies the role-allowlist + quota + profile gates against `ctx`). The
  // universal reachability path for a client that can't grow its own tool list.
  const ctxRef: { current: UnifiedToolContext | undefined } = { current: undefined };
  const dispatchTool: UnifiedToolContext['dispatchTool'] = async (toolName, toolArgs) => {
    // WI-3930: resolve TOLERANTLY — an agent commonly pastes a tool name into
    // tools:invoke in the underscore/group_verb (`curation_state-of-pot`) or
    // fully client-mangled (`mcp__papercusp-su__curation_state-of-pot`) form it
    // sees in its own advertised list, not the canonical colon form. Exact match
    // is still the fast path; the normalized fallback (unambiguous only) saves a
    // wasted unknown-tool round-trip. Dispatch downstream under the CANONICAL
    // registered name so telemetry/quota attribution keys off the real tool.
    const target = resolveMcpName(toolName);
    if (!target?.expose?.mcp) {
      // EI-9011 (generalized): moment-of-failure referral — closest catalog matches +
      // the tools:find/tools:invoke routing hint, so a typo'd or client-format name
      // never reads as "the tool doesn't exist".
      return { isError: true, content: [{ type: 'text' as const, text: unknownToolReferral(toolName) }] };
    }
    const canonicalName = target.expose.mcp.name;
    // EI-6982: bind the tx/principal the TARGET tool needs — NOT the outer
    // tools:invoke ctx (requirePrincipal:false, so tx-less). Without this, every
    // crossWorkspace/needsTx target (memory:*, flags:set, harness:list, …) threw
    // "requires a workspace-scoped call" from an unscoped session. Honor a per-call
    // `workspace` arg on the target too, so an unscoped superuser can
    // `tools:invoke { name:'harness:list', args:{ workspace } }` exactly as a direct
    // call would (effectiveDispatchWorkspace). Shared with the direct tools/call
    // path via dispatchWithSynthesizedTx so the two can't drift.
    const effectiveWs = effectiveDispatchWorkspace(spawn, toolArgs ?? {});
    const spawnCtx: BuiltSpawnContext =
      effectiveWs === spawn.workspaceId ? spawn : { ...spawn, workspaceId: effectiveWs };
    const baseCtx: UnifiedToolContext =
      effectiveWs === ctxRef.current!.workspaceId
        ? ctxRef.current!
        : { ...ctxRef.current!, workspaceId: effectiveWs };
    return (await dispatchWithSynthesizedTx(target, spawnCtx, baseCtx, (ctx) =>
      dispatchProjectedToolToMcp(target, canonicalName, toolArgs ?? {}, ctx, PROJECTED_DEPS),
    )) as Awaited<ReturnType<NonNullable<UnifiedToolContext['dispatchTool']>>>;
  };
  const builtCtx: UnifiedToolContext = {
    activateTools,
    dispatchTool,
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
    callerAgent: spawn.callerAgent ?? null,
    callerModel: spawn.callerModel ?? null,
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
    // Payload tier (context-trimming-tiers D-004) — absent ⇒ 'full' at resolution.
    contextTier: spawn.contextTier,
    requestedFormat,
    requestedStructured,
    requestedDelta,
    requestOrigin: spawn.requestOrigin,
    log: (msg) => {
       
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
  // Close the ctxRef loop so dispatchTool routes the target through THIS ctx.
  ctxRef.current = builtCtx;
  return builtCtx;
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
  // listChanged: true — this server GROWS a session's advertised tool set at
  // runtime (dynamic-tool-surface-2026-07-01). A seeded session (small ?tools=
  // core) expands on intent via ctx.activateTools (tools:find), and the
  // transport fires notifications/tools/list_changed so the client re-fetches
  // tools/list and can call the surfaced tools. Clients that honor the
  // notification (omp, codex) get "small seed + full reachability on demand";
  // clients that ignore it are unaffected. Claude is never sent the
  // notification (it launches un-seeded → no surface → no fire).
  tools: { listChanged: true },
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
 * Nudges agents toward the three-layer memory pattern. This is the STATIC
 * base; per-session dynamic enrichment (mem0 fan-out + insights index via
 * `buildMcpPrelude`) is wired in the setup callback below by DELEGATING to
 * the SDK's own initialize handler and appending to its `instructions` —
 * see `_mcp-initialize-enrich.ts`
 * (memory-delivery-unification-2026-07-12 P-001; the old "SDK doesn't
 * expose a clean hook" deferral is closed).
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
  After a SUCCESSFUL orient, do NOT separately call \`coord:plan-events\`,
  \`memory:search\`, \`coord:inbox\`, or \`coord:declare-intent\` — orient's
  result ALREADY contains them (plan-events delta + inbox summary + a mem0
  recall) and ALREADY declared your intent; re-calling them just re-pays the
  round-trip orient collapsed. Reach for one individually only for a detail
  orient deliberately bounds (full inbox bodies, or a mem0 query OTHER than
  your intent).

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
    \`memory:search\` directly. A recall hit is BINDING context, not flavor:
    if a recalled fact prescribes a behavior for THIS task, follow it — or
    explicitly say why you're not.
  - **insights (how things work).** When you hit a confusing failure,
    \`docs:search\` the \`agent-insights/\` section before grepping code —
    many "weird bugs" already have a written runbook.
  - **State answers NOW; only the append-only log answers EVER.** \`coord:presence\` /
    \`fleet:assignments\` are LIVE-STATE — who is alive, who holds what RIGHT NOW; an ended
    agent loses its fleet_slug and its presence row is TTL-reaped, so they CANNOT answer an
    *ever / was / missed / history* question. Route those to \`coord:catch-up { audience }\`
    (as a member of the fleet/topic) or \`coord:feed { audience }\` (the firehose) instead —
    never a state tool. Full map:
    \`docs:search\` \`agent-insights/presence-vs-history-who-is-on-what\`.

Right layer for READS and WRITES — the memory↔docs boundary:
  - **HOW IT WORKS** (a runbook, a failure mode, why-something-is, a hard-won gotcha):
    READ via \`docs:search\` the \`agent-insights/\` section; WRITE a new/updated MDX under
    \`apps/operator-docs/src/content/docs/agent-insights/\` with a \`documents:\` frontmatter
    anchor to the code it describes. This is the RIGHT place — a doc is code-ANCHORED,
    drift-TRACKED (the freshness sweep) and AUTO-HEALED (the doc-steward); a mem0 vector cannot
    be anchored/swept/auto-rewritten, so how-it-works left only in mem0 silently rots. Do NOT
    park a runbook in mem0.
  - **WHY a subsystem/decision is the way it is** (the rationale behind a design, not how it works):
    READ via \`rationale:feed { topic }\` — a topic-keyed projection over the relevant
    plan-decisions + work-items + insights, kept fresh by the event engine (\`topics:list\` for the
    topic, then \`plans:get\`/\`docs:get\` on an entry's \`ref\` for the full text). The discoverable
    "why" layer — reach for it before grepping plans/decisions by hand.
  - **A durable PERSONAL/PREFERENCE fact** (who the user is, a convention, an owner pref):
    READ via \`memory:search\`; WRITE via \`memory:remember\`. Keep mem0 entries SHORT, and when
    the why already lives in a doc/plan store only the non-derivable fact + a POINTER
    (\`[[<plan-slug>]]\`, \`/internal/docs/agent-insights/<slug>\`), never a copied paragraph.
  - **In-flight state** → coord; **derivable session state** (X shipped, migration N, N tests)
    → the plan / work-item, never memory.
See the plans \`papercusp-su-memory-2026-05-25\` and
\`tool-call-batching-wrappers-2026-06-21\`.`;

/**
 * Wall-clock cap on the per-session initialize enrichment (P-001). Session
 * establishment must stay snappy: past this, the enrichment resolves null
 * and the client gets the static instructions. buildMemoryContextBlock has
 * its own op-deadline posture; this bounds the WHOLE enrich path (including
 * the PG user lookup). Env-tunable; 0 = unbounded (raceDeadline semantics —
 * the kill switch for the whole prelude stays PAPERCUSP_SU_MEMORY_INJECTION=off).
 */
const INITIALIZE_ENRICH_DEADLINE_MS = (() => {
  const raw = Number(process.env.PAPERCUSP_MCP_INIT_ENRICH_DEADLINE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2_500;
})();

function mcpInstructionsForServer(): string | undefined {
  // dynamic-tool-surface D-011: append the compact CAPABILITY MAP so a trimmed session (the
  // default now) knows WHAT exists to search for — discoverability at ~1-2k instead of the
  // ~165k of full descriptions. Harmless for a `full`/eager session (it already sees every
  // tool). Gated off with the memory injection kill-switch for parity.
  if (process.env.PAPERCUSP_SU_MEMORY_INJECTION === 'off') return undefined;
  return `${PAPERCUSP_MCP_INSTRUCTIONS}\n\n${capabilityMapText()}`;
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
  | { kind: 'failed'; reason: string }
  | {
      kind: 'ok' | 'none';
      spawnRes: TrySpawnContextResult;
      listings: ReturnType<typeof listMcpProjections>;
    }
> {
  const spawnRes = await tryBuildSpawnContext(extra);
  // WI-574 (loud auth-fail): carry the rejection reason so tools/list can fail LOUDLY instead of
  // silently advertising an empty tool list (which is indistinguishable from a healthy server).
  if (spawnRes.kind === 'failed') return { kind: 'failed', reason: spawnRes.reason };
  const role = spawnRes.kind === 'ok' ? spawnRes.ctx.role : undefined;
  const rawProfile = spawnRes.kind === 'ok' ? spawnRes.ctx.profile : undefined;
  // GENERIC profile (P-025) → engineer-like tool visibility (the manifest filter only gates
  // power); coerce so the narrow listMcpProjections param need not carry 'generic'.
  const profile = rawProfile === 'generic' ? 'engineer' : rawProfile;
  const bypass = urlFromExtra(extra)?.searchParams.get('manifestBypass') === '1';
  const result = applyToolManifest(listMcpProjections(role, profile), { bypass });
  // `?tools=` is the SEED, not a hard cap (dynamic-tool-surface-2026-07-01): a
  // seeded session's surface GROWS at runtime via ctx.activateTools (tools:find)
  // + notifications/tools/list_changed. getSessionSurface returns that live set
  // (created on this first tools/list, re-fetched-and-grown on later ones), or
  // the raw seed when there's no stable session key, or null (full catalog) when
  // there's no seed at all. Keyed by the su session identity (uiClientId).
  const seed = parseToolsAllowlist(urlFromExtra(extra)?.searchParams.get('tools'));
  const sessionKey = spawnRes.kind === 'ok' ? spawnRes.ctx.uiClientId : null;
  const allow = getSessionSurface(sessionKey, seed);
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
          // WI-574 (loud auth-fail): a REJECTED auth context (expired per-spawn signed URL, invalid
          // superuser bearer, bad signature) must NOT return a silent empty tool list — that is
          // indistinguishable from a healthy server with no tools and is the root of the "toolless
          // session that looks connected" class. Throw a specific JSON-RPC error so the client + agent
          // KNOW the session is unauthenticated and WHY. (Mirrors tools/call, which already hard-fails
          // a rejected spawn ctx.) A bare no-params probe is `kind:'none'`, not 'failed', and still lists.
          throw new Error(
            `mcp_auth_failed: ${vis.reason} — this MCP session is UNAUTHENTICATED, so it exposes NO tools ` +
              '(this is NOT "a healthy server with zero tools"). Typical causes: an EXPIRED per-spawn signed ' +
              'URL token (re-mint/reconnect) or a missing/invalid superuser bearer. Fix the credential and reconnect.',
          );
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
            _meta?: { progressToken?: string | number; format?: string; idempotencyKey?: string; delta?: string };
          };
        },
        extra: unknown,
      ) => {
        const toolName = req.params.name;
        // `let` (not const): the scoped-superuser clamp may RE-RESOLVE a wildcard
        // `harness:'all'` on plans:list into a workspace-wide read of the session's
        // own workspace (F-A1) before dispatch — see the clamp block below.
        let args = req.params.arguments ?? {};
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
        // Freshness negotiation (agent-tool-delta-protocol-2026-06-22, D-001): a
        // per-call `_meta.delta` wins over a connection-level `?delta=` (mirrors
        // `?format=`). The HARNESS — not the model — sets this and owns cursor
        // storage + base-presence tracking; absent ⇒ no negotiation (serve full).
        const requestedDelta =
          req.params._meta?.delta ?? urlFromExtra(extra)?.searchParams.get('delta') ?? undefined;
        const explicitDelta =
          req.params._meta?.delta !== undefined || urlFromExtra(extra)?.searchParams.has('delta') === true;
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
        // EI-9510: the replay-store round-trip (lookupStoredMcpResult /
        // storeMcpResult, both awaited on the hot path below) only matters for
        // a WRITE — a read-only tool has no mutation to double-apply, so
        // replaying it is a pure no-op. P-005 makes the proxy inject
        // `_meta.idempotencyKey` on every call regardless, so without this
        // gate every read pays one extra awaited INSERT + one extra lookup
        // round-trip too. `projected.effect` ('read'|'write') is inferred
        // from the tool's capability suffix at defineTool time — skip both
        // the lookup and the store when it resolves to 'read'.
        const skipReplayForReadOnly = projected?.effect === 'read';
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
            !isScopedSafeCrossWorkspaceTool(toolName) &&
            // GLOBAL-config superuser meta-controls (flags:*) are exempt — they touch no
            // per-workspace tenant data, and denying flags:set circularly locks the
            // operator out of the very control that governs this clamp. See
            // SUPERUSER_GLOBAL_FLAG_ADMIN above for the security review.
            !isSuperuserGlobalFlagAdmin(toolName)
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
              // F-A1 (leaks D-4 / clamp D-002): for a WORKSPACE-scoped session
              // (ctx.harnessSlug '*', not pinned to a hive), harness:'all'/'*' on the
              // plans LIST read must mean "THIS workspace's plans" — NOT the
              // PAPERCUSP_WORKSPACE_ID papercup global (a cross-scope read). RE-RESOLVE
              // it to a workspace-wide read of the session's OWN workspace: drop the
              // wildcard harness + set workspaceWide, so list.ts reads
              // activeWorkspaceId() plans only (the dispatch tx is pinned to
              // ctx.workspaceId → it cannot cross out; the resolvePlanScope global
              // escape is never reached). Scoped narrowly: only plans:list, only the
              // workspace tier — a HIVE-pinned session's 'all' MUST fall through to the
              // hive-tier reject below (it cannot see sibling-hive plans), and any
              // OTHER tool's 'all'/'*' has no safe in-workspace meaning → REJECTED.
              if (toolName === 'plans:list' && spawnRes.ctx.harnessSlug === '*' && args && typeof args === 'object') {
                const rest = { ...(args as Record<string, unknown>) };
                delete rest.harness;
                args = { ...rest, workspaceWide: true };
              } else {
                return {
                  isError: true,
                  content: [{
                    type: 'text' as const,
                    text: `harness_forbidden: harness:'${ah}' is the unscoped global escape; this session is scoped to workspace "${spawnRes.ctx.workspaceId}". Name a concrete harness in scope, or use an unscoped (--all-workspaces) session.`,
                  }],
                };
              }
            }
          }
          // scoped-superuser-workspace-clamp (P-017, workspace tier): a concrete per-call
          // `harness` arg that resolves to a DIFFERENT workspace is REJECTED. The
          // plans/work-item readers derive a harness's workspace from the harness REGISTRY
          // (resolvePlanScope → resolveWorkspaceForHarnessSlug), NOT the clamped
          // ctx.workspaceId — so a scoped session could otherwise name a foreign-workspace
          // harness and read its plans even though crossWorkspace tools + harness:'all' are
          // already denied (the gap su-c5b1c's active-ws-first fallback narrowed but left
          // open via its cross-ws scan). We resolve the harness's workspace EXPLICITLY
          // against the session's own workspace — the request-scoped ALS is not yet pinned
          // to the clamped workspace at this point, so we pass ctx.workspaceId by hand
          // (the hive-tier clamp below does the same with potHomeSlugForHarness). The
          // hive tier is a FINER same-workspace/different-hive check that composes on top.
          // Fail-OPEN on an infra error / unresolvable-or-ambiguous slug (P-006); fail-CLOSED
          // only on a CONFIRMED foreign resolution.
          if (scopedSuperuserClamp) {
            const ah =
              args && typeof args === 'object' && typeof (args as Record<string, unknown>).harness === 'string'
                ? ((args as Record<string, unknown>).harness as string).trim()
                : '';
            if (ah && ah !== 'all' && ah !== '*') {
              const { resolveWorkspaceForHarnessSlugIn } = await import('../../../harness-core');
              let harnessWs: string | null = null;
              try {
                harnessWs = await resolveWorkspaceForHarnessSlugIn(spawnRes.ctx.workspaceId, ah);
              } catch {
                // Ambiguous cross-workspace collision (resolver throws) or an infra error:
                // fail OPEN — let the tool resolve/fail loud rather than block a same-name slug.
                harnessWs = null;
              }
              if (harnessWs && harnessWs !== spawnRes.ctx.workspaceId) {
                return {
                  isError: true,
                  content: [{
                    type: 'text' as const,
                    text: `harness_forbidden: harness "${ah}" belongs to workspace "${harnessWs}", but this session is scoped to workspace "${spawnRes.ctx.workspaceId}". Name a harness in scope, or use an unscoped (--all-workspaces) session.`,
                  }],
                };
              }
            }
          }
          // Hive tier (P-014a; owner-ratified 2026-06-18 — AUTO-CONFINE on harness).
          // When a scoped-superuser session's concrete harness belongs to a hive,
          // it is confined to THAT hive's subtree: (a) cross_harness:* tools (which
          // read OTHER harnesses) are denied; (b) a per-call `harness` arg that
          // escapes the hive — harness:'all'/'*', or a harness in a different hive —
          // is rejected. Subtree membership = potHomeSlugForHarness(harness) ===
          // scopeHive (the hive home AND each member resolve to the home; D-006).
          // The harder half — confining the workspace-global coord/fleet/search/
          // memory surfaces per-hive (P-014b) — is a separate multi-subsystem change.
          if (scopedSuperuserClamp && spawnRes.ctx.harnessSlug !== '*') {
            const { potHomeSlugForHarness } = await import('../../../hive-federation');
            const scopeHive = await potHomeSlugForHarness(
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
                  (await potHomeSlugForHarness(spawnRes.ctx.workspaceId, argHarness)) !== scopeHive;
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
              // P-016/P-014b: the harness check above keys on `harness`, but the
              // search + memory surfaces (search:fulltext/semantic, memory:search/
              // list/remember) scope by `harness_slug` — a hive-scoped session could
              // otherwise target a SIBLING-hive harness's prose/recall through that
              // arg. Reject a `harness_slug` that resolves outside the hive subtree
              // (same escapes rule as `harness`).
              const argHarnessSlug =
                args && typeof args === 'object' && typeof (args as Record<string, unknown>).harness_slug === 'string'
                  ? ((args as Record<string, unknown>).harness_slug as string).trim()
                  : '';
              if (argHarnessSlug) {
                const escapes =
                  argHarnessSlug === 'all' ||
                  argHarnessSlug === '*' ||
                  (await potHomeSlugForHarness(spawnRes.ctx.workspaceId, argHarnessSlug)) !== scopeHive;
                if (escapes) {
                  return {
                    isError: true,
                    content: [{
                      type: 'text' as const,
                      text: `harness_forbidden: harness_slug "${argHarnessSlug}" is outside this session's hive "${scopeHive}".`,
                    }],
                  };
                }
              }
              // P-016/P-014b: confine the workspace-GLOBAL read surfaces (coord/
              // fleet/presence) per-hive. The harness-arg + cross_harness checks
              // above cover the harness-keyed reads; this closes the surfaces that
              // read by a `hive` arg or a cross-hive `scope` selector.
              // (a) A `hive` arg naming a DIFFERENT hive is an explicit sibling-hive
              //     read on any tool (coord:presence, pot:get/status, coord:wake, …)
              //     → reject (a hive slug means the same thing on every tool).
              // (b) coord:presence is the one read surface with a hive|workspace|all
              //     scope selector; its DEFAULT already resolves to the caller's OWN
              //     hive (presence-snapshot resolvePresenceScope), so only an EXPLICIT
              //     scope:'workspace'|'all' widens out of the hive → reject it (mirrors
              //     the harness:'all' reject above; no-op in a single-hive workspace).
              // search/memory stay workspace-scoped via the per-workspace F-C1
              // foundation; a per-hive subtree-narrowing of free-text search/recall is
              // a tracked follow-on (P-016b) — latent today (live workspace == 1 hive).
              const hiveArgs =
                args && typeof args === 'object' ? (args as Record<string, unknown>) : null;
              const argHive =
                hiveArgs && typeof hiveArgs.hive === 'string' ? hiveArgs.hive.trim() : '';
              if (argHive && argHive !== scopeHive) {
                return {
                  isError: true,
                  content: [{
                    type: 'text' as const,
                    text: `hive_forbidden: hive "${argHive}" is outside this session's hive "${scopeHive}".`,
                  }],
                };
              }
              if (
                toolName === 'coord:presence' &&
                (hiveArgs?.scope === 'workspace' || hiveArgs?.scope === 'all')
              ) {
                return {
                  isError: true,
                  content: [{
                    type: 'text' as const,
                    text: `hive_forbidden: coord:presence scope:'${String(hiveArgs?.scope)}' spans past this session's hive "${scopeHive}" — it reads your hive by default.`,
                  }],
                };
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
          if (idempotencyKey && !skipReplayForReadOnly) {
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
          const baseCtx = await buildMcpToolContext(dispatchSpawnCtx, progressToken, sendNotification, projected.pluginName, requestedFormat, requestedStructured, requestedDelta);
          // Legacy first-party tools (defineTool with default
          // requirePrincipal=true) hard-require ctx.principal + ctx.tx
          // in their projected wrapper (see registerLegacyAsProjected
          // in packages/agent-mcp/src/define-tool.ts:198). ANY concrete-
          // workspace call — ?superuser=1 OR a signed role-scoped agent —
          // synthesizes a principal + opens a workspace tx so those tools
          // run (a role-scoped caller is authenticated by its verified
          // signed URL). workspaceId='*' (no workspace chosen) still fails
          // those tools — caller must pass ?workspace=X. (dispatchWithSynthesizedTx
          // below applies dispatchNeedsTx itself.)
          // Generic projected-dispatch → MCP-result mapping (P-031,
          // @papercusp/tooldef-mcp). Same shape/behavior as before: success →
          // { content }, failure → { isError, content:["<code>: <message>"] }.
          // tooldef-mcp returns an SDK-neutral McpToolCallResult; cast it to the
          // mutable shape the MCP SDK's setRequestHandler accepts (same shape the
          // legacy branch below returns) at this host boundary.
          const runDispatch = async (ctx: UnifiedToolContext): Promise<McpCallResult> => {
            // The tool execution + idempotent persistence as ONE promise, so the P2-5
            // deadline can return a clean client error WITHOUT cancelling it: it
            // completes server-side + persists (P-046/EI-68), so a retry with the same
            // idempotencyKey replays the outcome instead of re-running.
            const execute = async (): Promise<McpCallResult> => {
              const result = await maybeRunWithDeltaProxy({
                sessionKey: replayOwnerKey,
                toolName,
                args: dispatchArgs,
                requestedFormat,
                explicitDelta,
                itemKeyField: projected.delta?.itemKeyField,
                runRaw: async (autoRequestedDelta, overrideDelta = true) => (await dispatchProjectedToolToMcp(
                  projected,
                  toolName,
                  dispatchArgs,
                  overrideDelta ? { ...ctx, requestedDelta: autoRequestedDelta } : ctx,
                  PROJECTED_DEPS,
                )) as McpCallResult,
              });
              // Persist the outcome BEFORE the response hits the (possibly
              // already-closed) stream — the whole point of P-046/EI-68: the
              // result must survive the transport. Best-effort.
              if (idempotencyKey && !skipReplayForReadOnly) {
                try {
                  await storeMcpResult({
                    ownerKey: replayOwnerKey,
                    idempotencyKey,
                    toolName,
                    workspaceId: dispatchSpawnCtx.workspaceId,
                    result: result as StoredMcpResult,
                  });
                } catch (err) {
                   
                  console.warn(
                    `[mcp-replay] store failed for ${toolName} (key=${idempotencyKey}): ` +
                      (err instanceof Error ? err.message : String(err)),
                  );
                }
              }
              // code-run batch nudge (code-run-token-frugality, owner directive 2026-06-23):
              // catch the eager same-tool-N× pattern at the decision point + steer the caller to
              // bundle the calls into one code:run. In-process, one-shot per (session, tool),
              // success-path only, code:run-capable callers only. The Map bump runs on every call
              // (cheap); getFlag is consulted ONLY when a hint actually fires (rare), so the hot
              // path stays a single in-memory increment. Best-effort — never affect the tool result.
              // Attached AFTER idempotent persistence so a replay serves the raw stored result.
              if (!result.isError) {
                // A delta-protocol result (`result._meta.delta` set — e.g. a delta-proxy
                // RECONSTRUCTED full body, mcp-handler-gating-matrix delta-proxy:845) carries a
                // single structured JSON payload in content[0].text that the client JSON.parses;
                // appending an advisory `[batch-hint]`/`[nudge]` text item corrupts that parse.
                // Only attach the advisory nudges to PLAIN-TEXT results.
                const canAttachAdvisory = (result._meta as Record<string, unknown> | undefined)?.delta == null;
                try {
                  // SURFACE-AWARE (code-run-self-state-adoption-2026-07-03 P-004): the old check was
                  // role-membership only, so envelope-denied roles (overwatch/sentinel) and seeded
                  // sessions whose surface lacked code:run were nudged — escalating banners included —
                  // toward a tool they could not call. canRoleActOnCodeRun folds in the envelope deny;
                  // codeRunInSurface switches the hint to the activate-first path (tools:find /
                  // tools:invoke) when the live surface lacks the tool.
                  const nudgeSurface = getSessionSurface(
                    dispatchSpawnCtx.uiClientId ?? null,
                    parseToolsAllowlist(urlFromExtra(extra)?.searchParams.get('tools')),
                  );
                  const hint = maybeBatchNudge({
                    sessionKey: replayOwnerKey,
                    toolName,
                    // P-001/P-003 (code-run-batch-adoption): args unwrap tools:invoke-routed calls
                    // to their inner tool and prefill the skeletons with the burst's real args.
                    args,
                    canCodeRun:
                      dispatchSpawnCtx.isSuperuser === true ||
                      canRoleActOnCodeRun(dispatchSpawnCtx.role),
                    codeRunInSurface: !nudgeSurface || nudgeSurface.has('code:run'),
                  });
                  // Gate PER KIND: the same-tool trigger under CODE_RUN_BATCH_NUDGE; fan-out AND
                  // pipeline (the chained variant of the same multi-tool trigger) under
                  // CODE_RUN_FANOUT_NUDGE so the multi-tool family is one independent A/B knob —
                  // telemetry records the kind verbatim, keeping pipeline vs fanout measurable.
                  // getFlag is consulted ONLY when a hint actually fires (rare).
                  if (hint && canAttachAdvisory) {
                    const nudgeFlag =
                      hint.kind === 'same-tool' ? FLAGS.CODE_RUN_BATCH_NUDGE : FLAGS.CODE_RUN_FANOUT_NUDGE;
                    if (await getFlag(nudgeFlag, 'system')) {
                      result.content = [
                        ...result.content,
                        { type: 'text' as const, text: `\n[batch-hint] ${hint.text}` },
                      ];
                      // P-005: record the fire (best-effort, fire-and-forget) so nudge→conversion
                      // is finally measurable — the A/B flags existed but fires were invisible.
                      // hint.tool = the EFFECTIVE tool (the inner verb for tools:invoke-routed
                      // calls), so fires attribute to the real verb, not the wrapper.
                      recordBatchNudgeFire({
                        sessionKey: replayOwnerKey,
                        role: dispatchSpawnCtx.role,
                        kind: hint.kind,
                        toolName: hint.tool,
                        workspaceId: dispatchSpawnCtx.workspaceId,
                      });
                    }
                  }
                } catch {
                  // nudge is purely advisory; a failure must never change the tool outcome.
                }
                // orient-dedup nudge (agent-tooling-token-efficiency P-009): catch a
                // coord:plan-events / coord:inbox / memory:search / coord:declare-intent fired right
                // after a SUCCESSFUL coord:orient — orient already returned (+ declared) exactly that
                // — and steer the caller back at orient's payload. Same in-process per-session map,
                // same injection point as the batch hint. Recording the orient timestamp is the only
                // common-path side effect; getFlag is consulted ONLY when a nudge actually fires (rare),
                // so it runs even with the flag OFF and flipping it takes effect immediately. Role-
                // agnostic (every agent uses orient). Best-effort — never affect the tool result.
                try {
                  const orientHint = maybeOrientDedupNudge({
                    sessionKey: replayOwnerKey,
                    toolName,
                  });
                  if (orientHint && canAttachAdvisory && (await getFlag(FLAGS.ORIENT_DEDUP_NUDGE, 'system'))) {
                    result.content = [
                      ...result.content,
                      { type: 'text' as const, text: `\n[nudge] ${orientHint}` },
                    ];
                  }
                } catch {
                  // advisory only; a failure must never change the tool outcome.
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
                  : `request_timeout: tool "${toolName}" exceeded ${MCP_DEADLINE_MS}ms (still running server-side — this call had no idempotencyKey, so a blind retry now risks double-applying a mutation that may already have landed. Do NOT retry yet: first re-read the current state via the matching *:get/*:list to confirm whether it landed before deciding your next step. For future calls, pass _meta.idempotencyKey up front so a timeout-retry can safely replay instead of re-executing).`,
              }],
            }));
          };
          // Establish the request-scoped workspace ALS for the duration of the
          // tool call (P-022) so handlers that resolve via `activeWorkspaceId()`
          // — harness resolution, not just the PG GUC `withWorkspace` sets — see
          // the CALLER's workspace, not the process-global `reg.current`. '*'
          // (superuser with no chosen workspace) stays unpinned.
          // Bind the tx/principal the target needs (crossWorkspace → admin handle;
          // needsTx → workspace tx) + run — the SAME helper the tools:invoke
          // re-dispatch path (dispatchTool) uses, so the two can never drift
          // (EI-6982). See dispatchWithSynthesizedTx for the P-062 crossWorkspace
          // rationale (admin handle, checked before needsTx, covers the '*'
          // discovery case).
          return await dispatchWithSynthesizedTx(projected, dispatchSpawnCtx, baseCtx, runDispatch);
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

        // EI-9011 (generalized): moment-of-failure referral — closest catalog matches +
        // the tools:find/tools:invoke routing hint (see unknown-tool-referral.ts).
        return {
          isError: true,
          content: [{ type: 'text' as const, text: unknownToolReferral(toolName) }],
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

    // ── Initialize enrichment (memory-delivery-unification-2026-07-12 P-001) ──
    // Per-session `initialize.instructions`: delegate to the SDK's own stored
    // initialize handler (negotiation + client-info side effects stay
    // SDK-owned), then append the session-start memory prelude — user +
    // harness mem0 recall (harness-identity query per D-005) + the
    // agent-insights index. Auth-gated: a failed OR bare (`kind:'none'`)
    // spawn context gets the static text only — memories must never leak to
    // an unauthenticated probe. Deadline-bounded + never-throws: a slow or
    // broken memory backend can never stall or break session establishment.
    const sdkInitialize = takeStoredInitializeHandler(server.server);
    if (sdkInitialize) {
      // The wrapper is (req: unknown, extra: unknown) => Promise<unknown> —
      // deliberately SDK-shape-agnostic (it delegates to and returns the SDK's
      // OWN stored handler result, so the runtime shape is exactly what the
      // SDK produced; pinned against the real SDK in
      // __tests__/mcp-initialize-enrich.test.ts). The cast below only
      // re-admits the result type the wrapper's `unknown` erased.
      type StoredInitializeHandler = Parameters<typeof server.server.setRequestHandler>[1];
      server.server.setRequestHandler(
        sdk.InitializeRequestSchema,
        wrapInitializeWithInstructions(sdkInitialize, async (base, extra) =>
          raceDeadline(
            INITIALIZE_ENRICH_DEADLINE_MS,
            async () => {
              const spawnRes = await tryBuildSpawnContext(extra);
              if (spawnRes.kind !== 'ok') return null;
              const user = await getSessionUserOrDefault();
              const ctxWorkspace = spawnRes.ctx.workspaceId;
              const ctxHarness = spawnRes.ctx.harnessSlug;
              const prelude = await buildMcpPrelude({
                userId: user.id,
                workspaceId:
                  ctxWorkspace && ctxWorkspace !== '*' ? ctxWorkspace : activeWorkspaceId(),
                url: urlFromExtra(extra),
                // WI-4393: ctx.harnessSlug already resolved header (OMP)-vs-URL-param
                // (claude/codex) precedence in tryBuildSpawnContext — pass it explicitly
                // rather than making buildMcpPrelude re-parse `?harness=` alone, which
                // OMP's static per-launch URL never carries.
                harnessSlug: ctxHarness && ctxHarness !== '*' ? ctxHarness : null,
                insightsDir: INSIGHTS_DIR,
                // P-002 epoch dedup identity: the per-launch SID (uiClientId),
                // so initialize stamps the same ledger the turn-start/claim
                // ports will dedup against.
                ...(spawnRes.ctx.uiClientId ? { sessionId: spawnRes.ctx.uiClientId } : {}),
              });
              if (!prelude?.text) return null;
              return base ? `${base}\n\n${prelude.text}` : prelude.text;
            },
            () => null,
          ),
        ) as StoredInitializeHandler,
      );
    }

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
  let keepalive: ManagedHandle | undefined;
  const stopKeepalive = (): void => {
    if (keepalive) {
      keepalive.stop();
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
        keepalive = managedSetInterval('mcp-sse-keepalive', keepaliveMs, () => {
          if (cancelled || closed) return;
          try {
            controller.enqueue(SSE_KEEPALIVE);
          } catch {
            stopKeepalive(); // controller closed/errored between checks — stop pinging
          }
        }, { category: 'lifecycle', instanced: true });
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

// P-010 admission control (mcp-reliability-hardening-2026-07-11): shed a tools/call
// PRE-DISPATCH with 429+Retry-After when the loop is critically saturated; the P-005
// proxy absorbs the 429 so the agent just waits. Pure decision logic + the full
// rationale live in ./mcp-admission (kept out of this heavy side-effect module so it's
// unit-testable). Fail-open when no lag monitor is running (loopPressure() → 'ok').
const mcpHandler = async (req: Request): Promise<Response> => {
  const shed = await evaluateAdmission(req, loopPressure(), ADMISSION_CONTROL_ENABLED);
  if (shed) return shed;
  return primeSseResponse(await handler(req));
};

export { mcpHandler };
