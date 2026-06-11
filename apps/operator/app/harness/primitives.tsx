'use client';

import { CSSProperties, ReactNode } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  Archive,
  Bug,
  Check,
  CheckCircle,
  Circle,
  Eye,
  FileDiff,
  FlaskConical,
  Hammer,
  Info,
  ListChecks,
  Puzzle,
  Sparkles,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  COLORS, FONTS, RADIUS, SIZES, STATUS, HarnessStatus, getRoleStyle,
  SEVERITY, ISSUE_STATUS, WORK_ITEM_KIND,
  type IssueSeverityKey, type IssueStatusKey, type StatusMeta, type WorkItemKindKey,
} from './theme';
import { Tooltip } from './Tooltip';

/**
 * Shared chip-pill geometry — the SeverityPill recipe (tinted rounded-full
 * chip, icon + bold uppercase label). SeverityPill renders it directly;
 * Status / IssueStatus pills opt in via variant="chip" and KindPill always
 * uses it, so surfaces like the Work-items table can speak one visual
 * language across all their pill columns.
 */
function ChipPill({
  meta,
  Icon,
  size,
  showLabel,
  labelOverride,
}: {
  meta: StatusMeta;
  Icon: LucideIcon;
  size: 'xs' | 'sm';
  showLabel: boolean;
  labelOverride?: string;
}) {
  const iconSize = size === 'xs' ? 10 : 11;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '1px 8px', borderRadius: 999,
      fontSize: size === 'xs' ? 10 : SIZES.xs,
      fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
      color: meta.text, background: meta.bg, whiteSpace: 'nowrap',
    }}>
      <Icon size={iconSize} aria-hidden />
      {showLabel && <span>{labelOverride ?? meta.label}</span>}
    </span>
  );
}

// Feature/harness status → icon, for the chip variant of StatusPill. Same
// `?? Circle` fallback discipline as SEVERITY_ICON so an unknown status can't
// render `<undefined/>` and crash the row subtree.
export const STATUS_ICON: Record<HarnessStatus, LucideIcon> = {
  todo: Circle,
  in_progress: Hammer,
  validating: Eye,
  failing: XCircle,
  blocked: AlertTriangle,
  passed: CheckCircle,
  deprecated: Archive,
};

/** Dot + label — Linear's status badge pattern. variant="chip" renders the
 * SeverityPill-style tinted chip instead (icon + uppercase label). */
export function StatusPill({
  status,
  size = 'sm',
  showLabel = true,
  variant = 'dot',
}: {
  status: HarnessStatus;
  size?: 'xs' | 'sm';
  showLabel?: boolean;
  variant?: 'dot' | 'chip';
}) {
  const s = STATUS[status];
  if (variant === 'chip') {
    return <ChipPill meta={s} Icon={STATUS_ICON[status] ?? Circle} size={size} showLabel={showLabel} />;
  }
  const dotSize = size === 'xs' ? 6 : 8;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: size === 'xs' ? SIZES.xs : SIZES.sm,
      color: s.text,
      fontWeight: 500,
      whiteSpace: 'nowrap',
    }}>
      <span aria-hidden style={{
        width: dotSize, height: dotSize, borderRadius: '50%',
        background: s.solid, flexShrink: 0,
      }} />
      {showLabel && <span>{s.label}</span>}
    </span>
  );
}

// Severity → icon. Every panel that renders issue severity reads this map
// (with a Circle fallback) so a missing/typo'd key can't render `<undefined/>`
// and crash the row subtree.
export const SEVERITY_ICON: Record<IssueSeverityKey, LucideIcon> = {
  critical: AlertOctagon,
  major: AlertTriangle,
  minor: Info,
  nit: Circle,
};

// Issue status → icon (open=Circle, ack=Eye, fixing=Hammer, resolved=Check,
// closed=CheckCircle, wontfix=XCircle). Same fallback discipline as
// SEVERITY_ICON. (`resolved` was missing since the work_items issue-family
// added it to ISSUE_STATUS — it silently hit the Circle fallback.)
export const ISSUE_STATUS_ICON: Record<IssueStatusKey, LucideIcon> = {
  open: Circle,
  acknowledged: Eye,
  fixing: Hammer,
  resolved: Check,
  closed: CheckCircle,
  wontfix: XCircle,
};

/** Issue severity badge — icon + label, colored from the canonical SEVERITY table. */
export function SeverityPill({
  severity,
  size = 'sm',
  showLabel = true,
}: {
  severity: string;
  size?: 'xs' | 'sm';
  showLabel?: boolean;
}) {
  const s = SEVERITY[severity as IssueSeverityKey];
  const Icon = SEVERITY_ICON[severity as IssueSeverityKey] ?? Circle;
  return <ChipPill meta={s} Icon={Icon} size={size} showLabel={showLabel} />;
}

/** Issue status badge — dot + label, colored from the canonical ISSUE_STATUS
 * table. variant="chip" renders the SeverityPill-style tinted chip instead. */
export function IssueStatusPill({
  status,
  size = 'sm',
  showLabel = true,
  variant = 'dot',
}: {
  status: string;
  size?: 'xs' | 'sm';
  showLabel?: boolean;
  variant?: 'dot' | 'chip';
}) {
  const s = ISSUE_STATUS[status as IssueStatusKey];
  if (variant === 'chip') {
    return (
      <ChipPill
        meta={s}
        Icon={ISSUE_STATUS_ICON[status as IssueStatusKey] ?? Circle}
        size={size}
        showLabel={showLabel}
      />
    );
  }
  const dotSize = size === 'xs' ? 6 : 8;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: size === 'xs' ? SIZES.xs : SIZES.sm,
      color: s.text, fontWeight: 500, whiteSpace: 'nowrap',
    }}>
      <span aria-hidden style={{
        width: dotSize, height: dotSize, borderRadius: '50%',
        background: s.solid, flexShrink: 0,
      }} />
      {showLabel && <span>{s.label}</span>}
    </span>
  );
}

// Work-item kind → icon. Same fallback discipline as SEVERITY_ICON.
export const KIND_ICON: Record<WorkItemKindKey, LucideIcon> = {
  feature: Sparkles,
  'research-task': FlaskConical,
  chunk: Puzzle,
  bug: Bug,
  change: FileDiff,
  task: ListChecks,
};

/** Work-item kind badge — icon + label chip, colored from the canonical
 * WORK_ITEM_KIND table (same recipe as SeverityPill). An unknown kind keeps
 * its raw name (neutral grey chip) instead of reading "Unknown". */
export function KindPill({
  kind,
  size = 'sm',
  showLabel = true,
}: {
  kind: string;
  size?: 'xs' | 'sm';
  showLabel?: boolean;
}) {
  const s = WORK_ITEM_KIND[kind as WorkItemKindKey];
  const Icon = KIND_ICON[kind as WorkItemKindKey] ?? Circle;
  const labelOverride = kind in WORK_ITEM_KIND ? undefined : kind;
  return <ChipPill meta={s} Icon={Icon} size={size} showLabel={showLabel} labelOverride={labelOverride} />;
}

/** Short monospace ID pill — copyable. */
export function IdPill({ id, onClick }: { id: string; onClick?: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(id).catch(() => {});
        onClick?.();
      }}
      title={`${id} — click to copy`}
      style={{
        fontFamily: FONTS.mono,
        fontSize: SIZES.xs,
        color: COLORS.textMuted,
        background: 'transparent',
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.sm,
        padding: '1px 6px',
        cursor: 'pointer',
        letterSpacing: '0.02em',
      }}
    >
      {id}
    </button>
  );
}

export function RolePill({ role }: { role: string }) {
  const r = getRoleStyle(role);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: SIZES.xs, color: COLORS.text,
    }}>
      <span aria-hidden style={{
        width: 6, height: 6, borderRadius: '50%', background: r.solid,
      }} />
      {r.label.toLowerCase()}
    </span>
  );
}

/** Standard card container with subtle border. */
export function SectionCard({
  title,
  actions,
  children,
  style,
  bodyStyle,
  noPadding,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
  noPadding?: boolean;
}) {
  return (
    <div style={{
      background: COLORS.surfaceRaised,
      border: `1px solid ${COLORS.border}`,
      borderRadius: RADIUS.md,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      ...style,
    }}>
      {title && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '0.5rem 0.75rem',
          borderBottom: `1px solid ${COLORS.borderSubtle}`,
          fontSize: SIZES.sm,
          color: COLORS.textMuted,
          fontWeight: 500,
          letterSpacing: '0.02em',
          textTransform: 'uppercase',
          flexShrink: 0,
        }}>
          <span>{title}</span>
          {actions && <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>{actions}</span>}
        </div>
      )}
      <div style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        padding: noPadding ? 0 : '0.5rem 0.75rem',
        ...bodyStyle,
      }}>
        {children}
      </div>
    </div>
  );
}

export function KbdHint({ children }: { children: ReactNode }) {
  return (
    <kbd style={{
      fontFamily: FONTS.mono,
      fontSize: '0.65rem',
      padding: '1px 5px',
      background: COLORS.surfaceHover,
      color: COLORS.textMuted,
      border: `1px solid ${COLORS.border}`,
      borderRadius: RADIUS.sm,
      textTransform: 'none',
    }}>
      {children}
    </kbd>
  );
}

/** Small icon-style button used across the harness UI. */
export function IconButton({
  onClick,
  title,
  children,
  variant = 'ghost',
  disabled,
}: {
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  children: ReactNode;
  variant?: 'ghost' | 'primary' | 'danger' | 'subtle';
  disabled?: boolean;
}) {
  const styles: Record<string, CSSProperties> = {
    ghost: {
      background: 'transparent',
      color: COLORS.textMuted,
      border: `1px solid ${COLORS.border}`,
    },
    subtle: {
      background: COLORS.surfaceHover,
      color: COLORS.text,
      border: `1px solid ${COLORS.border}`,
    },
    primary: {
      background: COLORS.success,
      color: 'white',
      border: `1px solid ${COLORS.success}`,
      fontWeight: 600,
    },
    danger: {
      background: COLORS.danger,
      color: 'white',
      border: `1px solid ${COLORS.danger}`,
      fontWeight: 600,
    },
  };
  const btn = (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...styles[variant],
        borderRadius: RADIUS.sm,
        padding: '0.25rem 0.6rem',
        fontSize: SIZES.sm,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      {children}
    </button>
  );
  if (!title) return btn;
  return <Tooltip label={title}>{btn}</Tooltip>;
}
