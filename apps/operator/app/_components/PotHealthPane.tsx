'use client';

/**
 * PotHealthPane — the full-height "what the pot's minds decide from" view that
 * REPLACES the chat body while the header 🫖 toggle is on (WI-4778, owner
 * design 2026-07-14, frozen v2 mockup).
 *
 * Owner thesis: Papercup is the ONE persona you talk to — the Mug and Kettle
 * are never chats. But the owner must be able to SEE the information each of
 * them decides from. This pane renders exactly that, in one scroll:
 *   ☕ Mug section — her REAL wake-brief floor (`mugBrief.floorView`): the
 *      ranked frontier (+blocked/quarantined), live cups, open placements,
 *      inference capacity, escalations, owner steering, and her carry-note.
 *   🌡 Kettle section — its REAL brief (`overwatch.snapshot` +
 *      `overwatch.liveness`): the health panels (mug/cups/work-feed/tokens/
 *      plans), detected anomalies with the action it would take, the
 *      cross-monitor legs, and the observation lane.
 *
 * Data is reuse-first — the same sync queries the pot strip reads (SSE-live,
 * no polling); nothing here invents a parallel data path. Sections render the
 * briefs' REAL fields only: no fabricated meters, no data the agents don't
 * actually see. Row/chip/dot idioms reuse the existing `op-pot-*` classes;
 * pane-specific layout is `op-ph-*` (globals.css).
 */

import { useMemo } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { Coffee, Thermometer } from 'lucide-react';
import type {
  OverwatchBrief,
  OverwatchLiveness,
} from '@papercusp/operator-core/lib/overwatch/brief-types';
import type { MugBriefFloorView } from '@papercusp/operator-core/lib/pot/mug-brief-launch';
import { compactAge, compactCount, splitLeadingWi } from './pot-health-format';

const ACTION_CHIP: Record<string, string> = {
  nudge: 'NUDGE',
  escalate: 'ESCALATE',
  observe: 'OBSERVE',
};

const ACTION_TONE: Record<string, string> = {
  nudge: 'nudge',
  escalate: 'esc',
  observe: 'obs',
};

/** Dot tone from a boolean health reading. */
function dot(ok: boolean): string {
  return ok ? 'ok' : 'bad';
}

/** One label → value line in a card's kv grid, with an optional liveness dot. */
function KvRow({ k, v, tone }: { k: string; v: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <>
      <span className="op-ph-k">{k}</span>
      <span className="op-ph-v">
        {tone != null && <span className={`op-pot-dot ${tone}`} aria-hidden="true" />}
        {v}
      </span>
    </>
  );
}

export function PotHealthPane() {
  const floorQ = useSyncQuery<MugBriefFloorView>({
    queryName: 'mugBrief.floorView',
    args: {},
    staleTime: 30_000,
  });
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

  const floor = floorQ.data?.[0];
  const snap = snapQ.data?.[0];
  const live = liveQ.data?.[0];

  const needYou = useMemo(() => {
    const critical = (snap?.anomalies ?? []).filter((a) => a.severity !== 'info').length;
    return critical + (snap?.plans.agingEscalations ?? 0) + (floor?.escalations.length ?? 0);
  }, [snap, floor]);

  if (!floor && !snap && !live) {
    return (
      <div className="op-ph" role="region" aria-label="Pot health">
        <div className="op-pot-empty op-ph-loading">Loading pot health…</div>
      </div>
    );
  }

  const mugOk = !!snap && !snap.queen.stalled;
  const kettleOk = !!live && live.alive;
  const moreFrontier = floor ? Math.max(0, floor.frontierTotal - floor.frontier.length) : 0;
  const pausedBuckets = snap?.tokens.pausedBuckets ?? [];
  const anomalies = snap?.anomalies ?? [];
  const observationsByRole = Object.entries(snap?.observations.recentByRole ?? {});

  return (
    <div className="op-ph" role="region" aria-label="Pot health">
      {/* Ambient digest chips — the strip's read, restated at the top of the
          full view so the glance survives the mode switch. */}
      <div className="op-ph-chips">
        <span className={`op-ph-chip ${mugOk ? 'ok' : 'bad'}`}>
          Mug {compactAge(snap?.queen.lastWakeAt ?? null)}
        </span>
        <span className={`op-ph-chip ${kettleOk ? 'ok' : 'bad'}`}>
          Kettle {compactAge(live?.lastRunAt ?? null)}
        </span>
        <span className="op-ph-chip">{snap?.bees.running ?? 0} working</span>
        <span className="op-ph-chip">{snap?.workFeed.frontier ?? 0} ready</span>
        {snap != null && (
          <span className={`op-ph-chip ${snap.tokens.accountsAvailable > 0 ? '' : 'warn'}`}>
            {snap.tokens.accountsAvailable} accounts up
          </span>
        )}
        {needYou > 0 && (
          <span className="op-ph-chip bad">{compactCount(needYou)} need you</span>
        )}
      </div>

      <div className="op-ph-body">
        {/* ── 🌡 The Kettle — what it heals the system from ──────────────── */}
        <h3 className="op-ph-sec ket">
          <Thermometer size={12} strokeWidth={2} aria-hidden="true" />
          What the Kettle looks at
          <span className="op-ph-sec-d">system healing</span>
        </h3>

        {!snap && <div className="op-pot-empty">Loading the Kettle&apos;s brief…</div>}
        {snap && (
          <>
            <section className="op-ph-card ket" aria-label="Health panels">
              <h4 className="op-ph-card-h">Health panels</h4>
              <div className="op-ph-kv">
                <KvRow
                  k="mug"
                  v={`${snap.queen.stalled ? 'stalled' : snap.queen.cadenceOk ? 'on cadence' : 'off cadence'} · woke ${compactAge(snap.queen.lastWakeAt)} ago · driving ${snap.queen.workingTracked}`}
                  tone={snap.queen.stalled ? 'bad' : snap.queen.cadenceOk ? 'ok' : 'warn'}
                />
                <KvRow
                  k="cups"
                  v={`${snap.bees.running} running · ${snap.bees.completed} completed · ${snap.bees.churning} churning · ${snap.bees.deadClaims} dead claims`}
                  tone={snap.bees.churning > 0 || snap.bees.deadClaims > 0 ? 'warn' : 'ok'}
                />
                <KvRow
                  k="work-feed"
                  v={`${snap.workFeed.frontier} ready · ${snap.workFeed.autoEligibleStuck} stuck · ${snap.workFeed.deadRoutines} dead routines · ${snap.workFeed.blockedStranded} stranded`}
                  tone={snap.workFeed.deadRoutines > 0 ? 'bad' : snap.workFeed.autoEligibleStuck > 0 ? 'warn' : 'ok'}
                />
                <KvRow
                  k="tokens"
                  v={`${snap.tokens.accountsAvailable} accounts up${pausedBuckets.length > 0 ? ` · paused: ${pausedBuckets.join(', ')}` : ''}${snap.tokens.gatewayWedged ? ' · gateway WEDGED' : snap.tokens.gatewaySustainedThrottle ? ' · gateway throttling' : ''}`}
                  tone={snap.tokens.gatewayWedged ? 'bad' : pausedBuckets.length > 0 || snap.tokens.gatewaySustainedThrottle ? 'warn' : 'ok'}
                />
                <KvRow
                  k="plans"
                  v={`${snap.plans.active} active · ${snap.plans.stalledItems} stalled items · ${snap.plans.agingEscalations} aging escalations`}
                  tone={snap.plans.agingEscalations > 0 ? 'warn' : 'ok'}
                />
              </div>
            </section>

            <section className="op-ph-card ket" aria-label="Anomalies and suggested actions">
              <h4 className="op-ph-card-h">
                Anomalies → suggested action
                {anomalies.length > 0 && <span className="op-ph-card-n">{anomalies.length} open</span>}
              </h4>
              {anomalies.length === 0 ? (
                <div className="op-pot-empty">none — system healthy</div>
              ) : (
                <ul className="op-pot-list">
                  {anomalies.map((a) => (
                    <li key={`${a.kind}:${a.subject}`} className={`op-pot-attn sev-${a.severity}`}>
                      <span className="op-pot-attn-text">
                        <b className="op-pot-attn-subj">{a.subject}</b>
                        {' — '}
                        {a.detail}
                      </span>
                      <span className={`op-pot-chip ${ACTION_TONE[a.suggestedAction.type] ?? 'obs'}`}>
                        {ACTION_CHIP[a.suggestedAction.type] ?? 'OBSERVE'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="op-ph-card ket" aria-label="Cross monitor and wake">
              <h4 className="op-ph-card-h">Cross-monitor &amp; wake</h4>
              <div className="op-ph-kv">
                <KvRow k="mug alive" v={snap.crossMonitor.queenAlive ? 'yes' : 'DARK'} tone={dot(snap.crossMonitor.queenAlive) as 'ok' | 'bad'} />
                <KvRow k="kettle alive" v={kettleOk ? `yes · last run ${compactAge(live?.lastRunAt ?? null)} ago` : 'DARK'} tone={dot(kettleOk) as 'ok' | 'bad'} />
                {snap.wokeBy != null && <KvRow k="woke by" v={snap.wokeBy} />}
                <KvRow
                  k="owner steering"
                  v={snap.ownerSteering.pauseNewWork ? 'new work paused' : 'new work allowed'}
                  tone={snap.ownerSteering.pauseNewWork ? 'warn' : 'ok'}
                />
              </div>
            </section>

            <section className="op-ph-card ket" aria-label="Observations">
              <h4 className="op-ph-card-h">
                Observations
                <span className="op-ph-card-n">fed to ideation</span>
              </h4>
              {snap.observations.laneCount === 0 ? (
                <div className="op-pot-empty">none recorded this window</div>
              ) : (
                <div className="op-ph-kv">
                  <KvRow k="this window" v={`${snap.observations.laneCount} recorded`} />
                  {observationsByRole.map(([role, n]) => (
                    <KvRow key={role} k={role} v={`${n}`} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {/* ── ☕ The Mug — what she places work from ─────────────────────── */}
        <h3 className="op-ph-sec mug">
          <Coffee size={12} strokeWidth={2} aria-hidden="true" />
          What the Mug looks at
          <span className="op-ph-sec-d">work placement</span>
        </h3>

        {!floor && <div className="op-pot-empty">Loading the Mug&apos;s brief…</div>}
        {floor && (
          <>
            <section className="op-ph-card mug" aria-label="Ranked frontier">
              <h4 className="op-ph-card-h">
                Ranked frontier
                <span className="op-ph-card-n">
                  {floor.frontierTotal} ready · {floor.frontierBlocked} blocked · {floor.frontierQuarantined} quarantined
                </span>
              </h4>
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
              {moreFrontier > 0 && <div className="op-pot-foot">+{moreFrontier} more in rank order</div>}
            </section>

            <section className="op-ph-card mug" aria-label="Cups">
              <h4 className="op-ph-card-h">
                Cups
                <span className="op-ph-card-n">load · liveness · doing</span>
              </h4>
              {floor.cups.length === 0 ? (
                <div className="op-pot-empty">no live cups</div>
              ) : (
                <ul className="op-pot-list op-pot-cups">
                  {floor.cups.map((c) => {
                    const doing = c.doing != null ? splitLeadingWi(c.doing) : null;
                    return (
                      <li key={c.id} className={`op-pot-cup${c.doing != null ? '' : ' idle'}`}>
                        <span className="op-pot-cup-glyph" aria-hidden="true">☕</span>
                        <span className="op-pot-cup-id">{c.id}</span>
                        <span className="op-pot-cup-doing">
                          {doing == null ? (
                            'idle'
                          ) : (
                            <>
                              {doing.wi != null && (
                                <>
                                  <span className="op-pot-wi">{doing.wi}</span>{' '}
                                </>
                              )}
                              {doing.rest}
                            </>
                          )}
                        </span>
                        <span className="op-pot-cup-load">{c.load}</span>
                        <span className={`op-pot-dot ${dot(c.alive)}`} aria-hidden="true" />
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="op-ph-card mug" aria-label="Placements and capacity">
              <h4 className="op-ph-card-h">Placements &amp; capacity</h4>
              <div className="op-ph-kv">
                <KvRow
                  k="placements"
                  v={`${floor.openPlacements.workingTracked} working · ${floor.openPlacements.recovering} recovering · ${floor.openPlacements.stranded} stranded`}
                  tone={floor.openPlacements.stranded > 0 ? 'warn' : 'ok'}
                />
                {floor.capacity ? (
                  <>
                    <KvRow
                      k="inference pool"
                      v={`${Math.round(floor.capacity.factor * 100)}% headroom${floor.capacity.utilizationPct != null ? ` · ${Math.round(floor.capacity.utilizationPct)}% used` : ''}${floor.capacity.paused ? ' · paused' : ''}`}
                      tone={floor.capacity.paused ? 'bad' : floor.capacity.factor < 0.25 ? 'warn' : 'ok'}
                    />
                    {floor.capacity.dispatchBudget != null && (
                      <KvRow k="dispatch budget" v={`${floor.capacity.dispatchBudget} spare cup slots`} />
                    )}
                    <KvRow k="advice" v={floor.capacity.advice} />
                  </>
                ) : (
                  <KvRow k="inference pool" v="no capacity read (gateway unreachable)" tone="warn" />
                )}
              </div>
            </section>

            <section className="op-ph-card mug" aria-label="Escalations and steering">
              <h4 className="op-ph-card-h">
                Escalations &amp; steering
                {floor.escalations.length > 0 && (
                  <span className="op-ph-card-n">{floor.escalations.length} open</span>
                )}
              </h4>
              {floor.escalations.length === 0 ? (
                <div className="op-pot-empty">no open escalations</div>
              ) : (
                <ul className="op-pot-list">
                  {floor.escalations.map((e) => (
                    <li key={e.id} className={`op-pot-attn sev-${e.severity === 'critical' ? 'critical' : 'warning'}`}>
                      <span className="op-pot-attn-text">
                        <b className="op-pot-attn-subj">{e.id}</b>
                        {' — '}
                        {e.summary}
                      </span>
                      <span className="op-pot-chip esc">OWNER</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="op-pot-steering op-ph-steering">
                {floor.steering ? (
                  <>
                    {floor.steering.directive && (
                      <div className="op-pot-directive">“{floor.steering.directive}”</div>
                    )}
                    <div className="op-pot-steer-facts">
                      <span>
                        New work: <b>{floor.steering.pauseNewWork ? 'paused' : 'allowed'}</b>
                      </span>
                      {floor.steering.eligiblePlans.length > 0 && (
                        <span>Eligible: {floor.steering.eligiblePlans.join(', ')}</span>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="op-pot-empty">un-steered — the Mug places by rank</div>
                )}
                {floor.carryNote && (
                  <div className="op-ph-carry" title={`written ${compactAge(floor.carryNote.at)} ago`}>
                    carry-note: {floor.carryNote.note}
                  </div>
                )}
              </div>
            </section>
          </>
        )}

      </div>
    </div>
  );
}
