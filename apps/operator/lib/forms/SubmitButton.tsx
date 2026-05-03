'use client';

/**
 * SubmitButton — disabled-while-submitting button. Pairs with
 * `useFormWith().isSubmitting` so callers don't have to thread a manual
 * `busy` flag.
 */
import type { ReactNode } from 'react';

export function SubmitButton({
  pending,
  children,
  pendingLabel,
  variant = 'primary',
  ...rest
}: {
  pending: boolean;
  children: ReactNode;
  pendingLabel?: string;
  variant?: 'primary' | 'ghost';
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'disabled' | 'children'>) {
  const isPrimary = variant === 'primary';
  return (
    <button
      type="submit"
      disabled={pending || rest['aria-disabled'] === 'true'}
      className="pc-button"
      style={{
        background: isPrimary ? '#2563eb' : 'transparent',
        color: isPrimary ? '#fff' : 'var(--text-1)',
        border: isPrimary ? 'none' : '1px solid var(--border)',
        borderRadius: 4,
        padding: '0.45rem 0.9rem',
        fontSize: 13,
        fontWeight: 600,
        cursor: pending ? 'not-allowed' : 'pointer',
        opacity: pending ? 0.7 : 1,
        ...rest.style,
      }}
      {...rest}
    >
      {pending ? (pendingLabel ?? 'Saving…') : children}
    </button>
  );
}
