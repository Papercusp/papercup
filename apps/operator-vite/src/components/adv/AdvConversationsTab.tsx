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
import { ArrowUpRight, MessageCircle, RefreshCw, Radio, Megaphone, UserRound } from 'lucide-react';
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
      <div className="pc-advconv__viewtabs" role="tablist" aria-label="Conversations view">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'feed'}
          className={`pc-advconv__viewtab${view === 'feed' ? ' is-active' : ''}`}
          onClick={() => void setView('feed')}
        >
          <Radio size={13} aria-hidden /> Feed
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'threads'}
          className={`pc-advconv__viewtab${view === 'threads' ? ' is-active' : ''}`}
          onClick={() => void setView('threads')}
        >
          <MessageCircle size={13} aria-hidden /> Threads
        </button>
      </div>
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
  message: '#7dd3fc',
  ack: '#94a3b8',
  notify: '#fbbf24',
  broadcast: '#f472b6',
  handoff: '#a78bfa',
  handoff_accepted: '#c4b5fd',
  escalation: '#f87171',
  escalation_resolved: '#86efac',
  plan_event: '#5eead4',
  subscribe: '#67e8f9',
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
        <Radio size={13} aria-hidden />
        <span>
          Every coordination envelope across the fleet — messages, broadcasts, handoffs, escalations & plan events, newest first.
        </span>
        <span className="pc-advfeed__count">
          {meta ? `${meta.total} matching` : head.loading ? 'loading…' : '0'}
        </span>
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
          <input
            className="pc-advfeed__input"
            placeholder="agent (from or to)…"
            value={agent}
            onChange={(e) => void setAgent(e.target.value)}
            aria-label="Filter by agent"
          />
          <input
            className="pc-advfeed__input"
            placeholder="plan slug…"
            value={plan}
            onChange={(e) => void setPlan(e.target.value)}
            aria-label="Filter by plan slug"
          />
          <input
            className="pc-advfeed__input pc-advfeed__input--wide"
            placeholder="search text…"
            value={q}
            onChange={(e) => void setQ(e.target.value)}
            aria-label="Free-text search"
          />
          {filtersActive && (
            <button type="button" className="pc-coord__chip" onClick={clearFilters}>
              clear
            </button>
          )}
        </div>
      </div>

      {/* The stream */}
      <div className="pc-advfeed__stream">
        {head.loading && allRows.length === 0 ? (
          <p className="pc-coord__empty">Loading the coordination feed…</p>
        ) : head.error ? (
          <p className="pc-coord__empty">Feed unavailable: {head.error.message}</p>
        ) : roots.length === 0 ? (
          <p className="pc-coord__empty">No coordination traffic matches these filters.</p>
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
        <span className="pc-advfeed__badge" style={{ borderColor: color, color }}>
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
          {row.body && <p className="pc-advfeed__body">{row.body}</p>}
          {row.next_action && (
            <p className="pc-advfeed__kv">
              <strong>next action:</strong> {row.next_action}
            </p>
          )}
          {row.detail && !summary.includes(row.detail) && (
            <p className="pc-advfeed__kv">
              <strong>detail:</strong> {row.detail}
            </p>
          )}
          {children.length > 0 && (
            <ol className="pc-advfeed__thread">
              {children.map((c) => (
                <li key={c.msg_id}>
                  <span
                    className="pc-advfeed__badge pc-advfeed__badge--sm"
                    style={{ borderColor: KIND_COLOR[c.kind] ?? '#64748b', color: KIND_COLOR[c.kind] ?? '#64748b' }}
                  >
                    {c.kind}
                  </span>
                  <span className="pc-advfeed__threadfrom">{c.from}</span>
                  <span className="pc-advfeed__threadsum">
                    {c.summary ?? (c.choice ? `choice: ${c.choice}` : c.body ?? '')}
                  </span>
                  <span className="pc-advfeed__rel">{relTime(c.ts)}</span>
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
    <div className="pc-coord__split">
      <aside className="pc-coord__rail">
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
          <p className="pc-coord__empty">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="pc-coord__empty">No conversations.</p>
        ) : (
          visible.map((c) => (
            <button key={c.id} type="button" className={`pc-coord__row${sel === c.id ? ' is-active' : ''}`} onClick={() => void setSel(c.id)}>
              <span className={`pc-coord__kind pc-coord__kind--${c.kind}`}>{c.kind}</span>
              <span className="pc-coord__row-title">{c.title ?? c.id}</span>
              <span className="pc-coord__row-meta">
                {c.state}
                {c.harness_slug ? ` · ${c.harness_slug}` : ''}
                {c.promoted_issue_id ? ` · → ${c.promoted_issue_id}` : ''}
              </span>
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
          <p className="pc-coord__empty">
            <MessageCircle size={14} aria-hidden /> Select a conversation.
          </p>
        ) : (
          <article className="pc-coord__card">
            <header>
              <h2>{detail.title ?? detail.id}</h2>
              <p className="pc-coord__row-meta">
                {detail.kind} · {detail.state} · {detail.subscriber_count} follower(s)
                {detail.scope === 'harness' && detail.harness_slug ? ` · ${detail.harness_slug}` : ''}
                {detail.asker_id ? ` · asked by ${detail.asker_id}` : ''}
              </p>
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
              <p className="pc-coord__body pc-advconv__accepted">
                <strong>✓ Accepted answer:</strong> {detail.accepted_answer}
              </p>
            )}
            {detail.promoted_issue_id && (
              <p className="pc-advconv__linked">
                <ArrowUpRight size={13} aria-hidden /> Linked work-item: <strong>{detail.promoted_issue_id}</strong>
                <span className="pc-coord__row-meta"> (promoted to an engineer issue — discussion continues there)</span>
              </p>
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
                  <span className="pc-coord__row-meta">{p.author_id ?? 'unknown'}</span>
                  <p>{p.body}</p>
                </li>
              ))}
              {detail.posts.length === 0 && <li className="pc-coord__empty">No replies yet.</li>}
            </ol>
            {detail.state === 'open' && (
              <div className="pc-advconv__reply">
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder={detail.kind === 'question' ? 'Write a reply, or accept it as the answer…' : 'Write a reply…'}
                  rows={2}
                />
                <div className="pc-coord__actions">
                  <button type="button" disabled={busy || !reply.trim()} onClick={() => { const b = reply.trim(); setReply(''); void act('conversations/post', { conversation_id: detail.id, body: b }); }}>
                    Reply
                  </button>
                  {detail.kind === 'question' && (
                    <button type="button" disabled={busy || !reply.trim()} aria-label="Record this reply as the accepted answer and resolve the question" onClick={() => { const b = reply.trim(); setReply(''); void act('conversations/resolve', { conversation_id: detail.id, accepted_answer: b }); }}>
                      Accept as answer
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
        --advconv-accent: #7dd3fc;
        --advconv-accent-strong: #38bdf8;
        --advconv-accent-soft: rgba(125, 211, 252, 0.1);
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .pc-advconv .pc-coord__chip { transition: background-color 120ms, border-color 120ms, color 120ms; }
      .pc-advconv .pc-coord__chip {
        border-color: var(--border, rgba(125, 211, 252, 0.18));
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-advconv .pc-coord__chip:hover:not(:disabled) {
        border-color: rgba(125, 211, 252, 0.38);
        background: var(--advconv-accent-soft);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv .pc-coord__chip.is-active {
        border-color: rgba(56, 189, 248, 0.48);
        background: rgba(56, 189, 248, 0.16);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__rowtags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; grid-column: 1 / -1; }
      .pc-advconv__refresh { margin-left: auto; display: inline-flex; align-items: center; }
      .pc-advconv__accepted { border-left: 2px solid rgba(34, 197, 94, 0.6); padding-left: 8px; }
      .pc-advconv__linked { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; color: #bae6fd; margin: 4px 0; }
      .pc-advconv__reply { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
      .pc-advconv__reply textarea {
        width: 100%; resize: vertical; min-height: 38px;
        background: var(--bg-popover, #0d1829); color: var(--fg, #e7f7ff);
        border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.32));
        border-radius: 8px; padding: 7px 9px; font: inherit; font-size: 12px;
      }
      .pc-advconv__reply textarea:focus { outline: 2px solid rgba(56, 189, 248, 0.34); outline-offset: 2px; }

      /* View tabs */
      .pc-advconv__viewtabs { display: flex; gap: 6px; padding: 0 0 8px; flex: 0 0 auto; }
      .pc-advconv__viewtab {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 12px; border-radius: 8px; font-size: 12px; font-weight: 600;
        border: 1px solid var(--border, rgba(125,211,252,0.18));
        background: transparent; color: var(--fg-mute, #7f9bb4); cursor: pointer;
        transition: background-color 120ms, border-color 120ms, color 120ms;
      }
      .pc-advconv__viewtab:hover { color: var(--fg, #e7f7ff); border-color: rgba(125,211,252,0.38); }
      .pc-advconv__viewtab.is-active { background: rgba(56,189,248,0.16); border-color: rgba(56,189,248,0.48); color: var(--fg, #e7f7ff); }

      /* Threads split fills the remaining height */
      .pc-advconv .pc-coord__split { flex: 1 1 auto; min-height: 0; }

      /* Feed */
      .pc-advfeed { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
      .pc-advfeed__clarity {
        display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
        font-size: 12px; color: var(--fg-mute, #9fb6cc);
        padding: 8px 10px; border-radius: 8px;
        background: var(--advconv-accent-soft); border: 1px solid rgba(125,211,252,0.16);
      }
      .pc-advfeed__clarity > span:first-of-type { flex: 1 1 auto; }
      .pc-advfeed__count { font-variant-numeric: tabular-nums; color: var(--fg, #cfe8ff); font-weight: 600; }
      .pc-advfeed__filters { flex: 0 0 auto; display: flex; flex-direction: column; gap: 6px; }
      .pc-advfeed__kindchip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; }
      .pc-advfeed__kinddot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
      .pc-advfeed__kindn {
        font-variant-numeric: tabular-nums; font-size: 10px; opacity: 0.8;
        background: rgba(255,255,255,0.08); border-radius: 6px; padding: 0 4px; margin-left: 2px;
      }
      .pc-advfeed__inputs { display: flex; gap: 6px; flex-wrap: wrap; }
      .pc-advfeed__input {
        background: var(--bg-popover, #0d1829); color: var(--fg, #e7f7ff);
        border: 1px solid var(--border, rgba(125,211,252,0.2));
        border-radius: 7px; padding: 5px 9px; font: inherit; font-size: 12px; min-width: 130px;
      }
      .pc-advfeed__input--wide { flex: 1 1 200px; }
      .pc-advfeed__input:focus { outline: 2px solid rgba(56,189,248,0.34); outline-offset: 1px; }

      .pc-advfeed__stream { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
      .pc-advfeed__daysep {
        position: sticky; top: 0; z-index: 1;
        font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
        color: var(--fg-mute, #6f87a0); padding: 8px 4px 4px;
        background: linear-gradient(var(--bg, #081320), rgba(8,19,32,0.85));
      }
      .pc-advfeed__item { border-radius: 7px; }
      .pc-advfeed__item.is-open { background: rgba(125,211,252,0.05); }
      .pc-advfeed__row {
        width: 100%; display: grid;
        grid-template-columns: auto auto minmax(120px, 1fr) minmax(0, 2fr) auto auto auto;
        align-items: center; gap: 8px; text-align: left;
        padding: 5px 8px; background: transparent;
        font-size: 12px; color: var(--fg, #dceaf6);
        border-radius: 7px;
      }
      .pc-advfeed__row:hover { background: rgba(125,211,252,0.07); }
      .pc-advfeed__time { font-variant-numeric: tabular-nums; font-size: 11px; color: var(--fg-mute, #6f87a0); }
      .pc-advfeed__badge {
        font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 5px;
        border: 1px solid currentColor; background: color-mix(in srgb, currentColor 12%, transparent);
        white-space: nowrap; text-transform: lowercase;
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
      .pc-advfeed__to--broadcast { color: #f472b6; font-weight: 600; display: inline-flex; align-items: center; gap: 3px; }
      .pc-advfeed__to--human { color: #fbbf24; font-weight: 600; display: inline-flex; align-items: center; gap: 3px; }
      .pc-advfeed__summary {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg, #dceaf6);
        border: none; background: none; font: inherit; font-size: 12px; text-align: left;
        cursor: pointer; padding: 0; min-width: 0;
      }
      .pc-advfeed__summary:hover { color: #fff; }
      .pc-advfeed__nosum { color: var(--fg-mute, #5f7488); }
      .pc-advfeed__planchip {
        font-size: 10px; padding: 1px 6px; border-radius: 5px; white-space: nowrap;
        border: 1px solid rgba(94,234,212,0.4); color: #5eead4; background: rgba(94,234,212,0.08);
        cursor: pointer; font: inherit;
      }
      .pc-advfeed__planchip:hover { background: rgba(94,234,212,0.16); }
      .pc-advfeed__replyn { font-size: 10px; color: var(--fg-mute, #8aa3bc); white-space: nowrap; }
      .pc-advfeed__rel { font-size: 10px; color: var(--fg-mute, #6f87a0); white-space: nowrap; font-variant-numeric: tabular-nums; }
      .pc-advfeed__detail { padding: 4px 12px 10px 40px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
      .pc-advfeed__body { white-space: pre-wrap; color: var(--fg, #dceaf6); margin: 0; line-height: 1.5; }
      .pc-advfeed__kv { color: var(--fg-mute, #9fb6cc); margin: 0; }
      .pc-advfeed__kv strong { color: var(--fg, #cfe8ff); }
      .pc-advfeed__thread { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; border-left: 2px solid rgba(125,211,252,0.18); }
      .pc-advfeed__thread li { display: flex; align-items: center; gap: 7px; padding-left: 8px; font-size: 11px; }
      .pc-advfeed__threadfrom { font-weight: 600; color: var(--fg, #cfe8ff); }
      .pc-advfeed__threadsum { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-mute, #aebfd0); }
      .pc-advfeed__loadolder {
        margin: 8px auto; padding: 6px 16px; border-radius: 8px; font-size: 12px; cursor: pointer;
        border: 1px solid var(--border, rgba(125,211,252,0.2)); background: transparent; color: var(--fg-mute, #9fb6cc); font: inherit;
      }
      .pc-advfeed__loadolder:hover { color: var(--fg, #e7f7ff); border-color: rgba(125,211,252,0.4); background: var(--advconv-accent-soft); }
      .pc-advfeed__refresh { flex: 0 0 auto; }
    `}</style>
  );
}
