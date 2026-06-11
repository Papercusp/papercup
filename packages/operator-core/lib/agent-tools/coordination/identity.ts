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
  /** Role-gated fleet:spawn child — ownerId is the operator's durable `s-…`
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (ctx.isSuperuser) {
    if (!uiClientId) {
      throw new Error(
        'resolveAgentIdentity: superuser context is missing uiClientId — ' +
          're-run install-standalone-mcp.sh to mint a ?client= id',
      );
    }
    return {
      ownerId: uiClientId,
      ownerLabel: `su · ${shortId(uiClientId)}`,
      source: looksLikeBareUuid(uiClientId)
        ? 'static-client'
        : 'omp-hook-session',
      workspaceId: ctx.workspaceId ?? null,
      userId: ctx.userId ?? null,
    };
  }

  // ── In-process / principal-gated caller ────────────────────────────
  const principal = ctx.principal;
  if (principal) {
    return {
      ownerId: uiClientId ?? principal.slug,
      ownerLabel: `${principal.kind ?? 'principal'} · ${principal.slug}`,
      source: 'principal',
      workspaceId: principal.workspaceId,
      userId: null,
    };
  }

  // ── Role-gated fleet:spawn child (THE UMBILICAL) ────────────────────
  // A fleet:spawn bee connects over a SIGNED (not superuser, not power-user,
  // no bearer principal) MCP URL. fleet/operator-spawn now bakes the operator's
  // durable `s-…` spawnId as the URL's `client=` param (HMAC-signed; in the
  // allowlist), so parseRequestContext lands it in ctx.uiClientId. THAT is the
  // child's stable coord owner — the same id recorded as the spawned_agents row's
  // sessionOwner, so the bee's coord messages, file-lock owner, and fleet:cancel
  // release target all line up. Before this branch the resolver threw here and
  // every coord:send / plans:set-status / improvements:capture from a bee failed
  // (the "MUTE bee" voice gap): file edits landed, but the child couldn't speak.
  if (uiClientId) {
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
      'be attributed (a fleet:spawn child must carry its `s-…` spawnId as ' +
      'the signed MCP URL’s client= param — see fleet/operator-spawn.ts + ' +
      'spawn-mcp.ts; an invoke-route agent must connect over a VERIFIED ' +
      'signed spawn URL with harness=)',
  );
}
