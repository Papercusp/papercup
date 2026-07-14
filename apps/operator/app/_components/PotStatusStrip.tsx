'use client';

/**
 * PotStatusStrip — the chat sidebar's ambient one-line pot health digest
 * (operator-chat-sidebar-revival-2026-07-13 P-018, approved mockup variant A).
 *
 * Design thesis (P-016/P-017, owner-approved): the sidebar shows the DIGEST,
 * not the dashboards. The one-line strip is always visible in chat view — Mug +
 * Kettle liveness with last-wake age, working-cup count, ready count, a "need
 * you" badge. WI-4778 replaced the old fold-out panel with the full-height Pot
 * Health view (PotHealthPane): clicking the strip now opens THAT view (the
 * same `?opcv=pot` state the header 🫖 toggle drives), so there is exactly one
 * detail surface.
 *
 * Data (reuse-first, no parallel path): `overwatch.snapshot` +
 * `overwatch.liveness` (SSE-live — the same queries PotHealthPane reads).
 */

import { useMemo } from 'react';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import type {
  OverwatchBrief,
  OverwatchLiveness,
} from '@papercusp/operator-core/lib/overwatch/brief-types';

/** Compact "2m / 40s / 3h" age from an ISO timestamp or epoch ms; null-safe. */
export function compactAge(from: string | number | null | undefined, now = Date.now()): string {
  if (from == null) return '—';
  const t = typeof from === 'number' ? from : Date.parse(from);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Display-cap a badge count: 1..99 verbatim, above that "99+" (WI-4724 — the
 *  raw aging-escalations count can reach the hundreds and blows out the badge).
 *  The HONEST full count stays in the strip's aria-label + the badge title. */
export function compactCount(n: number, cap = 99): string {
  return n > cap ? `${cap}+` : String(n);
}

/** Split a leading work-item id off a cup's `doing` line so it renders in
 *  accent mono like the mockup's `.doing .wi` ("WI-4662 fleet-spec …"). */
export function splitLeadingWi(doing: string): { wi: string | null; rest: string } {
  const m = doing.match(/^((?:WI|EI|F)-\d+)\s+(.*)$/);
  return m ? { wi: m[1]!, rest: m[2]! } : { wi: null, rest: doing };
}

export function PotStatusStrip() {
  // WI-4778: the strip's click-through target is the full-height Pot Health
  // view — the SAME nuqs param the header 🫖 toggle drives.
  const [, setView] = useQueryState(
    'opcv',
    parseAsStringEnum(['chat', 'pot']).withDefault('chat'),
  );

  const snapQ = useSyncQuery<OverwatchBrief>({
    queryName: 'overwatch.snapshot',
    args: {},
    staleTime: 15_000,
  });
  const liveQ = useSyncQuery<OverwatchLiveness>({
    queryName: 'overwatch.liveness',
    args: {},
    staleTime: 15_000,
  });

  const snap = snapQ.data?.[0];
  const live = liveQ.data?.[0];

  const needYou = useMemo(() => {
    if (!snap) return 0;
    const critical = snap.anomalies.filter((a) => a.severity !== 'info').length;
    return critical + snap.plans.agingEscalations;
  }, [snap]);

  // No data at all yet (provider cold) → render nothing rather than a husk.
  if (!snap && !live) return null;

  const mugAge = compactAge(snap?.queen.lastWakeAt ?? null);
  const kettleAge = compactAge(live?.lastRunAt ?? null);
  const mugOk = !!snap && !snap.queen.stalled;
  const kettleOk = !!live && live.alive;
  const working = snap?.bees.running ?? 0;
  const ready = snap?.workFeed.frontier ?? 0;

  return (
    <div className="op-pot-status">
      <button
        type="button"
        className="op-pot-strip"
        aria-label={`Pot status — Mug ${mugAge}, Kettle ${kettleAge}, ${working} working, ${ready} ready${needYou > 0 ? `, ${needYou} need you` : ''}. Open pot health.`}
        onClick={() => void setView('pot')}
      >
        <span className={`op-pot-dot ${mugOk ? 'ok' : 'bad'}`} aria-hidden="true" />
        <span className="op-pot-who">Mug</span>
        <span className="op-pot-age">{mugAge}</span>
        <span className="op-pot-sep" aria-hidden="true">·</span>
        <span className={`op-pot-dot ${kettleOk ? 'ok' : 'bad'}`} aria-hidden="true" />
        <span className="op-pot-who">Kettle</span>
        <span className="op-pot-age">{kettleAge}</span>
        <span className="op-pot-sep" aria-hidden="true">·</span>
        <span className="op-pot-strip-item">{working} working</span>
        <span className="op-pot-sep" aria-hidden="true">·</span>
        <span className="op-pot-strip-item">{ready} ready</span>
        {needYou > 0 && (
          <span className="op-pot-needs" title={`${needYou} need you`}>
            <span className="op-pot-badge">{compactCount(needYou)}</span> need you
          </span>
        )}
        <span className="op-pot-caret" aria-hidden="true">🫖</span>
      </button>
    </div>
  );
}
