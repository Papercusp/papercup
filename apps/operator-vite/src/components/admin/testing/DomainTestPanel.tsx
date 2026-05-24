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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

    void Promise.all([fetchDetail(), fetchStatuses()])
      .then(([d, s]) => {
        if (cancelled) return;
        setDetail(d);
        setStatuses(s);
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
        </div>
        <p className="pc-dtp-description">{detail.description}</p>
      </header>

      {/* P-033: health strip slot — wired in Phase 6 */}
      <div className="pc-dtp-health-strip" data-pending="true" />

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
                          <span
                            className={chipClass(st.status, st.stale)}
                            title={
                              `${st.status} · ${st.durationMs ?? '?'}ms · ` +
                              `source=${st.source} · branch=${st.branch ?? 'none'}` +
                              (st.stale ? ' · STALE (no row on current branch)' : '')
                            }
                          >
                            {CHIP_LABEL[st.status]}
                          </span>
                        ) : (
                          <span className="pc-dtp-chip pc-dtp-chip-none" title="never run">?</span>
                        )}
                        <code className="pc-dtp-file-path">{f.path}</code>
                        <span className="pc-dtp-file-meta">
                          {(f.sizeBytes / 1024).toFixed(1)} KB · {formatMtime(f.mtimeMs)}
                        </span>
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
