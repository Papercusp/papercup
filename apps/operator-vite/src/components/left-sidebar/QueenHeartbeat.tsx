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
 * component ticks the countdown every 1s (a legit client UI timer); lastWakeAt /
 * nextFireAt / placements arrive via PUSH — the Queen wake writer (recordHiveWake)
 * fires notifySyncInvalidate('hive.controlState') per wake (data-sync-push-
 * completion P-007), replacing the old 12s self-poll.
 */
import { useEffect, useState } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { useSyncQuery } from '@papercusp/sync';
import { Crown } from 'lucide-react';
import { Tooltip } from '@/app/harness/Tooltip';
import { useLexicon } from '@/lib/useLexicon';

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
  const t = useLexicon();
  const q = useSyncQuery<HiveControlState>({ queryName: 'hive.controlState', args: {}, staleTime: 10_000 });
  const [now, setNow] = useState(() => Date.now());

  // Tick the countdown every 1s — a legit client UI timer (no data fetch).
  // lastWakeAt / nextFireAt / the placements now arrive via PUSH: the Queen wake
  // writer (recordHiveWake) fires notifySyncInvalidate('hive.controlState') on each
  // wake (data-sync-push-completion P-007), so the old degenerate 12s self-poll is
  // gone. The @papercusp/sync 180s drift-repair tick backs any wake path that bypasses
  // recordHiveWake.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const rows = (q.data ?? []) as HiveControlState[];
  const row = (homeSlug ? rows.find((r) => r.slug === homeSlug) : undefined) ?? rows[0];
  const { state, label: derivedLabel } = deriveQueenState(row, now);
  // The only lexicon-bearing derived label is the no-row "No hive" case; the rest
  // ('Running'/'Alive'/'Paused'/'Stalled?') are noun-free. deriveQueenState is a
  // pure (hook-less) helper, so route that one label here at the render site.
  const label = row ? derivedLabel : `No ${t('pot', { lower: true })}`;
  const tone = TONE[state];
  const pl = row?.placements;
  const recovering = (pl?.items ?? []).filter((i) => i.status === 'recovering').slice(0, 3);

  return (
    <TooltipPrimitive.Provider delayDuration={250}>
      <section className={`pc-qh pc-qh--${tone}`} aria-label={`${t('brain')} status`}>
        <div className="pc-qh__top">
          <span className={`pc-qh__dot pc-qh__dot--${tone}${state === 'running' || state === 'parked' ? ' pc-qh__dot--pulse' : ''}`} aria-hidden />
          <Crown size={13} aria-hidden />
          <span className="pc-qh__state">{label}</span>
          {row?.slug && (
            <Tooltip label={`The home ${t('brain')}`}>
              <span className="pc-qh__slug">{row.slug}</span>
            </Tooltip>
          )}
        </div>
        <div className="pc-qh__wakes">
          <span className="pc-qh__woke">woke {relPast(row?.lastWakeAt ?? null, now)}</span>
          {row?.started && <span className="pc-qh__next">next {countdown(row?.nextFireAt ?? null, now)}</span>}
        </div>
        {pl && (pl.workingTracked > 0 || pl.recovering > 0 || pl.cursed > 0) ? (
          <div className="pc-qh__placements">
            <Tooltip label="Placements she is driving to terminal">
              <span className="pc-qh__pchip">driving {pl.workingTracked}</span>
            </Tooltip>
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
      </section>
    </TooltipPrimitive.Provider>
  );
}
