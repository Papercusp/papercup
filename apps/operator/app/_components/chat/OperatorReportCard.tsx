'use client';

/**
 * OperatorReportCard — renders a `<report>` payload (the structured
 * per-plan/per-item status the operator emits alongside `<say>`) as a card
 * in the operator card visual language, below the say bubble.
 *
 * Two-tier shape (matches the TUI's plan→item list): an optional overall
 * title, then a list of plan blocks, each with a status glyph + title (+
 * subtle slug) + optional summary, and a nested list of item rows (status
 * glyph + subtle id + text).
 *
 * Pure presentational. The payload is the validated `ParsedReport` from
 * operator-converse-tags (parseReportBody) — already trimmed + shape-checked,
 * so this component renders defensively but doesn't re-validate.
 *
 * Plan: structured-report-protocol-2026-06-05 (D-005).
 */

import { type ReactNode } from 'react';
import type {
  ParsedReport,
  ReportPlan,
  ReportItem,
} from '@papercusp/operator-core/lib/operator-converse-tags';

/**
 * Map a free-string status to a single-width glyph + a semantic tone
 * (drives the CSS color via data-tone). Unknown statuses degrade to a
 * neutral dot rather than dropping the row (D-002). Lowercased + trimmed
 * before lookup so "Done"/"WIP" match.
 */
type Tone = 'good' | 'accent' | 'bad' | 'muted';

function statusGlyph(status: string | undefined): { glyph: string; tone: Tone; label: string } {
  const s = (status ?? '').trim().toLowerCase();
  switch (s) {
    case 'done':
    case 'passed':
    case 'shipped':
    case 'resolved':
      return { glyph: '●', tone: 'good', label: s };
    case 'wip':
    case 'active':
    case 'in_progress':
    case 'in-progress':
    case 'doing':
      return { glyph: '◐', tone: 'accent', label: s };
    case 'blocked':
    case 'failing':
    case 'failed':
    case 'error':
      return { glyph: '■', tone: 'bad', label: s };
    case 'needs-human':
    case 'needs_human':
    case 'review':
      return { glyph: '◆', tone: 'accent', label: s };
    case 'dropped':
    case 'deprecated':
    case 'closed':
      return { glyph: '×', tone: 'muted', label: s };
    case '':
      return { glyph: '·', tone: 'muted', label: '' };
    default:
      // todo / draft / ready / planned / unknown → open circle.
      return { glyph: '○', tone: 'muted', label: s };
  }
}

function ReportItemRow({ item }: { item: ReportItem }): ReactNode {
  const { glyph, tone, label } = statusGlyph(item.status);
  return (
    <li className="operator-report-item" data-tone={tone}>
      <span
        className="operator-report-glyph"
        data-tone={tone}
        aria-hidden="true"
        title={label || undefined}
      >
        {glyph}
      </span>
      {item.id && <span className="operator-report-item-id">{item.id}</span>}
      <span className="operator-report-item-text">{item.text}</span>
    </li>
  );
}

function ReportPlanBlock({ plan }: { plan: ReportPlan }): ReactNode {
  const { glyph, tone, label } = statusGlyph(plan.status);
  return (
    <div className="operator-report-plan" data-tone={tone}>
      <div className="operator-report-plan-head">
        <span
          className="operator-report-glyph"
          data-tone={tone}
          aria-hidden="true"
          title={label || undefined}
        >
          {glyph}
        </span>
        <span className="operator-report-plan-title">{plan.title}</span>
        {plan.status && <span className="operator-report-plan-status" data-tone={tone}>{plan.status}</span>}
      </div>
      {plan.summary && <p className="operator-report-plan-summary">{plan.summary}</p>}
      {plan.items && plan.items.length > 0 && (
        <ul className="operator-report-items">
          {plan.items.map((it, i) => (
            <ReportItemRow key={it.id ?? `${plan.title}-${i}`} item={it} />
          ))}
        </ul>
      )}
    </div>
  );
}

interface OperatorReportCardProps {
  report: ParsedReport;
}

export function OperatorReportCard({ report }: OperatorReportCardProps): ReactNode {
  if (!report.plans || report.plans.length === 0) return null;
  return (
    <div className="operator-report-card" data-component="operator-report" role="group" aria-label={report.title ?? 'Report'}>
      {report.title && <div className="operator-report-title">{report.title}</div>}
      <div className="operator-report-plans">
        {report.plans.map((plan, i) => (
          <ReportPlanBlock key={plan.slug ?? `${plan.title}-${i}`} plan={plan} />
        ))}
      </div>
    </div>
  );
}
