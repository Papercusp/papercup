/**
 * sessions:read — bounded window read over one indexed session
 * (session-search-scope-2026-07-05 P-006). The navigation half of the
 * search→read composition: sessions:search finds the needle, this reads
 * around it. Reads the INDEX (session_turns), never a raw file dump —
 * per-turn text is already truncated+redacted at ingest.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { sessionSearchEnabled, disabledResult, SESSION_SOURCE_KINDS } from './_shared';

const ALL_ROLES = [...SU_ROLES, 'sentinel', 'overwatch'] as const;

export default defineTool({
  name: 'sessions:read',
  crossWorkspace: true,
  capability: 'search:read',
  description:
    "Read a bounded window of turns from one indexed session transcript — around a turn (a sessions:search hit's readMore), a from/to range, or the tail. session:'self' reads YOUR OWN current session (pre-compaction turns included).",
  guidance: {
    when:
      "Following a sessions:search hit for more context, or reading where a session left off. Pass around=<turn_idx> (from the hit's provenance) or nothing for the tail.",
    notWhen:
      'Finding WHERE something was said — sessions:search. Raw un-indexed files — dev:claude_session op=read (being absorbed here).',
    chaining: 'provenance.turn_idx from sessions:search hits → around.',
    seeAlso: ['sessions:search', 'sessions:list'],
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 100 } },
  args: z.object({
    session: z.string().min(1).max(200).describe("Session id, or 'self' for the calling agent's current session."),
    source_kind: z.enum(SESSION_SOURCE_KINDS).optional().describe('Disambiguates when the same id exists under two sources; usually unnecessary.'),
    around: z.number().int().min(0).optional().describe('Center the window on this turn_idx.'),
    context: z.number().int().min(1).max(50).optional().describe('Turns each side of `around` (default 5).'),
    from_idx: z.number().int().min(0).optional(),
    to_idx: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200).optional().describe('Max turns (default 40). No range args = the session TAIL.'),
  }),
  async handler(args, ctx) {
    if (!(await sessionSearchEnabled())) return disabledResult();
    const workspaceId = ctx.workspaceId ?? '';
    const limit = args.limit ?? 40;

    let sessionId = args.session;
    let selfNote: string | undefined;
    if (args.session === 'self') {
      const { resolveSelfSession } = await import('../../search/self-session');
      const self = await resolveSelfSession(resolveAgentIdentity(ctx).ownerId ?? '');
      if (!self) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'self_session_unresolved', note: 'Could not pin your live transcript; use sessions:list { owner:"self" } to find your sessions.' }) }],
          isError: true,
        };
      }
      sessionId = self.sessionId;
      try {
        const { ingestFileNow } = await import('../../search/session-ingest');
        await ingestFileNow(self.filePath); // read-time freshness (D-002)
      } catch { /* the 2-min tick covers it */ }
      selfNote = `resolved self → ${self.sourceKind}:${self.sessionId}`;
    }

    let lo: number | null = null;
    let hi: number | null = null;
    if (typeof args.around === 'number') {
      const c = args.context ?? 5;
      lo = Math.max(0, args.around - c);
      hi = args.around + c;
    } else if (typeof args.from_idx === 'number' || typeof args.to_idx === 'number') {
      lo = args.from_idx ?? 0;
      hi = args.to_idx ?? null;
    }

    // No range → the tail: newest `limit` turns, returned in order.
    const rows = await ctx.tx<Array<{ source_kind: string; turn_idx: number; speaker: string; owner: string | null; ts: string | null; text: string }>>`
      SELECT source_kind, turn_idx, speaker, owner, ts::text AS ts, left(text, 1500) AS text
        FROM harness_shared.session_turns
       WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
         AND session_id = ${sessionId}
         AND (${args.source_kind ?? null}::text IS NULL OR source_kind = ${args.source_kind ?? null})
         AND (${lo}::int IS NULL OR turn_idx >= ${lo})
         AND (${hi}::int IS NULL OR turn_idx <= ${hi})
    ORDER BY turn_idx DESC
       LIMIT ${limit}
    `;
    rows.reverse();

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          session_id: sessionId,
          ...(selfNote ? { note: selfNote } : {}),
          turn_count: rows.length,
          turns: rows.map((r: { source_kind: string; turn_idx: number; speaker: string; owner: string | null; ts: string | null; text: string }) => ({
            turn_idx: r.turn_idx, speaker: r.speaker,
            ...(r.owner ? { owner: r.owner } : {}), ...(r.ts ? { ts: r.ts } : {}),
            text: r.text,
          })),
        }),
      }],
    };
  },
});
