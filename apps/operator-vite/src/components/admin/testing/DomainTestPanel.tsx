/**
 * <DomainTestPanel> — shared shell for every /admin/testing subtab.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-004.
 *
 * Three regions:
 *   1. Header — domain label + description + total file count
 *   2. Health strip — reserved slot; populated in P-033 (test-related
 *      signals only: last full-suite duration, last failure, flaky rate)
 *   3. Sections — file lists per section
 *
 * Existing 8 tabs mount their bespoke React inside this shell via the
 * `customId` lookup table the SPA owns (P-006a). When `customNode` is
 * passed, the sections list is replaced wholesale.
 *
 * P-004 ships the file-list region only. Run button per file lands in
 * P-016; status chip in P-013; output drawer in P-017.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useQueryState } from 'nuqs';
import './domain-panel.css';

interface FileHit {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

type TestRunnerWire =
  | { kind: 'vitest'; filePath: string }
  | { kind: 'playwright'; filePath: string }
  | { kind: 'cargo'; crate: string; test?: string }
  | { kind: 'node'; cmd: string; args?: string[]; label?: string }
  | { kind: 'shell'; cmd: string; args?: string[]; label?: string }
  | { kind: 'admin-suite'; suiteId: string };

interface ResolvedSection {
  id: string;
  label: string;
  description?: string;
  files: FileHit[];
  runners: TestRunnerWire[];
}

interface DomainDetail {
  id: string;
  label: string;
  description: string;
  tier: 'quick' | 'domain' | 'surface';
  sections: ResolvedSection[];
  totalFiles: number;
}

// P-013: status chip data per file from /api/admin/testing/file-status.
type ChipStatus = 'pass' | 'fail' | 'skip' | 'cancelled' | 'error' | 'running';

interface FileStatusEntry {
  status: ChipStatus;
  durationMs: number | null;
  finishedAt: string | null;
  source: 'ci' | 'local' | 'admin-ui';
  branch: string | null;
  stale: boolean;
}

interface FileStatusResponse {
  domainId: string;
  branch: string | null;
  commit: string | null;
  statuses: Record<string, FileStatusEntry>;
}

interface HealthStripData {
  domainId: string;
  branch: string | null;
  lastSuiteDurationMs: number | null;
  lastFailureFinishedAt: string | null;
  flakyFileCount: number;
  totalFilesTracked: number;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

const CHIP_LABEL: Record<ChipStatus, string> = {
  pass: '✓',
  fail: '✗',
  skip: '·',
  cancelled: '⊘',
  error: '!',
  running: '…',
};

function chipClass(s: ChipStatus, stale: boolean): string {
  return `pc-dtp-chip pc-dtp-chip-${s}${stale ? ' is-stale' : ''}`;
}

function runnerLabel(r: TestRunnerWire): string {
  if (r.kind === 'node' || r.kind === 'shell') {
    return r.label ?? `${r.kind} ${r.cmd}`;
  }
  if (r.kind === 'vitest' || r.kind === 'playwright') {
    return `${r.kind} ${r.filePath}`;
  }
  if (r.kind === 'cargo') {
    return r.test ? `cargo ${r.crate}::${r.test}` : `cargo ${r.crate}`;
  }
  return `suite ${r.suiteId}`;
}

function formatMtime(ms: number): string {
  const d = new Date(ms);
  const now = Date.now();
  const ageMs = now - ms;
  const day = 24 * 60 * 60 * 1000;
  if (ageMs < day) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (ageMs < 7 * day) {
    return `${Math.floor(ageMs / day)}d ago`;
  }
  return d.toISOString().slice(0, 10);
}

interface DomainTestPanelProps {
  domainId: string;
  /**
   * If passed, replaces the sections region with the caller-provided
   * React. Used by existing bespoke tabs (P-006a) to mount their UI
   * inside the same header/health-strip shell.
   */
  customNode?: ReactNode;
}

export default function DomainTestPanel({
  domainId,
  customNode,
}: DomainTestPanelProps): JSX.Element {
  const [detail, setDetail] = useState<DomainDetail | null>(null);
  const [statuses, setStatuses] = useState<Record<string, FileStatusEntry>>({});
  const [health, setHealth] = useState<HealthStripData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // P-016/P-017: per-file active run + output drawer. Drawer-open state
  // is URL-backed (?runFile=<path>) so reload preserves the visible
  // drawer and the URL is shareable. The transient runId/output stays in
  // useState — generated server-side per click, not useful in URL.
  const [runFile, setRunFile] = useQueryState('runFile');
  // P-018: clicking a status chip opens a per-file run-history sheet.
  // URL-backed for the same reasons.
  const [historyFile, setHistoryFile] = useQueryState('historyFile');
  const [activeRun, setActiveRun] = useState<{
    runId: string;
    filePath: string;
    status: string;
    exitCode: number | null;
    output: string;
    finishedAt: number | null;
  } | null>(null);
  const [runLoading, setRunLoading] = useState<string | null>(null);

  async function runVitestMulti(filePaths: string[], label: string): Promise<void> {
    const key = `__multi__:${label}`;
    setRunLoading(key);
    setActiveRun({ runId: '', filePath: label, status: 'starting', exitCode: null, output: '', finishedAt: null });
    void setRunFile(label);
    await runImpl({ runner: { kind: 'vitest-multi', filePaths, label } }, label);
  }

  async function runVitestFile(filePath: string): Promise<void> {
    setRunLoading(filePath);
    setActiveRun({ runId: '', filePath, status: 'starting', exitCode: null, output: '', finishedAt: null });
    void setRunFile(filePath);
    await runImpl({ runner: { kind: 'vitest', filePath } }, filePath);
  }

  async function runImpl(body: unknown, displayPath: string): Promise<void> {
    try {
      const r = await fetch('/api/admin/testing/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        setActiveRun({ runId: '', filePath: displayPath, status: 'error', exitCode: null, output: `HTTP ${r.status}`, finishedAt: Date.now() });
        setRunLoading(null);
        return;
      }
      const { runId } = (await r.json()) as { runId: string };
      setActiveRun((prev) => prev ? { ...prev, runId, status: 'running' } : prev);
      const poll = async (): Promise<void> => {
        const pr = await fetch(`/api/admin/testing/run/${encodeURIComponent(runId)}`);
        if (!pr.ok) return;
        const snap = await pr.json() as {
          status: string; exitCode: number | null; output: string; finishedAt: number | null;
        };
        setActiveRun({ runId, filePath: displayPath, status: snap.status, exitCode: snap.exitCode, output: snap.output, finishedAt: snap.finishedAt });
        if (snap.finishedAt === null) {
          setTimeout(poll, 750);
        } else {
          setRunLoading(null);
          void fetch(`/api/admin/testing/file-status?domainId=${encodeURIComponent(domainId)}`)
            .then((r2) => (r2.ok ? r2.json() as Promise<FileStatusResponse> : null))
            .then((d) => { if (d) setStatuses(d.statuses); })
            .catch(() => { /* keep stale */ });
        }
      };
      void poll();
    } catch (e) {
      setActiveRun({ runId: '', filePath: displayPath, status: 'error', exitCode: null, output: e instanceof Error ? e.message : String(e), finishedAt: Date.now() });
      setRunLoading(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    setStatuses({});

    const fetchDetail = () =>
      fetch(`/api/admin/testing/domains/${encodeURIComponent(domainId)}`)
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<DomainDetail>;
        });

    const fetchStatuses = () =>
      fetch(`/api/admin/testing/file-status?domainId=${encodeURIComponent(domainId)}`)
        .then((r) => (r.ok ? (r.json() as Promise<FileStatusResponse>) : null))
        .then((d) => d?.statuses ?? {});

    const fetchHealth = () =>
      fetch(`/api/admin/testing/health-strip?domainId=${encodeURIComponent(domainId)}`)
        .then((r) => (r.ok ? (r.json() as Promise<HealthStripData>) : null));

    void Promise.all([fetchDetail(), fetchStatuses(), fetchHealth()])
      .then(([d, s, h]) => {
        if (cancelled) return;
        setDetail(d);
        setStatuses(s);
        setHealth(h);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // Refetch on tab focus — no SWR/TanStack-Query in operator-vite per D-013.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void Promise.all([fetchDetail().catch(() => null), fetchStatuses().catch(() => ({}))])
        .then(([d, s]) => {
          if (cancelled) return;
          if (d) setDetail(d);
          setStatuses(s);
        });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [domainId]);

  if (loading && !detail) {
    return <div className="pc-dtp-loading">Loading {domainId}…</div>;
  }

  if (error) {
    return (
      <div className="pc-dtp-error">
        <h3>Could not load {domainId}</h3>
        <pre>{error}</pre>
      </div>
    );
  }

  if (!detail) {
    return <div className="pc-dtp-loading">No data for {domainId}.</div>;
  }

  return (
    <div className="pc-dtp">
      <header className="pc-dtp-header">
        <div className="pc-dtp-header-row">
          <h2 className="pc-dtp-title">{detail.label}</h2>
          <span className="pc-dtp-count">{detail.totalFiles} files</span>
          {detail.totalFiles > 0 && (
            <button
              type="button"
              className="pc-dtp-run-btn"
              disabled={runLoading !== null}
              onClick={() => {
                const all = detail.sections.flatMap((s) => s.files.map((f) => f.path));
                void runVitestMulti(all, `${detail.id}/all`);
              }}
              title={`Run all ${detail.totalFiles} files in this domain`}
            >
              ▶ Run all
            </button>
          )}
        </div>
        <p className="pc-dtp-description">{detail.description}</p>
      </header>

      {/* P-033: test-related health strip (last-suite duration, last failure, flaky-rate). */}
      {health && (health.totalFilesTracked > 0 || health.lastSuiteDurationMs !== null) && (
        <div className="pc-dtp-health-strip pc-dtp-health-strip-live">
          {health.lastSuiteDurationMs !== null && (
            <span className="pc-dtp-health-pill" title="Sum of latest-per-file durations on current branch">
              <strong>last:</strong> {formatMs(health.lastSuiteDurationMs)}
            </span>
          )}
          <span className="pc-dtp-health-pill" title="Files with at least one row on current branch">
            <strong>tracked:</strong> {health.totalFilesTracked}/{detail.totalFiles}
          </span>
          {health.flakyFileCount > 0 && (
            <span className="pc-dtp-health-pill pc-dtp-health-pill-flaky" title="Files with >1 distinct status in last 10 runs">
              <strong>flaky:</strong> {health.flakyFileCount}
            </span>
          )}
          {health.lastFailureFinishedAt && (
            <span className="pc-dtp-health-pill pc-dtp-health-pill-fail" title={health.lastFailureFinishedAt}>
              <strong>last fail:</strong> {new Date(health.lastFailureFinishedAt).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {runFile && activeRun && (
        <div className={`pc-dtp-drawer pc-dtp-drawer-${activeRun.status}`}>
          <header className="pc-dtp-drawer-header">
            <span className="pc-dtp-drawer-title">
              {activeRun.status === 'running' || activeRun.status === 'starting' ? '⟳' : activeRun.status === 'pass' ? '✓' : '✗'} {activeRun.filePath}
            </span>
            <span className="pc-dtp-drawer-meta">
              status: {activeRun.status}{activeRun.exitCode !== null ? ` · exit ${activeRun.exitCode}` : ''}
            </span>
            <button
              type="button"
              className="pc-dtp-drawer-close"
              onClick={() => { setActiveRun(null); void setRunFile(null); }}
              title="Close"
            >×</button>
          </header>
          <pre className="pc-dtp-drawer-output">{activeRun.output || '(no output yet)'}</pre>
        </div>
      )}

      {historyFile && (
        <FileHistorySheet
          filePath={historyFile}
          onClose={() => void setHistoryFile(null)}
        />
      )}

      {customNode ? (
        <div className="pc-dtp-custom">{customNode}</div>
      ) : (
        <div className="pc-dtp-sections">
          {detail.sections.map((s) => (
            <section key={s.id} className="pc-dtp-section">
              <header className="pc-dtp-section-header">
                <h3 className="pc-dtp-section-title">{s.label}</h3>
                <span className="pc-dtp-section-count">
                  {s.files.length} file{s.files.length === 1 ? '' : 's'}
                  {s.runners.length > 0 && `, ${s.runners.length} runner${s.runners.length === 1 ? '' : 's'}`}
                </span>
                {s.files.length > 0 && (
                  <button
                    type="button"
                    className="pc-dtp-run-btn"
                    disabled={runLoading !== null}
                    onClick={() => void runVitestMulti(s.files.map((f) => f.path), `${detail.id}/${s.id}`)}
                    title={`Run all ${s.files.length} files in this section`}
                  >
                    ▶ Run section
                  </button>
                )}
              </header>
              {s.description && <p className="pc-dtp-section-description">{s.description}</p>}

              {s.files.length === 0 && s.runners.length === 0 ? (
                <p className="pc-dtp-empty">No matching files.</p>
              ) : (
                <ul className="pc-dtp-files">
                  {s.files.map((f) => {
                    const st = statuses[f.path];
                    return (
                      <li key={f.path} className="pc-dtp-file">
                        {st ? (
                          <button
                            type="button"
                            className={`${chipClass(st.status, st.stale)} pc-dtp-chip-button`}
                            title={
                              `${st.status} · ${st.durationMs ?? '?'}ms · ` +
                              `source=${st.source} · branch=${st.branch ?? 'none'}` +
                              (st.stale ? ' · STALE (no row on current branch)' : '') +
                              ' — click for history'
                            }
                            onClick={() => void setHistoryFile(f.path)}
                          >
                            {CHIP_LABEL[st.status]}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="pc-dtp-chip pc-dtp-chip-none pc-dtp-chip-button"
                            title="never run — click for history"
                            onClick={() => void setHistoryFile(f.path)}
                          >?</button>
                        )}
                        <code className="pc-dtp-file-path">{f.path}</code>
                        <span className="pc-dtp-file-meta">
                          {(f.sizeBytes / 1024).toFixed(1)} KB · {formatMtime(f.mtimeMs)}
                        </span>
                        <button
                          type="button"
                          className="pc-dtp-run-btn"
                          disabled={runLoading !== null}
                          onClick={() => void runVitestFile(f.path)}
                          title="Run via vitest"
                        >
                          {runLoading === f.path ? '…' : '▶'}
                        </button>
                      </li>
                    );
                  })}
                  {s.runners.map((r, i) => (
                    <li key={`runner-${i}`} className="pc-dtp-file pc-dtp-runner">
                      <code className="pc-dtp-file-path">⚙ {runnerLabel(r)}</code>
                      <span className="pc-dtp-file-meta">{r.kind}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * P-018 — per-file history sheet. Opens when a status chip is clicked;
 * reads /api/admin/testing/file-history?filePath=<path>&limit=20.
 * URL-backed via `?historyFile=<path>` so reload preserves visibility.
 */

interface HistoryRow {
  id: number;
  status: 'pass' | 'fail' | 'skip' | 'cancelled' | 'error' | 'running';
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  source: 'ci' | 'local' | 'admin-ui';
  branch: string | null;
  commitSha: string | null;
  framework: string;
  outputTail: string | null;
}

function FileHistorySheet({
  filePath,
  onClose,
}: { filePath: string; onClose: () => void }): JSX.Element {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setErr(null);
    fetch(`/api/admin/testing/file-history?filePath=${encodeURIComponent(filePath)}&limit=20`)
      .then((r) => (r.ok ? (r.json() as Promise<{ rows?: HistoryRow[] }>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (!cancelled) setRows(d.rows ?? []); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [filePath]);

  return (
    <div className="pc-dtp-sheet-backdrop" onClick={onClose}>
      <aside className="pc-dtp-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="pc-dtp-sheet-header">
          <h3>Run history</h3>
          <code className="pc-dtp-sheet-path">{filePath}</code>
          <button type="button" className="pc-dtp-sheet-close" onClick={onClose} title="Close">×</button>
        </header>
        {err && <p className="pc-dtp-sheet-error">Error: {err}</p>}
        {rows === null && !err && <p className="pc-dtp-sheet-loading">Loading…</p>}
        {rows && rows.length === 0 && <p className="pc-dtp-sheet-empty">No runs recorded for this file yet.</p>}
        {rows && rows.length > 0 && (
          <table className="pc-dtp-sheet-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Finished</th>
                <th>Duration</th>
                <th>Source</th>
                <th>Branch</th>
                <th>Framework</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`pc-dtp-sheet-row pc-dtp-sheet-row-${r.status}`}>
                  <td><span className={`pc-dtp-chip pc-dtp-chip-${r.status}`}>{CHIP_LABEL[r.status as ChipStatus] ?? r.status}</span></td>
                  <td title={r.finishedAt ?? ''}>{r.finishedAt ? new Date(r.finishedAt).toLocaleString() : '—'}</td>
                  <td>{r.durationMs !== null ? `${r.durationMs} ms` : '—'}</td>
                  <td>{r.source}</td>
                  <td title={r.commitSha ?? ''}>{r.branch ?? '—'}</td>
                  <td>{r.framework}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </aside>
    </div>
  );
}
