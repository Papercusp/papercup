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
 *     incl. a START / PAUSE toggle (mirrors MugTab) → kettle:start/pause
 *   - the ANOMALY → ACTION list (each detected anomaly + the NUDGE / OBSERVE /
 *     ESCALATE it would take — the D-001 nudge-not-replace boundary, straight off
 *     `anomaly.suggestedAction`).
 *
 * Narrow-rail idiom (mirrors MugTab): vertical sections, `{ active }`-gated,
 * rendered only while the tab is open. Data: `overwatch.snapshot` (the brief,
 * SSE-live on the ~30s tick) + `overwatch.controlState`. Flag-gated by OVERWATCH
 * at the sidebar (LeftSidebar hides the tab when off); this also renders a clear
 * dark/empty state defensively.
 */
import { memo, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { Activity, AlertTriangle, CheckCircle2, Clock3, Eye, History, Pause, Play, ShieldCheck, XCircle } from 'lucide-react';
import { Tooltip } from '@/app/harness/Tooltip';
import { useLexicon } from '@/lib/useLexicon';
import ModelOverride from './ModelOverride';
import { useModelOverride } from './useModelOverride';
import type {
  Anomaly,
  AnomalyActionType,
  AnomalySeverity,
  OverwatchBrief,
  OverwatchControlState,
  OverwatchLiveness,
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

/** Compact forward duration: "in 3m 12s" / "in 4h". Negative ⇒ "overdue". */
function countdownLabel(ms: number | null): string {
  if (ms == null) return '—';
  if (ms <= 0) return 'now / overdue';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `in ${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 && min < 10 ? `in ${min}m ${sec}s` : `in ${min}m`;
  const hr = Math.floor(min / 60);
  return `in ${hr}h`;
}

/**
 * Fire an overwatch loop-control tool through the gated/audited run-tool bridge
 * (mirrors hive-control.ts `runHiveControl`, the Queen-tab path). The tool persists
 * `overwatch_started` and fires `notifySyncInvalidate('overwatch.controlState')`, so
 * this panel refreshes live after the toggle. Throws on failure so the caller can
 * surface it inline.
 */
async function runOverwatchControl(tool: 'kettle:start' | 'kettle:pause', harness: string | null): Promise<void> {
  const res = await fetch('/api/agent-mcp/run-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: tool, args: harness ? { harness } : {}, confirmed: true }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string;
    result?: { content?: Array<{ text?: string }> };
  };
  if (!res.ok || !body.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  const text = body.result?.content?.[0]?.text;
  const payload = text ? (JSON.parse(text) as { ok?: boolean; message?: string }) : { ok: true };
  if (payload.ok === false) throw new Error(payload.message ?? `${tool} refused`);
}

export default function OverwatchTab({ active }: { active: boolean }) {
  const t = useLexicon();
  const snap = useSyncQuery<OverwatchBrief>({ queryName: 'overwatch.snapshot', args: {}, staleTime: 15_000 });
  const ctrl = useSyncQuery<OverwatchControlState>({ queryName: 'overwatch.controlState', args: {}, staleTime: 15_000 });
  const live = useSyncQuery<OverwatchLiveness>({ queryName: 'overwatch.liveness', args: {}, staleTime: 15_000 });
  const [sevFilter, setSevFilter] = useQueryState(
    'owsev',
    parseAsStringEnum<SevFilter>([...SEV_FILTERS]).withDefault('all'),
  );
  const [busy, setBusy] = useState(false);
  const [ctrlErr, setCtrlErr] = useState<string | null>(null);

  // A 1s ticker so the "Last run" age + "Next run" countdown stay live BETWEEN
  // sync fetches (the server stamps ageMs/nextRunInMs at resolve time; we advance
  // them locally so the strip visibly counts — the whole point of an alive
  // indicator). Only runs while the tab is open.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  // Session-only MODEL override for the Overwatch supervisor (model-override-sidebar-2026-06-23).
  // Hook called unconditionally (before the early return) per the rules of hooks.
  const overwatchModel = useModelOverride('overwatch', active);

  const brief = active ? snap.data?.[0] : undefined;
  const control = active ? ctrl.data?.[0] : undefined;
  const liveness = active ? live.data?.[0] : undefined;

  // Render the control header whenever we have EITHER the control-state or a brief —
  // critically so a PAUSED overwatch (which has no live brief) still shows its Start
  // button. Only the genuinely-unavailable case (neither) shows the empty placeholder.
  if (!control && !brief) {
    return (
      <div className="pc-owsb pc-owsb--empty">
        <div className="pc-owsb__placeholder">
          {snap.error
            ? `Overwatch unavailable — ${String(snap.error)}`
            : snap.loading || ctrl.loading
              ? 'Loading the overwatch brief…'
              : 'Overwatch is dark. The full system health is on the Health tab.'}
        </div>
        {/* Model override is settable even while dark — it applies on the next start. */}
        {overwatchModel.error && <div className="pc-owsb__err">Model override - {overwatchModel.error}</div>}
        <ModelOverride
          label="Overwatch model"
          override={overwatchModel.override}
          onWrite={overwatchModel.setOverride}
          busy={overwatchModel.busy}
        />
      </div>
    );
  }

  const running = !!control?.started && !!control?.flagEnabled;
  const preArmed = !!control?.started && !control?.flagEnabled;
  const isStarted = !!control?.started;
  const tone = running ? 'good' : preArmed ? 'warn' : 'mute';
  const stateLabel = running ? 'Running' : preArmed ? 'Pre-armed' : 'Paused';
  const cadenceMin = control ? Math.round(control.cadenceSec / 60) : null;
  const slug = control?.potSlug ?? brief?.potSlug ?? null;
  const anomalyCount = brief?.anomalies.length ?? 0;
  const critCount = brief?.anomalies.filter((a) => a.severity === 'critical').length ?? 0;
  const lastWake = ageLabel(control?.staleForMs ?? null);
  const nextWake = control?.armed ? whenLabel(control.nextWakeAt) : 'not armed';

  const toggle = async () => {
    setBusy(true);
    setCtrlErr(null);
    try {
      await runOverwatchControl(isStarted ? 'kettle:pause' : 'kettle:start', slug);
    } catch (e) {
      setCtrlErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <TooltipPrimitive.Provider delayDuration={250}>
      <div className="pc-owsb">
        {/* Control / status header — status + START/PAUSE toggle (mirrors MugTab) */}
        <header className="pc-owsb__bar" data-tone={tone}>
          <div className="pc-owsb__identity">
            <span className={`pc-owsb__dot pc-owsb__dot--${tone}`} aria-hidden />
            <Eye size={14} aria-hidden />
            <span className="pc-owsb__state">
              <span className="pc-owsb__title">{stateLabel}</span>
              <span className="pc-owsb__subtitle">Supervisor loop</span>
            </span>
          </div>
          {slug && (
            <Tooltip label={`Supervised ${t('pot', { lower: true })}`}>
              <span className="pc-owsb__hive">{slug}</span>
            </Tooltip>
          )}
          <Tooltip label={isStarted ? 'Pause the overwatch supervisor (kettle:pause)' : 'Start the overwatch supervisor (kettle:start)'}>
            <button
              type="button"
              className="pc-owsb__toggle"
              data-on={isStarted}
              disabled={busy}
              onClick={() => void toggle()}
              aria-label={isStarted ? 'Pause overwatch' : 'Start overwatch'}
            >
              {busy ? (
                '...'
              ) : isStarted ? (
                <>
                  <Pause size={11} aria-hidden /> Pause
                </>
              ) : (
                <>
                  <Play size={11} aria-hidden /> Start
                </>
              )}
            </button>
          </Tooltip>
        </header>

        <div className="pc-owsb__metrics" aria-label="Overwatch telemetry">
          <Metric
            icon={<Activity size={11} aria-hidden />}
            label="Cadence"
            value={cadenceMin != null ? `${cadenceMin}m` : 'unknown'}
            tooltip="Floor cadence when the loop has no explicit next-wake. Actual wakes range 10-30min when the system reads healthy (kettle.md) — a slower average than this figure is expected, not a stall (WI-4401)."
          />
          <Metric icon={<Clock3 size={11} aria-hidden />} label="Next" value={nextWake} />
          <Metric icon={<Clock3 size={11} aria-hidden />} label="Last" value={lastWake} tooltip="Last overwatch wake" />
          <Metric
            icon={anomalyCount === 0 ? <ShieldCheck size={11} aria-hidden /> : <AlertTriangle size={11} aria-hidden />}
            label="Signals"
            value={brief ? (anomalyCount === 0 ? 'clear' : `${critCount}/${anomalyCount} critical`) : 'paused'}
            tone={brief ? (critCount > 0 ? 'bad' : anomalyCount > 0 ? 'warn' : 'good') : 'mute'}
          />
        </div>

        {ctrlErr && <div className="pc-owsb__err">Control failed - {ctrlErr}</div>}
        {preArmed && (
          <div className="pc-owsb__hint">
            Started, but the <strong>papercusp-overwatch</strong> flag is OFF - pre-armed, not looping. Flip it on at /admin/features.
          </div>
        )}

        {overwatchModel.error && <div className="pc-owsb__err">Model override - {overwatchModel.error}</div>}
        <ModelOverride
          label="Overwatch model"
          override={overwatchModel.override}
          onWrite={overwatchModel.setOverride}
          busy={overwatchModel.busy}
        />

        {brief ? (
          <OverwatchAnomalies brief={brief} sevFilter={sevFilter} setSevFilter={setSevFilter} />
        ) : (
          <section className="pc-owsb__section pc-owsb__section--empty">
            <div className="pc-owsb__empty-title">Supervisor paused</div>
            <div className="pc-owsb__placeholder">
              Start it above to resume system-health supervision. Full health remains on the <strong>Health</strong> tab.
            </div>
          </section>
        )}

        <div className="pc-owsb__footnote">
          Full system health lives on the <strong>Health</strong> tab. This panel is for supervisor actions.
        </div>
      </div>
    </TooltipPrimitive.Provider>
  );
}

function Metric({
  icon,
  label,
  value,
  tone = 'mute',
  tooltip,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'bad' | 'mute';
  tooltip?: string;
}) {
  const content = (
    <span className={`pc-owsb__metric pc-owsb__metric--${tone}`}>
      <span className="pc-owsb__metric-icon">{icon}</span>
      <span className="pc-owsb__metric-copy">
        <span className="pc-owsb__metric-label">{label}</span>
        <span className="pc-owsb__metric-value">{value}</span>
      </span>
    </span>
  );
  return tooltip ? <Tooltip label={tooltip}>{content}</Tooltip> : content;
}

function OverwatchAnomalies({
  brief,
  sevFilter,
  setSevFilter,
}: {
  brief: OverwatchBrief;
  sevFilter: SevFilter;
  setSevFilter: (value: SevFilter | null) => unknown;
}) {
  const anomalies = useMemo(
    () =>
      [...brief.anomalies]
        .map((a, idx) => ({ a, idx }))
        .sort((x, y) => SEV_RANK[x.a.severity] - SEV_RANK[y.a.severity] || x.idx - y.idx)
        .map(({ a }) => a)
        .filter((a) => sevFilter === 'all' || a.severity === sevFilter),
    [brief.anomalies, sevFilter],
  );
  const crit = brief.anomalies.filter((a) => a.severity === 'critical').length;
  const warn = brief.anomalies.filter((a) => a.severity === 'warning').length;

  return (
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
  );
}

const AnomalyRow = memo(function AnomalyRow({ anomaly }: { anomaly: Anomaly }) {
  const tone = SEV_TONE[anomaly.severity];
  const act = anomaly.suggestedAction;
  return (
    <li className={`pc-owsb__anom pc-owsb__anom--${tone}`}>
      <div className="pc-owsb__anom-head">
        <span className="pc-owsb__anom-main">
          <span className={`pc-owsb__sev pc-owsb__sev--${tone}`}>{anomaly.severity}</span>
          <span className="pc-owsb__kind" title={anomaly.subject}>{anomaly.kind}</span>
        </span>
        <span className="pc-owsb__subject">{anomaly.subject}</span>
      </div>
      <div className="pc-owsb__anom-detail">{anomaly.detail}</div>
      <div className="pc-owsb__action">
        <span className={`pc-owsb__verb pc-owsb__verb--${act.type}`}>
          {ACTION_VERB[act.type]}{act.target ? ` ${act.target}` : ''}
        </span>
        {act.message && <span className="pc-owsb__anom-msg">{act.message}</span>}
      </div>
    </li>
  );
});

