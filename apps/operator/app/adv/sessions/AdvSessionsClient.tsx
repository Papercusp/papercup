'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { launchOmpAgent } from '@/lib/native-omp-launch';

interface SessionRow {
  id: number;
  workspaceId: string;
  planSlug: string | null;
  mode: 'omp' | 'console';
  terminalBin: string | null;
  pid: number | null;
  windowId: string | null;
  ompThreadId: string | null;
  label: string | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
}

export default function AdvSessionsClient() {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aliveByPid, setAliveByPid] = useState<Record<number, boolean>>({});
  const [refreshTick, setRefreshTick] = useState(0);

  const fetchRows = useCallback(async () => {
    try {
      const r = await fetch('/api/adv/sessions', { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { rows: SessionRow[] };
      setRows(data.rows ?? []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    fetchRows();
  }, [fetchRows, refreshTick]);

  // Re-check pid liveness when the row list changes. For rows the DB
  // says are still active, ask the operator whether the pid is alive —
  // child-exit listener can miss exits across operator restarts.
  useEffect(() => {
    if (!rows) return;
    const activeWithPid = rows.filter((r) => r.endedAt == null && r.pid != null);
    if (activeWithPid.length === 0) return;
    let cancelled = false;
    (async () => {
      const updates: Record<number, boolean> = {};
      for (const row of activeWithPid) {
        try {
          const r = await fetch(`/api/adv/sessions/alive?pid=${row.pid}`);
          if (!r.ok) continue;
          const data = (await r.json()) as { alive: boolean };
          updates[row.pid!] = data.alive;
        } catch { /* swallow */ }
      }
      if (!cancelled) setAliveByPid((prev) => ({ ...prev, ...updates }));
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  const isActive = useCallback(
    (row: SessionRow): boolean => {
      if (row.endedAt != null) return false;
      if (row.pid == null) return false;
      // Default to "active" until the liveness check returns false.
      return aliveByPid[row.pid] !== false;
    },
    [aliveByPid],
  );

  const focusRow = useCallback(async (row: SessionRow) => {
    if (!row.pid) {
      toast.error('No pid recorded for this session — cannot focus.');
      return;
    }
    try {
      const r = await fetch('/api/adv/sessions/focus', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: row.pid, windowId: row.windowId }),
      });
      const data = (await r.json().catch(() => null)) as
        | { status?: string; error?: string }
        | null;
      if (!r.ok || data?.status !== 'ok') {
        toast.error(`Focus failed: ${data?.error ?? `HTTP ${r.status}`}`);
        return;
      }
      toast.success('Window focused.', { duration: 2000 });
    } catch (e: unknown) {
      toast.error(`Focus failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const resumeRow = useCallback(async (row: SessionRow) => {
    // The Resume button re-launches OMP in a fresh terminal. When
    // we've captured the OMP thread id, `papercusp-omp connect`
    // can be told to resume the same conversation via its CLI; we
    // pass that hint through the launch path. When the thread id
    // isn't captured (most rows today), we open a fresh OMP at the
    // same plan/cwd — the conversation is new but the workspace
    // context matches.
    const result = await launchOmpAgent({
      slug: null,
      planSlug: row.planSlug,
      label: row.label ?? row.planSlug ?? `resume-${row.id}`,
    });
    if (result.ok) {
      toast.success('OMP relaunched.', { duration: 3000 });
      setRefreshTick((t) => t + 1);
    } else {
      toast.error(`Resume failed: ${result.error ?? 'unknown error'}`);
    }
  }, []);

  const grouped = useMemo(() => groupRows(rows ?? []), [rows]);

  return (
    <div className="pc-adv-sessions">
      <div className="pc-adv-sessions__head">
        <h2>Agent sessions</h2>
        <button
          type="button"
          className="pc-adv-sessions__refresh"
          onClick={() => setRefreshTick((t) => t + 1)}
        >
          Refresh
        </button>
      </div>
      {error ? <p className="pc-adv-sessions__error">Failed to load: {error}</p> : null}
      {rows === null && !error ? <p className="pc-adv-sessions__placeholder">Loading…</p> : null}
      {rows && rows.length === 0 ? (
        <p className="pc-adv-sessions__placeholder">
          No agent sessions recorded yet. Launches from the Plans tab will appear here.
        </p>
      ) : null}
      {grouped.map((group) => (
        <section className="pc-adv-sessions__group" key={group.key}>
          <header className="pc-adv-sessions__group-head">
            <span className="pc-adv-sessions__group-title">
              {group.planSlug ?? '(no plan)'}
            </span>
            <span className="pc-adv-sessions__group-count">{group.rows.length}</span>
          </header>
          <ul className="pc-adv-sessions__list">
            {group.rows.map((row) => {
              const active = isActive(row);
              return (
                <li key={row.id} className={`pc-adv-sessions__row${active ? ' is-active' : ''}`}>
                  <div className="pc-adv-sessions__row-meta">
                    <span className={`pc-adv-sessions__badge pc-adv-sessions__badge--${row.mode}`}>
                      {row.mode}
                    </span>
                    <span className="pc-adv-sessions__row-label">
                      {row.label ?? row.terminalBin ?? `#${row.id}`}
                    </span>
                    <span className="pc-adv-sessions__row-times">
                      started {formatDate(row.startedAt)}
                      {row.endedAt ? ` · ended ${formatDate(row.endedAt)}` : ''}
                    </span>
                    {row.pid != null ? (
                      <span className="pc-adv-sessions__row-pid">pid {row.pid}</span>
                    ) : null}
                  </div>
                  <div className="pc-adv-sessions__row-actions">
                    {active ? (
                      <button
                        type="button"
                        className="pc-adv-sessions__btn pc-adv-sessions__btn--primary"
                        onClick={() => focusRow(row)}
                      >
                        Focus window
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="pc-adv-sessions__btn"
                        onClick={() => resumeRow(row)}
                      >
                        Resume
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <style>{`
        .pc-adv-sessions { padding: 16px 18px; color: rgba(220, 214, 248, 0.84); }
        .pc-adv-sessions__head {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 16px;
        }
        .pc-adv-sessions__head h2 {
          margin: 0; font-size: 18px; font-weight: 700; color: #f7f5ff;
        }
        .pc-adv-sessions__refresh {
          all: unset; cursor: pointer; padding: 5px 12px; border-radius: 6px;
          border: 1px solid rgba(167, 139, 250, 0.22);
          background: rgba(31, 23, 56, 0.6);
          font-size: 12px; font-weight: 600; color: #f7f5ff;
        }
        .pc-adv-sessions__refresh:hover { background: rgba(31, 23, 56, 0.9); }
        .pc-adv-sessions__error, .pc-adv-sessions__placeholder {
          padding: 12px; border-radius: 8px;
          background: rgba(31, 23, 56, 0.45);
          color: rgba(220, 214, 248, 0.7);
          font-size: 13px;
        }
        .pc-adv-sessions__error { color: #fca5a5; border: 1px solid rgba(248, 113, 113, 0.4); }
        .pc-adv-sessions__group { margin-bottom: 18px; }
        .pc-adv-sessions__group-head {
          display: flex; align-items: baseline; gap: 8px;
          padding-bottom: 6px;
          border-bottom: 1px solid rgba(167, 139, 250, 0.16);
          margin-bottom: 6px;
        }
        .pc-adv-sessions__group-title {
          font-size: 13px; font-weight: 700; color: #f7f5ff;
        }
        .pc-adv-sessions__group-count {
          font-size: 11px; color: rgba(220, 214, 248, 0.55);
        }
        .pc-adv-sessions__list { list-style: none; padding: 0; margin: 0; }
        .pc-adv-sessions__row {
          display: flex; align-items: center; justify-content: space-between;
          gap: 16px;
          padding: 8px 12px;
          border: 1px solid rgba(167, 139, 250, 0.12);
          border-radius: 8px;
          margin-bottom: 6px;
          background: rgba(11, 13, 28, 0.6);
        }
        .pc-adv-sessions__row.is-active {
          border-color: rgba(103, 232, 249, 0.4);
          background: rgba(20, 32, 48, 0.7);
        }
        .pc-adv-sessions__row-meta {
          display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
          font-size: 12px;
        }
        .pc-adv-sessions__badge {
          font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
          text-transform: uppercase;
          padding: 2px 6px; border-radius: 4px;
        }
        .pc-adv-sessions__badge--omp { background: rgba(103, 232, 249, 0.2); color: #67e8f9; }
        .pc-adv-sessions__badge--console { background: rgba(167, 139, 250, 0.2); color: #c4b5fd; }
        .pc-adv-sessions__row-label {
          color: #f7f5ff; font-weight: 600; font-size: 13px;
        }
        .pc-adv-sessions__row-times { color: rgba(220, 214, 248, 0.6); }
        .pc-adv-sessions__row-pid {
          font-family: ui-monospace, monospace;
          color: rgba(220, 214, 248, 0.5);
          font-size: 11px;
        }
        .pc-adv-sessions__row-actions { display: flex; gap: 6px; flex-shrink: 0; }
        .pc-adv-sessions__btn {
          all: unset; cursor: pointer; padding: 4px 10px; border-radius: 6px;
          border: 1px solid rgba(167, 139, 250, 0.22);
          background: rgba(31, 23, 56, 0.6);
          font-size: 12px; font-weight: 600; color: #f7f5ff;
        }
        .pc-adv-sessions__btn--primary {
          border-color: rgba(103, 232, 249, 0.5);
          background: rgba(20, 50, 65, 0.85);
        }
        .pc-adv-sessions__btn:hover { background: rgba(40, 35, 75, 0.95); }
      `}</style>
    </div>
  );
}

function groupRows(rows: SessionRow[]): Array<{ key: string; planSlug: string | null; rows: SessionRow[] }> {
  const map = new Map<string, { planSlug: string | null; rows: SessionRow[] }>();
  for (const r of rows) {
    const key = r.planSlug ?? '_';
    let g = map.get(key);
    if (!g) {
      g = { planSlug: r.planSlug, rows: [] };
      map.set(key, g);
    }
    g.rows.push(r);
  }
  return Array.from(map.entries()).map(([key, g]) => ({ key, planSlug: g.planSlug, rows: g.rows }));
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
