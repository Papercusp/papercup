import type { ComponentPropsWithoutRef } from 'react';

type IconProps = ComponentPropsWithoutRef<'svg'>;

export function DeckCardsMark({ className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      focusable="false"
      {...props}
    >
      <rect
        x="9.2"
        y="3.9"
        width="9.3"
        height="12.4"
        rx="2.1"
        transform="rotate(8 9.2 3.9)"
        stroke="currentColor"
        strokeOpacity="0.38"
        strokeWidth="1.7"
      />
      <rect
        x="6.5"
        y="5.4"
        width="10.1"
        height="13.1"
        rx="2.2"
        stroke="currentColor"
        strokeOpacity="0.64"
        strokeWidth="1.7"
      />
      <rect
        x="3.9"
        y="7.4"
        width="10.8"
        height="13.3"
        rx="2.35"
        stroke="currentColor"
        strokeWidth="1.9"
      />
      <path
        d="M6.5 11.2h5.6"
        stroke="currentColor"
        strokeOpacity="0.9"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M6.5 14.3h3.6"
        stroke="currentColor"
        strokeOpacity="0.76"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export function OpsTargetMark({ className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      focusable="false"
      {...props}
    >
      <circle cx="12" cy="12" r="5.2" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="1.65" fill="currentColor" stroke="none" />
      <path d="M12 2.6v3.2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M12 18.2v3.2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M2.6 12h3.2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M18.2 12h3.2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}
