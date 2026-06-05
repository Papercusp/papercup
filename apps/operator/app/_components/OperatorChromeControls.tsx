'use client';

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Select } from '../harness/Select';
import { Modal } from '../harness/Modal';
import { DeckCardsMark } from './ChromeNavMarks';
import { OperatorPanel } from './OperatorPanel';
import {
  AUTO_ACCEPT_LEVELS,
  broadcastState,
  hydrateOperatorStateFromPg,
  isAutoAcceptLevel,
  sharedState,
  subscribeOperatorState,
  type AutoAcceptEvent,
  type AutoAcceptLevel,
  type IconState,
  type OperatorState,
} from '@papercusp/operator-core/lib/operator-shared-state';

export function OperatorButton(): ReactElement {
  const [state, setState] = useState<OperatorState>(sharedState);

  useEffect(() => {
    const fn = (partial: Partial<OperatorState>) =>
      setState((s) => ({ ...s, ...partial }));
    void hydrateOperatorStateFromPg();
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
      if (armed && e.key.toLowerCase() === 'd') {
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

  const pausedActive = state.paused && (state.iconState === 'idle' || state.iconState === 'awaiting-input');
  const titleByState: Record<IconState, string> = {
    idle: 'Deck — Papercup idle',
    scanning: 'Deck — Papercup scanning workspace',
    thinking: 'Deck — Papercup composing suggestions',
    acting: 'Deck — Papercup dispatching',
    paused: 'Deck — Papercup paused (autonomous actions disabled)',
    'awaiting-input': 'Deck — Papercup awaiting your decision on pending suggestions',
  };
  let title: string;
  if (pausedActive) title = titleByState.paused;
  else if (state.paused) title = `${titleByState[state.iconState]} (paused — auto-dispatch off)`;
  else title = titleByState[state.iconState];
  const scanning = state.iconState === 'scanning' || state.iconState === 'thinking';
  const counts = useMemo(() => {
    const c = { pending: 0, accepted: 0, ignored: 0 };
    for (const card of state.cards) {
      if (card.status === 'pending') c.pending++;
      else if (card.status === 'accepted') c.accepted++;
      else if (card.status === 'ignored') c.ignored++;
    }
    return c;
  }, [state.cards]);
  const buttonLabel = `${title}. ${counts.pending} pending, ${counts.accepted} accepted, ${counts.ignored} ignored.`;

  return (
    <>
      <span className="pc-header-cta-shell pc-header-cta-shell--operator">
        <button
          className={`pc-header-cta pc-header-cta--operator pc-header-cta--${state.iconState}${state.paused ? ' is-paused' : ''}${scanning ? ' is-scanning' : ''}${state.autoAccept !== 'off' ? ' is-auto' : ''}`}
          aria-label={buttonLabel}
          onClick={toggle}
          aria-expanded={state.open}
          style={{ marginLeft: 8 }}
        >
          <span className="pc-header-cta-orb" aria-hidden="true">
            <DeckCardsMark className="pc-header-cta-logo pc-header-cta-logo--deck" />
            {scanning && <span className="pc-header-cta-scan-ring" aria-hidden="true" />}
            {state.autoAccept !== 'off' && !scanning && <span className="pc-header-cta-auto-dot" aria-hidden="true" />}
          </span>
          <span className="pc-header-cta-label">DECK</span>
        </button>
        <div
          role="status"
          aria-label={`Deck card counts: ${counts.pending} pending, ${counts.accepted} accepted, ${counts.ignored} ignored`}
          aria-live="polite"
          className="pc-operator-popdown"
        >
          <OperatorCountBubble label="pending" count={counts.pending} tone="pending" />
          <OperatorCountBubble label="accepted" count={counts.accepted} tone="accepted" />
          <OperatorCountBubble label="ignored" count={counts.ignored} tone="ignored" />
        </div>
        <OperatorAutoAcceptFeed events={state.recentAutoAccepts} />
      </span>
      {state.open ? (
        <Modal
          open={state.open}
          onOpenChange={(open) => broadcastState({ open })}
          title="Deck"
          description="Operator deck for scanning the workspace, reviewing suggestions, and inspecting live operator activity."
          srOnlyTitle
          zIndex={1180}
          closeOnEscape
          closeOnOutsideClick={false}
          closeOnOverlayClick
          modal={false}
          // Keep the Papercup chat sidebar outside the Deck scrim. The chat is
          // persistent operator chrome: do not blur it, cover it, trap focus away
          // from it, or make it non-interactive while Deck is open.
          overlayStyle={{
            left: 'var(--op-chat-w, 0px)',
            background: 'color-mix(in srgb, var(--bg-deepest), transparent 16%)',
            backdropFilter: 'blur(6px) saturate(0.6)',
            WebkitBackdropFilter: 'blur(6px) saturate(0.6)',
          }}
          contentClassName="operator-panel-dialog"
          nonDismissableOutsideSelector=".op-chat-sidebar"
        >
          <OperatorPanel />
        </Modal>
      ) : null}
    </>
  );
}

const TIER_DOT_COLOR: Record<'low' | 'medium' | 'high', string> = {
  low: 'var(--good)',
  medium: 'var(--warn)',
  high: 'var(--bad)',
};

function formatRelativeAgo(now: number, then: number): string {
  const ms = Math.max(0, now - then);
  const sec = Math.floor(ms / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function OperatorAutoAcceptFeed({ events }: { events: readonly AutoAcceptEvent[] }): ReactElement | null {
  // Tick once per 30s so relative-time labels refresh while the feed is visible.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (events.length === 0) return;
    const t = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [events.length]);
  if (events.length === 0) return null;
  const now = Date.now();

  return (
    <div
      role="region"
      aria-label="Recent auto-accepted cards"
      className="pc-operator-auto-feed"
    >
      <div className="pc-operator-auto-feed__head">
        <span className="pc-operator-auto-feed__title">Auto-accepted</span>
        <span className="pc-operator-auto-feed__count">{events.length}</span>
      </div>
      <ul className="pc-operator-auto-feed__list">
        {events.slice(0, 5).map((e) => (
          <li key={e.id} className="pc-operator-auto-feed__row">
            <span
              aria-hidden="true"
              className="pc-operator-auto-feed__tier-dot"
              style={{ background: TIER_DOT_COLOR[e.tier] }}
            />
            <span className="pc-operator-auto-feed__title-cell" title={e.title}>{e.title}</span>
            {e.targetHarness && (
              <span className="pc-operator-auto-feed__harness">{e.targetHarness}</span>
            )}
            <span className="pc-operator-auto-feed__age">{formatRelativeAgo(now, e.acceptedAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OperatorCountBubble({
  label,
  count,
  tone,
}: {
  label: 'pending' | 'accepted' | 'ignored';
  count: number;
  tone: 'pending' | 'accepted' | 'ignored';
}): ReactElement {
  return (
    <span
      className={`pc-operator-count-bubble pc-operator-count-bubble--${tone}`}
      aria-label={`${count} ${label}`}
      title={`${count} ${label}`}
    >
      {count}
    </span>
  );
}

// Auto-accept threshold control — explicit dropdown instead of an opaque
// cycle-on-click toggle so the current policy stays obvious.
const AUTO_ACCEPT_LABEL: Record<AutoAcceptLevel, string> = {
  off: 'Auto: Off',
  low: 'Auto: Low',
  medium: 'Auto: Med',
  high: 'Auto: High',
};
const AUTO_ACCEPT_TOOLTIP: Record<AutoAcceptLevel, string> = {
  off: 'Auto-accept is off. Every suggestion waits for your decision.',
  low: 'Auto-accept is set to low. Only low-risk cards auto-accept after a 10s review window.',
  medium: 'Auto-accept is set to medium. Low- and medium-risk cards auto-accept after a 10s review window.',
  high: 'Auto-accept is set to high. Every card auto-fires after a 10s review window, including high-risk actions.',
};

export function OperatorAutoScanToggle(): ReactElement {
  const [autoAccept, setAutoAcceptState] = useState<AutoAcceptLevel>(sharedState.autoAccept);
  useEffect(() => {
    return subscribeOperatorState((s) => {
      if (s.autoAccept) setAutoAcceptState(s.autoAccept);
    });
  }, []);
  return (
    <span className="pc-header-cta-select-shell" style={{ marginLeft: 4 }}>
      <Select
        value={autoAccept}
        onChange={(value) => {
          if (!isAutoAcceptLevel(value)) return;
          broadcastState({ autoAccept: value });
        }}
        ariaLabel={AUTO_ACCEPT_TOOLTIP[autoAccept]}
        triggerClassName={`pc-header-cta-select${autoAccept !== 'off' ? ' is-on' : ''}`}
        options={AUTO_ACCEPT_LEVELS.map((value) => ({
          value,
          label: AUTO_ACCEPT_LABEL[value],
        }))}
      />
    </span>
  );
}
