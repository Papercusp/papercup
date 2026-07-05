/**
 * Structured search filters — the host-side half of @papercusp/search's
 * filter bag (session-search-scope-2026-07-05 P-002, D-002 + D-003).
 *
 * The generic lib stays domain-free: it takes a flat `owners` set + scalar
 * turn filters. THIS module resolves the Papercusp domain concepts into that
 * shape:
 *   * owner:'self'   → the caller's coord ownerId (resolveAgentIdentity)
 *   * fleet:<slug>   → the fleet's EVER-members from the APPEND-ONLY
 *                      fleet_membership_events ledger (D-002: never live
 *                      presence — ended members lose their fleet_slug and get
 *                      presence-reaped, which would silently drop exactly the
 *                      dead members a postmortem needs)
 *   * session:'self' → the caller's live transcript (self-session.ts), which
 *                      is ALSO force-tailed (ingestFileNow) so the last
 *                      minutes are indexed at read time — the client-neutral
 *                      compaction-recovery freshness guarantee.
 */

import { z } from 'zod';
import type { Sql } from 'postgres';
import type { SearchFilters } from '@papercusp/search';

/** Shared zod arg fragments for search:fulltext / search:semantic / sessions:search. */
export const searchFilterArgs = {
  owner: z
    .string()
    .max(120)
    .optional()
    .describe(
      "Restrict to turns/messages attributed to one agent ownerId. Pass 'self' for the calling agent.",
    ),
  fleet: z
    .string()
    .max(80)
    .optional()
    .describe(
      'Restrict to agents who were EVER members of this fleet (resolved from the append-only membership ledger — includes dead/ended members; a postmortem-safe filter).',
    ),
  speaker: z
    .enum(['user', 'assistant'])
    .optional()
    .describe('Restrict transcript hits to one side of the conversation.'),
  session: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Restrict to one session id. Pass 'self' for the calling agent's CURRENT session — your pre-compaction turns are searchable this way (they survive on disk).",
    ),
  source_kind: z
    .enum(['claude', 'omp', 'codex', 'agent_chat'])
    .optional()
    .describe('Restrict transcript hits to one client/source.'),
  since: z.string().max(40).optional().describe('ISO timestamp lower bound (inclusive).'),
  until: z.string().max(40).optional().describe('ISO timestamp upper bound (exclusive).'),
};

export interface SearchFilterArgValues {
  owner?: string;
  fleet?: string;
  speaker?: 'user' | 'assistant';
  session?: string;
  source_kind?: 'claude' | 'omp' | 'codex' | 'agent_chat';
  since?: string;
  until?: string;
}

export interface ResolvedSearchFilters {
  /** undefined when no filter arg was passed — the no-narrowing fast path. */
  filters?: SearchFilters;
  /** Set when session:'self' resolved to a live transcript (for live-tail + read-back). */
  selfSession?: { sourceKind: string; sessionId: string; filePath: string } | null;
}

function isoOrUndefined(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return Number.isNaN(new Date(v).getTime()) ? undefined : v;
}

/**
 * Resolve tool-arg filters → the engine's SearchFilters. `callerOwnerId` backs
 * the 'self' sugars; pass '' when the surface has no agent identity (filters
 * needing 'self' then resolve to nothing rather than erroring).
 */
export async function resolveSearchFilters(
  sql: Sql,
  args: SearchFilterArgValues,
  callerOwnerId: string,
  opts?: { workspaceId?: string; liveTailSelf?: boolean },
): Promise<ResolvedSearchFilters> {
  const anySet =
    args.owner || args.fleet || args.speaker || args.session || args.source_kind || args.since || args.until;
  if (!anySet) return {};

  const owners = new Set<string>();
  if (args.owner) owners.add(args.owner === 'self' ? callerOwnerId : args.owner);

  if (args.fleet) {
    // EVER-members from the append-only ledger (D-002). Workspace-scoped with
    // the 'default' fallback used by host-global rows.
    const ws = opts?.workspaceId ?? '';
    const rows = await sql<Array<{ owner_id: string }>>`
      SELECT DISTINCT owner_id FROM harness_shared.fleet_membership_events
       WHERE fleet_slug = ${args.fleet}
         AND (${ws} = '' OR workspace_id = ${ws} OR workspace_id = 'default')
    `;
    for (const r of rows) if (r.owner_id) owners.add(r.owner_id);
    // An unknown fleet resolves to NO owners — surface that as an impossible
    // filter (empty results) rather than silently ignoring the narrowing.
    if (!rows.length && !args.owner) owners.add('__no_such_fleet__');
  }

  let sessionId = args.session;
  let selfSession: ResolvedSearchFilters['selfSession'];
  if (args.session === 'self') {
    const { resolveSelfSession } = await import('../../search/self-session');
    selfSession = await resolveSelfSession(callerOwnerId);
    sessionId = selfSession?.sessionId ?? undefined;
    if (selfSession && opts?.liveTailSelf !== false) {
      // Read-time freshness (D-002): force-tail the caller's own file so the
      // last minutes are indexed before we search. One file — bounded + cheap.
      try {
        const { ingestFileNow } = await import('../../search/session-ingest');
        await ingestFileNow(selfSession.filePath);
      } catch {
        /* fail-soft: the 2-min tick covers it */
      }
    }
    if (!selfSession && !owners.size && callerOwnerId) {
      // Couldn't pin the file (e.g. an omp session without a resume uuid) —
      // degrade to "my turns" via the owner column.
      owners.add(callerOwnerId);
    }
  }

  const filters: SearchFilters = {};
  if (owners.size) filters.owners = [...owners];
  if (args.speaker) filters.speaker = args.speaker;
  if (sessionId && sessionId !== 'self') filters.sessionId = sessionId;
  if (args.source_kind) filters.sourceKind = args.source_kind;
  const since = isoOrUndefined(args.since);
  const until = isoOrUndefined(args.until);
  if (since) filters.since = since;
  if (until) filters.until = until;

  return { filters: Object.keys(filters).length ? filters : undefined, selfSession };
}
