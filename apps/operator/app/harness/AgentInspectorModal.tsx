'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import {
  useAgentThinkingStream,
  Entry,
  waitingMessage,
  groupEntriesIntoTurns,
  ThinkingDot,
  fmtEntryTime,
  type Turn,
} from './AgentThinkingStream';

/**
 * AgentInspectorModal — the pinned, full-height view of a run's live thinking
 * stream. Opened by clicking a running agent's row in the AgentsRoster
 * (operator-vite's AgentsRunningPill → onInspect), the LIVE surface for this
 * — NOT a hover popover (EI-5917/WI-2346: AgentThinkingStream.tsx used to also
 * export a default `AgentThinkingPopover` hover component with no JSX caller
 * anywhere in the tree; it was deleted and only its shared hook/renderer
 * exports below survive, reused here).
 *
 * It does NOT dismiss on mouse-leave, so the whole transcript can be read +
 * scrolled. It reuses the shared stream hook + Entry renderer, but presents
 * the timeline grouped into TURNS, NEWEST-FIRST: the turn the agent is
 * currently working streams live at the TOP as "● Live turn" (with a pulsing
 * thinking indicator), and when it completes it becomes the top of the
 * completed-turns list below it — each older turn beneath, latest highest.
 *
 * Empty-timeline state reuses the shared `waitingMessage` helper (WI-1325): a
 * live run producing ZERO output for STALL_AFTER_MS escalates from a hopeful
 * "Waiting…" to a "⚠ no output for {elapsed} — stalled/rate-limited" warning +
 * a "stalled?" header, so a wedged agent stops reading as an eternal green
 * "live · No output yet".
 */
export default function AgentInspectorModal({
  slug,
  phase,
  runId,
  role,
  open,
  onClose,
  startedAtMs,
  streamUrl,
  focusTarget,
}: {
  slug: string;
  phase: string;
  runId: string;
  role: string;
  open: boolean;
  onClose: () => void;
  /** Run start (epoch-ms). Drives the elapsed counter + stall detection while
   *  the timeline is still empty. Optional — defaults to when the inspector was
   *  opened, so a wedged run still escalates from "waiting" to "stalled?". */
  startedAtMs?: number;
  /** Explicit stream URL — set for interactive-session transcripts; omit to use
   *  the bee run-log stream keyed by slug/runId. */
  streamUrl?: string;
  /** The agent's OS terminal-window handle — passed ONLY when focus will work (a
   *  stored X11 `windowId`). Present ⇒ a "Focus window" button that raises the
   *  agent's terminal via `POST /api/adv/sessions/focus`; absent ⇒ no button. */
  focusTarget?: { advSessionId?: number | null; windowId?: string | null; pid?: number | null };
}) {
  const { events, status, thinking } = useAgentThinkingStream(slug, phase, runId, streamUrl);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Elapsed baseline: the run start when known, else when this inspector opened
  // (captured once). Feeds the stall escalation while the timeline is empty.
  const openedAtRef = useRef<number>(Date.now());
  const [now, setNow] = useState(() => Date.now());
  // Tick a 1s clock ONLY while still waiting on the first output (empty timeline,
  // not terminal) so the elapsed counter + stall escalation update live.
  useEffect(() => {
    if (events.length > 0 || status === 'done') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [events.length, status]);

  // Group the flat timeline into turns and show them NEWEST-FIRST (latest highest).
  // The newest turn is the "live" one while the agent is actively thinking; when a
  // turn completes it just becomes the top of the completed list below.
  const turns = useMemo(() => groupEntriesIntoTurns(events), [events]);
  const ordered = useMemo(() => [...turns].reverse(), [turns]);

  // Newest turn is at the TOP, so keep the scroll pinned to the top as new turns /
  // entries stream in — unless the user scrolled DOWN to read history.
  const atTopRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atTopRef.current) el.scrollTop = 0;
  }, [events]);

  // "Focus window" — raise the agent's OS terminal via the existing wmctrl-backed
  // endpoint. Only wired when the caller passed a focusTarget (i.e. focus will work).
  const [focusState, setFocusState] = useState<'idle' | 'busy' | 'err'>('idle');
  const focusWindow = useCallback(async () => {
    if (!focusTarget) return;
    setFocusState('busy');
    try {
      const res = await fetch('/api/adv/sessions/focus', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: focusTarget.advSessionId ?? undefined,
          windowId: focusTarget.windowId ?? undefined,
          pid: focusTarget.pid ?? undefined,
        }),
      });
      setFocusState(res.ok ? 'idle' : 'err');
    } catch {
      setFocusState('err');
    }
  }, [focusTarget]);

  const elapsedMs = Math.max(0, now - (startedAtMs ?? openedAtRef.current));
  const waiting = waitingMessage(status, elapsedMs);
  // A live run sitting on zero output past the stall threshold reads as
  // "stalled?" instead of a reassuring green "live" (shared waitingMessage logic).
  const stalledNow = events.length === 0 && status === 'live' && waiting.stalled;
  const statusLabel = stalledNow ? 'stalled?' : status === 'connecting' ? 'connecting…' : status;
  const statusColor = stalledNow ? '#d97757'
    : status === 'live' ? '#6aa84f'
    : status === 'error' ? '#d97757'
    : '#9a9a9a';

  return (
    <Modal
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Agent inspector — ${role}`}
      srOnlyTitle
      contentStyle={{
        width: 'min(880px, 94vw)',
        height: 'min(78vh, 900px)',
        padding: 0,
        background: 'var(--bg-1)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        color: 'var(--fg)',
      }}
    >
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--bg-2)',
        fontSize: 12,
      }}>
        <span style={{ color: 'var(--fg-mute)' }}>
          <strong style={{ color: 'var(--fg)' }}>{role}</strong>
          {' · '}<code style={{ fontSize: 11 }}>{runId}</code>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {focusTarget ? (
            <button
              type="button"
              data-testid="focus-window-btn"
              onClick={focusWindow}
              disabled={focusState === 'busy'}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                font: 'inherit', fontSize: 11, cursor: focusState === 'busy' ? 'default' : 'pointer',
                color: focusState === 'err' ? '#d97757' : 'var(--fg)',
                background: 'var(--bg-1)', border: '1px solid var(--border)',
                borderRadius: 5, padding: '2px 8px', lineHeight: 1.4,
              }}
            >
              <span aria-hidden>⤢</span>
              {focusState === 'busy' ? 'focusing…' : focusState === 'err' ? 'focus failed' : 'Focus window'}
            </button>
          ) : null}
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {thinking ? <ThinkingDot size={7} /> : (
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor }} />
            )}
            <span style={{ color: thinking ? '#6aa84f' : statusColor }}>{thinking ? 'thinking…' : statusLabel}</span>
            <span style={{ color: 'var(--fg-mute)' }}>· {turns.length} turn{turns.length === 1 ? '' : 's'} · {events.length} event{events.length === 1 ? '' : 's'}</span>
          </span>
        </span>
      </div>
      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) atTopRef.current = el.scrollTop < 40;
        }}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 14,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        {events.length === 0 ? (
          <div style={{ color: waiting.stalled ? '#d97757' : 'var(--fg-mute)', fontStyle: 'italic' }}>
            {waiting.text}
          </div>
        ) : (
          ordered.map((turn, i) => (
            <TurnBlock key={turn.seq} turn={turn} live={thinking && i === 0} />
          ))
        )}
      </div>
    </Modal>
  );
}

/**
 * One turn rendered as a bordered block: a header (● Live turn while streaming,
 * else "Turn N" + its time) over the turn's prompt + activity. The live turn sits
 * at the TOP of the pane (newest-first) and is accented + pulsing.
 */
function TurnBlock({ turn, live }: { turn: Turn; live: boolean }) {
  const time = fmtEntryTime(turn.startTs);
  const accent = live ? 'var(--accent, #38bdf8)' : 'var(--border)';
  return (
    <div
      data-testid={live ? 'turn-live' : `turn-${turn.seq}`}
      style={{
        marginBottom: 12,
        border: `1px solid ${accent}`,
        borderRadius: 6,
        overflow: 'hidden',
        background: live ? 'color-mix(in srgb, var(--accent), transparent 94%)' : 'transparent',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
        background: live ? 'color-mix(in srgb, var(--accent), transparent 88%)' : 'var(--bg-2)',
        borderBottom: '1px solid var(--border)', fontSize: 11,
      }}>
        {live ? <ThinkingDot size={7} /> : (
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--fg-mute)', display: 'inline-block' }} />
        )}
        <strong style={{ color: live ? 'var(--accent-strong, #7dd3fc)' : 'var(--fg)' }}>
          {live ? 'Live turn' : `Turn ${turn.seq + 1}`}
        </strong>
        {time ? <span style={{ color: 'var(--fg-mute)', marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{time}</span> : null}
      </div>
      <div style={{ padding: 8 }}>
        {/* Newest-first WITHIN the turn too, so the current streamed line is the
            highest thing in the (top) live turn — not buried at the bottom. The
            prompt is the oldest event of the turn, so it falls to the foot. */}
        {[...(turn.prompt ? [turn.prompt, ...turn.entries] : turn.entries)]
          .reverse()
          .map((e, i) => <Entry key={i} entry={e} />)}
      </div>
    </div>
  );
}
