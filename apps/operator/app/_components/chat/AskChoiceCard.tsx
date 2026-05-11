'use client';

/**
 * AskChoiceCard — renders a chat:ask_choice tool call as a clickable
 * button list. Lifted visual from Restart's RecommenderChat suggestion
 * starters (icon + title + hint + chevron in a vertical stack), adapted
 * for three button styles (default, primary, danger) and an
 * answered/disabled state.
 *
 * Click flow:
 *   1. Parent's `onAnswer({option})` fires.
 *   2. Card immediately switches to its `answered` display (disabled
 *      buttons, chosen option highlighted, hint replaced with "Picked"
 *      tag and timestamp).
 *   3. Parent is responsible for the rest:
 *      - operator-converse: POST /api/operator/conversations/:id/turn-answer
 *      - oracle: local state mutation + send(option.label)
 *
 * Accessibility: role=group + aria-labelledby for the question; each
 * option is a real <button> with type=button and an aria-pressed state
 * once answered.
 */

import type { ReactNode } from 'react';
import { ChevronRight, Check, Sparkles } from 'lucide-react';

export interface AskChoiceOption {
  id: string;
  label: string;
  hint?: string;
  style?: 'default' | 'primary' | 'danger';
}

export interface AskChoiceArgs {
  question: string;
  options: AskChoiceOption[];
}

export interface AskChoiceAnswered {
  option_id: string;
  label: string;
  at: number;
}

interface AskChoiceCardProps {
  args: AskChoiceArgs;
  answered?: AskChoiceAnswered;
  /** Fires when a user clicks an option. Parent owns the I/O. */
  onAnswer?: (option: AskChoiceOption) => void;
  /**
   * If true (default), the card renders disabled when `answered` is
   * set. Pass `false` for historical replay where you want to show
   * the same answered card again with the option highlighted.
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

  return (
    <div
      role="group"
      aria-labelledby={questionId}
      className="flex flex-col gap-2 mt-2"
      data-tool="chat:ask_choice"
    >
      <div className="flex flex-col gap-1.5">
        <p id={questionId} className="text-[13.5px] leading-snug text-foreground">
          {args.question}
        </p>
        {isAnswered && (
          <p className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground/70">
            Picked{' '}
            <span className="text-foreground/80 normal-case tracking-normal">
              {answered.label}
            </span>
          </p>
        )}
      </div>
      <div className="flex flex-col gap-px rounded-xl border border-white/8 bg-white/[0.02] overflow-hidden">
        {args.options.map((opt) => {
          const isPicked = answered?.option_id === opt.id;
          const cls = styleClasses(opt.style, isPicked);
          return (
            <button
              key={opt.id}
              type="button"
              disabled={buttonsDisabled}
              aria-pressed={isPicked || undefined}
              onClick={() => {
                if (buttonsDisabled || !onAnswer) return;
                onAnswer(opt);
              }}
              className={`${cls} ${buttonsDisabled ? 'cursor-default' : ''}`}
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${iconBgClasses(opt.style)}`}
              >
                {isPicked ? <Check className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-medium text-foreground">
                  {opt.label}
                </span>
                {opt.hint && (
                  <span className="truncate text-[11.5px] text-muted-foreground">{opt.hint}</span>
                )}
              </span>
              {!buttonsDisabled && (
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
    </div>
  );
}
