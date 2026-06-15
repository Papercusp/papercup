/**
 * HealthTab — the read-only system Health dashboard
 * (system-health-tab-2026-06-15 P-004 / P-005, D-002/D-003).
 *
 * A live at-a-glance view of the whole running system: each panel is a
 * green/yellow/red status card (a light + a one-line summary + 3-5 counters +
 * a drill-down link to the existing detail surface). The goal is "is the system
 * healthy, and if not, which panel is red?" in two seconds — NOT a metrics dump.
 *
 * READ-ONLY (D-002): it shows, it never acts. Course-corrections are the
 * overwatch's job; structural controls (start/stop, restart, deploy) live in
 * their own surfaces, reached via the per-card drill-down links.
 *
 * Reads the `health.snapshot` sync resolver (SSE-live, the ~30s system-health
 * tick + on-demand recompute behind it). Renders a graceful empty state until a
 * recognizable snapshot arrives (loading / flag off / error), like the
 * LearningInfraHealthChip — a health surface must never add noise of its own.
 */
import { useQueryState, parseAsString } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { ArrowUpRight, HeartPulse } from 'lucide-react';
import {
  PANEL_ORDER,
  type SystemHealth,
  type HealthPanel,
  type HealthMetric,
  type PanelStatus,
} from '@papercusp/operator-core/lib/system-health/types';

const TONE: Record<PanelStatus, string> = { ok: 'good', warn: 'warn', crit: 'bad', unknown: 'mute' };

const OVERALL_LABEL: Record<PanelStatus, string> = {
  ok: 'All systems healthy',
  warn: 'Needs a look',
  crit: 'Action needed',
  unknown: 'Status unknown',
};

function checkedAgo(evaluatedAt: number, nowMs: number): string {
  const sec = Math.max(0, (nowMs - evaluatedAt) / 1000);
  if (sec < 60) return `${Math.round(sec)}s ago`;
  const min = sec / 60;
  if (min < 90) return `${Math.round(min)}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

export default function HealthTab() {
  const sync = useSyncQuery<SystemHealth>({ queryName: 'health.snapshot', args: {}, staleTime: 15_000 });
  const [, setTab] = useQueryState('tab', parseAsString);
  const health = sync.data?.[0];

  // In-app tab switch for /adv?tab=… drill-downs; let other routes navigate normally.
  const onLink = (href: string) => (e: React.MouseEvent) => {
    const m = href.match(/^\/adv\?tab=([\w-]+)/);
    if (m) {
      e.preventDefault();
      void setTab(m[1]);
    }
  };

  if (!health) {
    return (
      <div className="pc-health pc-health--empty">
        <div className="pc-health__placeholder">
          {sync.error ? `Health unavailable — ${String(sync.error)}` : sync.loading ? 'Loading system health…' : 'System health is disabled.'}
        </div>
        <HealthStyles />
      </div>
    );
  }

  const panels = PANEL_ORDER.map((k) => health.panels[k]).filter(Boolean) as HealthPanel[];
  const crit = panels.filter((p) => p.status === 'crit').length;
  const warn = panels.filter((p) => p.status === 'warn').length;
  const overallTone = TONE[health.overall];

  return (
    <div className="pc-health">
      <header className="pc-health__bar" data-tone={overallTone}>
        <span className={`pc-health__dot pc-health__dot--${overallTone}`} aria-hidden />
        <HeartPulse size={15} aria-hidden />
        <span className="pc-health__overall">{OVERALL_LABEL[health.overall]}</span>
        <div className="pc-health__counts">
          {crit > 0 && <span className="pc-health__count pc-health__count--bad">{crit} red</span>}
          {warn > 0 && <span className="pc-health__count pc-health__count--warn">{warn} yellow</span>}
          {crit === 0 && warn === 0 && <span className="pc-health__count pc-health__count--good">all green</span>}
        </div>
        <span className="pc-health__spacer" />
        <span className="pc-health__checked">checked {checkedAgo(health.evaluatedAt, Date.now())}</span>
      </header>

      <div className="pc-health__grid">
        {panels.map((p) => (
          <HealthCard key={p.key} panel={p} onLink={onLink} />
        ))}
      </div>

      <HealthStyles />
    </div>
  );
}

function HealthCard({ panel, onLink }: { panel: HealthPanel; onLink: (href: string) => (e: React.MouseEvent) => void }) {
  const tone = TONE[panel.status];
  return (
    <section className={`pc-hcard pc-hcard--${tone}`}>
      <div className="pc-hcard__head">
        <span className={`pc-hcard__dot pc-hcard__dot--${tone}`} aria-hidden title={panel.status} />
        <span className="pc-hcard__title">{panel.label}</span>
        {panel.link && (
          <a
            className="pc-hcard__link"
            href={panel.link.href}
            onClick={onLink(panel.link.href)}
            title={`Open ${panel.link.label}`}
          >
            {panel.link.label}
            <ArrowUpRight size={11} aria-hidden />
          </a>
        )}
      </div>
      <div className="pc-hcard__summary" title={panel.error ?? panel.summary}>
        {panel.summary}
      </div>
      <div className="pc-hcard__metrics">
        {panel.metrics.map((mt: HealthMetric, i: number) => (
          <div key={i} className="pc-hcard__metric" data-tone={mt.tone ? TONE[mt.tone] : undefined}>
            <span className="pc-hcard__metric-val">{mt.value}</span>
            <span className="pc-hcard__metric-label">{mt.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function HealthStyles() {
  return (
    <style>{`
      .pc-health {
        display: flex; flex-direction: column; gap: 12px;
        min-height: 0; flex: 1; padding: 14px 16px 18px;
      }
      .pc-health--empty { align-items: center; justify-content: center; }
      .pc-health__placeholder { color: var(--fg-mute, #7f9bb4); font-size: 13px; padding: 40px; }

      /* Overall status bar */
      .pc-health__bar {
        display: flex; align-items: center; gap: 9px;
        padding: 10px 14px; border-radius: 12px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      .pc-health__bar[data-tone='bad'] { border-color: rgba(244, 63, 94, 0.45); background: rgba(244, 63, 94, 0.08); }
      .pc-health__bar[data-tone='warn'] { border-color: rgba(251, 191, 36, 0.4); background: rgba(251, 191, 36, 0.06); }
      .pc-health__bar svg { color: var(--fg-dim, #b9d4e8); }
      .pc-health__overall { font-size: 13px; font-weight: 760; letter-spacing: 0.02em; color: var(--fg, #e7f7ff); }
      .pc-health__counts { display: flex; gap: 6px; }
      .pc-health__count {
        font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
        padding: 2px 8px; border-radius: 999px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); color: var(--fg-mute, #7f9bb4);
      }
      .pc-health__count--bad { color: #fca5a5; border-color: rgba(244, 63, 94, 0.5); background: rgba(244, 63, 94, 0.12); }
      .pc-health__count--warn { color: #fcd34d; border-color: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.12); }
      .pc-health__count--good { color: #6ee7b7; border-color: rgba(52, 211, 153, 0.45); background: rgba(52, 211, 153, 0.1); }
      .pc-health__spacer { flex: 1; }
      .pc-health__checked { font-size: 10.5px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
      .pc-health__dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }

      /* Card grid */
      .pc-health__grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
        gap: 11px; align-content: start;
      }
      .pc-hcard {
        display: flex; flex-direction: column; gap: 8px;
        padding: 11px 13px 12px; border-radius: 12px;
        border: 1px solid var(--card-accent, rgba(125, 211, 252, 0.16));
        background:
          radial-gradient(circle at top left, color-mix(in oklab, var(--card-accent, #38bdf8), transparent 92%), transparent 46%),
          var(--bg-2, rgba(255, 255, 255, 0.035));
      }
      .pc-hcard--good { --card-accent: rgba(52, 211, 153, 0.5); }
      .pc-hcard--warn { --card-accent: rgba(251, 191, 36, 0.55); }
      .pc-hcard--bad { --card-accent: rgba(244, 63, 94, 0.6); }
      .pc-hcard--mute { --card-accent: rgba(125, 211, 252, 0.14); opacity: 0.78; }
      .pc-hcard__head { display: flex; align-items: center; gap: 7px; }
      .pc-hcard__title {
        font-size: 11.5px; font-weight: 760; letter-spacing: 0.04em; text-transform: uppercase;
        color: var(--fg, #e7f7ff); flex: 1; min-width: 0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .pc-hcard__dot--good { background: #34d399; box-shadow: 0 0 6px rgba(52, 211, 153, 0.7); }
      .pc-hcard__dot--warn { background: #fbbf24; box-shadow: 0 0 6px rgba(251, 191, 36, 0.6); }
      .pc-hcard__dot--bad { background: #f43f5e; box-shadow: 0 0 7px rgba(244, 63, 94, 0.7); }
      .pc-hcard__dot--mute { background: #475569; }
      .pc-hcard__link {
        display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0;
        font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
        color: var(--fg-mute, #7f9bb4); text-decoration: none;
      }
      .pc-hcard__link:hover { color: var(--fg, #e7f7ff); }
      .pc-hcard__summary {
        font-size: 11.5px; line-height: 1.35; color: var(--fg-dim, #b9d4e8);
        min-height: 30px;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      }
      .pc-hcard__metrics {
        display: flex; flex-wrap: wrap; gap: 4px 6px;
        border-top: 1px solid var(--border, rgba(125, 211, 252, 0.1)); padding-top: 8px;
      }
      .pc-hcard__metric {
        display: flex; flex-direction: column; gap: 1px; min-width: 0;
        padding: 2px 7px; border-radius: 7px; background: rgba(255, 255, 255, 0.03);
      }
      .pc-hcard__metric[data-tone='bad'] { background: rgba(244, 63, 94, 0.14); }
      .pc-hcard__metric[data-tone='warn'] { background: rgba(251, 191, 36, 0.13); }
      .pc-hcard__metric[data-tone='mute'] { opacity: 0.7; }
      .pc-hcard__metric-val {
        font-size: 12px; font-weight: 750; color: var(--fg, #e7f7ff);
        font-variant-numeric: tabular-nums; white-space: nowrap;
      }
      .pc-hcard__metric[data-tone='bad'] .pc-hcard__metric-val { color: #fca5a5; }
      .pc-hcard__metric[data-tone='warn'] .pc-hcard__metric-val { color: #fcd34d; }
      .pc-hcard__metric-label {
        font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
        color: var(--fg-mute, #7f9bb4); white-space: nowrap;
      }
    `}</style>
  );
}
