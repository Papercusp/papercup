import {
  forwardRef,
  useId,
  type ComponentPropsWithoutRef,
} from 'react';

type SvgProps = ComponentPropsWithoutRef<'svg'> & {
  decorative?: boolean;
};

type MarkProps = SvgProps & {
  monochrome?: boolean;
};

export const HIVE_BRAND_COLORS = {
  ink: '#0B0E14',
  charcoal: '#0F1411',
  charcoalRaised: '#171A13',
  honey: '#F6B72F',
  honeyStrong: '#FFD166',
  honeyDeep: '#B97812',
  cream: '#FFF2C2',
} as const;

function ariaProps(decorative: boolean | undefined) {
  return {
    'aria-hidden': decorative ? true : undefined,
    focusable: 'false' as const,
  };
}

export const HivePrimaryMark = forwardRef<SVGSVGElement, MarkProps>(function HivePrimaryMark(
  { className, decorative = true, monochrome = false, ...props },
  ref,
) {
  const base = useId().replace(/:/g, '');
  const ids = {
    bg: `${base}-hive-bg`,
    honey: `${base}-hive-honey`,
    wing: `${base}-hive-wing`,
    glow: `${base}-hive-glow`,
  };
  const stroke = monochrome ? 'currentColor' : HIVE_BRAND_COLORS.honeyStrong;
  const fill = monochrome ? 'none' : `url(#${ids.bg})`;
  const honey = monochrome ? 'currentColor' : `url(#${ids.honey})`;
  const muted = monochrome ? 'currentColor' : HIVE_BRAND_COLORS.cream;

  return (
    <svg
      ref={ref}
      viewBox="0 0 128 128"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      {...ariaProps(decorative)}
      {...props}
    >
      <defs>
        <radialGradient id={ids.bg} cx="50%" cy="34%" r="70%">
          <stop offset="0%" stopColor="#25210F" />
          <stop offset="56%" stopColor={HIVE_BRAND_COLORS.charcoal} />
          <stop offset="100%" stopColor="#080A08" />
        </radialGradient>
        <linearGradient id={ids.honey} x1="24%" y1="8%" x2="84%" y2="92%">
          <stop offset="0%" stopColor={HIVE_BRAND_COLORS.honeyStrong} />
          <stop offset="52%" stopColor={HIVE_BRAND_COLORS.honey} />
          <stop offset="100%" stopColor={HIVE_BRAND_COLORS.honeyDeep} />
        </linearGradient>
        <linearGradient id={ids.wing} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFF8D6" stopOpacity="0.92" />
          <stop offset="100%" stopColor="#F6B72F" stopOpacity="0.30" />
        </linearGradient>
        <filter id={ids.glow} x="-35%" y="-35%" width="170%" height="170%">
          <feGaussianBlur stdDeviation="3.4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path
        d="M64 8 113 36v56l-49 28-49-28V36z"
        fill={fill}
        stroke={stroke}
        strokeWidth="3.2"
        strokeLinejoin="round"
      />
      <path
        d="M64 20 101 41v43l-37 22-37-22V41z"
        fill="none"
        stroke={stroke}
        strokeOpacity={monochrome ? 0.55 : 0.34}
        strokeWidth="1.6"
      />
      <path
        d="M64 34 86 47v25L64 85 42 72V47z"
        fill={monochrome ? 'none' : 'rgba(246, 183, 47, 0.10)'}
        stroke={stroke}
        strokeWidth="2"
      />
      <path d="M42 47 64 60l22-13M64 60v25" fill="none" stroke={stroke} strokeOpacity="0.62" strokeWidth="1.7" strokeLinecap="round" />
      <g filter={monochrome ? undefined : `url(#${ids.glow})`}>
        <path
          d="M53 53c-10-10-23-9-29 1 9 4 20 3 29-1Z"
          fill={monochrome ? 'none' : `url(#${ids.wing})`}
          stroke={muted}
          strokeOpacity={monochrome ? 0.70 : 0.46}
          strokeWidth="1.5"
        />
        <path
          d="M75 53c10-10 23-9 29 1-9 4-20 3-29-1Z"
          fill={monochrome ? 'none' : `url(#${ids.wing})`}
          stroke={muted}
          strokeOpacity={monochrome ? 0.70 : 0.46}
          strokeWidth="1.5"
        />
        <path d="M64 39c7 5 11 13 11 24 0 15-5 26-11 26S53 78 53 63c0-11 4-19 11-24Z" fill={honey} stroke={stroke} strokeWidth="1.7" />
        <path d="M55 58h18M54 70h20" stroke={HIVE_BRAND_COLORS.charcoal} strokeOpacity={monochrome ? 0 : 0.62} strokeWidth="2.4" strokeLinecap="round" />
        <path d="M58 39c0-5 3-9 6-9s6 4 6 9" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
        <circle cx="59" cy="50" r="1.8" fill={HIVE_BRAND_COLORS.charcoal} opacity={monochrome ? 0 : 0.78} />
        <circle cx="69" cy="50" r="1.8" fill={HIVE_BRAND_COLORS.charcoal} opacity={monochrome ? 0 : 0.78} />
      </g>
    </svg>
  );
});

export const HiveQueenMark = forwardRef<SVGSVGElement, MarkProps>(function HiveQueenMark(
  { className, decorative = true, monochrome = false, ...props },
  ref,
) {
  const base = useId().replace(/:/g, '');
  const ids = {
    bg: `${base}-queen-bg`,
    crown: `${base}-queen-crown`,
    core: `${base}-queen-core`,
    glow: `${base}-queen-glow`,
  };
  const stroke = monochrome ? 'currentColor' : HIVE_BRAND_COLORS.honeyStrong;
  const fill = monochrome ? 'none' : `url(#${ids.bg})`;

  return (
    <svg
      ref={ref}
      viewBox="0 0 128 128"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      {...ariaProps(decorative)}
      {...props}
    >
      <defs>
        <radialGradient id={ids.bg} cx="50%" cy="35%" r="72%">
          <stop offset="0%" stopColor="#2B250D" />
          <stop offset="62%" stopColor="#10120E" />
          <stop offset="100%" stopColor="#070807" />
        </radialGradient>
        <linearGradient id={ids.crown} x1="20%" y1="0%" x2="86%" y2="100%">
          <stop offset="0%" stopColor="#FFF2C2" />
          <stop offset="46%" stopColor="#FFD166" />
          <stop offset="100%" stopColor="#B97812" />
        </linearGradient>
        <radialGradient id={ids.core} cx="50%" cy="46%" r="58%">
          <stop offset="0%" stopColor="#FFF8D6" stopOpacity="0.96" />
          <stop offset="38%" stopColor="#F6B72F" stopOpacity="0.78" />
          <stop offset="100%" stopColor="#F6B72F" stopOpacity="0" />
        </radialGradient>
        <filter id={ids.glow} x="-35%" y="-35%" width="170%" height="170%">
          <feGaussianBlur stdDeviation="4.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path d="M64 8 113 36v56l-49 28-49-28V36z" fill={fill} stroke={stroke} strokeWidth="3.2" strokeLinejoin="round" />
      <path d="M35 48 48 30l16 19 16-19 13 18-8 37H43z" fill={monochrome ? 'none' : `url(#${ids.crown})`} stroke={stroke} strokeWidth="2.2" strokeLinejoin="round" />
      <circle cx="64" cy="72" r="25" fill={monochrome ? 'none' : `url(#${ids.core})`} stroke={stroke} strokeOpacity="0.62" strokeWidth="1.8" />
      <g filter={monochrome ? undefined : `url(#${ids.glow})`}>
        <path d="M47 75h34M52 65h24M57 55h14" stroke={stroke} strokeWidth="2.8" strokeLinecap="round" />
        <path d="M64 42v54" stroke={stroke} strokeWidth="2.6" strokeLinecap="round" />
      </g>
      <path d="M31 91h66" stroke={stroke} strokeOpacity="0.42" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
});

type NounIconKind = 'hive' | 'swarm' | 'queen' | 'bee' | 'cell' | 'comb' | 'frame';

type NounIconProps = SvgProps & {
  kind: NounIconKind;
};

export function HiveNounIcon({ kind, className, decorative = true, ...props }: NounIconProps) {
  const base = useId().replace(/:/g, '');
  const id = `${base}-${kind}`;

  if (kind === 'queen') {
    return <HiveQueenMark className={className} decorative={decorative} monochrome {...props} />;
  }

  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      {...ariaProps(decorative)}
      {...props}
    >
      <defs>
        <linearGradient id={id} x1="18%" y1="0%" x2="86%" y2="100%">
          <stop offset="0%" stopColor="#FFF2C2" />
          <stop offset="58%" stopColor="#F6B72F" />
          <stop offset="100%" stopColor="#B97812" />
        </linearGradient>
      </defs>
      {kind === 'hive' ? (
        <path d="M32 6 55 19v26L32 58 9 45V19z" fill="none" stroke={`url(#${id})`} strokeWidth="3" strokeLinejoin="round" />
      ) : null}
      {kind === 'swarm' ? (
        <g fill={`url(#${id})`}>
          <circle cx="18" cy="22" r="4" />
          <circle cx="34" cy="14" r="4" />
          <circle cx="46" cy="28" r="4" />
          <circle cx="27" cy="38" r="4" />
          <circle cx="44" cy="48" r="4" />
          <path d="M21 24 31 16M37 17l7 8M42 31 31 36M31 40l10 6" stroke={`url(#${id})`} strokeWidth="2" strokeLinecap="round" fill="none" />
        </g>
      ) : null}
      {kind === 'bee' ? (
        <g stroke={`url(#${id})`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none">
          <path d="M32 18c7 5 10 11 10 19 0 10-4 18-10 18S22 47 22 37c0-8 3-14 10-19Z" />
          <path d="M24 31h16M23 40h18M25 22c-6-6-14-5-18 1 6 3 12 3 18-1ZM39 22c6-6 14-5 18 1-6 3-12 3-18-1Z" />
        </g>
      ) : null}
      {kind === 'cell' ? (
        <path d="M32 8 52 20v24L32 56 12 44V20z" fill="none" stroke={`url(#${id})`} strokeWidth="3" strokeLinejoin="round" />
      ) : null}
      {kind === 'comb' ? (
        <g fill="none" stroke={`url(#${id})`} strokeWidth="2.4" strokeLinejoin="round">
          <path d="M22 8 34 15v14l-12 7-12-7V15z" />
          <path d="M42 8 54 15v14l-12 7-12-7V15z" />
          <path d="M32 29 44 36v14l-12 7-12-7V36z" />
        </g>
      ) : null}
      {kind === 'frame' ? (
        <g fill="none" stroke={`url(#${id})`} strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="12" y="10" width="40" height="44" rx="4" />
          <path d="M20 18h24M20 46h24M20 26l24 14M44 26 20 40" />
        </g>
      ) : null}
    </svg>
  );
}

export function HiveCombMotif({ className, decorative = true, ...props }: SvgProps) {
  const id = useId().replace(/:/g, '');
  return (
    <svg
      viewBox="0 0 360 120"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      {...ariaProps(decorative)}
      {...props}
    >
      <defs>
        <pattern id={`${id}-comb`} width="48" height="42" patternUnits="userSpaceOnUse" patternTransform="translate(2 0)">
          <path d="M24 2 45 14v24L24 50 3 38V14z" fill="none" stroke="currentColor" strokeOpacity="0.32" strokeWidth="1.2" />
        </pattern>
        <linearGradient id={`${id}-fade`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0" />
          <stop offset="45%" stopColor="currentColor" stopOpacity="1" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="360" height="120" fill={`url(#${id}-comb)`} />
      <path d="M26 61h308" stroke={`url(#${id}-fade)`} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export type { NounIconKind };
