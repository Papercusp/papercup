/**
 * AdvConversationsTab — the /adv "Conversations" tab. It surfaces EVERY type of
 * communication the workspace produces, across five views (nuqs `?conv=`) split
 * into two clusters in the header: FOUR curated communication stores (Q&A,
 * Deliberations, Agent chats, Messages — each a distinct table you read), then,
 * set apart past a divider, the RAW coordination event log (a debug firehose
 * beneath the curated views, not a 5th peer):
 *
 *  - **Q&A** (default, `conv=threads`): the conversations substrate (questions +
 *    discussions) — the human counterpart to the agents' conversations:* tools.
 *    Reads the in-process admin-coordination dispatch (one data path, no Zero
 *    entity). Detail = seed + topics + thread + accepted answer + linked
 *    work-item + promote/reply/resolve actions.
 *
 *  - **Deliberations** (`conv=deliberations`): the threaded coord:thread /
 *    deliberate / vote discussions (`coord_threads` + `coord_thread_posts`),
 *    attached to an issue or a conversation. Left rail lists threads; detail
 *    renders the discussion posts in order.
 *
 *  - **Agent chats** (`conv=agentchats`): the multi-turn agent chat SESSIONS
 *    (scoper/architect/worker/… transcripts, with tokens + cost) from
 *    `agent_chats_consolidated` — the bulk of real agent communication, which the
 *    per-harness `agent-chats` panel surfaced only one harness at a time. Left rail
 *    lists sessions (harness/role filters); detail renders the full transcript.
 *
 *  - **Messages** (`conv=messages`): work-item-scoped agent↔agent messages
 *    (messages:send / messages:inbox) from `messages_consolidated` — from → to,
 *    kind, subject/body, status, click-to-expand.
 *
 *  - **Raw events** (`conv=feed`): raw coordination events for debugging,
 *    newest-first, with day separators, grouped filters, URL-backed advanced
 *    kind filters, `from → to` routing, a plan chip, and click-to-expand detail.
 *    Data rides the SSE-invalidation rail via `@papercusp/sync` (`dev.coordFeed`,
 *    the same observer read the high-tier `coord:feed` tool exposes); "load
 *    older" paginates by cursor.
 *
 * The Threads/Feed views read the admin-coordination dispatch; the other three
 * (Deliberations / Agent chats / Messages) read the global communication-surface
 * dispatch (`/api/admin/comms/:kind/:verb`, see routes/admin/comms.ts) since those
 * tables had no global view before.
 *
 * All user-meaningful state is in the URL via nuqs (CLAUDE.md); only mid-edit
 * reply drafts + loading/busy lifecycle + the expand-set are useState.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryState, parseAsString, parseAsStringEnum, parseAsArrayOf } from 'nuqs';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, ArrowUpRight, Bot, CheckCircle2, Mail, MessageCircle, MessagesSquare, RefreshCw, Radio, Megaphone, Search, Send, SlidersHorizontal, UserRound } from 'lucide-react';
import { listCountLabel } from '@papercusp/operator-core/lib/sync-resolver/list-meta';
import { Tooltip } from '@/app/harness/Tooltip';
import ChatPanel from '@/app/harness/ChatPanel';
import { hiveHomeLabel } from '@/lib/hive-label';
import '@/app/admin/coordination/coordination.css';

// The comms `list` reads cap at this many rows; the server returns the true
// `total` alongside `items`, so the rails can show "N of TOTAL" honestly.
const COMMS_LIST_LIMIT = 500;

async function coord<T = Record<string, unknown>>(verb: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/api/admin/coordination/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${verb}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

// The global communication-surface reads (agent chats / deliberation threads /
// work-item messages) the coordination dispatch doesn't cover — see routes/admin/comms.ts.
async function comms<T = Record<string, unknown>>(kind: string, verb: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/api/admin/comms/${kind}/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${kind}/${verb}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

// agent-chat timestamps are bigint epoch-ms; coord/message ones are ISO
// strings. Normalise either to a display string.
function fmtTs(v: string | number | null | undefined): string {
  if (v == null) return '';
  const d = new Date(typeof v === 'number' ? v : v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtRel(v: string | number | null | undefined): string {
  if (v == null) return '—';
  const t = typeof v === 'number' ? v : Date.parse(v);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Shimmering placeholder rows shown while a rail / stream loads. */
function LoadingRows({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="pc-advconv__skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="pc-advconv__skeleton-row" aria-hidden />
      ))}
    </div>
  );
}

/** List-fetch failure state — without it a rejected fetch left the skeleton up forever. */
function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="pc-coord__empty pc-advconv__empty pc-advconv__empty--rail pc-advconv__empty--error" role="alert">
      <strong>Couldn&apos;t load</strong>
      <span>{message}</span>
      <button type="button" className="pc-coord__chip" onClick={onRetry}>
        <RefreshCw size={11} aria-hidden /> Retry
      </button>
    </div>
  );
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Stable row-chrome callbacks for the inline RichGrid lists (U1). Hoisted so
// their identity is constant across renders — RichGrid's `memo(BodyRow)` does a
// shallow prop compare, so an inline `getRowBg={() => …}` / `rowProps={() => ({…})}`
// would hand every row a fresh callback/object on each parent render and force
// ALL visible rows to re-render (e.g. on a selection toggle or an SSE invalidation
// that left a given row's data untouched). With stable references only the rows
// whose own data / selection actually changed re-render. The cards are
// fully class-styled, so the grid's own striping/border chrome is neutralized.
const gridTransparentBg = (): string => 'transparent';
const RAIL_ROW_PROPS = { style: { borderBottom: 'none', paddingBottom: 6 } } as const;
const STREAM_ROW_PROPS = { style: { borderBottom: 'none', paddingBottom: 5 } } as const;
const railRowProps = () => RAIL_ROW_PROPS;
const streamRowProps = () => STREAM_ROW_PROPS;

// ─── View switch ─────────────────────────────────────────────────────
const CONV_VIEWS = ['threads', 'deliberations', 'agentchats', 'messages', 'feed'] as const;
type ConvView = (typeof CONV_VIEWS)[number];

interface ViewDef {
  id: ConvView;
  label: string;
  desc: string;
  // 'curated' = a distinct, materialized communication store you read.
  // 'raw' = the low-level coordination event firehose, set apart as a debug tool.
  group: 'curated' | 'raw';
  Icon: typeof MessageCircle;
}

// The five views split into TWO clusters. The first four are distinct, curated
// stores (each its own table) you read directly; the fifth ('feed') is the RAW
// coordination event log — a lower layer that re-surfaces SOME of the same
// traffic (deliberation posts, coord messages, escalations), not a 5th peer.
// The header sets it apart so it reads as a debug firehose, not a conversation type.
const VIEW_DEFS: ReadonlyArray<ViewDef> = [
  { id: 'threads', label: 'Q&A', desc: 'Questions & discussions between you and the agents — reply, accept an answer, or promote to an issue.', group: 'curated', Icon: MessageCircle },
  { id: 'deliberations', label: 'Deliberations', desc: 'Group decisions — coord threads, proposals, and votes.', group: 'curated', Icon: MessagesSquare },
  { id: 'agentchats', label: 'Agent chats', desc: "Each agent's full chat transcript, with token + cost detail.", group: 'curated', Icon: Bot },
  { id: 'messages', label: 'Messages', desc: 'Work-item-scoped mail between agents (messages:send / inbox).', group: 'curated', Icon: Mail },
  { id: 'feed', label: 'Raw events', desc: 'The raw coordination event log — every envelope, newest first. A debug firehose beneath the curated views.', group: 'raw', Icon: Radio },
];
const CURATED_VIEW_DEFS = VIEW_DEFS.filter((v) => v.group === 'curated');
const RAW_VIEW_DEFS = VIEW_DEFS.filter((v) => v.group === 'raw');

export default function AdvConversationsTab() {
  const [view, setView] = useQueryState('conv', parseAsStringEnum<ConvView>([...CONV_VIEWS]).withDefault('threads'));
  const activeDef = VIEW_DEFS.find((v) => v.id === view) ?? VIEW_DEFS[0];
  const renderTab = ({ id, label, Icon, group }: ViewDef) => (
    <button
      key={id}
      type="button"
      role="tab"
      aria-selected={view === id}
      className={`pc-advconv__viewtab${group === 'raw' ? ' pc-advconv__viewtab--raw' : ''}${view === id ? ' is-active' : ''}`}
      onClick={() => void setView(id)}
    >
      <Icon size={13} aria-hidden />
      <span>{label}</span>
    </button>
  );
  return (
    <div className="pc-coord pc-advconv">
      <header className="pc-advconv__header">
        <div className="pc-advconv__header-copy">
          <h1>Conversations</h1>
          <p>{activeDef.desc}</p>
        </div>
        {/* Two clusters: the curated communication views, then a divider, then
            the raw event log set apart as a debug tool. */}
        <div className="pc-advconv__viewtabs" role="tablist" aria-label="Conversations view">
          {CURATED_VIEW_DEFS.map(renderTab)}
          <span className="pc-advconv__viewtab-sep" role="separator" aria-orientation="vertical" />
          {RAW_VIEW_DEFS.map(renderTab)}
        </div>
      </header>
      {view === 'feed' ? (
        <FeedView />
      ) : view === 'deliberations' ? (
        <DeliberationsView />
      ) : view === 'agentchats' ? (
        <AgentChatsView />
      ) : view === 'messages' ? (
        <MessagesView />
      ) : (
        <ThreadsView />
      )}
      <AdvConvStyles />
    </div>
  );
}

// ─── Raw events — the raw coordination event log ─────────────────────

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

const FEED_KIND_GROUPS = [
  { id: 'messages', label: 'Messages', description: 'Direct and broadcast messages', kinds: ['message', 'broadcast'] },
  { id: 'handoffs', label: 'Handoffs', description: 'Work passed between agents', kinds: ['handoff'] },
  { id: 'escalations', label: 'Escalations', description: 'Blocked work and resolutions', kinds: ['escalation', 'escalation_resolved'] },
  { id: 'plan-events', label: 'Plan events', description: 'Plan changes and lifecycle updates', kinds: ['plan_event'] },
] as const;

/** Kind → accent colour. `broadcast` is a synthetic UI kind (any kind with
 *  to:['*']); kept distinct so the firehose's all-hands traffic stands out. */
const KIND_COLOR: Record<string, string> = {
  message: 'var(--accent-strong, #7dd3fc)',
  ack: 'var(--fg-mute, #7f9bb4)',
  notify: 'var(--warn, #fbbf24)',
  broadcast: '#f472b6', // categorical — no semantic token
  handoff: '#a78bfa', // categorical — no semantic token
  handoff_accepted: '#c4b5fd', // categorical — no semantic token
  escalation: 'var(--bad, #f87171)',
  escalation_resolved: 'var(--good, #86efac)',
  plan_event: '#5eead4', // categorical — no semantic token
  subscribe: 'var(--accent, #38bdf8)',
  unsubscribe: 'var(--fg-mute, #64748b)',
  contract: '#fcd34d', // categorical — no semantic token
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

// U1 (operator-vite-ui-consolidation): the day-grouped feed is flattened into a
// single virtual row stream — a `day` separator row followed by its `item` rows —
// so the whole thing rides one @papercusp/grid-core RichGrid (virtualMode) instead
// of nested `.map()`s. RichGrid stays flat (no grouping primitive); the day
// separator is just another row the cell renderer special-cases. Variable-height
// rows (multi-line summaries, click-expanded detail) are handled by `measureAll`.
type FeedEntry =
  | { kind: 'day'; id: string; day: string }
  | { kind: 'item'; id: string; row: FeedRow; replies: FeedRow[] };

function FeedView() {
  // All filters in nuqs.
  const [kinds, setKinds] = useQueryState('fkind', parseAsArrayOf(parseAsString).withDefault([]));
  const [advancedKinds, setAdvancedKinds] = useQueryState('fadvanced', parseAsStringEnum(['closed', 'open']).withDefault('closed'));
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
    const escalationCount = byKind.escalation ?? rawRows.filter((r) => r.kind === 'escalation').length;
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
  const toggleKindGroup = (groupKinds: readonly string[]) => {
    const active = groupKinds.some((k) => kinds.includes(k));
    const next = active
      ? kinds.filter((k) => !groupKinds.includes(k))
      : [...kinds, ...groupKinds.filter((k) => !kinds.includes(k))];
    void setKinds(next);
  };
  const groupCount = (groupKinds: readonly string[]) =>
    rawRows.filter((r) => groupKinds.some((k) => (k === 'broadcast' ? r.broadcast : r.kind === k))).length;
  const rawKindCount = (k: string) =>
    k === 'broadcast' ? rawRows.filter((r) => r.broadcast).length : (meta?.byKind?.[k] ?? rawRows.filter((r) => r.kind === k).length);
  const kindLabel = (k: string) => k.replaceAll('_', ' ');

  const filtersActive = kinds.length > 0 || !!agent || !!plan || !!q.trim();
  const activeFilterCount = kinds.length + (agent ? 1 : 0) + (plan ? 1 : 0) + (q.trim() ? 1 : 0);
  const clearFilters = () => {
    void setKinds([]);
    void setAgent('');
    void setPlan('');
    void setQ('');
  };

  // Flatten the day groups (already day-separated, newest-first) into one virtual
  // row stream: each day contributes a `day` separator row then its root `item`
  // rows. The reply chain rides on the item as `replies` and shows inside the
  // expanded detail. RichGrid virtualizes this flat list.
  const feedEntries = useMemo<FeedEntry[]>(() => {
    const out: FeedEntry[] = [];
    for (const g of grouped) {
      out.push({ kind: 'day', id: `day:${g.day}`, day: g.day });
      for (const r of g.rows) {
        out.push({ kind: 'item', id: `item:${r.msg_id}`, row: r, replies: childrenOf.get(r.msg_id) ?? [] });
      }
    }
    return out;
  }, [grouped, childrenOf]);

  // The stream is the scroll container; RichGrid renders inline inside it.
  const streamRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: feedEntries.length,
    getScrollElement: () => streamRef.current,
    // A collapsed event row is ~one line; day separators are shorter and an
    // expanded row much taller. `measureAll` measures each real height, so the
    // estimate is only the pre-measure guess that keeps the scrollbar sane.
    estimateSize: () => 44,
    overscan: 12,
  });
  useEffect(() => {
    rowVirtualizer.measure();
  }, [feedEntries, rowVirtualizer]);

  // Expanded-row state = the nuqs `?fmsg=` scalar, fed in as RichGrid's selection
  // set (keyed by the entry id). The cell reads `isSelected` as "is open", so a
  // toggle only re-renders the two affected rows; `measureAll` re-measures the
  // newly-grown row. setOpenMsg uses the functional updater so the column set can
  // stay identity-stable (no `openMsg` in its deps) and per-row memo survives.
  const openSet = useMemo(() => new Set(openMsg ? [`item:${openMsg}`] : []), [openMsg]);
  const columns = useMemo<ColumnDef<FeedEntry>[]>(
    () => [
      {
        key: 'event',
        header: '',
        headerText: '',
        width: 1,
        toCopyText: (e) => (e.kind === 'item' ? e.row.summary ?? '' : dayLabel(e.day)),
        cellStyle: { display: 'block', padding: 0, overflow: 'visible' },
        render: ({ row: entry, isSelected }) =>
          entry.kind === 'day' ? (
            <div className="pc-advfeed__daysep">
              <span>{dayLabel(entry.day)}</span>
            </div>
          ) : (
            <FeedItem
              row={entry.row}
              children={entry.replies}
              open={isSelected}
              onToggle={() => void setOpenMsg((p) => (p === entry.row.msg_id ? null : entry.row.msg_id))}
              onPlanClick={(slug) => void setPlan(slug)}
              onAgentClick={(a) => void setAgent(a)}
            />
          ),
      },
    ],
    [setOpenMsg, setPlan, setAgent],
  );

  return (
    <div className="pc-advfeed">
      {/* Filters — all nuqs */}
      <div className="pc-advfeed__filters">
        <div className="pc-advfeed__filterhead">
          <div>
            <span>
              <SlidersHorizontal size={12} aria-hidden />
              Filter activity
            </span>
            <p>Raw coordination events for debugging, newest first.</p>
          </div>
          <div className="pc-advfeed__filtermeta">
            <strong>{meta ? `${meta.total} matching` : head.loading ? 'loading…' : '0 matching'}</strong>
            <span>{roots.length} shown</span>
            <button
              type="button"
              className="pc-coord__chip pc-advfeed__refresh"
              aria-label="Reload activity log"
              disabled={head.fetching}
              onClick={() => head.invalidate()}
            >
              <RefreshCw size={11} aria-hidden />
            </button>
          </div>
        </div>
        <div className="pc-advfeed__needsline" aria-label="Activity summary">
          <span><UserRound size={11} aria-hidden /> {signalStats.humanCount} to human</span>
          <span><AlertTriangle size={11} aria-hidden /> {signalStats.escalationCount} escalation</span>
          <span><Megaphone size={11} aria-hidden /> {signalStats.broadcastCount} broadcast</span>
          <strong>{filtersActive ? `${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'} active` : 'No filters'}</strong>
        </div>
        <div className="pc-coord__filters pc-advfeed__kindgroups" role="group" aria-label="Activity category filter">
          {FEED_KIND_GROUPS.map((g) => {
            const active = g.kinds.some((k) => kinds.includes(k));
            const n = groupCount(g.kinds);
            return (
              <Tooltip key={g.id} label={g.description}>
                <button
                  type="button"
                  className={`pc-coord__chip pc-advfeed__groupchip${active ? ' is-active' : ''}`}
                  onClick={() => toggleKindGroup(g.kinds)}
                  aria-pressed={active}
                >
                  {g.label}
                  {n > 0 ? <span className="pc-advfeed__kindn">{n}</span> : null}
                </button>
              </Tooltip>
            );
          })}
          <button
            type="button"
            className={`pc-coord__chip pc-advfeed__advancedtoggle${advancedKinds === 'open' ? ' is-active' : ''}`}
            onClick={() => void setAdvancedKinds(advancedKinds === 'open' ? 'closed' : 'open')}
            aria-expanded={advancedKinds === 'open'}
          >
            Advanced / all kinds
          </button>
        </div>
        {advancedKinds === 'open' && (
          <div className="pc-coord__filters pc-advfeed__rawkinds" role="group" aria-label="Raw kind filter">
            {FEED_KINDS.map((k) => {
              // byKind is keyed by real CoordKind; 'broadcast' is synthetic and
              // cross-cuts every kind, so count it from loaded rows.
              const n = rawKindCount(k);
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
                  {kindLabel(k)}
                  {typeof n === 'number' && n > 0 ? <span className="pc-advfeed__kindn">{n}</span> : null}
                </button>
              );
            })}
          </div>
        )}
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
          <label className="pc-advfeed__field pc-advfeed__field--search">
            <span>
              <Search size={10} aria-hidden />
              Search
            </span>
            <input
              type="search"
              className="pc-advfeed__input pc-advfeed__input--search"
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
      <div className="pc-advfeed__stream" ref={streamRef}>
        {head.loading && allRows.length === 0 ? (
          <LoadingRows rows={6} label="Loading the coordination feed" />
        ) : head.error ? (
          <p className="pc-coord__empty pc-advconv__empty">Raw events log unavailable: {head.error.message}</p>
        ) : roots.length === 0 ? (
          <div className="pc-coord__empty pc-advconv__empty pc-advconv__empty--card">
            <strong>No matching traffic</strong>
            <span>Clear a filter or broaden the search to return activity.</span>
          </div>
        ) : (
          <RichGrid<FeedEntry>
            inline
            disableCopySupport
            headerStyle={{ display: 'none' }}
            columns={columns}
            getRowId={(e) => e.id}
            virtualMode={{
              virtualizer: rowVirtualizer,
              totalRows: feedEntries.length,
              rowAt: (i) => feedEntries[i],
              measureAll: true,
            }}
            selectedRowIds={openSet}
            getRowBg={gridTransparentBg}
            rowProps={streamRowProps}
          />
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
            aria-label={`Filter to ${row.from}`}
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
          aria-label={hasDetail ? 'Expand row' : undefined}
        >
          {summary || <em className="pc-advfeed__nosum">(no summary)</em>}
        </button>
        {row.plan_slug && (
          <button
            type="button"
            className="pc-advfeed__planchip"
            onClick={() => onPlanClick(row.plan_slug!)}
            aria-label={`Filter to ${row.plan_slug}`}
          >
            {row.plan_slug}
          </button>
        )}
        {children.length > 0 && <span className="pc-advfeed__replyn">{children.length} {children.length === 1 ? 'reply' : 'replies'}</span>}
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    const body: Record<string, unknown> = {};
    if (state !== 'all') body.state = state;
    if (kind !== 'all') body.kind = kind;
    try {
      const r = await coord<{ conversations?: ConvRow[]; items?: ConvRow[] }>('conversations/list', body);
      setList(r.conversations ?? r.items ?? []);
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [state, kind]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await coord<ConvGetResponse>('conversations/get', { conversation_id: id });
      setDetail(
        r.conversation
          ? { ...r.conversation, topics: r.topics ?? [], posts: r.posts ?? [], subscriber_count: r.subscriber_count ?? 0 }
          : null,
      );
    } catch {
      setDetail(null);
    }
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
  const act = async (verb: string, body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      await coord(verb, body);
      await reload();
      if (sel) await loadDetail(sel);
      return true;
    } catch (e) {
      toast.error(`Action failed: ${errText(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const canPromote = !!detail && detail.state !== 'closed' && !detail.promoted_issue_id;

  // U1 (operator-vite-ui-consolidation): the threads rail renders through the
  // shared, virtualized @papercusp/grid-core RichGrid — the same inline-virtualMode
  // template the agent-chats rail uses. `measureAll` is on because a thread row's
  // height varies (the optional topic-tag line wraps), so the virtualizer measures
  // real heights instead of trusting one estimate.
  const railScrollRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: visible.length,
    getScrollElement: () => railScrollRef.current,
    estimateSize: () => 76,
    overscan: 10,
  });
  useEffect(() => {
    rowVirtualizer.measure();
  }, [visible, rowVirtualizer]);
  const selectedSet = useMemo(() => new Set(sel ? [sel] : []), [sel]);
  const columns = useMemo<ColumnDef<ConvRow>[]>(
    () => [
      {
        key: 'thread',
        header: '',
        headerText: '',
        width: 1,
        toCopyText: (c) => c.title ?? c.id,
        cellStyle: { display: 'block', padding: 0, overflow: 'visible' },
        render: ({ row: c, isSelected }) => (
          <div className={`pc-coord__row${isSelected ? ' is-active' : ''}`}>
            <span className="pc-advconv__threadtop">
              <span className={`pc-coord__kind pc-coord__kind--${c.kind}`}>{c.kind}</span>
              <span className={`pc-advconv__statepill pc-advconv__statepill--${c.state}`}>{c.state}</span>
              <span className="pc-advconv__rowdate">{dateStamp(c.created_ts)}</span>
            </span>
            <span className="pc-coord__row-title">{c.title ?? c.id}</span>
            <span className="pc-coord__row-meta">
              {c.harness_slug ? hiveHomeLabel(c.harness_slug) : 'workspace'}
              {c.promoted_issue_id ? ` · → ${c.promoted_issue_id}` : ''}
            </span>
            {(c.topics ?? []).length > 0 && (
              <span className="pc-advconv__rowtags">
                {(c.topics ?? []).map((t) => (
                  <span key={t} className="pc-coord__tag">#{t}</span>
                ))}
              </span>
            )}
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <div className="pc-coord__split pc-advconv__threads">
      <aside className="pc-coord__rail" ref={railScrollRef}>
        <div className="pc-advconv__railhead">
          <span>Question &amp; discussion threads</span>
          <strong>{loading ? '…' : visible.length}</strong>
        </div>
        <div className="pc-coord__filters" role="group" aria-label="State filter">
          {CONV_STATES.map((s) => (
            <button key={s} type="button" aria-pressed={state === s} className={`pc-coord__chip${state === s ? ' is-active' : ''}`} onClick={() => void setState(s)}>
              {s}
            </button>
          ))}
        </div>
        <div className="pc-coord__filters" role="group" aria-label="Kind filter">
          {CONV_KINDS.map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} className={`pc-coord__chip${kind === k ? ' is-active' : ''}`} onClick={() => void setKind(k)}>
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
          <div className="pc-coord__filters" role="group" aria-label="Topic filter">
            <button type="button" aria-pressed={!topic} className={`pc-coord__chip${!topic ? ' is-active' : ''}`} onClick={() => void setTopic('')}>
              all topics
            </button>
            {allTopics.map((t) => (
              <button key={t} type="button" aria-pressed={topic === t} className={`pc-coord__chip${topic === t ? ' is-active' : ''}`} onClick={() => void setTopic(topic === t ? '' : t)}>
                #{t}
              </button>
            ))}
          </div>
        )}
        {loading ? (
          <LoadingRows />
        ) : error ? (
          <LoadError message={error} onRetry={() => void reload()} />
        ) : visible.length === 0 ? (
          <div className="pc-coord__empty pc-advconv__empty pc-advconv__empty--rail">
            <strong>No threads match</strong>
            <span>Change the state, kind, or topic filter to widen the thread rail.</span>
          </div>
        ) : (
          <RichGrid<ConvRow>
            inline
            disableCopySupport
            headerStyle={{ display: 'none' }}
            columns={columns}
            getRowId={(c) => c.id}
            virtualMode={{
              virtualizer: rowVirtualizer,
              totalRows: visible.length,
              rowAt: (i) => visible[i],
              measureAll: true,
            }}
            selectedRowIds={selectedSet}
            onRowClick={(c) => void setSel(c.id)}
            getRowBg={gridTransparentBg}
            rowProps={railRowProps}
          />
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
                <span>{detail.scope === 'harness' && detail.harness_slug ? hiveHomeLabel(detail.harness_slug) : 'workspace'}</span>
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
                  <button type="button" className="pc-advconv__replybtn" disabled={busy || !reply.trim()} onClick={() => { void act('conversations/post', { conversation_id: detail.id, body: reply.trim() }).then((ok) => { if (ok) setReply(''); }); }}>
                    <Send size={12} aria-hidden /> Reply
                  </button>
                  {detail.kind === 'question' && (
                    <button type="button" className="pc-advconv__replybtn pc-advconv__replybtn--resolve" disabled={busy || !reply.trim()} aria-label="Record this reply as the accepted answer and resolve the question" onClick={() => { void act('conversations/resolve', { conversation_id: detail.id, accepted_answer: reply.trim() }).then((ok) => { if (ok) setReply(''); }); }}>
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

// ─── Deliberations — coord:thread / deliberate / vote posts on an entity ────

interface ThreadRow {
  thread_id: string;
  parent_kind: string | null;
  parent_ref: string | null;
  title: string | null;
  created_by: string | null;
  harness_slug: string | null;
  created_at: string;
  last_post_at: string | null;
  post_count: number;
}
interface ThreadPost { id: number; author_id: string | null; body: string | null; created_at: string; harness_slug: string | null }

function DeliberationsView() {
  const [sel, setSel] = useQueryState('thread', parseAsString);
  const [list, setList] = useState<ThreadRow[]>([]);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [posts, setPosts] = useState<ThreadPost[]>([]);
  const [head, setHead] = useState<ThreadRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await comms<{ items?: ThreadRow[]; total?: number }>('threads', 'list', { limit: COMMS_LIST_LIMIT });
      setList(r.items ?? []);
      setTotal(r.total);
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!sel) {
      setPosts([]);
      setHead(null);
      return;
    }
    void (async () => {
      try {
        const r = await comms<{ thread?: ThreadRow | null; posts?: ThreadPost[] }>('threads', 'get', { thread_id: sel });
        setHead(r.thread ?? null);
        setPosts(r.posts ?? []);
      } catch {
        setHead(null);
        setPosts([]);
      }
    })();
  }, [sel]);

  // U1 (operator-vite-ui-consolidation): the deliberations rail renders through
  // the shared, virtualized @papercusp/grid-core RichGrid (the agent-chats
  // inline-virtualMode template). `measureAll` keeps offsets exact as titles wrap.
  const railScrollRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: list.length,
    getScrollElement: () => railScrollRef.current,
    estimateSize: () => 70,
    overscan: 10,
  });
  useEffect(() => {
    rowVirtualizer.measure();
  }, [list, rowVirtualizer]);
  const selectedSet = useMemo(() => new Set(sel ? [sel] : []), [sel]);
  const columns = useMemo<ColumnDef<ThreadRow>[]>(
    () => [
      {
        key: 'thread',
        header: '',
        headerText: '',
        width: 1,
        toCopyText: (t) => t.title ?? t.thread_id,
        cellStyle: { display: 'block', padding: 0, overflow: 'visible' },
        render: ({ row: t, isSelected }) => (
          <div className={`pc-coord__row${isSelected ? ' is-active' : ''}`}>
            <span className="pc-advconv__threadtop">
              <span className="pc-coord__kind">{t.parent_kind ?? 'thread'}</span>
              {t.parent_ref ? <span className="pc-advconv__statepill">{t.parent_ref}</span> : null}
              <span className="pc-advconv__rowdate">{fmtTs(t.last_post_at ?? t.created_at)}</span>
            </span>
            <span className="pc-coord__row-title">{t.title ?? t.thread_id}</span>
            <span className="pc-coord__row-meta">
              {t.harness_slug ? hiveHomeLabel(t.harness_slug) : 'workspace'} · {t.post_count} post{t.post_count === 1 ? '' : 's'}
              {t.created_by ? ` · ${t.created_by}` : ''}
            </span>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <div className="pc-coord__split pc-advconv__threads">
      <aside className="pc-coord__rail" ref={railScrollRef}>
        <div className="pc-advconv__railhead">
          <span>Deliberation threads</span>
          <strong>{loading ? '…' : listCountLabel(list.length, total)}</strong>
          <button type="button" className="pc-coord__chip pc-advconv__refresh" aria-label="Reload deliberations" disabled={loading} onClick={() => void reload()}>
            <RefreshCw size={11} aria-hidden />
          </button>
        </div>
        {loading ? (
          <LoadingRows />
        ) : error ? (
          <LoadError message={error} onRetry={() => void reload()} />
        ) : list.length === 0 ? (
          <div className="pc-coord__empty pc-advconv__empty pc-advconv__empty--rail">
            <strong>No deliberations</strong>
            <span>No coord:thread / deliberate / vote discussions recorded.</span>
          </div>
        ) : (
          <RichGrid<ThreadRow>
            inline
            disableCopySupport
            headerStyle={{ display: 'none' }}
            columns={columns}
            getRowId={(t) => t.thread_id}
            virtualMode={{
              virtualizer: rowVirtualizer,
              totalRows: list.length,
              rowAt: (i) => list[i],
              measureAll: true,
            }}
            selectedRowIds={selectedSet}
            onRowClick={(t) => void setSel(t.thread_id)}
            getRowBg={gridTransparentBg}
            rowProps={railRowProps}
          />
        )}
      </aside>
      <section className="pc-coord__detail">
        {!head ? (
          <div className="pc-coord__empty pc-advconv__empty pc-advconv__empty--detail">
            <MessagesSquare size={22} aria-hidden />
            <strong>Select a deliberation</strong>
            <span>Open a thread to read its discussion posts.</span>
          </div>
        ) : (
          <article className="pc-coord__card">
            <header className="pc-advconv__detailhead">
              <div>
                <p className="pc-advconv__detailkicker">
                  <span className="pc-coord__kind">{head.parent_kind ?? 'thread'}</span>
                  {head.parent_ref ? <span className="pc-advconv__statepill">{head.parent_ref}</span> : null}
                </p>
                <h2>{head.title ?? head.thread_id}</h2>
              </div>
              <div className="pc-advconv__detailstats" aria-label="Thread metadata">
                <span>{head.harness_slug ? hiveHomeLabel(head.harness_slug) : 'workspace'}</span>
                <span><strong>{posts.length}</strong> posts</span>
              </div>
            </header>
            <ol className="pc-coord__thread pc-advconv__transcript">
              {posts.map((p) => (
                <li key={p.id} className="pc-advconv__turn">
                  <span className="pc-advconv__postmeta">
                    <strong>{p.author_id ?? 'unknown'}</strong>
                    <span>{fmtTs(p.created_at)}</span>
                  </span>
                  <p>{p.body ?? ''}</p>
                </li>
              ))}
              {posts.length === 0 && (
                <li className="pc-coord__empty pc-advconv__empty pc-advconv__empty--thread">
                  <strong>No posts</strong>
                  <span>This thread has no recorded posts.</span>
                </li>
              )}
            </ol>
          </article>
        )}
      </section>
    </div>
  );
}

// ─── Agent chats — the per-feature/per-role multi-turn transcripts ──────

interface AgentChatRow {
  id: string;
  harness_slug: string | null;
  role: string | null;
  feature_id: string | null;
  title: string | null;
  created_at: number;
  archived_at: number | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd_cents: number;
  turns: number;
}
interface AgentChatTurn { ts?: string; role?: string; content?: unknown }
interface AgentChatDetail extends AgentChatRow { transcript?: AgentChatTurn[] }

function turnText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : JSON.stringify(p)))
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function AgentChatsView() {
  const [harness, setHarness] = useQueryState('acharness', parseAsString.withDefault(''));
  const [role, setRole] = useQueryState('acrole', parseAsString.withDefault(''));
  const [sel, setSel] = useQueryState('chat', parseAsString);
  const [list, setList] = useState<AgentChatRow[]>([]);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [detail, setDetail] = useState<AgentChatDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await comms<{ items?: AgentChatRow[]; total?: number }>('agent-chats', 'list', {
        limit: COMMS_LIST_LIMIT,
        ...(harness ? { harness } : {}),
        ...(role ? { role } : {}),
      });
      setList(r.items ?? []);
      setTotal(r.total);
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [harness, role]);
  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!sel) {
      setDetail(null);
      return;
    }
    void (async () => {
      try {
        const r = await comms<{ chat?: AgentChatDetail }>('agent-chats', 'get', { id: sel });
        setDetail(r.chat ?? null);
      } catch {
        setDetail(null);
      }
    })();
  }, [sel]);

  const harnesses = useMemo(() => [...new Set(list.map((c) => c.harness_slug).filter(Boolean))].sort() as string[], [list]);
  const roles = useMemo(() => [...new Set(list.map((c) => c.role).filter(Boolean))].sort() as string[], [list]);

  // U1 (operator-vite-ui-consolidation): the agent-chats rail renders through
  // the shared, virtualized @papercusp/grid-core RichGrid instead of a raw
  // `.map()`. RichGrid runs in `inline` mode so the existing `.pc-coord__rail`
  // stays the scroll container; one full-width column whose `render` emits the
  // original `.pc-coord__row` card keeps the visual result identical.
  // `virtualMode` mounts only the visible window (the list pulls up to 500
  // sessions). This is the template for the other rails — see the report for
  // the grouped/expandable gap the live coord feed will hit next.
  const railScrollRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: list.length,
    getScrollElement: () => railScrollRef.current,
    // Three stacked lines (top meta / title / meta) inside a 7px-padded card.
    // Rows are uniform height, so a matching estimate keeps virtual offsets
    // exact; RichGrid only re-measures expanded rows, which this list has none.
    estimateSize: () => 64,
    overscan: 10,
  });
  useEffect(() => {
    rowVirtualizer.measure();
  }, [list, rowVirtualizer]);

  // RichGrid's selection set, derived from the nuqs `?chat=` scalar — drives
  // the cell's `isSelected` → `.pc-coord__row.is-active` styling.
  const selectedSet = useMemo(() => new Set(sel ? [sel] : []), [sel]);

  // One full-width column. RichGrid's cell wrapper is `display:flex` and adds
  // its own padding; we strip that via `cellStyle` and render the original
  // `.pc-coord__row` card (with its stacked-span layout from coordination.css)
  // as the cell body, so the visual result is byte-for-byte the prior markup.
  const columns = useMemo<ColumnDef<AgentChatRow>[]>(
    () => [
      {
        key: 'session',
        header: '',
        headerText: '',
        width: 1,
        toCopyText: (c) => c.title ?? c.id,
        cellStyle: { display: 'block', padding: 0, overflow: 'visible' },
        render: ({ row: c, isSelected }) => (
          <div className={`pc-coord__row${isSelected ? ' is-active' : ''}`}>
            <span className="pc-advconv__threadtop">
              <span className="pc-coord__kind">{c.role ?? 'agent'}</span>
              {c.archived_at ? <span className="pc-advconv__statepill pc-advconv__statepill--closed">archived</span> : null}
              <span className="pc-advconv__rowdate">{fmtTs(c.created_at)}</span>
            </span>
            <span className="pc-coord__row-title">{c.title ?? c.id}</span>
            <span className="pc-coord__row-meta">
              {c.harness_slug ? hiveHomeLabel(c.harness_slug) : 'workspace'}{c.feature_id ? ` · ${c.feature_id}` : ''} · {c.turns} turn{c.turns === 1 ? '' : 's'}
            </span>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <div className="pc-coord__split pc-advconv__threads">
      <aside className="pc-coord__rail" ref={railScrollRef}>
        <div className="pc-advconv__railhead">
          <span>Agent chat sessions</span>
          <strong>{loading ? '…' : listCountLabel(list.length, total)}</strong>
        </div>
        {harnesses.length > 0 && (
          <div className="pc-coord__filters" role="group" aria-label="Harness filter">
            <button type="button" aria-pressed={!harness} className={`pc-coord__chip${!harness ? ' is-active' : ''}`} onClick={() => void setHarness('')}>all</button>
            {harnesses.map((h) => (
              <button key={h} type="button" aria-pressed={harness === h} className={`pc-coord__chip${harness === h ? ' is-active' : ''}`} onClick={() => void setHarness(harness === h ? '' : h)}>{h}</button>
            ))}
            <button type="button" className="pc-coord__chip pc-advconv__refresh" aria-label="Reload agent chats" disabled={loading} onClick={() => void reload()}>
              <RefreshCw size={11} aria-hidden />
            </button>
          </div>
        )}
        {roles.length > 0 && (
          <div className="pc-coord__filters" role="tablist" aria-label="Role filter">
            <button type="button" className={`pc-coord__chip${!role ? ' is-active' : ''}`} onClick={() => void setRole('')}>all roles</button>
            {roles.map((r) => (
              <button key={r} type="button" className={`pc-coord__chip${role === r ? ' is-active' : ''}`} onClick={() => void setRole(role === r ? '' : r)}>{r}</button>
            ))}
          </div>
        )}
        {loading ? (
          <LoadingRows />
        ) : error ? (
          <LoadError message={error} onRetry={() => void reload()} />
        ) : list.length === 0 ? (
          <div className="pc-coord__empty pc-advconv__empty pc-advconv__empty--rail">
            <strong>No agent chats</strong>
            <span>No multi-turn agent chat sessions match the current filter.</span>
          </div>
        ) : (
          <RichGrid<AgentChatRow>
            inline
            disableCopySupport
            // The rail was a flat list of cards with no header. RichGrid always
            // renders its sticky header row, so hide it to keep the prior look.
            // (grid-core gap: no `hideHeader` prop — noted in the U1 report.)
            headerStyle={{ display: 'none' }}
            columns={columns}
            getRowId={(c) => c.id}
            virtualMode={{
              virtualizer: rowVirtualizer,
              totalRows: list.length,
              rowAt: (i) => list[i],
            }}
            // Selection is the nuqs `?chat=` param — feed it in so the cell's
            // `isSelected` drives the original `.pc-coord__row.is-active` style.
            selectedRowIds={selectedSet}
            onRowClick={(c) => void setSel(c.id)}
            // The card look is fully class-driven (.pc-advconv__threads
            // .pc-coord__row). Neutralize RichGrid's own per-row chrome
            // (striping bg + bottom border) so only the original styling shows;
            // the 6px inter-card gap the flex rail used becomes per-row bottom
            // padding since virtual rows are positioned edge-to-edge. Stable
            // hoisted refs so memo(BodyRow) skips untouched rows (see top of file).
            getRowBg={gridTransparentBg}
            rowProps={railRowProps}
          />
        )}
      </aside>
      <section className="pc-coord__detail">
        {!detail ? (
          <div className="pc-coord__empty pc-advconv__empty pc-advconv__empty--detail">
            <Bot size={22} aria-hidden />
            <strong>Select a chat</strong>
            <span>Open an agent chat session to read its full transcript.</span>
          </div>
        ) : (
          <article className="pc-coord__card">
            <header className="pc-advconv__detailhead">
              <div>
                <p className="pc-advconv__detailkicker">
                  <span className="pc-coord__kind">{detail.role ?? 'agent'}</span>
                  {detail.feature_id ? <span className="pc-advconv__statepill">{detail.feature_id}</span> : null}
                </p>
                <h2>{detail.title ?? detail.id}</h2>
              </div>
              <div className="pc-advconv__detailstats" aria-label="Chat metadata">
                <span>{detail.harness_slug ? hiveHomeLabel(detail.harness_slug) : 'workspace'}</span>
                <span><strong>{(detail.transcript ?? []).length}</strong> turns</span>
                <span>${((detail.total_cost_usd_cents ?? 0) / 100).toFixed(2)} · {(detail.total_input_tokens ?? 0) + (detail.total_output_tokens ?? 0)} tok</span>
              </div>
            </header>
            {detail.archived_at == null && detail.harness_slug ? (
              // WI-125: a LIVE chat is interactive here — the real <ChatPanel>
              // (transcript + streaming composer + archive), the same audited
              // send path the dock chat slots use. Archived chats keep the
              // read-only transcript below.
              <div className="pc-advconv__livechat" data-testid="advconv-live-chat">
                <ChatPanel
                  slug={detail.harness_slug}
                  chatId={detail.id}
                  onArchive={() => {
                    void setSel(null);
                    void reload();
                  }}
                />
              </div>
            ) : (
              <ol className="pc-coord__thread pc-advconv__transcript">
                {(detail.transcript ?? []).map((t, i) => (
                  <li key={i} className={`pc-advconv__turn pc-advconv__turn--${t.role ?? 'unknown'}`}>
                    <span className="pc-advconv__postmeta">
                      <strong>{t.role ?? 'unknown'}</strong>
                      {t.ts ? <span>{fmtTs(t.ts)}</span> : null}
                    </span>
                    <p>{turnText(t.content)}</p>
                  </li>
                ))}
                {(detail.transcript ?? []).length === 0 && (
                  <li className="pc-coord__empty pc-advconv__empty pc-advconv__empty--thread">
                    <strong>Empty transcript</strong>
                    <span>This chat session has no recorded turns.</span>
                  </li>
                )}
              </ol>
            )}
          </article>
        )}
      </section>
    </div>
  );
}

// ─── Messages — work-item-scoped agent↔agent messages ──────────────────

interface MsgRow {
  id: string;
  harness_slug: string | null;
  from_slug: string;
  to_slug: string | null;
  to_role: string | null;
  kind: string;
  subject: string | null;
  body: string | null;
  status: string;
  created_at: string;
  from_feature_id: string | null;
  to_feature_id: string | null;
}

function MessagesView() {
  const [list, setList] = useState<MsgRow[]>([]);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useQueryState('msg', parseAsString);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await comms<{ items?: MsgRow[]; total?: number }>('messages', 'list', { limit: COMMS_LIST_LIMIT });
      setList(r.items ?? []);
      setTotal(r.total);
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  // U1 (operator-vite-ui-consolidation): the messages stream (up to 500 rows)
  // renders through the shared, virtualized @papercusp/grid-core RichGrid instead
  // of a raw `.map()`. The stream itself is the scroll container; `measureAll`
  // keeps virtual offsets exact as a row grows when click-expanded. Open state is
  // the nuqs `?msg=` scalar, fed in as the selection set so only the toggled rows
  // re-render (and the cell's `isSelected` drives the `.is-open` styling).
  const streamRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: list.length,
    getScrollElement: () => streamRef.current,
    estimateSize: () => 40,
    overscan: 12,
  });
  useEffect(() => {
    rowVirtualizer.measure();
  }, [list, rowVirtualizer]);
  const openSet = useMemo(() => new Set(open ? [open] : []), [open]);
  const columns = useMemo<ColumnDef<MsgRow>[]>(
    () => [
      {
        key: 'message',
        header: '',
        headerText: '',
        width: 1,
        toCopyText: (m) => m.subject ?? m.body ?? '',
        cellStyle: { display: 'block', padding: 0, overflow: 'visible' },
        render: ({ row: m, isSelected: isOpen }) => {
          const hasDetail = !!m.body || !!m.from_feature_id || !!m.to_feature_id || !!m.harness_slug;
          return (
            <div className={`pc-advfeed__item${isOpen ? ' is-open' : ''}`}>
              <div className="pc-advfeed__row">
                <span className="pc-advfeed__time" title={m.created_at}>{fmtTs(m.created_at)}</span>
                <span className="pc-advfeed__badge">{m.kind}</span>
                <span className="pc-advfeed__route">
                  <span className="pc-advfeed__from">{m.from_slug}</span>
                  <span className="pc-advfeed__to">→ {m.to_slug ?? m.to_role ?? '∅'}</span>
                </span>
                <button
                  type="button"
                  className="pc-advfeed__summary"
                  onClick={() => void setOpen((p) => (p === m.id ? null : m.id))}
                  aria-expanded={isOpen}
                  aria-label={hasDetail ? 'Expand row' : undefined}
                >
                  {m.subject || m.body || <em className="pc-advfeed__nosum">(no subject)</em>}
                </button>
                {m.status && <span className="pc-advconv__statepill">{m.status}</span>}
                <span className="pc-advfeed__rel">{fmtRel(m.created_at)}</span>
              </div>
              {isOpen && hasDetail && (
                <div className="pc-advfeed__detail">
                  {m.body && (
                    <div className="pc-advfeed__bodycard">
                      <strong>Body</strong>
                      <p className="pc-advfeed__body">{m.body}</p>
                    </div>
                  )}
                  {(m.from_feature_id || m.to_feature_id) && (
                    <div className="pc-advfeed__kv">
                      <strong>work-item</strong>
                      <span>{m.from_feature_id ?? '—'} → {m.to_feature_id ?? '—'}</span>
                    </div>
                  )}
                  {m.harness_slug && (
                    <div className="pc-advfeed__kv">
                      <strong>harness</strong>
                      <span>{hiveHomeLabel(m.harness_slug)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        },
      },
    ],
    [setOpen],
  );

  return (
    <div className="pc-advfeed">
      <div className="pc-advfeed__filters">
        <div className="pc-advfeed__filterhead">
          <div>
            <span><Mail size={12} aria-hidden /> Agent messages</span>
            <p>Work-item-scoped messages between agents (messages:send / inbox).</p>
          </div>
          <div className="pc-advfeed__filtermeta">
            <strong>{loading ? 'loading…' : `${listCountLabel(list.length, total)} messages`}</strong>
            <button type="button" className="pc-coord__chip pc-advfeed__refresh" aria-label="Reload messages" disabled={loading} onClick={() => void reload()}>
              <RefreshCw size={11} aria-hidden />
            </button>
          </div>
        </div>
      </div>
      <div className="pc-advfeed__stream" ref={streamRef}>
        {loading && list.length === 0 ? (
          <LoadingRows rows={6} label="Loading messages" />
        ) : error && list.length === 0 ? (
          <LoadError message={error} onRetry={() => void reload()} />
        ) : list.length === 0 ? (
          <div className="pc-coord__empty pc-advconv__empty pc-advconv__empty--card">
            <strong>No messages</strong>
            <span>No agent-to-agent messages recorded.</span>
          </div>
        ) : (
          <RichGrid<MsgRow>
            inline
            disableCopySupport
            headerStyle={{ display: 'none' }}
            columns={columns}
            getRowId={(m) => m.id}
            virtualMode={{
              virtualizer: rowVirtualizer,
              totalRows: list.length,
              rowAt: (i) => list[i],
              measureAll: true,
            }}
            selectedRowIds={openSet}
            getRowBg={gridTransparentBg}
            rowProps={streamRowProps}
          />
        )}
      </div>
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
        gap: 8px;
        padding: 1px;
        color: var(--fg, #dceaf6);
        background: var(--advconv-bg);
      }
      .pc-advconv__header {
        position: relative;
        display: grid;
        grid-template-columns: minmax(180px, 1fr) auto;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        flex: 0 0 auto;
        padding: 8px 10px;
        border: 1px solid var(--advconv-border);
        border-radius: 12px;
        overflow: hidden;
        background: var(--advconv-panel-strong);
        box-shadow: none;
      }
      .pc-advconv__header-copy { position: relative; z-index: 1; min-width: 0; }
      .pc-advconv__header h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1;
        letter-spacing: 0;
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__header p {
        margin: 3px 0 0;
        color: var(--fg-mute, #9fb6cc);
        font-size: 12px;
        line-height: 1.35;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .pc-advconv {
        --advconv-button-accent: var(--advconv-accent);
      }
      .pc-advconv .pc-coord__chip {
        border-color: color-mix(in oklab, var(--advconv-button-accent), transparent 68%);
        background: color-mix(in oklab, var(--advconv-button-accent), transparent 93%);
        color: var(--fg-dim, #b9d4e8);
        border-radius: 8px;
        box-shadow: none;
        transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      .pc-advconv .pc-coord__chip:hover:not(:disabled) {
        border-color: color-mix(in oklab, var(--advconv-button-accent), transparent 32%);
        background: color-mix(in oklab, var(--advconv-button-accent), transparent 82%);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv .pc-coord__chip.is-active {
        border-color: color-mix(in oklab, var(--advconv-button-accent), transparent 18%);
        background: color-mix(in oklab, var(--advconv-button-accent), transparent 66%);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__rowtags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 1px; }
      .pc-advconv__refresh { margin-left: auto; display: inline-flex; align-items: center; }
      .pc-advconv__callout {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 8px;
        align-items: flex-start;
        margin: 6px 0;
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 82%);
        background: color-mix(in srgb, var(--bg-deeper, #040b14), transparent 15%);
        color: var(--fg-mute, #9fb6cc);
      }
      .pc-advconv__callout > svg { margin-top: 2px; }
      .pc-advconv__callout strong {
        display: block;
        margin-bottom: 4px;
        color: var(--fg, #e7f7ff);
        font-size: 12px;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advconv__callout p {
        margin: 0;
        line-height: 1.5;
      }
      .pc-advconv__callout--accepted {
        border-color: color-mix(in oklab, var(--good, #22c55e), transparent 68%);
        background: color-mix(in oklab, var(--good, #22c55e), transparent 92%);
      }
      .pc-advconv__callout--accepted > svg { color: var(--good, #22c55e); }
      .pc-advconv__callout--linked {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 70%);
        background: color-mix(in oklab, var(--advconv-accent), transparent 93%);
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
        min-height: 120px;
        padding: 14px;
        border-radius: 12px;
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
        min-height: 88px;
        padding: 12px;
        border-radius: 10px;
      }
      .pc-advconv__empty--thread {
        min-height: 72px;
        margin-top: 4px;
      }
      .pc-advconv__empty strong { color: var(--fg, #e7f7ff); font-size: 14px; }
      .pc-advconv__empty span { max-width: 420px; line-height: 1.45; }
      .pc-advconv__empty--error {
        border-color: color-mix(in oklab, var(--bad, #f87171), transparent 60%);
        background: color-mix(in oklab, var(--bad, #f87171), transparent 94%);
      }
      .pc-advconv__empty--error strong { color: var(--bad, #f87171); }
      .pc-advconv__skeleton {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 3px 1px;
      }
      .pc-advconv__skeleton-row {
        height: 42px;
        flex: 0 0 auto;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.15)), transparent 60%);
        background: linear-gradient(
          100deg,
          color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 45%) 40%,
          color-mix(in srgb, var(--bg-3, rgba(255, 255, 255, 0.075)), transparent 30%) 50%,
          color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 45%) 60%
        );
        background-size: 200% 100%;
        animation: pc-advconv-shimmer 1.4s ease-in-out infinite;
      }
      @keyframes pc-advconv-shimmer {
        from { background-position: 200% 0; }
        to { background-position: -200% 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .pc-advconv__skeleton-row { animation: none; }
      }
      .pc-advconv__reply {
        margin-top: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 9px;
        border-radius: 10px;
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
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advconv__replyhead em {
        max-width: 410px;
        text-align: right;
        font-style: normal;
        line-height: 1.35;
      }
      .pc-advconv__reply textarea {
        width: 100%; resize: vertical; min-height: 48px;
        background: color-mix(in srgb, var(--bg, #07101d), transparent 18%); color: var(--fg, #e7f7ff);
        border: 1px solid var(--advconv-border);
        border-radius: 8px; padding: 8px 9px; font: inherit; font-size: 12px;
        box-shadow: none;
      }
      .pc-advconv__reply textarea:focus { outline: 2px solid color-mix(in oklab, var(--advconv-accent), transparent 66%); outline-offset: 2px; }
      .pc-advconv__replyactions { justify-content: flex-end; }
      .pc-advconv .pc-coord__actions button,
      .pc-advconv__replybtn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 30px;
        padding: 5px 10px;
        border: 1px solid color-mix(in oklab, var(--advconv-accent), transparent 64%);
        border-radius: 8px;
        background: color-mix(in oklab, var(--advconv-accent), transparent 90%);
        color: var(--fg, #e7f7ff);
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0;
        cursor: pointer;
        transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      .pc-advconv .pc-coord__actions button:hover:not(:disabled),
      .pc-advconv__replybtn:hover:not(:disabled) {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 30%);
        background: color-mix(in oklab, var(--advconv-accent), transparent 64%);
      }
      .pc-advconv .pc-coord__actions button:disabled,
      .pc-advconv__replybtn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .pc-advconv__replybtn--resolve:not(:disabled) {
        border-color: color-mix(in oklab, var(--good, #22c55e), transparent 64%);
        color: var(--fg, #e7f7ff);
        background: color-mix(in oklab, var(--good, #22c55e), transparent 90%);
      }
      .pc-advconv__replybtn--resolve:hover:not(:disabled) {
        border-color: color-mix(in oklab, var(--good, #22c55e), transparent 30%);
        background: color-mix(in oklab, var(--good, #22c55e), transparent 64%);
      }

      /* View tabs — 6 tabs can outgrow narrow widths: the tablist scrolls
         horizontally, never wraps to a second header row. */
      .pc-advconv__viewtabs {
        position: relative;
        z-index: 1;
        align-self: center;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 0;
        flex: 0 0 auto;
        border: 0;
        border-radius: 0;
        background: transparent;
        box-shadow: none;
        max-width: 100%;
        min-width: 0;
        overflow-x: auto;
        scrollbar-width: thin;
      }
      .pc-advconv__viewtab {
        flex: 0 0 auto;
        white-space: nowrap;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 30px;
        padding: 5px 11px;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0;
        border: 1px solid var(--advconv-border);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 30%);
        color: var(--fg-dim, #b9d4e8);
        cursor: pointer;
        box-shadow: none;
        transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      .pc-advconv__viewtab > svg {
        color: var(--fg-mute, #7f9bb4);
        transition: color 120ms ease;
      }
      .pc-advconv__viewtab span {
        display: inline;
        min-width: 0;
      }
      .pc-advconv__viewtab:hover {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 55%);
        background: var(--advconv-accent-softer);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__viewtab.is-active {
        background: color-mix(in oklab, var(--advconv-accent), transparent 84%);
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 45%);
        color: var(--fg, #e7f7ff);
        font-weight: 700;
        box-shadow: none;
      }
      .pc-advconv__viewtab.is-active > svg,
      .pc-advconv__viewtab:hover > svg {
        color: var(--advconv-accent-strong);
      }
      /* Divider between the curated views and the raw event log. */
      .pc-advconv__viewtab-sep {
        flex: 0 0 auto;
        align-self: center;
        width: 1px;
        height: 18px;
        margin: 0 3px;
        background: var(--advconv-border);
      }
      /* "Raw events" is a debug tool, not a conversation type — render it muted
         and neutral (no sky accent), with a dashed edge, so it reads as set apart. */
      .pc-advconv__viewtab--raw {
        color: var(--fg-mute, #7f9bb4);
        border-style: dashed;
        border-color: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 64%);
        background: transparent;
      }
      .pc-advconv__viewtab--raw > svg { color: var(--fg-mute, #7f9bb4); }
      .pc-advconv__viewtab--raw:hover {
        border-color: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 40%);
        background: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 90%);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__viewtab--raw.is-active {
        border-color: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 28%);
        background: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 78%);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__viewtab--raw.is-active > svg,
      .pc-advconv__viewtab--raw:hover > svg { color: var(--fg-dim, #b9d4e8); }
      /* Threads split fills the remaining height */
      .pc-advconv .pc-coord__split { flex: 1 1 auto; min-height: 0; }
      .pc-advconv__threads {
        grid-template-columns: minmax(260px, 360px) minmax(0, 1fr);
        gap: 8px;
      }
      .pc-advconv__threads .pc-coord__rail,
      .pc-advconv__threads .pc-coord__detail {
        max-height: none;
        min-height: 0;
        border: 1px solid var(--advconv-border);
        border-radius: 12px;
        background: var(--advconv-panel);
        backdrop-filter: blur(12px);
      }
      .pc-advconv__threads .pc-coord__rail {
        padding: 8px;
        gap: 6px;
      }
      .pc-advconv__threads .pc-coord__detail {
        border-left: 1px solid var(--advconv-border);
        padding: 10px;
      }
      .pc-advconv__railhead {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 1px 1px 6px;
        color: var(--fg-mute, #9fb6cc);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0;
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
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 3px;
        padding: 7px 9px;
        border-radius: 8px;
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
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
      }
      .pc-advconv__statepill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 18px;
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 1px 6px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 72%);
        background: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 90%);
        color: var(--fg-dim, #b9d4e8);
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0;
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
      /* Kind pill — bring the coordination.css base (a square, hardcoded-#9bd chip)
         in line with the site's rounded, semantic-token pills (StatusPill family).
         Question is accent-tinted so it pops against neutral discussions/roles in
         the thread rail. */
      .pc-advconv .pc-coord__kind {
        display: inline-flex;
        align-items: center;
        min-height: 18px;
        padding: 1px 7px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 72%);
        background: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 90%);
        color: var(--fg-dim, #b9d4e8);
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advconv .pc-coord__kind--question {
        border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 56%);
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 86%);
        color: var(--accent-strong, #7dd3fc);
      }
      /* Topic tags — subtle accent pills (was the hardcoded-#9bd .pc-coord__tag). */
      .pc-advconv .pc-coord__tag {
        display: inline-flex;
        align-items: center;
        padding: 1px 7px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 80%);
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 92%);
        color: var(--accent-strong, #7dd3fc);
        font-size: 10px;
        font-weight: 700;
      }
      .pc-advconv__rowdate {
        margin-left: auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--fg-mute, #6f87a0);
        font-size: 10px;
        font-variant-numeric: tabular-nums;
      }
    .pc-advconv__threads .pc-coord__row-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
      letter-spacing: 0;
    }
      .pc-advconv__threads .pc-coord__row-meta {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
      }
      .pc-advconv__threads .pc-coord__card {
        min-height: 100%;
        padding: 2px;
      }
      .pc-advconv__detailhead {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
        padding: 0 0 8px;
        border-bottom: 1px solid var(--advconv-border);
      }
      .pc-advconv__detailkicker {
        display: flex;
        align-items: center;
        gap: 5px;
        margin: 0 0 5px;
      }
      .pc-advconv__threads .pc-coord__card header h2 {
        font-size: 22px;
        line-height: 1;
        letter-spacing: 0;
      }
      .pc-advconv__detailstats {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 4px;
        max-width: 340px;
      }
      .pc-advconv__detailstats span {
        display: inline-flex;
        align-items: center;
        min-height: 20px;
        padding: 2px 6px;
        border-radius: 8px;
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
        border-radius: 0 8px 8px 0;
        padding: 8px 10px;
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
        gap: 8px;
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

      /* Agent-chat transcript — role-differentiated turns */
      .pc-advconv__transcript {
        gap: 9px;
      }
      /* WI-125 live-chat embed: <ChatPanel> sizes itself with flex, so the
         wrapper must hand it a definite box (same WebKitGTK height-collapse
         gotcha as the dock — see HarnessesDock). */
      .pc-advconv__livechat {
        display: flex;
        height: min(64vh, 680px);
        min-height: 320px;
        border: 1px solid var(--advconv-border);
        border-radius: 10px;
        overflow: hidden;
      }
      .pc-advconv__livechat > * {
        flex: 1;
        min-width: 0;
      }
      .pc-advconv__turn p {
        margin: 4px 0 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-size: 12px;
        line-height: 1.5;
        color: var(--fg, #d7e7f4);
      }
      .pc-advconv__turn--user::before {
        background: var(--accent-strong, #7dd3fc) !important;
      }
      .pc-advconv__turn--assistant::before {
        background: var(--good, #6ee7b7) !important;
      }
      .pc-advconv__turn--system::before {
        background: var(--fg-mute, #8aa3bc) !important;
      }
      .pc-advconv__turn--system p {
        color: var(--fg-mute, #9fb6cd);
        font-style: italic;
      }

      /* Feed */
      .pc-advfeed { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 6px; }
      .pc-advfeed__filters {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 6px 8px;
        border-radius: 10px;
        background: color-mix(in srgb, var(--bg, #07101d), transparent 12%);
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 88%);
      }
      .pc-advfeed__filterhead {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 1px 2px 2px;
        color: var(--fg-mute, #8aa3bc);
        font-size: 11px;
      }
      .pc-advfeed__filterhead > div:first-child {
        min-width: 0;
      }
      .pc-advfeed__filterhead span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--fg, #e7f7ff);
        font-weight: 850;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advfeed__filterhead p { display: none; }
      .pc-advfeed__filtermeta {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 4px;
        flex-wrap: wrap;
      }
      .pc-advfeed__filtermeta strong,
      .pc-advfeed__filtermeta span,
      .pc-advfeed__needsline strong {
        display: inline-flex;
        align-items: center;
        min-height: 22px;
        padding: 2px 7px;
        border-radius: 7px;
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 82%);
        background: color-mix(in srgb, var(--bg-deeper, #040b14), transparent 15%);
        color: var(--fg, #e7f7ff);
        font-size: 10px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .pc-advfeed__filtermeta span {
        background: transparent;
        color: var(--fg-mute, #9fb6cc);
      }
      .pc-advfeed__needsline {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
        padding: 0;
      }
      .pc-advfeed__needsline span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-height: 22px;
        padding: 3px 7px;
        border-radius: 7px;
        color: var(--fg-dim, #b9d4e8);
        background: color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 93%);
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 82%);
        font-size: 10px;
        font-weight: 700;
      }
      .pc-advfeed__needsline strong {
        margin-left: auto;
      }
      .pc-advfeed__kindgroups {
        gap: 4px;
      }
      .pc-advfeed__groupchip,
      .pc-advfeed__advancedtoggle {
        --advconv-button-accent: var(--advconv-accent);
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-height: 28px;
        padding: 4px 8px;
        border-radius: 7px;
        font-size: 11px;
        font-weight: 700;
      }
      .pc-advfeed__advancedtoggle {
        --advconv-button-accent: #a78bfa;
      }
      .pc-advfeed__rawkinds {
        padding-top: 2px;
      }
      .pc-advfeed__kindchip {
        --advconv-button-accent: var(--fg-mute, #94a3b8);
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-height: 26px;
        padding: 3px 7px;
        border-radius: 7px;
        font-size: 10.5px;
        font-weight: 700;
      }
      .pc-advfeed__kinddot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
      .pc-advfeed__kindn {
        font-variant-numeric: tabular-nums; font-size: 10px; opacity: 0.8;
        background: color-mix(in srgb, var(--bg-3, rgba(255, 255, 255, 0.075)), transparent 20%); border-radius: 6px; padding: 0 4px; margin-left: 2px;
      }
      .pc-advfeed__inputs { display: flex; gap: 5px; flex-wrap: wrap; align-items: flex-end; }
      .pc-advfeed__field {
        display: flex;
        flex-direction: column;
        gap: 3px;
        flex: 0 1 142px;
        min-width: 118px;
        max-width: 150px;
      }
      .pc-advfeed__field > span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: var(--fg-mute, #7890a8);
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advfeed__field--search {
        flex: 0 1 220px;
        max-width: 240px;
      }
      .pc-advfeed__input {
        width: 100%;
        height: 28px;
        background: color-mix(in srgb, var(--bg-deeper, #040b14), transparent 15%);
        color: var(--fg, #e7f7ff);
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 82%);
        border-radius: 8px;
        padding: 4px 7px;
        font: inherit;
        font-size: 11.5px;
        min-width: 0;
      }
      .pc-advfeed__input::placeholder { color: color-mix(in srgb, var(--accent-soft, #94a3b8), transparent 60%); }
      .pc-advfeed__input:focus { outline: 2px solid color-mix(in oklab, var(--advconv-accent), transparent 66%); outline-offset: 1px; }
      .pc-advfeed__clear { min-height: 28px; }
      .pc-advfeed__scopebar {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
        padding-top: 2px;
        font-size: 11px;
        color: var(--fg-mute, #8aa3bc);
      }
      .pc-advfeed__scopebar > span {
        font-weight: 700;
        letter-spacing: 0;
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
        padding: 2px 7px;
        border-radius: 7px;
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
        gap: 5px;
        padding: 3px 1px 8px;
      }
      .pc-advfeed__daysep {
        position: sticky; top: 0; z-index: 1;
        font-size: 10px; letter-spacing: 0; text-transform: uppercase;
        color: var(--fg-mute, #7890a8); padding: 4px 2px 1px;
        background: linear-gradient(var(--advconv-bg), color-mix(in srgb, var(--advconv-bg), transparent 18%));
      }
      .pc-advfeed__daysep span {
        display: inline-flex;
        padding: 2px 7px;
        border-radius: 7px;
        background: var(--advconv-accent-softer);
        border: 1px solid var(--advconv-border);
      }
      .pc-advfeed__item { border-radius: 6px; }
      .pc-advfeed__item.is-open { background: var(--advconv-accent-softer); }
      .pc-advfeed__row {
        width: 100%; display: grid;
        grid-template-columns: auto auto minmax(120px, 1fr) minmax(0, 2fr) auto auto auto;
        align-items: center; gap: 6px; text-align: left;
        padding: 6px 8px;
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 40%);
        font-size: 12px; color: var(--fg, #dceaf6);
        border: 1px solid color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.15)), transparent 58%);
        border-radius: 8px;
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
      .pc-advfeed__time { font-variant-numeric: tabular-nums; font-size: 10px; color: var(--fg-mute, #7890a8); }
      .pc-advfeed__badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 7px;
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
      .pc-advfeed__badge--sm { font-size: 10px; padding: 0 5px; }
      .pc-advfeed__route { display: inline-flex; align-items: center; gap: 4px; min-width: 0; font-size: 10.5px; }
      .pc-advfeed__from {
        border: none; background: none; color: var(--fg, #cfe8ff); font: inherit; font-size: 10.5px;
        font-weight: 600; cursor: pointer; padding: 0; max-width: 120px; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap;
      }
      .pc-advfeed__from:hover { text-decoration: underline; }
      .pc-advfeed__to { color: var(--fg-mute, #8aa3bc); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
      .pc-advfeed__to--broadcast { color: var(--advconv-accent-strong); font-weight: 600; display: inline-flex; align-items: center; gap: 3px; }
      .pc-advfeed__to--human { color: var(--warn, #f59e0b); font-weight: 600; display: inline-flex; align-items: center; gap: 3px; }
      .pc-advfeed__summary {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg, #dceaf6);
        border: none; background: none; font: inherit; font-size: 11.5px; text-align: left;
        cursor: pointer; padding: 0; min-width: 0;
      }
      .pc-advfeed__summary:hover { color: var(--fg, #e7f7ff); }
      .pc-advfeed__nosum { color: var(--fg-mute, #5f7488); }
      .pc-advfeed__planchip {
        font-size: 10px; padding: 1px 6px; border-radius: 7px; white-space: nowrap;
        border: 1px solid color-mix(in oklab, var(--advconv-accent), transparent 58%);
        color: var(--advconv-accent-strong);
        background: var(--advconv-accent-softer);
        cursor: pointer; font: inherit;
      }
      .pc-advfeed__planchip:hover { background: var(--advconv-accent-soft); }
      .pc-advfeed__replyn { font-size: 10px; color: var(--fg-mute, #8aa3bc); white-space: nowrap; }
      .pc-advfeed__rel { font-size: 10px; color: var(--fg-mute, #6f87a0); white-space: nowrap; font-variant-numeric: tabular-nums; }
      .pc-advfeed__detail {
        margin: 0 6px 3px 28px;
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 11.5px;
        border: 1px solid var(--advconv-border);
        border-left: 2px solid color-mix(in oklab, var(--advconv-accent), transparent 58%);
        background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 18%);
        border-radius: 0 8px 8px 0;
        box-shadow: none;
      }
      .pc-advfeed__detailhead {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
      }
      .pc-advfeed__detailhead span {
        display: inline-flex;
        align-items: center;
        min-height: 18px;
        padding: 1px 6px;
        border-radius: 7px;
        border: 1px solid var(--advconv-border);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 34%);
        color: var(--fg-mute, #8aa3bc);
        font-size: 10px;
        font-weight: 700;
      }
      .pc-advfeed__bodycard,
      .pc-advfeed__kv {
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 82%);
        background: color-mix(in srgb, var(--bg-deeper, #040b14), transparent 15%);
      }
      .pc-advfeed__bodycard strong,
      .pc-advfeed__kv strong {
        display: block;
        margin-bottom: 3px;
        color: var(--fg, #e7f7ff);
        font-size: 10px;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advfeed__body { white-space: pre-wrap; color: var(--fg, #dceaf6); margin: 0; line-height: 1.42; }
      .pc-advfeed__kv { color: var(--fg-mute, #9fb6cc); margin: 0; }
      .pc-advfeed__kv span { color: var(--fg-mute, #b6c8d8); line-height: 1.45; }
      .pc-advfeed__kv--action {
        border-color: color-mix(in oklab, var(--warn, #f59e0b), transparent 70%);
        background: color-mix(in oklab, var(--warn, #f59e0b), transparent 93%);
      }
      .pc-advfeed__kv--action strong { color: var(--warn, #f59e0b); }
      .pc-advfeed__thread {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .pc-advfeed__thread li {
        position: relative;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: start;
        gap: 6px 8px;
        padding: 6px 8px 6px 2px;
        font-size: 10.5px;
      }
      .pc-advfeed__threadrail {
        width: 9px;
        height: 9px;
        margin-top: 4px;
        border-radius: 50%;
        background: var(--advconv-accent);
        box-shadow: none;
      }
      .pc-advfeed__threadmeta {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
      }
      .pc-advfeed__threadmeta strong { color: var(--fg, #e7f7ff); font-size: 10.5px; }
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
        margin: 5px auto; padding: 5px 12px; border-radius: 7px; font-size: 11px; cursor: pointer;
        border: 1px solid var(--border, rgba(125,211,252,0.2)); background: transparent; color: var(--fg-mute, #9fb6cc); font: inherit;
      }
      .pc-advfeed__loadolder:hover { color: var(--fg, #e7f7ff); border-color: var(--advconv-border-strong); background: var(--advconv-accent-soft); }
      .pc-advfeed__refresh { flex: 0 0 auto; }
      @media (max-width: 920px) {
        .pc-advconv__header { grid-template-columns: 1fr; }
        .pc-advconv__viewtabs { align-self: stretch; }
        .pc-advconv__viewtab { justify-content: center; }
        .pc-advconv__detailhead { flex-direction: column; }
        .pc-advconv__detailstats { justify-content: flex-start; max-width: none; }
        .pc-advconv__replyhead { flex-direction: column; }
        .pc-advconv__replyhead em { max-width: none; text-align: left; }
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
        .pc-advconv__header { padding: 8px 10px; border-radius: 12px; }
        .pc-advfeed__filterhead,
        .pc-advfeed__filtermeta,
        .pc-advfeed__needsline {
          align-items: stretch;
          flex-direction: column;
        }
        .pc-advfeed__needsline strong { margin-left: 0; }
        .pc-advfeed__inputs { flex-direction: column; }
        .pc-advfeed__field,
        .pc-advfeed__field--search {
          width: 100%;
          max-width: none;
        }
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
