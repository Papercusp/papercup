'use client';

/**
 * Always-mounted Oracle assistant dock.
 *
 * - Floating mascot button bottom-right of every page.
 * - Opens on demand with a welcome message and a link to /settings/oracle.
 * - Streams from POST /api/oracle/chat (SSE).
 *
 * Phase 1 (this file): pure text. Phase 2 will add tool-call events
 * (navigate, dispatchToAgent, ...) and a UI command bus so Oracle can
 * actually drive the page.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface ToolCallEntry {
  kind: 'tool';
  name: string;
  input?: unknown;
}

function summarizeToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input !== 'object') return String(input);
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return '';
  const parts = entries.map(([k, v]) => {
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s && s.length > 40) s = s.slice(0, 37) + '…';
    return `${k}: ${s}`;
  });
  return parts.join(', ');
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  tools?: ToolCallEntry[];
}


const WELCOME: Message = {
  role: 'assistant',
  content:
    "Hi, I'm the Oracle. I know how everything in Papercusp works, and I can help you get things done across the app. Configure my prompt and memory in Settings → Oracle to make me yours.",
};

const HISTORY_KEY = 'oracle_history_v1';
const SEEN_KEY = 'oracle_seen_v1';

export function OracleDock() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // First mount: restore tab-local history if present, otherwise seed the
  // welcome message. On a user's *first ever* visit (no SEEN flag in
  // localStorage), also auto-open the dock so they meet the Oracle.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = sessionStorage.getItem(HISTORY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          setMessages(parsed);
          return;
        }
      }
    } catch { /* ignore corrupt history */ }
    setMessages([WELCOME]);
    if (!localStorage.getItem(SEEN_KEY)) {
      setOpen(true);
      localStorage.setItem(SEEN_KEY, '1');
    }
  }, []);

  // Persist on every change. Skip the lone welcome state so reloads don't
  // permanently pin the welcome card after the user dismisses it via "new chat".
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (messages.length === 0 || (messages.length === 1 && messages[0] === WELCOME)) {
      sessionStorage.removeItem(HISTORY_KEY);
      return;
    }
    try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(messages)); }
    catch { /* ignore quota */ }
  }, [messages]);

  const newChat = () => {
    setMessages([WELCOME]);
    setInput('');
    setError(null);
    sessionStorage.removeItem(HISTORY_KEY);
  };

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, open]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setError(null);
    const next: Message[] = [...messages.filter((m) => m !== WELCOME), { role: 'user', content: text }, { role: 'assistant', content: '' }];
    setMessages(next);
    setBusy(true);

    try {
      const res = await fetch('/api/oracle/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: next.slice(0, -1).filter((m) => m.role !== 'assistant' || m.content),
          currentPath: typeof window !== 'undefined' ? window.location.pathname : '',
        }),
      });
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        setError(errText);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const eventMatch = frame.match(/^event:\s*(.+)$/m);
          const dataMatch = frame.match(/^data:\s*(.+)$/m);
          if (!eventMatch || !dataMatch) continue;
          const event = eventMatch[1].trim();
          let data: any;
          try { data = JSON.parse(dataMatch[1]); } catch { data = dataMatch[1]; }
          if (event === 'delta' && typeof data?.text === 'string') {
            setMessages((prev) => {
              const copy = [...prev];
              const last = copy[copy.length - 1];
              copy[copy.length - 1] = { ...last, role: 'assistant', content: last.content + data.text };
              return copy;
            });
          } else if (event === 'tool_call' && typeof data?.name === 'string') {
            setMessages((prev) => {
              const copy = [...prev];
              const last = copy[copy.length - 1];
              const tools = [...(last.tools ?? []), { kind: 'tool' as const, name: data.name, input: data.input }];
              copy[copy.length - 1] = { ...last, role: 'assistant', tools };
              return copy;
            });
          } else if (event === 'ui_command') {
            if (data?.type === 'navigate' && typeof data.path === 'string') {
              router.push(data.path);
            } else if (data?.type === 'openChat' && typeof data.slug === 'string' && typeof data.chatId === 'string') {
              // Stash the request in sessionStorage so PiTerminalsDock can
              // drain it after navigating to /harness/<slug> mounts the dock.
              try {
                sessionStorage.setItem(
                  'oracle_pending_open_chat',
                  JSON.stringify({
                    slug: data.slug,
                    chatId: data.chatId,
                    role: data.role,
                    title: data.title,
                    featureId: data.featureId,
                  }),
                );
              } catch { /* ignore quota */ }
              router.push(`/pi?harness=${encodeURIComponent(data.slug)}`);
            }
          } else if (event === 'error') {
            setError(typeof data?.message === 'string' ? data.message : 'Oracle error');
          }
        }
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open Oracle assistant"
          className="oracle-fab"
        >
          <img src="/mascot.svg" alt="" height={34} style={{ display: 'block' }} />
          <span>Ask Oracle</span>
        </button>
      )}

      {open && (
        <div className="oracle-dock" role="dialog" aria-label="Oracle">
          <header className="oracle-dock-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <img src="/mascot.svg" alt="" height={24} style={{ display: 'block' }} />
              <strong>Oracle</strong>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={newChat} aria-label="New chat" title="New chat" className="oracle-link" style={{ background: 'transparent', border: 0, padding: '2px 6px', cursor: 'pointer', font: 'inherit' }}>＋</button>
              <Link href="/settings/oracle" className="oracle-link" title="Configure">⚙</Link>
              <button onClick={() => setOpen(false)} aria-label="Close" className="oracle-close">×</button>
            </div>
          </header>

          <div className="oracle-body">
            {messages.length === 0 ? (
              <div style={{ color: 'var(--fg-mute)', fontSize: 13, padding: 16, textAlign: 'center' }}>
                Ask me anything about Papercusp.
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} className={`oracle-msg oracle-msg-${m.role}`}>
                  <div className="oracle-msg-role">{m.role === 'user' ? 'You' : 'Oracle'}</div>
                  {m.tools?.map((t, ti) => {
                    const summary = summarizeToolInput(t.input);
                    return (
                      <div key={ti} className="oracle-tool-chip" title={summary}>
                        🔧 <strong>{t.name}</strong>
                        {summary && <span className="oracle-tool-args">({summary})</span>}
                      </div>
                    );
                  })}
                  <div className="oracle-msg-content">
                    {m.content || (busy && i === messages.length - 1 && !m.tools?.length ? '…' : '')}
                  </div>
                </div>
              ))
            )}
            {error && <div className="oracle-error">⚠ {error}</div>}
            <div ref={endRef} />
          </div>

          <form className="oracle-form" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={busy ? 'thinking…' : 'Ask the Oracle…'}
              disabled={busy}
            />
            <button type="submit" disabled={busy || !input.trim()} className="pc-button">
              {busy ? '…' : 'Send'}
            </button>
          </form>
        </div>
      )}
    </>
  );
}
