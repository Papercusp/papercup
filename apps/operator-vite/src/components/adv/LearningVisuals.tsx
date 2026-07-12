import type { CSSProperties, ReactNode } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown, type LucideIcon } from "lucide-react";

export type LearningTone = "good" | "warn" | "bad" | "neutral" | "accent";

export function LearningPageHeader({
  icon: Icon,
  title,
  signal,
  tone = "neutral",
  action,
}: {
  icon: LucideIcon;
  title: string;
  signal?: string;
  tone?: LearningTone;
  action?: ReactNode;
}) {
  return (
    <div className="pc-learning-visual__head">
      <h2>
        <Icon size={15} aria-hidden />
        {title}
      </h2>
      {signal ? (
        <span className={`pc-learning-visual__signal is-${tone}`}>
          {signal}
        </span>
      ) : null}
      <span className="pc-learning-visual__headspace" />
      {action}
    </div>
  );
}

export function LearningHeroMetric({
  eyebrow,
  value,
  status,
  tone = "accent",
  children,
}: {
  eyebrow: string;
  value: string;
  status?: string;
  tone?: LearningTone;
  children?: ReactNode;
}) {
  return (
    <section className={`pc-learning-visual__hero is-${tone}`}>
      <span className="pc-learning-visual__eyebrow">{eyebrow}</span>
      <strong>{value}</strong>
      {status ? (
        <span className="pc-learning-visual__verdict">{status}</span>
      ) : null}
      {children ? (
        <div className="pc-learning-visual__herofoot">{children}</div>
      ) : null}
    </section>
  );
}

export interface LearningComparisonRow {
  label: string;
  baseline: number | null;
  treatment: number | null;
  baselineLabel?: string;
  treatmentLabel?: string;
  max?: number;
  treatmentWins?: boolean;
}

const barWidth = (value: number | null, max: number): string =>
  value == null ? "0%" : `${Math.max(2, Math.min(100, (value / max) * 100))}%`;

export function LearningComparisonBars({
  title,
  rows,
  baselineName = "Baseline",
  treatmentName = "Treatment",
}: {
  title: string;
  rows: LearningComparisonRow[];
  baselineName?: string;
  treatmentName?: string;
}) {
  return (
    <section className="pc-learning-visual__comparison">
      <header>
        <h3>{title}</h3>
        <span className="pc-learning-visual__legend is-baseline">
          {baselineName}
        </span>
        <span className="pc-learning-visual__legend is-treatment">
          {treatmentName}
        </span>
      </header>
      <div className="pc-learning-visual__barrows">
        {rows.map((row) => {
          const max =
            row.max ?? Math.max(row.baseline ?? 0, row.treatment ?? 0, 1);
          return (
            <div className="pc-learning-visual__barrow" key={row.label}>
              <span className="pc-learning-visual__barlabel">{row.label}</span>
              <div className="pc-learning-visual__barpair">
                <span className="pc-learning-visual__bartrack">
                  <span
                    className="pc-learning-visual__bar is-baseline"
                    style={
                      {
                        "--pc-learning-bar-width": barWidth(row.baseline, max),
                      } as CSSProperties
                    }
                  />
                  <em>{row.baselineLabel ?? row.baseline ?? "—"}</em>
                </span>
                <span className="pc-learning-visual__bartrack">
                  <span
                    className={`pc-learning-visual__bar is-treatment${row.treatmentWins ? " is-winner" : ""}`}
                    style={
                      {
                        "--pc-learning-bar-width": barWidth(row.treatment, max),
                      } as CSSProperties
                    }
                  />
                  <em>{row.treatmentLabel ?? row.treatment ?? "—"}</em>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function LearningEvidenceRail({
  title = "Evidence",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <aside className="pc-learning-visual__evidence" aria-label={title}>
      <h3>{title}</h3>
      {children}
    </aside>
  );
}

export function LearningVisualEmpty({
  icon: Icon,
  title,
}: {
  icon: LucideIcon;
  title: string;
}) {
  return (
    <div className="pc-learning-visual__empty" role="status">
      <Icon size={18} aria-hidden />
      <strong>{title}</strong>
      <span className="pc-learning-visual__ghost" aria-hidden>
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

export function LearningDisclosure({
  label,
  count,
  children,
  defaultOpen = false,
}: {
  label: string;
  count?: number;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <Collapsible.Root
      className="pc-learning-visual__disclosure"
      defaultOpen={defaultOpen}
    >
      <Collapsible.Trigger className="pc-learning-visual__disclosure-trigger">
        <ChevronDown size={13} aria-hidden />
        <span>{label}</span>
        {count != null ? <em>{count}</em> : null}
      </Collapsible.Trigger>
      <Collapsible.Content className="pc-learning-visual__disclosure-content">
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

export function LearningVisualStyles() {
  return (
    <style>{`
      .pc-learning-visual__head { min-height: 30px; display: flex; align-items: center; gap: 8px; margin: 0 0 6px; }
      .pc-learning-visual__head h2 { display: inline-flex; align-items: center; gap: 7px; margin: 0; color: var(--fg); font-size: 13px; font-weight: 680; letter-spacing: 0; }
      .pc-learning-visual__headspace { flex: 1 1 auto; }
      .pc-learning-visual__signal { border: 1px solid color-mix(in srgb, var(--fg-mute) 28%, transparent); border-radius: 999px; padding: 2px 7px; color: var(--fg-mute); font-size: 9.5px; font-weight: 750; text-transform: uppercase; letter-spacing: 0; }
      .pc-learning-visual__signal.is-good { color: #34d399; border-color: color-mix(in srgb, #34d399 42%, transparent); background: color-mix(in srgb, #34d399 9%, transparent); }
      .pc-learning-visual__signal.is-warn { color: #fbbf24; border-color: color-mix(in srgb, #fbbf24 42%, transparent); background: color-mix(in srgb, #fbbf24 9%, transparent); }
      .pc-learning-visual__signal.is-bad { color: #fb7185; border-color: color-mix(in srgb, #fb7185 42%, transparent); background: color-mix(in srgb, #fb7185 9%, transparent); }
      .pc-learning-visual__signal.is-accent { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 42%, transparent); background: color-mix(in srgb, var(--accent) 9%, transparent); }
      .pc-learning-visual__layout { display: grid; grid-template-columns: minmax(150px, .68fr) minmax(320px, 2fr) minmax(178px, .82fr); gap: 8px; align-items: stretch; margin-bottom: 8px; }
      .pc-learning-visual__hero, .pc-learning-visual__comparison, .pc-learning-visual__evidence { border: 1px solid color-mix(in srgb, var(--border) 84%, transparent); border-radius: 11px; background: color-mix(in srgb, var(--bg-2) 92%, transparent); }
      .pc-learning-visual__hero { min-height: 120px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; padding: 13px; overflow: hidden; position: relative; }
      .pc-learning-visual__hero::after { content: ''; position: absolute; inset: auto -20% -55% 15%; height: 75%; border-radius: 50%; background: currentColor; opacity: .055; filter: blur(18px); pointer-events: none; }
      .pc-learning-visual__hero.is-good { color: #34d399; }
      .pc-learning-visual__hero.is-warn { color: #fbbf24; }
      .pc-learning-visual__hero.is-bad { color: #fb7185; }
      .pc-learning-visual__hero.is-accent { color: var(--accent); }
      .pc-learning-visual__hero.is-neutral { color: var(--fg); }
      .pc-learning-visual__hero strong { margin-top: 5px; color: currentColor; font-size: clamp(27px, 2.4vw, 38px); line-height: .95; font-variant-numeric: tabular-nums; letter-spacing: 0; }
      .pc-learning-visual__eyebrow { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); font-size: 12px; font-weight: 690; }
      .pc-learning-visual__verdict { margin-top: 7px; border: 1px solid currentColor; border-radius: 5px; padding: 2px 7px; background: color-mix(in srgb, currentColor 10%, transparent); color: currentColor; font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0; }
      .pc-learning-visual__herofoot { width: 100%; margin-top: 7px; color: var(--fg-mute); font-size: 10px; font-variant-numeric: tabular-nums; }
      .pc-learning-visual__comparison { padding: 10px 12px 8px; }
      .pc-learning-visual__comparison > header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
      .pc-learning-visual__comparison h3, .pc-learning-visual__evidence h3 { flex: 1 1 auto; margin: 0; color: var(--fg); font-size: 12px; font-weight: 680; }
      .pc-learning-visual__legend { display: inline-flex; align-items: center; gap: 5px; color: var(--fg-mute); font-size: 9.5px; }
      .pc-learning-visual__legend::before { content: ''; width: 7px; height: 7px; border-radius: 2px; background: #64748b; }
      .pc-learning-visual__legend.is-treatment::before { background: #34d399; }
      .pc-learning-visual__barrows { display: flex; flex-direction: column; }
      .pc-learning-visual__barrow { display: grid; grid-template-columns: minmax(76px, .62fr) minmax(180px, 2fr); gap: 10px; align-items: center; padding: 3px 0; border-top: 1px solid color-mix(in srgb, var(--border) 48%, transparent); }
      .pc-learning-visual__barlabel { color: var(--fg); font-size: 11px; font-weight: 610; }
      .pc-learning-visual__barpair { display: grid; gap: 2px; }
      .pc-learning-visual__bartrack { display: grid; grid-template-columns: minmax(0, 1fr) 42px; gap: 7px; align-items: center; min-height: 8px; line-height: 1; }
      .pc-learning-visual__bartrack::before { content: ''; grid-column: 1; grid-row: 1; height: 7px; border-radius: 2px; background: color-mix(in srgb, var(--fg) 5%, transparent); }
      .pc-learning-visual__bar { grid-column: 1; grid-row: 1; display: block; width: var(--pc-learning-bar-width); height: 7px; border-radius: 2px; background: #64748b; transition: width 180ms ease; }
      .pc-learning-visual__bar.is-treatment { background: color-mix(in srgb, var(--accent) 72%, #34d399); }
      .pc-learning-visual__bar.is-treatment.is-winner { background: #34d399; }
      .pc-learning-visual__bartrack em { grid-column: 2; color: var(--fg-mute); font-size: 10px; font-style: normal; font-variant-numeric: tabular-nums; line-height: 1; text-align: right; }
      .pc-learning-visual__evidence { padding: 10px; }
      .pc-learning-visual__evidence > h3 { padding-bottom: 6px; border-bottom: 1px solid color-mix(in srgb, var(--border) 56%, transparent); }
      .pc-learning-visual__evidence-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; margin-top: 6px; }
      .pc-learning-visual__evidence-metric { min-width: 0; border: 1px solid color-mix(in srgb, var(--border) 70%, transparent); border-radius: 7px; padding: 6px; }
      .pc-learning-visual__evidence-metric span { display: block; overflow: hidden; color: var(--fg-mute); font-size: 9px; line-height: 1.1; text-overflow: ellipsis; white-space: nowrap; }
      .pc-learning-visual__evidence-metric strong { display: block; margin-top: 2px; color: var(--fg); font-size: 14px; font-variant-numeric: tabular-nums; line-height: 1; }
      .pc-learning-visual__empty { min-height: 116px; display: grid; place-content: center; justify-items: center; gap: 6px; color: var(--fg-mute); }
      .pc-learning-visual__empty strong { color: var(--fg); font-size: 12px; }
      .pc-learning-visual__ghost { width: min(220px, 38vw); display: grid; gap: 5px; margin-top: 4px; opacity: .3; }
      .pc-learning-visual__ghost i { display: block; height: 6px; border-radius: 3px; background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 40%, transparent) 65%, color-mix(in srgb, var(--fg) 8%, transparent) 65%); }
      .pc-learning-visual__ghost i:nth-child(2) { width: 82%; }
      .pc-learning-visual__ghost i:nth-child(3) { width: 56%; }
      .pc-learning-visual__disclosure { border-top: 1px solid color-mix(in srgb, var(--border) 68%, transparent); }
      .pc-learning-visual__disclosure-trigger { width: 100%; min-height: 30px; display: flex; align-items: center; gap: 6px; padding: 5px 3px; border: 0; background: transparent; color: var(--fg-mute); cursor: pointer; font: inherit; font-size: 10.5px; font-weight: 650; text-align: left; }
      .pc-learning-visual__disclosure-trigger:hover { color: var(--fg); }
      .pc-learning-visual__disclosure-trigger svg { transition: transform var(--dur-fast); }
      .pc-learning-visual__disclosure-trigger[data-state='open'] svg { transform: rotate(180deg); }
      .pc-learning-visual__disclosure-trigger em { margin-left: auto; min-width: 20px; border-radius: 999px; padding: 1px 6px; background: color-mix(in srgb, var(--fg) 7%, transparent); color: var(--fg-mute); font-size: 9.5px; font-style: normal; font-variant-numeric: tabular-nums; text-align: center; }
      .pc-learning-visual__disclosure-content { padding-top: 2px; }
      @media (max-width: 1060px) { .pc-learning-visual__layout { grid-template-columns: minmax(160px, .7fr) minmax(320px, 2fr); } .pc-learning-visual__evidence { grid-column: 1 / -1; } }
      @media (max-width: 720px) { .pc-learning-visual__layout { grid-template-columns: 1fr; } .pc-learning-visual__evidence { grid-column: auto; } .pc-learning-visual__barrow { grid-template-columns: 1fr; gap: 6px; } }
    `}</style>
  );
}
