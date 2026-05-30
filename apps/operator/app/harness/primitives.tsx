'use client';

import { CSSProperties, ReactNode } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle,
  Circle,
  Eye,
  Hammer,
  Info,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  COLORS, FONTS, RADIUS, SIZES, STATUS, HarnessStatus, getRoleStyle,
  SEVERITY, ISSUE_STATUS, type IssueSeverityKey, type IssueStatusKey,
} from './theme';
import { Tooltip } from './Tooltip';

/** Dot + label — Linear's status badge pattern. */
export function StatusPill({
  status,
  size = 'sm',
  showLabel = true,
}: {
  status: HarnessStatus;
  size?: 'xs' | 'sm';
  showLabel?: boolean;
}) {
  const s = STATUS[status];
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

// Issue status → icon (open=Circle, ack=Eye, fixing=Hammer, closed=CheckCircle,
// wontfix=XCircle). Same fallback discipline as SEVERITY_ICON.
export const ISSUE_STATUS_ICON: Record<IssueStatusKey, LucideIcon> = {
  open: Circle,
  acknowledged: Eye,
  fixing: Hammer,
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
  const iconSize = size === 'xs' ? 10 : 11;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '1px 8px', borderRadius: 999,
      fontSize: size === 'xs' ? 10 : SIZES.xs,
      fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
      color: s.text, background: s.bg, whiteSpace: 'nowrap',
    }}>
      <Icon size={iconSize} aria-hidden />
      {showLabel && <span>{s.label}</span>}
    </span>
  );
}

/** Issue status badge — dot + label, colored from the canonical ISSUE_STATUS table. */
export function IssueStatusPill({
  status,
  size = 'sm',
  showLabel = true,
}: {
  status: string;
  size?: 'xs' | 'sm';
  showLabel?: boolean;
}) {
  const s = ISSUE_STATUS[status as IssueStatusKey];
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
