'use client';

/**
 * Operator panel — primary interaction surface for the Operator concierge.
 *
 * Per spec/agent-mcp:
 *   - Top dropdown covering most of the page in all directions.
 *   - Triggered by the Operator button (next to Mission Control) AND
 *     the Cmd/Ctrl+K, O keyboard shortcut.
 *   - Click-outside to close.
 *   - Current view stays mounted underneath.
 *   - Icon states: idle / scanning / thinking / acting / paused / awaiting-input.
 *
 * On open, kicks off /api/agent-mcp/operator-scan, streams events,
 * renders suggestion cards as they arrive, and lets the user dispatch
 * or dismiss each.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { MarkdownPreview } from './MarkdownEditor';
import { speak, onFinalUtterance, getVoiceState } from './voice/voice-mode';
import { registerVoiceConsumer } from './voice/VoiceAppBridge';

type IconState = 'idle' | 'scanning' | 'thinking' | 'acting' | 'paused' | 'awaiting-input';

const ICON_GLYPH: Record<IconState, string> = {
  idle: '●',
  scanning: '◐',
  thinking: '◑',
  acting: '◉',
  paused: '⏸',
  'awaiting-input': '◆',
};

interface ParsedSuggestion {
  title: string;
  why: string;
  action: 'send_directive' | 'open' | 'draft' | 'advise';
  target_harness: string | null;
  directive_kind: 'Directive' | 'Decision' | 'Priority' | null;
  directive_subject: string;
  directive_body: string;
  auto_dispatch: boolean;
  reason: string;
}

interface SuggestionCard extends ParsedSuggestion {
  id: string;
  status: 'pending' | 'dispatched' | 'dismissed' | 'failed';
  failureReason?: string;
}

interface DecisionRow {
  id: string;
  ts: number;
  action: string;
  target: string;
}

interface OperatorState {
  open: boolean;
  iconState: IconState;
  paused: boolean;
}

const defaultState: OperatorState = {
  open: false,
  iconState: 'idle',
  paused: false,
};

// Shared state across button + panel. Both components subscribe to the
// same source of truth so the button click that flips `open` is visible
// to the panel and vice-versa.
const setters = new Set<(s: Partial<OperatorState>) => void>();
let sharedState: OperatorState = { ...defaultState };

function broadcastState(partial: Partial<OperatorState>): void {
  sharedState = { ...sharedState, ...partial };
  for (const fn of setters) fn(partial);
}

export function setOperatorState(partial: Partial<OperatorState>): void {
  broadcastState(partial);
}

export function OperatorButton(): JSX.Element {
  const [state, setState] = useState<OperatorState>(sharedState);

  useEffect(() => {
    const fn = (partial: Partial<OperatorState>) =>
      setState((s) => ({ ...s, ...partial }));
    setters.add(fn);
    return () => {
      setters.delete(fn);
    };
  }, []);

  useEffect(() => {
    let armed = false;
    let timer: number | null = null;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        armed = true;
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          armed = false;
        }, 1000);
        return;
      }
      if (armed && e.key === 'o') {
        e.preventDefault();
        broadcastState({ open: !sharedState.open });
        armed = false;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggle = useCallback(() => {
    broadcastState({ open: !sharedState.open });
  }, []);

  const glyph = state.paused ? ICON_GLYPH.paused : ICON_GLYPH[state.iconState];

  return (
    <button
      className="pc-header-cta"
      aria-label="Operator"
      onClick={toggle}
      style={{ marginLeft: 8 }}
    >
      <span style={{ marginRight: 6, fontFamily: 'monospace' }}>{glyph}</span>
      Operator
    </button>
  );
}

export function OperatorPanel(): JSX.Element | null {
  const [state, setState] = useState<OperatorState>(sharedState);
  const [suggestions, setSuggestions] = useState<SuggestionCard[]>([]);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [streamLog, setStreamLog] = useState<string[]>([]);
  const [scanStarted, setScanStarted] = useState(false);
  const [firstRun, setFirstRun] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const evtSrcRef = useRef<EventSource | null>(null);

  // Subscribe to shared state.
  useEffect(() => {
    const fn = (partial: Partial<OperatorState>) =>
      setState((s) => ({ ...s, ...partial }));
    setters.add(fn);
    return () => {
      setters.delete(fn);
    };
  }, []);

  // Click-outside to close.
  useEffect(() => {
    if (!state.open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!panelRef.current) return;
      if (panelRef.current.contains(e.target as Node)) return;
      const target = e.target as HTMLElement;
      if (target.closest('[aria-label="Operator"]')) return;
      broadcastState({ open: false });
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [state.open]);

  // Kick off a scan when the panel opens.
  const startScan = useCallback((request?: string) => {
    if (evtSrcRef.current) {
      evtSrcRef.current.close();
      evtSrcRef.current = null;
    }
    setSuggestions([]);
    setStreamLog([]);
    setState((s) => ({ ...s, iconState: 'scanning' }));
    setScanStarted(true);
    const url =
      `/api/agent-mcp/operator-scan?request=${encodeURIComponent(request ?? '')}`;
    const es = new EventSource(url);
    evtSrcRef.current = es;
    es.addEventListener('first_run', () => setFirstRun(true));
    es.addEventListener('delta', (ev: MessageEvent) => {
      try {
        const { text } = JSON.parse(ev.data);
        setStreamLog((log) => {
          const next = [...log];
          const last = next[next.length - 1] ?? '';
          if (last.length < 200) {
            next[next.length - 1] = (last + text).slice(-200);
          } else {
            next.push(text.slice(0, 200));
          }
          return next.slice(-5);
        });
      } catch {
        /* ignore */
      }
      setState((s) => ({ ...s, iconState: 'thinking' }));
    });
    es.addEventListener('tool_call', () => {
      setState((s) => ({ ...s, iconState: 'scanning' }));
    });
    es.addEventListener('suggestion', (ev: MessageEvent) => {
      try {
        const s = JSON.parse(ev.data) as ParsedSuggestion;
        setSuggestions((prev) => [
          ...prev,
          { ...s, id: `${prev.length}-${Date.now()}`, status: 'pending' },
        ]);
        // Voice mode: speak the suggestion title + why-line.
        if (getVoiceState().mode !== 'off') {
          speak(`${s.title}. ${s.why}`, 'system:operator');
        }
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('done', () => {
      setState((s) => ({ ...s, iconState: 'idle' }));
      es.close();
      evtSrcRef.current = null;
      void refreshDecisions();
    });
    es.addEventListener('error', (ev: MessageEvent) => {
      setStreamLog((log) => [...log, `error: ${(ev as any).data ?? '(no detail)'}`]);
      setState((s) => ({ ...s, iconState: 'idle' }));
      es.close();
      evtSrcRef.current = null;
    });
  }, []);

  const refreshDecisions = useCallback(async () => {
    try {
      const r = await fetch('/api/agent-mcp/decisions?limit=20');
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d?.rows)) setDecisions(d.rows);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!state.open) {
      if (evtSrcRef.current) {
        evtSrcRef.current.close();
        evtSrcRef.current = null;
      }
      return;
    }
    if (!scanStarted && !state.paused) {
      startScan();
    }
    void refreshDecisions();
  }, [state.open, state.paused, scanStarted, startScan, refreshDecisions]);

  // Voice mode: subscribe to final utterances while panel is open and
  // dispatch them as scan requests. Lets the user say "scan again" or
  // "tell me about the auth project" instead of typing. Also registers
  // as the priority voice consumer so VoiceAppBridge stops routing
  // utterances to Oracle while Operator is open.
  useEffect(() => {
    if (!state.open) return;
    const dereg = registerVoiceConsumer('OperatorPanel');
    const unsub = onFinalUtterance((text) => {
      if (!text || text.length < 2) return;
      startScan(text);
    });
    return () => {
      dereg();
      unsub();
    };
  }, [state.open, startScan]);

  const dispatchSuggestion = useCallback(async (id: string) => {
    const card = suggestionsRef.current.find((c) => c.id === id);
    if (!card) return;
    setSuggestions((prev) =>
      prev.map((c) => (c.id === id ? { ...c, status: 'dispatched' } : c)),
    );
    setState((s) => ({ ...s, iconState: 'acting' }));
    try {
      if (card.action !== 'send_directive' || !card.target_harness) {
        // Other action types are advisory; mark dispatched and exit.
        return;
      }
      const r = await fetch('/api/admin/execute-action', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Bearer is set server-side via the operator's stored credential
          // when operator is the caller; for this UI we rely on session auth.
        },
        body: JSON.stringify({
          op: 'send_message',
          to: [card.target_harness],
          kind: card.directive_kind ?? 'Directive',
          subject: card.directive_subject,
          body: card.directive_body,
          reason: card.reason,
        }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        setSuggestions((prev) =>
          prev.map((c) =>
            c.id === id ? { ...c, status: 'failed', failureReason: text } : c,
          ),
        );
      }
    } catch (err) {
      setSuggestions((prev) =>
        prev.map((c) =>
          c.id === id
            ? {
                ...c,
                status: 'failed',
                failureReason: err instanceof Error ? err.message : String(err),
              }
            : c,
        ),
      );
    } finally {
      setState((s) => ({ ...s, iconState: 'idle' }));
      void refreshDecisions();
    }
  }, [refreshDecisions]);

  const suggestionsRef = useRef<SuggestionCard[]>([]);
  useEffect(() => {
    suggestionsRef.current = suggestions;
  }, [suggestions]);

  const dismissSuggestion = useCallback((id: string) => {
    setSuggestions((prev) =>
      prev.map((c) => (c.id === id ? { ...c, status: 'dismissed' } : c)),
    );
  }, []);

  if (!state.open) return null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Operator panel"
      style={{
        position: 'fixed',
        top: 56,
        left: 24,
        right: 24,
        bottom: 24,
        background: 'var(--pc-panel-bg, #ffffff)',
        border: '1px solid rgba(0,0,0,0.1)',
        borderRadius: 12,
        boxShadow: '0 16px 48px rgba(0,0,0,0.18)',
        zIndex: 90,
        overflow: 'hidden',
        display: 'grid',
        gridTemplateRows: 'auto 1fr auto',
      }}
    >
      <div
        style={{
          padding: '12px 20px',
          borderBottom: '1px solid rgba(0,0,0,0.08)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          Operator <span style={{ opacity: 0.6, marginLeft: 8 }}>{state.iconState}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => startScan()}>
            Re-scan
          </button>
          <button
            type="button"
            onClick={() => broadcastState({ paused: !state.paused })}
          >
            {state.paused ? 'Resume autonomous actions' : 'Pause autonomous actions'}
          </button>
          <button
            type="button"
            onClick={() => broadcastState({ open: false })}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '320px 1fr 320px',
          height: '100%',
          overflow: 'hidden',
        }}
      >
        <aside
          style={{
            borderRight: '1px solid rgba(0,0,0,0.08)',
            padding: 16,
            overflow: 'auto',
          }}
        >
          {firstRun && (
            <div
              style={{
                padding: 12,
                marginBottom: 12,
                background: 'rgba(33,150,243,0.06)',
                borderRadius: 8,
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              <strong>First-run intro</strong>
              <p style={{ margin: '6px 0 0' }}>
                I have full write authority across all harnesses in this workspace.
                Edit my prompt or preferences from <a href="/settings/operator">/settings/operator</a>.
              </p>
            </div>
          )}
          <h3 style={{ margin: 0, marginBottom: 8, fontSize: 12, opacity: 0.7, textTransform: 'uppercase' }}>
            Stream
          </h3>
          {streamLog.length === 0 ? (
            <p style={{ fontSize: 13, opacity: 0.7 }}>(no stream yet)</p>
          ) : (
            <pre
              style={{
                fontSize: 11,
                lineHeight: 1.4,
                whiteSpace: 'pre-wrap',
                opacity: 0.85,
                margin: 0,
              }}
            >
              {streamLog.join('\n')}
            </pre>
          )}
        </aside>

        <main style={{ padding: 16, overflow: 'auto' }}>
          <h3 style={{ margin: 0, marginBottom: 12, fontSize: 12, opacity: 0.7, textTransform: 'uppercase' }}>
            Suggestions
          </h3>
          {suggestions.length === 0 ? (
            <p style={{ fontSize: 13, opacity: 0.7 }}>
              {scanStarted ? 'Scanning…' : 'No scan started.'}
            </p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
              {suggestions.map((s) => (
                <li
                  key={s.id}
                  style={{
                    border: '1px solid rgba(0,0,0,0.1)',
                    borderRadius: 8,
                    padding: 12,
                    background: s.status === 'dismissed' ? 'rgba(0,0,0,0.02)' : '#fff',
                    opacity: s.status === 'dismissed' ? 0.5 : 1,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <strong>{s.title}</strong>
                    <span style={{ fontSize: 11, opacity: 0.6 }}>
                      {s.action}
                      {s.target_harness ? ` → ${s.target_harness}` : ''}
                      {s.auto_dispatch ? ' · auto' : ' · ask first'}
                    </span>
                  </div>
                  <p style={{ fontSize: 13, opacity: 0.8, margin: '6px 0' }}>{s.why}</p>
                  {s.directive_body && (
                    <details style={{ fontSize: 12, opacity: 0.7 }}>
                      <summary>Directive body</summary>
                      <div style={{ marginTop: 4 }}>
                        <MarkdownPreview value={s.directive_body} outline="left" />
                      </div>
                    </details>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    {s.action === 'send_directive' && s.status === 'pending' && (
                      <button type="button" onClick={() => dispatchSuggestion(s.id)}>
                        Dispatch
                      </button>
                    )}
                    {s.status === 'pending' && (
                      <button type="button" onClick={() => dismissSuggestion(s.id)}>
                        Dismiss
                      </button>
                    )}
                    {s.status === 'dispatched' && (
                      <span style={{ fontSize: 12, color: 'green' }}>✓ dispatched</span>
                    )}
                    {s.status === 'failed' && (
                      <span style={{ fontSize: 12, color: 'red' }}>
                        ✗ failed: {s.failureReason}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </main>

        <aside
          style={{
            borderLeft: '1px solid rgba(0,0,0,0.08)',
            padding: 16,
            overflow: 'auto',
          }}
        >
          <h3 style={{ margin: 0, marginBottom: 8, fontSize: 12, opacity: 0.7, textTransform: 'uppercase' }}>
            Decisions log
          </h3>
          {decisions.length === 0 ? (
            <p style={{ fontSize: 13, opacity: 0.7 }}>No decisions yet.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {decisions.map((r) => (
                <li
                  key={r.id}
                  style={{ borderBottom: '1px solid rgba(0,0,0,0.06)', padding: '6px 0', fontSize: 13 }}
                >
                  <div style={{ fontWeight: 500 }}>{r.action}</div>
                  <div style={{ opacity: 0.7 }}>
                    {r.target}{' '}
                    <span style={{ opacity: 0.5 }}>· {new Date(r.ts).toLocaleString()}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      <div
        style={{
          padding: '8px 20px',
          borderTop: '1px solid rgba(0,0,0,0.08)',
          fontSize: 12,
          opacity: 0.7,
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>Cmd/Ctrl+K then O to toggle • Click outside to close</span>
        <span>Operator MCP v0.1.0</span>
      </div>
    </div>
  );
}
