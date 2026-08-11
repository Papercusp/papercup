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

import { type ReactNode, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReportBlock, ReportPlan, ReportItem } from '@papercusp/chat-protocol';
import { HydratedWorkRefPill } from './HydratedWorkRefPill';
import { remarkWorkRefs } from './remark-work-refs';
import type { WorkRefKind } from './parse-work-refs';

/** Keep report item newlines consistent with the chat markdown renderer. */
function withHardBreaks(text: string): string {
  return text.replace(/\n/g, '  \n');
}

/** Stable plugin identity avoids reparsing unchanged report rows on parent renders. */
const REPORT_REMARK_PLUGINS = [remarkGfm, remarkWorkRefs];

/** The custom `workrefpill` node emitted by `remarkWorkRefs`. */
interface WorkRefPillHastNode {
  properties?: { refId?: unknown; refKind?: unknown };
}

const REPORT_MARKDOWN_COMPONENTS = {
  // Item rows are inline list content, so avoid ReactMarkdown's default block
  // paragraph margins while retaining the existing row text class.
  p: ({ children }: { children?: ReactNode }) => (
    <span className="report-block-item-text">{children}</span>
  ),
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

type ReportWorkRef = { id: string; kind: WorkRefKind; planSlug?: string | null };

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

function ReportItemRow({
  item,
  onDrillIn,
  canDrillIn,
  harnessSlug,
  planSlug,
  onWorkRefActivate,
}: {
  item: ReportItem;
  onDrillIn?: (ref: string) => void;
  canDrillIn?: (ref: string) => boolean;
  harnessSlug?: string;
  planSlug?: string | null;
  onWorkRefActivate?: (ref: ReportWorkRef) => void;
}): ReactNode {
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
      <ReportItemMarkdown
        text={item.text}
        harnessSlug={harnessSlug}
        planSlug={planSlug}
        onWorkRefActivate={onWorkRefActivate}
      />
      {/* deterministic-status-cards-2026-07-17 P-003/D-004: the actionable
          drill-in — a real button that opens the referenced thing, replacing
          the curator's old dead `drill in: `<ref>`` monospace. Only when a
          handler is wired (the chat); the inbox/report uses pass no ref.

          ⚠ A ref STRING existing does not mean anything can be OPENED from it
          [owner 2026-07-28: "if there is nothing to open there should be no
          open button"]. A curator ref resolves against the LIVE attention items,
          and an escalation whose message has aged out of that snapshot resolves
          to nothing — so the old `item.ref && onDrillIn` condition rendered a
          button that navigated to the HUD board the chat is already on, i.e. a
          visible no-op. Measured live on the owner's own fleet-status cards:
          4 of the first 7 buttons were dead. `canDrillIn` lets the CALLER (which
          owns the resolver + the live items) decide; callers that pass no
          predicate keep the previous always-render behaviour. */}
      {item.ref && onDrillIn && (canDrillIn?.(item.ref) ?? true) && (
        <button
          type="button"
          className="report-block-item-drill"
          onClick={() => onDrillIn(item.ref!)}
          data-ref={item.ref}
          aria-label={`Open ${item.ref}`}
        >
          Open ↗
        </button>
      )}
    </li>
  );
}

function ReportItemMarkdown({
  text,
  harnessSlug,
  planSlug,
  onWorkRefActivate,
}: {
  text: string;
  harnessSlug?: string;
  planSlug?: string | null;
  onWorkRefActivate?: (ref: ReportWorkRef) => void;
}): ReactNode {
  const components = useMemo(
    () => ({
      ...REPORT_MARKDOWN_COMPONENTS,
      workrefpill: ({ node }: { node?: WorkRefPillHastNode }) => {
        const id = typeof node?.properties?.refId === 'string' ? node.properties.refId : '';
        const kind: WorkRefKind = node?.properties?.refKind === 'plan-item' ? 'plan-item' : 'work-item';
        if (!id) return null;
        return (
          <HydratedWorkRefPill
            id={id}
            kind={kind}
            harnessSlug={harnessSlug ?? ''}
            planSlug={planSlug}
            size="xs"
            onActivate={onWorkRefActivate ? () => onWorkRefActivate({ id, kind, planSlug }) : undefined}
          />
        );
      },
    }),
    [harnessSlug, planSlug, onWorkRefActivate],
  );

  return (
    <ReactMarkdown remarkPlugins={REPORT_REMARK_PLUGINS} components={components}>
      {withHardBreaks(text)}
    </ReactMarkdown>
  );
}

function ReportPlanBlock({
  plan,
  onDrillIn,
  canDrillIn,
  harnessSlug,
  planSlug,
  onWorkRefActivate,
}: {
  plan: ReportPlan;
  onDrillIn?: (ref: string) => void;
  canDrillIn?: (ref: string) => boolean;
  harnessSlug?: string;
  planSlug?: string | null;
  onWorkRefActivate?: (ref: ReportWorkRef) => void;
}): ReactNode {
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
            <ReportItemRow
              key={it.id ?? `${plan.title}-${i}`}
              item={it}
              onDrillIn={onDrillIn}
              canDrillIn={canDrillIn}
              harnessSlug={harnessSlug}
              planSlug={planSlug}
              onWorkRefActivate={onWorkRefActivate}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface ReportBlockCardProps {
  report: ReportBlock;
  /**
   * Optional drill-in handler (deterministic-status-cards-2026-07-17 P-003).
   * When provided, an item's `ref` renders as an actionable button that calls
   * this with the ref (the chat wires it to open the inbox / work-item / plan).
   * Omitted (inbox detail pane, AskChoiceCard bodies) ⇒ refs are inert, matching
   * today's behavior.
   */
  onDrillIn?: (ref: string) => void;
  /**
   * Optional openability predicate. Returns false for a ref that resolves to
   * NOTHING openable, so the row renders no "Open ↗" button at all rather than
   * one that silently does nothing. Omitted ⇒ every ref renders a button (the
   * previous behaviour), so non-chat callers are unaffected.
   */
  canDrillIn?: (ref: string) => boolean;
  /** Optional chat context for live work/plan-ref hydration in item markdown. */
  harnessSlug?: string;
  planSlug?: string | null;
  onWorkRefActivate?: (ref: ReportWorkRef) => void;
}

export function ReportBlockCard({
  report,
  onDrillIn,
  canDrillIn,
  harnessSlug,
  planSlug,
  onWorkRefActivate,
}: ReportBlockCardProps): ReactNode {
  if (!report.plans || report.plans.length === 0) return null;
  return (
    <div className="report-block-card" data-component="report-block" role="group" aria-label={report.title ?? 'Report'}>
      {report.title && <div className="report-block-title">{report.title}</div>}
      <div className="report-block-plans">
        {report.plans.map((plan, i) => (
          <ReportPlanBlock
            key={plan.slug ?? `${plan.title}-${i}`}
            plan={plan}
            onDrillIn={onDrillIn}
            canDrillIn={canDrillIn}
            harnessSlug={harnessSlug}
            planSlug={planSlug}
            onWorkRefActivate={onWorkRefActivate}
          />
        ))}
      </div>
    </div>
  );
}
