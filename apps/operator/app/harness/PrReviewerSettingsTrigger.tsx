'use client';

/**
 * PrReviewerSettingsTrigger — Phase 8 P-049 wiring helper.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 §9.4 — gear icon in PRs tab.
 *
 * Composes the gear-icon button + open-state + lazy data loader for the
 * `PrReviewerSettings` modal so the PRs tab consumer doesn't have to
 * juggle state itself. Modal-open state stays local to this component
 * (modal-scoped useState exception per AGENTS.md "almost all state in
 * nuqs" rule — modal-internal lifecycle is exempt).
 *
 * Data is loaded via the `loadInitial` async prop, which the consumer
 * implements (PG read in the route handler / fetch). Called when the
 * modal opens, not on mount, to keep cold-render cheap.
 *
 * onSave + onRemoveTrust pass through to the modal unchanged.
 */

import { useCallback, useState, type CSSProperties, type ReactNode } from 'react';
import { Settings } from 'lucide-react';
import {
  PrReviewerSettings,
  type AutoReviewAuditRow,
  type PrReviewerSettingsValues,
  type TrustedAuthorRow,
} from './PrReviewerSettings';

export interface PrReviewerSettingsTriggerData {
  values: PrReviewerSettingsValues;
  trustedAuthors: TrustedAuthorRow[];
  recentAudit: AutoReviewAuditRow[];
}

export interface PrReviewerSettingsTriggerProps {
  /** Called when the user clicks the gear; returns initial modal data. */
  loadInitial: () => Promise<PrReviewerSettingsTriggerData>;
  onSave: (next: PrReviewerSettingsValues) => Promise<void>;
  onRemoveTrust: (trusted_github_user_id: number) => Promise<void>;
  /** Optional label that replaces the icon-only render. */
  label?: string;
}

const GEAR_BUTTON: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  background: 'transparent',
  border: '1px solid var(--border, #2a2a2a)',
  borderRadius: 6,
  padding: '6px 10px',
  color: 'var(--fg, #ddd)',
  cursor: 'pointer',
  fontSize: 13,
};

const GEAR_BUTTON_LOADING: CSSProperties = {
  ...GEAR_BUTTON,
  opacity: 0.6,
  cursor: 'wait',
};

export function PrReviewerSettingsTrigger(
  props: PrReviewerSettingsTriggerProps,
): ReactNode {
  const { loadInitial, onSave, onRemoveTrust, label } = props;

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<PrReviewerSettingsTriggerData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const handleOpen = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await loadInitial();
      setData(next);
      setOpen(true);
    } catch (e) {
      setLoadError((e as Error)?.message ?? 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, [loadInitial]);

  return (
    <>
      <button
        type="button"
        style={loading ? GEAR_BUTTON_LOADING : GEAR_BUTTON}
        disabled={loading}
        onClick={() => {
          void handleOpen();
        }}
        title="PR-reviewer settings"
        aria-label="PR-reviewer settings"
        data-testid="pr-reviewer-settings-trigger"
      >
        <Settings size={14} />
        {label ? <span>{label}</span> : null}
      </button>
      {loadError ? (
        <div
          role="alert"
          style={{
            marginTop: 6,
            fontSize: 12,
            color: 'var(--fg-warning, #FF9800)',
          }}
          data-testid="pr-reviewer-settings-load-error"
        >
          {loadError}
        </div>
      ) : null}
      {data ? (
        <PrReviewerSettings
          open={open}
          onClose={() => setOpen(false)}
          initialValues={data.values}
          trustedAuthors={data.trustedAuthors}
          recentAudit={data.recentAudit}
          onSave={onSave}
          onRemoveTrust={onRemoveTrust}
        />
      ) : null}
    </>
  );
}
