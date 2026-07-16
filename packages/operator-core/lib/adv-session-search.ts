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

import type { RecencyRank } from '@papercusp/search';
import type { RosterEntry } from './adv-roster';
import type { AdvSessionRow } from './adv-sessions';

/**
 * Parse the route's recency query params into the engine's RecencyRank —
 * DEFAULT-ON (owner ask 2026-07-12): absent params mean 24h half-life,
 * weight 0.3, fresh-candidate window 2×half-life; `?recency=off` disables.
 *
 * ⚠ WI-5097: this previously lived inline in the route as
 * `Number(url.searchParams.get('recencyWeight'))` — but `Number(null)` is
 * **0**, not NaN, so an ABSENT param (every normal search; the UI never
 * sends it) passed the `>= 0 && <= 1` validity check and silently ran with
 * weight 0 = recency OFF. The desktop pill showed stale June hits for
 * queries with fresh same-day matches. Absent/blank/garbage now falls to
 * the default; an EXPLICIT in-range value (including 0) is honored. Pure —
 * unit-tested without a route. */
export function parseRecencyParams(searchParams: URLSearchParams): RecencyRank | undefined {
  if (searchParams.get('recency') === 'off') return undefined;
  // Absent or blank → NaN (→ default), NEVER Number(null)'s accidental 0.
  const num = (name: string): number => {
    const raw = searchParams.get(name);
    return raw === null || raw.trim() === '' ? NaN : Number(raw);
  };
  const halfLifeH = num('recencyHalfLifeH');
  const halfLifeMs = (Number.isFinite(halfLifeH) && halfLifeH > 0 ? halfLifeH : 24) * 3_600_000;
  const weight = (() => {
    const w = num('recencyWeight');
    return Number.isFinite(w) && w >= 0 && w <= 1 ? w : 0.3;
  })();
  // Fresh-candidate window (engine `RecencyRank.freshWindowMs`): guarantees
  // recent matches a seat in the relevance-cut candidate pool. Default
  // 2×half-life; `?recencyFreshWindowH=0` disables just the fresh leg.
  const freshH = num('recencyFreshWindowH');
  const freshWindowMs = Number.isFinite(freshH) && freshH >= 0 ? freshH * 3_600_000 : 2 * halfLifeMs;
  return { halfLifeMs, weight, freshWindowMs };
}

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

/**
 * Build a fast entry-level predicate equivalent to "would matchActiveEntry
 * select this entry for ANY of these groups" — WITHOUT scanning `active` per
 * group. Lets a caller cheaply skip expensive per-entry roster enrichment
 * (e.g. mergeRosterWithAssignments' thinking-state resolution, WI-3924) for
 * roster entries no group could ever match, instead of paying that cost for
 * the WHOLE live roster when only a handful of entries are actually used.
 *
 * MUST stay in exact sync with matchActiveEntry's three match rules (claude
 * sessionId, omp threadId, owner-fallback — the fallback matches ANY
 * sourceKind, mirrored here too). Pure; see adv-session-search.test.ts for
 * the equivalence check against matchActiveEntry itself.
 */
export function buildActiveEntryMatchFilter(
  groups: readonly Pick<SessionHitGroup, 'sourceKind' | 'sessionId' | 'hits'>[],
): (entry: Pick<RosterEntry, 'sessionId' | 'ompThreadId' | 'ownerId'>) => boolean {
  const claudeSessionIds = new Set<string>();
  const ompThreadIds = new Set<string>();
  const owners = new Set<string>();
  for (const g of groups) {
    if (g.sourceKind === 'claude') claudeSessionIds.add(g.sessionId);
    if (g.sourceKind === 'omp') ompThreadIds.add(g.sessionId);
    const owner = g.hits.find((h) => h.owner)?.owner;
    if (owner) owners.add(owner);
  }
  return (entry) =>
    (!!entry.sessionId && claudeSessionIds.has(entry.sessionId)) ||
    (!!entry.ompThreadId && ompThreadIds.has(entry.ompThreadId)) ||
    (!!entry.ownerId && owners.has(entry.ownerId));
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
