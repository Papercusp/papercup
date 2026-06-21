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
import { Tooltip } from '@/app/harness/Tooltip';
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
          <Tooltip label={`Open ${panel.link.label}`}>
            <a
              className="pc-hcard__link"
              href={panel.link.href}
              onClick={onLink(panel.link.href)}
              aria-label={`Open ${panel.link.label}`}
            >
              <ArrowUpRight size={12} aria-hidden />
            </a>
          </Tooltip>
        )}
      </div>
      <div className="pc-hcard__summary" title={panel.error ?? panel.summary}>
        {panel.summary}
      </div>
      {panel.metrics.length > 0 && (
        <div className="pc-hcard__metrics">
          {panel.metrics.map((mt: HealthMetric, i: number) => (
            <span key={i} className="pc-hcard__m" data-tone={mt.tone ? TONE[mt.tone] : undefined}>
              <b>{mt.value}</b>
              <span>{mt.label}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function HealthStyles() {
  return (
    <style>{`
      .pc-health {
        display: flex; flex-direction: column; gap: 9px;
        min-height: 0; flex: 1; padding: 11px 13px 15px;
      }
      .pc-health--empty { align-items: center; justify-content: center; }
      .pc-health__placeholder { color: var(--fg-mute, #7f9bb4); font-size: 13px; padding: 40px; }

      /* Overall status bar */
      .pc-health__bar {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 11px; border-radius: 9px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      .pc-health__bar[data-tone='bad'] { border-color: rgba(244, 63, 94, 0.45); background: rgba(244, 63, 94, 0.08); }
      .pc-health__bar[data-tone='warn'] { border-color: rgba(251, 191, 36, 0.4); background: rgba(251, 191, 36, 0.06); }
      .pc-health__bar svg { color: var(--fg-dim, #b9d4e8); }
      .pc-health__overall { font-size: 12px; font-weight: 760; letter-spacing: 0; color: var(--fg, #e7f7ff); }
      .pc-health__counts { display: flex; gap: 5px; }
      .pc-health__count {
        font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0;
        padding: 1px 7px; border-radius: 999px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); color: var(--fg-mute, #7f9bb4);
      }
      .pc-health__count--bad { color: #fca5a5; border-color: rgba(244, 63, 94, 0.5); background: rgba(244, 63, 94, 0.12); }
      .pc-health__count--warn { color: #fcd34d; border-color: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.12); }
      .pc-health__count--good { color: #6ee7b7; border-color: rgba(52, 211, 153, 0.45); background: rgba(52, 211, 153, 0.1); }
      .pc-health__spacer { flex: 1; }
      .pc-health__checked { font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
      .pc-health__dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

      /* Dense card grid — flat cards with a left status-stripe (compact pass) */
      .pc-health__grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(208px, 1fr));
        gap: 7px; align-content: start;
      }
      .pc-hcard {
        display: flex; flex-direction: column; gap: 4px;
        padding: 7px 10px 8px; border-radius: 8px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.13));
        border-left: 3px solid var(--card-accent, #475569);
        background: var(--bg-2, rgba(255, 255, 255, 0.035));
      }
      .pc-hcard--good { --card-accent: #34d399; }
      .pc-hcard--warn { --card-accent: #fbbf24; }
      .pc-hcard--bad { --card-accent: #f43f5e; }
      .pc-hcard--mute { --card-accent: #475569; opacity: 0.72; }
      .pc-hcard__head { display: flex; align-items: center; gap: 6px; }
      .pc-hcard__title {
        font-size: 10.5px; font-weight: 750; letter-spacing: 0; text-transform: uppercase;
        color: var(--fg, #e7f7ff); flex: 1; min-width: 0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .pc-hcard__dot--good { background: #34d399; box-shadow: 0 0 5px rgba(52, 211, 153, 0.7); }
      .pc-hcard__dot--warn { background: #fbbf24; box-shadow: 0 0 5px rgba(251, 191, 36, 0.6); }
      .pc-hcard__dot--bad { background: #f43f5e; box-shadow: 0 0 6px rgba(244, 63, 94, 0.7); }
      .pc-hcard__dot--mute { background: #475569; }
      .pc-hcard__link {
        display: inline-flex; align-items: center; flex-shrink: 0;
        color: var(--fg-mute, #7f9bb4); text-decoration: none; opacity: 0.7;
      }
      .pc-hcard__link:hover { color: var(--fg, #e7f7ff); opacity: 1; }
      .pc-hcard__summary {
        font-size: 10.5px; line-height: 1.3; color: var(--fg-dim, #b9d4e8);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .pc-hcard__metrics { display: flex; flex-wrap: wrap; gap: 1px 9px; }
      .pc-hcard__m {
        display: inline-flex; align-items: baseline; gap: 3px;
        font-size: 9.5px; color: var(--fg-mute, #7f9bb4); white-space: nowrap;
      }
      .pc-hcard__m b {
        font-size: 11px; font-weight: 740; color: var(--fg, #e7f7ff);
        font-variant-numeric: tabular-nums;
      }
      .pc-hcard__m span { text-transform: uppercase; letter-spacing: 0; font-weight: 600; }
      .pc-hcard__m[data-tone='bad'] b { color: #fca5a5; }
      .pc-hcard__m[data-tone='warn'] b { color: #fcd34d; }
      .pc-hcard__m[data-tone='mute'] { opacity: 0.6; }
    `}</style>
  );
}
