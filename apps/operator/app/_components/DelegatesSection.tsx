'use client';

/**
 * Delegates section in the operator panel.
 *
 * Lists open delegates (agent CLI sessions the operator has spawned —
 * `omp -p` via Meridian by default, or `claude -p` when AGENT_BACKEND=claude-code)
 * with title, age, turn-count, and click-to-resume. Resume opens a
 * mini-transcript drawer + lets the user type a follow-up that gets
 * dispatched to /api/agent-mcp/delegate-chat with the same session id.
 *
 * Per Plan v6 phase D — appears above the per-harness status section.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSyncQuery } from '@restart/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';

interface DelegateTurn {
  ts: string;
  request: string;
  response: string;
}

interface DelegateRow {
  id: number;
  claudeSessionId: string;
  title: string | null;
  summary: string | null;
  status: 'open' | 'archived';
  lastActiveAt: string;
  turnCount: number;
  origin: string;
  initiatorMsg: string | null;
  transcript?: DelegateTurn[];
}

interface DelegateZeroRow {
  id: number;
  workspace: string;
  claudeSessionId: string;
  title: string | null;
  summary: string | null;
  status: string;
  createdAt: number;
  lastActiveAt: number;
  turnCount: number;
  origin: string;
  initiatorMsg: string | null;
  transcript: DelegateTurn[];
}

interface ListResponse {
  sessions: DelegateRow[];
}

/**
 * "Running" heuristic for a delegate: no completed turns yet
 * (turnCount === 0) AND last activity within the last 5 minutes.
 *
 * The schema doesn't have an explicit "running" flag — turnCount
 * gets bumped only when a turn completes. So a fresh row with
 * turnCount=0 and recent lastActiveAt is in flight; an old row
 * with turnCount=0 either errored before completion or was never
 * driven (and is dead either way).
 *
 * 5min is generous enough for long file-reads / multi-step plans
 * but tight enough that an old failed delegate doesn't keep
 * spinning forever in the UI.
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [followText, setFollowText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const workspaceId = useWorkspaceId();

  // Delegates stream from harness_shared.delegates via Zero. Filter values
  // 'open' / 'archived' map directly to the status column; 'all' is a special
  // case the named query doesn't support directly so we fan out two queries.
  const { data: openRows, loading: openLoading } = useSyncQuery<DelegateZeroRow>({
    queryName: 'delegates.byWorkspace',
    args: { workspace: workspaceId, status: 'open', limit: 50 },
    enabled: filter === 'open' || filter === 'all',
  });
  const { data: archivedRows, loading: archivedLoading } = useSyncQuery<DelegateZeroRow>({
    queryName: 'delegates.byWorkspace',
    args: { workspace: workspaceId, status: 'archived', limit: 50 },
    enabled: filter === 'archived' || filter === 'all',
  });

  const loading = (filter === 'open' && openLoading)
    || (filter === 'archived' && archivedLoading)
    || (filter === 'all' && (openLoading || archivedLoading));

  const rows: DelegateRow[] = useMemo(() => {
    const merged: DelegateZeroRow[] = [];
    if ((filter === 'open' || filter === 'all') && Array.isArray(openRows)) merged.push(...openRows);
    if ((filter === 'archived' || filter === 'all') && Array.isArray(archivedRows)) merged.push(...archivedRows);
    return merged
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .map((r) => ({
        id: r.id,
        claudeSessionId: r.claudeSessionId,
        title: r.title,
        summary: r.summary,
        status: (r.status === 'archived' ? 'archived' : 'open') as DelegateRow['status'],
        lastActiveAt: r.lastActiveAt ? new Date(r.lastActiveAt).toISOString() : '',
        turnCount: r.turnCount,
        origin: r.origin,
        initiatorMsg: r.initiatorMsg,
        transcript: Array.isArray(r.transcript) ? r.transcript : undefined,
      }));
  }, [openRows, archivedRows, filter]);

  // Watcher → Zero handles refresh on archive/delegation-complete; the manual
  // refresh stub stays for legacy callers in this file.
  const refresh = async (_f?: DelegateFilter) => {};

  async function archive(claudeSessionId: string) {
    await fetch(`/api/agent-mcp/delegates?id=${encodeURIComponent(claudeSessionId)}`, {
      method: 'DELETE',
    }).catch(() => {});
  }

  async function sendFollowUp(claudeSessionId: string) {
    const text = followText.trim();
    if (!text || streaming) return;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setStreamText('');
    setStreaming(true);
    try {
      const url = `/api/agent-mcp/delegate-chat?request=${encodeURIComponent(text)}&sessionId=${encodeURIComponent(claudeSessionId)}`;
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
      void refresh();
    }
  }

  const expanded = useMemo(
    () => rows.find((r) => r.claudeSessionId === expandedId) ?? null,
    [rows, expandedId],
  );

  // delegates.byWorkspace already returns the full row including the
  // transcript JSONB. Avg transcript size measured at ~1.6 KB / max 4 KB
  // across current data — well under any threshold for eager
  // subscription. Read the expanded row directly from the cached list
  // instead of refetching.
  const expandedDetail = useMemo<DelegateRow | null>(() => {
    if (!expandedId) return null;
    return rows.find((r) => String(r.id) === String(expandedId)) ?? null;
  }, [expandedId, rows]);

  if (loading) return null;

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
          const isOpen = d.claudeSessionId === expandedId;
          const running = isLikelyRunning(d);
          return (
            <li
              key={d.claudeSessionId}
              className="operator-delegates__item"
              data-open={isOpen}
              data-running={running ? 'true' : 'false'}
            >
              <button
                type="button"
                className="operator-delegates__row"
                onClick={() => setExpandedId(isOpen ? null : d.claudeSessionId)}
              >
                <span className="operator-delegates__title">
                  {running && (
                    <span
                      className="operator-delegates__spinner"
                      aria-label="running"
                      title="In flight — waiting on Claude"
                    />
                  )}
                  {d.title ?? d.initiatorMsg?.slice(0, 60) ?? '(untitled)'}
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
                  {expandedDetail?.transcript && expandedDetail.transcript.length > 0 && (
                    <div className="operator-delegates__transcript" role="log" aria-label="Delegate transcript">
                      {expandedDetail.transcript.map((turn, i) => (
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
                        onClick={() => void sendFollowUp(d.claudeSessionId)}
                        disabled={!followText.trim() || streaming}
                      >
                        {streaming ? 'Sending…' : 'Send'}
                      </button>
                      <button
                        type="button"
                        className="operator-delegates__archive"
                        onClick={() => void archive(d.claudeSessionId)}
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
