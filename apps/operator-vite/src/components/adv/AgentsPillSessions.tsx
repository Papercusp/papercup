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
import { useCallback, useEffect, useRef, useState } from 'react';
import AgentInspectorModal from '@/app/harness/AgentInspectorModal';
import {
  agentGlyph,
  displayName,
  fmtCompactAge,
  groupByFleet,
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
  if (s.sourceKind === 'claude') {
    const owner = hit.owner ?? s.active?.ownerId ?? s.session?.coordOwnerId ?? null;
    return `/api/adv/session/thinking?sessionId=${encodeURIComponent(s.sessionId)}${owner ? `&owner=${encodeURIComponent(owner)}` : ''}${anchor}`;
  }
  if (s.sourceKind === 'omp') {
    return `/api/adv/session/thinking?ompThreadId=${encodeURIComponent(s.sessionId)}${anchor}`;
  }
  if (s.sourceKind === 'codex') {
    return `/api/adv/session/thinking?codexRolloutId=${encodeURIComponent(s.sessionId)}${anchor}`;
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
  if (r.sessionId) {
    return `/api/adv/session/thinking?sessionId=${encodeURIComponent(r.sessionId)}${r.coordOwnerId ? `&owner=${encodeURIComponent(r.coordOwnerId)}` : ''}`;
  }
  if (r.ompThreadId) return `/api/adv/session/thinking?ompThreadId=${encodeURIComponent(r.ompThreadId)}`;
  if (r.agent === 'codex') return `/api/adv/session/thinking?codexSessionKey=${encodeURIComponent(String(r.id))}`;
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
    onInspect({ streamUrl: url, runId: result.sessionId, role: title, highlightTerm: query });
  };
  const top = result.hits[0];
  const openable = top ? searchHitStreamUrl(result, top, query) !== null : false;
  return (
    <div className="pc-agents-sessions__result" data-testid={`session-hit-${result.sourceKind}-${result.sessionId}`}>
      <div
        className={`pc-agents-roster__row pc-agents-sessions__result-head${openable ? '' : ' is-unopenable'}`}
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

/**
 * The search-results view: ACTIVE matched sessions grouped by fleet (the same
 * ordering + coloring as the running roster), then the INACTIVE section.
 */
export function SessionSearchResults({ query, nowMs }: { query: string; nowMs: number }) {
  const [sessions, setSessions] = useState<SearchSessionResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<InspectTarget | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    // Debounce keystrokes; abort a stale in-flight search on the next one.
    const t = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/adv/sessions/search-transcripts?q=${encodeURIComponent(query)}&limit=30`, { signal: ctl.signal });
        const j = await r.json() as { ok: boolean; sessions?: SearchSessionResult[] };
        if (!j.ok) throw new Error('search_failed');
        setSessions(j.sessions ?? []);
        setLoading(false);
      } catch {
        if (!ctl.signal.aborted) { setError('Search failed'); setLoading(false); }
      }
    }, 300);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [query]);

  const activeResults = sessions.filter((s) => s.active);
  const inactiveResults = sessions.filter((s) => !s.active);
  const resultByOwner = new Map(activeResults.map((s) => [s.active!.ownerId, s]));
  const groups = groupByFleet(activeResults.map((s) => s.active!));

  return (
    <div className="pc-agents-sessions__results" data-testid="agents-search-results">
      {loading && <div className="pc-agents-sessions__status">Searching…</div>}
      {error && <div className="pc-agents-sessions__status is-error">{error}</div>}
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
                className={`pc-agents-roster__row${url ? '' : ' is-unopenable'}`}
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
