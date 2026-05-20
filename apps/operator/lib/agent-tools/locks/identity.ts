/**
 * Resolve the calling SU agent's identity for lock ownership.
 *
 * `agent_id` (the durable UUID identity) comes from the MCP request's
 * `?client=` URL param, baked in by `install-standalone-mcp.sh`. The
 * MCP layer surfaces this as `ctx.uiClientId` (or equivalent). We fall
 * back to `principal.slug` so in-process operator callers still work.
 *
 * `owner_label` is for human display only. Built best-effort from
 * principal.slug + the agent_id tail; the trigger names of the host
 * CLI (claude-code / omp / etc.) aren't reliably surfaced through MCP,
 * so we don't try to derive a fancy "<client>@<host>:<term>" form yet.
 */

/**
 * Loose ctx type — read-only access to the fields we need. Works for
 * both `ToolContext` (principal-gated) and `UnifiedToolContext`
 * (role-gated / projected). Defined locally to avoid the cross-package
 * type bridge between agent-mcp's two ctx shapes.
 */
export interface IdentityCtx {
  principal?:
    | { kind?: string; slug: string; workspaceId: string }
    | null;
  uiClientId?: string | null;
  isSuperuser?: boolean;
}

/**
 * Default workspace id for superuser callers that don't carry a
 * principal. Matches the convention used by other operator surfaces
 * (see `apps/operator/lib/dock-layouts.ts:getUserIdForLayouts`).
 */
const SUPERUSER_DEFAULT_WORKSPACE = 'default';

export interface SuAgentIdentity {
  /** Stable durable identity — used as the `owner` column. */
  ownerId: string;
  /** Human-readable label — used as the `owner_label` column. */
  ownerLabel: string;
  /** Workspace scope from the bearer principal. */
  workspaceId: string;
}

/**
 * Read identity from the agent's tool context.
 *
 * The MCP request flow:
 *   1. install-standalone-mcp.sh writes ~/.papercusp/su-agent-id (UUID)
 *      and bakes ?client=<uuid> into the MCP server URL.
 *   2. The HTTP MCP transport surfaces ?client=<uuid> on every call as
 *      a per-call context field — read here from ctx (the projection
 *      registry attaches it as uiClientId in the unified context).
 *
 * For in-process callers without a baked client (operator chat,
 * autoloop), we fall back to principal.slug so they still get a stable
 * identity per-process.
 */
export function readIdentity(ctx: IdentityCtx): SuAgentIdentity {
  const principal = ctx.principal;
  const baked =
    ctx.uiClientId && ctx.uiClientId.length > 0 ? ctx.uiClientId : null;

  // Superuser callers (papercusp-su / install-standalone-mcp.sh) don't
  // carry a principal — the `?superuser=1` path bypasses the bearer
  // resolution that would attach one. We identify them by the baked
  // `?client=<agent_id>` URL param.
  if (!principal) {
    if (!ctx.isSuperuser) {
      throw new Error(
        'locks:* requires an authenticated principal or superuser context',
      );
    }
    if (!baked) {
      throw new Error(
        'locks:* superuser caller is missing ?client=<agent_id> ' +
          '(re-run install-standalone-mcp.sh to mint one)',
      );
    }
    return {
      ownerId: baked,
      ownerLabel: `su:${baked.slice(0, 8)}`,
      workspaceId: SUPERUSER_DEFAULT_WORKSPACE,
    };
  }

  const ownerId = baked ?? principal.slug;
  const kind = principal.kind ?? 'principal';
  const ownerLabel = baked
    ? `${kind}:${principal.slug.slice(0, 16)}@${baked.slice(0, 8)}`
    : `${kind}:${principal.slug}`;

  return {
    ownerId,
    ownerLabel,
    workspaceId: principal.workspaceId,
  };
}
