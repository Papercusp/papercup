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
/* The ONE runtime import in this module, and chosen for that reason (WI-37883).
   `owner-chat-turn` is a deliberate zero-import leaf — see its header — kept
   that way precisely so the send path, the wake executor and browser-side chat
   code can share one definition of the owner-visibility rule. Importing the
   predicate here rather than re-stating it is what keeps the search filter and
   the chat pane from ever disagreeing about which turns the owner can see.
   HudView.tsx imports this module into the browser bundle; the leaf comes with
   it and costs nothing, since it has no dependencies of its own. */
import {
  isOwnerVisiblePrompt,
  ownerVisiblePromptText,
} from './agent-tools/coordination/owner-chat-turn';

/* Re-exported so the route gets the FILTER and the amount of text the filter
   needs from ONE module. They are one contract: hydrate less than this and the
   predicate silently starts reading truncated envelopes as unmarked prose,
   which fails toward showing machine turns — the exact leak being closed. */
export { OWNER_VISIBILITY_DECIDING_PREFIX_CHARS } from './agent-tools/coordination/owner-chat-turn';

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
  /**
   * A bounded HEAD of the matched turn's raw text — enough to decide whether
   * the owner's chat pane renders this turn at all (WI-37883), never the whole
   * turn.
   *
   * Hydrated alongside `speaker` by the route, and read ONLY by
   * {@link filterOwnerVisibleTurnHits}. Optional because the hydration is
   * fail-soft: a hit that never got metadata carries neither, and both readers
   * treat that as "no claim" rather than as a verdict.
   */
  textHead?: string | null;
  /**
   * The full raw text for a user turn, hydrated only while deciding whether a
   * matched fragment falls inside the owner's rendered span (WI-37909). This
   * is an internal filter input and is stripped before the response is sent.
   */
  fullText?: string | null;
}

// ── ID search (WI-37204) ────────────────────────────────────────────────────

/**
 * The minimum token length that may be treated as an ID SEARCH.
 *
 * 6 is `shortHandle`'s own floor (`/^([a-z]+)-([0-9a-f]{6,8})/` in
 * hud-board-model) — i.e. exactly the shortest id fragment this UI ever RENDERS
 * to a human, which is the fragment they will copy back into the box. Shorter
 * than that and a hex-looking word ("added", "decade", "beef") starts colliding
 * with prose, and an id leg that fires on prose queries would inject unrelated
 * sessions at the TOP of every text search.
 */
export const SESSION_ID_TOKEN_MIN_LEN = 6;

/**
 * Whether `q` should ALSO be resolved as a session/agent identifier.
 *
 * The three id shapes this system actually hands a human, all of which turn up
 * in logs, work-items and coord messages and get pasted straight into a search
 * box:
 *
 *   · coord owner id — `su-bc38a419-8dc6-4040-a63e-2dc0515e42be`, and the
 *     `su-bc38a419` SHORT HANDLE the roster/HUD render in place of it;
 *   · native session id — a bare claude uuid, or its 8-hex head (which is what
 *     an ended-session card shows: `${sessionId.slice(0, 8)}…`);
 *   · spawn/presence owner id — `s-1786227863758-271597fd` (fleet-spawn and
 *     omp-hook-session rows both use this shape).
 *
 * Returns the LOWERCASED token to match with, or null when the query is prose.
 * A prefix is deliberately enough: nobody types 39 characters to find a
 * session, and the short handle is the form the UI itself displays.
 *
 * ⚠ This is a WIDENING, never a narrowing: a query that parses as an id is
 * still run through the text engine as well, because ids DO appear in
 * transcript prose ("waking su-bc38a419") and those hits are often the reason
 * someone is searching. See the route's id leg — it MERGES, it does not
 * replace. Pure — unit-tested without PG.
 */
export function parseSessionIdQuery(q: string): string | null {
  const token = q.trim().toLowerCase();
  if (token.length < SESSION_ID_TOKEN_MIN_LEN) return null;
  // Whitespace ⇒ a phrase, not an identifier. Checked before the shape tests so
  // "su-bc38a419 crashed" reads as prose rather than as an id with a suffix.
  if (/\s/.test(token)) return null;
  // `su-<hex…>` / `s-<digits>-<hex>` / any `<word>-<hex…>` handle, a bare uuid
  // (or uuid prefix), or a bare hex run. The trailing-dot form is NOT accepted:
  // a copied "…" ellipsis from a truncated card is stripped by the caller, not
  // silently tolerated here (a token containing '…' would never match anything
  // and reads as a no-result bug rather than a paste artifact).
  if (/^[a-z]+-[0-9a-f]{4,}(-[0-9a-f]+)*$/.test(token)) return token; // su-…, s-…
  if (/^[0-9a-f]{6,}(-[0-9a-f]{4,})*$/.test(token)) return token; // uuid / hex head
  return null;
}

/** Does `candidate` (an ownerId / sessionId / ompThreadId) answer to `token`?
 *  PREFIX match, case-insensitive — `su-bc38a419` finds
 *  `su-bc38a419-8dc6-…`, and the full id finds itself. Never a substring
 *  match: an id's tail is not a handle anyone is given, and matching mid-string
 *  would make one uuid pull in unrelated sessions that merely share a run of
 *  hex. Pure. */
export function sessionIdCandidateMatches(
  candidate: string | null | undefined,
  token: string,
): boolean {
  if (!candidate) return false;
  return candidate.toLowerCase().startsWith(token);
}

/** The id-bearing fields of anything session-shaped, in the order a match is
 *  attributed. Kept as one list so the roster leg, the adv_sessions leg and the
 *  two client surfaces cannot drift on WHICH ids are searchable. */
export type SessionIdBearing = {
  ownerId?: string | null;
  coordOwnerId?: string | null;
  sessionId?: string | null;
  ompThreadId?: string | null;
};

/** Which id field matched, or null. The field NAME rides to the UI so a card
 *  can say "matched su id" vs "matched session id" instead of leaving the human
 *  to guess why a hit-less row is on screen. Pure. */
export function matchSessionIdField(
  e: SessionIdBearing,
  token: string,
): 'ownerId' | 'sessionId' | 'ompThreadId' | null {
  if (sessionIdCandidateMatches(e.ownerId ?? e.coordOwnerId, token)) return 'ownerId';
  if (sessionIdCandidateMatches(e.sessionId, token)) return 'sessionId';
  if (sessionIdCandidateMatches(e.ompThreadId, token)) return 'ompThreadId';
  return null;
}

/** Human label for {@link matchSessionIdField}'s verdict. Pure. */
export function sessionIdMatchLabel(field: 'ownerId' | 'sessionId' | 'ompThreadId'): string {
  if (field === 'ownerId') return 'su id';
  if (field === 'sessionId') return 'session id';
  return 'thread id';
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
  /**
   * WI-37204 — this result is here because the query IS one of its ids, not
   * because its transcript said anything. `hits` may legitimately be EMPTY for
   * such a result, which is the one case where an empty `hits` is not a bug:
   * the card renders from the roster/adv metadata and opens at the head of the
   * transcript rather than at a match. Absent/null ⇒ an ordinary text hit.
   */
  idMatch?: 'ownerId' | 'sessionId' | 'ompThreadId' | null;
}

/** The transcript identity a session-shaped row opens under: claude by native
 *  session uuid, omp by thread id. Neither ⇒ a SYNTHETIC key so the row still
 *  has a stable React key and a distinguishable card, with `sourceKind` naming
 *  the backend so the chip stays honest instead of claiming 'claude'. Pure. */
export function transcriptIdentity(
  e: SessionIdBearing & { agent?: string | null; id?: number | null },
): { sourceKind: string; sessionId: string } {
  if (e.sessionId) return { sourceKind: 'claude', sessionId: e.sessionId };
  if (e.ompThreadId) return { sourceKind: 'omp', sessionId: e.ompThreadId };
  const fallbackId = e.ownerId ?? e.coordOwnerId ?? (e.id != null ? `adv-${e.id}` : '');
  return { sourceKind: e.agent ?? 'session', sessionId: fallbackId };
}

/** How many id matches a single query may surface. A 6-char prefix can match
 *  many sessions; past a couple of dozen the human should type more of the id
 *  rather than scroll. Active entries are taken first (see buildIdMatchResults). */
export const ID_MATCH_LIMIT = 20;

/**
 * Resolve an id token against the live roster and recorded sessions, as
 * hit-less {@link ClassifiedSessionHits}. Live entries come first (an agent you
 * can still open beats its historical row), then recorded rows in the order the
 * caller supplied (the lookup returns newest-started first).
 *
 * Deduped on BOTH the transcript identity and the owner id: the same agent
 * routinely appears as a roster entry AND an adv_sessions row, and a roster
 * entry that has not yet recorded a native session id would otherwise pair with
 * its own row as two separate cards. Pure — unit-tested without PG.
 */
export function buildIdMatchResults(
  token: string,
  active: readonly RosterEntry[],
  rows: readonly AdvSessionRow[],
  opts: { limit?: number } = {},
): ClassifiedSessionHits[] {
  const limit = opts.limit ?? ID_MATCH_LIMIT;
  const out: ClassifiedSessionHits[] = [];
  const seenKeys = new Set<string>();
  const seenOwners = new Set<string>();

  const take = (
    idMatch: 'ownerId' | 'sessionId' | 'ompThreadId',
    identity: { sourceKind: string; sessionId: string },
    owner: string | null,
    entry: RosterEntry | null,
    row: AdvSessionRow | null,
  ): boolean => {
    const key = `${identity.sourceKind}:${identity.sessionId}`;
    if (seenKeys.has(key)) return false;
    if (owner && seenOwners.has(owner)) return false;
    seenKeys.add(key);
    if (owner) seenOwners.add(owner);
    out.push({ ...identity, topScore: 0, hits: [], active: entry, session: row, idMatch });
    return true;
  };

  for (const a of active) {
    if (out.length >= limit) break;
    const e = a as unknown as SessionIdBearing;
    const field = matchSessionIdField(e, token);
    if (!field) continue;
    // Pair the live entry with its recorded row when we already have it — that
    // is what carries `endedAt`/`feature`/the codex open-key into the card.
    const row =
      rows.find(
        (r) =>
          (e.sessionId && r.sessionId === e.sessionId) ||
          (e.ompThreadId && r.ompThreadId === e.ompThreadId) ||
          (e.ownerId && r.coordOwnerId === e.ownerId),
      ) ?? null;
    take(field, transcriptIdentity(e), e.ownerId ?? null, a, row);
  }

  for (const r of rows) {
    if (out.length >= limit) break;
    const field = matchSessionIdField(r, token);
    if (!field) continue;
    take(field, transcriptIdentity(r), r.coordOwnerId ?? null, null, r);
  }

  return out;
}

/**
 * Fold id matches into the text results: an id match that ALSO has transcript
 * hits keeps them (and is stamped `idMatch`), and every id match is hoisted
 * ahead of the pure text results.
 *
 * MERGE, not replace — deliberately. Ids appear in transcript prose ("waking
 * su-bc38a419", a pasted uuid in a stack trace) and those hits are frequently
 * the reason someone is searching an id at all; dropping them would trade one
 * missing-result complaint for another.
 *
 * GENERIC over the result shape so the agents-pill can run the IDENTICAL merge
 * on its own client-side type (whose `active`/`session` are the browser-shaped
 * roster/ended rows, not this module's server ones). The union rule then exists
 * once: the pill's instant id matches and the server's results cannot end up
 * deduped by two subtly different keys. Pure.
 */
export function mergeIdMatches<
  T extends { sourceKind: string; sessionId: string; idMatch?: ClassifiedSessionHits['idMatch'] },
>(idResults: readonly T[], textResults: readonly T[]): T[] {
  if (idResults.length === 0) return [...textResults];
  const keyOf = (r: T) => `${r.sourceKind}:${r.sessionId}`;
  const byKey = new Map(textResults.map((r) => [keyOf(r), r] as const));
  const merged = idResults.map((r) => {
    const text = byKey.get(keyOf(r));
    return text ? { ...text, idMatch: r.idMatch } : r;
  });
  const claimed = new Set(merged.map(keyOf));
  return [...merged, ...textResults.filter((r) => !claimed.has(keyOf(r)))];
}

/**
 * Drop hits the OWNER'S CHAT PANE would never render — machine-authored
 * `user`-role turns (WI-37883). Pure.
 *
 * ── Why a search route filters on a DISPLAY rule ─────────────────────────────
 *
 * EI-20135573616431912 (owner-reported) fixed the chat pane: a `user`-role turn
 * is shown only when its turn-origin envelope says the HUMAN authored it, so
 * wake blobs, loop-fire instructions and Stop-hook coaching walls stopped
 * appearing as things the owner had apparently said. This route searches the
 * SAME `session_turns` rows and was left unfiltered, which leaks the identical
 * defect one surface over, twice:
 *
 *   1. the machine turn's text is rendered back to the owner as a search
 *      EXCERPT / `<mark>` highlight — the reported bug verbatim, just in a
 *      results list instead of a conversation; and
 *   2. clicking that hit cannot anchor. `SessionChatModal`'s `focusIndex`
 *      corroborates the deep-link by requiring the focused message to CONTAIN
 *      the search term, and the matched text is no longer rendered — so the
 *      corroboration fails, the text fallback finds nothing either, and the
 *      pane silently opens at the tail.
 *
 * ── Why it is a post-filter and not an engine predicate ──────────────────────
 *
 * MEASURED over 3 days of `session_turns` before choosing: 38,760 assistant
 * turns (92.3%) vs 3,247 user turns (7.7%), of which 1,747 are machine-authored
 * — so this drops ~4% of the searchable corpus, not half of it. (The
 * intuition-trap is real: machine turns ARE 54% of USER-role rows, which is the
 * number the parent fix turned on, and reading that as 54% of the SEARCH corpus
 * argues for an engine-level predicate that duplicates the rule in SQL and can
 * drift from it.) At 4% a post-filter cannot meaningfully starve a page, and
 * reusing the one shared predicate is worth more than the recovered hits.
 *
 * Two queries do skew high — boilerplate that only exists inside wake blobs
 * ("loop wake", "coord:orient") — and for those, every dropped hit is one the
 * owner could not have opened anyway.
 *
 * ── Fails OPEN, deliberately ─────────────────────────────────────────────────
 *
 * A hit with no hydrated `textHead` (the route's metadata join is fail-soft) is
 * KEPT. So is every `assistant` turn, which the pane renders unconditionally.
 * The dangerous direction here is hiding something the human wrote, exactly as
 * in `ownerVisiblePromptText`'s own note — never keeping one machine row too
 * many.
 */
export function filterOwnerVisibleTurnHits<T extends TranscriptTurnHit>(
  hits: readonly T[],
): T[] {
  return hits.filter((h) => {
    if (h.speaker !== 'user') return true;
    if (typeof h.textHead !== 'string' || h.textHead === '') return true;
    if (!isOwnerVisiblePrompt(h.textHead)) return false;

    /* WI-37909 — an owner-chat turn is visible as a whole, but its trailing
       `⟦owner-chat⟧` note is stripped before rendering. The old whole-turn
       predicate therefore kept a hit whose `<mark>` was entirely inside that
       hidden note. Compare the headline's actual marked fragments with the
       rendered span. A semantic-only hit has no lexical mark to locate, so it
       remains fail-open: dropping a semantically relevant owner turn would be
       worse than retaining one hit whose match location cannot be proven. */
    if (typeof h.fullText !== 'string' || h.fullText === '') return true;
    const visibleText = ownerVisiblePromptText(h.fullText);
    if (visibleText === '') return false;
    const markedTerms = [...h.highlight.matchAll(/<mark\b[^>]*>([\s\S]*?)<\/mark>/gi)]
      .map((match) => match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase())
      .filter(Boolean);
    if (markedTerms.length === 0) return true;
    const normalizedVisible = visibleText.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    return markedTerms.some((term) => normalizedVisible.includes(term));
  });
}

/**
 * Roll turn-level hits up to sessions, PRESERVING THE CALLER'S ORDER: one group
 * per (sourceKind, sessionId), groups in the order their best hit arrives, hits
 * within a group in that same order and capped at `maxHitsPerSession` (the
 * popover shows a few excerpts per session, not every matching turn). Pure.
 *
 * ⚠ THE ORDER IS THE CALLER'S, NOT `score`'s — and that is the point (P-010).
 * This used to re-derive the order by sorting on `score`, which was a no-op:
 * `runHybridSearch` already returns its page score-desc, so the sort could only
 * ever reproduce the order it was handed. It stops being a no-op the moment a
 * Stage-B reranker runs, and then it is actively WRONG — `rerankProseHits`
 * returns hits in cross-encoder relevance order while carrying each hit's
 * RETRIEVAL score through untouched (the score stays on the wire as
 * provenance), so a score sort silently un-does the entire rerank. That is a
 * failure with no symptom: the reranker runs, costs its latency, and the
 * response is byte-identical to not having reranked at all.
 *
 * `topScore` therefore stays the group's best RETRIEVAL score — a display /
 * provenance value that no longer implies a position.
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
    // Cap on the way in: the kept hits are the FIRST ones the caller ranked,
    // not the highest-scoring ones (identical for score-desc input).
    if (g.hits.length < maxHitsPerSession) g.hits.push(h);
    // Measured over EVERY hit, including ones the cap dropped — unchanged.
    if (h.score > g.topScore) g.topScore = h.score;
  }
  return [...byKey.values()];
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
 * Active sessions come before inactive; RELEVANCE ORDER is preserved within
 * each half. Pure.
 *
 * ⚠ Partition, not a sort — same P-010 reason as {@link groupHitsBySession}.
 * The `|| b.topScore - a.topScore` tiebreak this replaced re-derived the order
 * from the RETRIEVAL score, so it would have discarded a Stage-B rerank at the
 * last step even after the grouping above started preserving it. An explicit
 * two-pass filter is stable by construction rather than by relying on the
 * spec's stable-sort guarantee to carry the order through.
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
  return [...out.filter((g) => g.active), ...out.filter((g) => !g.active)];
}
