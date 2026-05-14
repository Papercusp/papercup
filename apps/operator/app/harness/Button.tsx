'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

/**
 * Button — canonical button wrapper with variant support.
 *
 * The default look matches the native <button> baseline in globals.css
 * (var(--bg-2) bg, var(--border) border, font-size 12, 4px 10px padding).
 *
 * Variants layer on:
 *   - primary     — filled accent, for the page's primary CTA
 *   - destructive — red tint, for destructive confirmations / "Delete"
 *   - ghost       — transparent until hovered, for low-emphasis actions
 *
 * Use `<Button variant="primary">Save</Button>` for emphasis-needing
 * buttons. For neutral inline actions, a bare `<button>` is enough —
 * the global baseline already handles styling.
 *
 * See /docs/design for the form-control decision matrix.
 */
export type ButtonVariant = 'primary' | 'destructive' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'pc-btn-primary',
  destructive: 'pc-btn-destructive',
  ghost: 'pc-btn-ghost',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, className, type = 'button', children, ...rest },
  ref,
) {
  const cls = variant
    ? className
      ? `${VARIANT_CLASS[variant]} ${className}`
      : VARIANT_CLASS[variant]
    : className;
  return (
    <button ref={ref} type={type} className={cls} {...rest}>
      {children}
    </button>
  );
});
