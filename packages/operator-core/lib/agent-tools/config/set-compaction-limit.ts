/**
 * config:set-compaction-limit — set THIS session's soft compaction limit.
 *
 * agent-managed-compaction-2026-07-01. An agent tunes how large its context
 * grows before it steers toward a clean stopping point and self-compacts. The
 * limit is a SOFT target below the model's hard window; the live usage signal
 * (`context: N/limit (X%)`) is injected each turn, and near it the agent should
 * reach a stopping point and call `session:request_compaction`. Persisted per
 * session on `coord_presence.compaction_limit` (keyed by the session owner id).
 *
 * TODO(agent-managed-compaction D-007): clamp against the caller's model window
 * (`limit × 1.25 ≤ window − margin`) once the session model is resolvable in
 * ctx; for now a static sanity range applies (overshoot past a small window is
 * harmless — the model auto-compacts first, the soft limit just never fires).
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { setCompactionLimit, getPresence } from '../coordination/presence';

/** Soft limit applied when a session has set none. Read-time default (P-007). */
export const DEFAULT_COMPACTION_LIMIT_TOKENS = 160_000;

export default defineTool({
  name: 'config:set-compaction-limit',
  description:
    "Set THIS session's soft compaction limit (tokens) — a target below your model window; near it, reach a stopping point and call session:request_compaction. Persisted per session; visible in coord:presence.",
  capability: 'coord:write',
  guidance: {
    when: 'Tune how large your context grows before you self-compact — raise it for wide-context work, lower it to stay sharp on a tight task.',
    notWhen:
      'To compact right now — use session:request_compaction. To read your usage — it is injected each turn as `context: N/limit (X%)`.',
    seeAlso: ['session:request_compaction (compact now, at a stopping point)'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    limit: z
      .number()
      .int()
      .min(20_000)
      .max(900_000)
      .describe(
        'Soft compaction limit in tokens (below your model window; overshoot to ~125% is safe but wasteful).',
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // Clamp to the caller's model-derived ceiling (context-trimming-tiers D-001):
    // `limit × 1.2 ≤ window − margin`, i.e. limit ≤ defaultCompactionLimitForSpec(spec).
    // The spec resolves best-effort (session settings.json → launch argv); an
    // unresolvable spec clamps against the conservative 200k window — a LOW cap
    // on a big-window session is safe leanness, the reverse is a hard death.
    const spec = await resolveModelSpecForOwner(identity.ownerId).catch(() => null);
    const cap = defaultCompactionLimitForSpec(spec);
    const applied = clampCompactionLimit(args.limit, spec);
    await setCompactionLimit(identity.ownerId, applied);
    const presence = await getPresence(identity.ownerId);
    const persisted = presence?.compactionLimit ?? null;
    // { data } shape (tool-data-shape ratchet P-003): the framework owns wire encoding.
    return {
      data: {
        ok: persisted != null,
        ownerId: identity.ownerId,
        compactionLimit: persisted,
        ...(applied !== args.limit
          ? {
              clamped: true,
              requested: args.limit,
              cap,
              note: `requested limit clamped to the model-derived ceiling (window${spec ? ` for ${spec}` : ' 200k — model spec unresolvable'} minus margin, ÷1.2 overshoot allowance)`,
            }
          : {}),
        ...(persisted == null ? { note: 'no live presence row for this session — limit not persisted' } : {}),
      },
    };
  },
});
