'use client';

/**
 * Delegates section in the operator panel.
 *
 * Lists the operator's delegated tasks (work_items of kind=task — the durable record
 * of each `operator:delegate`, see collapse-delegate-into-workitems-2026-06-04) with
 * title, age, turn-count, and click-to-resume. Resume opens a mini-transcript drawer
 * (the work_item's coord thread) + lets the user type a follow-up that gets dispatched
 * to /api/agent-mcp/delegate-chat with the same session id.
 *
 * Data source: GET /api/agent-mcp/delegates (backed by delegated-tasks over work_items),
 * refetched on mount, filter change, and delegation-lifecycle events. Per Plan v6
 * phase D — appears above the per-harness status section.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

interface DelegateTurn {
  ts: string;
  request: string;
  response: string;
}

interface DelegateSession {
  id: string;
  agentSessionId: string;
  title: string | null;
  summary: string | null;
  status: 'open' | 'archived';
  createdAt: string;
  lastActiveAt: string;
  turnCount: number;
  origin: string | null;
  transcript?: DelegateTurn[];
}

/**
 * "Running" heuristic for a delegate: no completed turns yet (turnCount === 0) AND
 * last activity within the last 5 minutes. turnCount is the work_item thread's
 * post_count — bumped only when a turn completes — so a fresh task with turnCount=0
 * and recent activity is in flight; an old turnCount=0 task is dead either way.
 */
function isLikelyRunning(d: { turnCount: number; lastActiveAt: string }): boolean {
  if (d.turnCount > 0) return false;
  const ageMs = Date.now() - new Date(d.lastActiveAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return false;
  return ageMs < 5 * 60_000;
}

function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

type DelegateFilter = 'open' | 'archived' | 'all';

export default function DelegatesSection() {
  const [filter, setFilter] = useState<DelegateFilter>('open');
  const [rows, setRows] = useState<DelegateSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedTranscript, setExpandedTranscript] = useState<DelegateTurn[]>([]);
  const [followText, setFollowText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const fetchRows = useCallback(async (f: DelegateFilter) => {
    try {
      const r = await fetch(`/api/agent-mcp/delegates?status=${f}&limit=50`);
      if (!r.ok) return;
      const data = await r.json();
      const sessions: DelegateSession[] = Array.isArray(data?.sessions) ? data.sessions : [];
      setRows(sessions);
    } catch { /* leave previous rows */ } finally {
      setLoading(false);
    }
  }, []);

  // Initial + on-filter-change load, plus a refetch whenever a delegation completes.
  useEffect(() => {
    let live = true;
    void (async () => { if (live) await fetchRows(filter); })();
    const onChange = () => { void fetchRows(filter); };
    window.addEventListener('operator:delegation-complete', onChange);
    window.addEventListener('operator:delegation-async-complete', onChange);
    return () => {
      live = false;
      window.removeEventListener('operator:delegation-complete', onChange);
      window.removeEventListener('operator:delegation-async-complete', onChange);
    };
  }, [filter, fetchRows]);

  async function archive(agentSessionId: string) {
    await fetch(`/api/agent-mcp/delegates?id=${encodeURIComponent(agentSessionId)}`, {
      method: 'DELETE',
    }).catch(() => {});
    void fetchRows(filter);
  }

  // Lazy-load the transcript (the work_item thread) when a row expands.
  async function loadTranscript(agentSessionId: string) {
    setExpandedTranscript([]);
    try {
      const r = await fetch(`/api/agent-mcp/delegates?id=${encodeURIComponent(agentSessionId)}`);
      if (!r.ok) return;
      const data = await r.json();
      const t: DelegateTurn[] = data?.session?.transcript ?? [];
      setExpandedTranscript(Array.isArray(t) ? t : []);
    } catch { /* ignore */ }
  }

  function toggleExpand(agentSessionId: string) {
    if (expandedId === agentSessionId) {
      setExpandedId(null);
      setExpandedTranscript([]);
    } else {
      setExpandedId(agentSessionId);
      void loadTranscript(agentSessionId);
    }
  }

  async function sendFollowUp(agentSessionId: string) {
    const text = followText.trim();
    if (!text || streaming) return;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setStreamText('');
    setStreaming(true);
    try {
      const url = `/api/agent-mcp/delegate-chat?request=${encodeURIComponent(text)}&sessionId=${encodeURIComponent(agentSessionId)}`;
      const r = await fetch(url, { signal: abortRef.current.signal });
      if (!r.ok || !r.body) {
        setStreamText(`error: HTTP ${r.status}`);
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const evt = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const eventLine = evt.split('\n').find((l) => l.startsWith('event:'));
          const dataLine = evt.split('\n').find((l) => l.startsWith('data:'));
          if (!eventLine || !dataLine) continue;
          const event = eventLine.slice(6).trim();
          const data = JSON.parse(dataLine.slice(5).trim());
          if (event === 'delta') setStreamText((s) => s + (data.text ?? ''));
          else if (event === 'done') {
            window.dispatchEvent(new CustomEvent('operator:delegation-complete', { detail: data }));
          } else if (event === 'error') {
            setStreamText((s) => s + `\n[error] ${data.message ?? 'unknown'}`);
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setStreamText((s) => s + `\n[exception] ${(e as Error).message}`);
      }
    } finally {
      setStreaming(false);
      setFollowText('');
      void fetchRows(filter);
      if (expandedId) void loadTranscript(expandedId);
    }
  }

  if (loading && rows.length === 0) return null;

  const filterLabels: Record<DelegateFilter, string> = {
    open: 'Open',
    archived: 'Archived',
    all: 'All',
  };
  const counterLabel = filter === 'open'
    ? `${rows.length} open`
    : filter === 'archived'
      ? `${rows.length} archived`
      : `${rows.length} total`;

  return (
    <section className="operator-section operator-delegates">
      <div className="operator-section__head">
        <span>Delegates</span>
        <em>{counterLabel}</em>
      </div>
      <div className="operator-delegates__filters" role="tablist" aria-label="Delegate filter">
        {(['open', 'archived', 'all'] as DelegateFilter[]).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className="operator-delegates__filter"
            data-active={filter === f}
          >
            {filterLabels[f]}
          </button>
        ))}
      </div>
      {!rows.length && (
        <p className="operator-delegates__empty">
          {filter === 'open' && 'No open delegates. Ask the operator to delegate something complex (file reads, planning) to spawn one.'}
          {filter === 'archived' && 'No archived delegates yet.'}
          {filter === 'all' && 'No delegates have been created in this workspace.'}
        </p>
      )}
      <ul role="list" className="operator-delegates__list">
        {rows.map((d) => {
          const isOpen = d.agentSessionId === expandedId;
          const running = isLikelyRunning(d);
          return (
            <li
              key={d.agentSessionId || d.id}
              className="operator-delegates__item"
              data-open={isOpen}
              data-running={running ? 'true' : 'false'}
            >
              <button
                type="button"
                className="operator-delegates__row"
                onClick={() => toggleExpand(d.agentSessionId)}
              >
                <span className="operator-delegates__title">
                  {running && (
                    <span
                      className="operator-delegates__spinner"
                      aria-label="running"
                      title="In flight — waiting on Claude"
                    />
                  )}
                  {d.title ?? '(untitled)'}
                </span>
                <span className="operator-delegates__meta">
                  {running ? 'running' : `${d.turnCount}t`} · {fmtAge(d.lastActiveAt)}
                </span>
              </button>
              {isOpen && (
                <div className="operator-delegates__body">
                  {d.summary && (
                    <p className="operator-delegates__summary">{d.summary}</p>
                  )}
                  {expandedTranscript.length > 0 && (
                    <div className="operator-delegates__transcript" role="log" aria-label="Delegate transcript">
                      {expandedTranscript.map((turn, i) => (
                        <div key={`${turn.ts}-${i}`} className="operator-delegates__turn">
                          <div className="operator-delegates__turn-user">
                            <span className="operator-delegates__turn-label">You</span>
                            <span className="operator-delegates__turn-time">{fmtAge(turn.ts)}</span>
                            <p>{turn.request}</p>
                          </div>
                          <div className="operator-delegates__turn-agent">
                            <span className="operator-delegates__turn-label">Delegate</span>
                            <p>{turn.response}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {streamText && (
                    <pre className="operator-delegates__stream">{streamText}</pre>
                  )}
                  <div className="operator-delegates__followup">
                    <textarea
                      value={followText}
                      onChange={(e) => setFollowText(e.target.value)}
                      placeholder="Ask a follow-up…"
                      rows={2}
                      disabled={streaming}
                    />
                    <div className="operator-delegates__actions">
                      <button
                        type="button"
                        onClick={() => void sendFollowUp(d.agentSessionId)}
                        disabled={!followText.trim() || streaming}
                      >
                        {streaming ? 'Sending…' : 'Send'}
                      </button>
                      <button
                        type="button"
                        className="operator-delegates__archive"
                        onClick={() => void archive(d.agentSessionId)}
                        disabled={streaming}
                      >
                        Archive
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
