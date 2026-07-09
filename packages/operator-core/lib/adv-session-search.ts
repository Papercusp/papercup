/**
 * adv-session-search.ts — pure grouping/classification for the agents-pill
 * transcript search (agents-pill-inactive-search-2026-07-09 P-002).
 *
 * The GET /api/adv/sessions/search-transcripts route runs the SHARED search
 * engine (`runHybridSearch` over the `session_turn` source — the same
 * @papercusp/search registry the `sessions:search` agent tool and
 * /api/user/search use; reuse-first, never a forked searcher). This module is
 * the pure half: turn-level hits → per-SESSION groups → classified against the
 * live roster (active, fleet-grouped downstream) and adv_sessions rows
 * (inactive) so the popover can render active-by-fleet first, then inactive.
 * Pure — unit-tests without PG.
 */

import type { RosterEntry } from './adv-roster';
import type { AdvSessionRow } from './adv-sessions';

/** One matched transcript turn (a session_turns row that hit the query). */
export interface TranscriptTurnHit {
  sourceKind: string;
  sessionId: string;
  turnIdx: number;
  /** First ~200 chars of the matched turn (engine excerpt). */
  excerpt: string;
  /** ts_headline snippet — matched terms wrapped in <mark>. */
  highlight: string;
  score: number;
  /** Stamped from session_turns metadata (hydrated by the route). */
  ts?: string | null;
  speaker?: string | null;
  owner?: string | null;
}

/** Turn hits rolled up to their owning session, best score first. */
export interface SessionHitGroup {
  sourceKind: string;
  sessionId: string;
  topScore: number;
  hits: TranscriptTurnHit[];
}

/** A session group classified for display: `active` = the live roster entry
 *  (popover groups these by fleet, same as the running roster); `session` =
 *  the matched adv_sessions row (metadata + the codex open-key `id`); both
 *  null ⇒ a transcript with no recorded session row (still openable for
 *  claude/omp/codex via the transcript handles). */
export interface ClassifiedSessionHits {
  sourceKind: string;
  sessionId: string;
  topScore: number;
  hits: TranscriptTurnHit[];
  active: RosterEntry | null;
  session: AdvSessionRow | null;
}

/**
 * Roll turn-level hits up to sessions: one group per (sourceKind, sessionId),
 * groups ordered by their best hit's score, hits within a group score-desc and
 * capped at `maxHitsPerSession` (the popover shows a few excerpts per session,
 * not every matching turn). Pure.
 */
export function groupHitsBySession(
  hits: readonly TranscriptTurnHit[],
  maxHitsPerSession = 3,
): SessionHitGroup[] {
  const byKey = new Map<string, SessionHitGroup>();
  for (const h of hits) {
    const key = `${h.sourceKind}:${h.sessionId}`;
    let g = byKey.get(key);
    if (!g) {
      g = { sourceKind: h.sourceKind, sessionId: h.sessionId, topScore: h.score, hits: [] };
      byKey.set(key, g);
    }
    g.hits.push(h);
    if (h.score > g.topScore) g.topScore = h.score;
  }
  for (const g of byKey.values()) {
    g.hits.sort((a, b) => b.score - a.score);
    if (g.hits.length > maxHitsPerSession) g.hits = g.hits.slice(0, maxHitsPerSession);
  }
  return [...byKey.values()].sort((a, b) => b.topScore - a.topScore);
}

/** The live roster entry a hit-session belongs to, if any: matched by the
 *  transcript handle (claude session uuid / omp thread id) or — for claude
 *  isolation-dir transcripts — the owning agent's coord ownerId. Pure. */
export function matchActiveEntry(
  group: Pick<SessionHitGroup, 'sourceKind' | 'sessionId' | 'hits'>,
  active: readonly RosterEntry[],
): RosterEntry | null {
  const sid = group.sessionId;
  const owner = group.hits.find((h) => h.owner)?.owner ?? null;
  for (const a of active) {
    const e = a as unknown as { sessionId?: string | null; ompThreadId?: string | null; ownerId?: string };
    if (group.sourceKind === 'claude' && e.sessionId && e.sessionId === sid) return a;
    if (group.sourceKind === 'omp' && e.ompThreadId && e.ompThreadId === sid) return a;
    if (owner && e.ownerId === owner) return a;
  }
  return null;
}

/** The adv_sessions row a hit-session maps to, if any: claude by session_id,
 *  omp by omp_thread_id. Rows arrive newest-first; first match wins. Pure. */
export function matchSessionRow(
  group: Pick<SessionHitGroup, 'sourceKind' | 'sessionId'>,
  rows: readonly AdvSessionRow[],
): AdvSessionRow | null {
  for (const r of rows) {
    if (group.sourceKind === 'claude' && r.sessionId === group.sessionId) return r;
    if (group.sourceKind === 'omp' && r.ompThreadId === group.sessionId) return r;
  }
  return null;
}

/**
 * Classify session groups for the popover: attach the live roster entry
 * (active) and/or the adv_sessions row (metadata; `endedAt` set ⇒ inactive).
 * Active sessions sort before inactive, both score-desc within. Pure.
 */
export function classifySessionGroups(
  groups: readonly SessionHitGroup[],
  active: readonly RosterEntry[],
  sessionRows: readonly AdvSessionRow[],
): ClassifiedSessionHits[] {
  const out: ClassifiedSessionHits[] = groups.map((g) => ({
    ...g,
    active: matchActiveEntry(g, active),
    session: matchSessionRow(g, sessionRows),
  }));
  return out.sort((a, b) => {
    const aActive = a.active ? 0 : 1;
    const bActive = b.active ? 0 : 1;
    return aActive - bActive || b.topScore - a.topScore;
  });
}
