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
import styles from './coord.module.css';
import { LivenessDot, livenessFromHeartbeat } from './presence-ui';

const PANELS = ['sessions', 'inbox', 'plans', 'history'] as const;
type Panel = (typeof PANELS)[number];

const PANEL_LABEL: Record<Panel, string> = {
  sessions: 'Sessions',
  inbox: 'Inbox',
  plans: 'Plans',
  history: 'History',
};

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export default function CoordDashboard() {
  const [panel, setPanel] = useQueryState<Panel>(
    'panel',
    parseAsStringEnum([...PANELS]).withDefault('sessions'),
  );

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title}>Coordination</h1>
        <p className={styles.description}>
          Agent coordination surface — presence, the human inbox, plans, and the
          event history. Backed by <code>coord/*</code> + <code>plans/*</code>.
        </p>
      </header>

      <HookHealthBanner />

      <nav className={styles.tabNav}>
        {PANELS.map((p) => (
          <button
            key={p}
            onClick={() => setPanel(p)}
            className={cx(styles.tabButton, panel === p && styles.tabButtonActive)}
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
      className={styles.warningAlert}
    >
      <strong className={styles.strong}>File-lock enforcement is offline.</strong>{' '}
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
        <div className={styles.alert}>
          Error: {error}
        </div>
      )}
      <h2 className={styles.sectionTitle}>
        Active ({active.length})
      </h2>
      {active.length === 0 && (
        <p className={styles.mutedCopy}>No active agent sessions.</p>
      )}
      <ul className={styles.list}>
        {active.map((s) => (
          <SessionRow key={s.ownerId} s={s} />
        ))}
      </ul>
      {stale.length > 0 && (
        <>
          <h2 className={cx(styles.sectionTitle, styles.sectionTitleMuted)}>
            Stale ({stale.length}) — heartbeat &gt; 10 min old
          </h2>
          <ul className={cx(styles.listCompact, styles.staleList)}>
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
    <li className={cx(styles.cardRow, styles.cardRowPadded)}>
      <div className={styles.rowHeader}>
        <span className={styles.rowTitle}>
          <LivenessDot liveness={liveness} />
          {s.ownerLabel}
        </span>
        <span className={styles.rowMeta}>
          {s.source} · {new Date(s.heartbeatAt).toLocaleTimeString()}
        </span>
      </div>
      <div className={styles.rowBody}>
        {s.intent || '(no declared intent)'}
      </div>
      {(s.currentPlanSlug || s.currentFiles.length > 0) && (
        <div className={styles.pillRow}>
          {s.currentPlanSlug && (
            <span className={styles.miniBadge}>
              plan: {s.currentPlanSlug}
            </span>
          )}
          {s.currentFiles.slice(0, 4).map((f) => (
            <span
              key={f}
              className={cx(styles.miniBadge, styles.miniBadgeMuted)}
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
        <div className={styles.alert}>
          Error: {error}
        </div>
      )}
      <p className={styles.mutedCopy}>
        Open escalations and messages addressed to you. This is the channel
        agents use to surface decisions that need a human.
      </p>
      {items.length === 0 && (
        <p className={styles.emptyCopy}>Inbox is empty.</p>
      )}
      <ul className={styles.listCompact}>
        {items.map((it) => (
          <li
            key={`${it.source}:${it.msg_id}`}
            className={cx(
              styles.cardRow,
              styles.inboxItem,
              it.kind === 'escalation' && styles.inboxItemEscalation,
            )}
          >
            <div className={styles.inlineRow}>
              <span
                className={cx(
                  styles.kindBadge,
                  it.kind === 'escalation' ? styles.kindBadgeEscalation : styles.kindBadgeNeutral,
                )}
              >
                {it.kind}
              </span>
              <span className={cx(styles.truncateText, styles.summaryText)}>
                {it.summary ?? '—'}
              </span>
            </div>
            <div className={styles.rowMeta}>
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
        <div className={styles.alert}>
          Error: {error}
        </div>
      )}
      {plans.length === 0 && (
        <p className={styles.emptyCopy}>No structured plans found.</p>
      )}
      <ul className={styles.listCompact}>
        {plans.map((p) => (
          <li key={p.slug} className={styles.cardRow}>
            <button
              onClick={() => openPlan(p.slug)}
              className={styles.rowButton}
            >
              <span className={styles.miniBadge}>
                {p.status}
              </span>
              <div className={styles.contentColumn}>
                <div className={cx(styles.truncateText, styles.planTitle)}>{p.title}</div>
                <div className={styles.rowMeta}>
                  {p.slug} · {p.item_count} items · {p.decision_count} decisions
                  {p.updated && ` · updated ${p.updated}`}
                </div>
                {p.now_next && (
                  <div className={cx(styles.rowBody, styles.truncateText)}>
                    Now: {p.now_next}
                  </div>
                )}
              </div>
            </button>
            {openSlug === p.slug && (
              <pre className={styles.payloadPre}>
{mdLoading ? 'Loading…' : markdown}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
