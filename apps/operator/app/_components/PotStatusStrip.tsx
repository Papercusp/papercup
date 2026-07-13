'use client';

/**
 * PotStatusStrip — the chat sidebar's ambient pot health + fold-out panel
 * (operator-chat-sidebar-revival-2026-07-13 P-018, approved mockup variant A).
 *
 * Design thesis (P-016/P-017, owner-approved): the sidebar shows the DIGEST,
 * not the dashboards. The one-line strip is always visible — Mug + Kettle
 * liveness with last-wake age, working-cup count, ready count, a "need you"
 * badge — and clicking it folds out the pot panel: Needs attention (anomalies
 * + escalations, the Kettle's funnel), Cups (who's doing what), Up next (the
 * ranked frontier, honestly), and Your steering (the directive the Mug obeys).
 *
 * Data (reuse-first, no parallel path):
 *  - strip → `overwatch.snapshot` + `overwatch.liveness` (SSE-live; the same
 *    queries the left-rail OverwatchTab reads).
 *  - panel → `mugBrief.floorView` (the Mug-brief floor projection resolver),
 *    fetched ONLY while the panel is expanded.
 *
 * The open state is user-meaningful → nuqs (`?pot=`).
 */

import { useMemo } from 'react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import type {
  OverwatchBrief,
  OverwatchLiveness,
} from '@papercusp/operator-core/lib/overwatch/brief-types';
import type { MugBriefFloorView } from '@papercusp/operator-core/lib/pot/mug-brief-launch';

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

const ACTION_CHIP: Record<string, string> = {
  nudge: 'NUDGE',
  escalate: 'ESCALATE',
  observe: 'OBSERVE',
};

export function PotStatusStrip() {
  const [potOpen, setPotOpen] = useQueryState('pot', parseAsBoolean.withDefault(false));

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
  // The panel body is the heavier read — fetch only while expanded.
  const floorQ = useSyncQuery<MugBriefFloorView>({
    queryName: 'mugBrief.floorView',
    args: {},
    staleTime: 30_000,
    enabled: potOpen,
  });

  const snap = snapQ.data?.[0];
  const live = liveQ.data?.[0];
  const floor = floorQ.data?.[0];

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

  const attention = potOpen && floor
    ? [
        ...(snap?.anomalies ?? []).map((a) => ({
          key: `anomaly:${a.kind}:${a.subject}`,
          severity: a.severity,
          text: `${a.subject} — ${a.detail}`,
          chip: ACTION_CHIP[a.suggestedAction.type] ?? 'OBSERVE',
        })),
        ...floor.escalations.map((e) => ({
          key: e.id,
          severity: e.severity === 'critical' ? ('critical' as const) : ('warning' as const),
          text: e.summary,
          chip: 'ESCALATE',
        })),
      ]
    : [];

  const moreFrontier = floor ? Math.max(0, floor.frontierTotal - floor.frontier.length) : 0;

  return (
    <div className="op-pot-status">
      <button
        type="button"
        className="op-pot-strip"
        aria-expanded={potOpen}
        aria-label={`Pot status — Mug ${mugAge}, Kettle ${kettleAge}, ${working} working, ${ready} ready${needYou > 0 ? `, ${needYou} need you` : ''}`}
        onClick={() => void setPotOpen(!potOpen)}
      >
        <span className={`op-pot-dot ${mugOk ? 'ok' : 'bad'}`} aria-hidden="true" />
        <span className="op-pot-strip-item">Mug {mugAge}</span>
        <span className="op-pot-sep" aria-hidden="true">·</span>
        <span className={`op-pot-dot ${kettleOk ? 'ok' : 'bad'}`} aria-hidden="true" />
        <span className="op-pot-strip-item">Kettle {kettleAge}</span>
        <span className="op-pot-sep" aria-hidden="true">·</span>
        <span className="op-pot-strip-item">{working} working</span>
        <span className="op-pot-sep" aria-hidden="true">·</span>
        <span className="op-pot-strip-item">{ready} ready</span>
        {needYou > 0 && (
          <span className="op-pot-badge" title={`${needYou} need you`}>
            {compactCount(needYou)} need you
          </span>
        )}
        <span className="op-pot-caret" aria-hidden="true">{potOpen ? '▴' : '▾'}</span>
      </button>

      {potOpen && (
        <div className="op-pot-panel" role="region" aria-label="Pot status detail">
          {!floor && <div className="op-pot-empty">Loading pot status…</div>}
          {floor && (
            <>
              <section className="op-pot-section">
                <h3 className="op-pot-h">
                  Needs attention{attention.length > 0 ? ` (${attention.length})` : ''}
                </h3>
                {attention.length === 0 ? (
                  <div className="op-pot-empty">nothing — system healthy</div>
                ) : (
                  <ul className="op-pot-list">
                    {attention.map((a) => (
                      <li key={a.key} className={`op-pot-attn sev-${a.severity}`}>
                        <span className="op-pot-attn-text">{a.text}</span>
                        <span className="op-pot-chip">{a.chip}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="op-pot-section">
                <h3 className="op-pot-h">Cups ({floor.cups.length})</h3>
                {floor.cups.length === 0 ? (
                  <div className="op-pot-empty">no live cups</div>
                ) : (
                  <ul className="op-pot-list">
                    {floor.cups.map((c) => (
                      <li key={c.id} className="op-pot-cup">
                        <span className={`op-pot-dot ${c.alive ? 'ok' : 'bad'}`} aria-hidden="true" />
                        <span className="op-pot-cup-id">{c.id}</span>
                        <span className="op-pot-cup-doing">{c.doing ?? 'idle'}</span>
                        <span className="op-pot-cup-load">{c.load}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="op-pot-section">
                <h3 className="op-pot-h">Up next ({floor.frontierTotal})</h3>
                {floor.frontier.length === 0 ? (
                  <div className="op-pot-empty">
                    {floor.frontierQuarantined > 0
                      ? `frontier empty — ${floor.frontierQuarantined} quarantined by the admission gate`
                      : 'no ready work'}
                  </div>
                ) : (
                  <ol className="op-pot-list op-pot-queue">
                    {floor.frontier.map((f) => (
                      <li key={f.id} className="op-pot-next">
                        <span className="op-pot-next-id">{f.id}</span>
                        <span className="op-pot-next-title">{f.title}</span>
                      </li>
                    ))}
                  </ol>
                )}
                <div className="op-pot-foot">
                  {moreFrontier > 0 ? `+${moreFrontier} more · ` : ''}
                  {floor.frontierBlocked} blocked · {floor.frontierQuarantined} quarantined
                  {floor.openPlacements.recovering > 0
                    ? ` · ${floor.openPlacements.recovering} recovering ↻`
                    : ''}
                  {floor.openPlacements.stranded > 0
                    ? ` · ${floor.openPlacements.stranded} stranded`
                    : ''}
                </div>
              </section>

              <section className="op-pot-section">
                <h3 className="op-pot-h">Your steering</h3>
                {floor.steering ? (
                  <div className="op-pot-steering">
                    {floor.steering.directive && (
                      <div className="op-pot-directive">“{floor.steering.directive}”</div>
                    )}
                    <div className="op-pot-foot">
                      New work: {floor.steering.pauseNewWork ? 'paused' : 'allowed'}
                      {floor.steering.eligiblePlans.length > 0
                        ? ` · Eligible: ${floor.steering.eligiblePlans.join(', ')}`
                        : ''}
                    </div>
                  </div>
                ) : (
                  <div className="op-pot-empty">un-steered — the Mug places by rank</div>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </div>
  );
}
