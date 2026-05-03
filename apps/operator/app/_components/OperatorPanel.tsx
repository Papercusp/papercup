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
import { findFuzzyDuplicate } from '../../lib/operator-fuzzy-dedup';

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
  /** Local deadline for foreground auto-dispatch affordance. */
  autoDispatchAt?: number;
  /** True when dismiss came from undo-window cancel (audit-only, no preferences entry). */
  undoCancelled?: boolean;
  /** Set after a successful send_message dispatch — drives receiving-state polling. */
  messageId?: string;
}

const UNCONSUMED_AGE_MS = 4 * 60_000; // 3 × 60s cadence + 60s grace = 4 min — fallback

function ageMs(card: SuggestionCard): number | null {
  return card.dispatchedAt ? Date.now() - card.dispatchedAt : null;
}

interface AckLatencyTable {
  perHarness: Record<string, number>;
  fallbackMs: number;
}

function unconsumedThresholdFor(card: SuggestionCard, table: AckLatencyTable | null): number {
  if (!table) return UNCONSUMED_AGE_MS;
  const target = card.target_harness;
  if (target && table.perHarness[target]) return table.perHarness[target];
  return table.fallbackMs;
}

function lifecycleLabel(status: LifecycleState): string {
  switch (status) {
    case 'pending':
      return 'Needs decision';
    case 'dispatched':
      return 'In flight';
    case 'consumed':
      return 'Consumed';
    case 'escalated':
      return 'Escalated';
    case 'rejected':
      return 'Rejected';
    case 'failed':
      return 'Failed';
    case 'dismissed':
      return 'Dismissed';
    case 'superseded':
      return 'Superseded';
    default:
      return status;
  }
}

function tierLabel(tier: SuggestionCard['actualTier']): string {
  return tier === 'high' ? 'High safety' : tier === 'medium' ? 'Medium safety' : 'Low safety';
}

type FeedFilter = 'all' | 'suggestions' | 'activity';
type ScanStatus = 'idle' | 'scanning' | 'complete' | 'error';

function lifecycleLabelForCard(card: SuggestionCard): string {
  if (card.action === 'inform' && card.status === 'pending') return 'Informational';
  if (card.auto_dispatch && card.status === 'pending') return 'Auto-fire pending';
  return lifecycleLabel(card.status);
}

function lifecycleClassForCard(card: SuggestionCard): string {
  if (card.action === 'inform' && card.status === 'pending') return 'inform';
  if (card.auto_dispatch && card.status === 'pending') return 'auto';
  return card.status;
}

function autoDispatchSeconds(card: SuggestionCard, now: number): number {
  if (!card.autoDispatchAt) return 0;
  return Math.max(0, Math.ceil((card.autoDispatchAt - now) / 1000));
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
  const [ackLatency, setAckLatency] = useState<AckLatencyTable | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const evtSrcRef = useRef<EventSource | null>(null);
  const [feedFilter, setFeedFilter] = useState<FeedFilter>('all');
  const [scanStatus, setScanStatus] = useState<ScanStatus>('idle');
  const [scanError, setScanError] = useState<string | null>(null);
  const [confirmingHigh, setConfirmingHigh] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => Date.now());


  // Subscribe to shared state.
  useEffect(() => {
    const fn = (partial: Partial<OperatorState>) =>
      setState((s) => ({ ...s, ...partial }));
    return subscribeOperatorState(fn);
  }, []);

  // Click-outside or Escape to close.
  useEffect(() => {
    if (!state.open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!panelRef.current) return;
      if (panelRef.current.contains(e.target as Node)) return;
      const target = e.target as HTMLElement;
      if (target.closest('[aria-label^="Operator"]')) return;
      broadcastState({ open: false });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') broadcastState({ open: false });
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [state.open]);
  useEffect(() => {
    if (!state.open) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [state.open]);


  // Kick off a scan when the panel opens.
  const startScan = useCallback((request?: string) => {
    if (evtSrcRef.current) {
      evtSrcRef.current.close();
      evtSrcRef.current = null;
    }
    setSuggestions([]);
    setStreamLog([]);
    setScanError(null);
    setScanStatus('scanning');
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
            const autoDispatchAt = s.auto_dispatch ? Date.now() + 5_000 : undefined;
            next[idx] = wasTerminal
              ? { ...prior, status: 'superseded' as LifecycleState }
              : { ...prior, ...s, status: 'pending', autoDispatchAt };
            if (wasTerminal) next.push({ ...s, status: 'pending', autoDispatchAt });
            return next;
          }
          // Fuzzy dedup: titles that paraphrase a still-pending card
          // collapse rather than stack. Only collapse against pending —
          // dispatched/dismissed cards have user-visible decisions we
          // shouldn't mask.
          const candidates = prev
            .filter((c) => c.status === 'pending')
            .map((c) => ({ id: c.id, title: c.title }));
          const fuzzy = findFuzzyDuplicate(s.title, candidates);
          if (fuzzy) {
            const fIdx = prev.findIndex((c) => c.id === fuzzy.matchedId);
            if (fIdx >= 0) {
              const dup = prev.slice();
              dup[fIdx] = {
                ...prev[fIdx],
                ...s,
                id: prev[fIdx].id,
                status: 'pending',
                autoDispatchAt: s.auto_dispatch ? Date.now() + 5_000 : undefined,
              };
              return dup;
            }
          }
          return [
            ...prev,
            { ...s, status: 'pending', autoDispatchAt: s.auto_dispatch ? Date.now() + 5_000 : undefined },
          ];
        });
        // Voice mode: speak the suggestion title + why-line.
        // Phase 6: append voice-readable provenance flags so users hear
        // when Operator overrode the LLM's claimed tier or fell back to
        // the unknown-cap fail-safe.
        if (getVoiceState().mode !== 'off') {
          let suffix = '';
          if (s.provenanceFlags?.tierMismatch) suffix += ' Warning: tier mismatch — substrate forced authoritative.';
          if (s.provenanceFlags?.capabilityUnknown) suffix += ' Warning: unknown capability — forced high.';
          // Escalation surfaces louder via assertive aria-live priority.
          const priority = s.actualTier === 'high' ? 'assertive' : 'polite';
          speak(`${s.title}. ${s.why}${suffix}`, 'system:operator', priority);
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
      setScanStatus('complete');
      setState((s) => ({ ...s, iconState: askFirstPending ? 'awaiting-input' : 'idle' }));
      es.close();
      evtSrcRef.current = null;
      void refreshDecisions();
    });
    es.addEventListener('error', (ev: MessageEvent) => {
      const detail = (ev as any).data ?? '(no detail)';
      setStreamLog((log) => [...log, `error: ${detail}`]);
      setScanError(String(detail));
      setScanStatus('error');
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

  // Receiving-state polling: while the panel is open, every 10s ask the
  // server for the current message.status of any 'dispatched' card with a
  // tracked messageId. Flip the card's lifecycle when the recipient picks
  // it up.
  useEffect(() => {
    if (!state.open) return;
    let cancelled = false;
    const tick = async () => {
      const cards = suggestionsRef.current.filter(
        (c) => c.status === 'dispatched' && c.messageId,
      );
      if (!cards.length) return;
      const ids = cards.map((c) => c.messageId!).join(',');
      try {
        const r = await fetch(`/api/agent-mcp/operator-message-status?ids=${encodeURIComponent(ids)}`);
        if (!r.ok || cancelled) return;
        const { rows } = (await r.json()) as {
          rows: { messageId: string; receivingState: 'dispatched' | 'consumed' | 'escalated' | 'rejected' }[];
        };
        if (cancelled || !rows.length) return;
        const byMsgId = new Map(rows.map((r) => [r.messageId, r.receivingState]));
        setSuggestions((prev) =>
          prev.map((c) => {
            if (!c.messageId || c.status !== 'dispatched') return c;
            const next = byMsgId.get(c.messageId);
            if (!next || next === 'dispatched') return c;
            // Lifecycle telemetry: log the receiving-state transition.
            void logAudit(c.id, next as 'consumed' | 'escalated' | 'rejected');
            return { ...c, status: next };
          }),
        );
      } catch {
        /* network blip — try again next tick */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [state.open]);

  // Adaptive unconsumed thresholds: refresh on open + every 30 min.
  useEffect(() => {
    if (!state.open) return;
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const r = await fetch('/api/agent-mcp/operator-ack-latency');
        if (!r.ok || cancelled) return;
        setAckLatency((await r.json()) as AckLatencyTable);
      } catch {
        /* keep last */
      }
    };
    void fetchOnce();
    const t = setInterval(() => void fetchOnce(), 30 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [state.open]);

  const hydrateFromLastScan = useCallback(async () => {
    try {
      const r = await fetch('/api/agent-mcp/operator-last-scan');
      if (!r.ok) return;
      const { snapshot } = (await r.json()) as {
        snapshot: {
          cards: (ParsedSuggestion & {
            _status?: LifecycleState;
            _dispatchedAt?: number;
            _undoCancelled?: boolean;
          })[];
        } | null;
      };
      if (!snapshot?.cards?.length) return;
      // Only hydrate when we have nothing on screen — never blow away an
      // in-flight scan.
      setSuggestions((prev) => {
        if (prev.length > 0) return prev;
        return snapshot.cards.map((c) => {
          const { _status, _dispatchedAt, _undoCancelled, ...rest } = c;
          const status = (_status ?? 'pending') as LifecycleState;
          return {
            ...rest,
            status,
            dispatchedAt: _dispatchedAt,
            autoDispatchAt: rest.auto_dispatch && status === 'pending' ? Date.now() + 5_000 : undefined,
            undoCancelled: _undoCancelled,
          };
        });
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


  // Voice-action provenance (v4 §2m): flipped to 'voice' for the duration
  // of voice-utterance-handled actions so logAudit tags them correctly.
  // Reset to 'click' otherwise.
  const actorMethodRef = useRef<'voice' | 'click' | 'api'>('click');

  const logAudit = useCallback(async (cardId: string, kind: 'dispatched' | 'acked' | 'undo_cancel' | 'consumed' | 'escalated' | 'rejected' | 'failed' | 'dismissed' | 'superseded', context?: Record<string, unknown>) => {
    try {
      await fetch('/api/agent-mcp/operator-audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cardId, kind, context, actorMethod: actorMethodRef.current }),
      });
    } catch {
      /* best-effort */
    }
  }, []);

  const dispatchSuggestion = useCallback(async (id: string) => {
    const card = suggestionsRef.current.find((c) => c.id === id);
    if (!card) return;
    setConfirmingHigh((prev) => {
      const { [id]: _removed, ...rest } = prev;
      return rest;
    });
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
        // Path-(b) ack: dispatch returned without error. Capture the
        // messageId so receiving-state polling can flip 'dispatched' →
        // 'consumed' once the recipient harness picks it up.
        let messageId: string | undefined;
        try {
          const data = await r.clone().json();
          messageId = data?.result?.inserted?.[0]?.messageId;
        } catch {
          /* response wasn't JSON — that's fine */
        }
        if (messageId) {
          setSuggestions((prev) =>
            prev.map((c) => (c.id === id ? { ...c, messageId } : c)),
          );
        }
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

  useEffect(() => {
    if (!state.open || state.paused) return;
    const due = suggestions.find(
      (s) => s.status === 'pending' && s.auto_dispatch && s.autoDispatchAt && s.autoDispatchAt <= now,
    );
    if (due) void dispatchSuggestion(due.id);
  }, [dispatchSuggestion, now, state.open, state.paused, suggestions]);

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
    // Record dismissal for the cooldown filter (so re-scans don't re-emit).
    void fetch('/api/agent-mcp/operator-dismissed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    // Lifecycle telemetry: dismissed (deliberate, not undo-cancel).
    void logAudit(id, 'dismissed');
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

  // Voice mode: subscribe to final utterances while panel is open and
  // route commands to Operator actions. Falls through to scan(query)
  // when no strict command matches.
  useEffect(() => {
    if (!state.open) return;
    const dereg = registerVoiceConsumer('OperatorPanel');
    const unsub = onFinalUtterance(async (text) => {
      if (!text || text.length < 2) return;
      // v4 §2m: tag voice-initiated audit rows. Restore on next macrotask.
      actorMethodRef.current = 'voice';
      try {
        const { parseVoiceCommand } = await import('../../lib/voice-commands');
        const cmd = parseVoiceCommand(text);
        const orderedPending = suggestionsRef.current.filter((c) => c.status === 'pending');
        const pickByOrdinal = (ord?: number) => {
          if (ord === undefined) return orderedPending[0];
          return orderedPending[ord - 1];
        };
        switch (cmd.kind) {
          case 'dispatch': {
            const card = pickByOrdinal(cmd.ordinal);
            if (card) await dispatchSuggestion(card.id);
            return;
          }
          case 'dismiss': {
            const card = pickByOrdinal(cmd.ordinal);
            if (card) dismissSuggestion(card.id);
            return;
          }
          case 'pause':
            broadcastState({ paused: true });
            return;
          case 'resume':
            broadcastState({ paused: false });
            return;
          case 'cancel':
            return;
          case 'scan':
            startScan(cmd.query);
            return;
          case 'freeform':
          default:
            startScan(cmd.text);
        }
      } finally {
        setTimeout(() => { actorMethodRef.current = 'click'; }, 50);
      }
    });
    return () => {
      dereg();
      unsub();
    };
  }, [state.open, startScan, dispatchSuggestion, dismissSuggestion]);

  const pendingCount = suggestions.filter((s) => s.status === 'pending').length;
  const inFlightCount = suggestions.filter((s) => s.status === 'dispatched').length;
  const failedCount = suggestions.filter((s) =>
    s.status === 'failed' || s.status === 'escalated' || s.status === 'rejected',
  ).length;
  const terminalCount = suggestions.filter((s) =>
    s.status === 'consumed' || s.status === 'dismissed' || s.status === 'superseded',
  ).length;
  const visibleSuggestions = feedFilter === 'activity' ? [] : suggestions;
  const visibleDecisions = feedFilter === 'suggestions' ? [] : decisions;
  const hasFeedEntries = visibleSuggestions.length > 0 || visibleDecisions.length > 0;
  const streamMuted = scanStatus === 'complete' && suggestions.length > 0;
  const emptyTitle = feedFilter === 'activity'
    ? 'No user-started actions yet'
    : scanStatus === 'error'
      ? 'Operator scan needs setup'
      : scanStatus === 'scanning'
        ? 'Scanning workspace…'
        : scanStarted
          ? "Operator hasn't surfaced anything"
          : 'No operator entries yet';
  const emptyBody = feedFilter === 'activity'
    ? 'Replan, Cleanup, Snapshot, and plugin actions will appear here as they run and settle.'
    : scanStatus === 'error'
      ? 'The scan did not complete. Check Operator settings or provision the substrate before scanning again.'
      : scanStatus === 'scanning'
        ? 'Operator is checking workspace state, recent decisions, and pending harness work.'
        : 'Suggestions and long-running user actions will appear here in one timeline. Use Re-scan when you want Operator to reassess the workspace.';
  const statusLabel = state.paused ? 'paused' : state.iconState.replace('-', ' ');

  if (!state.open) return null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Operator panel"
      className={`operator-panel operator-panel--${state.iconState}${state.paused ? ' is-paused' : ''}`}
    >
      <header className="operator-panel__header">
        <div className="operator-panel__titleblock">
          <div className="operator-panel__titleline">
            <h2>Operator</h2>
            <span className={`operator-status operator-status--${state.paused ? 'paused' : state.iconState}`}>
              {statusLabel}
            </span>
          </div>
        </div>

        <div className="operator-panel__metrics" aria-label="Operator panel summary">
          <span title="pending = pending suggestions"><strong>{pendingCount}</strong><em>pending</em></span>
          <span title="in flight = dispatched suggestions"><strong>{inFlightCount}</strong><em>in flight</em></span>
          <span title="attention = escalated, failed, or rejected suggestions"><strong>{failedCount}</strong><em>attention</em></span>
          <span title="resolved = consumed, dismissed, or superseded suggestions"><strong>{terminalCount}</strong><em>resolved</em></span>
        </div>

        <div className="operator-panel__actions">
          <button
            type="button"
            className="operator-btn operator-btn--primary operator-btn--icon"
            onClick={() => startScan()}
            aria-label="Re-scan Operator suggestions"
          >
            <span aria-hidden="true">↻</span>
            <span>Scan</span>
          </button>
          <button
            type="button"
            className="operator-btn operator-btn--icon"
            onClick={() => broadcastState({ paused: !state.paused })}
            aria-label={state.paused ? 'Resume autonomous actions' : 'Pause autonomous actions'}
          >
            <span aria-hidden="true">{state.paused ? '▶' : '⏸'}</span>
            <span>{state.paused ? 'Resume' : 'Pause'}</span>
          </button>
          <a className="operator-btn operator-btn--ghost" href="/settings/operator">
            Settings
          </a>
          <button
            type="button"
            className="operator-btn operator-btn--close"
            onClick={() => broadcastState({ open: false })}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </header>

      {budget && !budget.configured && (
        <div className="operator-budget-overlay">
          <div className="operator-budget-card">
            <div className="operator-panel__eyebrow">First run</div>
            <h3>Pick a daily budget for Operator</h3>
            <p>
              Operator stops scanning automatically when today&apos;s spend reaches the cap.
              You can change this any time at <a href="/settings/operator">/settings/operator</a>.
            </p>
            <div className="operator-budget-options">
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
                  className="operator-budget-option"
                >
                  <strong>{label} — ${cap}/day</strong>
                  <span>{blurb}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="operator-panel__body">
        <aside className="operator-panel__rail operator-panel__rail--left">
          {firstRun && (
            <section className="operator-callout">
              <strong>First-run intro</strong>
              <p>
                I have full write authority across all harnesses in this workspace.
                Edit my prompt or preferences from <a href="/settings/operator">/settings/operator</a>.
              </p>
            </section>
          )}
          <section className="operator-section">
            <PerHarnessStatus />
          </section>
          <section className="operator-section">
            <OtherWorkspacesPanel />
          </section>
          <section className={`operator-section operator-stream${streamMuted ? ' operator-stream--muted' : ''}${scanStatus === 'error' ? ' operator-stream--error' : ''}`}>
            <div className="operator-section__head">
              <span>Stream</span>
              <em>{scanStatus === 'error' ? 'error' : scanStatus === 'scanning' ? 'live scan' : scanStatus === 'complete' ? 'complete' : 'quiet'}</em>
            </div>
            {scanStatus === 'error' ? (
              <div className="operator-stream-error">
                <strong>Scan errored</strong>
                <p>{scanError || 'Operator substrate is not ready.'}</p>
                <a href="/settings/operator">Set up Operator →</a>
              </div>
            ) : streamLog.length === 0 ? (
              <p className="operator-empty-small">(no stream yet)</p>
            ) : (
              <pre>{streamLog.join('\n')}</pre>
            )}
          </section>
        </aside>

        <main className="operator-panel__feed">
          <div className="operator-feed-head">
            <div>
              <span className="operator-panel__eyebrow">Unified timeline</span>
              <h3>Timeline</h3>
            </div>
            <div className="operator-feed-pills" aria-label="Timeline view">
              {[
                { key: 'all' as FeedFilter, label: 'All', count: suggestions.length + decisions.length },
                { key: 'suggestions' as FeedFilter, label: 'Suggestions', count: suggestions.length },
                { key: 'activity' as FeedFilter, label: 'Activity', count: decisions.length },
              ].map((pill) => (
                <button
                  key={pill.key}
                  type="button"
                  className={feedFilter === pill.key ? 'is-active' : undefined}
                  aria-pressed={feedFilter === pill.key}
                  onClick={() => setFeedFilter(pill.key)}
                >
                  <span>{pill.label}</span>
                  <strong>{pill.count}</strong>
                </button>
              ))}
            </div>
          </div>

          {!hasFeedEntries ? (
            <div className={`operator-empty-state operator-empty-state--${scanStatus}`}>
              <div className="operator-empty-state__icon" aria-hidden="true">
                {scanStatus === 'error' ? '!' : scanStatus === 'scanning' ? '◐' : '·'}
              </div>
              <h3>{emptyTitle}</h3>
              <p>{emptyBody}</p>
              {scanStatus === 'error' && (
                <a className="operator-btn operator-btn--primary" href="/settings/operator">
                  Set up Operator →
                </a>
              )}
            </div>
          ) : (
            <ul role="list" aria-label="Operator timeline" className="operator-feed-list">
              {visibleSuggestions.map((s) => (
                <li
                  key={s.id}
                  role="article"
                  aria-label={`${s.title} — ${s.actualTier} tier, ${s.auto_dispatch ? 'auto-dispatched' : 'awaiting your decision'}`}
                  tabIndex={0}
                  className={`operator-entry operator-entry--suggestion operator-entry--${s.status} operator-entry--tier-${s.actualTier}`}
                >
                  <div className="operator-entry__rail">
                    <span title={s.auto_dispatch ? 'Auto-dispatch suggestion' : s.actualTier === 'high' ? 'High-risk review required' : 'Ask-first suggestion'}>
                      {s.auto_dispatch ? '⚡' : s.actualTier === 'high' ? '✋' : '?'}
                    </span>
                  </div>
                  <div className="operator-entry__content">
                    <div className="operator-entry__meta">
                      <span className="operator-kind">Suggestion</span>
                      <span className="operator-meta-sep" aria-hidden="true">·</span>
                      <span className={`operator-tier operator-tier--${s.actualTier}`}>{tierLabel(s.actualTier)}</span>
                      <span className="operator-meta-sep" aria-hidden="true">·</span>
                      <span className={`operator-life operator-life--${lifecycleClassForCard(s)}`}>{lifecycleLabelForCard(s)}</span>
                      {s.target_harness && (
                        <>
                          <span className="operator-meta-sep" aria-hidden="true">·</span>
                          <span className="operator-target">{s.target_harness}</span>
                        </>
                      )}
                      <span className="operator-voice-slot" aria-hidden="true" />
                    </div>
                    <div className="operator-entry__title-row">
                      <h4>{s.title}</h4>
                      <span className="operator-entry__action-kind">{s.action}</span>
                    </div>
                    <p className="operator-entry__why">{s.why}</p>

                    {(s.provenanceFlags?.tierMismatch || s.provenanceFlags?.capabilityUnknown) && (
                      <div className="operator-entry__flags" aria-label="Provenance warnings">
                        {s.provenanceFlags?.tierMismatch && (
                          <span title="LLM-claimed tier overridden by substrate">⚠ tier corrected</span>
                        )}
                        {s.provenanceFlags?.capabilityUnknown && (
                          <span title="Unknown capability — forced high (fail-safe)">⚠ capability unknown</span>
                        )}
                      </div>
                    )}

                    {s.action === 'send_directive' && s.directive_body && (
                      <details className="operator-entry__details">
                        <summary>Directive body</summary>
                        <div>
                          <MarkdownPreview value={s.directive_body} outline="left" />
                        </div>
                      </details>
                    )}
                    {s.action === 'inform' && s.body && (
                      <div className="operator-entry__markdown">
                        <MarkdownPreview value={s.body} outline="left" />
                      </div>
                    )}
                    {s.action === 'navigate' && s.target_resource && (
                      <a
                        href={s.target_resource}
                        target="_blank"
                        rel="noreferrer"
                        className="operator-entry__link"
                      >
                        Open {s.target_resource}
                      </a>
                    )}

                    <div className="operator-entry__footer">
                      <div className="operator-entry__buttons">
                        {s.action === 'send_directive' && s.status === 'pending' && s.auto_dispatch && (
                          <button type="button" className="operator-mini-btn operator-mini-btn--auto" onClick={() => undoCancelSuggestion(s.id)}>
                            Cancel auto
                          </button>
                        )}
                        {s.action === 'send_directive' && s.status === 'pending' && !s.auto_dispatch && s.actualTier !== 'high' && (
                          <button type="button" className="operator-mini-btn operator-mini-btn--primary" onClick={() => dispatchSuggestion(s.id)}>
                            Dispatch
                          </button>
                        )}
                        {s.action === 'send_directive' && s.status === 'pending' && !s.auto_dispatch && s.actualTier === 'high' && !confirmingHigh[s.id] && (
                          <button type="button" className="operator-mini-btn operator-mini-btn--danger" onClick={() => setConfirmingHigh((prev) => ({ ...prev, [s.id]: true }))}>
                            Review high-risk
                          </button>
                        )}
                        {s.action === 'send_directive' && s.status === 'pending' && !s.auto_dispatch && s.actualTier === 'high' && confirmingHigh[s.id] && (
                          <div className="operator-confirm-strip">
                            <span>Confirm high-risk dispatch{s.target_harness ? ` to ${s.target_harness}` : ''}</span>
                            <button type="button" className="operator-mini-btn operator-mini-btn--danger" onClick={() => dispatchSuggestion(s.id)}>
                              Confirm dispatch
                            </button>
                            <button type="button" className="operator-mini-btn" onClick={() => setConfirmingHigh((prev) => {
                              const { [s.id]: _removed, ...rest } = prev;
                              return rest;
                            })}>
                              Cancel
                            </button>
                          </div>
                        )}
                        {s.status === 'pending' && !s.auto_dispatch && (
                          <button type="button" className="operator-mini-btn" onClick={() => dismissSuggestion(s.id)}>
                            Dismiss
                          </button>
                        )}
                      </div>
                      <div className="operator-entry__state">
                        {s.status === 'pending' && s.auto_dispatch && (
                          <span className="operator-state-text operator-state-text--auto">
                            ⚡ Auto-dispatching in {autoDispatchSeconds(s, now)}s
                          </span>
                        )}
                        {s.status === 'pending' && s.action === 'inform' && (
                          <span className="operator-state-text operator-state-text--muted">read-only</span>
                        )}
                        {s.status === 'dispatched' && (() => {
                          const age = ageMs(s);
                          const threshold = unconsumedThresholdFor(s, ackLatency);
                          const unconsumed = age !== null && age > threshold;
                          return unconsumed ? (
                            <span className="operator-state-text operator-state-text--warn" title={`pending for ${Math.round(age! / 60000)}m (threshold ${Math.round(threshold / 60000)}m)`}>
                              ⏳ unconsumed — harness may be paused
                            </span>
                          ) : (
                            <span className="operator-state-text operator-state-text--good">✓ dispatched</span>
                          );
                        })()}
                        {s.status === 'consumed' && (
                          <span className="operator-state-text operator-state-text--good">✓ consumed</span>
                        )}
                        {s.status === 'escalated' && (
                          <span className="operator-state-text operator-state-text--warn">↑ escalated</span>
                        )}
                        {s.status === 'rejected' && (
                          <span className="operator-state-text operator-state-text--bad">✗ rejected</span>
                        )}
                        {s.status === 'failed' && (
                          <span className="operator-state-text operator-state-text--bad">✗ failed: {s.failureReason}</span>
                        )}
                        {s.status === 'superseded' && (
                          <span className="operator-state-text operator-state-text--muted">↻ superseded</span>
                        )}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
              {visibleDecisions.map((r) => (
                <li key={`activity:${r.id}`} role="article" className="operator-entry operator-entry--action" tabIndex={0}>
                  <div className="operator-entry__rail">
                    <span title="User-initiated activity">↻</span>
                  </div>
                  <div className="operator-entry__content">
                    <div className="operator-entry__meta">
                      <span className="operator-kind operator-kind--activity">Activity</span>
                      <span className="operator-meta-sep" aria-hidden="true">·</span>
                      <span className="operator-life operator-life--consumed">Recorded</span>
                      <span className="operator-meta-sep" aria-hidden="true">·</span>
                      <span className="operator-target">{r.target}</span>
                    </div>
                    <div className="operator-entry__title-row">
                      <h4>{r.action}</h4>
                      <span className="operator-entry__action-kind">{new Date(r.ts).toLocaleString()}</span>
                    </div>
                    <p className="operator-entry__why">User-initiated action recorded by Operator.</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </main>

        <aside className="operator-panel__rail operator-panel__rail--right">
          <div className="operator-section__head">
            <span>Activity</span>
            <em>{decisions.length ? 'recent decisions' : 'waiting'}</em>
          </div>
          {decisions.length === 0 ? (
            <div className="operator-empty-side">
              <strong>No actions yet.</strong>
              <p>User-started work such as Replan, Cleanup, Snapshot, and plugin changes will live here.</p>
            </div>
          ) : (
            <ul className="operator-activity-list">
              {decisions.map((r) => (
                <li key={r.id} className="operator-activity-item">
                  <span className="operator-activity-dot" aria-hidden="true" />
                  <div>
                    <strong>{r.action}</strong>
                    <p>
                      {r.target}{' '}
                      <span>· {new Date(r.ts).toLocaleString()}</span>
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      <footer className="operator-panel__footer">
        <span>Cmd/Ctrl+K then O to toggle • Click outside to close</span>
        <span>Operator MCP v0.1.0</span>
      </footer>
    </div>
  );
}

interface HarnessOneLiner {
  slug: string;
  status: string;
  lastTouched: string | null;
}

function PerHarnessStatus(): JSX.Element | null {
  const [rows, setRows] = useState<HarnessOneLiner[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/agent-mcp/operator-trigger-state')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.state?.perHarness) return;
        setRows(d.state.perHarness);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  if (!rows?.length) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <h3 style={{ margin: 0, marginBottom: 8, fontSize: 12, opacity: 0.7, textTransform: 'uppercase' }}>
        Harnesses
      </h3>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4, fontSize: 12 }}>
        {rows.slice(0, 8).map((h) => (
          <li key={h.slug} style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--mono, monospace)' }}>{h.slug}</span>
            <span style={{ opacity: 0.6 }}>{h.status}</span>
          </li>
        ))}
        {rows.length > 8 && (
          <li style={{ opacity: 0.5 }}>+{rows.length - 8} more</li>
        )}
      </ul>
    </div>
  );
}

interface ForeignCard {
  workspaceId: string;
  workspaceName: string;
  card: { id?: string; title?: string; action?: string; auto_dispatch?: boolean };
  dismissed: boolean;
}

interface MultiWorkspaceSnapshot {
  cards: ForeignCard[];
  workspaces: { id: string; name: string; cardCount: number; scanCompletedAt: string | null }[];
}

function OtherWorkspacesPanel(): JSX.Element | null {
  const [snap, setSnap] = useState<MultiWorkspaceSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/agent-mcp/operator-multi-workspace')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setSnap(d as MultiWorkspaceSnapshot);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  if (!snap?.workspaces?.length) return null;
  const switchTo = async (id: string) => {
    try {
      const m = await import('../../lib/workspaces-tauri');
      await m.switchWorkspace(id, { resetTo: `/harness?ws=${encodeURIComponent(id)}` });
    } catch {
      // Web mode — fall back to a hard navigate.
      window.location.assign(`/harness?ws=${encodeURIComponent(id)}`);
    }
  };
  const visibleCards = snap.cards.filter((c) => !c.dismissed).slice(0, 3);
  return (
    <div className="operator-workspaces">
      <h3>
        Other workspaces
      </h3>
      <ul className="operator-workspace-list">
        {snap.workspaces.map((w) => (
          <li key={w.id} className="operator-workspace-row">
            <button
              type="button"
              onClick={() => void switchTo(w.id)}
            >
              {w.name}
            </button>
            {w.cardCount > 0 && (
              <span className="operator-workspace-count">
                {w.cardCount}
              </span>
            )}
          </li>
        ))}
      </ul>
      {visibleCards.length > 0 && (
        <ul className="operator-workspace-cards">
          {visibleCards.map((c, i) => (
            <li key={`${c.workspaceId}-${c.card.id ?? i}`}>
              <button
                type="button"
                onClick={() => void switchTo(c.workspaceId)}
                title={`${c.workspaceName} · ${c.card.title ?? '(untitled)'}`}
              >
                {c.card.title ?? '(untitled)'}
              </button>
              <span>{c.card.auto_dispatch ? 'auto' : 'ask'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
