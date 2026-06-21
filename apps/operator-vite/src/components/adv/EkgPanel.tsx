/**
 * EkgPanel — the Benchmark view's fleet behavioral heartbeat
 * (self-learning-frontier-2026-06-12 P-030 / FB-10).
 *
 * Renders the Fleet EKG's output (`learning.ekg` sync query): detected
 * distribution shifts in the fleet's session behavior — which named feature
 * moved, how hard, and WHICH behavior-change-ledger entries are the candidate
 * causes. Unattributable shifts (no ledgered mutation in the lookback) carry
 * the alarm chip — those are the D-003 attribution holes. Until the frontier
 * arming gate (the plan's P-001) flips the scan's flag the store is empty and
 * the panel renders its nothing-scanned state.
 *
 * Self-contained on purpose (own sync query + pc-ekg__* styles, mirroring
 * DemandPanel's self-carried idiom) so the LearningTab wiring stays at two
 * lines. Defensive about the snapshot shape — anything but the expected
 * {shifts: []} renders the empty state, never a crash.
 */
import { useSyncQuery } from '@papercusp/sync';
import { Activity, RefreshCw } from 'lucide-react';
import type { EkgSnapshot } from '@papercusp/operator-core/lib/fleet-ekg/ekg-read';

const num = (v: number | null): string => (v == null ? '' : Math.abs(v) >= 100 ? v.toFixed(0) : v.toPrecision(3));

function dateShort(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function EkgPanel() {
  const sync = useSyncQuery<EkgSnapshot>({ queryName: 'learning.ekg', args: {}, staleTime: 30_000 });
  const snap = sync.data?.[0];
  const shifts = Array.isArray(snap?.shifts) ? snap.shifts : [];

  return (
    <section className="pc-ekg" aria-label="Fleet EKG behavioral shifts">
      <div className="pc-ekg__head">
        <h3 className="pc-ekg__title">
          <Activity size={14} aria-hidden /> Fleet EKG
        </h3>
        <span className="pc-ekg__sub">behavioral drift across agent sessions, attributed to the change ledger</span>
        <button
          type="button"
          className="pc-ekg__refresh"
          aria-label="Reload the EKG"
          disabled={sync.fetching}
          onClick={() => sync.invalidate()}
        >
          <RefreshCw size={12} aria-hidden />
        </button>
      </div>

      {shifts.length === 0 ? (
        <p className="pc-ekg__empty">
          No shifts detected{snap?.sessionsEmbedded ? ` across ${snap.sessionsEmbedded} embedded sessions` : ''}.
          The EKG scans on a cadence — it ships dark until the frontier arming gate flips it on.
        </p>
      ) : (
        <>
          <p className="pc-ekg__rollup">
            {snap!.totalShifts} shift{snap!.totalShifts === 1 ? '' : 's'} · {snap!.unattributedShifts} unattributable ·{' '}
            {snap!.sessions7d} sessions embedded (7d)
            {snap!.scannedAt ? ` · scanned ${dateShort(snap!.scannedAt)}` : ''}
          </p>
          <ul className="pc-ekg__list">
            {shifts.map((s) => (
              <li key={s.id} className="pc-ekg__row">
                <span className={`pc-ekg__severity is-${s.severity}`}>{s.severity}</span>
                <span className="pc-ekg__feature">
                  {s.feature}
                  {s.direction ? <em className="pc-ekg__dir">{s.direction === 'up' ? '↑' : '↓'}</em> : null}
                </span>
                <span className="pc-ekg__meta">
                  <span title="Drift score (PSI for numeric, JSD for distributions)">{s.score.toFixed(3)}</span>
                  {s.baselineSummary != null && s.windowSummary != null ? (
                    <span title="Baseline median → window median">
                      {num(s.baselineSummary)}→{num(s.windowSummary)}
                    </span>
                  ) : null}
                  <span title="Window vs baseline cohort sizes">
                    {s.windowSessions}w/{s.baselineSessions}b
                  </span>
                  <span className="pc-ekg__age" title="Shift window day">{dateShort(s.windowDate)}</span>
                  {s.attributed ? (
                    <span
                      className="pc-ekg__attributed"
                      title={s.ledgerCandidates
                        .map((c) => `${c.source} ${c.target}${c.summary ? ` — ${c.summary}` : ''}`)
                        .join('\n')}
                    >
                      {s.ledgerCandidates.length} cause{s.ledgerCandidates.length === 1 ? '' : 's'}
                    </span>
                  ) : (
                    <span className="pc-ekg__alarm" title="No behavior-change-ledger entry in the lookback window">
                      unattributable
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <style>{`
        .pc-ekg { margin: 10px 0 4px; padding: 10px 12px; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); border-radius: 12px; background: var(--bg-2, rgba(255, 255, 255, 0.03)); }
        .pc-ekg__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .pc-ekg__title { display: inline-flex; align-items: center; gap: 6px; margin: 0; font-size: 12.5px; font-weight: 650; }
        .pc-ekg__sub { flex: 1 1 auto; font-size: 11px; color: var(--fg-mute, #7f9bb4); }
        .pc-ekg__refresh { display: inline-flex; align-items: center; border: none; background: none; color: var(--fg-mute, #7f9bb4); cursor: pointer; padding: 2px; }
        .pc-ekg__refresh:disabled { opacity: 0.5; cursor: default; }
        .pc-ekg__empty { margin: 8px 0 2px; font-size: 11.5px; color: var(--fg-mute, #7f9bb4); }
        .pc-ekg__rollup { margin: 6px 0 4px; font-size: 11px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
        .pc-ekg__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
        .pc-ekg__row { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; border-top: 1px solid rgba(255, 255, 255, 0.04); }
        .pc-ekg__severity { flex: none; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #06121a; border-radius: 4px; padding: 1px 5px; background: #fcd34d; }
        .pc-ekg__severity.is-major { background: #fb7185; }
        .pc-ekg__feature { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono, ui-monospace, monospace); font-size: 11.5px; }
        .pc-ekg__dir { margin-left: 4px; font-style: normal; color: var(--fg-mute, #7f9bb4); }
        .pc-ekg__meta { flex: none; display: inline-flex; gap: 8px; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
        .pc-ekg__age { opacity: 0.85; }
        .pc-ekg__attributed { color: #34d399; font-weight: 650; }
        .pc-ekg__alarm { color: #fb7185; font-weight: 650; }
      `}</style>
    </section>
  );
}

export default EkgPanel;
