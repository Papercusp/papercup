'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createResilientEventSource } from '@papercusp/sse';

/**
 * Hover popover anchored to a Now-running agent pill that shows the
 * agent's live "thinking" stream (text deltas, tool uses, tool results,
 * status events, terminal result).
 *
 * Lifecycle:
 *   - Mount: opens an EventSource on /api/harness/<slug>/agents/<runId>/stream.
 *   - Receives 'backfill' (array) once at start, then 'event' deltas as
 *     the agent writes more lines, then 'done' when the run terminates.
 *   - Unmount: aborts the EventSource. Server side closes the watcher.
 *
 * Interaction:
 *   - The popover catches its own mouseenter/mouseleave so the cursor
 *     can transit from the pill into the popover without a flicker close.
 *     Mouse leaving the popover triggers onClose.
 *   - The pill controls the open state via parent component (HarnessDashboard).
 */

export interface TimelineEntry {
  kind: 'text' | 'tool_use' | 'tool_result' | 'status' | 'result' | 'prompt';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  /** ISO timestamp of the source record — rendered as the per-entry header time. */
  ts?: string;
}

interface Props {
  slug: string;
  phase: string;
  runId: string;
  role: string;
  /** Pill's bounding rect at hover time. Used to anchor the popover. */
  anchorRect: DOMRect;
  /** Called when cursor enters the popover (parent cancels its close timer). */
  onMouseEnter: () => void;
  /** Called when cursor leaves the popover (parent re-schedules close). */
  onMouseLeave: () => void;
  /** Open the full AgentInspector modal (existing loadAgent flow). */
  onOpenInspector: () => void;
  /** Run start (epoch-ms). Drives the elapsed counter + stall detection while
   *  the timeline is still empty. Optional — when absent, no elapsed is shown. */
  startedAtMs?: number;
}

/** How long a run may produce ZERO output before the card flags it as likely
 *  stalled (an upstream gateway stall / rate-limit is the common cause). */
export const STALL_AFTER_MS = 45_000;

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

/**
 * The message shown while the timeline is EMPTY. Pure — exported for tests.
 * Escalates a still-connected run that has produced no output for
 * STALL_AFTER_MS from a hopeful "Waiting…" to a "likely stalled" warning, so a
 * wedged agent stops reading as an eternal "live · 0 events".
 */
export function waitingMessage(
  status: 'connecting' | 'live' | 'done' | 'error',
  elapsedMs: number | null,
): { text: string; stalled: boolean } {
  if (status === 'connecting') return { text: 'Connecting…', stalled: false };
  if (status === 'error') return { text: 'Disconnected before any output — retrying…', stalled: true };
  if (status === 'done') return { text: 'Run ended without producing any output.', stalled: true };
  if (elapsedMs != null && elapsedMs >= STALL_AFTER_MS) {
    return {
      text: `⚠ No output for ${fmtElapsed(elapsedMs)} — the agent may be stalled or rate-limited`,
      stalled: true,
    };
  }
  return {
    text: `Waiting for first output from the agent…${elapsedMs != null ? ` (${fmtElapsed(elapsedMs)})` : ''}`,
    stalled: false,
  };
}

const POPOVER_WIDTH = 520;
const POPOVER_MAX_HEIGHT = 360;
const VIEWPORT_PAD = 12;

/**
 * Subscribe to a run's live thinking stream. Shared by the hover popover AND the
 * pinned inspector modal (AgentInspectorModal) so both render the same timeline
 * from one code path. Opens an EventSource on mount, replays `backfill` once,
 * appends `event` deltas, and flips to done/error on the terminal events.
 */
export function useAgentThinkingStream(slug: string, phase: string, runId: string, streamUrl?: string) {
  const [events, setEvents] = useState<TimelineEntry[]>([]);
  const [status, setStatus] = useState<'connecting' | 'live' | 'done' | 'error'>('connecting');
  // Whether the agent is ACTIVELY writing right now (its transcript is being
  // appended) — driven by the session stream's `thinking` status event. The
  // live-turn section + the "● thinking" header badge key off this.
  const [thinking, setThinking] = useState(false);
  useEffect(() => {
    setStatus('connecting');
    setEvents([]);
    setThinking(false);
    const source = createResilientEventSource({
      // A caller can pass an explicit stream URL (e.g. the interactive-session
      // transcript endpoint); default is the bee run-log stream.
      url: streamUrl ?? `/api/harness/${slug}/agents/${runId}/stream?phase=${phase}`,
      handlers: {
        backfill: (data) => {
          try { setEvents(JSON.parse(data) as TimelineEntry[]); setStatus('live'); } catch { /* ignore */ }
        },
        event: (data) => {
          try { const e = JSON.parse(data) as TimelineEntry; setEvents((prev) => [...prev, e]); } catch { /* ignore */ }
        },
        // Session live-follow: the agent started/stopped writing the current turn.
        thinking: (data) => {
          try { setThinking(Boolean((JSON.parse(data) as { active?: boolean }).active)); } catch { /* ignore */ }
        },
        done: () => { setStatus('done'); setThinking(false); },
      },
      onError: () => { setStatus('error'); setThinking(false); },
    });
    return () => { source.close(); };
  }, [slug, phase, runId, streamUrl]);
  return { events, status, thinking };
}

export default function AgentThinkingPopover({
  slug,
  phase,
  runId,
  role,
  anchorRect,
  onMouseEnter,
  onMouseLeave,
  onOpenInspector,
  startedAtMs,
}: Props) {
  const { events, status } = useAgentThinkingStream(slug, phase, runId);
  const [now, setNow] = useState(() => Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Position: above pill by default; flip below if it would clip the
  // viewport top. Horizontal: align left edge to pill; clamp inside
  // viewport horizontally so the popover never overflows.
  const [pos, setPos] = useState<{ left: number; top: number; placement: 'above' | 'below' }>(() => {
    const top = anchorRect.top - POPOVER_MAX_HEIGHT - 8;
    const left = Math.min(
      Math.max(VIEWPORT_PAD, anchorRect.left),
      (typeof window !== 'undefined' ? window.innerWidth : 1024) - POPOVER_WIDTH - VIEWPORT_PAD,
    );
    return top > VIEWPORT_PAD
      ? { left, top, placement: 'above' }
      : { left, top: anchorRect.bottom + 8, placement: 'below' };
  });

  // Re-measure if the viewport scrolls under us (cheap; no resize observer needed).
  useLayoutEffect(() => {
    const onScroll = () => onMouseLeave();
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', onScroll, { capture: true });
  }, [onMouseLeave]);

  // Tick a 1s clock ONLY while still waiting on the first output (empty timeline,
  // not terminal) so the elapsed counter + the stall escalation update live —
  // no timer runs once output arrives or the run ends.
  useEffect(() => {
    if (events.length > 0 || status === 'done') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [events.length, status]);

  // Auto-scroll to bottom on new events. We don't auto-scroll if the
  // user has manually scrolled up — preserve their scroll position.
  const userScrolledRef = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!userScrolledRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [events]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onUserScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      userScrolledRef.current = !nearBottom;
    };
    el.addEventListener('scroll', onUserScroll, { passive: true });
    return () => el.removeEventListener('scroll', onUserScroll);
  }, []);

  const elapsedMs = startedAtMs != null ? Math.max(0, now - startedAtMs) : null;
  const waiting = waitingMessage(status, elapsedMs);
  // A live run sitting on zero output past the stall threshold reads as
  // "stalled?" in the header instead of a reassuring green "live".
  const stalledNow = events.length === 0 && status === 'live' && waiting.stalled;
  const statusLabel = stalledNow ? 'stalled?'
    : status === 'connecting' ? 'connecting…'
    : status === 'live' ? 'live'
    : status === 'done' ? 'done'
    : 'disconnected';
  const statusColor = stalledNow ? '#d97757'
    : status === 'live' ? '#6aa84f'
    : status === 'done' ? '#9a9a9a'
    : status === 'error' ? '#d97757'
    : '#9a9a9a';

  return createPortal(
    <div
      role="tooltip"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        width: POPOVER_WIDTH,
        maxHeight: POPOVER_MAX_HEIGHT,
        zIndex: 2147483640,
        background: 'var(--bg-1)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        boxShadow: '0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontSize: 12,
        color: 'var(--fg)',
      }}
    >
      <div style={{
        padding: '6px 10px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: 11,
        background: 'var(--bg-2)',
      }}>
        <span style={{ color: 'var(--fg-mute)' }}>
          <strong style={{ color: 'var(--fg)' }}>{role}</strong>
          {' · '}<code style={{ fontSize: 10 }}>{runId.slice(0, 24)}</code>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', background: statusColor,
            boxShadow: status === 'live' ? `0 0 6px ${statusColor}` : 'none',
          }} />
          <span style={{ color: statusColor }}>{statusLabel}</span>
        </span>
      </div>
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 8,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 11.5,
          lineHeight: 1.45,
        }}
      >
        {events.length === 0 ? (
          <div style={{ color: waiting.stalled ? '#d97757' : 'var(--fg-mute)', fontStyle: 'italic', padding: 4 }}>
            {waiting.text}
          </div>
        ) : (
          events.map((e, i) => <Entry key={i} entry={e} />)
        )}
      </div>
      <div style={{
        padding: '5px 10px',
        borderTop: '1px solid var(--border)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'var(--bg-2)',
        fontSize: 10.5,
        color: 'var(--fg-mute)',
      }}>
        <span>{events.length} event{events.length === 1 ? '' : 's'}</span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpenInspector(); }}
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            color: 'var(--fg)',
            padding: '2px 8px',
            borderRadius: 3,
            fontSize: 10.5,
            cursor: 'pointer',
          }}
        >
          Open full inspector →
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** Format an entry's ISO timestamp as a compact local `HH:MM:SS`, or null when
 *  absent/unparseable. Pure — exported for tests. */
export function fmtEntryTime(ts?: string): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** A small, right-aligned muted timestamp for an entry header. Renders nothing
 *  when the entry carries no (valid) timestamp — so timestamp-less live deltas
 *  don't get an empty chip. */
function EntryTime({ ts }: { ts?: string }) {
  const t = fmtEntryTime(ts);
  if (!t) return null;
  return (
    <time
      dateTime={ts}
      style={{ float: 'right', marginLeft: 8, fontSize: 9.5, fontWeight: 400, color: 'var(--fg-mute)', fontVariantNumeric: 'tabular-nums', opacity: 0.8 }}
    >
      {t}
    </time>
  );
}

export function Entry({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === 'text') {
    return (
      <div style={{ margin: '0 0 8px' }}>
        <EntryTime ts={entry.ts} />
        <pre style={{
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: 'inherit',
        }}>
          {entry.text}
        </pre>
      </div>
    );
  }
  if (entry.kind === 'tool_use') {
    return (
      <div style={{ margin: '0 0 8px', padding: '4px 6px', background: 'color-mix(in srgb, var(--accent), transparent 92%)', border: '1px solid color-mix(in srgb, var(--accent), transparent 82%)', borderRadius: 3 }}>
        <div style={{ color: 'var(--accent-strong, #7dd3fc)', fontSize: 10.5, marginBottom: 2 }}>
          <EntryTime ts={entry.ts} />
          ▸ tool_use: <strong>{entry.toolName}</strong>
        </div>
        <pre style={{ margin: 0, fontSize: 10.5, color: 'var(--fg-mute)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {compactJson(entry.toolInput)}
        </pre>
      </div>
    );
  }
  if (entry.kind === 'tool_result') {
    return (
      <div style={{ margin: '0 0 8px', padding: '4px 6px', background: 'rgba(106, 168, 79, 0.06)', border: '1px solid rgba(106, 168, 79, 0.16)', borderRadius: 3 }}>
        <div style={{ color: '#6aa84f', fontSize: 10.5, marginBottom: 2 }}>
          <EntryTime ts={entry.ts} />
          ◂ tool_result
        </div>
        <pre style={{ margin: 0, fontSize: 10.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflow: 'auto' }}>
          {entry.text}
        </pre>
      </div>
    );
  }
  if (entry.kind === 'status') {
    return (
      <div style={{ margin: '0 0 8px', fontSize: 10.5, color: 'var(--fg-mute)', fontStyle: 'italic' }}>
        <EntryTime ts={entry.ts} />
        ⌘ {entry.text}
      </div>
    );
  }
  if (entry.kind === 'result') {
    const cost = entry.costUsd ? `$${entry.costUsd.toFixed(4)}` : '';
    const tokens = entry.inputTokens || entry.outputTokens
      ? `${entry.inputTokens ?? 0}/${entry.outputTokens ?? 0} tok`
      : '';
    const dur = entry.durationMs ? `${(entry.durationMs / 1000).toFixed(1)}s` : '';
    const time = fmtEntryTime(entry.ts);
    // The time + cost/tokens/duration share the right side of the header.
    const right = [time, cost, tokens, dur].filter(Boolean).join(' · ');
    return (
      <div style={{ margin: '0 0 4px', padding: '4px 6px', background: 'var(--bg-2)', borderTop: '1px solid var(--border)' }}>
        <div style={{ color: '#9a9a9a', fontSize: 10.5, marginBottom: 2 }}>
          ✓ result {right && <span style={{ float: 'right' }}>{right}</span>}
        </div>
        {entry.text && (
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit' }}>
            {entry.text}
          </pre>
        )}
      </div>
    );
  }
  return null;
}

function compactJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    if (!s) return '';
    return s.length > 400 ? s.slice(0, 400) + '…' : s;
  } catch {
    return String(v);
  }
}
