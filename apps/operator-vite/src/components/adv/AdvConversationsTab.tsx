/**
 * AdvConversationsTab — the /adv "Conversations" tab (Brief 25,
 * conversations-tab-2026-06-05). A workspace-wide browse surface over the
 * coordination conversations substrate (coord_conversations + thread posts +
 * topic tags), the human counterpart to the agents' conversations:* tools.
 *
 * Data rides the SAME in-process tool dispatch the admin coordination panel
 * uses (POST /api/admin/coordination/conversations/<verb> → the conversations:*
 * MCP handlers) — one data path, no Zero entity (D-001). Reuses the pc-coord__*
 * classes from the admin coordination view.
 *
 * Filters: state (open/resolved/closed) + kind (question/discussion) go
 * server-side; topic is filtered client-side over the loaded page as clickable
 * chips (the chip universe stays the full state+kind page; the server-side topic
 * arg added in D-002 is exercised by the TUI + API consumers). All
 * user-meaningful state is in the URL via nuqs (CLAUDE.md); only the mid-edit
 * reply draft + loading/busy lifecycle is useState.
 *
 * Detail = the seed + topics + the full thread + the accepted answer + the
 * linked work-item (the promoted engineer issue, D-004) + a promote-to-issue
 * action (D-005) and reply/resolve.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs';
import { ArrowUpRight, MessageCircle, RefreshCw } from 'lucide-react';
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
// conversations:get returns the conversation fields PLUS topics / posts /
// subscriber_count as TOP-LEVEL siblings (not nested in `conversation`).
interface ConvGetResponse {
  conversation?: Omit<ConvDetailT, 'topics' | 'posts' | 'subscriber_count'>;
  topics?: string[];
  posts?: ConvPost[];
  subscriber_count?: number;
}

export default function AdvConversationsTab() {
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

  // Topic chips: the full set across the loaded (state+kind) page, so the chip
  // universe doesn't collapse when a topic is selected (D-002 UX).
  const allTopics = useMemo(() => {
    const s = new Set<string>();
    for (const c of list) for (const t of c.topics ?? []) s.add(t);
    return [...s].sort();
  }, [list]);
  const visible = useMemo(
    () => (topic ? list.filter((c) => (c.topics ?? []).includes(topic)) : list),
    [list, topic],
  );
  const pageStats = useMemo(() => {
    let questions = 0;
    let discussions = 0;
    let promoted = 0;
    for (const c of visible) {
      if (c.kind === 'question') questions += 1;
      if (c.kind === 'discussion') discussions += 1;
      if (c.promoted_issue_id) promoted += 1;
    }
    return { questions, discussions, promoted };
  }, [visible]);

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
    <div className="pc-coord pc-advconv">
      <section className="pc-advconv__hero" aria-label="Conversations overview">
        <div className="pc-advconv__hero-copy">
          <span className="pc-advconv__eyebrow">Coordination archive</span>
          <h2>Conversations that turned into work</h2>
          <p>
            Browse questions and discussions from the shared coordination layer, then jump from
            the thread to a reply, accepted answer, or promoted engineer issue.
          </p>
        </div>
        <dl className="pc-advconv__metrics">
          <div>
            <dt>shown</dt>
            <dd>{visible.length}</dd>
          </div>
          <div>
            <dt>questions</dt>
            <dd>{pageStats.questions}</dd>
          </div>
          <div>
            <dt>promoted</dt>
            <dd>{pageStats.promoted}</dd>
          </div>
        </dl>
      </section>
      <div className="pc-coord__split">
        <aside className="pc-coord__rail">
          <div className="pc-advconv__rail-head">
            <div>
              <span className="pc-advconv__eyebrow">Browse</span>
              <strong>{topic ? `#${topic}` : 'All loaded threads'}</strong>
            </div>
            <span className="pc-advconv__sync">{loading ? 'syncing' : `${visible.length}/${list.length}`}</span>
          </div>
          <span className="pc-advconv__filter-label">State</span>
          <div className="pc-coord__filters" role="tablist" aria-label="State filter">
            {CONV_STATES.map((s) => (
              <button key={s} type="button" className={`pc-coord__chip${state === s ? ' is-active' : ''}`} onClick={() => void setState(s)}>
                {s}
              </button>
            ))}
          </div>
          <span className="pc-advconv__filter-label">Kind</span>
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
            <>
              <span className="pc-advconv__filter-label">Topics</span>
              <div className="pc-coord__filters pc-advconv__topics" role="tablist" aria-label="Topic filter">
                <button type="button" className={`pc-coord__chip${!topic ? ' is-active' : ''}`} onClick={() => void setTopic('')}>
                  all topics
                </button>
                {allTopics.map((t) => (
                  <button key={t} type="button" className={`pc-coord__chip${topic === t ? ' is-active' : ''}`} onClick={() => void setTopic(topic === t ? '' : t)}>
                    #{t}
                  </button>
                ))}
              </div>
            </>
          )}
          {loading ? (
            <p className="pc-coord__empty pc-advconv__state-card">Loading conversations…</p>
          ) : visible.length === 0 ? (
            <p className="pc-coord__empty pc-advconv__state-card">No conversations match these filters.</p>
          ) : (
            visible.map((c) => (
              <button key={c.id} type="button" className={`pc-coord__row pc-advconv__row${sel === c.id ? ' is-active' : ''}`} onClick={() => void setSel(c.id)}>
                <span className={`pc-coord__kind pc-coord__kind--${c.kind} pc-advconv__kind`}>{c.kind}</span>
                <span className="pc-coord__row-title pc-advconv__row-title">{c.title ?? c.id}</span>
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
            <div className="pc-coord__empty pc-advconv__empty-detail">
              <MessageCircle size={22} aria-hidden />
              <strong>Select a conversation</strong>
              <span>Pick a thread from the rail to inspect its source, replies, answer, and promoted issue link.</span>
            </div>
          ) : (
            <article className="pc-coord__card">
              <header className="pc-advconv__detail-head">
                <div>
                  <span className="pc-advconv__eyebrow">{detail.kind} conversation</span>
                  <h2>{detail.title ?? detail.id}</h2>
                </div>
                <span className={`pc-advconv__status pc-advconv__status--${detail.state}`}>{detail.state}</span>
              </header>
              <p className="pc-coord__row-meta pc-advconv__detail-meta">
                {detail.subscriber_count} follower(s)
                {detail.scope === 'harness' && detail.harness_slug ? ` · ${detail.harness_slug}` : ''}
                {detail.asker_id ? ` · asked by ${detail.asker_id}` : ''}
              </p>
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
              <h3 className="pc-advconv__section-title">Thread</h3>
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
      <style>{`
        .pc-advconv {
          --advconv-accent: #ec4899;
          --advconv-accent-rgb: 236, 72, 153;
          --advconv-teal: #2dd4bf;
          gap: 14px;
          height: 100%;
          min-height: 0;
          padding: 14px;
        }
        .pc-advconv__hero {
          display: flex;
          justify-content: space-between;
          gap: 18px;
          padding: 18px;
          border: 1px solid color-mix(in oklab, var(--advconv-accent), transparent 68%);
          border-radius: 20px;
          background:
            radial-gradient(circle at 12% 0%, rgba(var(--advconv-accent-rgb), 0.26), transparent 34%),
            linear-gradient(135deg, rgba(7, 16, 29, 0.96), rgba(16, 24, 42, 0.82));
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.045);
        }
        .pc-advconv__hero-copy { max-width: 720px; }
        .pc-advconv__eyebrow {
          color: color-mix(in oklab, var(--advconv-teal), white 14%);
          font-size: 10px;
          font-weight: 780;
          letter-spacing: 0.12em;
          line-height: 1;
          text-transform: uppercase;
        }
        .pc-advconv__hero h2 {
          margin: 6px 0 5px;
          color: var(--fg, #e7f7ff);
          font-size: clamp(24px, 4vw, 40px);
          line-height: 0.98;
          letter-spacing: -0.055em;
        }
        .pc-advconv__hero p {
          margin: 0;
          color: color-mix(in oklab, var(--fg-mute, #9eb4ca), white 8%);
          font-size: 13px;
          line-height: 1.55;
        }
        .pc-advconv__metrics {
          display: grid;
          grid-template-columns: repeat(3, minmax(74px, 1fr));
          gap: 8px;
          min-width: 290px;
          margin: 0;
        }
        .pc-advconv__metrics div {
          display: flex;
          flex-direction: column-reverse;
          justify-content: space-between;
          min-height: 84px;
          padding: 12px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.045);
        }
        .pc-advconv__metrics dt {
          color: var(--fg-mute, #7f9bb4);
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0.1em;
          text-transform: uppercase;
        }
        .pc-advconv__metrics dd {
          margin: 0;
          color: var(--fg, #e7f7ff);
          font-size: 30px;
          font-weight: 800;
          letter-spacing: -0.04em;
        }
        .pc-advconv .pc-coord__split {
          grid-template-columns: minmax(300px, 390px) minmax(0, 1fr);
          gap: 14px;
          flex: 1;
          min-height: 0;
        }
        .pc-advconv .pc-coord__rail,
        .pc-advconv .pc-coord__detail {
          max-height: none;
          min-height: 0;
          border: 1px solid rgba(125, 211, 252, 0.13);
          border-radius: 18px;
          background: rgba(4, 13, 24, 0.72);
        }
        .pc-advconv .pc-coord__rail {
          gap: 8px;
          padding: 12px;
        }
        .pc-advconv .pc-coord__detail {
          padding: 16px;
          border-left: 1px solid rgba(125, 211, 252, 0.13);
        }
        .pc-advconv__rail-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 4px 2px 8px;
          color: var(--fg, #e7f7ff);
        }
        .pc-advconv__rail-head div { display: grid; gap: 4px; }
        .pc-advconv__sync {
          padding: 4px 8px;
          border: 1px solid rgba(125, 211, 252, 0.16);
          border-radius: 999px;
          color: var(--fg-mute, #7f9bb4);
          font-size: 11px;
          font-weight: 700;
        }
        .pc-advconv__filter-label {
          color: color-mix(in oklab, var(--fg-mute, #7f9bb4), white 12%);
          font-size: 10px;
          font-weight: 780;
          letter-spacing: 0.11em;
          text-transform: uppercase;
        }
        .pc-advconv .pc-coord__filters { gap: 6px; margin: 0 0 4px; }
        .pc-advconv .pc-coord__chip {
          padding: 5px 10px;
          border-color: rgba(125, 211, 252, 0.15);
          background: rgba(255, 255, 255, 0.035);
          color: color-mix(in oklab, var(--fg-mute, #9eb4ca), white 8%);
          font-weight: 680;
          transition: background-color 120ms, border-color 120ms, color 120ms;
        }
        .pc-advconv .pc-coord__chip:hover:not(:disabled) {
          border-color: rgba(var(--advconv-accent-rgb), 0.42);
          background: rgba(var(--advconv-accent-rgb), 0.12);
          color: var(--fg, #e7f7ff);
        }
        .pc-advconv .pc-coord__chip.is-active {
          border-color: rgba(var(--advconv-accent-rgb), 0.6);
          background: rgba(var(--advconv-accent-rgb), 0.22);
          color: #ffe9f5;
        }
        .pc-advconv__topics {
          max-height: 86px;
          overflow: auto;
          padding-right: 2px;
        }
        .pc-advconv__refresh { margin-left: auto; display: inline-flex; align-items: center; }
        .pc-advconv__state-card {
          display: block;
          padding: 16px;
          border: 1px dashed rgba(125, 211, 252, 0.16);
          border-radius: 14px;
          text-align: center;
        }
        .pc-advconv__row {
          grid-template-columns: auto minmax(0, 1fr);
          gap: 4px 10px;
          padding: 11px;
          border-color: rgba(125, 211, 252, 0.08);
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.028);
          transition: background-color 120ms, border-color 120ms;
        }
        .pc-advconv__row:hover {
          border-color: rgba(var(--advconv-accent-rgb), 0.24);
          background: rgba(var(--advconv-accent-rgb), 0.075);
        }
        .pc-advconv__row.is-active {
          border-color: rgba(var(--advconv-accent-rgb), 0.58);
          background:
            linear-gradient(90deg, rgba(var(--advconv-accent-rgb), 0.18), rgba(255, 255, 255, 0.04));
        }
        .pc-advconv__kind {
          border-radius: 999px;
          background: rgba(45, 212, 191, 0.12);
          color: #8af5e6;
        }
        .pc-advconv__row-title {
          min-width: 0;
          color: var(--fg, #e7f7ff);
          font-size: 13px;
          line-height: 1.25;
        }
        .pc-advconv .pc-coord__row-meta { color: color-mix(in oklab, var(--fg-mute, #8899aa), white 6%); }
        .pc-advconv__rowtags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; grid-column: 1 / -1; }
        .pc-advconv .pc-coord__tag {
          display: inline-flex;
          align-items: center;
          min-height: 20px;
          padding: 1px 7px;
          border: 1px solid rgba(45, 212, 191, 0.18);
          border-radius: 999px;
          background: rgba(45, 212, 191, 0.08);
          color: #99f6e4;
          font-size: 11px;
          font-weight: 680;
        }
        .pc-advconv__empty-detail {
          display: grid;
          place-items: center;
          gap: 8px;
          min-height: 360px;
          padding: 24px;
          border: 1px dashed rgba(125, 211, 252, 0.16);
          border-radius: 16px;
          text-align: center;
        }
        .pc-advconv__empty-detail strong { color: var(--fg, #e7f7ff); font-size: 17px; }
        .pc-advconv__empty-detail span { max-width: 380px; line-height: 1.5; }
        .pc-advconv .pc-coord__card {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .pc-advconv__detail-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 18px;
          padding-bottom: 10px;
          border-bottom: 1px solid rgba(125, 211, 252, 0.12);
        }
        .pc-advconv__detail-head h2 {
          margin: 6px 0 0;
          color: var(--fg, #e7f7ff);
          font-size: clamp(22px, 3vw, 34px);
          line-height: 1.04;
          letter-spacing: -0.045em;
        }
        .pc-advconv__status {
          flex-shrink: 0;
          padding: 5px 10px;
          border: 1px solid rgba(125, 211, 252, 0.16);
          border-radius: 999px;
          color: #dbeafe;
          font-size: 11px;
          font-weight: 780;
          text-transform: uppercase;
        }
        .pc-advconv__status--open { border-color: rgba(45, 212, 191, 0.42); color: #99f6e4; }
        .pc-advconv__status--resolved { border-color: rgba(34, 197, 94, 0.42); color: #bbf7d0; }
        .pc-advconv__status--closed { border-color: rgba(148, 163, 184, 0.35); color: #cbd5e1; }
        .pc-advconv__detail-meta { margin: 0; }
        .pc-advconv__accepted {
          border-left: 2px solid rgba(34, 197, 94, 0.6);
          padding: 10px 12px;
          border-radius: 0 12px 12px 0;
          background: rgba(34, 197, 94, 0.075);
        }
        .pc-advconv__linked {
          display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
          padding: 9px 11px;
          border: 1px solid rgba(var(--advconv-accent-rgb), 0.22);
          border-radius: 12px;
          background: rgba(var(--advconv-accent-rgb), 0.085);
          font-size: 12px; color: #fbcfe8; margin: 0;
        }
        .pc-advconv__section-title {
          margin: 6px 0 0;
          color: var(--fg, #e7f7ff);
          font-size: 12px;
          font-weight: 780;
          letter-spacing: 0.09em;
          text-transform: uppercase;
        }
        .pc-advconv .pc-coord__thread {
          gap: 10px;
          margin-top: 0;
        }
        .pc-advconv .pc-coord__thread li {
          padding: 10px 12px;
          border: 1px solid rgba(125, 211, 252, 0.12);
          border-left: 3px solid rgba(45, 212, 191, 0.34);
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.032);
        }
        .pc-advconv .pc-coord__actions button {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-height: 30px;
          border-color: rgba(125, 211, 252, 0.18);
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.055);
          color: var(--fg, #e7f7ff);
          font-size: 12px;
          font-weight: 720;
        }
        .pc-advconv .pc-coord__actions button:hover:not(:disabled) {
          border-color: rgba(var(--advconv-accent-rgb), 0.42);
          background: rgba(var(--advconv-accent-rgb), 0.16);
        }
        .pc-advconv__reply { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
        .pc-advconv__reply textarea {
          width: 100%; resize: vertical; min-height: 68px;
          background: var(--bg-popover, #0d1829); color: var(--fg, #e7f7ff);
          border: 1px solid rgba(125, 211, 252, 0.2);
          border-radius: 14px; padding: 10px 12px; font: inherit; font-size: 12px;
        }
        .pc-advconv__reply textarea:focus {
          outline: 2px solid rgba(var(--advconv-accent-rgb), 0.38);
          outline-offset: 2px;
        }
        @media (max-width: 980px) {
          .pc-advconv__hero { flex-direction: column; }
          .pc-advconv__metrics { min-width: 0; }
          .pc-advconv .pc-coord__split { grid-template-columns: 1fr; }
          .pc-advconv .pc-coord__rail { max-height: 42vh; }
        }
        @media (max-width: 640px) {
          .pc-advconv { padding: 10px; }
          .pc-advconv__hero { padding: 14px; border-radius: 16px; }
          .pc-advconv__metrics { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
