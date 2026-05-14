'use client';

import { useCallback, useMemo, useState } from 'react';
import { useSyncQuery } from '@restart/sync';
import { Modal } from './Modal';
import { RichGrid, type ColumnDef } from '@restart/grid-core';

// Row shape from harness_shared.harness_smoke_test (single-row aggregate
// of smoke-{pass,failure,results,startup} sibling files).
type HarnessSmokeTestRow = {
  harnessSlug: string;
  status: 'pass' | 'fail' | 'unknown';
  passContent?: string | null;
  failureContent?: string | null;
  results?: SmokeResult[] | null;
  startupLog?: string | null;
  mtimeMs: number;
};

interface SmokeResult {
  url: string;
  expectStatus: number;
  actualStatus: string;
  ok: boolean;
  reason: string;
  bodyHead: string;
}

interface SmokeData {
  status: 'pass' | 'fail' | 'unknown';
  mtimeMs: number | null;
  pass: string | null;
  failure: string | null;
  results: SmokeResult[] | null;
  startupLog: string | null;
}

interface Props {
  slug: string;
  onClose: () => void;
}

function fmtTs(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function SmokeTestPanel({ slug, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [runOutput, setRunOutput] = useState<string | null>(null);

  // Live-pushed via Zero (harness_shared.harness_smoke_test, aggregated
  // from 4 source files by harness-fs-watcher.ts). Replaces
  // useSseOrPoll(/smoke-test/sse, load, 5000).
  const { data: smokeRows, error } = useSyncQuery<HarnessSmokeTestRow>({
    queryName: 'harnessSmokeTest.byHarness',
    args: { harnessSlug: slug },
  });
  const data = useMemo<SmokeData | null>(() => {
    const row = smokeRows?.[0];
    if (!row) return null;
    return {
      status: row.status,
      mtimeMs: row.mtimeMs ?? null,
      pass: row.passContent ?? null,
      failure: row.failureContent ?? null,
      results: row.results ?? null,
      startupLog: row.startupLog ?? null,
    };
  }, [smokeRows]);
  const err = error ? String(error) : null;

  const runNow = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setRunOutput('Running…');
    try {
      const r = await fetch(`/api/harness/${slug}/smoke-test/run`, { method: 'POST' });
      const d = await r.json();
      setRunOutput(d.output ?? '(no output)');
      // Zero pushes the new row once chokidar mirrors the smoke-* file writes.
    } catch (e) {
      setRunOutput(`error: ${e}`);
    } finally {
      setBusy(false);
    }
  }, [slug, busy]);

  const tone = data?.status === 'pass' ? '#10b981' : data?.status === 'fail' ? '#f87171' : 'var(--fg-mute)';

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Smoke test`}
      srOnlyTitle
      zIndex={60}
      contentStyle={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, width: '80vw', maxWidth: 1000, height: '75vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', color: 'var(--fg)' }}
    >
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong>Smoke test — {slug}</strong>
          <span style={{ fontFamily: 'monospace', color: 'var(--fg-mute)', fontSize: '0.75rem' }}>bin/service-smoke-test.sh</span>
          {data && (
            <span style={{
              fontSize: '0.75rem', padding: '0.15rem 0.55rem',
              border: `1px solid ${tone}`, color: tone, borderRadius: 3,
              textTransform: 'uppercase', fontWeight: 600,
            }}>
              {data.status}
            </span>
          )}
          {data?.mtimeMs && <span style={{ fontSize: '0.75rem', color: 'var(--fg-mute)' }}>{fmtTs(data.mtimeMs)}</span>}
          <button
            onClick={runNow}
            disabled={busy}
            style={{
              marginLeft: 'auto',
              background: '#3b82f6', color: 'white', border: 'none',
              padding: '0.35rem 0.85rem', borderRadius: 3,
              cursor: busy ? 'wait' : 'pointer', fontSize: '0.8rem', fontWeight: 600,
            }}
          >
            {busy ? 'running…' : '▶ Run now'}
          </button>
          <button onClick={onClose} style={{ background: 'transparent', color: 'var(--fg-mute)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}>close</button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '1rem' }}>
          {err && <div style={{ color: '#f87171', marginBottom: 12 }}>err: {err}</div>}

          {data?.results && data.results.length > 0 && (
            <section style={{ marginBottom: 18 }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--fg-mute)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                URL checks ({data.results.filter((r) => r.ok).length}/{data.results.length} passed)
              </div>
              <SmokeResultsGrid results={data.results} />
            </section>
          )}

          {data?.failure && (
            <section style={{ marginBottom: 18 }}>
              <div style={{ fontSize: '0.7rem', color: '#f87171', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Failure report</div>
              <pre style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 3, padding: '0.75rem', margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem', whiteSpace: 'pre-wrap', color: '#fde68a' }}>
                {data.failure}
              </pre>
            </section>
          )}

          {data?.pass && !data?.failure && (
            <section style={{ marginBottom: 18 }}>
              <div style={{ fontSize: '0.7rem', color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Last pass</div>
              <pre style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 3, padding: '0.75rem', margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem', whiteSpace: 'pre-wrap', color: '#d1d5db' }}>
                {data.pass}
              </pre>
            </section>
          )}

          {runOutput && (
            <section style={{ marginBottom: 18 }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--fg-mute)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Last manual run</div>
              <pre style={{ background: '#000', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem', margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: '0.7rem', whiteSpace: 'pre-wrap', color: '#d1d5db', maxHeight: 240, overflow: 'auto' }}>
                {runOutput}
              </pre>
            </section>
          )}

          {data?.status === 'unknown' && !runOutput && (
            <div style={{ color: 'var(--fg-mute)', fontStyle: 'italic', fontSize: '0.85rem' }}>
              No smoke test has run yet. Enable <code style={{ color: '#fde68a' }}>smokeTest.enabled</code> in config and configure URLs, or click <strong>Run now</strong>.
            </div>
          )}
        </div>
      </Modal>
  );
}

function SmokeResultsGrid({ results }: { results: SmokeResult[] }) {
  const columns: ColumnDef<SmokeResult>[] = useMemo(
    () => [
      {
        key: 'url',
        header: 'URL',
        width: 4,
        render: ({ row }) => (
          <span style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
            <span style={{ marginRight: 6, color: row.ok ? '#10b981' : '#f87171' }}>{row.ok ? '✓' : '✗'}</span>
            {row.url}
          </span>
        ),
      },
      {
        key: 'expected',
        header: 'Expected',
        width: 0.7,
        align: 'right',
        render: ({ row }) => <span style={{ fontFamily: 'monospace', color: 'var(--fg-mute)' }}>{row.expectStatus}</span>,
      },
      {
        key: 'actual',
        header: 'Actual',
        width: 0.7,
        align: 'right',
        render: ({ row }) => (
          <span style={{ fontFamily: 'monospace', color: row.ok ? '#10b981' : '#f87171' }}>{row.actualStatus}</span>
        ),
      },
      {
        key: 'reason',
        header: 'Reason',
        width: 2,
        render: ({ row }) => <span style={{ color: '#d1d5db', fontSize: '0.75rem' }}>{row.reason || '—'}</span>,
      },
    ],
    [],
  );
  return (
    <RichGrid<SmokeResult>
      rows={results}
      columns={columns}
      getRowId={(r) => r.url}
      inline
    />
  );
}
