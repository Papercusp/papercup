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
          <circle cx="64" cy="64" r="54" fill={`url(#${ids.bg})`} stroke={`url(#${ids.ring})`} strokeWidth="4.5" />
          <path d="M64 18c0 7-8 11-15 17" fill="none" stroke="#d9a977" strokeWidth="3.2" strokeLinecap="round" />
          <path d="M64 18c0 7 8 11 15 17" fill="none" stroke="#d9a977" strokeWidth="3.2" strokeLinecap="round" />
          <g transform="translate(0 8)">
            <path
              d="M47 42h34l-4 30c0 4-5.5 7-13 7s-13-3-13-7z"
              fill={`url(#${ids.cup})`}
              fillOpacity="0.16"
              stroke="#d8f4ff"
              strokeOpacity="0.88"
              strokeWidth="2.2"
              strokeLinejoin="round"
            />
            <ellipse cx="64" cy="42" rx="17" ry="4.2" fill={`url(#${ids.cup})`} fillOpacity="0.20" stroke="#d8f4ff" strokeOpacity="0.88" strokeWidth="2.2" />
            <ellipse cx="64" cy="42" rx="12.5" ry="2.8" fill={`url(#${ids.coffee})`} fillOpacity="0.88" />
            <rect x="61.5" y="51.5" width="5" height="15" rx="2.5" fill="#7ce2ff" fillOpacity="0.80" />
            <path d="M58 74c1.8 2.4 4 3.4 6 3.4s4.2-1 6-3.4" fill="none" stroke="#7ce2ff" strokeOpacity="0.78" strokeWidth="1.9" strokeLinecap="round" />
          </g>
        </>
      ) : (
        <>
          <circle cx="64" cy="64" r="58" fill={`url(#${ids.bg})`} stroke="rgba(185,239,255,0.16)" strokeWidth="1" />
          <circle cx="64" cy="64" r="50" fill="#08111d" stroke={`url(#${ids.ring})`} strokeWidth="4" />
          <circle cx="64" cy="64" r="43" fill="none" stroke="rgba(185,239,255,0.18)" strokeWidth="1.5" />
          <path d="M64 16c0 8-9 13-17 20" fill="none" stroke="#d9a977" strokeWidth="3.5" strokeLinecap="round" />
          <path d="M64 16c0 8 9 13 17 20" fill="none" stroke="#d9a977" strokeWidth="3.5" strokeLinecap="round" />
          <g filter={`url(#${ids.glow})`}>
            <circle cx="64" cy="29" r="2.6" fill="#7ce2ff" />
          </g>
          <g transform="translate(0 4)">
            <path
              d="M41 43h46l-5 38c0 5-8 9-18 9s-18-4-18-9z"
              fill={`url(#${ids.cup})`}
              fillOpacity="0.18"
              stroke="#d8f4ff"
              strokeOpacity="0.88"
              strokeWidth="2.4"
              strokeLinejoin="round"
            />
            <ellipse cx="64" cy="43" rx="23" ry="5" fill={`url(#${ids.cup})`} fillOpacity="0.22" stroke="#d8f4ff" strokeOpacity="0.88" strokeWidth="2.4" />
            <ellipse cx="64" cy="43" rx="18" ry="3.5" fill={`url(#${ids.coffee})`} fillOpacity="0.86" />
            <path d="M46 59c10-3 26-3 36 0" fill="none" stroke="#d9a977" strokeOpacity="0.72" strokeWidth="2.2" strokeLinecap="round" />
            <rect x="61.5" y="58" width="5" height="18" rx="2.5" fill="#7ce2ff" fillOpacity="0.78" />
            <path d="M57 82c2 3 4.5 4 7 4s5-1 7-4" fill="none" stroke="#7ce2ff" strokeOpacity="0.78" strokeWidth="2" strokeLinecap="round" />
          </g>
        </>
      )}
    </svg>
  );
});
