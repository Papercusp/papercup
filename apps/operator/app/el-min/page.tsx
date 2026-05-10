'use client';

import { useRef, useState } from 'react';

// Minimal EL test inside the operator React tree.
// Imports @elevenlabs/client from the BUNDLED package (same as the failing
// elPure path), but renders no chrome, no providers, no OracleDock, no voice
// button. If this works → contamination is in specific operator components.
// If it fails the same way as elPure → bundling itself is the issue.

export default function Page() {
  const [lines, setLines] = useState<string[]>(['click "Start" to begin…']);
  const convRef = useRef<any>(null);
  const append = (s: string) => setLines((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${s}`]);

  const start = async () => {
    setLines([]);
    append('=== minimal-react EL test starting ===');
    let token: string, agentId: string;
    try {
      const r = await fetch('/api/agent-mcp/operator-elevenlabs-bootstrap');
      if (!r.ok) {
        append(`mint failed: HTTP ${r.status}`);
        return;
      }
      const j = await r.json();
      token = j.conversationToken;
      agentId = j.agentId;
      append(`token len ${token.length}, agentId ${agentId}`);
    } catch (e: any) {
      append(`mint threw: ${e?.message ?? e}`);
      return;
    }
    append('opening Conversation.startSession (bundled @elevenlabs/client) …');
    try {
      const mod = await import('@elevenlabs/client');
      const conv = await mod.Conversation.startSession({
        conversationToken: token,
        connectionType: 'webrtc',
        textOnly: false,
        clientTools: {},
        onConnect: ({ conversationId }: any) => append(`onConnect — ${conversationId}`),
        onDisconnect: (d: any) => append(`onDisconnect ${JSON.stringify(d)}`),
        onMessage: ({ message, source }: any) => append(`msg[${source}]: ${String(message).slice(0, 120)}`),
        onError: (m: string) => append(`error: ${m}`),
        onModeChange: (m: any) => append(`mode: ${JSON.stringify(m)}`),
        onStatusChange: (s: any) => append(`status: ${JSON.stringify(s)}`),
      });
      convRef.current = conv;
      append('startSession resolved — speak now');
    } catch (e: any) {
      append(`startSession failed: ${e?.message ?? e}`);
    }
  };

  const stop = async () => {
    try { await convRef.current?.endSession(); } catch {}
    convRef.current = null;
    append('stopped');
  };

  return (
    <div style={{ padding: 24, fontFamily: 'ui-monospace, Menlo, monospace', maxWidth: 720, margin: '0 auto' }}>
      <h1>EL minimal-React test</h1>
      <p>Same code as <code>el-bare-test.html</code> but inside the operator React tree (root layout providers still wrap it; no chrome, no OracleDock, no voice button on this route).</p>
      <p>
        <button onClick={start} style={{ padding: '8px 16px', marginRight: 8 }}>Start</button>
        <button onClick={stop} style={{ padding: '8px 16px' }}>Stop</button>
      </p>
      <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 4, maxHeight: 500, overflow: 'auto' }}>
        {lines.join('\n')}
      </pre>
    </div>
  );
}
