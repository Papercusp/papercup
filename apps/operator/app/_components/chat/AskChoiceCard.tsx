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

/**
 * Card response surface — the new ctx.askUser shape (#2 + L4):
 *   submit  — user committed picks
 *   decline — user explicitly skipped (Skip button)
 *   cancel  — orchestrated by parent (run abort) — not a user button
 */
export type AskChoiceResponse =
  | { action: 'submit'; picks: Array<{ option_id: string; label: string }> }
  | { action: 'decline'; reason?: string }
  | { action: 'cancel' };

interface AskChoiceCardProps {
  args: AskChoiceArgs;
  answered?: AskChoiceAnswered;
  /**
   * Fires when the user commits a response (submit/decline). For
   * single-select cards, one click = one submit (picks.length===1).
   * For multi-select cards, the Submit button commits all currently
   * toggled options. The Skip affordance fires {action:'decline'}.
   */
  onResponse?: (response: AskChoiceResponse) => void;
  /**
   * Legacy alias for onResponse. Receives `{picks}` for submit only;
   * decline/cancel are not surfaced to legacy callers. Use onResponse
   * for new code. (Kept while the chat surface migration in commit 10
   * has not yet landed — removed after that.)
   */
  onAnswer?: (commit: { picks: Array<{ option_id: string; label: string }> }) => void;
  /**
   * Whether the Skip affordance is shown. Default true. Maps to the
   * CardSpec.allowDecline field; the chat surface passes it through
   * from state-snapshot.openCards.
   */
  allowDecline?: boolean;
  /**
   * If true (default), the card renders disabled when `answered` is
   * set. Pass `false` for historical replay where you want to show
   * the same answered card again with the options highlighted.
   */
  disableWhenAnswered?: boolean;
}


export function AskChoiceCard({
  args,
  answered,
  onResponse,
  onAnswer,
  allowDecline = true,
  disableWhenAnswered = true,
}: AskChoiceCardProps): ReactNode {
  const questionId = `ask-${args.question.slice(0, 16).replace(/\s+/g, '-')}`;
  const isAnswered = !!answered;
  const buttonsDisabled = isAnswered && disableWhenAnswered;
  const multi = args.multi === true;

  /**
   * Bridge: callers may pass onResponse (new), onAnswer (legacy), or
   * both during the migration. The bridge fans out so a single user
   * action notifies both — keeps OperatorChat (still on onAnswer) and
   * future state-snapshot consumers (onResponse) both wired.
   */
  const fire = (response: AskChoiceResponse): void => {
    if (buttonsDisabled) return;
    if (onResponse) onResponse(response);
    if (onAnswer && response.action === 'submit') onAnswer({ picks: response.picks });
  };

  // Multi-select tracks local toggle state until Submit is clicked.
  // Single-select commits immediately on click and has no Submit.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const pickedIds = new Set(answered?.picks.map((p) => p.option_id) ?? []);

  const renderPickedSummary = (): ReactNode => {
    if (!isAnswered) return null;
    const labels = answered.picks.map((p) => p.label).join(' · ');
    return (
      <p className="ask-choice-picked">
        Picked <span>{labels}</span>
      </p>
    );
  };

  const commit = (picks: Array<{ option_id: string; label: string }>) => {
    if (buttonsDisabled || picks.length === 0) return;
    fire({ action: 'submit', picks });
  };

  return (
    <div
      role="group"
      aria-labelledby={questionId}
      className="ask-choice-card"
      data-tool="chat:ask_choice"
      data-multi={multi ? 'true' : 'false'}
      data-answered={isAnswered ? 'true' : 'false'}
    >
      <div className="ask-choice-head">
        <p id={questionId} className="ask-choice-question">
          {args.question}
        </p>
        {renderPickedSummary()}
      </div>
      <div className="ask-choice-options">
        {args.options.map((opt) => {
          const isPicked = pickedIds.has(opt.id);
          const isToggled = multi && !isAnswered && selected.has(opt.id);
          const showHighlight = isPicked || isToggled;
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
                if (buttonsDisabled) return;
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
              className="ask-choice-option"
              data-style={opt.style ?? 'default'}
              data-picked={showHighlight ? 'true' : 'false'}
              data-disabled={buttonsDisabled ? 'true' : 'false'}
            >
              <span
                aria-hidden="true"
                className="ask-choice-option-icon"
                data-style={opt.style ?? 'default'}
              >
                {showHighlight ? (
                  <Check className="ask-choice-icon" />
                ) : multi ? (
                  <Square className="ask-choice-icon" />
                ) : (
                  <Sparkles className="ask-choice-icon" />
                )}
              </span>
              <span className="ask-choice-option-text">
                <span className="ask-choice-option-label">
                  {opt.label}
                </span>
                {opt.hint && (
                  <span aria-hidden="true" className="ask-choice-option-hint">{opt.hint}</span>
                )}
              </span>
              {!buttonsDisabled && !multi && (
                <ChevronRight
                  className="ask-choice-option-chevron"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>
      {multi && !isAnswered && (
        <div className="ask-choice-submit-row">
          <span className="ask-choice-submit-hint">
            {selected.size === 0
              ? 'Pick one or more, then Submit'
              : `${selected.size} selected`}
          </span>
          <div className="ask-choice-actions">
            {allowDecline && (
              <button
                type="button"
                onClick={() => fire({ action: 'decline' })}
                className="ask-choice-skip"
                aria-label="Skip"
              >
                Skip
              </button>
            )}
            <button
              type="button"
              disabled={selected.size === 0}
              onClick={() => {
                const picks = args.options
                  .filter((o) => selected.has(o.id))
                  .map((o) => ({ option_id: o.id, label: o.label }));
                commit(picks);
              }}
              className="ask-choice-submit"
            >
              Submit
            </button>
          </div>
        </div>
      )}
      {!multi && !isAnswered && allowDecline && (
        <div className="ask-choice-skip-row">
          <button
            type="button"
            onClick={() => fire({ action: 'decline' })}
            className="ask-choice-skip-link"
            aria-label="Skip this question"
          >
            Skip
          </button>
        </div>
      )}
    </div>
  );
}
