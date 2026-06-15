/**
 * OverwatchTab — the Overwatch supervisor's ACTIONABLE view
 * (overwatch-role-2026-06-15 B-08, D-006).
 *
 * Sibling to the read-only Health tab: where Health is the full human dashboard,
 * THIS is the overwatch's actionable surface — its current brief (the health
 * panels), the anomalies it has detected this wake, and the NUDGE / OBSERVE /
 * ESCALATE action it would take for each (the D-001 nudge-not-replace boundary,
 * rendered straight off `anomaly.suggestedAction`). The header shows the loop's
 * control state (started / paused / pre-armed) + cadence + liveness.
 *
 * Data (D-006: one health aggregation, two consumers):
 *  - `overwatch.snapshot`     → the `OverwatchBrief` (mapped from the SAME cached
 *    SystemHealth the Health tab reads; SSE-live on the ~30s tick).
 *  - `overwatch.controlState` → the started bit + cadence + flag + liveness
 *    (invalidated by overwatch:start / overwatch:pause, B-07).
 *
 * Flag-gated (D-009): AdvShell hides the tab when `papercusp-overwatch` is OFF;
 * this component also renders a clear "pre-armed / dark" state defensively.
 */
import { parseAsStringEnum, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { Activity, AlertTriangle, Bell, Coins, Crown, Eye, ListChecks, Radio, Workflow } from 'lucide-react';
import type {
  Anomaly,
  AnomalyActionType,
  AnomalySeverity,
  OverwatchBrief,
  OverwatchControlState,
} from '@papercusp/operator-core/lib/overwatch/brief-types';

/** Anomaly severity → the shared status tone (matches HealthTab's good/warn/bad/mute). */
const SEV_TONE: Record<AnomalySeverity, string> = { critical: 'bad', warning: 'warn', info: 'mute' };
const SEV_RANK: Record<AnomalySeverity, number> = { critical: 0, warning: 1, info: 2 };
const ACTION_VERB: Record<AnomalyActionType, string> = { nudge: 'NUDGE', observe: 'OBSERVE', escalate: 'ESCALATE' };

/** The anomaly-severity filter (nuqs ?owsev=) — URL-backed so it survives refresh
 *  and is agent-controllable (ui:dispatch). */
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

export default function OverwatchTab() {
  const snap = useSyncQuery<OverwatchBrief>({ queryName: 'overwatch.snapshot', args: {}, staleTime: 15_000 });
  const ctrl = useSyncQuery<OverwatchControlState>({ queryName: 'overwatch.controlState', args: {}, staleTime: 15_000 });
  const [sevFilter, setSevFilter] = useQueryState(
    'owsev',
    parseAsStringEnum<SevFilter>([...SEV_FILTERS]).withDefault('all'),
  );

  const brief = snap.data?.[0];
  const control = ctrl.data?.[0];

  if (!brief) {
    return (
      <div className="pc-ow pc-ow--empty">
        <div className="pc-ow__placeholder">
          {snap.error
            ? `Overwatch unavailable — ${String(snap.error)}`
            : snap.loading
              ? 'Loading the overwatch brief…'
              : 'Overwatch is disabled.'}
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
  const critCount = brief.anomalies.filter((a) => a.severity === 'critical').length;
  const warnCount = brief.anomalies.filter((a) => a.severity === 'warning').length;

  return (
    <div className="pc-ow">
      <OverwatchHeader control={control} hiveSlug={brief.hiveSlug} crit={critCount} warn={warnCount} />

      <section className="pc-ow__section">
        <div className="pc-ow__section-head">
          <AlertTriangle size={13} aria-hidden />
          <span className="pc-ow__section-title">Anomalies — detected this wake</span>
          <div className="pc-ow__filters" role="group" aria-label="Filter anomalies by severity">
            {SEV_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                className={`pc-ow__chip${sevFilter === f ? ' pc-ow__chip--on' : ''}`}
                aria-pressed={sevFilter === f}
                onClick={() => void setSevFilter(f === 'all' ? null : f)}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        {brief.anomalies.length === 0 ? (
          <div className="pc-ow__healthy">No anomalies — system healthy.</div>
        ) : anomalies.length === 0 ? (
          <div className="pc-ow__healthy">No {sevFilter} anomalies.</div>
        ) : (
          <ul className="pc-ow__anoms">
            {anomalies.map((a, i) => (
              <AnomalyRow key={`${a.kind}-${a.subject}-${i}`} anomaly={a} />
            ))}
          </ul>
        )}
      </section>

      <section className="pc-ow__section">
        <div className="pc-ow__section-head">
          <Activity size={13} aria-hidden />
          <span className="pc-ow__section-title">System health</span>
        </div>
        <div className="pc-ow__grid">
          <Panel icon={Crown} label="Queen">
            <Metric v={brief.queen.stalled ? 'STALLED' : brief.queen.cadenceOk ? 'on cadence' : 'off cadence'} l="status" tone={brief.queen.stalled ? 'bad' : undefined} />
            <Metric v={brief.queen.workingTracked} l="driving" />
            <Metric v={whenLabel(brief.queen.lastWakeAt)} l="last woke" />
            <Metric v={whenLabel(brief.queen.nextFireAt)} l="next wake" />
          </Panel>
          <Panel icon={Workflow} label="Bees">
            <Metric v={brief.bees.running} l="running" />
            <Metric v={brief.bees.churning} l="churning" tone={brief.bees.churning > 0 ? 'warn' : undefined} />
            <Metric v={brief.bees.deadClaims} l="dead claims" tone={brief.bees.deadClaims > 0 ? 'warn' : undefined} />
          </Panel>
          <Panel icon={ListChecks} label="Work feed">
            <Metric v={brief.workFeed.frontier} l="frontier" />
            <Metric v={brief.workFeed.deadRoutines} l="dead routines" tone={brief.workFeed.deadRoutines > 0 ? 'bad' : undefined} />
            <Metric v={brief.workFeed.blockedStranded} l="stranded" tone={brief.workFeed.blockedStranded > 0 ? 'warn' : undefined} />
            <Metric v={brief.workFeed.autoEligibleStuck} l="stuck" tone={brief.workFeed.autoEligibleStuck > 0 ? 'warn' : undefined} />
          </Panel>
          <Panel icon={Coins} label="Tokens / gateway">
            <Metric
              v={brief.tokens.pausedBuckets.length ? brief.tokens.pausedBuckets.join(', ') : 'none'}
              l="paused"
              tone={brief.tokens.pausedBuckets.length ? 'warn' : undefined}
            />
            <Metric v={brief.tokens.accountsAvailable} l="accounts" tone={brief.tokens.accountsAvailable <= 0 ? 'bad' : undefined} />
          </Panel>
          <Panel icon={ListChecks} label="Plans + escalations">
            <Metric v={brief.plans.active} l="active" />
            <Metric v={brief.plans.stalledItems} l="stalled" tone={brief.plans.stalledItems > 0 ? 'warn' : undefined} />
            <Metric v={brief.plans.agingEscalations} l="aging esc." tone={brief.plans.agingEscalations > 0 ? 'warn' : undefined} />
          </Panel>
          <Panel icon={Bell} label="Observation lane">
            <Metric v={brief.observations.laneCount} l="this window" />
            <Metric v={byRoleLabel(brief.observations.recentByRole)} l="by role" />
          </Panel>
          <Panel icon={Radio} label="Cross-monitor">
            <Metric v={brief.crossMonitor.queenAlive ? 'alive' : 'DARK'} l="queen" tone={brief.crossMonitor.queenAlive ? undefined : 'bad'} />
            <Metric v={brief.crossMonitor.overwatchAlive ? 'alive' : 'DARK'} l="overwatch" tone={brief.crossMonitor.overwatchAlive ? undefined : 'bad'} />
          </Panel>
        </div>
      </section>

      <OverwatchStyles />
    </div>
  );
}

function OverwatchHeader({
  control,
  hiveSlug,
  crit,
  warn,
}: {
  control: OverwatchControlState | undefined;
  hiveSlug: string;
  crit: number;
  warn: number;
}) {
  // started + flag on = running; started + flag off = pre-armed; else paused.
  const running = !!control?.started && !!control?.flagEnabled;
  const preArmed = !!control?.started && !control?.flagEnabled;
  const tone = running ? 'good' : preArmed ? 'warn' : 'mute';
  const label = running ? 'Overwatch running' : preArmed ? 'Pre-armed — flag off' : 'Overwatch paused';
  const cadenceMin = control ? Math.round(control.cadenceSec / 60) : null;

  return (
    <header className="pc-ow__bar" data-tone={tone}>
      <span className={`pc-ow__dot pc-ow__dot--${tone}`} aria-hidden />
      <Eye size={15} aria-hidden />
      <span className="pc-ow__overall">{label}</span>
      <span className="pc-ow__hive" title="Supervised hive">{control?.hiveSlug ?? hiveSlug}</span>
      <div className="pc-ow__counts">
        {crit > 0 && <span className="pc-ow__count pc-ow__count--bad">{crit} critical</span>}
        {warn > 0 && <span className="pc-ow__count pc-ow__count--warn">{warn} warning</span>}
        {crit === 0 && warn === 0 && <span className="pc-ow__count pc-ow__count--good">no anomalies</span>}
      </div>
      <span className="pc-ow__spacer" />
      {cadenceMin != null && <span className="pc-ow__meta">cadence {cadenceMin}m</span>}
      <span className="pc-ow__meta">
        {control?.armed ? `next ${whenLabel(control.nextWakeAt)}` : 'no wake armed'}
      </span>
      <span className="pc-ow__meta" title="Last overwatch wake">woke {ageLabel(control?.staleForMs ?? null)}</span>
    </header>
  );
}

function AnomalyRow({ anomaly }: { anomaly: Anomaly }) {
  const tone = SEV_TONE[anomaly.severity];
  const act = anomaly.suggestedAction;
  return (
    <li className={`pc-ow__anom pc-ow__anom--${tone}`}>
      <div className="pc-ow__anom-head">
        <span className={`pc-ow__sev pc-ow__sev--${tone}`}>{anomaly.severity}</span>
        <span className="pc-ow__kind">{anomaly.kind}</span>
        <span className="pc-ow__subject">{anomaly.subject}</span>
        <span className={`pc-ow__verb pc-ow__verb--${act.type}`}>
          {ACTION_VERB[act.type]}
          {act.target ? ` ${act.target}` : ''}
        </span>
      </div>
      <div className="pc-ow__anom-detail">{anomaly.detail}</div>
      {act.message && <div className="pc-ow__anom-msg">“{act.message}”</div>}
    </li>
  );
}

function Panel({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="pc-ow__panel">
      <div className="pc-ow__panel-head">
        <Icon size={13} aria-hidden />
        <span className="pc-ow__panel-title">{label}</span>
      </div>
      <div className="pc-ow__metrics">{children}</div>
    </section>
  );
}

function Metric({ v, l, tone }: { v: string | number; l: string; tone?: string }) {
  return (
    <div className="pc-ow__metric" data-tone={tone}>
      <span className="pc-ow__metric-val">{v}</span>
      <span className="pc-ow__metric-label">{l}</span>
    </div>
  );
}

function byRoleLabel(byRole: Record<string, number>): string {
  const entries = Object.entries(byRole).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return 'none';
  return entries.map(([role, n]) => `${role} ${n}`).join(', ');
}

function OverwatchStyles() {
  return (
    <style>{`
      .pc-ow { display: flex; flex-direction: column; gap: 12px; min-height: 0; flex: 1; padding: 14px 16px 18px; }
      .pc-ow--empty { align-items: center; justify-content: center; }
      .pc-ow__placeholder { color: var(--fg-mute, #7f9bb4); font-size: 13px; padding: 40px; }

      /* Control / status bar */
      .pc-ow__bar {
        display: flex; align-items: center; gap: 9px; padding: 10px 14px; border-radius: 12px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16)); background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      .pc-ow__bar[data-tone='good'] { border-color: rgba(52, 211, 153, 0.4); background: rgba(52, 211, 153, 0.06); }
      .pc-ow__bar[data-tone='warn'] { border-color: rgba(251, 191, 36, 0.4); background: rgba(251, 191, 36, 0.06); }
      .pc-ow__bar svg { color: var(--fg-dim, #b9d4e8); }
      .pc-ow__overall { font-size: 13px; font-weight: 760; letter-spacing: 0.02em; color: var(--fg, #e7f7ff); }
      .pc-ow__hive {
        font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-mute, #7f9bb4);
        padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
      }
      .pc-ow__counts { display: flex; gap: 6px; }
      .pc-ow__count {
        font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
        padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); color: var(--fg-mute, #7f9bb4);
      }
      .pc-ow__count--bad { color: #fca5a5; border-color: rgba(244, 63, 94, 0.5); background: rgba(244, 63, 94, 0.12); }
      .pc-ow__count--warn { color: #fcd34d; border-color: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.12); }
      .pc-ow__count--good { color: #6ee7b7; border-color: rgba(52, 211, 153, 0.45); background: rgba(52, 211, 153, 0.1); }
      .pc-ow__spacer { flex: 1; }
      .pc-ow__meta { font-size: 10.5px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .pc-ow__dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
      .pc-ow__dot--good { background: #34d399; box-shadow: 0 0 6px rgba(52, 211, 153, 0.7); }
      .pc-ow__dot--warn { background: #fbbf24; box-shadow: 0 0 6px rgba(251, 191, 36, 0.6); }
      .pc-ow__dot--mute { background: #475569; }

      /* Sections */
      .pc-ow__section { display: flex; flex-direction: column; gap: 8px; }
      .pc-ow__section-head { display: flex; align-items: center; gap: 7px; color: var(--fg-dim, #b9d4e8); }
      .pc-ow__section-head svg { color: var(--fg-mute, #7f9bb4); }
      .pc-ow__section-title { font-size: 11.5px; font-weight: 760; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg, #e7f7ff); }
      .pc-ow__filters { display: flex; gap: 4px; margin-left: auto; }
      .pc-ow__chip {
        font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; cursor: pointer;
        padding: 2px 8px; border-radius: 999px; color: var(--fg-mute, #7f9bb4);
        background: var(--bg-2, rgba(255, 255, 255, 0.04)); border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
      }
      .pc-ow__chip--on { color: var(--fg, #e7f7ff); border-color: rgba(99, 102, 241, 0.6); background: rgba(99, 102, 241, 0.16); }
      .pc-ow__healthy {
        font-size: 12px; color: #6ee7b7; padding: 12px 14px; border-radius: 10px;
        border: 1px solid rgba(52, 211, 153, 0.3); background: rgba(52, 211, 153, 0.07);
      }

      /* Anomaly list */
      .pc-ow__anoms { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
      .pc-ow__anom {
        display: flex; flex-direction: column; gap: 4px; padding: 9px 12px; border-radius: 10px;
        border: 1px solid var(--card-accent, rgba(125, 211, 252, 0.16));
        background: var(--bg-2, rgba(255, 255, 255, 0.035));
      }
      .pc-ow__anom--bad { --card-accent: rgba(244, 63, 94, 0.55); background: rgba(244, 63, 94, 0.06); }
      .pc-ow__anom--warn { --card-accent: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.05); }
      .pc-ow__anom--mute { --card-accent: rgba(125, 211, 252, 0.2); }
      .pc-ow__anom-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .pc-ow__sev { font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; padding: 1px 7px; border-radius: 999px; }
      .pc-ow__sev--bad { color: #fca5a5; background: rgba(244, 63, 94, 0.16); }
      .pc-ow__sev--warn { color: #fcd34d; background: rgba(251, 191, 36, 0.16); }
      .pc-ow__sev--mute { color: #93c5fd; background: rgba(125, 211, 252, 0.14); }
      .pc-ow__kind { font-size: 11px; font-weight: 750; color: var(--fg, #e7f7ff); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .pc-ow__subject { font-size: 11px; color: var(--fg-mute, #7f9bb4); }
      .pc-ow__verb {
        margin-left: auto; font-size: 9.5px; font-weight: 800; letter-spacing: 0.05em; padding: 1px 8px; border-radius: 999px;
        border: 1px solid currentColor;
      }
      .pc-ow__verb--nudge { color: #818cf8; }
      .pc-ow__verb--observe { color: #38bdf8; }
      .pc-ow__verb--escalate { color: #fb7185; }
      .pc-ow__anom-detail { font-size: 11.5px; line-height: 1.4; color: var(--fg-dim, #b9d4e8); }
      .pc-ow__anom-msg { font-size: 11px; line-height: 1.4; color: var(--fg-mute, #7f9bb4); font-style: italic; }

      /* Health panel grid */
      .pc-ow__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(224px, 1fr)); gap: 10px; align-content: start; }
      .pc-ow__panel {
        display: flex; flex-direction: column; gap: 8px; padding: 11px 13px 12px; border-radius: 12px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.14)); background: var(--bg-2, rgba(255, 255, 255, 0.035));
      }
      .pc-ow__panel-head { display: flex; align-items: center; gap: 7px; }
      .pc-ow__panel-head svg { color: var(--fg-mute, #7f9bb4); }
      .pc-ow__panel-title { font-size: 11px; font-weight: 760; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg, #e7f7ff); }
      .pc-ow__metrics { display: flex; flex-wrap: wrap; gap: 4px 6px; border-top: 1px solid var(--border, rgba(125, 211, 252, 0.1)); padding-top: 8px; }
      .pc-ow__metric { display: flex; flex-direction: column; gap: 1px; min-width: 0; padding: 2px 7px; border-radius: 7px; background: rgba(255, 255, 255, 0.03); }
      .pc-ow__metric[data-tone='bad'] { background: rgba(244, 63, 94, 0.14); }
      .pc-ow__metric[data-tone='warn'] { background: rgba(251, 191, 36, 0.13); }
      .pc-ow__metric-val { font-size: 12px; font-weight: 750; color: var(--fg, #e7f7ff); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .pc-ow__metric[data-tone='bad'] .pc-ow__metric-val { color: #fca5a5; }
      .pc-ow__metric[data-tone='warn'] .pc-ow__metric-val { color: #fcd34d; }
      .pc-ow__metric-label { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; color: var(--fg-mute, #7f9bb4); white-space: nowrap; }
    `}</style>
  );
}
