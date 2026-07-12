/**
 * AgentsPillSessions — the agents-running popover's session-history surfaces
 * (agents-pill-inactive-search-2026-07-09 P-003/P-004):
 *
 *   * SessionsSearchInput + SessionSearchResults — the "search ANYTHING in the
 *     sessions" box. Debounced fetch to GET /api/adv/sessions/search-transcripts
 *     (the shared @papercusp/search engine over the session_turns corpus);
 *     results keep the roster's format — ACTIVE sessions grouped by fleet
 *     first, then INACTIVE — each with its matched excerpts (engine
 *     ts_headline <mark> highlights). Clicking a hit opens the
 *     AgentInspectorModal deep-linked at the matched turn with the term
 *     highlighted (P-005: streamUrl carries find/anchorTs).
 *
 *   * InactiveSessionsSection — the "View inactive sessions" expander at the
 *     popover bottom: every ended adv_session, ended_at DESC, paged from
 *     GET /api/adv/sessions/ended with IntersectionObserver infinite scroll
 *     (the ChatConversation.tsx sentinel + reentry-lock pattern).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryState } from 'nuqs';
import {
  computeFacets,
  facetPredicate,
  parseFacetSelection,
  serializeFacetSelection,
  toggleFacetValue,
  facetSelectionSize,
  type FacetDef,
  type FacetGroup,
  type FacetSelection,
} from '@papercusp/facets';
import AgentInspectorModal from '@/app/harness/AgentInspectorModal';
import { LivenessDot } from '@/app/coord/presence-ui';
import {
  agentGlyph,
  canForkSession,
  displayName,
  fmtCompactAge,
  groupByFleet,
  resumableSessionId,
  shortOwner,
  type RosterAgent,
} from './AgentsRunningPill';

/** The AdvSessionRow subset the ended-sessions feed serves. */
export interface EndedSessionRow {
  id: number;
  workspaceId?: string;
  planSlug: string | null;
  agent: string | null;
  role: string | null;
  feature: string | null;
  label: string | null;
  coordOwnerId: string | null;
  sessionId: string | null;
  ompThreadId: string | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
}

/** One matched transcript turn from /api/adv/sessions/search-transcripts. */
export interface SearchTurnHit {
  turnIdx: number;
  ts?: string | null;
  speaker?: string | null;
  owner?: string | null;
  excerpt: string;
  highlight: string;
  score: number;
}

/** One matched SESSION (classified server-side against roster + adv rows). */
export interface SearchSessionResult {
  sourceKind: string;
  sessionId: string;
  topScore: number;
  hits: SearchTurnHit[];
  active: RosterAgent | null;
  session: EndedSessionRow | null;
}

/**
 * The transcript-viewer stream URL for a SEARCH HIT, deep-linked at the match:
 * `find` = the query (the pane highlights + scrolls to it), `anchorTs` = the
 * matched turn's timestamp. Keyed per source kind — claude by session uuid
 * (+ owner isolation-dir hint), omp by thread id, codex by rollout uuid.
 * agent_chat has no transcript viewer ⇒ null (the row shows a note instead of
 * a dead click). Pure — exported for tests.
 */
export function searchHitStreamUrl(
  s: Pick<SearchSessionResult, 'sourceKind' | 'sessionId' | 'active' | 'session'>,
  hit: Pick<SearchTurnHit, 'ts' | 'owner'>,
  query: string,
): string | null {
  const anchor = `&find=${encodeURIComponent(query)}${hit.ts ? `&anchorTs=${encodeURIComponent(hit.ts)}` : ''}`;
  // A hit on an INACTIVE (no live roster agent) session is ended → ended=1 so the
  // thinking route rematerializes an archived transcript / terminates instead of
  // polling forever (WI-3990). An ACTIVE result's agent is still running, so its
  // transcript is live on disk — no flag.
  const ended = s.active ? '' : '&ended=1';
  if (s.sourceKind === 'claude') {
    const owner = hit.owner ?? s.active?.ownerId ?? s.session?.coordOwnerId ?? null;
    return `/api/adv/session/thinking?sessionId=${encodeURIComponent(s.sessionId)}${owner ? `&owner=${encodeURIComponent(owner)}` : ''}${anchor}${ended}`;
  }
  if (s.sourceKind === 'omp') {
    return `/api/adv/session/thinking?ompThreadId=${encodeURIComponent(s.sessionId)}${anchor}${ended}`;
  }
  if (s.sourceKind === 'codex') {
    return `/api/adv/session/thinking?codexRolloutId=${encodeURIComponent(s.sessionId)}${anchor}${ended}`;
  }
  return null;
}

/** The transcript-viewer stream URL for an ENDED session row (no anchor):
 *  claude transcript / omp thread / codex rollout (keyed by the adv row id —
 *  its per-session CODEX_HOME). Null when the row recorded no handle. Pure —
 *  exported for tests. */
export function endedSessionStreamUrl(
  r: Pick<EndedSessionRow, 'id' | 'agent' | 'sessionId' | 'ompThreadId' | 'coordOwnerId'>,
): string | null {
  // ended=1 (WI-3990): this session has ENDED, so a transcript that isn't on
  // disk (archived + deleted ~after death) must be rematerialized-from-archive
  // and backfilled — or the stream terminated. WITHOUT this the thinking route
  // can't tell an ended session from a live one pre-first-turn, so it polls
  // forever and the inspector shows "waiting for the first output" indefinitely
  // instead of the stored history.
  if (r.sessionId) {
    return `/api/adv/session/thinking?sessionId=${encodeURIComponent(r.sessionId)}${r.coordOwnerId ? `&owner=${encodeURIComponent(r.coordOwnerId)}` : ''}&ended=1`;
  }
  if (r.ompThreadId) return `/api/adv/session/thinking?ompThreadId=${encodeURIComponent(r.ompThreadId)}&ended=1`;
  if (r.agent === 'codex') return `/api/adv/session/thinking?codexSessionKey=${encodeURIComponent(String(r.id))}&ended=1`;
  return null;
}

/** ts_headline output → safe HTML: escape EVERYTHING, then restore only the
 *  engine's own <mark> tags. Transcripts routinely contain HTML/JS snippets —
 *  raw dangerouslySetInnerHTML of a headline over them would inject markup.
 *  Pure — exported for tests. */
export function headlineToSafeHtml(headline: string): string {
  return headline
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('&lt;mark&gt;', '<mark>')
    .replaceAll('&lt;/mark&gt;', '</mark>');
}

/** Display name for an ended session row: label → short owner id → agent+row.
 *  Pure — exported for tests. */
export function endedDisplayName(
  r: Pick<EndedSessionRow, 'id' | 'agent' | 'label' | 'coordOwnerId'>,
): string {
  const label = r.label?.trim();
  if (label) return label;
  if (r.coordOwnerId) return shortOwner(r.coordOwnerId);
  return `${r.agent ?? 'session'} #${r.id}`;
}

/** Append a page of ended rows, dropping ids already present (a session that
 *  ended between two page fetches shifts the keyset). Pure — exported for tests. */
export function appendEndedPage(prev: readonly EndedSessionRow[], page: readonly EndedSessionRow[]): EndedSessionRow[] {
  const seen = new Set(prev.map((r) => r.id));
  return [...prev, ...page.filter((r) => !seen.has(r.id))];
}

/** Classify a failed search response into the user-facing message. A route
 *  timeout (the 30s watchdog 408s under host load — 2026-07-09 incident) is
 *  NOT "broken": say so and invite a retry, instead of a dead generic error
 *  the owner reads as "no results". Pure — exported for tests. */
export function searchFailureMessage(status: number | null, errCode?: string | null): string {
  if (status === 408 || status === 503 || status === 504 || errCode === 'timeout') {
    return 'Search timed out — the server is busy right now. Try again in a moment.';
  }
  return 'Search failed.';
}

/** The popover's session search input. Controlled; the parent decides when the
 *  query is "active" (>= 2 chars) and swaps the roster for the results view. */
export function SessionsSearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="pc-agents-sessions__searchwrap">
      <input
        type="search"
        className="pc-agents-sessions__search"
        placeholder="Search anything in all sessions…"
        aria-label="Search session transcripts"
        data-testid="agents-sessions-search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <SessionsStyles />
    </div>
  );
}

/** What the results view needs to open the inspector on a click. */
interface InspectTarget {
  streamUrl: string;
  runId: string;
  role: string;
  highlightTerm?: string;
  /** WI-3882: the id to fork/resume into a new terminal (null ⇒ no
   *  Fork/Resume button — codex results, or a source with no resumable id). */
  resumeSessionId?: string | null;
  /** true ⇒ the source agent is still RUNNING — tags the Resume button's
   *  collision-warning tooltip; false ⇒ it has ENDED. Both Resume and Fork are
   *  offered either way (owner ask 2026-07-11). */
  resumeLive?: boolean;
  /** WI-4009 / 2026-07-11: whether the source can be FORKED (claude-only) —
   *  gates the Fork button, independent of active/inactive. */
  resumeCanFork?: boolean;
}

/** WI-3882: the Fork/Resume target for a matched search result — an ACTIVE
 *  result's agent is still running (`live:true`, tags the Resume button's
 *  collision tooltip); an INACTIVE result's session has ended (`live:false`).
 *  null ⇒ no button at all (codex, or neither half of the result carries a
 *  resumable id). Owner ask 2026-07-11 (retracted the "fork only for active /
 *  resume only for inactive" split): BOTH Resume and Fork are offered for
 *  active AND inactive. `live` no longer gates presence — it only tags the
 *  Resume collision tooltip. `canFork` (claude-only — `--fork-session` has no
 *  omp equivalent) gates the Fork button, independent of active/inactive. The
 *  Resume button works for any resumable (claude/omp) session either way. Pure
 *  — exported for tests. */
export function searchResultResumeTarget(
  result: Pick<SearchSessionResult, 'active' | 'session'>,
): { sessionId: string; live: boolean; canFork: boolean } | null {
  if (result.active) {
    const sessionId = resumableSessionId(result.active);
    return sessionId ? { sessionId, live: true, canFork: canForkSession(result.active) } : null;
  }
  const sessionId = result.session ? resumableSessionId(result.session) : null;
  return sessionId ? { sessionId, live: false, canFork: result.session ? canForkSession(result.session) : false } : null;
}

/** One matched session row + its excerpt hits. Shared by the active (fleet-
 *  grouped) and inactive halves of the results view. */
function SearchResultRow({
  title,
  glyph,
  color,
  meta,
  result,
  query,
  onInspect,
}: {
  title: string;
  glyph: string;
  color?: string | null;
  meta: string;
  result: SearchSessionResult;
  query: string;
  onInspect: (t: InspectTarget) => void;
}) {
  const openHit = (hit: SearchTurnHit) => {
    const url = searchHitStreamUrl(result, hit, query);
    if (!url) return;
    const resumeTarget = searchResultResumeTarget(result);
    onInspect({
      streamUrl: url,
      runId: result.sessionId,
      role: title,
      highlightTerm: query,
      resumeSessionId: resumeTarget?.sessionId ?? null,
      resumeLive: resumeTarget?.live ?? false,
      resumeCanFork: resumeTarget?.canFork ?? false,
    });
  };
  const top = result.hits[0];
  const openable = top ? searchHitStreamUrl(result, top, query) !== null : false;
  return (
    <div className="pc-agents-sessions__result" data-testid={`session-hit-${result.sourceKind}-${result.sessionId}`}>
      <div
        className={`pc-agents-roster__row pc-agents-roster__row--nocheck pc-agents-sessions__result-head${openable ? '' : ' is-unopenable'}`}
        role={openable ? 'button' : undefined}
        tabIndex={openable ? 0 : undefined}
        title={openable ? 'Open at the best match' : 'No transcript viewer for this source'}
        onClick={() => top && openHit(top)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && top) { e.preventDefault(); openHit(top); }
        }}
      >
        <span className="pc-agents-sessions__kind" aria-hidden>{result.sourceKind}</span>
        <span className="pc-agents-roster__glyph" style={color ? { color } : undefined} aria-hidden>{glyph}</span>
        <span className="pc-agents-roster__name" style={color ? { color } : undefined}>{title}</span>
        <span className="pc-agents-roster__doing">{meta}</span>
      </div>
      {result.hits.map((h) => (
        <div
          key={h.turnIdx}
          className="pc-agents-sessions__hit"
          role="button"
          tabIndex={0}
          data-testid={`hit-${result.sessionId}-${h.turnIdx}`}
          onClick={() => openHit(h)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHit(h); }
          }}
          // Engine ts_headline output, escaped except its own <mark> tags.
          dangerouslySetInnerHTML={{ __html: headlineToSafeHtml(h.highlight || h.excerpt) }}
        />
      ))}
    </div>
  );
}

// ── Context-dependent facet filtering (facet-pills-and-recency-2026-07-12) ────

type SessionFacetMeta = { color?: string | null };

/**
 * Facet definitions over a search result — the ONLY session-specific knowledge;
 * `@papercusp/facets` owns the tally / hide-singletons / sort / filter math.
 * This list is a SUPERSET: a facet with <2 distinct values in the actual results
 * is auto-hidden by computeFacets, so only the facets that genuinely help filter
 * THESE results ever render. Order here = the render order of the facet rows.
 */
export const SESSION_FACETS: FacetDef<SearchSessionResult, SessionFacetMeta>[] = [
  { key: 'status', label: 'Status', extract: (s) => (s.active ? 'active' : 'ended') },
  { key: 'backend', label: 'Agent', extract: (s) => s.sourceKind || null },
  {
    key: 'fleet',
    label: 'Fleet',
    extract: (s) =>
      s.active?.fleetSlug ? { value: s.active.fleetSlug, meta: { color: s.active.fleetColor } } : null,
  },
  { key: 'role', label: 'Role', extract: (s) => s.active?.role ?? s.active?.agentPaneKind ?? s.session?.role ?? null },
  { key: 'plan', label: 'Plan', extract: (s) => s.active?.currentPlanSlug ?? s.session?.planSlug ?? null },
  { key: 'feature', label: 'Work item', extract: (s) => s.active?.feature ?? s.session?.feature ?? null },
  { key: 'machine', label: 'Machine', extract: (s) => s.active?.machineLabel ?? null },
];

/** The `since` ISO for a recency-window token, or null for "all time". This is
 *  the SERVER-side tier: changing it re-queries so the window can surface recent
 *  matches that the relevance-ranked top-N would otherwise have hidden. Pure —
 *  exported for tests. */
export function windowToSinceIso(token: string | null | undefined, nowMs: number = Date.now()): string | null {
  if (token === 'day') return new Date(nowMs - 86_400_000).toISOString();
  if (token === 'week') return new Date(nowMs - 7 * 86_400_000).toISOString();
  return null;
}

const RECENCY_WINDOWS: { token: string | null; label: string }[] = [
  { token: null, label: 'All time' },
  { token: 'day', label: 'Today' },
  { token: 'week', label: 'This week' },
];

/**
 * The context-dependent filter bar under the search box. A "When" row (the
 * server-side recency window — re-queries with `since`), then one row per facet
 * that `@papercusp/facets` decided is worth showing. Selecting pills filters the
 * rendered results client-side (AND across facets, OR within). Counts + fleet
 * color ride from the facet meta.
 */
function FacetBar({
  groups,
  selection,
  onToggle,
  onClearAll,
  windowToken,
  onWindow,
}: {
  groups: FacetGroup<SessionFacetMeta>[];
  selection: FacetSelection;
  onToggle: (key: string, value: string) => void;
  onClearAll: () => void;
  windowToken: string | null;
  onWindow: (token: string | null) => void;
}) {
  const selCount = facetSelectionSize(selection);
  const showClear = selCount > 0 || windowToken != null;
  return (
    <div className="pc-agents-facets" data-testid="agents-facet-bar">
      <div className="pc-agents-facets__row">
        <span className="pc-agents-facets__label">When</span>
        <div className="pc-agents-facets__pills">
          {RECENCY_WINDOWS.map((w) => (
            <button
              key={w.token ?? 'all'}
              type="button"
              className={`pc-agents-facets__pill${(windowToken ?? null) === w.token ? ' is-on' : ''}`}
              data-testid={`facet-when-${w.token ?? 'all'}`}
              aria-pressed={(windowToken ?? null) === w.token}
              onClick={() => onWindow(w.token)}
            >
              {w.label}
            </button>
          ))}
        </div>
        {showClear ? (
          <button
            type="button"
            className="pc-agents-facets__clear"
            data-testid="facet-clear"
            onClick={onClearAll}
          >
            Clear{selCount > 0 ? ` (${selCount})` : ''}
          </button>
        ) : null}
      </div>
      {groups.map((g) => {
        const sel = selection.get(g.key);
        return (
          <div key={g.key} className="pc-agents-facets__row" data-testid={`facet-row-${g.key}`}>
            <span className="pc-agents-facets__label">{g.label ?? g.key}</span>
            <div className="pc-agents-facets__pills">
              {g.values.map((v) => {
                const on = sel?.has(v.value) ?? false;
                return (
                  <button
                    key={v.value}
                    type="button"
                    className={`pc-agents-facets__pill${on ? ' is-on' : ''}`}
                    data-testid={`facet-${g.key}-${v.value}`}
                    aria-pressed={on}
                    onClick={() => onToggle(g.key, v.value)}
                  >
                    {v.meta?.color ? (
                      <span className="pc-agents-facets__dot" style={{ background: v.meta.color }} aria-hidden />
                    ) : null}
                    <span className="pc-agents-facets__pill-text">{v.value}</span>
                    <span className="pc-agents-facets__count">{v.count}</span>
                  </button>
                );
              })}
              {g.hiddenValueCount > 0 ? (
                <span className="pc-agents-facets__more">+{g.hiddenValueCount}</span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The search-results view: ACTIVE matched sessions grouped by fleet (the same
 * ordering + coloring as the running roster), then the INACTIVE section.
 */
export function SessionSearchResults({ query, nowMs }: { query: string; nowMs: number }) {
  const [sessions, setSessions] = useState<SearchSessionResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the Retry button to re-fire the same query. DELIBERATELY manual —
  // auto-retry against a server that just 408'd under load would stack more
  // heavy queries onto the exact condition that caused the failure.
  const [attempt, setAttempt] = useState(0);
  const [inspecting, setInspecting] = useState<InspectTarget | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    // Debounce keystrokes; abort a stale in-flight search on the next one.
    const t = setTimeout(async () => {
      setLoading(true);
      setError(null);
      // CLIENT-SIDE deadline (owner-hit 07-10): a server that never answers —
      // mid-boot after an auto-deploy restart, wedged socket — otherwise spins
      // "Searching…" forever (fetch has no default timeout). 35s sits just past
      // the server's 30s watchdog, so a live-but-slow server's own 408 arrives
      // first and this only trips when the server is truly unresponsive.
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; ctl.abort(); }, 35_000);
      try {
        const r = await fetch(`/api/adv/sessions/search-transcripts?q=${encodeURIComponent(query)}&limit=30`, { signal: ctl.signal });
        const j = await r.json() as { ok: boolean; error?: string; sessions?: SearchSessionResult[] };
        clearTimeout(deadline);
        if (!j.ok) { setError(searchFailureMessage(r.status, j.error)); setLoading(false); return; }
        setSessions(j.sessions ?? []);
        setLoading(false);
      } catch {
        clearTimeout(deadline);
        if (timedOut) {
          setError(searchFailureMessage(408, 'timeout'));
          setLoading(false);
        } else if (!ctl.signal.aborted) {
          setError(searchFailureMessage(null));
          setLoading(false);
        }
        // else: superseded by a newer keystroke / unmount — stay silent.
      }
    }, 300);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [query, attempt]);

  const activeResults = sessions.filter((s) => s.active);
  const inactiveResults = sessions.filter((s) => !s.active);
  const resultByOwner = new Map(activeResults.map((s) => [s.active!.ownerId, s]));
  const groups = groupByFleet(activeResults.map((s) => s.active!));

  return (
    <div className="pc-agents-sessions__results" data-testid="agents-search-results">
      {loading && <div className="pc-agents-sessions__status">Searching…</div>}
      {error && (
        <div className="pc-agents-sessions__status is-error" data-testid="search-error">
          {error}{' '}
          <button
            type="button"
            className="pc-agents-sessions__retry"
            data-testid="search-retry"
            onClick={() => setAttempt((a) => a + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {!loading && !error && sessions.length === 0 && (
        <div className="pc-agents-sessions__status">No matches in any session.</div>
      )}
      {groups.length > 0 && (
        <div className="pc-agents-sessions__scroll">
          {groups.map((g) => (
            <section key={g.slug ?? '__none'} className="pc-agents-roster__group">
              <header
                className="pc-agents-roster__group-head"
                style={g.slug ? { color: g.color ?? undefined } : undefined}
              >
                <span className="pc-agents-roster__group-caret" aria-hidden>▾</span>
                {g.slug ?? 'No fleet'} <span className="pc-agents-roster__group-count">({g.agents.length})</span>
              </header>
              {g.agents.map((a) => {
                const res = resultByOwner.get(a.ownerId);
                if (!res) return null;
                return (
                  <SearchResultRow
                    key={a.ownerId}
                    title={displayName(a)}
                    glyph={agentGlyph(a)}
                    color={g.color}
                    meta={a.intent || a.currentPlanSlug || '—'}
                    result={res}
                    query={query}
                    onInspect={setInspecting}
                  />
                );
              })}
            </section>
          ))}
        </div>
      )}
      {inactiveResults.length > 0 && (
        <section className="pc-agents-roster__group">
          <header className="pc-agents-roster__group-head">
            <span className="pc-agents-roster__group-caret" aria-hidden>▾</span>
            Inactive sessions <span className="pc-agents-roster__group-count">({inactiveResults.length})</span>
          </header>
          <div className="pc-agents-sessions__scroll">
            {inactiveResults.map((s) => {
              const row = s.session;
              const title = row ? endedDisplayName(row) : `${s.sourceKind} · ${s.sessionId.slice(0, 8)}…`;
              const endedAgo = row?.endedAt ? `ended ${fmtCompactAge(row.endedAt, nowMs)} ago` : '';
              const meta = [row?.feature, row?.planSlug, endedAgo].filter(Boolean).join(' · ') || '—';
              return (
                <SearchResultRow
                  key={`${s.sourceKind}:${s.sessionId}`}
                  title={title}
                  glyph={agentGlyph({ agentPaneKind: null, role: row?.role ?? null })}
                  meta={meta}
                  result={s}
                  query={query}
                  onInspect={setInspecting}
                />
              );
            })}
          </div>
        </section>
      )}
      {inspecting ? (
        <AgentInspectorModal
          slug=""
          phase="staging"
          runId={inspecting.runId}
          role={inspecting.role}
          streamUrl={inspecting.streamUrl}
          highlightTerm={inspecting.highlightTerm}
          resumeTarget={inspecting.resumeSessionId
            ? { sessionId: inspecting.resumeSessionId, live: Boolean(inspecting.resumeLive), canFork: Boolean(inspecting.resumeCanFork) }
            : undefined}
          open
          onClose={() => setInspecting(null)}
        />
      ) : null}
      <SessionsStyles />
    </div>
  );
}

/**
 * "View inactive sessions" — the expander at the popover bottom. Every ended
 * session ever, newest-ended first, in pages of 30 with infinite scroll: a
 * bottom sentinel inside the section's own scroll container, an
 * IntersectionObserver that fires loadMore while `hasMore`, and a synchronous
 * reentry lock (`fetchInFlightRef`) — the exact ChatConversation.tsx pattern
 * (there the sentinel is at the top for older history; here at the bottom).
 * Unlike ChatConversation there is deliberately NO user-scroll gate: when the
 * first page doesn't fill the container the observer SHOULD keep paging until
 * it does.
 */
export function InactiveSessionsSection({
  activeOwnerIds,
  nowMs,
}: {
  /** Owner ids currently shown as RUNNING — their ended rows are older
   *  terminals of a live agent and are elided (mirrors the roster's
   *  dedupeEndedAgainstActive). */
  activeOwnerIds: ReadonlySet<string>;
  nowMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<EndedSessionRow[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [inspecting, setInspecting] = useState<EndedSessionRow | null>(null);
  const nextBeforeRef = useRef<string | null>(null);
  const fetchInFlightRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async () => {
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    setLoading(true);
    try {
      const before = nextBeforeRef.current;
      const r = await fetch(`/api/adv/sessions/ended?limit=30${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      const j = await r.json() as { ok: boolean; sessions?: EndedSessionRow[]; hasMore?: boolean; nextBefore?: string | null };
      if (!j.ok) throw new Error('ended_fetch_failed');
      nextBeforeRef.current = j.nextBefore ?? null;
      setHasMore(Boolean(j.hasMore));
      setRows((prev) => appendEndedPage(prev, j.sessions ?? []));
    } catch {
      setError(true);
      setHasMore(false);
    } finally {
      fetchInFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  // First page on expand.
  useEffect(() => {
    if (expanded && rows.length === 0 && !error) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  // Infinite scroll: bottom sentinel + reentry lock (ChatConversation pattern).
  useEffect(() => {
    if (!expanded) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        if (!hasMore) continue;
        if (fetchInFlightRef.current) continue;
        void loadMore();
      }
    }, { root: scrollRef.current ?? null, rootMargin: '0px 0px 120px 0px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [expanded, hasMore, loadMore]);

  const visible = rows.filter((r) => !r.coordOwnerId || !activeOwnerIds.has(r.coordOwnerId));

  return (
    <div className="pc-agents-sessions__inactive" data-testid="inactive-sessions-section">
      <button
        type="button"
        className="pc-agents-sessions__toggle"
        data-testid="inactive-sessions-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span aria-hidden>{expanded ? '▾' : '▸'}</span> View inactive sessions
        {expanded && visible.length > 0 ? (
          <span className="pc-agents-roster__group-count" data-testid="inactive-sessions-count">
            ({visible.length}{hasMore ? '+' : ''})
          </span>
        ) : null}
        <span className="pc-agents-sessions__toggle-hint">every past session, newest first</span>
      </button>
      {expanded && (
        <div className="pc-agents-sessions__scroll pc-agents-sessions__inactive-list" ref={scrollRef} data-testid="inactive-sessions-list">
          {visible.map((r) => {
            const url = endedSessionStreamUrl(r);
            const endedAgo = r.endedAt ? fmtCompactAge(r.endedAt, nowMs) : '';
            return (
              <div
                key={r.id}
                className={`pc-agents-roster__row pc-agents-roster__row--nocheck${url ? '' : ' is-unopenable'}`}
                data-testid={`inactive-session-${r.id}`}
                role={url ? 'button' : undefined}
                tabIndex={url ? 0 : undefined}
                title={url ? 'Open transcript' : 'No transcript handle recorded for this session'}
                onClick={() => { if (url) setInspecting(r); }}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && url) { e.preventDefault(); setInspecting(r); }
                }}
              >
                <span className="pc-agents-roster__live">
                  {/* Ended sessions get the SAME leading status dot as the active
                      roster rows (a muted grey 'stale' dot = offline/ended), so the
                      inactive list reads as a peer of the active-sessions section
                      instead of a bare age-only column (owner ask 2026-07-12). */}
                  <LivenessDot liveness="stale" size={7} title={endedAgo ? `ended ${endedAgo} ago` : 'ended session'} />
                  {endedAgo ? (
                    <span className="pc-agents-roster__age" title={`ended ${endedAgo} ago`}>{endedAgo}</span>
                  ) : null}
                </span>
                <span className="pc-agents-roster__glyph" aria-hidden>
                  {agentGlyph({ agentPaneKind: null, role: r.role })}
                </span>
                <span className="pc-agents-roster__name" title={`${r.coordOwnerId ?? ''}${r.agent ? ` · ${r.agent}` : ''}`}>
                  {endedDisplayName(r)}
                </span>
                <span className="pc-agents-roster__doing">
                  {r.feature ? <span className="pc-agents-roster__feat">{r.feature}</span> : null}
                  {[r.planSlug, r.agent].filter(Boolean).join(' · ') || '—'}
                </span>
              </div>
            );
          })}
          {loading && <div className="pc-agents-sessions__status">Loading…</div>}
          {error && <div className="pc-agents-sessions__status is-error">Couldn’t load inactive sessions.</div>}
          {!hasMore && !loading && !error && visible.length === 0 && (
            <div className="pc-agents-sessions__status">No inactive sessions.</div>
          )}
          {/* The infinite-scroll sentinel — observed while more pages remain. */}
          <div ref={sentinelRef} data-testid="inactive-sessions-sentinel" style={{ height: 1 }} />
        </div>
      )}
      {inspecting ? (
        <AgentInspectorModal
          slug=""
          phase="staging"
          runId={inspecting.sessionId ?? inspecting.ompThreadId ?? String(inspecting.id)}
          role={endedDisplayName(inspecting)}
          streamUrl={endedSessionStreamUrl(inspecting) ?? undefined}
          resumeTarget={resumableSessionId(inspecting)
            ? { sessionId: resumableSessionId(inspecting)!, live: false, canFork: canForkSession(inspecting) }
            : undefined}
          open
          onClose={() => setInspecting(null)}
        />
      ) : null}
      <SessionsStyles />
    </div>
  );
}

function SessionsStyles() {
  return (
    <style>{`
      /* Sticky header: the search box stays visible while the roster scrolls
         (the popover itself is the scrollport; -4px rides over its padding). */
      .pc-agents-sessions__searchwrap {
        padding: 6px 8px 4px; border-bottom: 1px solid var(--border);
        position: sticky; top: -4px; z-index: 2; background: var(--bg-1, #0b1525);
      }
      .pc-agents-sessions__search {
        width: 100%; box-sizing: border-box; font-size: 12px; padding: 5px 8px;
        background: var(--bg-2); color: var(--fg); border: 1px solid var(--border); border-radius: 6px;
      }
      .pc-agents-sessions__search:focus { outline: 1px solid var(--accent, #38bdf8); }
      .pc-agents-sessions__status { padding: 8px 10px; font-size: 11.5px; color: var(--fg-mute); font-style: italic; }
      .pc-agents-sessions__status.is-error { color: #d97757; }
      .pc-agents-sessions__retry {
        margin-left: 6px; padding: 1px 8px; font-size: 11px; font-style: normal;
        color: var(--accent, #7aa2f7); background: transparent;
        border: 1px solid var(--border); border-radius: 4px; cursor: pointer;
      }
      .pc-agents-sessions__retry:hover { border-color: var(--accent, #7aa2f7); }
      .pc-agents-sessions__scroll { max-height: 300px; overflow-y: auto; }
      .pc-agents-sessions__result { padding: 2px 0 4px; border-bottom: 1px solid var(--border); }
      .pc-agents-sessions__result:last-child { border-bottom: none; }
      .pc-agents-sessions__result-head.is-unopenable { cursor: default; opacity: 0.75; }
      .pc-agents-sessions__kind {
        font-size: 9px; font-family: ui-monospace, monospace; color: var(--fg-mute);
        border: 1px solid var(--border); border-radius: 3px; padding: 0 3px; line-height: 1.5;
      }
      .pc-agents-sessions__hit {
        margin: 2px 8px 2px 30px; padding: 3px 8px; font-size: 11px; line-height: 1.45;
        color: var(--fg-mute); background: var(--bg-2); border-left: 2px solid var(--border);
        border-radius: 3px; cursor: pointer; word-break: break-word;
      }
      .pc-agents-sessions__hit:hover { border-left-color: var(--accent, #38bdf8); background: color-mix(in oklab, var(--accent), transparent 88%); }
      .pc-agents-sessions__hit mark {
        background: color-mix(in srgb, var(--accent, #38bdf8), transparent 55%);
        color: inherit; border-radius: 2px; padding: 0 1px;
      }
      /* Sticky footer: pinned to the popover bottom so the hover detail strip
         appearing/disappearing above it never displaces it (it was "fighting"
         that strip for the same spot), and it stays visible without scrolling. */
      .pc-agents-sessions__inactive {
        border-top: 1px solid var(--border-strong, var(--border)); margin-top: 4px;
        position: sticky; bottom: -4px; z-index: 2; background: var(--bg-1, #0b1525);
      }
      .pc-agents-sessions__toggle {
        width: 100%; text-align: left; font-size: 12px; font-weight: 600;
        padding: 8px 10px; cursor: pointer; display: flex; align-items: center; gap: 6px;
        background: transparent; color: var(--accent, #38bdf8); border: none; border-radius: 4px;
      }
      .pc-agents-sessions__toggle:hover { background: color-mix(in oklab, var(--accent, #38bdf8), transparent 86%); }
      .pc-agents-sessions__toggle-hint { margin-left: auto; font-weight: 400; font-size: 10.5px; color: var(--fg-mute); }
      .pc-agents-sessions__inactive-list { max-height: 260px; }
    `}</style>
  );
}
