/**
 * OverwatchTab (left sidebar) — the Overwatch supervisor's ACTIONABLE panel,
 * docked in the Colony left rail right after Queen
 * (system-health-tab-2026-06-15 P-008; overwatch-role-2026-06-15 B-08).
 *
 * Owner reorg 2026-06-15: the overwatch surface used to be a full /adv tab that
 * DUPLICATED the read-only Health tab's panel grid (same `SystemHealth` source).
 * That grid moved out — the Health tab is the one place for the panels (incl.
 * cross-monitor, via its Queen + Overwatch liveness cards). What's left here is
 * the overwatch's UNIQUE value, which can't live in a read-only dashboard:
 *   - the loop CONTROL/status (running / paused / pre-armed · cadence · liveness)
 *   - the ANOMALY → ACTION list (each detected anomaly + the NUDGE / OBSERVE /
 *     ESCALATE it would take — the D-001 nudge-not-replace boundary, straight off
 *     `anomaly.suggestedAction`).
 *
 * Narrow-rail idiom (mirrors QueenTab): vertical sections, `{ active }`-gated,
 * rendered only while the tab is open. Data: `overwatch.snapshot` (the brief,
 * SSE-live on the ~30s tick) + `overwatch.controlState`. Flag-gated by OVERWATCH
 * at the sidebar (LeftSidebar hides the tab when off); this also renders a clear
 * dark/empty state defensively.
 */
import { parseAsStringEnum, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { AlertTriangle, Eye } from 'lucide-react';
import type {
  Anomaly,
  AnomalyActionType,
  AnomalySeverity,
  OverwatchBrief,
  OverwatchControlState,
} from '@papercusp/operator-core/lib/overwatch/brief-types';

const SEV_TONE: Record<AnomalySeverity, string> = { critical: 'bad', warning: 'warn', info: 'mute' };
const SEV_RANK: Record<AnomalySeverity, number> = { critical: 0, warning: 1, info: 2 };
const ACTION_VERB: Record<AnomalyActionType, string> = { nudge: 'NUDGE', observe: 'OBSERVE', escalate: 'ESCALATE' };

const SEV_FILTERS = ['all', 'critical', 'warning', 'info'] as const;
type SevFilter = (typeof SEV_FILTERS)[number];

function ageLabel(ms: number | null): string {
  if (ms == null) return 'never';
  const sec = ms / 1000;
  if (sec < 60) return `${Math.round(sec)}s ago`;
  const min = sec / 60;
  if (min < 90) return `${Math.round(min)}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

function whenLabel(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function OverwatchTab({ active }: { active: boolean }) {
  const snap = useSyncQuery<OverwatchBrief>({ queryName: 'overwatch.snapshot', args: {}, staleTime: 15_000 });
  const ctrl = useSyncQuery<OverwatchControlState>({ queryName: 'overwatch.controlState', args: {}, staleTime: 15_000 });
  const [sevFilter, setSevFilter] = useQueryState(
    'owsev',
    parseAsStringEnum<SevFilter>([...SEV_FILTERS]).withDefault('all'),
  );

  const brief = active ? snap.data?.[0] : undefined;
  const control = ctrl.data?.[0];

  if (!brief) {
    return (
      <div className="pc-owsb pc-owsb--empty">
        <div className="pc-owsb__placeholder">
          {snap.error
            ? `Overwatch unavailable — ${String(snap.error)}`
            : snap.loading
              ? 'Loading the overwatch brief…'
              : 'Overwatch is paused/dark. The full system health is on the Health tab.'}
        </div>
        <OverwatchStyles />
      </div>
    );
  }

  const anomalies = [...brief.anomalies]
    .map((a, idx) => ({ a, idx }))
    .sort((x, y) => SEV_RANK[x.a.severity] - SEV_RANK[y.a.severity] || x.idx - y.idx)
    .map(({ a }) => a)
    .filter((a) => sevFilter === 'all' || a.severity === sevFilter);
  const crit = brief.anomalies.filter((a) => a.severity === 'critical').length;
  const warn = brief.anomalies.filter((a) => a.severity === 'warning').length;

  const running = !!control?.started && !!control?.flagEnabled;
  const preArmed = !!control?.started && !control?.flagEnabled;
  const tone = running ? 'good' : preArmed ? 'warn' : 'mute';
  const stateLabel = running ? 'Running' : preArmed ? 'Pre-armed' : 'Paused';
  const cadenceMin = control ? Math.round(control.cadenceSec / 60) : null;

  return (
    <div className="pc-owsb">
      {/* Control / status header */}
      <header className="pc-owsb__bar" data-tone={tone}>
        <span className={`pc-owsb__dot pc-owsb__dot--${tone}`} aria-hidden />
        <Eye size={14} aria-hidden />
        <span className="pc-owsb__title">{stateLabel}</span>
        {(control?.hiveSlug ?? brief.hiveSlug) && (
          <span className="pc-owsb__hive" title="Supervised hive">{control?.hiveSlug ?? brief.hiveSlug}</span>
        )}
      </header>
      <div className="pc-owsb__meta">
        {cadenceMin != null && <span>cadence {cadenceMin}m</span>}
        <span>{control?.armed ? `next ${whenLabel(control.nextWakeAt)}` : 'no wake armed'}</span>
        <span title="Last overwatch wake">woke {ageLabel(control?.staleForMs ?? null)}</span>
      </div>

      {/* Anomalies → actions */}
      <section className="pc-owsb__section">
        <div className="pc-owsb__section-head">
          <AlertTriangle size={12} aria-hidden />
          <span className="pc-owsb__section-title">Anomalies</span>
          <div className="pc-owsb__counts">
            {crit > 0 && <span className="pc-owsb__count pc-owsb__count--bad">{crit} crit</span>}
            {warn > 0 && <span className="pc-owsb__count pc-owsb__count--warn">{warn} warn</span>}
            {crit === 0 && warn === 0 && <span className="pc-owsb__count pc-owsb__count--good">clear</span>}
          </div>
        </div>
        <div className="pc-owsb__filters" role="group" aria-label="Filter anomalies by severity">
          {SEV_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={`pc-owsb__chip${sevFilter === f ? ' pc-owsb__chip--on' : ''}`}
              aria-pressed={sevFilter === f}
              onClick={() => void setSevFilter(f === 'all' ? null : f)}
            >
              {f}
            </button>
          ))}
        </div>
        {brief.anomalies.length === 0 ? (
          <div className="pc-owsb__healthy">No anomalies — system healthy.</div>
        ) : anomalies.length === 0 ? (
          <div className="pc-owsb__placeholder">No {sevFilter} anomalies.</div>
        ) : (
          <ul className="pc-owsb__anoms">
            {anomalies.map((a, i) => (
              <AnomalyRow key={`${a.kind}-${a.subject}-${i}`} anomaly={a} />
            ))}
          </ul>
        )}
      </section>

      <div className="pc-owsb__footnote">
        Full system health → the <strong>Health</strong> tab. This panel is the supervisor's actions.
      </div>

      <OverwatchStyles />
    </div>
  );
}

function AnomalyRow({ anomaly }: { anomaly: Anomaly }) {
  const tone = SEV_TONE[anomaly.severity];
  const act = anomaly.suggestedAction;
  return (
    <li className={`pc-owsb__anom pc-owsb__anom--${tone}`}>
      <div className="pc-owsb__anom-head">
        <span className={`pc-owsb__sev pc-owsb__sev--${tone}`}>{anomaly.severity}</span>
        <span className="pc-owsb__kind" title={anomaly.subject}>{anomaly.kind}</span>
        <span className={`pc-owsb__verb pc-owsb__verb--${act.type}`}>
          {ACTION_VERB[act.type]}
          {act.target ? ` ${act.target}` : ''}
        </span>
      </div>
      <div className="pc-owsb__anom-detail">{anomaly.detail}</div>
      {act.message && <div className="pc-owsb__anom-msg">“{act.message}”</div>}
    </li>
  );
}

function OverwatchStyles() {
  return (
    <style>{`
      .pc-owsb { display: flex; flex-direction: column; gap: 9px; padding: 10px 10px 16px; min-height: 0; }
      .pc-owsb--empty { padding-top: 24px; }
      .pc-owsb__placeholder { color: var(--fg-mute, #7f9bb4); font-size: 11.5px; line-height: 1.4; padding: 8px 2px; }

      .pc-owsb__bar {
        display: flex; align-items: center; gap: 7px; padding: 7px 10px; border-radius: 9px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16)); background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      .pc-owsb__bar[data-tone='good'] { border-color: rgba(52, 211, 153, 0.4); background: rgba(52, 211, 153, 0.06); }
      .pc-owsb__bar[data-tone='warn'] { border-color: rgba(251, 191, 36, 0.4); background: rgba(251, 191, 36, 0.06); }
      .pc-owsb__bar svg { color: var(--fg-dim, #b9d4e8); }
      .pc-owsb__title { font-size: 12px; font-weight: 760; letter-spacing: 0.03em; text-transform: uppercase; color: var(--fg, #e7f7ff); }
      .pc-owsb__hive {
        margin-left: auto; font-size: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-mute, #7f9bb4);
        padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 130px;
      }
      .pc-owsb__dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .pc-owsb__dot--good { background: #34d399; box-shadow: 0 0 5px rgba(52, 211, 153, 0.7); }
      .pc-owsb__dot--warn { background: #fbbf24; box-shadow: 0 0 5px rgba(251, 191, 36, 0.6); }
      .pc-owsb__dot--mute { background: #475569; }
      .pc-owsb__meta {
        display: flex; flex-wrap: wrap; gap: 3px 10px; padding: 0 2px;
        font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums;
      }

      .pc-owsb__section {
        display: flex; flex-direction: column; gap: 7px; padding: 9px 10px; border-radius: 10px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.14)); background: var(--bg-2, rgba(255, 255, 255, 0.03));
      }
      .pc-owsb__section-head { display: flex; align-items: center; gap: 6px; }
      .pc-owsb__section-head svg { color: var(--fg-mute, #7f9bb4); }
      .pc-owsb__section-title { font-size: 10.5px; font-weight: 760; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg, #e7f7ff); }
      .pc-owsb__counts { margin-left: auto; display: flex; gap: 4px; }
      .pc-owsb__count { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); color: var(--fg-mute, #7f9bb4); }
      .pc-owsb__count--bad { color: #fca5a5; border-color: rgba(244, 63, 94, 0.5); background: rgba(244, 63, 94, 0.12); }
      .pc-owsb__count--warn { color: #fcd34d; border-color: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.12); }
      .pc-owsb__count--good { color: #6ee7b7; border-color: rgba(52, 211, 153, 0.45); background: rgba(52, 211, 153, 0.1); }

      .pc-owsb__filters { display: flex; gap: 4px; flex-wrap: wrap; }
      .pc-owsb__chip {
        font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; cursor: pointer;
        padding: 2px 8px; border-radius: 999px; color: var(--fg-mute, #7f9bb4);
        background: var(--bg-3, rgba(255, 255, 255, 0.04)); border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
      }
      .pc-owsb__chip--on { color: var(--fg, #e7f7ff); border-color: rgba(99, 102, 241, 0.6); background: rgba(99, 102, 241, 0.16); }
      .pc-owsb__healthy {
        font-size: 11px; color: #6ee7b7; padding: 8px 10px; border-radius: 8px;
        border: 1px solid rgba(52, 211, 153, 0.3); background: rgba(52, 211, 153, 0.07);
      }

      .pc-owsb__anoms { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 420px; overflow-y: auto; }
      .pc-owsb__anom {
        display: flex; flex-direction: column; gap: 3px; padding: 7px 9px; border-radius: 8px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.14)); border-left: 3px solid var(--accent, #475569);
        background: rgba(255, 255, 255, 0.02);
      }
      .pc-owsb__anom--bad { --accent: #f43f5e; background: rgba(244, 63, 94, 0.06); }
      .pc-owsb__anom--warn { --accent: #fbbf24; background: rgba(251, 191, 36, 0.05); }
      .pc-owsb__anom--mute { --accent: #38bdf8; }
      .pc-owsb__anom-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .pc-owsb__sev { font-size: 8.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; padding: 1px 6px; border-radius: 999px; }
      .pc-owsb__sev--bad { color: #fca5a5; background: rgba(244, 63, 94, 0.16); }
      .pc-owsb__sev--warn { color: #fcd34d; background: rgba(251, 191, 36, 0.16); }
      .pc-owsb__sev--mute { color: #93c5fd; background: rgba(125, 211, 252, 0.14); }
      .pc-owsb__kind {
        font-size: 10.5px; font-weight: 750; color: var(--fg, #e7f7ff);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
      }
      .pc-owsb__verb {
        margin-left: auto; font-size: 8.5px; font-weight: 800; letter-spacing: 0.05em; padding: 1px 7px; border-radius: 999px;
        border: 1px solid currentColor; white-space: nowrap;
      }
      .pc-owsb__verb--nudge { color: #818cf8; }
      .pc-owsb__verb--observe { color: #38bdf8; }
      .pc-owsb__verb--escalate { color: #fb7185; }
      .pc-owsb__anom-detail { font-size: 11px; line-height: 1.35; color: var(--fg-dim, #b9d4e8); }
      .pc-owsb__anom-msg { font-size: 10.5px; line-height: 1.35; color: var(--fg-mute, #7f9bb4); font-style: italic; }

      .pc-owsb__footnote { font-size: 10px; line-height: 1.4; color: var(--fg-mute, #7f9bb4); padding: 0 2px; }
      .pc-owsb__footnote strong { color: var(--fg-dim, #b9d4e8); font-weight: 700; }
    `}</style>
  );
}
