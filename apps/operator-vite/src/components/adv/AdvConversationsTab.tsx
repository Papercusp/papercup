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
      <style>{`
        .pc-advconv {
          --advconv-accent: var(--accent, #7dd3fc);
          --advconv-accent-strong: var(--accent-strong, #7dd3fc);
          height: 100%;
          min-height: 0;
        }
        .pc-advconv .pc-coord__chip {
          transition: background-color 120ms, border-color 120ms, color 120ms;
        }
        .pc-advconv .pc-coord__chip {
          border-color: var(--border, rgba(125, 211, 252, 0.18));
          color: var(--fg-mute, #7f9bb4);
        }
        .pc-advconv .pc-coord__chip:hover:not(:disabled) {
          border-color: color-mix(in oklab, var(--advconv-accent), transparent 62%);
          background: color-mix(in oklab, var(--advconv-accent), transparent 88%);
          color: var(--fg, #e7f7ff);
        }
        .pc-advconv .pc-coord__chip.is-active {
          border-color: color-mix(in oklab, var(--advconv-accent), transparent 54%);
          background: color-mix(in oklab, var(--advconv-accent), transparent 82%);
          color: var(--fg, #e7f7ff);
        }
        .pc-advconv__rowtags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; grid-column: 1 / -1; }
        .pc-advconv__refresh { margin-left: auto; display: inline-flex; align-items: center; }
        .pc-advconv__accepted {
          border-left: 2px solid rgba(34, 197, 94, 0.6);
          padding-left: 8px;
        }
        .pc-advconv__linked {
          display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
          font-size: 12px; color: color-mix(in oklab, var(--advconv-accent-strong), white 8%); margin: 4px 0;
        }
        .pc-advconv__reply { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
        .pc-advconv__reply textarea {
          width: 100%; resize: vertical; min-height: 38px;
          background: var(--bg-popover, #0d1829); color: var(--fg, #e7f7ff);
          border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.32));
          border-radius: 8px; padding: 7px 9px; font: inherit; font-size: 12px;
        }
        .pc-advconv__reply textarea:focus {
          outline: 2px solid color-mix(in oklab, var(--advconv-accent), transparent 66%);
          outline-offset: 2px;
        }
      `}</style>
    </div>
  );
}
