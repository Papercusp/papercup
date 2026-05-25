'use client';

/**
 * ContributorRow — Phase 8 P-048a row component.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 §9.2 + addendum 3.
 *
 * Composes the existing badge components (P-071 ContributorBadgeRow,
 * P-048a BindingStatusBadge) into one tabular row. Avatar click routes
 * to the user profile (P-072) at `/users/github/<github_user_id>`.
 *
 * Greyed-out treatment when `binding_status === 'unverified'`
 * (P-048d).
 */

import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import {
  ContributorBadgeRow,
} from '@/app/_components/ContributorBadge';
import {
  BindingStatusBadge,
  type BindingStatus,
} from '@/app/_components/BindingStatusBadge';

export interface ContributorRowData {
  github_user_id: number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  joined_at: number;
  last_seen_at: number | null;
  binding_status: BindingStatus;
  binding_last_checked_at: number | null;
  device_count: number;
  prs_merged: number;
  features_shipped: number;
  activity_events: number;
}

const ROW: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '48px 1fr auto auto',
  gap: 12,
  alignItems: 'center',
  padding: '8px 12px',
  borderBottom: '1px solid var(--border)',
};

const AVATAR: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 9999,
  background: 'var(--surface-2)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--fg-dim)',
  overflow: 'hidden',
};

const NAME_LINE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 14,
  fontWeight: 500,
};

const META: CSSProperties = {
  fontSize: 12,
  color: 'var(--fg-dim)',
  marginTop: 2,
};

function formatDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

function pendingAge(joinedAt: number): string {
  const elapsedMs = Date.now() - joinedAt;
  const hours = Math.max(0, Math.round(elapsedMs / 3_600_000));
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export interface ContributorRowProps {
  row: ContributorRowData;
}

export function ContributorRow({ row }: ContributorRowProps): ReactNode {
  const greyed = row.binding_status === 'unverified';
  const displayName = row.display_name ?? row.github_username;
  const profileHref = `/users/github/${row.github_user_id}`;
  return (
    <div
      style={{
        ...ROW,
        opacity: greyed ? 0.55 : 1,
      }}
      data-binding-status={row.binding_status}
      data-github-user-id={row.github_user_id}
    >
      <Link href={profileHref} aria-label={`Profile for ${displayName}`}>
        <div style={AVATAR}>
          {row.avatar_url
            ? // eslint-disable-next-line @next/next/no-img-element
              <img
                src={row.avatar_url}
                alt=""
                width={40}
                height={40}
                style={{ borderRadius: 9999 }}
              />
            : (displayName?.[0] ?? '?').toUpperCase()}
        </div>
      </Link>

      <div>
        <div style={NAME_LINE}>
          <Link href={profileHref} style={{ color: 'inherit', textDecoration: 'none' }}>
            {displayName}
          </Link>
          <span style={{ color: 'var(--fg-dim)', fontWeight: 400 }}>
            @{row.github_username}
          </span>
          <BindingStatusBadge
            status={row.binding_status}
            pendingAgeText={
              row.binding_status === 'pending' ? pendingAge(row.joined_at) : undefined
            }
          />
        </div>
        <div style={META}>
          joined {formatDate(row.joined_at)}
          {row.device_count > 0 ? ` · ${row.device_count} device${row.device_count === 1 ? '' : 's'}` : ''}
        </div>
      </div>

      <div>
        <ContributorBadgeRow
          prsMerged={greyed ? 0 : row.prs_merged}
          featuresShipped={greyed ? 0 : row.features_shipped}
          activityEvents={greyed ? 0 : row.activity_events}
        />
      </div>

      <div />
    </div>
  );
}
