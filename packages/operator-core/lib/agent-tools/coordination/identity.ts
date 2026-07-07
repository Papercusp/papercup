/**
 * resolveAgentIdentity — the single identity primitive for the
 * coordination layer (L1). Consumed by L2 (file locks), L3 (coord:*
 * channels), the OMP hook, and the plans:* write verbs, so that a lock
 * owner, a message sender, and a plan-decision author are all the same
 * agent id.
 *
 * See apps/operator/docs/plans/agent-coordination-architecture-v2-2026-05-20.md §4.1.
 *
 * Identity is TIER-AWARE — there is no single flat fallback chain:
 *
 *   - power-user agent (?power_user=1): the canonical id is the
 *     auth_session_id ("pus-<uuid>") minted at session launch. The
 *     ?power_user=1 route branch sets ctx.uiClientId to exactly that
 *     (apps/operator/app/api/[transport]/route.ts:225), so
 *     ctx.uiClientId IS the agent id. The MCP transport's
 *     Mcp-Session-Id is NOT consulted — it is the transport handshake,
 *     not the agent.
 *
 *   - engineer / superuser agent (?superuser=1): no auth_session_id
 *     exists. The route's superuser branch already folds the
 *     per-session identity into ctx.uiClientId (the Mcp-Session-Id
 *     header, else the ?client=<uuid> install-script machine id). So
 *     here too ctx.uiClientId is the resolved id — the route did the
 *     tier work upstream.
 *
 *   - in-process callers (operator chat, autoloop) carry a bearer
 *     principal but no uiClientId; they fall back to principal.slug.
 *
 * Because the per-transport route already populates ctx.uiClientId
 * correctly per tier, this function is a typed read + label
 * construction; the tier-awareness is reflected in the `source` field
 * and in which ctx fields carry the workspace / user.
 *
 * NEVER derive identity from ctx.runId / ctx.spawnId — both regenerate
 * on every MCP call (omp-power-user-bundle-brief-2026-05-20.md §3).
 */

/**
 * Loose, structural ctx type — the fields this resolver reads. Works
 * for both agent-mcp ctx shapes (principal-gated `ToolContext` and the
 * role/spawn-gated unified context). Defined locally to avoid the
 * cross-package type bridge — same approach as the sibling
 * `agent-tools/locks/identity.ts`.
 */
export interface ResolveIdentityCtx {
  /** Per-tier resolved client id, set by the transport route.
   *  Power-user: the auth_session_id. Superuser: Mcp-Session-Id || ?client=. */
  uiClientId?: string | null;
  isSuperuser?: boolean;
  isPowerUser?: boolean;
  /** Workspace the call is clamped to (power-user) or scoped to. */
  workspaceId?: string | null;
  /** The acting-as human user, when the agent has a power-user token. */
  userId?: string | null;
  /** Bearer principal — present for in-process / role-gated callers. */
  principal?: { kind?: string; slug: string; workspaceId: string } | null;
  /** Harness slug from the spawn URL — read ONLY by the signed-spawn branch. */
  harnessSlug?: string | null;
  /**
   * True when the transport VERIFIED the spawn URL's HMAC (never set for
   * unsigned soft-allowed URLs) — see _mcp-handler.ts branch (2). Keys the
   * signed-spawn attribution for client=-less invoke-route agents.
   */
  sigVerifiedSpawn?: boolean;
}

export type IdentitySource =
  /** Power-user OMP session — ownerId is the auth_session_id. */
  | 'power-user-token'
  /** Superuser engineer session — ownerId is the per-session id. */
  | 'omp-hook-session'
  /** Superuser engineer whose id is a bare ?client= machine UUID. */
  | 'static-client'
  /** In-process caller identified by its bearer principal. */
  | 'principal'
  /** Role-gated cup:spawn child — ownerId is the operator's durable `s-…`
   *  spawnId, baked as the signed MCP URL's `client=` param. */
  | 'fleet-spawn'
  /** Verified signed spawn WITHOUT a client= owner id (invoke-route agents:
   *  promote/scoper/expert) — attributed to the stable harness slug
   *  (promote-policy-and-waves-2026-05-30 D-002, owner option (c)). */
  | 'signed-spawn';

export interface AgentIdentity {
  /** Stable per-agent id. Power-user: auth_session_id ("pus-<uuid>"). */
  ownerId: string;
  /** Human-readable label — display only, never keyed on. */
  ownerLabel: string;
  /** Where the identity came from — debug aid. */
  source: IdentitySource;
  /** Papercusp workspace, when the ctx carries one. */
  workspaceId: string | null;
  /** Acting-as human user, when known (power-user tier). */
  userId: string | null;
}

/**
 * Derive the agent's durable ROLE for presence-v2 (D-004). Role isn't stored on
 * the identity today — it's surrogated by `source`. The explicit
 * `PAPERCUSP_AGENT_ROLE` env wins when a spawn sets the FINE role (e.g.
 * scoper/worker/validator); otherwise map `source` to a COARSE role. This is the
 * "resolveAgentIdentity.role / env" source named in presence-v2 P-002.
 */
export function deriveAgentRole(identity: AgentIdentity): string | null {
  const env =
    typeof process !== 'undefined' ? (process.env?.PAPERCUSP_AGENT_ROLE ?? '').trim() : '';
  if (env) return env;
  switch (identity.source) {
    case 'power-user-token':
      return 'human';
    case 'omp-hook-session':
    case 'static-client':
      return 'su';
    case 'fleet-spawn':
    case 'signed-spawn':
      return 'cup';
    case 'principal':
      return 'principal';
    default:
      return identity.source || null;
  }
}

/** The agent's named-fleet membership (named-su-agent-fleets-2026-06-29 P-005). */
export interface FleetMembership {
  /** The named-fleet slug the process is pinned to (PAPERCUSP_FLEET_SLUG), or null
   *  when the agent is in no fleet. */
  fleetSlug: string | null;
  /** Role within the fleet — 'leader' | 'member' (designed extensible); defaults to
   *  'member' when a fleet is pinned without an explicit role, null when no fleet. */
  fleetRole: string | null;
}

/**
 * Derive the agent's named-fleet membership from the env the launcher pins
 * (named-su-agent-fleets-2026-06-29 P-005 / D-003) — PAPERCUSP_FLEET_SLUG +
 * PAPERCUSP_FLEET_ROLE, the per-process mirror of the account pin. Membership is a
 * SOFT presence label (written onto coord_presence by the presence write path, the
 * per-agent mirror of hive_slug); this env read is its SOURCE — consumed by the
 * presence write and surfaced by coord:whoami. A fleet pinned WITHOUT an explicit
 * role defaults to 'member' (the creator / handoff path pins 'leader', D-002); no
 * slug ⇒ no fleet (both null). Mirrors `deriveAgentRole`'s env read.
 */
export function deriveFleetMembership(): FleetMembership {
  const slug =
    typeof process !== 'undefined' ? (process.env?.PAPERCUSP_FLEET_SLUG ?? '').trim() : '';
  if (!slug) return { fleetSlug: null, fleetRole: null };
  const role =
    typeof process !== 'undefined' ? (process.env?.PAPERCUSP_FLEET_ROLE ?? '').trim() : '';
  return { fleetSlug: slug, fleetRole: role || 'member' };
}

/**
 * Default coordination domain for callers without a workspace. The
 * coordination *domain* (the L2 lock partition) is per-machine, not
 * per-workspace — see the v2 plan §5 / OMP-bundle brief §7 — but a
 * caller still needs *a* string; this is it.
 */
export const COORDINATION_DEFAULT_DOMAIN = 'default';

/**
 * The coord owner-id the human's admin coord UI (`/api/admin/coord/*`) acts as
 * when the human resolves/acks from the Planning inbox. A stable, human-side
 * identity — distinct from any pipeline agent's ownerId — so the inbox dismisses
 * exactly the messages the HUMAN acked and an agent's ack of a broadcast can't
 * suppress them. The admin coord route (its `?client=`) and the inbox
 * ack-dismiss filter both key off this single constant.
 */
export const ADMIN_COORD_UI_OWNER = 'pc-admin-coord-ui';

/**
 * Stable fallback coordination id for an ADMITTED superuser ctx that carries no
 * per-session uiClientId — no Mcp-Session-Id header and no `?client=` machine id
 * (the loopback HTTP/curl bridge, or an in-process superuser MCP call that never
 * threaded one).
 *
 * By the time `ctx.isSuperuser` is true the caller has ALREADY cleared the
 * superuser admission gate (loopback origin + the on-disk bearer token — see the
 * http-projection `validateSuperuser` branch), so it is "the machine admin": a
 * single fixed, attributable identity, the same stability class as a `?client=`
 * machine UUID. The superuser branch is NOT one of the impersonation guards
 * (those are the unverified-`client=` fleet/signed-spawn branches, EI-311/EI-318);
 * a missing uiClientId here only ever meant "couldn't find a per-session id".
 *
 * EI-2127 / EI-334: the superuser branch used to THROW on a missing uiClientId,
 * so every identity-resolving tool (db:next-migration, coord:whoami, coord:send,
 * locks:*, plans:set-status, …) failed deterministically from a client-less
 * superuser context. The transport-level `su-http-loopback` default
 * (http-projection.ts) covered ONLY the JSON HTTP path; resolving the fallback
 * HERE — in the single L1 identity primitive — covers EVERY transport uniformly
 * so no transport can forget it.
 */
export const SUPERUSER_FALLBACK_CLIENT_ID = 'su-loopback';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The AUTO-GENERATED fallback client id `scripts/mcp-call.mjs` mints when the
 * caller passes no `--client` of their own: `mcp-call-${process.pid}`. It is
 * emitted per-invocation and the node process that made the single stateless
 * `tools/call` request has already EXITED by the time the caller reads the
 * response — there is no coord_presence heartbeat loop, no fleet:spawn row, no
 * liveness behind it whatsoever, ever. It resolves through the ordinary
 * superuser branch above (a `client=` that is not a bare UUID → 'omp-hook-
 * session'), so structurally it is indistinguishable from a real, live su
 * session's per-session id — the ONLY signal is this literal naming pattern.
 *
 * EI-8509: a prior Mug wake used the raw mcp-call.mjs fallback (documented as
 * a recovery path for when MCP tools are genuinely unusable — see the script's
 * header) to PLACE routine work-item claims, without ever passing its own
 * `--client`. Each claim landed under a fresh `mcp-call-<pid>` identity that
 * was already gone by the next tick, so the claim looked "placed" (assignee
 * set, claim row present) but nothing was ever spawned to execute it — a
 * silent no-op placement that only an audit caught, hours later.
 */
const EPHEMERAL_MCP_CALL_RE = /^mcp-call-\d+$/;

/**
 * True when `ownerId` is the mcp-call.mjs AUTO-GENERATED fallback identity
 * (see EPHEMERAL_MCP_CALL_RE doc above) — never a real fleet cup, never able
 * to heartbeat or make progress. Claim/lease call sites use this to refuse an
 * IMPLICIT self-claim under this identity (the same shape as the
 * `SUPERUSER_FALLBACK_CLIENT_ID` guard) so a raw one-shot mcp-call invocation
 * can no longer silently "place" work that nothing will ever execute. An
 * EXPLICIT `assignee` (a real agent id the caller names on purpose) is never
 * blocked by this check — only the implicit "claim for whoever I am" path is.
 */
export function isEphemeralMcpCallIdentity(ownerId: string | null | undefined): boolean {
  return Boolean(ownerId) && EPHEMERAL_MCP_CALL_RE.test(ownerId as string);
}

/** Cosmetic short form for owner labels. Never used for identity. */
function shortId(id: string): string {
  if (id.startsWith('pus-')) return id.slice(0, 12);
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** A bare ?client= machine id is a plain UUID; a per-session id is not. */
function looksLikeBareUuid(id: string): boolean {
  return UUID_RE.test(id);
}

/**
 * Resolve the calling agent's coordination identity. Throws when the
 * ctx carries no attributable identity at all — coordination writes
 * MUST be attributable, so a missing identity is a hard error, not a
 * silent anonymous write.
 */
export function resolveAgentIdentity(ctx: ResolveIdentityCtx): AgentIdentity {
  const uiClientId =
    ctx.uiClientId && ctx.uiClientId.length > 0 ? ctx.uiClientId : null;

  // ── Power-user agent ───────────────────────────────────────────────
  // ctx.uiClientId is the auth_session_id ("pus-<uuid>").
  if (ctx.isPowerUser) {
    if (!uiClientId) {
      throw new Error(
        'resolveAgentIdentity: power-user context is missing uiClientId ' +
          '(auth_session_id) — the ?power_user=1 route branch must set it',
      );
    }
    return {
      ownerId: uiClientId,
      ownerLabel: `omp · ${shortId(uiClientId)}`,
      source: 'power-user-token',
      workspaceId: ctx.workspaceId ?? null,
      userId: ctx.userId ?? null,
    };
  }

  // ── Superuser engineer agent ───────────────────────────────────────
  // The route already folded Mcp-Session-Id / ?client= into uiClientId.
  // A bare ?client= machine UUID and a real per-session id are
  // indistinguishable here — both are stable per OS process, which is
  // all the coordination layer needs.
  //
  // EI-2127: an admitted superuser that carries NO per-session id (no
  // Mcp-Session-Id, no ?client=) is still attributable — admission already
  // proved the machine admin — so resolve a stable fallback id instead of
  // throwing. Throwing here broke every identity-resolving tool (db:next-
  // migration, coord:whoami, coord:send, …) from a client-less superuser
  // context. See SUPERUSER_FALLBACK_CLIENT_ID. (A real per-session id, when
  // present, always wins — the fallback is the no-client case only.)
  if (ctx.isSuperuser) {
    const suClientId = uiClientId ?? SUPERUSER_FALLBACK_CLIENT_ID;
    return {
      ownerId: suClientId,
      ownerLabel: `su · ${shortId(suClientId)}`,
      source: looksLikeBareUuid(suClientId)
        ? 'static-client'
        : 'omp-hook-session',
      workspaceId: ctx.workspaceId ?? null,
      userId: ctx.userId ?? null,
    };
  }

  // ── In-process / principal-gated caller ────────────────────────────
  const principal = ctx.principal;
  if (principal) {
    // A `system:<role>` principal IS a loop role (queen/overwatch/scout…) — label
    // it ROLE-first so the roster reads "queen · …" instead of the invisible
    // "principal · system:queen" (owner kept asking "why don't I see the
    // queen/overwatch running?" while both were live in the roster, 2026-07-01).
    // Labels are display-only, never keyed on (see module header).
    const sysRole = /^system:(.+)$/.exec(principal.slug)?.[1];
    return {
      ownerId: uiClientId ?? principal.slug,
      ownerLabel: sysRole
        ? `${sysRole} · ${ctx.harnessSlug ?? 'system'}`
        : `${principal.kind ?? 'principal'} · ${principal.slug}`,
      source: 'principal',
      workspaceId: principal.workspaceId,
      userId: null,
    };
  }

  // ── Role-gated cup:spawn child (THE UMBILICAL) ────────────────────
  // A cup:spawn bee connects over a SIGNED (not superuser, not power-user,
  // no bearer principal) MCP URL. fleet/operator-spawn bakes the operator's
  // durable `s-…` spawnId as the URL's `client=` param (HMAC-signed; in the
  // allowlist), so parseRequestContext lands it in ctx.uiClientId. THAT is the
  // child's stable coord owner — the same id recorded as the spawned_agents row's
  // sessionOwner, so the bee's coord messages, file-lock owner, and fleet:cancel
  // release target all line up. Before this branch the resolver threw here and
  // every coord:send / plans:set-status / improvements:capture from a bee failed
  // (the "MUTE bee" voice gap): file edits landed, but the child couldn't speak.
  //
  // EI-318: this client= is only an IDENTITY when the transport VERIFIED it —
  // `sigVerifiedSpawn` means the MCP handler checked the spawn URL's HMAC (which
  // covers the allow-listed `client` param). The public HTTP catch-all
  // (/api/agent-tools/*, auth:'public') reads a bare `?client=` query param and
  // NEVER sets this flag, so a loopback `curl …?client=opspawn-…` could
  // previously forge ANY agent's coord/work-item writes (the EI-311 identity
  // fork — a degraded bee curled the operator with its run-id and the claim
  // stuck under the wrong owner). Without verification we fall through to the
  // hard error below: an unattributable write is REJECTED, never impersonated.
  if (uiClientId && ctx.sigVerifiedSpawn) {
    return {
      ownerId: uiClientId,
      ownerLabel: `bee · ${shortId(uiClientId)}`,
      source: 'fleet-spawn',
      workspaceId: ctx.workspaceId ?? null,
      userId: ctx.userId ?? null,
    };
  }

  // ── Verified signed spawn WITHOUT client= (invoke-route agents) ──────
  // promote-policy-and-waves D-002 (owner, 2026-06-10), option (c): a spawn
  // whose URL HMAC VERIFIED but carries no client= owner id attributes to the
  // STABLE harness slug — least privilege (no su/power grant) and never the
  // per-call spawnId/runId (the header rule above). Concurrent agents on one
  // harness deliberately share this id: the slug is the stable unit. The
  // `harness:` prefix keeps it distinct from an in-process principal's bare
  // slug ownerId, so an invoke-route agent and the operator's own in-process
  // calls never conflate. The unscoped '*' session mints nothing — a
  // workspace-level signed session has no harness to attribute to.
  if (ctx.sigVerifiedSpawn && ctx.harnessSlug && ctx.harnessSlug !== '*') {
    return {
      ownerId: `harness:${ctx.harnessSlug}`,
      ownerLabel: `harness · ${ctx.harnessSlug}`,
      source: 'signed-spawn',
      workspaceId: ctx.workspaceId ?? null,
      userId: null,
    };
  }

  throw new Error(
    'resolveAgentIdentity: context carries no power-user / superuser / ' +
      'principal / fleet-spawn / signed-spawn identity — the caller cannot ' +
      'be attributed (a cup:spawn child must carry its `s-…` spawnId as ' +
      'the signed MCP URL’s client= param, VERIFIED — a bare unverified ' +
      'client= over the public HTTP path is NOT an identity, EI-318; see ' +
      'fleet/operator-spawn.ts + spawn-mcp.ts; an invoke-route agent must ' +
      'connect over a VERIFIED signed spawn URL with harness=)',
  );
}
