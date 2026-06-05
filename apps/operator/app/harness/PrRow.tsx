'use client';

/**
 * PrRow — single PR row for PrsTab (Phase 7 P-043).
 *
 * Shows: PR number + title, author avatar placeholder, checks status,
 * trust badge, action buttons.
 */

import React from 'react';
import { ExternalLink, CheckCircle, XCircle, Clock, AlertCircle, ShieldCheck } from 'lucide-react';
import { COLORS, FONTS, RADIUS } from './theme';

import type { PrRowData } from '@papercusp/operator-core/lib/pr-host/pr-row-data';
export type { PrRowData };

interface Props {
  pr: PrRowData;
  onApprove?: (prNumber: number) => void;
  onApproveAndMerge?: (prNumber: number) => void;
}

function ChecksBadge({ conclusion }: { conclusion: string | null }) {
  if (conclusion === null) return null;
  if (conclusion === 'success') {
    return (
      <span style={{ color: COLORS.success, display: 'flex', alignItems: 'center', gap: 2, fontSize: 12 }}>
        <CheckCircle size={12} /> checks
      </span>
    );
  }
  if (conclusion === 'failure') {
    return (
      <span style={{ color: COLORS.error, display: 'flex', alignItems: 'center', gap: 2, fontSize: 12 }}>
        <XCircle size={12} /> failed
      </span>
    );
  }
  if (conclusion === 'pending') {
    return (
      <span style={{ color: COLORS.textMuted, display: 'flex', alignItems: 'center', gap: 2, fontSize: 12 }}>
        <Clock size={12} /> pending
      </span>
    );
  }
  return (
    <span style={{ color: COLORS.textMuted, display: 'flex', alignItems: 'center', gap: 2, fontSize: 12 }}>
      <AlertCircle size={12} /> {conclusion}
    </span>
  );
}

function ReviewBadge({ decision }: { decision: PrRowData['review_decision'] }) {
  if (decision === 'none') return null;
  const color =
    decision === 'approved'
      ? COLORS.success
      : decision === 'changes_requested'
        ? COLORS.error
        : COLORS.textMuted;
  const label =
    decision === 'approved'
      ? '✓ approved'
      : decision === 'changes_requested'
        ? '✗ changes requested'
        : decision;
  return (
    <span style={{ color, fontSize: 12 }}>{label}</span>
  );
}

export function PrRow({ pr, onApprove, onApproveAndMerge }: Props) {
  const cannotReach = pr.state === 'gone';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '10px 0',
        borderBottom: `1px solid ${COLORS.border}`,
        opacity: cannotReach ? 0.5 : 1,
      }}
    >
      {/* PR number */}
      <span style={{ color: COLORS.textMuted, fontSize: 12, minWidth: 32, paddingTop: 2 }}>
        #{pr.number}
      </span>

      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span
            style={{
              fontFamily: FONTS.sans,
              fontSize: 13,
              fontWeight: 500,
              color: COLORS.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 360,
            }}
          >
            {pr.title}
          </span>
          {pr.trusted && pr.reviewerRoleEnabled && (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 3,
                background: COLORS.successBg ?? 'rgba(34,197,94,0.1)',
                color: COLORS.success,
                borderRadius: RADIUS.sm,
                padding: '1px 6px',
                fontSize: 11,
              }}
            >
              <ShieldCheck size={10} /> trusted
            </span>
          )}
          {cannotReach && (
            <span style={{ fontSize: 11, color: COLORS.error }}>PR gone</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: COLORS.textMuted }}>@{pr.author_login}</span>
          <ChecksBadge conclusion={pr.check_conclusion} />
          <ReviewBadge decision={pr.review_decision} />
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <a
          href={pr.html_url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            color: COLORS.accent,
            textDecoration: 'none',
          }}
          aria-label={`Open PR #${pr.number} on GitHub`}
        >
          <ExternalLink size={12} />
        </a>
        {pr.reviewerRoleEnabled && pr.state === 'open' && (
          <>
            <button
              onClick={() => onApprove?.(pr.number)}
              style={{
                fontSize: 12,
                padding: '2px 8px',
                borderRadius: RADIUS.sm,
                border: `1px solid ${COLORS.border}`,
                background: 'transparent',
                color: COLORS.text,
                cursor: 'pointer',
              }}
            >
              Approve
            </button>
            <button
              onClick={() => onApproveAndMerge?.(pr.number)}
              style={{
                fontSize: 12,
                padding: '2px 8px',
                borderRadius: RADIUS.sm,
                border: `1px solid ${COLORS.accent}`,
                background: COLORS.accent,
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              Approve + merge
            </button>
          </>
        )}
      </div>
    </div>
  );
}
