'use client';

/**
 * BranchActionRunner — modal that invokes a per-branch action and tails
 * its log via SSE. Mirrors ProvisionStream's xterm pattern but speaks the
 * branch-action event vocabulary (`output`, `stderr`, `action-started`,
 * `action-completed`, `action-failed`, `done`).
 */

import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';

interface Props {
  slug: string;
  branch: 'staging' | 'testing' | 'production';
  name: string;
  /** If set, attach to an existing run instead of starting a new one. */
  existingRunId?: string;
  onClose: () => void;
}

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m',
};

export default function BranchActionRunner({ slug, branch, name, existingRunId, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const [runId, setRunId] = useState<string | null>(existingRunId ?? null);
  const [status, setStatus] = useState<'starting' | 'connecting' | 'streaming' | 'done' | 'failed' | 'error'>(
    existingRunId ? 'connecting' : 'starting',
  );
  const [error, setError] = useState<string | null>(null);

  // Mount xterm
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (cancelled || !containerRef.current) return;
      const t = new Terminal({
        convertEol: true,
        scrollback: 5000,
        fontFamily: 'ui-monospace, Menlo, monospace',
        fontSize: 12,
        theme: { background: '#0d1117', foreground: '#c9d1d9' },
      });
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(containerRef.current);
      fit.fit();
      termRef.current = t;
      fitRef.current = fit;

      const onResize = () => { try { fit.fit(); } catch { /* ignore */ } };
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    })();
    return () => {
      cancelled = true;
      try { termRef.current?.dispose(); } catch { /* ignore */ }
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Start the run if we don't have one yet
  useEffect(() => {
    if (runId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/harness/${slug}/branch/${branch}/action/${name}/run`,
          { method: 'POST' },
        );
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (!cancelled) {
          setRunId(body.runId as string);
          setStatus('connecting');
        }
      } catch (e) {
        if (!cancelled) { setError(String((e as Error).message)); setStatus('error'); }
      }
    })();
    return () => { cancelled = true; };
  }, [runId, slug, branch, name]);

  // Subscribe SSE
  useEffect(() => {
    if (!runId) return;
    const url = `/api/harness/${slug}/branch/${branch}/action/${name}/stream?runId=${encodeURIComponent(runId)}`;
    const es = new EventSource(url);

    const write = (s: string) => termRef.current?.write(s);
    const ts = () => `${C.dim}${new Date().toISOString().slice(11, 19)}${C.reset} `;

    es.addEventListener('attached', () => setStatus('streaming'));
    es.addEventListener('action-started', (ev: MessageEvent) => {
      try {
        const d = JSON.parse(ev.data);
        write(`${ts()}${C.cyan}── starting ${d.branch}/${d.name} ──${C.reset}\r\n`);
        write(`${ts()}${C.dim}cwd: ${d.cwd}${C.reset}\r\n`);
      } catch { /* ignore */ }
    });
    es.addEventListener('output', (ev: MessageEvent) => {
      try { write(`${(JSON.parse(ev.data).line as string)}\r\n`); } catch { /* ignore */ }
    });
    es.addEventListener('stderr', (ev: MessageEvent) => {
      try { write(`${C.red}${JSON.parse(ev.data).line}${C.reset}\r\n`); } catch { /* ignore */ }
    });
    es.addEventListener('action-completed', (ev: MessageEvent) => {
      try {
        const d = JSON.parse(ev.data);
        write(`\r\n${ts()}${C.green}${C.bold}✓ completed${C.reset} (exit ${d.exitCode}, ${d.durationMs} ms)\r\n`);
      } catch { /* ignore */ }
      setStatus('done');
    });
    es.addEventListener('action-failed', (ev: MessageEvent) => {
      try {
        const d = JSON.parse(ev.data);
        write(`\r\n${ts()}${C.red}${C.bold}✗ failed${C.reset} (exit ${d.exitCode}, ${d.durationMs} ms)\r\n`);
      } catch { /* ignore */ }
      setStatus('failed');
    });
    es.addEventListener('done', () => { es.close(); });
    es.onerror = () => {
      // Auto-reconnects; flag only if we never got attached
      if (status === 'connecting') setStatus('error');
    };

    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, slug, branch, name]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(900px, 100%)', height: 'min(600px, 100%)',
          background: '#161b22', border: '1px solid var(--border)',
          borderRadius: 6, display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '8px 12px', borderBottom: '1px solid var(--border)',
          fontSize: 12,
        }}>
          <span style={{ fontWeight: 600 }}>{branch} / {name}</span>
          <span style={{ color: 'var(--fg-dim)' }}>{slug}</span>
          <span style={{
            marginLeft: 'auto',
            color:
              status === 'done' ? '#3fb950' :
              status === 'failed' || status === 'error' ? '#f85149' :
              '#58a6ff',
          }}>
            {status}{runId ? ` · ${runId}` : ''}
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: '1px solid var(--border)',
              color: 'var(--fg)', borderRadius: 3, padding: '2px 8px',
              cursor: 'pointer', fontSize: 11,
            }}
          >Close</button>
        </div>
        <div ref={containerRef} style={{ flex: 1, padding: 8, background: '#0d1117' }} />
        {error && (
          <div style={{ padding: '6px 12px', background: '#3a1010', color: '#f85149', fontSize: 12 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
