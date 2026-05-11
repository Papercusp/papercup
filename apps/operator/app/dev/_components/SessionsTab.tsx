'use client';

import { Fragment, useEffect, useState, useCallback } from 'react';

interface Entry {
  spawn_id: string;
  parent_spawn_id: string | null;
  workspace_id: string;
  harness_slug: string | null;
  role: string | null;
  run_id: string | null;
  started_at: string;
  ended_at: string;
  tool_count: number;
  error_count: number;
  total_duration_ms: number;
}

interface Detail {
  spawn_id: string;
  agent: {
    parent_role: string | null;
    child_role: string | null;
    feature_id: string | null;
    chunk_id: string | null;
    status: string | null;
    duration_ms: number | null;
    exit_code: number | null;
    output_tail: string | null;
    error_message: string | null;
  } | null;
  invocations: Array<{
    id: string;
    tool_name: string;
    invoked_at: string;
    duration_ms: number | null;
    status: string;
    error_message: string | null;
    args_json: unknown;
  }>;
  children: Array<{
    spawn_id: string;
    child_role: string | null;
    status: string | null;
    tool_count: number;
    error_count: number;
  }>;
  related_chats: Array<{ id: string; role: string; title: string | null; updated_at: string }>;
}

import type { RerunContext } from '../page';

interface Props {
  workspaceIds: string[] | null;
  onRerun: (ctx: RerunContext) => void;
}

function fmtRelTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

const CTX = new URLSearchParams({
  workspace: 'default',
  role: 'architect',
  run: 'dev-page',
  spawn: 'dev-page',
});

export default function SessionsTab({ workspaceIds, onRerun }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState(24);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Detail | null>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/agent-tools/dev/sessions?${CTX}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceIds, hours, limit: 200 }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        const parsed = JSON.parse(d.content[0].text);
        if (cancelled) return;
        setEntries(parsed.entries ?? []);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceIds, hours]);

  async function toggleExpand(spawnId: string) {
    if (expanded === spawnId) {
      setExpanded(null);
      return;
    }
    setExpanded(spawnId);
    if (!(spawnId in details)) {
      setDetailLoading((d) => ({ ...d, [spawnId]: true }));
      try {
        const r = await fetch(`/api/agent-tools/dev/session_detail?${CTX}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ spawnId }),
        });
        const d = await r.json();
        const parsed = JSON.parse(d.content[0].text);
        setDetails((m) => ({ ...m, [spawnId]: parsed.error ? null : parsed }));
      } catch {
        setDetails((m) => ({ ...m, [spawnId]: null }));
      } finally {
        setDetailLoading((d) => ({ ...d, [spawnId]: false }));
      }
    }
  }

  return (
    <div className="pc-dev-tab-body">
      <header className="pc-dev-tab-header">
        <h2>Sessions</h2>
        <span className="pc-dev-muted">{entries.length} spawns</span>
        <label className="pc-dev-muted">
          window
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            className="pc-dev-input pc-dev-input-inline"
          >
            <option value={1}>1h</option>
            <option value={6}>6h</option>
            <option value={24}>24h</option>
            <option value={168}>7d</option>
            <option value={720}>30d</option>
          </select>
        </label>
      </header>
      {loading && <div className="pc-dev-muted">loading…</div>}
      {error && <div className="pc-dev-api-err">{error}</div>}
      {!loading && !error && (
        <table className="pc-dev-table">
          <thead>
            <tr>
              <th></th>
              <th>Spawn</th>
              <th>Started</th>
              <th>Workspace</th>
              <th>Harness</th>
              <th>Role</th>
              <th>Tools</th>
              <th>Errors</th>
              <th>Duration</th>
              <th>Parent</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const isOpen = expanded === e.spawn_id;
              const detail = details[e.spawn_id];
              return (
                <Fragment key={e.spawn_id}>
                  <tr
                    className="pc-dev-row-expand"
                    onClick={() => toggleExpand(e.spawn_id)}
                  >
                    <td className="pc-dev-muted">{isOpen ? '▾' : '▸'}</td>
                    <td className="pc-dev-slug" title={e.spawn_id}>
                      {e.spawn_id.slice(0, 12)}…
                    </td>
                    <td className="pc-dev-muted" title={e.started_at}>
                      {fmtRelTime(e.started_at)}
                    </td>
                    <td className="pc-dev-muted">{e.workspace_id}</td>
                    <td>{e.harness_slug ?? '—'}</td>
                    <td className="pc-dev-muted">{e.role ?? '—'}</td>
                    <td>{e.tool_count}</td>
                    <td className={e.error_count ? 'pc-dev-api-err' : ''}>
                      {e.error_count > 0 ? e.error_count : ''}
                    </td>
                    <td className="pc-dev-muted">{fmtDuration(e.total_duration_ms)}</td>
                    <td className="pc-dev-muted" title={e.parent_spawn_id ?? ''}>
                      {e.parent_spawn_id ? `${e.parent_spawn_id.slice(0, 8)}…` : '—'}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="pc-dev-detail-row">
                      <td colSpan={10}>
                        {detailLoading[e.spawn_id] && (
                          <div className="pc-dev-muted">loading detail…</div>
                        )}
                        {!detailLoading[e.spawn_id] && !detail && (
                          <div className="pc-dev-muted">no detail available</div>
                        )}
                        {detail && (
                          <DetailPanel
                            detail={detail}
                            entry={e}
                            onRerun={onRerun}
                          />
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface OmpSession {
  id: string;
  filePath: string;
  cwd: string;
  timestamp: string;
  title: string;
  matchKind: 'exact-cwd' | 'cwd-prefix' | 'time-only';
  timeDriftMs: number;
}

function DetailPanel({
  detail,
  entry,
  onRerun,
}: {
  detail: Detail;
  entry: Entry;
  onRerun: (ctx: RerunContext) => void;
}) {
  const [omp, setOmp] = useState<OmpSession | null | 'loading' | 'none'>('loading');

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      workspace: 'default',
      role: 'architect',
      run: 'dev-page',
      spawn: 'dev-page',
    });
    fetch(`/api/agent-tools/dev/omp_session?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spawnId: entry.spawn_id, mode: 'find' }),
    })
      .then(async (r) => {
        if (!r.ok) {
          if (!cancelled) setOmp('none');
          return;
        }
        const d = await r.json();
        const parsed = JSON.parse(d.content[0].text);
        if (cancelled) return;
        if (parsed && parsed.id && parsed.filePath) setOmp(parsed as OmpSession);
        else setOmp('none');
      })
      .catch(() => {
        if (!cancelled) setOmp('none');
      });
    return () => {
      cancelled = true;
    };
  }, [entry.spawn_id]);
  return (
    <div className="pc-dev-session-detail">
      {detail.agent && (
        <section>
          <h4 className="pc-dev-rail-h">Agent</h4>
          <div className="pc-dev-kv">
            <span>parent_role</span>
            <span>{detail.agent.parent_role ?? '—'}</span>
            <span>child_role</span>
            <span>{detail.agent.child_role ?? '—'}</span>
            <span>feature</span>
            <span>{detail.agent.feature_id ?? '—'}</span>
            <span>chunk</span>
            <span>{detail.agent.chunk_id ?? '—'}</span>
            <span>status</span>
            <span
              className={
                detail.agent.status === 'failed' ? 'pc-dev-api-err' : 'pc-dev-ok'
              }
            >
              {detail.agent.status ?? '—'}
            </span>
            <span>exit_code</span>
            <span
              className={
                detail.agent.exit_code !== null && detail.agent.exit_code !== 0
                  ? 'pc-dev-api-err'
                  : ''
              }
            >
              {detail.agent.exit_code ?? '—'}
            </span>
          </div>
          {detail.agent.error_message && (
            <pre className="pc-dev-pre pc-dev-api-err">
              {detail.agent.error_message}
            </pre>
          )}
          {detail.agent.output_tail && (
            <pre className="pc-dev-pre">{detail.agent.output_tail.slice(-2000)}</pre>
          )}
        </section>
      )}

      <section>
        <h4 className="pc-dev-rail-h">
          Tool invocations <span className="pc-dev-muted">{detail.invocations.length}</span>
        </h4>
        {detail.invocations.length === 0 && <div className="pc-dev-muted">none</div>}
        {detail.invocations.length > 0 && (
          <table className="pc-dev-table pc-dev-table-inner">
            <thead>
              <tr>
                <th>At</th>
                <th>Tool</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Error</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {detail.invocations.map((i) => (
                <tr key={i.id}>
                  <td className="pc-dev-muted">{fmtRelTime(i.invoked_at)}</td>
                  <td className="pc-dev-slug">{i.tool_name}</td>
                  <td className={i.status !== 'ok' ? 'pc-dev-api-err' : 'pc-dev-ok'}>
                    {i.status}
                  </td>
                  <td className="pc-dev-muted">
                    {i.duration_ms != null ? fmtDuration(i.duration_ms) : '—'}
                  </td>
                  <td className="pc-dev-muted pc-dev-details" title={i.error_message ?? ''}>
                    {i.error_message ?? '—'}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="pc-dev-btn-mini"
                      title="Open in API tab with this tool + spawn context"
                      onClick={() =>
                        onRerun({
                          toolName: i.tool_name,
                          workspace: entry.workspace_id,
                          harness: entry.harness_slug ?? '',
                          role: entry.role ?? 'architect',
                          run: entry.run_id ?? 'dev-page',
                          spawn: entry.spawn_id,
                          args:
                            i.args_json && typeof i.args_json === 'object' && !('_truncated' in (i.args_json as Record<string, unknown>))
                              ? (i.args_json as Record<string, unknown>)
                              : undefined,
                        })
                      }
                    >
                      ↗
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {detail.children.length > 0 && (
        <section>
          <h4 className="pc-dev-rail-h">
            Child spawns <span className="pc-dev-muted">{detail.children.length}</span>
          </h4>
          <table className="pc-dev-table pc-dev-table-inner">
            <thead>
              <tr>
                <th>Spawn</th>
                <th>Role</th>
                <th>Status</th>
                <th>Tools</th>
                <th>Errors</th>
              </tr>
            </thead>
            <tbody>
              {detail.children.map((c) => (
                <tr key={c.spawn_id}>
                  <td className="pc-dev-slug" title={c.spawn_id}>
                    {c.spawn_id.slice(0, 12)}…
                  </td>
                  <td className="pc-dev-muted">{c.child_role ?? '—'}</td>
                  <td className={c.status === 'failed' ? 'pc-dev-api-err' : 'pc-dev-ok'}>
                    {c.status ?? '—'}
                  </td>
                  <td>{c.tool_count}</td>
                  <td className={c.error_count ? 'pc-dev-api-err' : ''}>
                    {c.error_count > 0 ? c.error_count : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {detail.related_chats.length > 0 && (
        <section>
          <h4 className="pc-dev-rail-h">
            Related chats <span className="pc-dev-muted">{detail.related_chats.length}</span>
          </h4>
          <ul className="pc-dev-chats">
            {detail.related_chats.map((c) => (
              <li key={c.id}>
                <span className="pc-dev-slug">{c.role}</span>{' '}
                <span>{c.title ?? '(untitled)'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <OmpSection ompState={omp} spawnId={entry.spawn_id} />
    </div>
  );
}

function OmpSection({
  ompState,
  spawnId,
}: {
  ompState: OmpSession | null | 'loading' | 'none';
  spawnId: string;
}) {
  const [transcript, setTranscript] = useState<{
    turns: Array<Record<string, unknown>>;
    totalLines: number;
    truncated: boolean;
  } | null>(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);

  const loadTranscript = useCallback(async () => {
    if (ompState === 'loading' || ompState === 'none' || ompState === null) return;
    setLoadingTranscript(true);
    setTranscriptError(null);
    try {
      const params = new URLSearchParams({
        workspace: 'default',
        role: 'architect',
        run: 'dev-page',
        spawn: 'dev-page',
      });
      const r = await fetch(`/api/agent-tools/dev/omp_session?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spawnId, mode: 'read', limit: 200 }),
      });
      const d = await r.json();
      const parsed = JSON.parse(d.content[0].text);
      if (parsed?.error) {
        setTranscriptError(parsed.error);
      } else {
        setTranscript({
          turns: parsed.turns ?? [],
          totalLines: parsed.totalLines ?? 0,
          truncated: !!parsed.truncated,
        });
      }
    } catch (err) {
      setTranscriptError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingTranscript(false);
    }
  }, [ompState, spawnId]);

  if (ompState === 'loading') {
    return (
      <section>
        <h4 className="pc-dev-rail-h">omp transcript</h4>
        <div className="pc-dev-muted">searching session files…</div>
      </section>
    );
  }
  if (ompState === 'none' || !ompState || typeof ompState === 'string') {
    return (
      <section>
        <h4 className="pc-dev-rail-h">omp transcript</h4>
        <div className="pc-dev-muted">no matching session file</div>
      </section>
    );
  }

  return (
    <section>
      <h4 className="pc-dev-rail-h">
        omp transcript{' '}
        <span className="pc-dev-muted">
          ({ompState.matchKind} match, drift {Math.round(ompState.timeDriftMs / 1000)}s)
        </span>
      </h4>
      <div className="pc-dev-kv">
        <span>id</span>
        <span className="pc-dev-slug">{ompState.id.slice(0, 24)}…</span>
        <span>cwd</span>
        <span className="pc-dev-muted">{ompState.cwd}</span>
        <span>file</span>
        <span className="pc-dev-muted pc-dev-details" title={ompState.filePath}>
          {ompState.filePath}
        </span>
        <span>title</span>
        <span>{ompState.title.slice(0, 100) || '—'}</span>
      </div>
      {!transcript && !loadingTranscript && (
        <button type="button" className="pc-dev-btn-mini" onClick={loadTranscript}>
          load transcript
        </button>
      )}
      {loadingTranscript && <div className="pc-dev-muted">loading…</div>}
      {transcriptError && <div className="pc-dev-api-err">{transcriptError}</div>}
      {transcript && (
        <details className="pc-dev-transcript">
          <summary>
            {transcript.turns.length} turns
            {transcript.truncated ? ` of ${transcript.totalLines} (truncated)` : ''}
          </summary>
          <pre className="pc-dev-pre">
            {transcript.turns
              .map((t) => `[${t.type}] ${JSON.stringify(t).slice(0, 200)}`)
              .join('\n')}
          </pre>
        </details>
      )}
    </section>
  );
}
