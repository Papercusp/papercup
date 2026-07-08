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
 * Clamped against the caller's model window (context-trimming-tiers D-001):
 * `limit × 1.2 ≤ window − margin` — the spec resolves best-effort via
 * resolveModelSpecForOwner (launch argv → session settings.json). An
 * UNRESOLVABLE spec clamps to the fleet-default [1m] ceiling (400k), NOT the old
 * conservative 200k → 158k (WI-3383): on this opus[1m]-default fleet a genuine
 * small-window model is always explicitly specced, so an unknown is a 1M session.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { setCompactionLimit, getPresence } from '../coordination/presence';
import { resolveModelSpecForOwner } from '../../compaction-usage';
import { clampCompactionLimit, defaultCompactionLimitForSpec } from '../../agent-config-constants';

/** Soft limit applied when a session has set none. Read-time default (P-007).
 *  Superseded by the model-aware `defaultCompactionLimitForSpec` (context-
 *  trimming-tiers D-001 — 200k window derives 158k, ≈ this value); kept as the
 *  last-resort static fallback where no spec is in reach. */
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
        'Soft compaction limit in tokens. Clamped so limit × 1.2 stays under your model window minus margin (the ~20% overshoot allowance); overshooting the SOFT limit is safe but wasteful.',
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // Clamp to the caller's model-derived ceiling (context-trimming-tiers D-001):
    // `limit × 1.2 ≤ window − margin`, i.e. limit ≤ defaultCompactionLimitForSpec(spec).
    // The spec resolves best-effort (session settings.json → launch argv); an
    // unresolvable spec clamps to the fleet-default [1m] ceiling (400k, WI-3383) —
    // on this opus[1m]-default fleet a genuine small-window model is always
    // explicitly specced, so an unknown is a 1M session, not a haiku.
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
              note: `requested limit clamped to the model-derived ceiling (${spec ? `window for ${spec} minus margin, ÷1.2 overshoot allowance` : 'model spec unresolvable — fleet-default [1m] ceiling'})`,
            }
          : {}),
        ...(persisted == null ? { note: 'no live presence row for this session — limit not persisted' } : {}),
      },
    };
  },
});
