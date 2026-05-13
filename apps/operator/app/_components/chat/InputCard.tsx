'use client';

/**
 * InputCard — renders cards whose presentation is a single input field
 * (`text`, `date`, `slider`). Choice-style cards (`radio`, `checkbox`)
 * keep going through AskChoiceCard.
 *
 * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §6
 *
 * Response shape is unified with AskChoiceCard:
 *   { action: 'submit',  value: ... }   ← payload depends on presentation
 *   { action: 'decline', reason? }
 *
 * The submitted value is shape-specific:
 *   text   → string
 *   date   → string (ISO yyyy-mm-dd)
 *   slider → number
 *
 * PendingCardsBar wraps the value into the runtime dataSchema-expected
 * shape before POSTing /card-response.
 */

import { useState, type ReactNode } from 'react';

export type InputCardPresentation =
  | { kind: 'text'; placeholder?: string; multiline?: boolean }
  | { kind: 'date'; min?: string; max?: string }
  | { kind: 'slider'; min: number; max: number; step?: number };

export type InputCardResponse =
  | { action: 'submit'; value: string | number }
  | { action: 'decline'; reason?: string };

interface Props {
  prompt: string;
  presentation: InputCardPresentation;
  fallbackText?: string;
  allowDecline?: boolean;
  onResponse: (r: InputCardResponse) => void;
}

export function InputCard({
  prompt,
  presentation,
  fallbackText,
  allowDecline = true,
  onResponse,
}: Props): ReactNode {
  const questionId = `input-${prompt.slice(0, 16).replace(/\s+/g, '-')}`;

  if (presentation.kind === 'text') {
    return (
      <TextInputCard
        prompt={prompt}
        questionId={questionId}
        placeholder={presentation.placeholder}
        multiline={presentation.multiline ?? false}
        fallbackText={fallbackText}
        allowDecline={allowDecline}
        onResponse={onResponse}
      />
    );
  }
  if (presentation.kind === 'date') {
    return (
      <DateInputCard
        prompt={prompt}
        questionId={questionId}
        min={presentation.min}
        max={presentation.max}
        allowDecline={allowDecline}
        onResponse={onResponse}
      />
    );
  }
  // slider
  return (
    <SliderInputCard
      prompt={prompt}
      questionId={questionId}
      min={presentation.min}
      max={presentation.max}
      step={presentation.step ?? 1}
      allowDecline={allowDecline}
      onResponse={onResponse}
    />
  );
}

// ── text ──────────────────────────────────────────────────────────────

function TextInputCard({
  prompt,
  questionId,
  placeholder,
  multiline,
  fallbackText,
  allowDecline,
  onResponse,
}: {
  prompt: string;
  questionId: string;
  placeholder?: string;
  multiline: boolean;
  fallbackText?: string;
  allowDecline: boolean;
  onResponse: (r: InputCardResponse) => void;
}): ReactNode {
  const [value, setValue] = useState('');
  const submit = () => {
    if (value.length === 0) return;
    onResponse({ action: 'submit', value });
  };
  return (
    <div
      role="group"
      aria-labelledby={questionId}
      className="input-card"
      data-kind="text"
    >
      <p id={questionId} className="input-card-question">
        {prompt}
      </p>
      {multiline ? (
        <textarea
          className="input-card-textarea"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder ?? fallbackText ?? ''}
          rows={3}
          aria-label="response"
        />
      ) : (
        <input
          type="text"
          className="input-card-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder ?? fallbackText ?? ''}
          aria-label="response"
        />
      )}
      <div className="input-card-actions">
        {allowDecline && (
          <button
            type="button"
            onClick={() => onResponse({ action: 'decline' })}
            className="input-card-skip"
            aria-label="Skip"
          >
            Skip
          </button>
        )}
        <button
          type="button"
          disabled={value.length === 0}
          onClick={submit}
          className="input-card-submit"
        >
          Submit
        </button>
      </div>
    </div>
  );
}

// ── date ──────────────────────────────────────────────────────────────

function DateInputCard({
  prompt,
  questionId,
  min,
  max,
  allowDecline,
  onResponse,
}: {
  prompt: string;
  questionId: string;
  min?: string;
  max?: string;
  allowDecline: boolean;
  onResponse: (r: InputCardResponse) => void;
}): ReactNode {
  const [value, setValue] = useState('');
  return (
    <div
      role="group"
      aria-labelledby={questionId}
      className="input-card"
      data-kind="date"
    >
      <p id={questionId} className="input-card-question">
        {prompt}
      </p>
      <input
        type="date"
        className="input-card-date"
        value={value}
        min={min}
        max={max}
        onChange={(e) => setValue(e.target.value)}
        aria-label="date"
      />
      <div className="input-card-actions">
        {allowDecline && (
          <button
            type="button"
            onClick={() => onResponse({ action: 'decline' })}
            className="input-card-skip"
            aria-label="Skip"
          >
            Skip
          </button>
        )}
        <button
          type="button"
          disabled={value.length === 0}
          onClick={() => value.length > 0 && onResponse({ action: 'submit', value })}
          className="input-card-submit"
        >
          Submit
        </button>
      </div>
    </div>
  );
}

// ── slider ────────────────────────────────────────────────────────────

function SliderInputCard({
  prompt,
  questionId,
  min,
  max,
  step,
  allowDecline,
  onResponse,
}: {
  prompt: string;
  questionId: string;
  min: number;
  max: number;
  step: number;
  allowDecline: boolean;
  onResponse: (r: InputCardResponse) => void;
}): ReactNode {
  const initial = Math.round((min + max) / 2 / step) * step;
  const [value, setValue] = useState<number>(initial);
  return (
    <div
      role="group"
      aria-labelledby={questionId}
      className="input-card"
      data-kind="slider"
    >
      <p id={questionId} className="input-card-question">
        {prompt}
      </p>
      <div className="input-card-slider-row">
        <input
          type="range"
          className="input-card-slider"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          aria-label="value"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
        />
        <output className="input-card-slider-value" aria-live="polite">{value}</output>
      </div>
      <div className="input-card-actions">
        {allowDecline && (
          <button
            type="button"
            onClick={() => onResponse({ action: 'decline' })}
            className="input-card-skip"
            aria-label="Skip"
          >
            Skip
          </button>
        )}
        <button
          type="button"
          onClick={() => onResponse({ action: 'submit', value })}
          className="input-card-submit"
        >
          Submit
        </button>
      </div>
    </div>
  );
}
