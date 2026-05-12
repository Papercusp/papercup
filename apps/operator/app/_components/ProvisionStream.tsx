'use client';

/**
 * ProvisionStream — read-only xterm view of a (harness, plugin) provision
 * audit-log stream.
 *
 * Subscribes to `/api/provision/stream?harness=&plugin=&runId=` (SSE) and
 * renders each entry into an xterm.js terminal. Mirrors PiPanel's xterm
 * setup pattern (dynamic import for SSR safety, FitAddon resize) but
 * strips out the PTY input/resize-write plumbing — provisioning is one-way.
 *
 * Renders structured events distinctly:
 *   - script-output     → raw stdout/stderr line
 *   - resource-recorded → green annotation "+ <kind> <id>"
 *   - setup-started     → cyan separator
 *   - setup-completed   → green banner
 *   - setup-failed      → red banner
 *   - state-set, consent-granted, log-truncated → grey annotations
 *   - ::papercusp::progress markers in script-output → yellow tag
 *   - ::papercusp::warn / error    → yellow / red prefixes
 *
 * Calls onDone(success) when the server emits a terminal event.
 */

import { useEffect, useRef, useState } from 'react';
import { createResilientEventSource } from '@restart/sse';
import '@xterm/xterm/css/xterm.css';

export interface ProvisionStreamProps {
  /** Harness slug. */
  harness: string;
  /** Plugin slug (e.g. "@papercupai/cloudflare-stack"). */
  plugin: string;
  /** Optional runId to scope the stream to a specific run. */
  runId?: string;
  /** Called once on terminal event with the outcome. */
  onDone?: (outcome: { kind: 'success' | 'failed' | 'closed'; finalKind?: string }) => void;
  /** ISO timestamp; only events strictly after this time are streamed. */
  since?: string;
  /** Approximate terminal height in rows. Default 24. */
  rows?: number;
}

interface AuditEntry {
  ts: string;
  kind: string;
  runId?: string;
  data?: unknown;
}

/* ─── ANSI colour helpers ──────────────────────────────────────────────── */

const C = {
  reset: '\x1b[0m',
  dim:   '\x1b[2m',
  red:   '\x1b[31m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  cyan:  '\x1b[36m',
  bold:  '\x1b[1m',
};

function fmtData(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Render a single audit entry as a colourised terminal line.
 * Returned string includes a trailing CRLF (xterm needs CR for new lines).
 */
function renderEntry(e: AuditEntry): string {
  const t = e.ts.slice(11, 19); // HH:MM:SS
  const ts = `${C.dim}${t}${C.reset}`;
  switch (e.kind) {
    case 'script-output': {
      const line = (e.data as { line?: string } | undefined)?.line ?? '';
      // Surface ::papercusp:: markers
      if (line.startsWith('::papercusp::progress')) {
        const parts = line.split('\t');
        return `${ts} ${C.yellow}▸${C.reset} ${parts[1] ?? ''} ${C.dim}${parts.slice(2).join(' ')}${C.reset}\r\n`;
      }
      if (line.startsWith('::papercusp::warn')) {
        return `${ts} ${C.yellow}WARN${C.reset} ${line.replace(/^::papercusp::warn\t/, '')}\r\n`;
      }
      if (line.startsWith('::papercusp::error')) {
        return `${ts} ${C.red}${C.bold}ERROR${C.reset} ${line.replace(/^::papercusp::error\t/, '')}\r\n`;
      }
      if (line.startsWith('STDERR:')) {
        return `${ts} ${C.dim}${line}${C.reset}\r\n`;
      }
      return `${ts} ${line}\r\n`;
    }
    case 'resource-recorded': {
      const d = e.data as { kind?: string; externalId?: string } | undefined;
      return `${ts} ${C.green}+ ${d?.kind ?? '?'}${C.reset} ${d?.externalId ?? ''}\r\n`;
    }
    case 'setup-started':
    case 'teardown-started':
    case 'verify-started':
      return `${ts} ${C.cyan}${C.bold}${e.kind}${C.reset} ${C.dim}${fmtData(e.data)}${C.reset}\r\n`;
    case 'setup-completed':
    case 'teardown-completed':
    case 'verify-completed':
      return `${ts} ${C.green}${C.bold}✓ ${e.kind}${C.reset}\r\n`;
    case 'setup-failed':
    case 'teardown-failed':
    case 'verify-failed':
      return `${ts} ${C.red}${C.bold}✗ ${e.kind}${C.reset} ${C.dim}${fmtData(e.data)}${C.reset}\r\n`;
    case 'consent-granted':
      return `${ts} ${C.dim}consent granted${C.reset}\r\n`;
    case 'log-truncated':
      return `${ts} ${C.yellow}log truncated${C.reset} ${C.dim}${fmtData(e.data)}${C.reset}\r\n`;
    default:
      return `${ts} ${C.dim}${e.kind} ${fmtData(e.data)}${C.reset}\r\n`;
  }
}

/* ─── Component ────────────────────────────────────────────────────────── */

export function ProvisionStream({
  harness,
  plugin,
  runId,
  onDone,
  since,
  rows = 24,
}: ProvisionStreamProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<{ write: (s: string) => void } | null>(null);
  const fitRef = useRef<{ fit: () => void } | null>(null);
  const [status, setStatus] = useState<'connecting' | 'streaming' | 'done' | 'error'>('connecting');

  // xterm setup (dynamic import so SSR doesn't choke on `self`)
  useEffect(() => {
    let cancelled = false;
    let term: { write: (s: string) => void; dispose: () => void; open: (el: HTMLElement) => void; loadAddon: (a: unknown) => void } | null = null;
    let fit: { fit: () => void } | null = null;
    let resizeObserver: ResizeObserver | null = null;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (cancelled || !containerRef.current) return;
      term = new Terminal({
        rows,
        cols: 100,
        convertEol: true,
        scrollback: 5_000,
        fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        fontSize: 12,
        theme: {
          background: '#0d1117',
          foreground: '#c9d1d9',
          cursor: '#c9d1d9',
        },
        cursorBlink: false,
        disableStdin: true,
      }) as unknown as typeof term;
      fit = new FitAddon() as unknown as typeof fit;
      term!.loadAddon(fit);
      term!.open(containerRef.current);
      fit!.fit();
      termRef.current = term as unknown as { write: (s: string) => void };
      fitRef.current = fit as unknown as { fit: () => void };

      resizeObserver = new ResizeObserver(() => {
        try { fit?.fit(); } catch { /* ignore */ }
      });
      resizeObserver.observe(containerRef.current);
    })();

    return () => {
      cancelled = true;
      try { resizeObserver?.disconnect(); } catch { /* ignore */ }
      try { term?.dispose(); } catch { /* ignore */ }
      termRef.current = null;
      fitRef.current = null;
    };
  }, [rows]);

  // SSE subscription
  useEffect(() => {
    if (!harness || !plugin) return;
    const params = new URLSearchParams({ harness, plugin });
    if (runId) params.set('runId', runId);
    if (since) params.set('since', since);
    const url = `/api/provision/stream?${params}`;
    setStatus('connecting');

    const allKinds = [
      'script-output', 'resource-recorded', 'consent-granted',
      'setup-started', 'setup-completed', 'setup-failed',
      'teardown-started', 'teardown-completed', 'teardown-failed',
      'verify-started', 'verify-completed', 'verify-failed',
      'log-truncated', 'state-set',
    ];
    const successKinds = new Set(['setup-completed', 'teardown-completed', 'verify-completed']);
    const failureKinds = new Set(['setup-failed', 'teardown-failed', 'verify-failed']);

    const handleEntry = (kind: string) => (data: string) => {
      try {
        const entry = JSON.parse(data) as AuditEntry;
        const line = renderEntry(entry);
        termRef.current?.write(line);
      } catch { /* skip malformed */ }
      if (successKinds.has(kind)) {
        setStatus('done');
        onDone?.({ kind: 'success', finalKind: kind });
      } else if (failureKinds.has(kind)) {
        setStatus('done');
        onDone?.({ kind: 'failed', finalKind: kind });
      }
    };

    const handlers: Record<string, (data: string) => void> = {
      attached: () => setStatus('streaming'),
      done: () => setStatus('done'),
    };
    for (const k of allKinds) handlers[k] = handleEntry(k);

    const source = createResilientEventSource({
      url,
      handlers,
      onStatusChange: (s) => {
        // Surface a hard error only when we never reach an open state.
        if (s === 'failing' && status === 'connecting') setStatus('error');
      },
    });

    return () => { source.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harness, plugin, runId, since]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 200,
          background: '#0d1117',
          padding: 8,
          borderRadius: 4,
        }}
      />
      <div style={{
        fontSize: 11,
        color: '#888',
        marginTop: 4,
        display: 'flex',
        gap: 12,
        fontFamily: 'ui-monospace, monospace',
      }}>
        <span>provision: {plugin} @ {harness}</span>
        <span>status: <span style={{ color: status === 'error' ? '#f85149' : status === 'done' ? '#3fb950' : '#58a6ff' }}>{status}</span></span>
        {runId && <span>runId: {runId}</span>}
      </div>
    </div>
  );
}
