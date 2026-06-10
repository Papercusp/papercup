'use client';

/**
 * /coord — the coordination dashboard.
 *
 * agent-coordination-architecture-v2 §9. Four panels:
 *
 *   - Sessions — L1 presence: who is active, what they're doing.
 *   - Inbox    — L3 human-facing: open escalations + to:['human'] msgs.
 *   - Plans    — the plans/* docs, list + full markdown.
 *   - History  — the merged coord/* event feed (CoordHistory).
 *
 * The active panel is URL-backed (nuqs) so a panel view is shareable,
 * per the operator's nuqs-by-default policy.
 */

import { useQueryState, parseAsStringEnum } from 'nuqs';
import { useCallback, useEffect, useRef, useState } from 'react';
import CoordHistory from './CoordHistory';
import { LivenessDot, livenessFromHeartbeat } from './presence-ui';

const PANELS = ['sessions', 'inbox', 'plans', 'history'] as const;
type Panel = (typeof PANELS)[number];

const PANEL_LABEL: Record<Panel, string> = {
  sessions: 'Sessions',
  inbox: 'Inbox',
  plans: 'Plans',
  history: 'History',
};

export default function CoordDashboard() {
  const [panel, setPanel] = useQueryState<Panel>(
    'panel',
    parseAsStringEnum([...PANELS]).withDefault('sessions'),
  );

  return (
    <div className="mx-auto max-w-6xl p-6 text-slate-100">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold">Coordination</h1>
        <p className="text-sm text-slate-400">
          Agent coordination surface — presence, the human inbox, plans, and the
          event history. Backed by <code>coord/*</code> + <code>plans/*</code>.
        </p>
      </header>

      <HookHealthBanner />

      <nav className="mb-5 flex gap-1 border-b border-slate-700">
        {PANELS.map((p) => (
          <button
            key={p}
            onClick={() => setPanel(p)}
            className={
              'rounded-t px-4 py-2 text-sm ' +
              (panel === p
                ? 'border-b-2 border-blue-400 font-medium text-blue-200'
                : 'text-slate-400 hover:text-slate-200')
            }
          >
            {PANEL_LABEL[p]}
          </button>
        ))}
      </nav>

      {panel === 'sessions' && <SessionsPanel />}
      {panel === 'inbox' && <InboxPanel />}
      {panel === 'plans' && <PlansPanel />}
      {panel === 'history' && <CoordHistory />}
    </div>
  );
}

// ── Hook-health banner (file-locking #3) ─────────────────────────────

interface HookErrorRecord {
  ts: string;
  // OMP coord-hook: 'tool_call' | 'tool_result'. Claude/Codex cc/ hooks:
  // 'pretooluse' | 'posttooluse'. Same marker file, either source — keep in
  // sync with the route union in routes/su-locks/hook-health.ts.
  handler: 'tool_call' | 'tool_result' | 'pretooluse' | 'posttooluse';
  phase: 'connect' | 'http' | 'parse';
  detail: string;
  operator_url: string;
}
interface HookHealthResponse {
  healthy: boolean;
  last_success_ts: string | null;
  last_error: HookErrorRecord | null;
}

const STALE_WINDOW_MS = 5 * 60_000;

/**
 * Renders a banner ONLY when a lock-enforcement hook (OMP coord-hook or
 * the Claude/Codex cc hooks) is currently failing open (unhealthy AND the
 * error happened within the last 5 minutes). Silent otherwise — no banner spam during normal
 * operation.
 *
 * Polls /api/su-locks/hook-health every 15s; cheap (small JSON, no
 * DB query — the route reads ~/.papercusp/locks-cache/last-error.json
 * + last-success.json).
 */
function HookHealthBanner() {
  const [data, setData] = useState<HookHealthResponse | null>(null);

  useEffect(() => {
    let live = true;
    async function tick() {
      try {
        const res = await fetch('/api/su-locks/hook-health', {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const json = (await res.json()) as HookHealthResponse;
        if (live) setData(json);
      } catch {
        // Network errors are silent — the banner is itself best-effort.
      }
    }
    tick();
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') void tick();
    }, 15_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  if (!data || data.healthy || !data.last_error) return null;
  const ageMs = Date.now() - Date.parse(data.last_error.ts);
  if (!Number.isFinite(ageMs) || ageMs > STALE_WINDOW_MS) return null;

  const phase = data.last_error.phase;
  const label =
    phase === 'connect'
      ? 'operator unreachable from an agent session'
      : `hook ${data.last_error.handler} error (${phase})`;
  const minutes = Math.max(1, Math.round(ageMs / 60_000));
  return (
    <div
      role="alert"
      className="mb-4 rounded border border-amber-500 bg-amber-950/40 px-4 py-2 text-sm text-amber-100"
    >
      <strong className="font-semibold">File-lock enforcement is offline.</strong>{' '}
      {label} ({minutes}m ago). Edits are being allowed without claim;
      coordination relies on cooperative <code>locks:*</code> calls until the
      hook recovers.
    </div>
  );
}

// ── Sessions panel (L1 presence) ─────────────────────────────────────

interface PresenceRecord {
  ownerId: string;
  ownerLabel: string;
  source: string;
  intent: string;
  currentPlanSlug: string | null;
  currentFiles: string[];
  host: string;
  heartbeatAt: string;
  stale: boolean;
}

// Documented polling exception (audit P-058): the /coord dev page reads
// heartbeat-cadence presence + file-backed health endpoints with no PG
// sync-invalidation source (attaching NOTIFY triggers to presence/
// coord_event_log is an owner-gated trade-off — the heartbeat churn would
// out-shout the dedupe window). Poll while visible, pause when hidden;
// in-flight responses abort on supersede so a slow stale reply never
// clobbers a newer one (audit P-064 race class).
function usePolledJson<T>(url: string, intervalMs = 5000): {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(url, { signal: controller.signal });
      if (!r.ok) throw new Error(`status ${r.status}`);
      setData((await r.json()) as T);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    void refresh();
    const tick = () => {
      if (document.visibilityState === 'hidden') return;
      void refresh();
    };
    const id = window.setInterval(tick, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      abortRef.current?.abort();
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, intervalMs]);
  return { data, error, loading, refresh };
}

function SessionsPanel() {
  const { data, error } = usePolledJson<{
    active: PresenceRecord[];
    stale: PresenceRecord[];
  }>('/api/coord/presence');

  const active = data?.active ?? [];
  const stale = data?.stale ?? [];

  return (
    <div>
      {error && (
        <div className="mb-3 rounded border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">
          Error: {error}
        </div>
      )}
      <h2 className="mb-2 text-sm font-medium text-slate-300">
        Active ({active.length})
      </h2>
      {active.length === 0 && (
        <p className="mb-4 text-sm text-slate-500">No active agent sessions.</p>
      )}
      <ul className="mb-6 space-y-2">
        {active.map((s) => (
          <SessionRow key={s.ownerId} s={s} />
        ))}
      </ul>
      {stale.length > 0 && (
        <>
          <h2 className="mb-2 text-sm font-medium text-slate-500">
            Stale ({stale.length}) — heartbeat &gt; 10 min old
          </h2>
          <ul className="space-y-2 opacity-50">
            {stale.map((s) => (
              <SessionRow key={s.ownerId} s={s} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function SessionRow({ s }: { s: PresenceRecord }) {
  // 3-state liveness from the heartbeat (finer than the active/stale split the
  // section grouping gives — distinguishes "live <1m" from "idle").
  const liveness = livenessFromHeartbeat(s.heartbeatAt);
  return (
    <li className="rounded border border-slate-800 bg-slate-900/40 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium text-slate-200">
          <LivenessDot liveness={liveness} />
          {s.ownerLabel}
        </span>
        <span className="text-xs text-slate-500">
          {s.source} · {new Date(s.heartbeatAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="mt-0.5 text-xs text-slate-400">
        {s.intent || '(no declared intent)'}
      </div>
      {(s.currentPlanSlug || s.currentFiles.length > 0) && (
        <div className="mt-1 flex flex-wrap gap-1">
          {s.currentPlanSlug && (
            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
              plan: {s.currentPlanSlug}
            </span>
          )}
          {s.currentFiles.slice(0, 4).map((f) => (
            <span
              key={f}
              className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500"
            >
              {f}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

// ── Inbox panel (L3 human-facing) ────────────────────────────────────

interface InboxItem {
  ts: string;
  msg_id: string;
  source: string;
  kind: string;
  from?: string;
  summary?: string;
  plan_slug?: string;
}

function InboxPanel() {
  const { data, error } = usePolledJson<{ items: InboxItem[] }>(
    '/api/coord/inbox',
  );
  const items = data?.items ?? [];
  return (
    <div>
      {error && (
        <div className="mb-3 rounded border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">
          Error: {error}
        </div>
      )}
      <p className="mb-3 text-sm text-slate-400">
        Open escalations and messages addressed to you. This is the channel
        agents use to surface decisions that need a human.
      </p>
      {items.length === 0 && (
        <p className="text-sm text-slate-500">Inbox is empty.</p>
      )}
      <ul className="space-y-2">
        {items.map((it) => (
          <li
            key={`${it.source}:${it.msg_id}`}
            className={
              'rounded border px-3 py-2 ' +
              (it.kind === 'escalation'
                ? 'border-amber-800 bg-amber-950/30'
                : 'border-slate-800 bg-slate-900/40')
            }
          >
            <div className="flex items-baseline gap-2">
              <span
                className={
                  'shrink-0 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ' +
                  (it.kind === 'escalation'
                    ? 'bg-amber-900/50 text-amber-200'
                    : 'bg-slate-700/50 text-slate-200')
                }
              >
                {it.kind}
              </span>
              <span className="truncate text-sm text-slate-200">
                {it.summary ?? '—'}
              </span>
            </div>
            <div className="mt-0.5 text-xs text-slate-500">
              {new Date(it.ts).toLocaleString()}
              {it.from && ` · from ${it.from}`}
              {it.plan_slug && ` · plan ${it.plan_slug}`}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Plans panel ──────────────────────────────────────────────────────

interface PlanSummary {
  slug: string;
  title: string;
  status: string;
  updated: string | null;
  now_state: string | null;
  now_next: string | null;
  item_count: number;
  decision_count: number;
}

function PlansPanel() {
  const { data, error } = usePolledJson<{ plans: PlanSummary[] }>(
    '/api/coord/plans',
    15000,
  );
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState<string>('');
  const [mdLoading, setMdLoading] = useState(false);

  const openPlan = useCallback(async (slug: string) => {
    if (openSlug === slug) {
      setOpenSlug(null);
      return;
    }
    setOpenSlug(slug);
    setMdLoading(true);
    setMarkdown('');
    try {
      const r = await fetch(`/api/coord/plans/${encodeURIComponent(slug)}`);
      const j = (await r.json()) as { markdown?: string; error?: string };
      setMarkdown(j.markdown ?? j.error ?? '(empty)');
    } catch (e) {
      setMarkdown(e instanceof Error ? e.message : String(e));
    } finally {
      setMdLoading(false);
    }
  }, [openSlug]);

  const plans = data?.plans ?? [];
  return (
    <div>
      {error && (
        <div className="mb-3 rounded border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">
          Error: {error}
        </div>
      )}
      {plans.length === 0 && (
        <p className="text-sm text-slate-500">No structured plans found.</p>
      )}
      <ul className="space-y-2">
        {plans.map((p) => (
          <li key={p.slug} className="rounded border border-slate-800 bg-slate-900/40">
            <button
              onClick={() => openPlan(p.slug)}
              className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-slate-800/30"
            >
              <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-slate-400">
                {p.status}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-slate-200">{p.title}</div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {p.slug} · {p.item_count} items · {p.decision_count} decisions
                  {p.updated && ` · updated ${p.updated}`}
                </div>
                {p.now_next && (
                  <div className="mt-1 truncate text-xs text-slate-400">
                    Now: {p.now_next}
                  </div>
                )}
              </div>
            </button>
            {openSlug === p.slug && (
              <pre className="max-h-[60vh] overflow-auto border-t border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] whitespace-pre-wrap text-slate-300">
{mdLoading ? 'Loading…' : markdown}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
