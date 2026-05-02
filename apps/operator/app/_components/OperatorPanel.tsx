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

interface ProvenanceFlags {
  tierMismatch?: boolean;
  capabilityUnknown?: boolean;
  oversizedTitle?: boolean;
  oversizedWhy?: boolean;
}

interface ParsedSuggestion {
  id: string;
  title: string;
  why: string;
  reason: string;
  tier: 'low' | 'medium' | 'high';
  actualTier: 'low' | 'medium' | 'high';
  auto_dispatch: boolean;
  provenanceFlags: ProvenanceFlags;
  action: 'send_directive' | 'navigate' | 'inform';
  // Discriminated fields (only populated for matching action variant):
  capability?: 'messages:write' | null;
  target_harness?: string;
  directive_kind?: 'Directive' | 'Decision' | 'Priority';
  directive_subject?: string;
  directive_body?: string;
  target_resource?: string;
  body?: string;
}

type LifecycleState =
  | 'pending'
  | 'dispatched'
  | 'consumed'
  | 'escalated'
  | 'rejected'
  | 'failed'
  | 'dismissed'
  | 'superseded';

interface SuggestionCard extends ParsedSuggestion {
  status: LifecycleState;
  failureReason?: string;
  /** Local time we transitioned to `dispatched`. Used for the "unconsumed" warning glyph. */
  dispatchedAt?: number;
  /** True when dismiss came from undo-window cancel (audit-only, no preferences entry). */
  undoCancelled?: boolean;
}

const UNCONSUMED_AGE_MS = 4 * 60_000; // 3 × 60s cadence + 60s grace = 4 min

function ageMs(card: SuggestionCard): number | null {
  return card.dispatchedAt ? Date.now() - card.dispatchedAt : null;
}

interface DecisionRow {
  id: string;
  ts: number;
  action: string;
  target: string;
}

import {
  broadcastState,
  setOperatorState,
  sharedState,
  subscribeOperatorState,
  type OperatorState,
} from './operator-shared-state';

export { setOperatorState };

export function OperatorButton(): JSX.Element {
  const [state, setState] = useState<OperatorState>(sharedState);

  useEffect(() => {
    const fn = (partial: Partial<OperatorState>) =>
      setState((s) => ({ ...s, ...partial }));
    return subscribeOperatorState(fn);
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
  const titleByState: Record<IconState, string> = {
    idle: 'Operator — idle',
    scanning: 'Operator — scanning workspace',
    thinking: 'Operator — composing suggestions',
    acting: 'Operator — dispatching',
    paused: 'Operator — paused (autonomous actions disabled)',
    'awaiting-input': 'Operator — awaiting your decision on pending suggestions',
  };
  const title = state.paused ? titleByState.paused : titleByState[state.iconState];

  return (
    <button
      className={`pc-header-cta pc-header-cta--operator pc-header-cta--${state.iconState}${state.paused ? ' is-paused' : ''}`}
      aria-label={title}
      title={title}
      onClick={toggle}
      style={{ marginLeft: 8 }}
    >
      <span className="pc-header-cta-orb" aria-hidden="true">
        <span className="pc-header-cta-glyph">{glyph}</span>
      </span>
      <span className="pc-header-cta-label">Operator</span>
    </button>
  );
}

interface BudgetSnapshot {
  configured: boolean;
  dailyCapUsd: number;
  todaySpendUsd: number;
  exceeded: boolean;
}

export function OperatorPanel(): JSX.Element | null {
  const [state, setState] = useState<OperatorState>(sharedState);
  const [suggestions, setSuggestions] = useState<SuggestionCard[]>([]);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [streamLog, setStreamLog] = useState<string[]>([]);
  const [scanStarted, setScanStarted] = useState(false);
  const [firstRun, setFirstRun] = useState(false);
  const [budget, setBudget] = useState<BudgetSnapshot | null>(null);
  const [budgetSaving, setBudgetSaving] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const evtSrcRef = useRef<EventSource | null>(null);

  // Subscribe to shared state.
  useEffect(() => {
    const fn = (partial: Partial<OperatorState>) =>
      setState((s) => ({ ...s, ...partial }));
    return subscribeOperatorState(fn);
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
        const raw = JSON.parse(ev.data) as ParsedSuggestion;
        // Pause → foreground convert auto→ask BEFORE render.
        const s: ParsedSuggestion = sharedState.paused && raw.auto_dispatch
          ? { ...raw, auto_dispatch: false }
          : raw;
        setSuggestions((prev) => {
          const idx = prev.findIndex((c) => c.id === s.id);
          if (idx >= 0) {
            // Stable-id collision = supersede the prior card. Drop terminal
            // statuses to 'superseded' so reconstruction sees the move.
            const next = prev.slice();
            const prior = prev[idx];
            const wasTerminal = prior.status === 'dispatched' || prior.status === 'dismissed';
            next[idx] = wasTerminal
              ? { ...prior, status: 'superseded' as LifecycleState }
              : { ...prior, ...s, status: 'pending' };
            if (wasTerminal) next.push({ ...s, status: 'pending' });
            return next;
          }
          return [...prev, { ...s, status: 'pending' }];
        });
        // Voice mode: speak the suggestion title + why-line.
        if (getVoiceState().mode !== 'off') {
          speak(`${s.title}. ${s.why}`, 'system:operator');
        }
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('done', () => {
      // If any cards landed ask-first, the user owes us a decision.
      const askFirstPending = suggestionsRef.current.some(
        (c) => c.status === 'pending' && !c.auto_dispatch,
      );
      setState((s) => ({ ...s, iconState: askFirstPending ? 'awaiting-input' : 'idle' }));
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

  const hydrateFromLastScan = useCallback(async () => {
    try {
      const r = await fetch('/api/agent-mcp/operator-last-scan');
      if (!r.ok) return;
      const { snapshot } = (await r.json()) as {
        snapshot: { cards: ParsedSuggestion[] } | null;
      };
      if (!snapshot?.cards?.length) return;
      // Only hydrate when we have nothing on screen — never blow away an
      // in-flight scan.
      setSuggestions((prev) => {
        if (prev.length > 0) return prev;
        return snapshot.cards.map((c) => ({ ...c, status: 'pending' as LifecycleState }));
      });
    } catch {
      /* ignore */
    }
  }, []);

  const refreshBudget = useCallback(async () => {
    try {
      const r = await fetch('/api/agent-mcp/operator-budget');
      if (!r.ok) return;
      setBudget((await r.json()) as BudgetSnapshot);
    } catch {
      /* ignore */
    }
  }, []);

  const setBudgetCap = useCallback(async (cap: number) => {
    setBudgetSaving(true);
    try {
      await fetch('/api/agent-mcp/operator-budget', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dailyCapUsd: cap }),
      });
      await refreshBudget();
    } finally {
      setBudgetSaving(false);
    }
  }, [refreshBudget]);

  useEffect(() => {
    if (!state.open) {
      if (evtSrcRef.current) {
        evtSrcRef.current.close();
        evtSrcRef.current = null;
      }
      return;
    }
    void refreshBudget();
    void refreshDecisions();
    void hydrateFromLastScan();
    // Don't auto-scan until the user has confirmed a budget cap.
    if (!scanStarted && !state.paused && budget?.configured && !budget.exceeded) {
      startScan();
    }
  }, [state.open, state.paused, scanStarted, startScan, refreshDecisions, refreshBudget, hydrateFromLastScan, budget?.configured, budget?.exceeded]);

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

  const logAudit = useCallback(async (cardId: string, kind: 'dispatched' | 'acked' | 'undo_cancel', context?: Record<string, unknown>) => {
    try {
      await fetch('/api/agent-mcp/operator-audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cardId, kind, context }),
      });
    } catch {
      /* best-effort */
    }
  }, []);

  const dispatchSuggestion = useCallback(async (id: string) => {
    const card = suggestionsRef.current.find((c) => c.id === id);
    if (!card) return;
    const dispatchedAt = Date.now();
    setSuggestions((prev) =>
      prev.map((c) => (c.id === id ? { ...c, status: 'dispatched', dispatchedAt } : c)),
    );
    setState((s) => ({ ...s, iconState: 'acting' }));
    void logAudit(id, 'dispatched', {
      action: card.action,
      capability: card.capability ?? null,
      target: card.target_harness ?? null,
    });
    try {
      if (card.action !== 'send_directive' || !card.target_harness) {
        // navigate / inform are advisory; ack immediately and exit.
        void logAudit(id, 'acked');
        return;
      }
      const r = await fetch('/api/admin/execute-action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
      } else {
        // Path-(b) ack: dispatch returned without error. Receiving-state
        // ('consumed' / 'escalated' / 'rejected') is derived later from
        // a Zero subscription on messages.status — wired in a follow-up.
        void logAudit(id, 'acked');
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
  }, [refreshDecisions, logAudit]);

  const suggestionsRef = useRef<SuggestionCard[]>([]);
  useEffect(() => {
    suggestionsRef.current = suggestions;
  }, [suggestions]);

  /**
   * Deliberate dismiss — user clicked Dismiss in the panel. Optionally
   * collect a reason so Operator can learn from the dismissal (Phase 4a).
   * Skipping the reason still records the dismissal in card state but
   * leaves preferences.md untouched.
   */
  const dismissSuggestion = useCallback((id: string) => {
    const card = suggestionsRef.current.find((c) => c.id === id);
    setSuggestions((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, status: 'dismissed', undoCancelled: false } : c,
      ),
    );
    if (!card) return;
    const reason = typeof window !== 'undefined'
      ? window.prompt('Why dismiss this? (optional — leave blank to skip learning)')
      : '';
    if (!reason || !reason.trim()) return;
    const entry = `- [USER-TYPED] [DISMISS] "${card.title.replace(/"/g, '\\"')}" — reason: "${reason.trim().replace(/"/g, '\\"')}"`;
    void fetch('/api/agent-mcp/operator-preferences', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry }),
    });
  }, []);

  /**
   * Undo-window cancel — user hit Cancel within 5s of a background
   * auto-fire toast. Audit-only; explicitly DOES NOT touch preferences
   * (per §4 decision 2). Background auto-fire toasts arrive in Phase 3;
   * this helper is exported now so the existing UI dismiss button can
   * share the lifecycle without confusing the two paths.
   */
  const undoCancelSuggestion = useCallback(
    (id: string) => {
      setSuggestions((prev) =>
        prev.map((c) =>
          c.id === id ? { ...c, status: 'dismissed', undoCancelled: true } : c,
        ),
      );
      void logAudit(id, 'undo_cancel');
    },
    [logAudit],
  );
  void undoCancelSuggestion; // surfaced for Phase 3 toast wiring

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

      {budget && !budget.configured && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(255,255,255,0.96)',
            zIndex: 1,
            display: 'grid',
            placeItems: 'center',
            padding: 32,
          }}
        >
          <div style={{ maxWidth: 420, fontSize: 14, lineHeight: 1.5 }}>
            <h3 style={{ margin: '0 0 8px' }}>Pick a daily budget for Operator</h3>
            <p style={{ opacity: 0.7, margin: '0 0 16px' }}>
              Operator stops scanning automatically when today&apos;s spend reaches the cap.
              You can change this any time at <a href="/settings/operator">/settings/operator</a>.
            </p>
            <div style={{ display: 'grid', gap: 8 }}>
              {[
                { label: 'Light', cap: 5, blurb: '~50 scans/day with default model' },
                { label: 'Active', cap: 20, blurb: 'recommended for daily use' },
                { label: 'Heavy', cap: 50, blurb: 'large workspaces or always-on background' },
              ].map(({ label, cap, blurb }) => (
                <button
                  key={cap}
                  type="button"
                  disabled={budgetSaving}
                  onClick={() => setBudgetCap(cap)}
                  style={{
                    textAlign: 'left',
                    padding: 12,
                    border: '1px solid rgba(0,0,0,0.12)',
                    borderRadius: 8,
                    background: '#fff',
                    cursor: budgetSaving ? 'wait' : 'pointer',
                  }}
                >
                  <strong>{label} — ${cap}/day</strong>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>{blurb}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
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
                      {' · '}
                      <span title={`tier=${s.actualTier}`}>
                        {s.actualTier}
                      </span>
                      {s.auto_dispatch ? ' · auto' : ' · ask first'}
                      {s.provenanceFlags?.tierMismatch && (
                        <span title="LLM-claimed tier overridden by substrate" style={{ color: '#a04' }}>
                          {' · ⚠tier'}
                        </span>
                      )}
                      {s.provenanceFlags?.capabilityUnknown && (
                        <span title="Unknown capability — forced high (fail-safe)" style={{ color: '#a04' }}>
                          {' · ⚠cap'}
                        </span>
                      )}
                    </span>
                  </div>
                  <p style={{ fontSize: 13, opacity: 0.8, margin: '6px 0' }}>{s.why}</p>
                  {s.action === 'send_directive' && s.directive_body && (
                    <details style={{ fontSize: 12, opacity: 0.7 }}>
                      <summary>Directive body</summary>
                      <div style={{ marginTop: 4 }}>
                        <MarkdownPreview value={s.directive_body} outline="left" />
                      </div>
                    </details>
                  )}
                  {s.action === 'inform' && s.body && (
                    <div style={{ fontSize: 12, marginTop: 4 }}>
                      <MarkdownPreview value={s.body} outline="left" />
                    </div>
                  )}
                  {s.action === 'navigate' && s.target_resource && (
                    <a
                      href={s.target_resource}
                      style={{ fontSize: 12 }}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open {s.target_resource}
                    </a>
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
                    {s.status === 'dispatched' && (() => {
                      const age = ageMs(s);
                      const unconsumed = age !== null && age > UNCONSUMED_AGE_MS;
                      return unconsumed ? (
                        <span style={{ fontSize: 12, color: '#a04' }} title={`pending for ${Math.round(age! / 60000)}m`}>
                          ⏳ unconsumed — harness may be paused
                        </span>
                      ) : (
                        <span style={{ fontSize: 12, color: 'green' }}>✓ dispatched</span>
                      );
                    })()}
                    {s.status === 'consumed' && (
                      <span style={{ fontSize: 12, color: 'green' }}>✓ consumed</span>
                    )}
                    {s.status === 'escalated' && (
                      <span style={{ fontSize: 12, color: '#a40' }}>↑ escalated</span>
                    )}
                    {s.status === 'rejected' && (
                      <span style={{ fontSize: 12, color: 'red' }}>✗ rejected</span>
                    )}
                    {s.status === 'failed' && (
                      <span style={{ fontSize: 12, color: 'red' }}>
                        ✗ failed: {s.failureReason}
                      </span>
                    )}
                    {s.status === 'superseded' && (
                      <span style={{ fontSize: 12, opacity: 0.5 }}>↻ superseded</span>
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
