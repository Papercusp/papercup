/**
 * coord:presence — list active coordination agents and what they are
 * doing right now.
 *
 * Joins the live liveness layer (harness_shared.coord_presence) with
 * the durable record (harness_shared.power_user_sessions). Sessions
 * whose heartbeat is older than 10 min are returned in `stale`, not
 * `active`. agent-coordination-architecture-v2 §4.2 / §4.3.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listPresence, sweepStalePresence } from '../presence';
import { listFederatedPresence } from '../federated-presence';
import { fetchPresenceTier1, mergeTier1, type PresenceTier1Joins } from '../presence-tier1';
import { COORD_ROLES } from '../roles';

/** Hard GC threshold: rows whose heartbeat is older than this are dead beyond
 *  any doubt (PRESENCE_STALE_MS is 10 min) and are swept on read so the roster
 *  can't grow to hundreds of long-ended sessions (the overflow source). */
const PRESENCE_GC_MS = 24 * 60 * 60 * 1000;

export default defineTool({
  name: 'coord:presence',
  description:
    'List ACTIVE coordination agents (fresh heartbeat) and their declared intent. Stale sessions (heartbeat >10 min — almost certainly ended) are summarised, not listed, unless you pass include_stale. Optionally filter by workspace.',
  guidance: {
    when: '"Who else is working right now, and on what?" — before starting work that might overlap.',
    notWhen: 'Checking whether a specific file is free — use locks:queue for that.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    workspace: z
      .string()
      .optional()
      .describe('Filter to one workspace id; omit to list all.'),
    include_stale: z
      .boolean()
      .optional()
      .describe('Also return the full stale roster (default false — stale is summarised only; the live answer is `active`).'),
  }),
  async handler(args) {
    // Best-effort GC of long-dead rows so the roster stays bounded. Concurrent
    // with the read so it adds no latency; failure never breaks the listing.
    // The federated roster (cross-machine peers from shared_presence,
    // distributed-coordination-shared-harness-2026-06-04 Phase 0.3) is merged in;
    // it is [] on a single box and best-effort, so it never breaks the listing.
    const [records, federated] = await Promise.all([
      listPresence({ workspaceId: args.workspace ?? null }),
      listFederatedPresence({ workspaceId: args.workspace ?? null }),
      sweepStalePresence(PRESENCE_GC_MS).catch(() => 0),
    ]);
    const all = [...records, ...federated];
    const active = all.filter((r) => !r.stale);
    const stale = all.filter((r) => r.stale);
    // P-003: enrich the LOCAL active rows with the Tier-1 scalars (lastActiveSecAgo
    // + claimedItems/model/awaitingEvent/wakeMode). Best-effort: a join failure
    // must never break the listing, and federated `fed:…` rows have no local
    // join (they get lastActiveSecAgo only). agentRole/hiveSlug already ride the
    // row (P-002).
    const now = Date.now();
    let joins = new Map<string, PresenceTier1Joins>();
    try {
      const localIds = active
        .filter((r) => !(r as { federated?: boolean }).federated)
        .map((r) => r.ownerId);
      joins = await fetchPresenceTier1(localIds);
    } catch {
      /* best-effort enrichment — presence must list even if a join fails */
    }
    const activeEnriched = mergeTier1(active, joins, now);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            // ONE roster-level read-time stamp (P-005 / D-006) — rows are ordered
            // by ownerId and carry no churning per-read timestamp, so the cached
            // payload stays byte-stable; `as_of` is the single freshness marker.
            as_of: new Date(now).toISOString(),
            summary: { active: active.length, stale: stale.length, federated: federated.length },
            active: activeEnriched,
            // Stale rows are almost always dead sessions; returning all of them
            // is what overflowed the token limit (233 rows). Summarise by default.
            ...(args.include_stale ? { stale } : {}),
          }),
        },
      ],
    };
  },
});
