'use client';

/**
 * PrReviewerSettings — Phase 8 P-049.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 §9.4 + §7.5 (security-bucket PG tables).
 *
 * Per-harness, per-viewer modal exposing PR-reviewer role config:
 *
 *   P-049a — Toggles for pr_reviewer_role_enabled / auto_review /
 *            auto_merge + merge_method radio. The role-enabled toggle
 *            is the master kill-switch — disabling it greys out the
 *            inner auto_review / auto_merge controls.
 *
 *   P-049b — Trust list view + remove inline. Trust keyed by
 *            trusted_github_user_id; no "trust anyone" toggle.
 *            Adding trust happens elsewhere (PR row's Trust button).
 *
 *   P-049c — Audit log: recent auto-review + auto-merge actions from
 *            LOCAL auto_review_audit. Read-only.
 *
 * Pure UI — caller passes current rows + onSave / onRemoveTrust
 * callbacks. The modal owns its draft state while the user toggles
 * (uncommitted), then calls onSave on commit. This makes the
 * cancel/keep-pristine semantics trivial.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import {
  PR_MERGE_METHODS,
  type PrMergeMethod,
} from '../../lib/pr-host/types';

export interface PrReviewerSettingsValues {
  pr_reviewer_role_enabled: boolean;
  auto_review: boolean;
  auto_merge: boolean;
  merge_method: PrMergeMethod;
}

export interface TrustedAuthorRow {
  trusted_github_user_id: number;
  display_login: string;
  trusted_at_label: string;
}

export interface AutoReviewAuditRow {
  id: string;
  /** Display, e.g. "approved PR #123 by @bob (3m ago)". */
  display_text: string;
  /** 'approved' | 'merged' | 'skipped' — drives the color dot. */
  action: 'approved' | 'merged' | 'skipped';
}

export interface PrReviewerSettingsProps {
  open: boolean;
  onClose: () => void;
  /** Viewer's current PG row, or the default if no row exists yet. */
  initialValues: PrReviewerSettingsValues;
  /** Trust list rows (LOCAL trusted_authors). */
  trustedAuthors: TrustedAuthorRow[];
  /** Recent auto-review audit rows (newest first). */
  recentAudit: AutoReviewAuditRow[];
  /** Caller persists. Awaited; modal stays open until resolved. */
  onSave: (next: PrReviewerSettingsValues) => Promise<void>;
  /** Caller persists. Awaited. */
  onRemoveTrust: (trusted_github_user_id: number) => Promise<void>;
}

const OVERLAY: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
};

const MODAL: CSSProperties = {
  background: 'var(--surface, #1a1a1a)',
  borderRadius: 8,
  width: '90%',
  maxWidth: 560,
  maxHeight: '85vh',
  display: 'flex',
  flexDirection: 'column',
  fontSize: 14,
  boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
};

const HEADER: CSSProperties = {
  padding: '16px 20px',
  borderBottom: '1px solid var(--border, #2a2a2a)',
  fontWeight: 600,
  fontSize: 16,
};

const BODY: CSSProperties = {
  padding: '16px 20px',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const FOOTER: CSSProperties = {
  padding: '12px 20px',
  borderTop: '1px solid var(--border, #2a2a2a)',
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
};

const SECTION_TITLE: CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--fg-dim, #888)',
  marginBottom: 6,
};

const TOGGLE_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '6px 0',
};

const TOGGLE_LABEL: CSSProperties = {
  flex: 1,
};

const TOGGLE_DESC: CSSProperties = {
  fontSize: 12,
  color: 'var(--fg-dim, #888)',
};

const RADIO_ROW: CSSProperties = {
  display: 'flex',
  gap: 12,
};

const TRUST_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 0',
  borderBottom: '1px solid var(--border-subtle, #222)',
};

const AUDIT_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 0',
  fontSize: 13,
};

const AUDIT_DOT_BASE: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 4,
  flexShrink: 0,
};

const PRIMARY_BUTTON: CSSProperties = {
  background: 'var(--accent, #4CAF50)',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '8px 16px',
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
};

const SECONDARY_BUTTON: CSSProperties = {
  ...PRIMARY_BUTTON,
  background: 'transparent',
  color: 'var(--fg, #ddd)',
  border: '1px solid var(--border, #2a2a2a)',
};

const SMALL_LINK: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--fg-danger, #f44)',
  cursor: 'pointer',
  fontSize: 12,
  padding: 0,
};

const auditDotColor: Record<AutoReviewAuditRow['action'], string> = {
  approved: '#4CAF50',
  merged: '#2196F3',
  skipped: 'var(--fg-dim, #888)',
};

export function PrReviewerSettings(props: PrReviewerSettingsProps): ReactNode {
  const {
    open,
    onClose,
    initialValues,
    trustedAuthors,
    recentAudit,
    onSave,
    onRemoveTrust,
  } = props;

  const [draft, setDraft] = useState<PrReviewerSettingsValues>(initialValues);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(initialValues);
    }
  }, [open, initialValues]);

  if (!open) return null;

  const inner = !draft.pr_reviewer_role_enabled;

  async function handleSave(): Promise<void> {
    setSaving(true);
    try {
      await onSave(draft);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={OVERLAY}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pr-reviewer-settings-title"
      data-testid="pr-reviewer-settings"
      onClick={onClose}
    >
      <div style={MODAL} onClick={(e) => e.stopPropagation()}>
        <div id="pr-reviewer-settings-title" style={HEADER}>
          PR-reviewer settings
        </div>

        <div style={BODY}>
          {/* P-049a — toggles */}
          <div>
            <div style={SECTION_TITLE}>Reviewer role</div>
            <label style={TOGGLE_ROW} data-testid="role-toggle">
              <input
                type="checkbox"
                checked={draft.pr_reviewer_role_enabled}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    pr_reviewer_role_enabled: e.target.checked,
                  })
                }
              />
              <span style={TOGGLE_LABEL}>
                <strong>Enabled</strong>
                <div style={TOGGLE_DESC}>
                  Master switch. When off, no auto-review or auto-merge fires
                  no matter what's set below.
                </div>
              </span>
            </label>

            <label style={TOGGLE_ROW} data-testid="auto-review-toggle">
              <input
                type="checkbox"
                checked={draft.auto_review}
                disabled={inner}
                onChange={(e) =>
                  setDraft({ ...draft, auto_review: e.target.checked })
                }
              />
              <span
                style={{
                  ...TOGGLE_LABEL,
                  opacity: inner ? 0.5 : 1,
                }}
              >
                <strong>Auto-approve trusted authors</strong>
                <div style={TOGGLE_DESC}>
                  PRs from the trust list below get an automatic approval
                  review.
                </div>
              </span>
            </label>

            <label style={TOGGLE_ROW} data-testid="auto-merge-toggle">
              <input
                type="checkbox"
                checked={draft.auto_merge}
                disabled={inner}
                onChange={(e) =>
                  setDraft({ ...draft, auto_merge: e.target.checked })
                }
              />
              <span
                style={{
                  ...TOGGLE_LABEL,
                  opacity: inner ? 0.5 : 1,
                }}
              >
                <strong>Auto-merge after auto-approve</strong>
                <div style={TOGGLE_DESC}>
                  Merge as soon as the auto-approval lands + required checks
                  pass.
                </div>
              </span>
            </label>

            <div style={{ marginTop: 8 }}>
              <div style={SECTION_TITLE}>Merge method</div>
              <div style={RADIO_ROW} data-testid="merge-method-radio">
                {PR_MERGE_METHODS.map((m) => (
                  <label
                    key={m}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      opacity: inner ? 0.5 : 1,
                    }}
                  >
                    <input
                      type="radio"
                      name="merge_method"
                      value={m}
                      checked={draft.merge_method === m}
                      disabled={inner}
                      onChange={() => setDraft({ ...draft, merge_method: m })}
                      data-testid={`merge-method-${m}`}
                    />
                    {m}
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* P-049b — trust list */}
          <div>
            <div style={SECTION_TITLE}>
              Trusted authors ({trustedAuthors.length})
            </div>
            {trustedAuthors.length === 0 ? (
              <div style={{ ...TOGGLE_DESC, padding: '6px 0' }}>
                No trusted authors yet. Trust gets added from each PR row.
              </div>
            ) : (
              <div data-testid="trust-list">
                {trustedAuthors.map((t) => (
                  <div key={t.trusted_github_user_id} style={TRUST_ROW}>
                    <span style={{ flex: 1 }}>
                      <strong>@{t.display_login}</strong>
                      <span style={{ ...TOGGLE_DESC, marginLeft: 6 }}>
                        added {t.trusted_at_label}
                      </span>
                    </span>
                    <button
                      type="button"
                      style={SMALL_LINK}
                      onClick={() => {
                        void onRemoveTrust(t.trusted_github_user_id);
                      }}
                      data-testid={`remove-trust-${t.trusted_github_user_id}`}
                    >
                      remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* P-049c — audit log */}
          <div>
            <div style={SECTION_TITLE}>
              Recent auto-actions ({recentAudit.length})
            </div>
            {recentAudit.length === 0 ? (
              <div style={{ ...TOGGLE_DESC, padding: '6px 0' }}>
                No auto-review or auto-merge actions yet.
              </div>
            ) : (
              <div data-testid="audit-list">
                {recentAudit.map((row) => (
                  <div key={row.id} style={AUDIT_ROW}>
                    <span
                      style={{
                        ...AUDIT_DOT_BASE,
                        background: auditDotColor[row.action],
                      }}
                    />
                    <span>{row.display_text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={FOOTER}>
          <button
            type="button"
            style={SECONDARY_BUTTON}
            onClick={onClose}
            disabled={saving}
            data-testid="pr-reviewer-settings-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            style={PRIMARY_BUTTON}
            onClick={() => {
              void handleSave();
            }}
            disabled={saving}
            data-testid="pr-reviewer-settings-save"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
