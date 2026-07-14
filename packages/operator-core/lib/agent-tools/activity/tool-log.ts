/**
 * activity:tool-log — the bare tool-call log surface
 * (deterministic-context-carry-2026-07-14 P-013).
 *
 * A DETERMINISTIC compact render of a session's tool ledger: one ~10–15-token
 * line per call (normalized name + primary target + ✓/✗), consecutive runs
 * collapsed, and over-budget history decayed to per-tool counts + a top-K
 * touched-set (errors out-age successes). The token-cheap answer to "what did
 * this session actually DO" — for a successor after compaction, a fleet peer,
 * or the Phase-4 carry-doc builder (which consumes the same lib in-process).
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { toolCallRowsFor } from '../../tool-call-log-store';
import { dedupeToolCalls, renderToolCallLog } from '../../tool-call-log';

export default defineTool({
  name: 'activity:tool-log',
  profile: 'engineer',
  description:
    "Compact deterministic tool-call log for a session or owner: one short line per call (tool + primary target + ✓/✗), consecutive same-tool runs collapsed ×N, over-budget history decayed to per-tool counts + top-K touched files/commands (error lines survive longest). Rendered from the same ledger activity:recent reads, at a fraction of the tokens — the post-compaction / peer-catch-up view of what a session actually did.",
  capability: 'activity:read',
  guidance: {
    when: "You want the cheap chronological picture of what a session DID (yours pre-compaction, or a peer's) — not the full row stream. Pass owner:'self' for your own trail; since to window it.",
    notWhen: 'For raw rows with detail payloads use `activity:recent`; for the agent-authored turn notes use `journal:recent`.',
    seeAlso: ['activity:recent (raw ledger rows)', 'journal:recent (per-turn journal notes)'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  rolesQuota: { operator: { perRun: 60 } },
  args: z.object({
    /** Scope to one owner (coordination id); the literal 'self' resolves you. */
    owner: z.string().min(1).max(256).optional(),
    /** Scope to one native session id. */
    session_id: z.string().min(1).max(256).optional(),
    /** Only calls strictly after this ISO timestamp. */
    since: z.string().max(64).optional(),
    /** Only calls at or before this ISO timestamp. */
    until: z.string().max(64).optional(),
    /** Itemized-line budget; older successes decay first (default 40). */
    max_lines: z.number().int().min(5).max(200).optional(),
    /** Touched-set size on the decay line (default 8). */
    top_k: z.number().int().min(1).max(25).optional(),
  }),
  async handler(args, ctx) {
    const ownerId = args.owner === 'self' ? resolveAgentIdentity(ctx).ownerId : args.owner;
    if (!ownerId && !args.session_id) {
      return {
        isError: true,
        content: [{ type: 'text', text: "scope_required: pass owner (or 'self') and/or session_id." }],
      };
    }
    const rows = await toolCallRowsFor({
      ownerId: ownerId ?? undefined,
      sessionId: args.session_id,
      sinceIso: args.since,
      untilIso: args.until,
    });
    const calls = dedupeToolCalls(rows);
    const log = renderToolCallLog(rows, { maxLines: args.max_lines, topK: args.top_k });
    return {
      data: {
        ok: true,
        calls: calls.length,
        rawRows: rows.length,
        span: rows.length
          ? { from: rows[0].createdAt ?? null, to: rows[rows.length - 1].createdAt ?? null }
          : null,
        log,
      },
    };
  },
});
