/**
 * coord:escalations — list open / resolved escalation records.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listEscalationsPaginated } from '../escalations';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:escalations',
  description:
    'List escalations addressed to the human — NEWEST-FIRST and bounded at the storage layer (EI-1548: never loads the whole backlog into memory). Default page 50, max 500. Filter by status=open / status=resolved. ⚠ `total`/`count` are JUST the size of THIS page (== `escalations.length`) — they are NOT the backlog size, and a small maxRecords silently produces a small `total` that looks like ground truth (EI-16170: a maxRecords:10 open-scan read `total:2` as "only 2 escalations open" when 279+ were actually open). `truncated:true` means older escalations exist beyond the window. For status=open, use `trueOpenTotal` (an unbounded exact count) as the real backlog size — never `total`/`count` for that purpose — and page the WHOLE backlog with `offset` (0, then +maxRecords, …) until `truncated:false`: sum of pages == trueOpenTotal (EI-18712273081050373 — for status=open `offset` slices the exact materialized open set, so it is REAL backward pagination, unlike a bare maxRecords bump which only widens a fixed recency window and can never reach an old escalation buried under newer, fast-resolving traffic). `offset` is a no-op for status=resolved / unfiltered reads (those still page by widening maxRecords only). A record whose `body` exceeds 500 chars is truncated in list mode (`bodyTruncated:true` + the original `bodyLength`) so a page of fat bodies cannot reproduce the original ~9MB dump.',
  guidance: {
    when: 'Showing the human inbox; diagnostics; checking your own past escalations.',
    notWhen: 'A specific msg_id you already have — there is no escalation read-by-id tool yet; coord:escalations + filter is enough at current volumes.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    status: z.enum(['open', 'resolved']).optional(),
    maxRecords: z.number().int().min(1).max(500).optional().describe('Max records per call (default 50, max 500)'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Page offset into the true open set (status=open only) — 0 for the first page, then +maxRecords each call, until truncated:false. No effect for status=resolved / unfiltered reads.',
      ),
  }),
  async handler(args) {
    const result = await listEscalationsPaginated({
      status: args.status,
      maxRecords: args.maxRecords,
      offset: args.offset,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            escalations: result.escalations,
            count: result.escalations.length,
            total: result.total,
            trueOpenTotal: result.trueOpenTotal,
            truncated: result.truncated,
            offset: result.offset,
            note: result.truncated
              ? result.offset !== undefined && result.trueOpenTotal !== undefined
                ? `Page [${result.offset}, ${result.offset + result.escalations.length}) of the true open backlog (trueOpenTotal:${result.trueOpenTotal}). Pass offset:${result.offset + result.escalations.length} to page further — do NOT just raise maxRecords, it will not reach older rows.`
                : `Bounded to a window of up to ${args.maxRecords ?? 50} most-recent escalation events (older ones exist beyond this window). Raise maxRecords (max 500) or filter by status to page further.${result.trueOpenTotal !== undefined ? ` The TRUE open backlog size is trueOpenTotal:${result.trueOpenTotal} — use that, not total/count, as ground truth.` : ''}`
              : undefined,
          }),
        },
      ],
    };
  },
});
