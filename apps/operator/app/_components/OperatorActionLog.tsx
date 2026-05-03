'use client';

/**
 * OperatorActionLog — the harness-scoped log of long-running user-initiated
 * actions described in the designer brief from 2026-05-02.
 *
 * Polls /api/user-actions/<slug> every 4 seconds while at least one action is
 * `running`; otherwise every 30 seconds. Lightweight; designed to slot into
 * any harness chrome region (sidebar / dashboard panel / drawer). Wire-up
 * is intentionally not done here — the host decides where the panel lives.
 *
 * Design choices left for the visual-design pass (see designer brief):
 *   - Layout shape (table vs timeline vs cards) — currently a simple list.
 *   - Running indicator — currently a CSS-pulse on the row.
 *   - Failure prominence — currently failures stay chronological, marked.
 *   - Archive policy — currently no auto-archive; show all returned rows.
 *
 * The polling-vs-Zero decision: this component uses a polling endpoint as
 * v1 to ship without a Zero schema migration. When the Zero `user_actions`
 * table lands, swap useUserActions() for the Zero query — same row shape.
 */

import { useEffect, useRef, useState } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';

export interface UserAction {
  id: number;
  kind: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  summary: string | null;
  detailUrl: string | null;
  errorText: string | null;
  invocationId: string | null;
  startedAt: number;
  finishedAt: number | null;
  actor: string | null;
}

type Listener = (a: UserAction) => void;

function useUserActions(slug: string | null, opts?: { onTransition?: Listener }): {
  actions: UserAction[];
  loading: boolean;
  error: string | null;
} {
  const [actions, setActions] = useState<UserAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Smooth FLIP when a new action prepends — operators perceive the
  // log as live; without animation the new row pops in jarringly.
  const [listRef] = useAutoAnimate<HTMLUListElement>();
  const lastRef = useRef<Map<number, UserAction>>(new Map());
  const onTransitionRef = useRef(opts?.onTransition);
  onTransitionRef.current = opts?.onTransition;

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchOnce = async () => {
      try {
        const r = await fetch(`/api/user-actions/${encodeURIComponent(slug)}?limit=100`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { actions: UserAction[] };
        if (cancelled) return;

        // Detect status transitions on rows we've seen before. Fires
        // onTransition for any row whose status changed since the last
        // poll — used by the toast bridge to nudge the user.
        const next = new Map<number, UserAction>();
        for (const a of j.actions) next.set(a.id, a);
        const cb = onTransitionRef.current;
        if (cb) {
          for (const [id, a] of next) {
            const prev = lastRef.current.get(id);
            if (prev && prev.status !== a.status) cb(a);
          }
        }
        lastRef.current = next;
        setActions(j.actions);
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }

      if (cancelled) return;
      // Faster cadence while anything is running; otherwise relax.
      const anyRunning = lastRef.current.size > 0
        ? Array.from(lastRef.current.values()).some((a) => a.status === 'running')
        : false;
      const delay = anyRunning ? 4000 : 30000;
      timer = setTimeout(fetchOnce, delay);
    };

    fetchOnce();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [slug]);

  return { actions, loading, error };
}

function formatRelative(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  if (d < 1000) return 'just now';
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function formatElapsed(startedAt: number, finishedAt: number | null, now: number): string {
  const ms = (finishedAt ?? now) - startedAt;
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

export function OperatorActionLog({
  slug,
  onTransition,
  className,
}: {
  slug: string | null;
  onTransition?: Listener;
  className?: string;
}) {
  const { actions, loading, error } = useUserActions(slug, { onTransition });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!slug) return null;
  if (loading && actions.length === 0) {
    return <div className={className}>Loading actions…</div>;
  }
  if (error && actions.length === 0) {
    return <div className={className}>Could not load action log: {error}</div>;
  }
  if (actions.length === 0) {
    return (
      <div className={className}>
        <div style={{ opacity: 0.6, fontSize: 13 }}>
          No actions yet. Replan, cleanup, snapshot, and plugin operations show up here.
        </div>
      </div>
    );
  }

  return (
    <ul ref={listRef} className={className} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {actions.map((a) => (
        <ActionRow key={a.id} action={a} now={now} />
      ))}
    </ul>
  );
}

function ActionRow({ action: a, now }: { action: UserAction; now: number }) {
  const elapsed = formatElapsed(a.startedAt, a.finishedAt, now);
  const started = formatRelative(a.startedAt, now);
  const dotColor =
    a.status === 'running' ? '#3b82f6' :
    a.status === 'succeeded' ? '#16a34a' :
    a.status === 'failed' ? '#dc2626' :
    '#737373';

  return (
    <li
      title={a.errorText ?? undefined}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'baseline',
        padding: '6px 0',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        fontSize: 13,
      }}
    >
      <span
        aria-label={a.status}
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: dotColor,
          display: 'inline-block',
          flexShrink: 0,
          animation: a.status === 'running' ? 'pulse 1.4s ease-in-out infinite' : undefined,
        }}
      />
      <span style={{ minWidth: 110, fontFamily: 'monospace', opacity: 0.8 }}>{a.kind}</span>
      <span style={{ flex: 1, opacity: a.status === 'failed' ? 0.85 : 0.95 }}>
        {a.errorText ? (
          <span style={{ color: '#fca5a5' }}>{a.errorText.slice(0, 200)}</span>
        ) : (
          a.summary ?? <em style={{ opacity: 0.5 }}>(no summary)</em>
        )}
      </span>
      <span style={{ minWidth: 60, textAlign: 'right', opacity: 0.6 }}>{elapsed}</span>
      <span style={{ minWidth: 80, textAlign: 'right', opacity: 0.5 }}>{started}</span>
      {a.detailUrl ? (
        <a href={a.detailUrl} style={{ marginLeft: 6, opacity: 0.8 }}>↗</a>
      ) : null}
    </li>
  );
}
