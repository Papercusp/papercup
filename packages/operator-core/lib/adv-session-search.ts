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

import type { MatchProvenance, RecencyRank } from '@papercusp/search';
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
/**
 * Decay half-life. 7 DAYS, not the original 24h (P-003).
 *
 * At a 24h half-life a 3-day-old turn keeps 12.5% of its recency credit and a
 * week-old one 0.8% — i.e. for most of the corpus the decay term is pinned at
 * zero and the blend degenerates to "today vs everything else". Session
 * transcripts stay useful for weeks, so the curve was an order of magnitude
 * too aggressive for what it ranks. At 7d, 3 days keeps 74% and a week 50%.
 */
export const DEFAULT_HALF_LIFE_H = 24 * 7;

/**
 * Recency's share of the blend. 0.5, RAISED from 0.3 — and this is a
 * translation, NOT a behaviour change.
 *
 * The old 0.3 was tuned against the engine's pre-P-002 blend, where relevance
 * was divided by the max and so never spanned its nominal range: measured on
 * real RRF distributions, recency actually reached parity with relevance at
 * weight ~0.295 for a typical 45-candidate pool. P-002 made `weight` a true
 * mixing fraction (both terms span [0,1]), where parity is exactly 0.5. So
 * 0.5 here PRESERVES today's effective ranking; leaving 0.3 would have
 * silently weakened recency by ~40% the moment P-002 landed.
 */
export const DEFAULT_WEIGHT = 0.5;

/**
 * Fresh-candidate window, 48h — DECOUPLED from the half-life (P-003).
 *
 * It used to be `2 × halfLife`, which was invisible while the half-life was
 * 24h and became wrong the instant it moved: at 7d that formula silently
 * redefines "fresh" as a FOURTEEN DAY window, admitting a fortnight of rows
 * into a leg whose entire purpose is guaranteeing genuinely-recent rows a seat
 * the relevance cut would deny them. They answer different questions — the
 * half-life shapes the decay CURVE, this bounds pool ADMISSION — so tying one
 * to the other was incidental, not a design.
 */
export const DEFAULT_FRESH_WINDOW_H = 48;

export function parseRecencyParams(searchParams: URLSearchParams): RecencyRank | undefined {
  if (searchParams.get('recency') === 'off') return undefined;
  // Absent or blank → NaN (→ default), NEVER Number(null)'s accidental 0.
  const num = (name: string): number => {
    const raw = searchParams.get(name);
    return raw === null || raw.trim() === '' ? NaN : Number(raw);
  };
  const halfLifeH = num('recencyHalfLifeH');
  const halfLifeMs =
    (Number.isFinite(halfLifeH) && halfLifeH > 0 ? halfLifeH : DEFAULT_HALF_LIFE_H) * 3_600_000;
  const weight = (() => {
    const w = num('recencyWeight');
    return Number.isFinite(w) && w >= 0 && w <= 1 ? w : DEFAULT_WEIGHT;
  })();
  // Fresh-candidate window (engine `RecencyRank.freshWindowMs`): guarantees
  // recent matches a seat in the relevance-cut candidate pool.
  // `?recencyFreshWindowH=0` disables just the fresh leg.
  const freshH = num('recencyFreshWindowH');
  const freshWindowMs =
    Number.isFinite(freshH) && freshH >= 0 ? freshH * 3_600_000 : DEFAULT_FRESH_WINDOW_H * 3_600_000;
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
  /**
   * WHY this turn matched (P-004), classified SERVER-SIDE by
   * `@papercusp/search`'s `hitProvenance` so the ranker names live in exactly
   * one place instead of being re-derived in every card across the wire.
   *
   * Load-bearing for the UI: a `semantic` hit matched no query TERM, so its
   * `highlight` carries no <mark> and is just the head of the turn. Without
   * this field a card cannot tell that apart from a lexical match whose terms
   * happen to fall outside the headline window, and renders both as if the
   * text shown were the match.
   *
   * OPTIONAL on purpose — a hit built outside the engine (a test fixture, a
   * hand-rolled searcher) legitimately has no attribution, and `undefined`
   * must read as "no claim", never as a default.
   */
  matchedBy?: MatchProvenance;
  /** Pre-fusion ts_rank_cd score, when a lexical leg returned this turn. */
  lexicalScore?: number;
  /** Pre-fusion cosine similarity, when the vector leg returned this turn. */
  semanticScore?: number;
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
