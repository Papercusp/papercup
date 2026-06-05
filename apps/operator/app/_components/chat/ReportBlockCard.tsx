'use client';

/**
 * ReportBlockCard — renders a `ReportBlock` (the card system's shared
 * structured two-tier plan→item status shape, `@papercusp/chat-protocol`)
 * in the operator card visual language.
 *
 * This is THE desktop renderer for structured report content (one schema,
 * one renderer — report-cards-inbox-reconciliation-2026-06-05 D-001):
 *   - inbox attention items carrying a report (`operator-report` kind)
 *     render it in the detail pane;
 *   - any `CardSpec.report` body renders it inside `AskChoiceCard`.
 *
 * Two-tier shape (matches the TUI's plan→item list): an optional overall
 * title, then a list of plan blocks, each with a status glyph + title (+
 * subtle slug) + optional summary, and a nested list of item rows (status
 * glyph + subtle id + text).
 *
 * Pure presentational. The payload is a validated `ReportBlock`
 * (parseReportBlock) — already trimmed + shape-checked, so this component
 * renders defensively but doesn't re-validate.
 *
 * (Formerly OperatorReportCard, which rendered `<report>` inline in the
 * operator chat — that channel was removed per the owner's correction:
 * operator structured output routes to the Inbox, chat is conversation only.)
 */

import { type ReactNode } from 'react';
import type { ReportBlock, ReportPlan, ReportItem } from '@papercusp/chat-protocol';

/**
 * Map a free-string status to a single-width glyph + a semantic tone
 * (drives the CSS color via data-tone). Unknown statuses degrade to a
 * neutral dot rather than dropping the row. Lowercased + trimmed
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
    <li className="report-block-item" data-tone={tone}>
      <span
        className="report-block-glyph"
        data-tone={tone}
        aria-hidden="true"
        title={label || undefined}
      >
        {glyph}
      </span>
      {item.id && <span className="report-block-item-id">{item.id}</span>}
      <span className="report-block-item-text">{item.text}</span>
    </li>
  );
}

function ReportPlanBlock({ plan }: { plan: ReportPlan }): ReactNode {
  const { glyph, tone, label } = statusGlyph(plan.status);
  return (
    <div className="report-block-plan" data-tone={tone}>
      <div className="report-block-plan-head">
        <span
          className="report-block-glyph"
          data-tone={tone}
          aria-hidden="true"
          title={label || undefined}
        >
          {glyph}
        </span>
        <span className="report-block-plan-title">{plan.title}</span>
        {plan.status && <span className="report-block-plan-status" data-tone={tone}>{plan.status}</span>}
      </div>
      {plan.summary && <p className="report-block-plan-summary">{plan.summary}</p>}
      {plan.items && plan.items.length > 0 && (
        <ul className="report-block-items">
          {plan.items.map((it, i) => (
            <ReportItemRow key={it.id ?? `${plan.title}-${i}`} item={it} />
          ))}
        </ul>
      )}
    </div>
  );
}

interface ReportBlockCardProps {
  report: ReportBlock;
}

export function ReportBlockCard({ report }: ReportBlockCardProps): ReactNode {
  if (!report.plans || report.plans.length === 0) return null;
  return (
    <div className="report-block-card" data-component="report-block" role="group" aria-label={report.title ?? 'Report'}>
      {report.title && <div className="report-block-title">{report.title}</div>}
      <div className="report-block-plans">
        {report.plans.map((plan, i) => (
          <ReportPlanBlock key={plan.slug ?? `${plan.title}-${i}`} plan={plan} />
        ))}
      </div>
    </div>
  );
}
