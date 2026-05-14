'use client';

import { forwardRef, type CSSProperties, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

/**
 * TextInput / TextArea — canonical text-entry primitives that match the
 * Select trigger styling (see app/harness/Select.tsx TRIGGER_DEFAULT_STYLE).
 *
 * For most cases the global `:where(input, textarea)` baseline in
 * globals.css already gives unwrapped inputs the right look. Use the
 * wrappers when you want:
 *
 *   - typesafe leading/trailing slots without rebuilding flexbox each site
 *   - the canonical class hook (`pc-text-input`) for future restyling
 *   - to opt out of bespoke inline styles a parent might be applying
 *
 * Existing native inputs scattered across the app keep working — the
 * global rule has 0 specificity (`:where`), so any inline style wins.
 *
 * See /docs/design for the form-control decision matrix.
 */

const BASE_STYLE: CSSProperties = {
  background: 'var(--bg-2)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  fontFamily: 'inherit',
  fontSize: 12,
  padding: '4px 8px',
  outline: 'none',
};

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  /** Optional leading element rendered inside the bordered container. */
  leading?: React.ReactNode;
  /** Optional trailing element (icon, unit, etc.). */
  trailing?: React.ReactNode;
};

/**
 * Text input. Pass `type` for variants (`number`, `email`, etc.) — defaults
 * to text. For leading/trailing slot use, the input lives inside a wrapper
 * div that owns the border and the slot layout.
 */
export const TextInput = forwardRef<HTMLInputElement, InputProps>(function TextInput(
  { leading, trailing, style, className, ...rest },
  ref,
) {
  if (!leading && !trailing) {
    return (
      <input
        ref={ref}
        className={className ? `pc-text-input ${className}` : 'pc-text-input'}
        style={{ ...BASE_STYLE, ...style }}
        {...rest}
      />
    );
  }
  return (
    <div
      className={className ? `pc-text-input-wrap ${className}` : 'pc-text-input-wrap'}
      style={{
        ...BASE_STYLE,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        ...style,
      }}
    >
      {leading}
      <input
        ref={ref}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          font: 'inherit',
          padding: '4px 0',
          outline: 'none',
        }}
        {...rest}
      />
      {trailing}
    </div>
  );
});

type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { style, className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={className ? `pc-text-input ${className}` : 'pc-text-input'}
      style={{
        ...BASE_STYLE,
        padding: '6px 8px',
        minHeight: 60,
        resize: 'vertical',
        fontFamily: 'inherit',
        lineHeight: 1.45,
        ...style,
      }}
      {...rest}
    />
  );
});
