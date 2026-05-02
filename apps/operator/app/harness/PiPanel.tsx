'use client';

/**
 * PiPanel — embedded oh-my-pi (omp) terminal pane.
 *
 * Mounts an xterm.js terminal connected to an EventSource SSE stream from
 * `/api/harness/:slug/pty/:id/stream`. User keystrokes POST back to
 * `/api/harness/:slug/pty/:id/input`. Resize on container change.
 *
 * Lifecycle:
 *   - On mount: POST /spawn → record id → open SSE → wire xterm.
 *   - On unmount or slug/laneId change: POST /kill, close SSE.
 *   - On exit event from the server: render an "exited" banner; user can
 *     click Restart to spawn fresh.
 *
 * NOT a client of node-pty directly — that runs in the sidecar. This is a
 * pure browser-side component.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Loader2 } from 'lucide-react';
import { Tooltip } from './Tooltip';
import './PiPanel.css';

export interface PiPanelProps {
  /** Harness slug — matches the URL `/harness/<slug>`. */
  slug: string;
  /** Optional feature/lane id; scopes the pty cwd to that worktree. */
  laneId?: string;
  /** Override the spawn command. Default: pi (omp) with --no-pty. */
  command?: string;
  /** Override the spawn args. Default: ['--no-pty']. */
  args?: readonly string[];
}

interface ToolDef {
  name: string;
  label: string;
  description: string;
}

interface AuditSession {
  filename: string;
  tag: string | null;
  timestamp: string | null;
  sessionId: string | null;
  sizeBytes: number;
  mtimeMs: number;
}

interface PtyHandle {
  id: string;
  command: string;
  args: readonly string[];
  cwd: string;
  pid: number;
}

type PaneState =
  | { kind: 'starting' }
  | { kind: 'running'; handle: PtyHandle }
  | { kind: 'exited'; code: number; handle: PtyHandle }
  | { kind: 'error'; message: string };

const DARK_THEME = {
  background: '#0a0a0a',
  foreground: '#e7e7e7',
  cursor: '#6ea8ff',
  cursorAccent: '#0a0a0a',
  selectionBackground: '#3a3a4a',
  black: '#0a0a0a',
  red: '#e27e8a',
  green: '#7ee2a8',
  yellow: '#e2c47e',
  blue: '#7ec3e2',
  magenta: '#caa9e3',
  cyan: '#7ed4cc',
  white: '#e7e7e7',
  brightBlack: '#5a5a5a',
  brightRed: '#fca5a5',
  brightGreen: '#a8e2c5',
  brightYellow: '#fcd591',
  brightBlue: '#aac7e3',
  brightMagenta: '#dac3eb',
  brightCyan: '#a3dad4',
  brightWhite: '#ffffff',
};

export default function PiPanel({ slug, laneId, command, args }: PiPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<unknown>(null); // xterm Terminal instance
  const fitAddonRef = useRef<unknown>(null); // FitAddon instance
  const eventSourceRef = useRef<EventSource | null>(null);
  const handleIdRef = useRef<string | null>(null);
  const [state, setState] = useState<PaneState>({ kind: 'starting' });
  const [restartTick, setRestartTick] = useState(0);
  const [tools, setTools] = useState<ToolDef[] | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [sessions, setSessions] = useState<AuditSession[] | null>(null);
  const [showSessions, setShowSessions] = useState(false);

  // Fetch the static papercusp_* tool list once. Endpoint reflects whether
  // the extension file is present on disk; sidecar passes -e <path> on
  // omp spawn when it is, so this also tells the user whether tools are
  // actually wired into this pty.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/pty/tools`);
        if (!r.ok) return;
        const data = await r.json() as { extensionAvailable: boolean; tools: ToolDef[] };
        if (!cancelled && data.extensionAvailable) setTools(data.tools);
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [slug]);

  const refreshSessions = useCallback(async () => {
    try {
      const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/pi-sessions/audit`);
      if (!r.ok) { setSessions([]); return; }
      const data = await r.json() as { sessions: AuditSession[] };
      setSessions(data.sessions);
    } catch { setSessions([]); }
  }, [slug]);

  const postKill = useCallback(async (id: string) => {
    try {
      await fetch(`/api/harness/${encodeURIComponent(slug)}/pty/${id}/kill`, {
        method: 'POST',
        keepalive: true,
      });
    } catch { /* best-effort */ }
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    let mounted = true;
    let resizeObs: ResizeObserver | null = null;

    // Critical-path: kick the pty spawn POST in parallel with terminal
    // construction so the slow side (omp startup ~500–1500 ms) overlaps
    // with the cheap side (xterm DOM mount). The dock has likely already
    // POSTed /pty/prewarm on its own mount, in which case the server
    // adopts a hot handle and this returns near-instantly. We use a
    // conservative default 80×24 — a resize() POST follows once xterm
    // has measured the container.
    const spawnPromise = (async () => {
      try {
        const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/pty/spawn`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command, args, laneId, cols: 80, rows: 24 }),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({} as { error?: string }));
          return { ok: false as const, error: errBody?.error ?? `spawn failed: HTTP ${res.status}` };
        }
        return { ok: true as const, handle: (await res.json()) as PtyHandle };
      } catch (err) {
        return { ok: false as const, error: `spawn failed: ${(err as Error).message}` };
      }
    })();

    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: DARK_THEME,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    // fit.fit() can throw `TypeError: Cannot read properties of undefined
    // (reading 'scrollBarWidth')` when the container has 0 dimensions at
    // the moment of the call — happens reliably under dockview when a
    // panel is freshly added to a tab strip and hasn't been laid out
    // yet. Swallow + retry on next animation frame, by which time the
    // container has been measured.
    try { fit.fit(); } catch { /* not yet sized */ }
    requestAnimationFrame(() => {
      if (cancelled) return;
      try { fit.fit(); } catch { /* still 0×0 — user can resize manually */ }
    });
    termRef.current = term;
    fitAddonRef.current = fit;

    // Now wait on the spawn that's been racing in the background.
    spawnPromise.then((result) => {
      if (cancelled) {
        if (result.ok) postKill(result.handle.id);
        return;
      }
      if (!result.ok) {
        if (mounted) setState({ kind: 'error', message: result.error });
        return;
      }
      const handle = result.handle;
      handleIdRef.current = handle.id;
      if (mounted) setState({ kind: 'running', handle });

      // Push the post-fit dims to the pty if they differ from the 80×24
      // we asked for at spawn. Best-effort.
      if (term.cols !== 80 || term.rows !== 24) {
        fetch(`/api/harness/${encodeURIComponent(slug)}/pty/${handle.id}/resize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cols: term.cols, rows: term.rows }),
        }).catch(() => { /* ignore */ });
      }

      // SSE stream — bytes are base64'd UTF-8 from the server. xterm.write
      // takes either string (already-decoded code points, no UTF-8 decode)
      // or Uint8Array (decoded as UTF-8). atob returns a binary string of
      // raw bytes, so feed those as a Uint8Array — otherwise multi-byte
      // glyphs (powerline triangles, box-drawing) get mis-rendered as
      // Latin-1 chars and the C1 bytes (0x80–0x9F) trigger spurious
      // cursor moves.
      const es = new EventSource(
        `/api/harness/${encodeURIComponent(slug)}/pty/${handle.id}/stream`,
      );
      eventSourceRef.current = es;
      es.addEventListener('data', (ev) => {
        try {
          const bin = atob((ev as MessageEvent).data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          term.write(bytes);
        } catch { /* malformed event — drop */ }
      });
      es.addEventListener('exit', (ev) => {
        try {
          const payload = JSON.parse((ev as MessageEvent).data);
          if (mounted) setState({ kind: 'exited', code: payload?.code ?? 0, handle });
        } catch {
          if (mounted) setState({ kind: 'exited', code: 0, handle });
        }
        es.close();
      });
      es.onerror = () => {
        // The connection may drop temporarily during sidecar restart; let
        // the browser retry. Hard errors surface as exit events.
      };

      term.onData((data) => {
        const b64 = btoa(unescape(encodeURIComponent(data)));
        fetch(`/api/harness/${encodeURIComponent(slug)}/pty/${handle.id}/input`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: b64 }),
        }).catch(() => { /* best-effort */ });
      });

      resizeObs = new ResizeObserver(() => {
        try {
          fit.fit();
          fetch(`/api/harness/${encodeURIComponent(slug)}/pty/${handle.id}/resize`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cols: term.cols, rows: term.rows }),
          }).catch(() => { /* ignore */ });
        } catch { /* term not ready yet */ }
      });
      if (containerRef.current) resizeObs.observe(containerRef.current);
    });

    return () => {
      cancelled = true;
      mounted = false;
      resizeObs?.disconnect();
      const es = eventSourceRef.current;
      if (es) es.close();
      const id = handleIdRef.current;
      if (id) postKill(id);
      try { term.dispose(); } catch { /* ignore */ }
      termRef.current = null;
      fitAddonRef.current = null;
      handleIdRef.current = null;
    };
  // restartTick forces re-spawn on user-clicked Restart.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, laneId, command, args, postKill, restartTick]);

  return (
    <div className="pi-panel">
      <div className="pi-panel__header">
        <span className="pi-panel__title">pi</span>
        {state.kind === 'running' && (
          <span className="pi-panel__sub">
            pid {state.handle.pid}{laneId ? ` · ${laneId}` : ''}
          </span>
        )}
        {state.kind === 'exited' && (
          <span className="pi-panel__sub pi-panel__sub--exited">
            exited {state.code}
          </span>
        )}
        {state.kind === 'error' && (
          <span className="pi-panel__sub pi-panel__sub--error">{state.message}</span>
        )}

        {/* Spacer so action chips align right */}
        <span className="pi-panel__spacer" />

        {tools && tools.length > 0 && (
          <Tooltip label="Show papercusp tools the LLM can call from this pty">
            <button
              type="button"
              className="pi-panel__chip"
              onClick={() => { setShowTools((v) => !v); setShowSessions(false); }}
            >
              ↯ {tools.length} papercusp tools
            </button>
          </Tooltip>
        )}

        <Tooltip label="Past pi sessions exported to HTML">
          <button
            type="button"
            className="pi-panel__chip"
            onClick={async () => {
              const next = !showSessions;
              setShowSessions(next);
              setShowTools(false);
              if (next && sessions === null) await refreshSessions();
            }}
          >
            past sessions{sessions ? ` (${sessions.length})` : ''}
          </button>
        </Tooltip>

        {state.kind === 'exited' && (
          <button
            type="button"
            className="pi-panel__btn"
            onClick={() => setRestartTick((t) => t + 1)}
          >Restart</button>
        )}
      </div>

      {showTools && tools && (
        <div className="pi-panel__popover">
          <div className="pi-panel__popover-title">papercusp_* tools loaded for this pty</div>
          <ul className="pi-panel__tools-list">
            {tools.map((t) => (
              <li key={t.name}>
                <code>{t.name}</code>
                <span>{t.description}</span>
              </li>
            ))}
          </ul>
          <div className="pi-panel__popover-foot">
            Pi calls these via the extension at <code>~/.papercusp/global-plugins/pi/extension.ts</code>.
          </div>
        </div>
      )}

      {showSessions && sessions !== null && (
        <div className="pi-panel__popover">
          <div className="pi-panel__popover-title">
            Past pi sessions ({sessions.length})
            <Tooltip label="Refresh">
              <button
                type="button"
                className="pi-panel__refresh"
                onClick={refreshSessions}
              >↻</button>
            </Tooltip>
          </div>
          {sessions.length === 0 ? (
            <div className="pi-panel__empty">
              No exported sessions yet. They appear here after a pi pane closes.
            </div>
          ) : (
            <ul className="pi-panel__sessions-list">
              {sessions.map((s) => {
                const date = s.timestamp
                  ? s.timestamp.replace('T', ' ').replace(/-/g, ':').replace(/Z$/, ' UTC').replace('::', '-').replace('::', '-')
                  : null;
                const niceDate = s.mtimeMs ? new Date(s.mtimeMs).toLocaleString() : date;
                return (
                  <li key={s.filename}>
                    <a
                      href={`/api/harness/${encodeURIComponent(slug)}/pi-sessions/audit/${encodeURIComponent(s.filename)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span className="pi-panel__session-tag">{s.tag ?? s.filename}</span>
                      {niceDate && <span className="pi-panel__session-date">{niceDate}</span>}
                      <span className="pi-panel__session-size">{Math.round(s.sizeBytes / 1024)}&nbsp;KB</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="pi-panel__term-wrap">
        <div className="pi-panel__term" ref={containerRef} />
        {state.kind === 'starting' && (
          <div className="pi-panel__loading" aria-live="polite">
            <Loader2 size={18} className="pi-panel__loading-spin" />
            <span>starting pi…</span>
          </div>
        )}
      </div>
    </div>
  );
}
