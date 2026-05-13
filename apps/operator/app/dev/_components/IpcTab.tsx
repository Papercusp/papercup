/**
 * /dev → IPC tab. End-to-end verification button for the endpoint-IPC
 * transport. Calls dev:ipc_echo through dispatchEndpointStream — which
 * picks IPC on Tauri (when PAPERCUSP_DESKTOP_IPC=1 was set at desktop
 * boot) and falls back to HTTP+SSE everywhere else. Same event log
 * regardless of transport so behavior can be compared side-by-side
 * via the FORCE_HTTP env override.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  dispatchEndpointStream,
  type EndpointStreamEvent,
} from '@/lib/transport-adapters';
import { Checkbox } from '@/app/harness/Checkbox';

interface LogEntry {
  ts: number;
  kind: EndpointStreamEvent['kind'];
  text: string;
}

export default function IpcTab(): JSX.Element {
  const [transport, setTransport] = useState<'ipc' | 'http' | 'unknown'>('unknown');
  const [message, setMessage] = useState('hello from the dev page');
  const [emitBinary, setEmitBinary] = useState(false);
  const [delayMs, setDelayMs] = useState(100);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);

  // Detect transport on mount (matches the picker's logic).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tauri = Boolean((window as any).__TAURI_INTERNALS__?.invoke);
    const forceHttp =
      typeof process !== 'undefined' &&
      process.env.NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT === '1';
    setTransport(tauri && !forceHttp ? 'ipc' : 'http');
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setLog([]);
    const controller = new AbortController();
    const append = (kind: EndpointStreamEvent['kind'], text: string): void => {
      setLog((prev) => [...prev, { ts: Date.now(), kind, text }]);
    };
    try {
      for await (const ev of dispatchEndpointStream(
        'dev:ipc_echo',
        { message, emitBinary, delayMs },
        { signal: controller.signal },
      )) {
        if (ev.kind === 'event') {
          append('event', `${ev.name}: ${JSON.stringify(ev.data)}`);
        } else if (ev.kind === 'binary') {
          append(
            'binary',
            `${ev.name}: Uint8Array(${ev.data.byteLength}) [${Array.from(ev.data).map((b) => b.toString(16).padStart(2, '0')).join(' ')}]`,
          );
        } else if (ev.kind === 'done') {
          append('done', JSON.stringify(ev.result));
          break;
        } else {
          append('error', `${ev.code}: ${ev.message}`);
          break;
        }
      }
    } finally {
      setRunning(false);
    }
  }, [message, emitBinary, delayMs]);

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: 0, marginBottom: 8 }}>Endpoint IPC verification</h2>
      <p style={{ marginTop: 0, opacity: 0.7, fontSize: 13 }}>
        Selected transport:{' '}
        <strong>{transport === 'unknown' ? 'detecting…' : transport.toUpperCase()}</strong>.{' '}
        {transport === 'ipc'
          ? 'Calls go through the Tauri Channel<EndpointEvent> directly.'
          : 'Calls go through HTTP+SSE. Set PAPERCUSP_DESKTOP_IPC=1 at desktop launch to switch.'}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 8, maxWidth: 480, marginBottom: 12 }}>
        <label>Message:</label>
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          style={{ font: 'inherit' }}
        />
        <label>Delay ms:</label>
        <input
          type="number"
          min={0}
          max={1000}
          value={delayMs}
          onChange={(e) => setDelayMs(Math.max(0, Math.min(1000, Number(e.target.value) || 0)))}
          style={{ font: 'inherit' }}
        />
        <label>Emit binary:</label>
        <Checkbox checked={emitBinary} onChange={setEmitBinary} />
      </div>

      <button
        onClick={run}
        disabled={running}
        style={{ padding: '6px 14px', font: 'inherit', cursor: running ? 'wait' : 'pointer' }}
      >
        {running ? 'Running…' : 'Run dev:ipc_echo'}
      </button>

      <h3 style={{ marginTop: 16, marginBottom: 6 }}>Event log</h3>
      <pre
        style={{
          background: 'rgba(0,0,0,0.04)',
          padding: 10,
          borderRadius: 4,
          fontSize: 12,
          minHeight: 120,
          maxHeight: 360,
          overflow: 'auto',
        }}
      >
        {log.length === 0 ? '(no events yet)' : log.map((e, i) => `[${e.kind}] ${e.text}`).join('\n')}
      </pre>
    </div>
  );
}
