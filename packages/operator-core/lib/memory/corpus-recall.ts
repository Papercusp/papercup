/**
 * corpus-recall — the PURE selection core for the second retrieval leg
 * (context-injection-audit-2026-07-28 P-008, built to D-037).
 *
 * The injector reads mem0 memories ONLY. Of the four places the motivating
 * answer was stored, exactly one was reachable by auto-injection: the mem0
 * memory. The work-item post that held the actual evidence, the source
 * docstring with the owner's words, and the plan were all structurally
 * unreachable. This leg makes `session_turns` + work-items reachable.
 *
 * THREE THINGS THIS IS NOT, each forced by evidence (D-037):
 *
 *   1. NOT a fourth pool in the mem0 ranked list. The memory store embeds with
 *      harrier-oss @ native 1024 (`memory_vec_harrier`, 100% of
 *      `memory_canonical`); every prose surface — session_turns, work_items,
 *      docs, plans — stays in gemma@384 (see `proseSurfacePreference` in
 *      ./configure). One query vector cannot score both, so these hits can
 *      never join the single comparable ranking F-C/D-011 built. Merging them
 *      anyway could only be done by a fixed priority, which D-011 names "a
 *      quota under another name".
 *
 *   2. NOT a share of INJECTION_TOTAL_LIMIT. Measured 2026-08-02 over
 *      memory_recall_stats (surface='turn-start', 7d, n=557): the user pool
 *      ALONE fills all 12 slots on 64.3% of recalls. A fourth competitor there
 *      is dead on arrival, and when it did place it would evict a
 *      floor-passing memory. This leg carries its own small item cap and its
 *      own char budget, and takes nothing from the three pools.
 *
 *   3. NOT content. A teaser + a resolvable HANDLE, mirroring ambient-push's
 *      teaser-not-content discipline. Inlining raw transcript text from a
 *      ~400k-turn corpus would consume the block to say less — and the thing
 *      the motivating example actually needed was a POINTER (WI-6512 post
 *      54626), not the post.
 *
 * WHY THERE IS NO ABSOLUTE SCORE FLOOR HERE — read before adding one. The
 * score arriving from the search engine in hybrid mode is a fused RRF value
 * (~1/(60+rank)), a function of RANK WITHIN ONE CALL. It is not on any
 * absolute scale, so a constant compared against it means nothing — precisely
 * the conflation P-036/D-036 was written to stop. Admission here is therefore
 * a RANK CUT plus a scale-free relevance guard (shared query terms), never a
 * magic constant. Note also that the precision asymmetry runs the other way
 * from the mem0 push path: an irrelevant FACT pollutes the turn's reasoning
 * (hence that path's 0.45 cosine floor), while an irrelevant POINTER costs
 * ~200 chars and is ignored.
 *
 * PURE — no PG, no embedder, no clock. The live leg is ./corpus-recall-io.
 */

/** A ranked hit handed in by the live leg (structurally mirrors the search
 *  engine's `SearchHit` without importing its surface). */
export interface CorpusHit {
  /** Search source label: 'session_turn' | 'work_item'. */
  source: string;
  /** `<source_kind>:<session_id>:<turn_idx>` for a turn; the issue id for a work-item. */
  sourceId: string;
  /** work_item: 'harness:<slug>' | 'operator'. session_turn: the harness slug, usually absent. */
  scope?: string | null;
  /** The first ~200 chars of the body — the LEAD, not necessarily the match. */
  excerpt: string;
  /**
   * The ts_headline fragment around the actual match, `<mark>`-wrapped. Strongly
   * preferred over `excerpt` for the teaser: on a long work-item body the match
   * is routinely past the 200-char lead, so an excerpt teaser shows the agent a
   * pointer without showing it WHY the pointer is here — and the term-overlap
   * guard, reading that same lead, would then drop the hit as irrelevant when
   * it is not. Optional: a source that skipped highlighting falls back cleanly.
   */
  highlight?: string | null;
  /** Fused RRF (hybrid) — rank-derived, NOT an absolute similarity. See header. */
  score: number;
  ts?: string | number | Date | null;
  /** Which rankers contributed ('bm25' / 'embeddings'). Agreement breaks ties. */
  rankers?: readonly string[];
}

/** The resolvable pointer — same concept as ambient-push's QueryHandle. Never
 *  carries content; `resolve` is the literal tool call that fetches it. */
export interface CorpusHandle {
  kind: 'work-item' | 'session';
  /** The id to resolve: a WI-/EI- id, or `<source_kind>:<session_id>`. */
  ref: string;
  /** The matched query terms — the "why", and the re-pull query. */
  query: string[];
  /** The tool call that resolves this handle, rendered for the agent. */
  resolve: string;
}

export interface CorpusLine {
  line: string;
  handle: CorpusHandle;
  score: number;
}

export type CorpusDropReason =
  | 'self-session'
  | 'out-of-scope'
  | 'no-term-overlap'
  | 'duplicate-ref'
  | 'not-novel'
  | 'cap-exhausted'
  | 'budget-exhausted';

export interface CorpusDrop {
  ref: string;
  reason: CorpusDropReason;
}

export interface SelectCorpusInput {
  hits: readonly CorpusHit[];
  /** The retrieval query — the term source for the overlap guard + the handle. */
  queryText: string;
  /**
   * Drop hits from THIS session. Its turns are already in the agent's context,
   * so surfacing them is a pure echo — the same thing ambient-push's novelty
   * filter exists to prevent.
   */
  excludeSessionId?: string | null;
  /**
   * Harnesses in scope. Applied to WORK-ITEM hits only, in this pure core
   * rather than as a SQL `scopeFilter`, and that split is deliberate:
   * 396,798 of 396,826 session turns (99.993%) carry `harness_slug IS NULL`
   * (file-sourced claude/codex transcripts are stamped workspace 'default' by
   * design), so a harness-scoped SQL filter would leave the turn leg able to
   * match at most 28 rows — structurally empty while looking healthy. That is
   * the exact failure class injection.ts's per-pool telemetry (P-026) was
   * added to catch. Workspace scoping is the real boundary for turns; harness
   * scoping is meaningful only for work-items, whose `scope` column is
   * reliably populated. Omit/empty ⇒ no harness narrowing.
   */
  harnessSlugs?: readonly string[];
  /** Handle refs the agent already carries (dedup across injection moments). */
  knownRefs?: ReadonlySet<string>;
  /** Max lines admitted. */
  maxItems?: number;
  /** Char budget for the admitted lines. */
  budgetChars?: number;
}

export interface SelectCorpusResult {
  lines: CorpusLine[];
  /** Every candidate that did not ship, with why — auditable, like selectPushes. */
  dropped: CorpusDrop[];
}

/** Max lines this leg may contribute. Small on purpose: it is additive to a
 *  block whose mem0 half is already saturated 64.3% of the time (D-037). */
export const CORPUS_MAX_ITEMS = 3;

/** Char budget for this leg ALONE — not a share of the mem0 budget (D-037). */
export const CORPUS_BUDGET_CHARS = 900;

/** A teaser is one bounded line; a runaway teaser must never become content. */
export const CORPUS_TEASER_MAX_CHARS = 220;

/** Ordinary English + this codebase's own boilerplate. Terms are only used for
 *  the overlap guard and the handle's re-pull query, so a missed stopword costs
 *  a slightly noisier handle, never a wrong admission. */
const STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'because', 'been', 'before', 'being',
  'between', 'both', 'came', 'come', 'could', 'does', 'doing', 'done', 'down',
  'during', 'each', 'else', 'even', 'ever', 'every', 'from', 'further', 'have',
  'having', 'here', 'how', 'into', 'itself', 'just', 'like', 'made', 'make',
  'many', 'more', 'most', 'much', 'must', 'need', 'next', 'once', 'only',
  'other', 'over', 'same', 'should', 'since', 'some', 'such', 'than', 'that',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'time', 'under', 'until', 'very', 'want', 'well', 'were', 'what', 'when',
  'where', 'which', 'while', 'will', 'with', 'without', 'would', 'your',
]);

/** An id-shaped token is ALWAYS a term regardless of length — WI-6512, EI-9748,
 *  P-008, D-037, migration numbers. These are exactly the tokens that make
 *  pointer-retrieval work, and a plain length filter would drop them. */
const ID_TOKEN_RE = /^(?:[a-z]{1,3}-\d{2,}|\d{3,})$/;

/**
 * Extract the comparable terms from a piece of text. Lowercased, split on
 * non-alphanumeric-and-dash, stopwords removed, keeping tokens of ≥4 chars or
 * id-shaped tokens of any length. PURE.
 */
export function corpusTerms(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9-]+/)) {
    const t = raw.replace(/^-+|-+$/g, '');
    if (!t) continue;
    if (STOPWORDS.has(t)) continue;
    if (t.length < 4 && !ID_TOKEN_RE.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Content terms kept when the text carries no id-shaped token. TWO, and the
 * number is forced rather than chosen — see {@link corpusQueryText}.
 */
export const CORPUS_QUERY_MAX_TERMS = 2;

/**
 * Build the COMPACT retrieval query for this leg from the injected text.
 *
 * This is not a nicety, it is the difference between the lexical leg working
 * and being structurally dead. Both corpora are searched through
 * `plainto_tsquery`, which **ANDs every term**, and the text arriving at the
 * injection port is the raw submitted prompt, envelope and all — measured over
 * `memory_recall_stats` (3d, 2026-08-02): turn-start is clamped at 1000 chars
 * with a MEDIAN of 1000, mid-turn ~196, claim/create 300. Handing that
 * straight to the engine produces an AND of ~150 lexemes, which matches
 * nothing, ever. Verified against live PG:
 *
 *   'why did the http2 sse transport change on the endpoint'
 *     → 'http2' & 'sse' & 'transport' & 'chang' & 'endpoint'  → 0 rows
 *   'http2 transport'                                          → 3 rows
 *   'WI-6512' → 'wi' & '-6512'                                 → 11 work-items, 58 turns
 *
 * So: an ID-SHAPED token wins outright and is used ALONE. A work-item id in
 * the prompt is a near-unique retrieval key — ANDing anything beside it can
 * only cost recall, and it cannot buy precision the id does not already have.
 * That case is also this item's entire motivating example (find WI-6512 and
 * its post), so it is the case worth optimizing.
 *
 * Failing an id, the two longest distinct content terms. Length is a crude
 * distinctiveness proxy; it is used deliberately in place of a tuned constant
 * because there is no corpus-frequency signal on this path yet. TERM SELECTION
 * IS THE TUNABLE THIS LEG'S TELEMETRY SHOULD DRIVE — measure it before
 * changing it, and note D-008's lesson first: on this path the natural
 * constant to retune is usually not the one governing the behavior.
 *
 * The same compact query also serves the EMBEDDING leg, and that is an
 * improvement rather than a compromise: a 1000-char envelope embeds mostly its
 * own boilerplate, which is precisely the effect P-041 was added to measure.
 * PURE.
 */
export function corpusQueryText(text: string, maxTerms = CORPUS_QUERY_MAX_TERMS): string {
  const terms = corpusTerms(text);
  if (terms.length === 0) return '';
  const id = terms.find((t) => ID_TOKEN_RE.test(t));
  if (id) return id;
  return [...terms]
    .sort((a, b) => b.length - a.length || terms.indexOf(a) - terms.indexOf(b))
    .slice(0, Math.max(1, maxTerms))
    .join(' ');
}

/** The session id a `session_turn` hit came from, or null for other sources.
 *  `sourceId` is `<source_kind>:<session_id>:<turn_idx>` and a session id may
 *  itself contain colons, so the turn index is stripped from the END. PURE. */
export function sessionIdOfHit(hit: CorpusHit): string | null {
  if (hit.source !== 'session_turn') return null;
  const parts = hit.sourceId.split(':');
  if (parts.length < 3) return null;
  return parts.slice(1, -1).join(':') || null;
}

/** The handle ref a hit collapses to: one line per WORK-ITEM, and one per
 *  SESSION (not per turn — three turns of one session is one pointer). PURE. */
export function handleRefOfHit(hit: CorpusHit): string | null {
  if (hit.source === 'work_item') return hit.sourceId || null;
  if (hit.source === 'session_turn') {
    const parts = hit.sourceId.split(':');
    if (parts.length < 3) return null;
    const kind = parts[0];
    const sid = parts.slice(1, -1).join(':');
    return kind && sid ? `${kind}:${sid}` : null;
  }
  return null;
}

/** Is a work-item hit inside the harnesses in scope? `operator`-scoped items are
 *  always in scope (workspace-wide by construction). Turn hits are never
 *  narrowed here — see SelectCorpusInput.harnessSlugs. PURE. */
function inHarnessScope(hit: CorpusHit, harnessSlugs: readonly string[]): boolean {
  if (hit.source !== 'work_item') return true;
  if (harnessSlugs.length === 0) return true;
  const scope = hit.scope ?? '';
  if (scope === 'operator' || scope === '') return true;
  return harnessSlugs.some((slug) => scope === `harness:${slug}`);
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Strip ts_headline's `<mark>` wrappers — the emphasis is markup for a web
 *  surface, noise in a prompt. PURE. */
const unmark = (s: string): string => s.replace(/<\/?mark>/g, '');

/** The text a hit is JUDGED and TEASED on: the highlighted match fragment when
 *  the source produced one, else the body lead. PURE. */
export function hitText(hit: CorpusHit): string {
  const h = unmark(hit.highlight ?? '').trim();
  return h || hit.excerpt || '';
}

/** Render the resolving tool call for a handle. This is the whole point of a
 *  handle: the agent does not have to know HOW to fetch it. PURE. */
function resolveCall(kind: CorpusHandle['kind'], ref: string, terms: string[]): string {
  if (kind === 'work-item') return `work_items:get { id: '${ref}' }`;
  const sid = ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref;
  const q = terms.slice(0, 4).join(' ');
  return `sessions:search { session: '${sid}', query: '${q}' }`;
}

/** A short label for the hit's date, when it has one. PURE. */
function dateLabel(ts: CorpusHit['ts']): string {
  if (ts === undefined || ts === null) return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return '';
  return ` · ${d.toISOString().slice(0, 10)}`;
}

/**
 * Select which corpus hits reach the turn, in order:
 *   1. SELF-SESSION — drop this session's own turns (pure echo);
 *   2. SCOPE        — drop work-items outside the harnesses in scope;
 *   3. OVERLAP      — drop a hit sharing no query term with the query
 *                     (the scale-free relevance guard — see header);
 *   4. DEDUP        — one line per handle ref, best-ranked wins;
 *   5. NOVELTY      — drop refs the agent already carries;
 *   6. CAP + BUDGET — best-ranked first, up to maxItems and budgetChars.
 * Every drop is recorded with its reason. Input order is treated as relevance
 * order (the engine already fused + sorted); ties break toward multi-ranker
 * agreement, which is the one scale-free quality signal available. PURE.
 */
export function selectCorpusLines(input: SelectCorpusInput): SelectCorpusResult {
  const maxItems = input.maxItems ?? CORPUS_MAX_ITEMS;
  const budget = input.budgetChars ?? CORPUS_BUDGET_CHARS;
  const harnessSlugs = input.harnessSlugs ?? [];
  const known = input.knownRefs ?? new Set<string>();
  const queryTerms = new Set(corpusTerms(input.queryText));
  const dropped: CorpusDrop[] = [];

  // 1-4: filter, then collapse to one candidate per handle ref (first wins —
  // input is already in fused-relevance order).
  const byRef = new Map<string, { hit: CorpusHit; terms: string[]; rank: number }>();
  input.hits.forEach((hit, rank) => {
    const ref = handleRefOfHit(hit);
    if (!ref) return;
    const sid = sessionIdOfHit(hit);
    if (input.excludeSessionId && sid && sid === input.excludeSessionId) {
      dropped.push({ ref, reason: 'self-session' });
      return;
    }
    if (!inHarnessScope(hit, harnessSlugs)) {
      dropped.push({ ref, reason: 'out-of-scope' });
      return;
    }
    // Judged on the match fragment when there is one — see CorpusHit.highlight
    // for why the body lead alone would drop genuine deep matches.
    const shared = corpusTerms(hitText(hit)).filter((t) => queryTerms.has(t));
    if (queryTerms.size > 0 && shared.length === 0) {
      dropped.push({ ref, reason: 'no-term-overlap' });
      return;
    }
    if (byRef.has(ref)) {
      dropped.push({ ref, reason: 'duplicate-ref' });
      return;
    }
    if (known.has(ref)) {
      dropped.push({ ref, reason: 'not-novel' });
      return;
    }
    byRef.set(ref, { hit, terms: shared, rank });
  });

  // 5: order. The engine's fused order is the primary key; multi-ranker
  // agreement (a hit BOTH legs found) breaks ties, since it is the only
  // quality signal here that does not depend on an absolute scale.
  const ordered = [...byRef.entries()].sort((a, b) => {
    const agree = (b[1].hit.rankers?.length ?? 1) - (a[1].hit.rankers?.length ?? 1);
    if (agree !== 0) return agree;
    return a[1].rank - b[1].rank;
  });

  // 6: cap + budget.
  const lines: CorpusLine[] = [];
  let spent = 0;
  for (const [ref, { hit, terms }] of ordered) {
    if (lines.length >= maxItems) {
      dropped.push({ ref, reason: 'cap-exhausted' });
      continue;
    }
    const kind: CorpusHandle['kind'] = hit.source === 'work_item' ? 'work-item' : 'session';
    const handle: CorpusHandle = {
      kind,
      ref,
      query: terms.slice(0, 6),
      resolve: resolveCall(kind, ref, terms),
    };
    const label = kind === 'work-item' ? `work-item ${ref}` : `session ${ref}`;
    const teaser = oneLine(hitText(hit)).slice(0, CORPUS_TEASER_MAX_CHARS);
    const line = `- [${label}${dateLabel(hit.ts)}] ${teaser} → ${handle.resolve}`;
    if (spent + line.length > budget && lines.length > 0) {
      dropped.push({ ref, reason: 'budget-exhausted' });
      continue;
    }
    spent += line.length;
    lines.push({ line, handle, score: hit.score });
  }

  return { lines, dropped };
}

/** The section heading this leg renders under. Named so the agent can tell a
 *  POINTER from an injected FACT: the mem0 block states things, this one points. */
export const CORPUS_BLOCK_HEADING = 'Related context (pointers — resolve to read)';

/** Render the selected lines as a markdown section, or null when nothing was
 *  admitted. PURE. */
export function renderCorpusBlock(lines: readonly CorpusLine[]): string | null {
  if (lines.length === 0) return null;
  return `### ${CORPUS_BLOCK_HEADING}\n\n${lines.map((l) => l.line).join('\n')}`;
}
