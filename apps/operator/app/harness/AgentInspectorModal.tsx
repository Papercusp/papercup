'use client';

import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { useAgentThinkingStream, Entry, waitingMessage } from './AgentThinkingPopover';

/**
 * AgentInspectorModal — the pinned, full-height view of a run's live thinking
 * stream. Opened from the hover popover's "Open full inspector" button.
 *
 * Unlike the hover popover it does NOT dismiss on mouse-leave, so the whole
 * transcript can be read + scrolled. It reuses the shared stream hook + Entry
 * renderer so the timeline is identical to the popover, just larger and pinned.
 * Before this the "Open full inspector" button was a dead stub (it only closed
 * the popover) — there was no inspector in operator-vite to open.
 *
 * Empty-timeline state reuses the shared `waitingMessage` helper (WI-1325): a
 * live run producing ZERO output for STALL_AFTER_MS escalates from a hopeful
 * "Waiting…" to a "⚠ no output for {elapsed} — stalled/rate-limited" warning +
 * a "stalled?" header, so a wedged agent stops reading as an eternal green
 * "live · No output yet". Mirrors the hover popover's behavior.
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
}) {
  const { events, status } = useAgentThinkingStream(slug, phase, runId, streamUrl);
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

  // Follow the tail as new events stream in (unless the user scrolled up).
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  const elapsedMs = Math.max(0, now - (startedAtMs ?? openedAtRef.current));
  const waiting = waitingMessage(status, elapsedMs);
  // A live run sitting on zero output past the stall threshold reads as
  // "stalled?" instead of a reassuring green "live" (mirrors the hover popover).
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
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor }} />
          <span style={{ color: statusColor }}>{statusLabel}</span>
          <span style={{ color: 'var(--fg-mute)' }}>· {events.length} event{events.length === 1 ? '' : 's'}</span>
        </span>
      </div>
      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
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
          events.map((e, i) => <Entry key={i} entry={e} />)
        )}
      </div>
    </Modal>
  );
}
