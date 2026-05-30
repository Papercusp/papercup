'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createResilientEventSource } from '@restart/sse';

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

interface TimelineEntry {
  kind: 'text' | 'tool_use' | 'tool_result' | 'status' | 'result';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
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
}

const POPOVER_WIDTH = 520;
const POPOVER_MAX_HEIGHT = 360;
const VIEWPORT_PAD = 12;

export default function AgentThinkingPopover({
  slug,
  phase,
  runId,
  role,
  anchorRect,
  onMouseEnter,
  onMouseLeave,
  onOpenInspector,
}: Props) {
  const [events, setEvents] = useState<TimelineEntry[]>([]);
  const [status, setStatus] = useState<'connecting' | 'live' | 'done' | 'error'>('connecting');
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

  // EventSource lifecycle.
  useEffect(() => {
    setStatus('connecting');
    const source = createResilientEventSource({
      url: `/api/harness/${slug}/agents/${runId}/stream?phase=${phase}`,
      handlers: {
        backfill: (data) => {
          try {
            const arr = JSON.parse(data) as TimelineEntry[];
            setEvents(arr);
            setStatus('live');
          } catch { /* ignore */ }
        },
        event: (data) => {
          try {
            const entry = JSON.parse(data) as TimelineEntry;
            setEvents((prev) => [...prev, entry]);
          } catch { /* ignore */ }
        },
        done: () => setStatus('done'),
      },
      onError: () => setStatus('error'),
    });
    return () => { source.close(); };
  }, [slug, phase, runId]);

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

  const statusLabel = status === 'connecting' ? 'connecting…'
    : status === 'live' ? 'live'
    : status === 'done' ? 'done'
    : 'disconnected';
  const statusColor = status === 'live' ? '#6aa84f'
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
          <div style={{ color: 'var(--fg-mute)', fontStyle: 'italic', padding: 4 }}>
            {status === 'connecting' ? 'Connecting…' : 'Waiting for first output from the agent…'}
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

function Entry({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === 'text') {
    return (
      <pre style={{
        margin: '0 0 8px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'inherit',
      }}>
        {entry.text}
      </pre>
    );
  }
  if (entry.kind === 'tool_use') {
    return (
      <div style={{ margin: '0 0 8px', padding: '4px 6px', background: 'rgba(56, 189, 248, 0.08)', border: '1px solid rgba(56, 189, 248, 0.18)', borderRadius: 3 }}>
        <div style={{ color: 'var(--accent-strong, #7dd3fc)', fontSize: 10.5, marginBottom: 2 }}>
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
    const meta = [cost, tokens, dur].filter(Boolean).join(' · ');
    return (
      <div style={{ margin: '0 0 4px', padding: '4px 6px', background: 'var(--bg-2)', borderTop: '1px solid var(--border)' }}>
        <div style={{ color: '#9a9a9a', fontSize: 10.5, marginBottom: 2 }}>
          ✓ result {meta && <span style={{ float: 'right' }}>{meta}</span>}
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
