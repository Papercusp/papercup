'use client';

/**
 * BranchActionRunner — modal that invokes a per-branch action and tails
 * its log via SSE. Mirrors ProvisionStream's xterm pattern but speaks the
 * branch-action event vocabulary (`output`, `stderr`, `action-started`,
 * `action-completed`, `action-failed`, `done`).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useEventSource } from '@papercusp/sse/react';
import { Modal } from '../harness/Modal';

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

  const [missingKeys, setMissingKeys] = useState<{ name: string; plugin?: string }[] | null>(null);

  // Start the run if we don't have one yet
  useEffect(() => {
    if (runId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/harness/${slug}/branch/${branch}/action-run?name=${encodeURIComponent(name)}`,
          { method: 'POST' },
        );
        const body = await res.json();
        if (res.status === 412) {
          if (!cancelled) {
            setMissingKeys(body.missing ?? []);
            setStatus('error');
            setError('Required keys missing');
          }
          return;
        }
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
  const streamUrl = useMemo(() => runId
    ? `/api/harness/${slug}/branch/${branch}/action-stream?name=${encodeURIComponent(name)}&runId=${encodeURIComponent(runId)}`
    : null,
    [runId, slug, branch, name]);

  const write = (s: string) => termRef.current?.write(s);
  const ts = () => `${C.dim}${new Date().toISOString().slice(11, 19)}${C.reset} `;

  const { status: esStatus } = useEventSource(streamUrl, {
    // Disable consecutive-failure escalation — we don't have a fallback,
    // and the previous impl just retried forever via browser auto-reconnect.
    maxConsecutiveFailures: 0,
    handlers: {
      attached: () => setStatus('streaming'),
      'action-started': (data) => {
        try {
          const d = JSON.parse(data);
          write(`${ts()}${C.cyan}── starting ${d.branch}/${d.name} ──${C.reset}\r\n`);
          write(`${ts()}${C.dim}cwd: ${d.cwd}${C.reset}\r\n`);
        } catch { /* ignore */ }
      },
      output: (data) => {
        try { write(`${JSON.parse(data).line as string}\r\n`); } catch { /* ignore */ }
      },
      stderr: (data) => {
        try { write(`${C.red}${JSON.parse(data).line}${C.reset}\r\n`); } catch { /* ignore */ }
      },
      'action-completed': (data) => {
        try {
          const d = JSON.parse(data);
          write(`\r\n${ts()}${C.green}${C.bold}✓ completed${C.reset} (exit ${d.exitCode}, ${d.durationMs} ms)\r\n`);
        } catch { /* ignore */ }
        setStatus('done');
      },
      'action-failed': (data) => {
        try {
          const d = JSON.parse(data);
          write(`\r\n${ts()}${C.red}${C.bold}✗ failed${C.reset} (exit ${d.exitCode}, ${d.durationMs} ms)\r\n`);
        } catch { /* ignore */ }
        setStatus('failed');
      },
      done: () => { /* hook handles close on `done` events natively */ },
    },
  });

  // Surface a connection-error state if we never made it past 'connecting'.
  useEffect(() => {
    if (esStatus === 'failing' && status === 'connecting') setStatus('error');
  }, [esStatus, status]);

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`${branch} / ${name}`}
      srOnlyTitle
      zIndex={200}
      closeOnEscape={status === 'done' || status === 'failed' || status === 'error'}
      closeOnOutsideClick={status === 'done' || status === 'failed' || status === 'error'}
      contentStyle={{
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
              status === 'failed' || status === 'error' ? 'var(--bad)' :
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
        <div ref={containerRef} style={{ flex: 1, padding: 8, background: '#0d1117', display: missingKeys ? 'none' : 'block' }} />
        {missingKeys && (
          <div style={{ padding: 16, background: '#1c1917', color: 'var(--warn)', fontSize: 13, lineHeight: 1.5, overflow: 'auto', flex: 1 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--warn)' }}>
              Required keys missing
            </div>
            <div style={{ color: '#c9d1d9', marginBottom: 12 }}>
              This action needs values that haven't been configured yet for this harness.
            </div>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {missingKeys.map((m) => (
                <li key={m.name} style={{ marginBottom: 8 }}>
                  <code style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: 3 }}>{m.name}</code>
                  {m.plugin && (
                    <>
                      {' '}— from{' '}
                      <a
                        href={`/harness/${slug}?panel=plugins&plugin=${encodeURIComponent(m.plugin)}`}
                        style={{ color: '#58a6ff' }}
                      >
                        {m.plugin}
                      </a>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {missingKeys[0]?.plugin && (
              <a
                href={`/harness/${slug}?panel=plugins&plugin=${encodeURIComponent(missingKeys[0].plugin)}`}
                style={{
                  display: 'inline-block', marginTop: 12,
                  padding: '6px 12px', background: '#58a6ff', color: '#0d1117',
                  textDecoration: 'none', borderRadius: 4, fontWeight: 600,
                }}
              >
                Configure {missingKeys[0].plugin} →
              </a>
            )}
          </div>
        )}
        {error && !missingKeys && (
          <div style={{ padding: '6px 12px', background: '#3a1010', color: 'var(--bad)', fontSize: 12 }}>
            {error}
          </div>
        )}
    </Modal>
  );
}
