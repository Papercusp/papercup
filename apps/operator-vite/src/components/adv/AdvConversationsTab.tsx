/**
 * AdvConversationsTab — the /adv "Conversations" tab. Two views (nuqs `?conv=`):
 *
 *  - **Feed** (default, `conv=feed`): the COMPLETE coordination firehose — every
 *    envelope every agent has exchanged across every channel (messages, acks,
 *    notifies, broadcasts, handoffs + acceptances, escalations + resolutions,
 *    plan events), newest-first, with day separators, kind-coloured badges,
 *    `from → to` (BROADCAST + "→ human" highlighted), a plan-slug chip, and
 *    click-to-expand body + thread (the related_msg_id chain — an ack/resolution
 *    groups under its parent). Filters (kind multi-select, agent, plan,
 *    free-text) are all in the URL via nuqs. Data rides the SSE-invalidation
 *    rail via `@papercusp/sync` (`dev.coordFeed`, the same observer read the
 *    high-tier `coord:feed` tool exposes); "load older" paginates by cursor.
 *    This is the fix for "Conversations only shows a small number" — it shows
 *    ALL coordination traffic, not just the question/discussion substrate.
 *
 *  - **Threads** (`conv=threads`): the conversations substrate (questions +
 *    discussions) — the human counterpart to the agents' conversations:* tools.
 *    Reads the in-process admin-coordination dispatch (one data path, no Zero
 *    entity). Detail = seed + topics + thread + accepted answer + linked
 *    work-item + promote/reply/resolve actions.
 *
 * All user-meaningful state is in the URL via nuqs (CLAUDE.md); only mid-edit
 * reply drafts + loading/busy lifecycle + the expand-set are useState.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsString, parseAsStringEnum, parseAsArrayOf } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { AlertTriangle, ArrowUpRight, CheckCircle2, MessageCircle, RefreshCw, Radio, Megaphone, Search, Send, SlidersHorizontal, UserRound } from 'lucide-react';
import '@/app/admin/coordination/coordination.css';

async function coord<T = Record<string, unknown>>(verb: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/api/admin/coordination/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  return (await res.json()) as T;
}

// ─── View switch ─────────────────────────────────────────────────────
const CONV_VIEWS = ['feed', 'threads'] as const;
type ConvView = (typeof CONV_VIEWS)[number];

export default function AdvConversationsTab() {
  const [view, setView] = useQueryState('conv', parseAsStringEnum<ConvView>([...CONV_VIEWS]).withDefault('feed'));
  return (
    <div className="pc-coord pc-advconv">
      <header className="pc-advconv__hero">
        <div className="pc-advconv__hero-copy">
          <span className="pc-advconv__eyebrow">Fleet comms</span>
          <h1>Conversations</h1>
          <p>Live coordination traffic, agent handoffs, human asks, and durable Q&amp;A threads in one workspace view.</p>
          <div className="pc-advconv__herochips" aria-label="Conversation surfaces">
            <span>
              <Radio size={11} aria-hidden />
              Full fleet feed
            </span>
            <span>
              <MessageCircle size={11} aria-hidden />
              Durable Q&amp;A threads
            </span>
          </div>
        </div>
        <div className="pc-advconv__viewtabs" role="tablist" aria-label="Conversations view">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'feed'}
            className={`pc-advconv__viewtab${view === 'feed' ? ' is-active' : ''}`}
            onClick={() => void setView('feed')}
          >
            <Radio size={13} aria-hidden />
            <span>
              Feed
              <em>all envelopes</em>
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'threads'}
            className={`pc-advconv__viewtab${view === 'threads' ? ' is-active' : ''}`}
            onClick={() => void setView('threads')}
          >
            <MessageCircle size={13} aria-hidden />
            <span>
              Threads
              <em>human questions</em>
            </span>
          </button>
        </div>
      </header>
      {view === 'feed' ? <FeedView /> : <ThreadsView />}
      <AdvConvStyles />
    </div>
  );
}

// ─── Feed view — the complete coordination firehose ──────────────────

const FEED_KINDS = [
  'message',
  'ack',
  'notify',
  'broadcast',
  'handoff',
  'handoff_accepted',
  'escalation',
  'escalation_resolved',
  'plan_event',
  'subscribe',
  'unsubscribe',
  'contract',
] as const;

/** Kind → accent colour. `broadcast` is a synthetic UI kind (any kind with
 *  to:['*']); kept distinct so the firehose's all-hands traffic stands out. */
const KIND_COLOR: Record<string, string> = {
  message: 'var(--accent-strong, #7dd3fc)',
  ack: '#94a3b8',
  notify: '#fbbf24',
  broadcast: '#f472b6',
  handoff: '#a78bfa',
  handoff_accepted: '#c4b5fd',
  escalation: '#f87171',
  escalation_resolved: '#86efac',
  plan_event: '#5eead4',
  subscribe: 'var(--accent, #38bdf8)',
  unsubscribe: '#64748b',
  contract: '#fcd34d',
};

interface FeedRow {
  ts: string;
  msg_id: string;
  from: string;
  to: string[];
  kind: string;
  surface: string;
  broadcast: boolean;
  summary?: string;
  body?: string;
  plan_slug?: string;
  related_msg_id?: string;
  event?: string;
  detail?: string;
  choice?: string;
  next_action?: string;
  category?: string;
  _meta?: { total: number; byKind: Record<string, number>; nextCursor: string | null };
}

function dayKey(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString().slice(0, 10);
}
function dayLabel(key: string): string {
  if (key === 'unknown') return 'Unknown date';
  const today = new Date().toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (key === today) return 'Today';
  if (key === yest) return 'Yesterday';
  return new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function relTime(ts: string): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return '—';
  const delta = Date.now() - t;
  if (delta < 0) return 'just now';
  const s = Math.round(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function clock(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function dateStamp(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function ToCell({ to, broadcast }: { to: string[]; broadcast: boolean }) {
  if (broadcast) {
    return (
      <span className="pc-advfeed__to pc-advfeed__to--broadcast">
        <Megaphone size={10} aria-hidden /> BROADCAST
      </span>
    );
  }
  const toHuman = to.includes('human');
  if (toHuman) {
    return (
      <span className="pc-advfeed__to pc-advfeed__to--human">
        <UserRound size={10} aria-hidden /> → human
      </span>
    );
  }
  return <span className="pc-advfeed__to">→ {to.length ? to.join(', ') : '∅'}</span>;
}

function FeedView() {
  // All filters in nuqs.
  const [kinds, setKinds] = useQueryState('fkind', parseAsArrayOf(parseAsString).withDefault([]));
  const [agent, setAgent] = useQueryState('fagent', parseAsString.withDefault(''));
  const [plan, setPlan] = useQueryState('fplan', parseAsString.withDefault(''));
  const [q, setQ] = useQueryState('fq', parseAsString.withDefault(''));
  const [openMsg, setOpenMsg] = useQueryState('fmsg', parseAsString);

  // "Load older" grows the window from the top. The feed is newest-first and the
  // limit caps from the newest end, so a larger limit reaches further back while
  // the live head stays put — no second data path, all on the @papercusp/sync
  // SSE-invalidation rail. (Transient render state: the URL carries the filters,
  // not the scroll depth.)
  const PAGE = 100;
  const [limit, setLimit] = useState(PAGE);

  // 'broadcast' is a synthetic, cross-cutting UI kind (any envelope with
  // to:['*']) — it is NOT a real CoordKind the server validates, so it's applied
  // client-side. Real kinds go to the server.
  const wantBroadcast = kinds.includes('broadcast');
  const serverKinds = useMemo(() => kinds.filter((k) => k !== 'broadcast'), [kinds]);
  const feedArgs = useMemo(
    () => ({
      ...(serverKinds.length ? { kinds: serverKinds } : {}),
      ...(agent ? { owner: agent } : {}),
      ...(plan ? { plan_slug: plan } : {}),
      ...(q.trim() ? { q: q.trim() } : {}),
      limit,
    }),
    [serverKinds, agent, plan, q, limit],
  );
  const head = useSyncQuery<FeedRow>({ queryName: 'dev.coordFeed', args: feedArgs, staleTime: 5_000 });

  // Reset the window whenever the FILTER set changes (not when limit changes).
  const filterKey = useMemo(
    () => JSON.stringify({ kinds, agent, plan, q: q.trim() }),
    [kinds, agent, plan, q],
  );
  useEffect(() => {
    setLimit(PAGE);
  }, [filterKey]);

  const rawRows = head.data ?? [];
  const meta = rawRows[0]?._meta;
  // Apply the synthetic 'broadcast' filter client-side when selected.
  const allRows = useMemo(
    () => (wantBroadcast ? rawRows.filter((r) => r.broadcast) : rawRows),
    [rawRows, wantBroadcast],
  );
  const signalStats = useMemo(() => {
    const byKind = meta?.byKind ?? {};
    const broadcastCount = rawRows.filter((r) => r.broadcast).length;
    const humanCount = rawRows.filter((r) => (r.to ?? []).includes('human')).length;
    const escalationCount = (byKind.escalation ?? 0) + (byKind.escalation_resolved ?? 0);
    return { broadcastCount, humanCount, escalationCount };
  }, [meta, rawRows]);

  // Group an ack/resolution/acceptance under its parent (related_msg_id chain),
  // so a reply collapses into its root row. A row whose related_msg_id points at
  // another loaded row is a CHILD; everything else is a root.
  const { roots, childrenOf } = useMemo(() => {
    const byId = new Map(allRows.map((r) => [r.msg_id, r]));
    const childrenOf = new Map<string, FeedRow[]>();
    const roots: FeedRow[] = [];
    for (const r of allRows) {
      const parentId = typeof r.related_msg_id === 'string' ? r.related_msg_id : null;
      if (parentId && byId.has(parentId)) {
        const arr = childrenOf.get(parentId) ?? [];
        arr.push(r);
        childrenOf.set(parentId, arr);
      } else {
        roots.push(r);
      }
    }
    // Children oldest-first under their parent (chronological reply order).
    for (const arr of childrenOf.values()) arr.sort((a, b) => a.ts.localeCompare(b.ts));
    return { roots, childrenOf };
  }, [allRows]);

  // Day separators over the root rows (already newest-first from the server).
  const grouped = useMemo(() => {
    const out: Array<{ day: string; rows: FeedRow[] }> = [];
    let cur: { day: string; rows: FeedRow[] } | null = null;
    for (const r of roots) {
      const k = dayKey(r.ts);
      if (!cur || cur.day !== k) {
        cur = { day: k, rows: [] };
        out.push(cur);
      }
      cur.rows.push(r);
    }
    return out;
  }, [roots]);

  // The server returns a non-null cursor whenever more rows exist beyond the
  // current window — that's our "has older" signal.
  const hasOlder = (meta?.nextCursor ?? null) !== null;
  const loadOlder = useCallback(() => setLimit((n) => n + PAGE), []);

  const toggleKind = (k: string) =>
    void setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k]);

  const filtersActive = kinds.length > 0 || !!agent || !!plan || !!q.trim();
  const activeFilterCount = kinds.length + (agent ? 1 : 0) + (plan ? 1 : 0) + (q.trim() ? 1 : 0);
  const clearFilters = () => {
    void setKinds([]);
    void setAgent('');
    void setPlan('');
    void setQ('');
  };

  return (
    <div className="pc-advfeed">
      {/* Clarity bar */}
      <div className="pc-advfeed__clarity">
        <div className="pc-advfeed__clarity-main">
          <Radio size={13} aria-hidden />
          <span>
            Every coordination envelope across the fleet — messages, broadcasts, handoffs, escalations & plan events, newest first.
          </span>
        </div>
        <div className="pc-advfeed__stat">
          <span>Matching</span>
          <strong>{meta ? `${meta.total} matching` : head.loading ? 'loading…' : '0 matching'}</strong>
        </div>
        <div className="pc-advfeed__stat">
          <span>Window</span>
          <strong>{roots.length} shown</strong>
        </div>
        <div className="pc-advfeed__signals" aria-label="Feed signal summary">
          <span><Megaphone size={11} aria-hidden /> {signalStats.broadcastCount} broadcast</span>
          <span><UserRound size={11} aria-hidden /> {signalStats.humanCount} human</span>
          <span><AlertTriangle size={11} aria-hidden /> {signalStats.escalationCount} escalation</span>
        </div>
        <button
          type="button"
          className="pc-coord__chip pc-advfeed__refresh"
          aria-label="Reload feed"
          disabled={head.fetching}
          onClick={() => head.invalidate()}
        >
          <RefreshCw size={11} aria-hidden />
        </button>
      </div>

      {/* Filters — all nuqs */}
      <div className="pc-advfeed__filters">
        <div className="pc-advfeed__filterhead">
          <span>
            <SlidersHorizontal size={12} aria-hidden />
            Narrow the signal
          </span>
          <strong>{filtersActive ? `${activeFilterCount} active` : 'unfiltered'}</strong>
        </div>
        <div className="pc-coord__filters" role="group" aria-label="Kind filter">
          {FEED_KINDS.map((k) => {
            // byKind is keyed by real CoordKind; 'broadcast' is synthetic (no
            // count — it cross-cuts every kind).
            const n = k === 'broadcast' ? undefined : meta?.byKind?.[k];
            const active = kinds.includes(k);
            return (
              <button
                key={k}
                type="button"
                className={`pc-coord__chip pc-advfeed__kindchip${active ? ' is-active' : ''}`}
                style={active ? { borderColor: KIND_COLOR[k], color: KIND_COLOR[k] } : undefined}
                onClick={() => toggleKind(k)}
                aria-pressed={active}
              >
                <span className="pc-advfeed__kinddot" style={{ background: KIND_COLOR[k] ?? '#64748b' }} aria-hidden />
                {k}
                {typeof n === 'number' && n > 0 ? <span className="pc-advfeed__kindn">{n}</span> : null}
              </button>
            );
          })}
        </div>
        <div className="pc-advfeed__inputs">
          <label className="pc-advfeed__field">
            <span>Agent</span>
            <input
              className="pc-advfeed__input"
              placeholder="from or to…"
              value={agent}
              onChange={(e) => void setAgent(e.target.value)}
              aria-label="Filter by agent"
            />
          </label>
          <label className="pc-advfeed__field">
            <span>Plan</span>
            <input
              className="pc-advfeed__input"
              placeholder="plan slug…"
              value={plan}
              onChange={(e) => void setPlan(e.target.value)}
              aria-label="Filter by plan slug"
            />
          </label>
          <label className="pc-advfeed__field pc-advfeed__field--wide">
            <span>
              <Search size={10} aria-hidden />
              Search
            </span>
            <input
              className="pc-advfeed__input pc-advfeed__input--wide"
              placeholder="summary, body, event…"
              value={q}
              onChange={(e) => void setQ(e.target.value)}
              aria-label="Free-text search"
            />
          </label>
          {filtersActive && (
            <button type="button" className="pc-coord__chip pc-advfeed__clear" onClick={clearFilters}>
              clear
            </button>
          )}
        </div>
        {filtersActive && (
          <div className="pc-advfeed__scopebar" aria-label="Active feed filters">
            <span>Showing</span>
            {kinds.length > 0 && <strong>{kinds.join(', ')}</strong>}
            {agent && <strong>agent: {agent}</strong>}
            {plan && <strong>plan: {plan}</strong>}
            {q.trim() && <strong>search: {q.trim()}</strong>}
          </div>
        )}
      </div>

      {/* The stream */}
      <div className="pc-advfeed__stream">
        {head.loading && allRows.length === 0 ? (
          <p className="pc-coord__empty pc-advconv__empty">Loading the coordination feed…</p>
        ) : head.error ? (
          <p className="pc-coord__empty pc-advconv__empty">Feed unavailable: {head.error.message}</p>
        ) : roots.length === 0 ? (
          <div className="pc-coord__empty pc-advconv__empty pc-advconv__empty--card">
            <strong>No matching traffic</strong>
            <span>Clear a filter or broaden the search to return the fleet stream.</span>
          </div>
        ) : (
          grouped.map((g) => (
            <div key={g.day} className="pc-advfeed__daygroup">
              <div className="pc-advfeed__daysep">
                <span>{dayLabel(g.day)}</span>
              </div>
              {g.rows.map((r) => (
                <FeedItem
                  key={r.msg_id}
                  row={r}
                  children={childrenOf.get(r.msg_id) ?? []}
                  open={openMsg === r.msg_id}
                  onToggle={() => void setOpenMsg(openMsg === r.msg_id ? null : r.msg_id)}
                  onPlanClick={(slug) => void setPlan(slug)}
                  onAgentClick={(a) => void setAgent(a)}
                />
              ))}
            </div>
          ))
        )}
        {hasOlder && roots.length > 0 && (
          <button type="button" className="pc-advfeed__loadolder" onClick={loadOlder} disabled={head.fetching}>
            {head.fetching ? 'Loading…' : 'Load older ↓'}
          </button>
        )}
      </div>
    </div>
  );
}

function FeedItem({
  row,
  children,
  open,
  onToggle,
  onPlanClick,
  onAgentClick,
}: {
  row: FeedRow;
  children: FeedRow[];
  open: boolean;
  onToggle: () => void;
  onPlanClick: (slug: string) => void;
  onAgentClick: (a: string) => void;
}) {
  const badge = row.kind;
  const color = KIND_COLOR[row.broadcast ? 'broadcast' : badge] ?? '#64748b';
  const summary =
    row.summary ||
    (row.kind === 'plan_event' && row.event ? `${row.event}${row.detail ? `: ${row.detail}` : ''}` : '');
  const hasDetail = !!row.body || children.length > 0 || !!row.detail || !!row.next_action;

  // The row is a grid (NOT a wrapping <button> — that can't legally contain the
  // nested from/plan filter buttons). The summary cell is the expand trigger;
  // from + plan are independent filter buttons; the rest are spans.
  return (
    <div className={`pc-advfeed__item${open ? ' is-open' : ''}`}>
      <div className="pc-advfeed__row">
        <span className="pc-advfeed__time" title={row.ts}>
          {clock(row.ts)}
        </span>
        <span className="pc-advfeed__badge" style={{ borderColor: color, color, ['--feed-kind-color' as string]: color }}>
          <span aria-hidden />
          {badge}
        </span>
        <span className="pc-advfeed__route">
          <button
            type="button"
            className="pc-advfeed__from"
            onClick={() => onAgentClick(row.from)}
            title={`Filter to ${row.from}`}
          >
            {row.from}
          </button>
          <ToCell to={row.to ?? []} broadcast={row.broadcast} />
        </span>
        <button
          type="button"
          className="pc-advfeed__summary"
          onClick={onToggle}
          aria-expanded={open}
          title={hasDetail ? 'Expand' : undefined}
        >
          {summary || <em className="pc-advfeed__nosum">(no summary)</em>}
        </button>
        {row.plan_slug && (
          <button
            type="button"
            className="pc-advfeed__planchip"
            onClick={() => onPlanClick(row.plan_slug!)}
            title={`Filter to ${row.plan_slug}`}
          >
            {row.plan_slug}
          </button>
        )}
        {children.length > 0 && <span className="pc-advfeed__replyn">{children.length} reply{children.length > 1 ? 'ies' : ''}</span>}
        <span className="pc-advfeed__rel">{relTime(row.ts)}</span>
      </div>
      {open && hasDetail && (
        <div className="pc-advfeed__detail">
          <div className="pc-advfeed__detailhead">
            <span>{row.surface}</span>
            <span>{dateStamp(row.ts)}</span>
            {row.event && <span>{row.event}</span>}
          </div>
          {row.body && (
            <div className="pc-advfeed__bodycard">
              <strong>Body</strong>
              <p className="pc-advfeed__body">{row.body}</p>
            </div>
          )}
          {row.next_action && (
            <div className="pc-advfeed__kv pc-advfeed__kv--action">
              <strong>next action</strong>
              <span>{row.next_action}</span>
            </div>
          )}
          {row.detail && !summary.includes(row.detail) && (
            <div className="pc-advfeed__kv">
              <strong>detail</strong>
              <span>{row.detail}</span>
            </div>
          )}
          {children.length > 0 && (
            <ol className="pc-advfeed__thread">
              {children.map((c) => (
                <li key={c.msg_id}>
                  <span className="pc-advfeed__threadrail" aria-hidden />
                  <span className="pc-advfeed__threadmeta">
                    <span
                      className="pc-advfeed__badge pc-advfeed__badge--sm"
                      style={{ borderColor: KIND_COLOR[c.kind] ?? '#64748b', color: KIND_COLOR[c.kind] ?? '#64748b' }}
                    >
                      <span aria-hidden />
                      {c.kind}
                    </span>
                    <strong>{c.from}</strong>
                    <em>{relTime(c.ts)}</em>
                  </span>
                  <span className="pc-advfeed__threadsum">
                    {c.summary ?? (c.choice ? `choice: ${c.choice}` : c.body ?? '')}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Threads view — the conversations Q&A substrate (unchanged behaviour) ──

const CONV_STATES = ['open', 'resolved', 'closed', 'all'] as const;
type ConvStateFilter = (typeof CONV_STATES)[number];
const CONV_KINDS = ['all', 'question', 'discussion'] as const;
type ConvKindFilter = (typeof CONV_KINDS)[number];

interface ConvRow {
  id: string;
  kind: string;
  state: string;
  scope: string;
  harness_slug: string | null;
  title: string | null;
  asker_id: string;
  topics?: string[];
  promoted_issue_id?: string | null;
  created_ts: string;
}
interface ConvPost {
  id: number;
  author_id: string | null;
  body: string;
  created_ts?: string;
}
interface ConvDetailT {
  id: string;
  kind: string;
  state: string;
  scope: string;
  harness_slug?: string | null;
  title: string | null;
  body?: string;
  asker_id?: string;
  accepted_answer?: string | null;
  promoted_issue_id?: string | null;
  topics: string[];
  posts: ConvPost[];
  subscriber_count: number;
}
interface ConvGetResponse {
  conversation?: Omit<ConvDetailT, 'topics' | 'posts' | 'subscriber_count'>;
  topics?: string[];
  posts?: ConvPost[];
  subscriber_count?: number;
}

function ThreadsView() {
  const [state, setState] = useQueryState('cstate', parseAsStringEnum<ConvStateFilter>([...CONV_STATES]).withDefault('open'));
  const [kind, setKind] = useQueryState('ckind', parseAsStringEnum<ConvKindFilter>([...CONV_KINDS]).withDefault('all'));
  const [topic, setTopic] = useQueryState('ctopic', parseAsString.withDefault(''));
  const [sel, setSel] = useQueryState('conversation', parseAsString);
  const [list, setList] = useState<ConvRow[]>([]);
  const [detail, setDetail] = useState<ConvDetailT | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    const body: Record<string, unknown> = {};
    if (state !== 'all') body.state = state;
    if (kind !== 'all') body.kind = kind;
    const r = await coord<{ conversations?: ConvRow[]; items?: ConvRow[] }>('conversations/list', body);
    setList(r.conversations ?? r.items ?? []);
    setLoading(false);
  }, [state, kind]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const loadDetail = useCallback(async (id: string) => {
    const r = await coord<ConvGetResponse>('conversations/get', { conversation_id: id });
    setDetail(
      r.conversation
        ? { ...r.conversation, topics: r.topics ?? [], posts: r.posts ?? [], subscriber_count: r.subscriber_count ?? 0 }
        : null,
    );
  }, []);
  useEffect(() => {
    if (!sel) {
      setDetail(null);
      return;
    }
    void loadDetail(sel);
    setReply('');
  }, [sel, loadDetail]);

  const allTopics = useMemo(() => {
    const s = new Set<string>();
    for (const c of list) for (const t of c.topics ?? []) s.add(t);
    return [...s].sort();
  }, [list]);
  const visible = useMemo(
    () => (topic ? list.filter((c) => (c.topics ?? []).includes(topic)) : list),
    [list, topic],
  );
  const act = async (verb: string, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await coord(verb, body);
      await reload();
      if (sel) await loadDetail(sel);
    } finally {
      setBusy(false);
    }
  };

  const canPromote = !!detail && detail.state !== 'closed' && !detail.promoted_issue_id;

  return (
    <div className="pc-coord__split pc-advconv__threads">
      <aside className="pc-coord__rail">
        <div className="pc-advconv__railhead">
          <span>Question &amp; discussion threads</span>
          <strong>{loading ? '…' : visible.length}</strong>
        </div>
        <div className="pc-coord__filters" role="tablist" aria-label="State filter">
          {CONV_STATES.map((s) => (
            <button key={s} type="button" className={`pc-coord__chip${state === s ? ' is-active' : ''}`} onClick={() => void setState(s)}>
              {s}
            </button>
          ))}
        </div>
        <div className="pc-coord__filters" role="tablist" aria-label="Kind filter">
          {CONV_KINDS.map((k) => (
            <button key={k} type="button" className={`pc-coord__chip${kind === k ? ' is-active' : ''}`} onClick={() => void setKind(k)}>
              {k}
            </button>
          ))}
          <button
            type="button"
            className="pc-coord__chip pc-advconv__refresh"
            aria-label="Reload conversations"
            disabled={loading}
            onClick={() => void reload()}
          >
            <RefreshCw size={11} aria-hidden />
          </button>
        </div>
        {allTopics.length > 0 && (
          <div className="pc-coord__filters" role="tablist" aria-label="Topic filter">
            <button type="button" className={`pc-coord__chip${!topic ? ' is-active' : ''}`} onClick={() => void setTopic('')}>
              all topics
            </button>
            {allTopics.map((t) => (
              <button key={t} type="button" className={`pc-coord__chip${topic === t ? ' is-active' : ''}`} onClick={() => void setTopic(topic === t ? '' : t)}>
                #{t}
              </button>
            ))}
          </div>
        )}
        {loading ? (
          <p className="pc-coord__empty pc-advconv__empty">Loading…</p>
        ) : visible.length === 0 ? (
          <div className="pc-coord__empty pc-advconv__empty pc-advconv__empty--rail">
            <strong>No threads match</strong>
            <span>Change the state, kind, or topic filter to widen the thread rail.</span>
          </div>
        ) : (
          visible.map((c) => (
            <button key={c.id} type="button" className={`pc-coord__row${sel === c.id ? ' is-active' : ''}`} onClick={() => void setSel(c.id)}>
              <span className="pc-advconv__threadtop">
                <span className={`pc-coord__kind pc-coord__kind--${c.kind}`}>{c.kind}</span>
                <span className={`pc-advconv__statepill pc-advconv__statepill--${c.state}`}>{c.state}</span>
              </span>
              <span className="pc-coord__row-title">{c.title ?? c.id}</span>
              <span className="pc-coord__row-meta">
                {c.harness_slug ? c.harness_slug : 'workspace'}
                {c.promoted_issue_id ? ` · → ${c.promoted_issue_id}` : ''}
              </span>
              <span className="pc-advconv__rowdate">{dateStamp(c.created_ts)}</span>
              {(c.topics ?? []).length > 0 && (
                <span className="pc-advconv__rowtags">
                  {(c.topics ?? []).map((t) => (
                    <span key={t} className="pc-coord__tag">#{t}</span>
                  ))}
                </span>
              )}
            </button>
          ))
        )}
      </aside>
      <section className="pc-coord__detail">
        {!detail ? (
          <div className="pc-coord__empty pc-advconv__empty pc-advconv__empty--detail">
            <MessageCircle size={22} aria-hidden />
            <strong>Select a thread</strong>
            <span>Open a question or discussion to review context, replies, accepted answers, and linked work-items.</span>
          </div>
        ) : (
          <article className="pc-coord__card">
            <header className="pc-advconv__detailhead">
              <div>
                <p className="pc-advconv__detailkicker">
                  <span className={`pc-coord__kind pc-coord__kind--${detail.kind}`}>{detail.kind}</span>
                  <span className={`pc-advconv__statepill pc-advconv__statepill--${detail.state}`}>{detail.state}</span>
                </p>
                <h2>{detail.title ?? detail.id}</h2>
              </div>
              <div className="pc-advconv__detailstats" aria-label="Conversation metadata">
                <span><strong>{detail.subscriber_count}</strong> follower{detail.subscriber_count === 1 ? '' : 's'}</span>
                <span>{detail.scope === 'harness' && detail.harness_slug ? detail.harness_slug : 'workspace'}</span>
                {detail.asker_id && <span>asked by {detail.asker_id}</span>}
              </div>
            </header>
            {detail.topics.length > 0 && (
              <p className="pc-coord__tags">
                {detail.topics.map((t) => (
                  <span key={t} className="pc-coord__tag">#{t}</span>
                ))}
              </p>
            )}
            {detail.body && <p className="pc-coord__body">{detail.body}</p>}
            {detail.accepted_answer && (
              <div className="pc-advconv__callout pc-advconv__callout--accepted">
                <CheckCircle2 size={15} aria-hidden />
                <div>
                  <strong>Accepted answer</strong>
                  <p>{detail.accepted_answer}</p>
                </div>
              </div>
            )}
            {detail.promoted_issue_id && (
              <div className="pc-advconv__callout pc-advconv__callout--linked">
                <ArrowUpRight size={15} aria-hidden />
                <div>
                  <strong>Linked work-item</strong>
                  <p>
                    <span>{detail.promoted_issue_id}</span>
                    <em>Promoted to an engineer issue; implementation discussion continues there.</em>
                  </p>
                </div>
              </div>
            )}
            <div className="pc-coord__actions">
              {canPromote && (
                <button type="button" disabled={busy} aria-label="Promote this conversation to an engineer issue" onClick={() => void act('conversations/promote', { conversation_id: detail.id })}>
                  <ArrowUpRight size={13} aria-hidden /> Promote to issue
                </button>
              )}
            </div>
            <ol className="pc-coord__thread">
              {detail.posts.map((p) => (
                <li key={p.id}>
                  <span className="pc-advconv__postmeta">
                    <strong>{p.author_id ?? 'unknown'}</strong>
                    {p.created_ts && <span>{dateStamp(p.created_ts)}</span>}
                  </span>
                  <p>{p.body}</p>
                </li>
              ))}
              {detail.posts.length === 0 && (
                <li className="pc-coord__empty pc-advconv__empty pc-advconv__empty--thread">
                  <strong>No replies yet</strong>
                  <span>This thread is waiting for its first response.</span>
                </li>
              )}
            </ol>
            {detail.state === 'open' && (
              <div className="pc-advconv__reply">
                <div className="pc-advconv__replyhead">
                  <span>
                    <MessageCircle size={13} aria-hidden />
                    Thread response
                  </span>
                  <em>{detail.kind === 'question' ? 'Resolve with an accepted answer when this closes the loop.' : 'Add context for everyone subscribed to this discussion.'}</em>
                </div>
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder={detail.kind === 'question' ? 'Write a reply, or accept it as the answer…' : 'Write a reply…'}
                  rows={2}
                />
                <div className="pc-coord__actions pc-advconv__replyactions">
                  <button type="button" className="pc-advconv__replybtn" disabled={busy || !reply.trim()} onClick={() => { const b = reply.trim(); setReply(''); void act('conversations/post', { conversation_id: detail.id, body: b }); }}>
                    <Send size={12} aria-hidden /> Reply
                  </button>
                  {detail.kind === 'question' && (
                    <button type="button" className="pc-advconv__replybtn pc-advconv__replybtn--resolve" disabled={busy || !reply.trim()} aria-label="Record this reply as the accepted answer and resolve the question" onClick={() => { const b = reply.trim(); setReply(''); void act('conversations/resolve', { conversation_id: detail.id, accepted_answer: b }); }}>
                      <CheckCircle2 size={12} aria-hidden /> Accept as answer
                    </button>
                  )}
                </div>
              </div>
            )}
          </article>
        )}
      </section>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────

function AdvConvStyles() {
  return (
    <style>{`
      .pc-advconv {
        --advconv-bg: var(--bg, #07101d);
        --advconv-panel: color-mix(in srgb, var(--bg-1, #0b1220), transparent 14%);
        --advconv-panel-strong: color-mix(in srgb, var(--bg-popover, #0d1829), transparent 6%);
        --advconv-border: var(--border, rgba(125, 211, 252, 0.15));
        --advconv-border-strong: var(--border-strong, rgba(125, 211, 252, 0.32));
        --advconv-accent: var(--accent, #38bdf8);
        --advconv-accent-strong: var(--accent-strong, #7dd3fc);
        --advconv-accent-soft: color-mix(in oklab, var(--accent, #38bdf8), transparent 86%);
        --advconv-accent-softer: color-mix(in oklab, var(--accent, #38bdf8), transparent 92%);
        --advconv-good-soft: color-mix(in oklab, var(--good, #22c55e), transparent 88%);
        --advconv-warn-soft: color-mix(in oklab, var(--warn, #f59e0b), transparent 90%);
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 1px;
        color: var(--fg, #dceaf6);
        background: linear-gradient(180deg, color-mix(in srgb, var(--bg-deep, #050d18), transparent 24%), transparent 220px);
      }
      .pc-advconv__hero {
        position: relative;
        display: flex;
        align-items: stretch;
        justify-content: space-between;
        gap: 16px;
        flex: 0 0 auto;
        padding: 16px;
        border: 1px solid var(--advconv-border);
        border-radius: 18px;
        overflow: hidden;
        background: linear-gradient(180deg, var(--advconv-panel-strong), color-mix(in srgb, var(--bg-1, #0b1220), transparent 16%));
        box-shadow: none;
      }
      .pc-advconv__hero::after {
        content: "";
        position: absolute;
        inset: auto 18px 0 18px;
        height: 1px;
        background: linear-gradient(90deg, transparent, var(--advconv-border-strong), transparent);
      }
      .pc-advconv__hero-copy { position: relative; z-index: 1; max-width: 740px; }
      .pc-advconv__eyebrow {
        display: inline-flex;
        margin-bottom: 6px;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--advconv-accent-strong);
      }
      .pc-advconv__hero h1 {
        margin: 0;
        font-size: clamp(24px, 3.6vw, 40px);
        line-height: 0.95;
        letter-spacing: -0.055em;
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__hero p {
        margin: 8px 0 0;
        color: var(--fg-mute, #9fb6cc);
        font-size: 13px;
        line-height: 1.45;
      }
      .pc-advconv__herochips {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
        margin-top: 12px;
      }
      .pc-advconv__herochips span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 26px;
        padding: 3px 9px;
        border-radius: 999px;
        border: 1px solid var(--advconv-border);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 22%);
        color: var(--fg-dim, #b9d4e8);
        font-size: 11px;
        font-weight: 750;
        box-shadow: none;
      }
      .pc-advconv .pc-coord__chip {
        transition: background-color 140ms, border-color 140ms, color 140ms;
      }
      .pc-advconv .pc-coord__chip {
        border-color: var(--advconv-border);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 40%);
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-advconv .pc-coord__chip:hover:not(:disabled) {
        border-color: var(--advconv-border-strong);
        background: var(--advconv-accent-soft);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv .pc-coord__chip.is-active {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 48%);
        background: color-mix(in oklab, var(--advconv-accent), transparent 78%);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__rowtags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; grid-column: 1 / -1; }
      .pc-advconv__refresh { margin-left: auto; display: inline-flex; align-items: center; }
      .pc-advconv__callout {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 10px;
        align-items: flex-start;
        margin: 8px 0;
        padding: 12px;
        border-radius: 14px;
        border: 1px solid var(--advconv-border);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 26%);
        color: var(--fg-mute, #9fb6cc);
      }
      .pc-advconv__callout > svg { margin-top: 2px; }
      .pc-advconv__callout strong {
        display: block;
        margin-bottom: 4px;
        color: var(--fg, #e7f7ff);
        font-size: 12px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
      .pc-advconv__callout p {
        margin: 0;
        line-height: 1.5;
      }
      .pc-advconv__callout--accepted {
        border-color: color-mix(in oklab, var(--good, #22c55e), transparent 68%);
        background: var(--advconv-good-soft);
      }
      .pc-advconv__callout--accepted > svg { color: var(--good, #22c55e); }
      .pc-advconv__callout--linked {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 70%);
        background: var(--advconv-accent-softer);
      }
      .pc-advconv__callout--linked > svg { color: var(--advconv-accent-strong); }
      .pc-advconv__callout--linked p {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .pc-advconv__callout--linked p span {
        display: inline-flex;
        padding: 2px 7px;
        border-radius: 999px;
        border: 1px solid var(--advconv-border);
        color: var(--advconv-accent-strong);
        background: var(--advconv-accent-soft);
        font-weight: 750;
      }
      .pc-advconv__callout--linked p em {
        color: var(--fg-mute, #8aa3bc);
        font-style: normal;
      }
      .pc-advconv__empty {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--fg-mute, #8aa3bc);
      }
      .pc-advconv__empty--card,
      .pc-advconv__empty--detail,
      .pc-advconv__empty--rail,
      .pc-advconv__empty--thread {
        align-items: flex-start;
        flex-direction: column;
        justify-content: center;
        min-height: 160px;
        padding: 22px;
        border-radius: 16px;
        border: 1px dashed var(--advconv-border);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 35%);
      }
      .pc-advconv__empty--detail {
        min-height: 100%;
        align-items: center;
        text-align: center;
      }
      .pc-advconv__empty--rail,
      .pc-advconv__empty--thread {
        min-height: 112px;
        padding: 16px;
        border-radius: 14px;
      }
      .pc-advconv__empty--thread {
        min-height: 92px;
        margin-top: 4px;
      }
      .pc-advconv__empty strong { color: var(--fg, #e7f7ff); font-size: 14px; }
      .pc-advconv__empty span { max-width: 420px; line-height: 1.45; }
      .pc-advconv__reply {
        margin-top: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 12px;
        border-radius: 15px;
        border: 1px solid var(--advconv-border);
        background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 18%);
      }
      .pc-advconv__replyhead {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        color: var(--fg-mute, #8aa3bc);
        font-size: 11px;
      }
      .pc-advconv__replyhead span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--fg, #e7f7ff);
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .pc-advconv__replyhead em {
        max-width: 410px;
        text-align: right;
        font-style: normal;
        line-height: 1.35;
      }
      .pc-advconv__reply textarea {
        width: 100%; resize: vertical; min-height: 58px;
        background: color-mix(in srgb, var(--bg, #07101d), transparent 18%); color: var(--fg, #e7f7ff);
        border: 1px solid var(--advconv-border);
        border-radius: 12px; padding: 10px 11px; font: inherit; font-size: 12px;
        box-shadow: none;
      }
      .pc-advconv__reply textarea:focus { outline: 2px solid color-mix(in oklab, var(--advconv-accent), transparent 66%); outline-offset: 2px; }
      .pc-advconv__replyactions { justify-content: flex-end; }
      .pc-advconv__replybtn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .pc-advconv__replybtn--resolve:not(:disabled) {
        border-color: color-mix(in oklab, var(--good, #22c55e), transparent 58%);
        color: var(--fg, #e7f7ff);
        background: var(--advconv-good-soft);
      }

      /* View tabs */
      .pc-advconv__viewtabs {
        position: relative;
        z-index: 1;
        align-self: flex-start;
        display: grid;
        grid-template-columns: repeat(2, minmax(116px, 1fr));
        gap: 5px;
        padding: 5px;
        flex: 0 0 auto;
        border: 1px solid var(--advconv-border);
        border-radius: 18px;
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 28%);
        box-shadow: none;
      }
      .pc-advconv__viewtab {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: center;
        gap: 8px;
        padding: 9px 11px;
        border-radius: 14px;
        font-size: 12px;
        font-weight: 800;
        border: 1px solid transparent;
        background: transparent; color: var(--fg-mute, #8aa3bc); cursor: pointer;
        transition: background-color 140ms, border-color 140ms, color 140ms;
      }
      .pc-advconv__viewtab span {
        display: flex;
        min-width: 0;
        flex-direction: column;
        align-items: flex-start;
        gap: 1px;
      }
      .pc-advconv__viewtab em {
        color: var(--fg-mute, #6f87a0);
        font-size: 9px;
        font-style: normal;
        font-weight: 750;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .pc-advconv__viewtab:hover {
        border-color: var(--advconv-border);
        background: var(--advconv-accent-softer);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__viewtab.is-active {
        background: color-mix(in oklab, var(--advconv-accent), transparent 78%);
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 48%);
        color: var(--fg, #e7f7ff);
        box-shadow: none;
      }
      .pc-advconv__viewtab.is-active em { color: var(--advconv-accent-strong); }

      /* Threads split fills the remaining height */
      .pc-advconv .pc-coord__split { flex: 1 1 auto; min-height: 0; }
      .pc-advconv__threads {
        grid-template-columns: minmax(280px, 390px) minmax(0, 1fr);
        gap: 12px;
      }
      .pc-advconv__threads .pc-coord__rail,
      .pc-advconv__threads .pc-coord__detail {
        max-height: none;
        min-height: 0;
        border: 1px solid var(--advconv-border);
        border-radius: 16px;
        background: var(--advconv-panel);
        backdrop-filter: blur(12px);
      }
      .pc-advconv__threads .pc-coord__rail {
        padding: 10px;
        gap: 8px;
      }
      .pc-advconv__threads .pc-coord__detail {
        border-left: 1px solid var(--advconv-border);
        padding: 14px;
      }
      .pc-advconv__railhead {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 4px 2px 8px;
        color: var(--fg-mute, #9fb6cc);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .pc-advconv__railhead strong {
        display: inline-flex;
        min-width: 28px;
        justify-content: center;
        border-radius: 999px;
        padding: 2px 7px;
        color: var(--fg, #e7f7ff);
        background: var(--advconv-accent-soft);
        border: 1px solid var(--advconv-border);
      }
      .pc-advconv__threads .pc-coord__row {
        position: relative;
        grid-template-columns: auto 1fr;
        padding: 10px 11px;
        border-radius: 12px;
        border-color: color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.15)), transparent 48%);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 38%);
        transition: background-color 140ms, border-color 140ms;
      }
      .pc-advconv__threads .pc-coord__row:hover {
        background: var(--advconv-accent-softer);
        border-color: var(--advconv-border);
      }
      .pc-advconv__threads .pc-coord__row.is-active {
        background: var(--advconv-accent-soft);
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 50%);
        box-shadow: none;
      }
      .pc-advconv__threadtop {
        grid-row: 1 / span 2;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 5px;
        min-width: 72px;
      }
      .pc-advconv__statepill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 18px;
        padding: 1px 6px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 72%);
        background: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 90%);
        color: var(--fg-dim, #b9d4e8);
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .pc-advconv__statepill--open {
        border-color: color-mix(in oklab, var(--good, #22c55e), transparent 58%);
        background: var(--advconv-good-soft);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__statepill--resolved {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 58%);
        background: var(--advconv-accent-soft);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__statepill--closed {
        border-color: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 80%);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 48%);
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-advconv__rowdate {
        position: absolute;
        top: 10px;
        right: 11px;
        max-width: 118px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--fg-mute, #6f87a0);
        font-size: 10px;
        font-variant-numeric: tabular-nums;
      }
      .pc-advconv__threads .pc-coord__row-title {
        padding-right: 116px;
        font-weight: 750;
        letter-spacing: -0.01em;
      }
      .pc-advconv__threads .pc-coord__card {
        min-height: 100%;
        padding: 6px;
      }
      .pc-advconv__detailhead {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 4px 0 12px;
        border-bottom: 1px solid var(--advconv-border);
      }
      .pc-advconv__detailkicker {
        display: flex;
        align-items: center;
        gap: 7px;
        margin: 0 0 8px;
      }
      .pc-advconv__threads .pc-coord__card header h2 {
        font-size: clamp(20px, 3vw, 30px);
        line-height: 1;
        letter-spacing: -0.04em;
      }
      .pc-advconv__detailstats {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 6px;
        max-width: 390px;
      }
      .pc-advconv__detailstats span {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        padding: 3px 8px;
        border-radius: 999px;
        border: 1px solid var(--advconv-border);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 34%);
        color: var(--fg-mute, #9fb6cc);
        font-size: 11px;
      }
      .pc-advconv__detailstats strong {
        color: var(--fg, #e7f7ff);
        font-variant-numeric: tabular-nums;
      }
      .pc-advconv__threads .pc-coord__thread li {
        position: relative;
        border-left-color: color-mix(in oklab, var(--advconv-accent), transparent 62%);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 34%);
        border-radius: 0 12px 12px 0;
        padding: 10px 12px;
      }
      .pc-advconv__threads .pc-coord__thread li::before {
        content: "";
        position: absolute;
        left: -5px;
        top: 16px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--advconv-accent);
        box-shadow: none;
      }
      .pc-advconv__postmeta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        color: var(--fg-mute, #8aa3bc);
        font-size: 11px;
      }
      .pc-advconv__postmeta strong {
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__postmeta span {
        font-variant-numeric: tabular-nums;
        color: var(--fg-mute, #7f9bb4);
      }

      /* Feed */
      .pc-advfeed { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
      .pc-advfeed__clarity {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto minmax(220px, auto) auto;
        align-items: stretch;
        gap: 8px;
        flex: 0 0 auto;
        font-size: 12px; color: var(--fg-mute, #9fb6cc);
        padding: 10px;
        border-radius: 16px;
        background: var(--advconv-panel);
        border: 1px solid var(--advconv-border);
        backdrop-filter: blur(12px);
      }
      .pc-advfeed__clarity-main {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        padding: 8px 10px;
        border-radius: 12px;
        background: var(--advconv-accent-softer);
        border: 1px solid var(--advconv-border);
      }
      .pc-advfeed__clarity-main span { min-width: 0; }
      .pc-advfeed__stat {
        min-width: 102px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 2px;
        padding: 7px 10px;
        border-radius: 12px;
        border: 1px solid color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.15)), transparent 56%);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 38%);
      }
      .pc-advfeed__stat span {
        font-size: 9px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--fg-mute, #7890a8);
      }
      .pc-advfeed__stat strong {
        color: var(--fg, #e7f7ff);
        font-size: 13px;
        font-variant-numeric: tabular-nums;
      }
      .pc-advfeed__signals {
        display: grid;
        grid-template-columns: repeat(3, auto);
        align-items: center;
        gap: 5px;
        padding: 6px;
        border-radius: 12px;
        border: 1px solid color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.15)), transparent 56%);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 42%);
      }
      .pc-advfeed__signals span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-height: 26px;
        padding: 3px 7px;
        border-radius: 999px;
        color: var(--fg-dim, #b9d4e8);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 34%);
        border: 1px solid var(--advconv-border);
        font-size: 10px;
        font-weight: 700;
        white-space: nowrap;
      }
      .pc-advfeed__filters {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 11px;
        border-radius: 16px;
        background: var(--advconv-panel);
        border: 1px solid var(--advconv-border);
      }
      .pc-advfeed__filterhead {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 1px 2px 2px;
        color: var(--fg-mute, #8aa3bc);
        font-size: 11px;
      }
      .pc-advfeed__filterhead span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--fg, #e7f7ff);
        font-weight: 850;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }
      .pc-advfeed__filterhead strong {
        display: inline-flex;
        align-items: center;
        min-height: 22px;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--advconv-border);
        background: var(--advconv-accent-soft);
        color: var(--fg, #e7f7ff);
        font-size: 10px;
        font-variant-numeric: tabular-nums;
      }
      .pc-advfeed__kindchip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; }
      .pc-advfeed__kinddot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
      .pc-advfeed__kindn {
        font-variant-numeric: tabular-nums; font-size: 10px; opacity: 0.8;
        background: color-mix(in srgb, var(--bg-3, rgba(255, 255, 255, 0.075)), transparent 20%); border-radius: 6px; padding: 0 4px; margin-left: 2px;
      }
      .pc-advfeed__inputs { display: flex; gap: 7px; flex-wrap: wrap; align-items: flex-end; }
      .pc-advfeed__field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1 1 150px;
        min-width: 130px;
      }
      .pc-advfeed__field > span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: var(--fg-mute, #7890a8);
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .pc-advfeed__field--wide { flex: 2 1 260px; }
      .pc-advfeed__input {
        width: 100%;
        background: color-mix(in srgb, var(--bg, #07101d), transparent 20%); color: var(--fg, #e7f7ff);
        border: 1px solid var(--advconv-border);
        border-radius: 10px; padding: 7px 10px; font: inherit; font-size: 12px; min-width: 0;
      }
      .pc-advfeed__input--wide { flex: 1 1 200px; }
      .pc-advfeed__input:focus { outline: 2px solid color-mix(in oklab, var(--advconv-accent), transparent 66%); outline-offset: 1px; }
      .pc-advfeed__clear { min-height: 32px; }
      .pc-advfeed__scopebar {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        padding-top: 2px;
        font-size: 11px;
        color: var(--fg-mute, #8aa3bc);
      }
      .pc-advfeed__scopebar > span {
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-advfeed__scopebar strong {
        display: inline-flex;
        align-items: center;
        max-width: 280px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 3px 8px;
        border-radius: 999px;
        border: 1px solid var(--advconv-border);
        background: var(--advconv-accent-soft);
        color: var(--fg, #e7f7ff);
        font-weight: 700;
      }

      .pc-advfeed__stream {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 6px 2px 12px;
      }
      .pc-advfeed__daysep {
        position: sticky; top: 0; z-index: 1;
        font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
        color: var(--fg-mute, #7890a8); padding: 7px 2px 2px;
        background: linear-gradient(var(--advconv-bg), color-mix(in srgb, var(--advconv-bg), transparent 18%));
      }
      .pc-advfeed__daysep span {
        display: inline-flex;
        padding: 3px 8px;
        border-radius: 999px;
        background: var(--advconv-accent-softer);
        border: 1px solid var(--advconv-border);
      }
      .pc-advfeed__item { border-radius: 7px; }
      .pc-advfeed__item.is-open { background: var(--advconv-accent-softer); }
      .pc-advfeed__row {
        width: 100%; display: grid;
        grid-template-columns: auto auto minmax(120px, 1fr) minmax(0, 2fr) auto auto auto;
        align-items: center; gap: 8px; text-align: left;
        padding: 9px 10px;
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 40%);
        font-size: 12px; color: var(--fg, #dceaf6);
        border: 1px solid color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.15)), transparent 58%);
        border-radius: 13px;
        transition: background-color 140ms, border-color 140ms;
      }
      .pc-advfeed__row:hover {
        background: var(--advconv-accent-softer);
        border-color: var(--advconv-border);
      }
      .pc-advfeed__item.is-open .pc-advfeed__row {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 58%);
        background: var(--advconv-accent-soft);
      }
      .pc-advfeed__time { font-variant-numeric: tabular-nums; font-size: 11px; color: var(--fg-mute, #7890a8); }
      .pc-advfeed__badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 999px;
        border: 1px solid currentColor; background: color-mix(in srgb, currentColor 12%, transparent);
        white-space: nowrap; text-transform: lowercase;
      }
      .pc-advfeed__badge > span {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: var(--feed-kind-color, currentColor);
        box-shadow: none;
      }
      .pc-advfeed__badge--sm { font-size: 9px; padding: 0 5px; }
      .pc-advfeed__route { display: inline-flex; align-items: center; gap: 5px; min-width: 0; font-size: 11px; }
      .pc-advfeed__from {
        border: none; background: none; color: var(--fg, #cfe8ff); font: inherit; font-size: 11px;
        font-weight: 600; cursor: pointer; padding: 0; max-width: 120px; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap;
      }
      .pc-advfeed__from:hover { text-decoration: underline; }
      .pc-advfeed__to { color: var(--fg-mute, #8aa3bc); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
      .pc-advfeed__to--broadcast { color: var(--advconv-accent-strong); font-weight: 600; display: inline-flex; align-items: center; gap: 3px; }
      .pc-advfeed__to--human { color: var(--warn, #f59e0b); font-weight: 600; display: inline-flex; align-items: center; gap: 3px; }
      .pc-advfeed__summary {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg, #dceaf6);
        border: none; background: none; font: inherit; font-size: 12px; text-align: left;
        cursor: pointer; padding: 0; min-width: 0;
      }
      .pc-advfeed__summary:hover { color: var(--fg, #e7f7ff); }
      .pc-advfeed__nosum { color: var(--fg-mute, #5f7488); }
      .pc-advfeed__planchip {
        font-size: 10px; padding: 2px 7px; border-radius: 999px; white-space: nowrap;
        border: 1px solid color-mix(in oklab, var(--advconv-accent), transparent 58%);
        color: var(--advconv-accent-strong);
        background: var(--advconv-accent-softer);
        cursor: pointer; font: inherit;
      }
      .pc-advfeed__planchip:hover { background: var(--advconv-accent-soft); }
      .pc-advfeed__replyn { font-size: 10px; color: var(--fg-mute, #8aa3bc); white-space: nowrap; }
      .pc-advfeed__rel { font-size: 10px; color: var(--fg-mute, #6f87a0); white-space: nowrap; font-variant-numeric: tabular-nums; }
      .pc-advfeed__detail {
        margin: 0 8px 4px 36px;
        padding: 11px 12px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        font-size: 12px;
        border: 1px solid var(--advconv-border);
        border-left: 2px solid color-mix(in oklab, var(--advconv-accent), transparent 58%);
        background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 18%);
        border-radius: 0 14px 14px 0;
        box-shadow: none;
      }
      .pc-advfeed__detailhead {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .pc-advfeed__detailhead span {
        display: inline-flex;
        align-items: center;
        min-height: 20px;
        padding: 2px 7px;
        border-radius: 999px;
        border: 1px solid var(--advconv-border);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 34%);
        color: var(--fg-mute, #8aa3bc);
        font-size: 10px;
        font-weight: 700;
      }
      .pc-advfeed__bodycard,
      .pc-advfeed__kv {
        padding: 10px;
        border-radius: 12px;
        border: 1px solid color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.15)), transparent 58%);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 40%);
      }
      .pc-advfeed__bodycard strong,
      .pc-advfeed__kv strong {
        display: block;
        margin-bottom: 4px;
        color: var(--fg, #e7f7ff);
        font-size: 10px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }
      .pc-advfeed__body { white-space: pre-wrap; color: var(--fg, #dceaf6); margin: 0; line-height: 1.5; }
      .pc-advfeed__kv { color: var(--fg-mute, #9fb6cc); margin: 0; }
      .pc-advfeed__kv span { color: var(--fg-mute, #b6c8d8); line-height: 1.45; }
      .pc-advfeed__kv--action {
        border-color: color-mix(in oklab, var(--warn, #f59e0b), transparent 70%);
        background: var(--advconv-warn-soft);
      }
      .pc-advfeed__kv--action strong { color: var(--warn, #f59e0b); }
      .pc-advfeed__thread {
        list-style: none;
        margin: 2px 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .pc-advfeed__thread li {
        position: relative;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: start;
        gap: 8px 9px;
        padding: 8px 9px 8px 2px;
        font-size: 11px;
      }
      .pc-advfeed__threadrail {
        width: 9px;
        height: 9px;
        margin-top: 5px;
        border-radius: 50%;
        background: var(--advconv-accent);
        box-shadow: none;
      }
      .pc-advfeed__threadmeta {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
      }
      .pc-advfeed__threadmeta strong { color: var(--fg, #e7f7ff); font-size: 11px; }
      .pc-advfeed__threadmeta em { color: var(--fg-mute, #6f87a0); font-style: normal; margin-left: auto; white-space: nowrap; }
      .pc-advfeed__threadsum {
        grid-column: 2;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--fg-mute, #aebfd0);
      }
      .pc-advfeed__loadolder {
        margin: 8px auto; padding: 6px 16px; border-radius: 8px; font-size: 12px; cursor: pointer;
        border: 1px solid var(--border, rgba(125,211,252,0.2)); background: transparent; color: var(--fg-mute, #9fb6cc); font: inherit;
      }
      .pc-advfeed__loadolder:hover { color: var(--fg, #e7f7ff); border-color: var(--advconv-border-strong); background: var(--advconv-accent-soft); }
      .pc-advfeed__refresh { flex: 0 0 auto; }
      @media (max-width: 920px) {
        .pc-advconv__hero { flex-direction: column; }
        .pc-advconv__viewtabs { align-self: stretch; }
        .pc-advconv__viewtab { justify-content: center; }
        .pc-advconv__detailhead { flex-direction: column; }
        .pc-advconv__detailstats { justify-content: flex-start; max-width: none; }
        .pc-advconv__replyhead { flex-direction: column; }
        .pc-advconv__replyhead em { max-width: none; text-align: left; }
        .pc-advfeed__clarity { grid-template-columns: 1fr 1fr; }
        .pc-advfeed__clarity-main { grid-column: 1 / -1; }
        .pc-advfeed__signals { grid-column: 1 / -1; grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .pc-advfeed__signals span { justify-content: center; }
        .pc-advfeed__refresh { justify-content: center; }
        .pc-advconv__threads { grid-template-columns: 1fr; }
        .pc-advconv__threads .pc-coord__rail { max-height: 34vh; }
        .pc-advfeed__row {
          grid-template-columns: auto auto minmax(0, 1fr) auto;
        }
        .pc-advfeed__summary {
          grid-column: 3 / -1;
        }
        .pc-advfeed__planchip,
        .pc-advfeed__replyn,
        .pc-advfeed__rel {
          grid-column: auto;
        }
      }
      @media (max-width: 620px) {
        .pc-advconv__hero { padding: 13px; border-radius: 15px; }
        .pc-advfeed__clarity { grid-template-columns: 1fr; }
        .pc-advfeed__stat { min-width: 0; }
        .pc-advfeed__signals { grid-template-columns: 1fr; }
        .pc-advconv__rowdate { position: static; grid-column: 2; max-width: none; }
        .pc-advconv__threads .pc-coord__row-title { padding-right: 0; }
        .pc-advfeed__inputs { flex-direction: column; }
        .pc-advfeed__field { width: 100%; }
        .pc-advfeed__clear { width: 100%; justify-content: center; }
        .pc-advfeed__row {
          grid-template-columns: auto minmax(0, 1fr);
          gap: 6px;
        }
        .pc-advfeed__time,
        .pc-advfeed__badge,
        .pc-advfeed__route,
        .pc-advfeed__summary,
        .pc-advfeed__planchip,
        .pc-advfeed__replyn,
        .pc-advfeed__rel {
          grid-column: auto;
        }
        .pc-advfeed__summary { grid-column: 1 / -1; }
        .pc-advfeed__detail { margin-left: 8px; }
      }
    `}</style>
  );
}
