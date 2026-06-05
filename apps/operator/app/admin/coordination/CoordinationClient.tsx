'use client';

/**
 * Coordination admin tab (integration-adoption-2026-06-03, Capstone P2).
 *
 * Three operator-level, cross-harness views over the coordination substrate:
 *   • Issues   — the agent-facing engineer_issues surface (the audit's gap: no
 *                cross-harness issues view existed). list/get/claim/close.
 *   • Topics   — the shared topic taxonomy + a topic's cross-object feed
 *                (issues/conversations/features/plans tagged it).
 *   • Conversations — questions/discussions on the substrate (su-9fd2d's).
 *
 * Data goes through /api/admin/coordination/<group>/<verb>, which re-dispatches
 * to the SAME MCP tools the agents use (no second data path). All user-meaningful
 * state is in the URL via nuqs (CLAUDE.md) so the views are deep-linkable +
 * agent-driveable; only loading/error lifecycle is useState.
 *
 * NB: this is reactive on demand (fetch + manual reload). Live SSE push (the
 * useSyncQuery path) is a follow-up; the data is already correct on (re)load.
 */
import { useCallback, useEffect, useState } from 'react';
import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs';
import './coordination.css';

type Tab = 'issues' | 'topics' | 'conversations';
const TABS: readonly Tab[] = ['issues', 'topics', 'conversations'];

async function coord<T = Record<string, unknown>>(verb: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/api/admin/coordination/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  return (await res.json()) as T;
}

export default function CoordinationClient() {
  const [tab, setTab] = useQueryState('tab', parseAsStringEnum<Tab>([...TABS]).withDefault('issues'));
  return (
    <div className="pc-coord">
      <nav className="pc-coord__subtabs" aria-label="Coordination views">
        {TABS.map((t) => (
          <button key={t} type="button" className={`pc-coord__subtab${tab === t ? ' is-active' : ''}`} onClick={() => void setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      {tab === 'issues' && <IssuesPanel />}
      {tab === 'topics' && <TopicsPanel />}
      {tab === 'conversations' && <ConversationsPanel />}
    </div>
  );
}

// ── Issues ────────────────────────────────────────────────────────────────────

interface IssueRow {
  id: string;
  title: string;
  severity: string;
  state: string;
  scope: string;
  assignee: string | null;
  source: string;
}
interface IssueDetailT extends IssueRow {
  body: string;
  topics: string[];
  posts: { id: number; author_id: string | null; body: string; created_ts: string }[];
  links: { rel: string; dst: { kind: string; ref: string } }[];
  linkedFeatureId: string | null;
}

const ISSUE_STATES = ['open', 'resolved', 'closed', 'all'] as const;
type IssueStateFilter = (typeof ISSUE_STATES)[number];

function IssuesPanel() {
  const [state, setState] = useQueryState('istate', parseAsStringEnum<IssueStateFilter>([...ISSUE_STATES]).withDefault('open'));
  const [sel, setSel] = useQueryState('issue', parseAsString);
  const [list, setList] = useState<IssueRow[]>([]);
  const [detail, setDetail] = useState<IssueDetailT | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const r = await coord<{ issues?: IssueRow[] }>('issues/list', state === 'all' ? {} : { state });
    setList(r.issues ?? []);
    setLoading(false);
  }, [state]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (!sel) {
      setDetail(null);
      return;
    }
    void coord<{ issue?: IssueDetailT }>('issues/get', { id: sel }).then((r) => setDetail(r.issue ?? null));
  }, [sel]);

  const act = async (verb: string, body: Record<string, unknown>) => {
    setBusy(true);
    await coord(verb, body);
    setBusy(false);
    await reload();
    if (sel) void coord<{ issue?: IssueDetailT }>('issues/get', { id: sel }).then((r) => setDetail(r.issue ?? null));
  };

  return (
    <div className="pc-coord__split">
      <aside className="pc-coord__rail">
        <div className="pc-coord__filters">
          {ISSUE_STATES.map((s) => (
            <button key={s} type="button" className={`pc-coord__chip${state === s ? ' is-active' : ''}`} onClick={() => void setState(s)}>
              {s}
            </button>
          ))}
        </div>
        {loading ? (
          <p className="pc-coord__empty">Loading…</p>
        ) : list.length === 0 ? (
          <p className="pc-coord__empty">No issues.</p>
        ) : (
          list.map((i) => (
            <button key={i.id} type="button" className={`pc-coord__row${sel === i.id ? ' is-active' : ''}`} onClick={() => void setSel(i.id)}>
              <span className={`pc-coord__sev pc-coord__sev--${i.severity}`}>{i.severity}</span>
              <span className="pc-coord__row-title">{i.title}</span>
              <span className="pc-coord__row-meta">
                {i.id} · {i.state}
                {i.assignee ? ` · ${i.assignee}` : ''}
              </span>
            </button>
          ))
        )}
      </aside>
      <section className="pc-coord__detail">
        {!detail ? (
          <p className="pc-coord__empty">Select an issue.</p>
        ) : (
          <article className="pc-coord__card">
            <header>
              <h2>{detail.title}</h2>
              <p className="pc-coord__row-meta">
                {detail.id} · {detail.severity} · {detail.state} · {detail.scope} · {detail.source}
                {detail.assignee ? ` · @${detail.assignee}` : ' · unassigned'}
                {detail.linkedFeatureId ? ` · → ${detail.linkedFeatureId}` : ''}
              </p>
            </header>
            {detail.body && <p className="pc-coord__body">{detail.body}</p>}
            {detail.topics.length > 0 && (
              <p className="pc-coord__tags">{detail.topics.map((t) => <span key={t} className="pc-coord__tag">#{t}</span>)}</p>
            )}
            <div className="pc-coord__actions">
              {detail.state === 'open' && (
                <>
                  <button type="button" disabled={busy} onClick={() => void act('issues/claim', { id: detail.id })}>Claim</button>
                  <button type="button" disabled={busy} onClick={() => void act('issues/close', { id: detail.id, state: 'resolved' })}>Resolve</button>
                  <button type="button" disabled={busy} onClick={() => void act('issues/close', { id: detail.id, state: 'closed' })}>Close</button>
                </>
              )}
              {detail.state !== 'open' && (
                <button type="button" disabled={busy} onClick={() => void act('issues/close', { id: detail.id, state: 'open' })}>Reopen</button>
              )}
            </div>
            {detail.links.length > 0 && (
              <ul className="pc-coord__links">
                {detail.links.map((l, idx) => (
                  <li key={idx}>{l.rel} → {l.dst.kind}:{l.dst.ref}</li>
                ))}
              </ul>
            )}
            <ol className="pc-coord__thread">
              {detail.posts.map((p) => (
                <li key={p.id}>
                  <span className="pc-coord__row-meta">{p.author_id ?? 'unknown'}</span>
                  <p>{p.body}</p>
                </li>
              ))}
              {detail.posts.length === 0 && <li className="pc-coord__empty">No comments.</li>}
            </ol>
          </article>
        )}
      </section>
    </div>
  );
}

// ── Topics ────────────────────────────────────────────────────────────────────

interface TopicRow {
  slug: string;
  title: string | null;
  description: string;
  subscribed?: boolean;
}
interface FeedItem {
  kind: string;
  ref: string;
  title: string | null;
  state: string | null;
}

function TopicsPanel() {
  const [sel, setSel] = useQueryState('topic', parseAsString);
  const [topics, setTopics] = useState<TopicRow[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const r = await coord<{ topics?: TopicRow[] }>('topics/list', {});
    setTopics(r.topics ?? []);
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (!sel) {
      setFeed([]);
      return;
    }
    void coord<{ items?: FeedItem[] }>('topics/feed', { topic: sel }).then((r) => setFeed(r.items ?? []));
  }, [sel]);

  return (
    <div className="pc-coord__split">
      <aside className="pc-coord__rail">
        {loading ? (
          <p className="pc-coord__empty">Loading…</p>
        ) : topics.length === 0 ? (
          <p className="pc-coord__empty">No topics yet.</p>
        ) : (
          topics.map((t) => (
            <button key={t.slug} type="button" className={`pc-coord__row${sel === t.slug ? ' is-active' : ''}`} onClick={() => void setSel(t.slug)}>
              <span className="pc-coord__row-title">#{t.slug}</span>
              <span className="pc-coord__row-meta">{t.description}</span>
            </button>
          ))
        )}
      </aside>
      <section className="pc-coord__detail">
        {!sel ? (
          <p className="pc-coord__empty">Select a topic to see its cross-object feed.</p>
        ) : (
          <article className="pc-coord__card">
            <header>
              <h2>#{sel}</h2>
              <p className="pc-coord__row-meta">{feed.length} item(s) tagged across issues / conversations / features / plans</p>
            </header>
            <ul className="pc-coord__feed">
              {feed.map((f) => (
                <li key={`${f.kind}:${f.ref}`}>
                  <span className={`pc-coord__kind pc-coord__kind--${f.kind}`}>{f.kind}</span>
                  <span className="pc-coord__row-title">{f.title ?? f.ref}</span>
                  <span className="pc-coord__row-meta">{f.ref}{f.state ? ` · ${f.state}` : ''}</span>
                </li>
              ))}
              {feed.length === 0 && <li className="pc-coord__empty">Nothing tagged this topic yet.</li>}
            </ul>
          </article>
        )}
      </section>
    </div>
  );
}

// ── Conversations ─────────────────────────────────────────────────────────────

interface ConvRow {
  id: string;
  kind: string;
  title: string | null;
  state: string;
}
interface ConvPost {
  id: number;
  author_id: string | null;
  body: string;
  created_ts?: string;
}
interface ConvDetailT extends ConvRow {
  body?: string;
  asker_id?: string;
  accepted_answer?: string | null;
  topics: string[];
  posts: ConvPost[];
  subscriber_count: number;
}
// su-9fd2d's conversations:get returns the conversation fields PLUS topics / posts
// / subscriber_count as TOP-LEVEL siblings (not nested in `conversation`).
interface ConvGetResponse {
  conversation?: Omit<ConvDetailT, 'topics' | 'posts' | 'subscriber_count'>;
  topics?: string[];
  posts?: ConvPost[];
  subscriber_count?: number;
}

function ConversationsPanel() {
  const [sel, setSel] = useQueryState('conversation', parseAsString);
  const [list, setList] = useState<ConvRow[]>([]);
  const [detail, setDetail] = useState<ConvDetailT | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const r = await coord<{ conversations?: ConvRow[]; items?: ConvRow[] }>('conversations/list', {});
    setList(r.conversations ?? r.items ?? []);
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (!sel) {
      setDetail(null);
      return;
    }
    void coord<ConvGetResponse>('conversations/get', { conversation_id: sel }).then((r) =>
      setDetail(
        r.conversation
          ? { ...r.conversation, topics: r.topics ?? [], posts: r.posts ?? [], subscriber_count: r.subscriber_count ?? 0 }
          : null,
      ),
    );
  }, [sel]);

  return (
    <div className="pc-coord__split">
      <aside className="pc-coord__rail">
        {loading ? (
          <p className="pc-coord__empty">Loading…</p>
        ) : list.length === 0 ? (
          <p className="pc-coord__empty">No conversations.</p>
        ) : (
          list.map((c) => (
            <button key={c.id} type="button" className={`pc-coord__row${sel === c.id ? ' is-active' : ''}`} onClick={() => void setSel(c.id)}>
              <span className={`pc-coord__kind pc-coord__kind--${c.kind}`}>{c.kind}</span>
              <span className="pc-coord__row-title">{c.title ?? c.id}</span>
              <span className="pc-coord__row-meta">{c.state}</span>
            </button>
          ))
        )}
      </aside>
      <section className="pc-coord__detail">
        {!detail ? (
          <p className="pc-coord__empty">Select a conversation.</p>
        ) : (
          <article className="pc-coord__card">
            <header>
              <h2>{detail.title ?? detail.id}</h2>
              <p className="pc-coord__row-meta">
                {detail.kind} · {detail.state} · {detail.subscriber_count} follower(s)
                {detail.asker_id ? ` · asked by ${detail.asker_id}` : ''}
              </p>
            </header>
            {detail.topics.length > 0 && (
              <p className="pc-coord__tags">{detail.topics.map((t) => <span key={t} className="pc-coord__tag">#{t}</span>)}</p>
            )}
            {detail.body && <p className="pc-coord__body">{detail.body}</p>}
            {detail.accepted_answer && (
              <p className="pc-coord__body"><strong>Accepted:</strong> {detail.accepted_answer}</p>
            )}
            <ol className="pc-coord__thread">
              {detail.posts.map((p) => (
                <li key={p.id}>
                  <span className="pc-coord__row-meta">{p.author_id ?? 'unknown'}</span>
                  <p>{p.body}</p>
                </li>
              ))}
              {detail.posts.length === 0 && <li className="pc-coord__empty">No posts.</li>}
            </ol>
          </article>
        )}
      </section>
    </div>
  );
}
