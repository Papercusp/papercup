import {
  forwardRef,
  useId,
  type ComponentPropsWithoutRef,
} from 'react';

type Props = ComponentPropsWithoutRef<'svg'> & {
  decorative?: boolean;
  variant?: 'full' | 'compact';
};

export const OperatorLogoMark = forwardRef<SVGSVGElement, Props>(function OperatorLogoMark(
  { className, decorative = true, variant = 'full', ...props },
  ref,
) {
  const base = useId().replace(/:/g, '');
  const ids = {
    bg: `${base}-bg`,
    ring: `${base}-ring`,
    cup: `${base}-cup`,
    coffee: `${base}-coffee`,
    glow: `${base}-glow`,
  };

  const compact = variant === 'compact';
  return (
    <svg
      ref={ref}
      viewBox="0 0 128 128"
      className={className}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
      {...props}
    >
      <defs>
        <radialGradient id={ids.bg} cx="50%" cy="38%" r="68%">
          <stop offset="0%" stopColor="#17324a" />
          <stop offset="58%" stopColor="#0b1624" />
          <stop offset="100%" stopColor="#07101d" />
        </radialGradient>
        <linearGradient id={ids.ring} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#b9efff" />
          <stop offset="52%" stopColor="#57d8ff" />
          <stop offset="100%" stopColor="#178db8" />
        </linearGradient>
        <linearGradient id={ids.cup} x1="50%" y1="0%" x2="50%" y2="100%">
          <stop offset="0%" stopColor="#f3eef9" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#d7d2e2" stopOpacity="0.78" />
        </linearGradient>
        <linearGradient id={ids.coffee} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#c8a57b" />
          <stop offset="100%" stopColor="#8b5e3d" />
        </linearGradient>
        <filter id={ids.glow} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {compact ? (
        <>
          <circle cx="64" cy="64" r="56" fill={`url(#${ids.bg})`} stroke="rgba(185,239,255,0.24)" strokeWidth="2" />
          <path d="M64 17c0 7-8.5 11-16 17" fill="none" stroke="#d9a977" strokeWidth="3.2" strokeLinecap="round" />
          <path d="M64 17c0 7 8.5 11 16 17" fill="none" stroke="#d9a977" strokeWidth="3.2" strokeLinecap="round" />
          <g transform="translate(0 8)">
            <path
              d="M39 40h50l-5 37c0 5-7.5 9-20 9s-20-4-20-9z"
              fill={`url(#${ids.cup})`}
              fillOpacity="0.18"
              stroke="#d8f4ff"
              strokeOpacity="0.90"
              strokeWidth="2.3"
              strokeLinejoin="round"
            />
            <ellipse cx="64" cy="40" rx="25" ry="5.2" fill={`url(#${ids.cup})`} fillOpacity="0.22" stroke="#d8f4ff" strokeOpacity="0.90" strokeWidth="2.3" />
            <ellipse cx="64" cy="40" rx="18.5" ry="3.1" fill={`url(#${ids.coffee})`} fillOpacity="0.88" />
            <path d="M46 56c10-2.7 26-2.7 36 0" fill="none" stroke="#d9a977" strokeOpacity="0.74" strokeWidth="2.1" strokeLinecap="round" />
            <rect x="61.5" y="53" width="5" height="19" rx="2.5" fill="#7ce2ff" fillOpacity="0.82" />
            <path d="M56.5 79c2.2 2.7 4.7 4 7.5 4s5.3-1.3 7.5-4" fill="none" stroke="#7ce2ff" strokeOpacity="0.82" strokeWidth="2" strokeLinecap="round" />
          </g>
        </>
      ) : (
        <>
          <circle cx="64" cy="64" r="58" fill={`url(#${ids.bg})`} stroke="rgba(185,239,255,0.16)" strokeWidth="1" />
          <circle cx="64" cy="64" r="54" fill="none" stroke={`url(#${ids.ring})`} strokeOpacity="0.82" strokeWidth="2.2" />
          <path d="M64 16c0 8-9 13-17 20" fill="none" stroke="#d9a977" strokeWidth="3.5" strokeLinecap="round" />
          <path d="M64 16c0 8 9 13 17 20" fill="none" stroke="#d9a977" strokeWidth="3.5" strokeLinecap="round" />
          <g filter={`url(#${ids.glow})`}>
            <circle cx="64" cy="29" r="2.8" fill="#7ce2ff" />
          </g>
          <g transform="translate(0 5)">
            <path
              d="M35 41h58l-5 42c0 5.5-8.5 10-24 10s-24-4.5-24-10z"
              fill={`url(#${ids.cup})`}
              fillOpacity="0.18"
              stroke="#d8f4ff"
              strokeOpacity="0.90"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
            <ellipse cx="64" cy="41" rx="29" ry="5.8" fill={`url(#${ids.cup})`} fillOpacity="0.22" stroke="#d8f4ff" strokeOpacity="0.90" strokeWidth="2.5" />
            <ellipse cx="64" cy="41" rx="21" ry="3.5" fill={`url(#${ids.coffee})`} fillOpacity="0.88" />
            <path d="M45 59c10.5-2.9 27.5-2.9 38 0" fill="none" stroke="#d9a977" strokeOpacity="0.74" strokeWidth="2.25" strokeLinecap="round" />
            <rect x="61.5" y="57" width="5" height="20" rx="2.5" fill="#7ce2ff" fillOpacity="0.80" />
            <path d="M56 84c2.2 2.9 4.9 4.2 8 4.2s5.8-1.3 8-4.2" fill="none" stroke="#7ce2ff" strokeOpacity="0.80" strokeWidth="2.05" strokeLinecap="round" />
          </g>
        </>
      )}
    </svg>
  );
});
