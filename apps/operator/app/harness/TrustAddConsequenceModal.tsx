'use client';

/**
 * TrustAddConsequenceModal — consequence confirmation when adding
 * someone to the trust list while auto_review (±auto_merge) is on.
 *
 * Phase 7 P-046.
 *
 * P-046a: surfaces when auto_review is on — future PRs auto-approved.
 * P-046b: additional copy when auto_merge is also on.
 * P-046c: confirm → contributor added; toast "@alice added to trust list."
 * P-046d: cancel → no change.
 */

import React from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { COLORS, FONTS, RADIUS } from './theme';

interface Props {
  /** GitHub login of the contributor being added. */
  authorLogin: string;
  /** Whether auto_review is on for this harness (gate for showing modal). */
  autoReview: boolean;
  /** Whether auto_merge is also on. */
  autoMerge: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function TrustAddConsequenceModal({
  authorLogin,
  autoReview,
  autoMerge,
  onConfirm,
  onCancel,
}: Props) {
  if (!autoReview) {
    // Safety guard — callers should only render when autoReview is true,
    // but if not, just call onConfirm immediately (no consequence).
    onConfirm();
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal
      aria-labelledby="trust-modal-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        fontFamily: FONTS.ui,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        style={{
          background: COLORS.surface ?? COLORS.bg ?? '#1a1a1a',
          border: `1px solid ${COLORS.border}`,
          borderRadius: RADIUS.md ?? 8,
          padding: 20,
          width: 400,
          maxWidth: '90vw',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16,
          }}
        >
          <div
            id="trust-modal-title"
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <ShieldCheck size={16} color={COLORS.accent} />
            <span style={{ fontSize: 14, fontWeight: 600, color: COLORS.text }}>
              Add to trust list
            </span>
          </div>
          <button
            onClick={onCancel}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: COLORS.textMuted,
              padding: 4,
              lineHeight: 1,
            }}
            aria-label="Cancel"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body — P-046a */}
        <p style={{ fontSize: 13, color: COLORS.text, margin: '0 0 12px', lineHeight: 1.5 }}>
          Future PRs from{' '}
          <strong style={{ color: COLORS.accent }}>@{authorLogin}</strong> will be{' '}
          <strong>auto-approved</strong> on this harness.
          {/* P-046b additional copy */}
          {autoMerge && (
            <>
              {' '}Their PRs will also be{' '}
              <strong>auto-merged</strong> once checks pass.
            </>
          )}
        </p>

        <p style={{ fontSize: 12, color: COLORS.textMuted, margin: '0 0 20px', lineHeight: 1.4 }}>
          You can remove @{authorLogin} from the trust list at any time in Contributors settings.
        </p>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              fontSize: 13,
              padding: '6px 16px',
              borderRadius: RADIUS.sm ?? 4,
              border: `1px solid ${COLORS.border}`,
              background: 'transparent',
              color: COLORS.text,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              fontSize: 13,
              padding: '6px 16px',
              borderRadius: RADIUS.sm ?? 4,
              border: `1px solid ${COLORS.accent}`,
              background: COLORS.accent,
              color: '#fff',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Add @{authorLogin}
          </button>
        </div>
      </div>
    </div>
  );
}
