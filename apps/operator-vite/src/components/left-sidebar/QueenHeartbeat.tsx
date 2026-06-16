/**
 * QueenHeartbeat — the persistent "is the Queen alive?" indicator
 * (queen-heartbeat-2026-06-16, owner-priority UX).
 *
 * The Queen is fresh-per-wake: a pulser that PARKS (alive, waiting) between brief
 * wakes. Nothing on the desktop showed a parked-but-alive Queen, so the owner
 * repeatedly thought she was dead when she was not. This makes her aliveness
 * impossible to miss: ALIVE/PARKED vs STALLED vs PAUSED, the last wake (relative),
 * the next-wake countdown, and the placements she is DRIVING (recovering / working
 * / cursed + the work-item ids) — with a pulse when she JUST ran.
 *
 * Data: the `hive.controlState` sync query (started / nextFireAt / lastWakeAt +
 * the placements summary added for this, queen-heartbeat-2026-06-16). The
 * component ticks the countdown every 1s and periodically refetches so lastWakeAt
 * stays live (a heartbeat polls its own status — the legitimate UI-timer case).
 */
import { useEffect, useRef, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { Crown } from 'lucide-react';

interface PlacementSummary {
  recovering: number;
  cursed: number;
  stranded: number;
  workingTracked: number;
  items: Array<{ workItemId: string; status: string; failCount?: number; harness?: string | null }>;
}

/** One row of the `hive.controlState` sync query (+ the heartbeat placements). */
export interface HiveControlState {
  slug: string;
  started: boolean;
  nextFireAt: string | null;
  lastWakeAt: string | null;
  watchdogFires24h?: number;
  placements?: PlacementSummary;
}

export type QueenState = 'running' | 'parked' | 'stalled' | 'stopped';

/** "she just ran" pulse window. */
const RUNNING_MS = 90_000;
/** started + no armed wake + stale past this ⇒ possibly stalled (not just parked). */
const STALE_MS = 45 * 60_000;

/** Derive the Queen's liveness from her control-state row. Pure (now injected). */
export function deriveQueenState(row: HiveControlState | undefined, now: number): { state: QueenState; label: string } {
  if (!row) return { state: 'stopped', label: 'No hive' };
  if (!row.started) return { state: 'stopped', label: 'Paused' };
  const lastWake = row.lastWakeAt ? Date.parse(row.lastWakeAt) : NaN;
  const nextFire = row.nextFireAt ? Date.parse(row.nextFireAt) : NaN;
  const armed = !Number.isNaN(nextFire);
  if (!Number.isNaN(lastWake) && now - lastWake < RUNNING_MS) return { state: 'running', label: 'Running' };
  if (armed) return { state: 'parked', label: 'Alive · parked' };
  if (!Number.isNaN(lastWake) && now - lastWake > STALE_MS) return { state: 'stalled', label: 'Stalled?' };
  return { state: 'parked', label: 'Alive' };
}

function relPast(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'never';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${Math.round(s)}s ago`;
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function countdown(iso: string | null, now: number): string {
  if (!iso) return 'unscheduled';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unscheduled';
  const s = (t - now) / 1000;
  if (s <= 0) return 'imminent';
  if (s < 60) return `in ${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  if (m < 60) return `in ${m}m ${rem}s`;
  return `in ${Math.round(m / 60)}h`;
}

const TONE: Record<QueenState, string> = { running: 'live', parked: 'ok', stalled: 'warn', stopped: 'mute' };

export default function QueenHeartbeat({ homeSlug }: { homeSlug?: string }) {
  const q = useSyncQuery<HiveControlState>({ queryName: 'hive.controlState', args: {}, staleTime: 10_000 });
  const [now, setNow] = useState(() => Date.now());

  // Tick the countdown every 1s; periodically refetch so lastWakeAt / the
  // placements stay live without a server-side per-wake invalidation.
  const invalidateRef = useRef(q.invalidate);
  invalidateRef.current = q.invalidate;
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const refetch = setInterval(() => void invalidateRef.current?.(), 12_000);
    return () => {
      clearInterval(tick);
      clearInterval(refetch);
    };
  }, []);

  const rows = (q.data ?? []) as HiveControlState[];
  const row = (homeSlug ? rows.find((r) => r.slug === homeSlug) : undefined) ?? rows[0];
  const { state, label } = deriveQueenState(row, now);
  const tone = TONE[state];
  const pl = row?.placements;
  const recovering = (pl?.items ?? []).filter((i) => i.status === 'recovering').slice(0, 3);

  return (
    <section className={`pc-qh pc-qh--${tone}`} aria-label="Queen status">
      <div className="pc-qh__top">
        <span className={`pc-qh__dot pc-qh__dot--${tone}${state === 'running' || state === 'parked' ? ' pc-qh__dot--pulse' : ''}`} aria-hidden />
        <Crown size={13} aria-hidden />
        <span className="pc-qh__state">{label}</span>
        {row?.slug && <span className="pc-qh__slug" title="The home Queen">{row.slug}</span>}
      </div>
      <div className="pc-qh__wakes">
        <span className="pc-qh__woke">woke {relPast(row?.lastWakeAt ?? null, now)}</span>
        {row?.started && <span className="pc-qh__next">next {countdown(row?.nextFireAt ?? null, now)}</span>}
      </div>
      {pl && (pl.workingTracked > 0 || pl.recovering > 0 || pl.cursed > 0) ? (
        <div className="pc-qh__placements">
          <span className="pc-qh__pchip" title="placements she is driving to terminal">driving {pl.workingTracked}</span>
          {pl.recovering > 0 && <span className="pc-qh__pchip pc-qh__pchip--warn">{pl.recovering} recovering</span>}
          {pl.cursed > 0 && <span className="pc-qh__pchip pc-qh__pchip--bad">{pl.cursed} cursed</span>}
          {recovering.map((i) => (
            <span key={i.workItemId} className="pc-qh__wi" title={`recovering ${i.workItemId}`}>{i.workItemId}</span>
          ))}
        </div>
      ) : row?.started ? (
        <div className="pc-qh__placements">
          <span className="pc-qh__pchip pc-qh__pchip--idle">no open placements</span>
        </div>
      ) : null}
      <HeartbeatStyles />
    </section>
  );
}

function HeartbeatStyles() {
  return (
    <style>{`
      .pc-qh {
        display: flex; flex-direction: column; gap: 5px; padding: 9px 10px; border-radius: 10px;
        border: 1px solid var(--qh-accent, rgba(125, 211, 252, 0.2)); background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      .pc-qh--live { --qh-accent: rgba(52, 211, 153, 0.55); background: rgba(52, 211, 153, 0.09); }
      .pc-qh--ok { --qh-accent: rgba(52, 211, 153, 0.4); background: rgba(52, 211, 153, 0.055); }
      .pc-qh--warn { --qh-accent: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.08); }
      .pc-qh--mute { --qh-accent: rgba(125, 211, 252, 0.18); }
      .pc-qh__top { display: flex; align-items: center; gap: 7px; }
      .pc-qh__top svg { color: #fbbf24; }
      .pc-qh__dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
      .pc-qh__dot--live { background: #34d399; box-shadow: 0 0 7px rgba(52, 211, 153, 0.8); }
      .pc-qh__dot--ok { background: #34d399; box-shadow: 0 0 5px rgba(52, 211, 153, 0.6); }
      .pc-qh__dot--warn { background: #fbbf24; box-shadow: 0 0 6px rgba(251, 191, 36, 0.7); }
      .pc-qh__dot--mute { background: #475569; }
      .pc-qh__dot--pulse { animation: pc-qh-pulse 1.7s ease-in-out infinite; }
      @keyframes pc-qh-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.45; transform: scale(0.82); } }
      .pc-qh__state { font-size: 11.5px; font-weight: 760; letter-spacing: 0.02em; color: var(--fg, #e7f7ff); }
      .pc-qh__slug {
        margin-left: auto; font-size: 9.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        color: var(--fg-mute, #7f9bb4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 110px;
      }
      .pc-qh__wakes { display: flex; gap: 10px; flex-wrap: wrap; }
      .pc-qh__woke, .pc-qh__next { font-size: 10.5px; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; }
      .pc-qh__next { color: var(--fg-mute, #7f9bb4); }
      .pc-qh__placements { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
      .pc-qh__pchip {
        font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; padding: 1px 7px; border-radius: 999px;
        color: var(--fg-dim, #b9d4e8); border: 1px solid var(--border, rgba(125, 211, 252, 0.22)); background: rgba(255, 255, 255, 0.03);
      }
      .pc-qh__pchip--warn { color: #fcd34d; border-color: rgba(251, 191, 36, 0.5); }
      .pc-qh__pchip--bad { color: #fca5a5; border-color: rgba(244, 63, 94, 0.5); }
      .pc-qh__pchip--idle { color: var(--fg-mute, #7f9bb4); opacity: 0.8; }
      .pc-qh__wi {
        font-size: 9px; font-weight: 700; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #fcd34d; padding: 1px 6px; border-radius: 5px; background: rgba(251, 191, 36, 0.12); border: 1px solid rgba(251, 191, 36, 0.35);
      }
    `}</style>
  );
}
