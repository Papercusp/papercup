'use client';

/**
 * AskChoiceCard — renders a chat:ask_choice tool call as a clickable
 * button list (single-select) or a checkbox-style picker with a
 * Submit button (multi-select). Lifted visual from Restart's
 * RecommenderChat suggestion starters (icon + title + hint + chevron),
 * adapted for three button styles (default, primary, danger) and
 * an answered/disabled state.
 *
 * Click flow (single-select, args.multi=false or undefined):
 *   1. User clicks an option → `onAnswer({picks: [{option_id, label}]})`.
 *   2. Card switches to answered display (disabled, picked highlighted).
 *
 * Click flow (multi-select, args.multi=true):
 *   1. User toggles options (local state).
 *   2. Submit button enables when ≥1 picked.
 *   3. Submit → `onAnswer({picks: [{option_id, label}, ...]})`.
 *
 * Parent owns the I/O after onAnswer (POST to turn-answer endpoint
 * for operator; local state + send for oracle).
 *
 * Accessibility: role=group + aria-labelledby for the question; each
 * option is a real <button> with type=button. Single-select: aria-pressed
 * on the chosen option. Multi-select: aria-checked on each toggle.
 */

import { useState, type ReactNode } from 'react';
import { ChevronRight, Check, Sparkles, Square } from 'lucide-react';

export interface AskChoiceOption {
  id: string;
  label: string;
  hint?: string;
  style?: 'default' | 'primary' | 'danger';
}

export interface AskChoiceArgs {
  question: string;
  options: AskChoiceOption[];
  /** Multi-select mode. When true, renders checkboxes + Submit button. */
  multi?: boolean;
}

/**
 * Unified answered shape — picks[] has length 1 for single-select
 * cards and ≥1 for multi-select.
 */
export interface AskChoiceAnswered {
  picks: Array<{ option_id: string; label: string }>;
  at: number;
}

interface AskChoiceCardProps {
  args: AskChoiceArgs;
  answered?: AskChoiceAnswered;
  /**
   * Fires when the user commits a selection. For single-select cards,
   * one click = one commit (picks.length===1). For multi-select cards,
   * the Submit button commits all currently-toggled options.
   */
  onAnswer?: (commit: { picks: Array<{ option_id: string; label: string }> }) => void;
  /**
   * If true (default), the card renders disabled when `answered` is
   * set. Pass `false` for historical replay where you want to show
   * the same answered card again with the options highlighted.
   */
  disableWhenAnswered?: boolean;
}

function styleClasses(style: AskChoiceOption['style'], isPicked: boolean): string {
  const base = 'group flex items-center gap-3 bg-transparent px-3.5 py-3 text-left transition-colors';
  const tone =
    style === 'primary'
      ? 'hover:bg-primary/8'
      : style === 'danger'
      ? 'hover:bg-destructive/10'
      : 'hover:bg-white/[0.04]';
  const picked = isPicked
    ? style === 'danger'
      ? 'bg-destructive/14'
      : style === 'primary'
      ? 'bg-primary/14'
      : 'bg-white/[0.06]'
    : '';
  return `${base} ${tone} ${picked}`;
}

function iconBgClasses(style: AskChoiceOption['style']): string {
  if (style === 'danger') {
    return 'bg-destructive/12 text-destructive ring-1 ring-destructive/20 group-hover:bg-destructive/20';
  }
  return 'bg-primary/10 text-primary ring-1 ring-primary/15 group-hover:bg-primary/18';
}

export function AskChoiceCard({
  args,
  answered,
  onAnswer,
  disableWhenAnswered = true,
}: AskChoiceCardProps): ReactNode {
  const questionId = `ask-${args.question.slice(0, 16).replace(/\s+/g, '-')}`;
  const isAnswered = !!answered;
  const buttonsDisabled = isAnswered && disableWhenAnswered;
  const multi = args.multi === true;

  // Multi-select tracks local toggle state until Submit is clicked.
  // Single-select commits immediately on click and has no Submit.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const pickedIds = new Set(answered?.picks.map((p) => p.option_id) ?? []);

  const renderPickedSummary = (): ReactNode => {
    if (!isAnswered) return null;
    const labels = answered.picks.map((p) => p.label).join(' · ');
    return (
      <p className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground/70">
        Picked{' '}
        <span className="text-foreground/80 normal-case tracking-normal">{labels}</span>
      </p>
    );
  };

  const commit = (picks: Array<{ option_id: string; label: string }>) => {
    if (buttonsDisabled || !onAnswer || picks.length === 0) return;
    onAnswer({ picks });
  };

  return (
    <div
      role="group"
      aria-labelledby={questionId}
      className="flex flex-col gap-2 mt-2"
      data-tool="chat:ask_choice"
      data-multi={multi ? 'true' : 'false'}
    >
      <div className="flex flex-col gap-1.5">
        <p id={questionId} className="text-[13.5px] leading-snug text-foreground">
          {args.question}
        </p>
        {renderPickedSummary()}
      </div>
      <div className="flex flex-col gap-px rounded-xl border border-white/8 bg-white/[0.02] overflow-hidden">
        {args.options.map((opt) => {
          const isPicked = pickedIds.has(opt.id);
          const isToggled = multi && !isAnswered && selected.has(opt.id);
          const showHighlight = isPicked || isToggled;
          const cls = styleClasses(opt.style, showHighlight);
          const ariaProps: Record<string, string | boolean | undefined> = multi
            ? { 'aria-checked': isToggled || isPicked || false, role: 'checkbox' }
            : { 'aria-pressed': isPicked || undefined };

          return (
            <button
              key={opt.id}
              type="button"
              disabled={buttonsDisabled}
              aria-label={opt.label}
              {...ariaProps}
              onClick={() => {
                if (buttonsDisabled || !onAnswer) return;
                if (multi) {
                  // Toggle local state; Submit commits.
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(opt.id)) next.delete(opt.id);
                    else next.add(opt.id);
                    return next;
                  });
                } else {
                  // Single-select: commit immediately.
                  commit([{ option_id: opt.id, label: opt.label }]);
                }
              }}
              className={`${cls} ${buttonsDisabled ? 'cursor-default' : ''}`}
            >
              <span
                aria-hidden="true"
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${iconBgClasses(opt.style)}`}
              >
                {showHighlight ? (
                  <Check className="h-4 w-4" />
                ) : multi ? (
                  <Square className="h-4 w-4" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-medium text-foreground">
                  {opt.label}
                </span>
                {opt.hint && (
                  <span aria-hidden="true" className="truncate text-[11.5px] text-muted-foreground">{opt.hint}</span>
                )}
              </span>
              {!buttonsDisabled && !multi && (
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-all group-hover:translate-x-0.5 group-hover:text-foreground"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>
      {multi && !isAnswered && (
        <div className="flex items-center justify-end gap-2">
          <span className="text-[11px] text-muted-foreground/60">
            {selected.size === 0
              ? 'Pick one or more, then Submit'
              : `${selected.size} selected`}
          </span>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => {
              const picks = args.options
                .filter((o) => selected.has(o.id))
                .map((o) => ({ option_id: o.id, label: o.label }));
              commit(picks);
            }}
            className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Submit
          </button>
        </div>
      )}
    </div>
  );
}
