'use client';

/**
 * PrReviewerSettings — PR-reviewer settings modal (Phase 8 P-049).
 *
 * P-049a: per-harness toggles — pr_reviewer_role_enabled (master kill-switch),
 *         auto_review, auto_merge, merge_method (squash/merge/rebase).
 * P-049b: trust list view + inline remove.
 * P-049c: recent auto-review/auto-merge audit log from LOCAL auto_review_audit.
 *
 * Reads/writes `GET|POST /api/harness/:slug/pr-reviewer-settings`. Settings +
 * trust list are per-viewer (server-resolved gh identity); the response's
 * `editable` flag gates the controls — anonymous (no gh auth) renders
 * read-only. Toggle VALUES are server state (useState here, not URL); the
 * modal-OPEN flag lives in nuqs in the parent (PrsTab) per repo convention.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ShieldCheck, Trash2, ScrollText, GitMerge } from 'lucide-react';
import { Modal } from './Modal';
import { Select } from './Select';
import type { PrMergeMethod } from '@papercusp/operator-core/lib/pr-host/types';

// ─── Wire shapes (mirror routes/harness/pr-reviewer-settings.ts) ──

export interface SettingsToggles {
  pr_reviewer_role_enabled: boolean;
  auto_review: boolean;
  auto_merge: boolean;
  merge_method: PrMergeMethod;
}
export interface TrustListEntry {
  trusted_github_user_id: number;
  trusted_login: string | null;
  trusted_at: string;
}
export interface AuditEntry {
  id: number;
  pr_number: number;
  pr_url: string | null;
  author_github_id: number | null;
  action: string;
  detail: string | null;
  ts: string;
}
export interface PrReviewerSettingsResponse {
  settings: SettingsToggles;
  trustList: TrustListEntry[];
  audit: AuditEntry[];
  viewer: { github_user_id: number; github_login: string } | null;
  editable: boolean;
  /** PR-3 §3: viewer is the claimed owner (may flip auto-mode). */
  claimOwner?: boolean;
  /** PR-3 §3: may the viewer flip auto_review/auto_merge (= editable && claimOwner)? */
  autoModeEditable?: boolean;
  /** P-007 (D-002): hive HOME slug the role bit was inherited from, when this
   *  harness has no explicit row. Provenance display only. */
  inheritedFrom?: string | null;
  /** P-008 (D-003): the role was conferred by hive OWNERSHIP (this install
   *  created the hive). Provenance display only. */
  grantedByOwnership?: boolean;
}

// ─── Pure helpers (unit-tested) ───────────────────────────────────

export const MERGE_METHOD_OPTIONS: ReadonlyArray<{ value: PrMergeMethod; label: string }> = [
  { value: 'squash', label: 'Squash and merge' },
  { value: 'merge', label: 'Create a merge commit' },
  { value: 'rebase', label: 'Rebase and merge' },
];

/** Build the POST body for a single toggle flip. Pure — unit-tested. */
export function toggleToPayload(
  key: keyof SettingsToggles,
  value: SettingsToggles[keyof SettingsToggles],
): Partial<SettingsToggles> {
  return { [key]: value } as Partial<SettingsToggles>;
}

/** A short human label for an audit action. Pure — unit-tested. */
export function auditActionLabel(action: string): string {
  switch (action) {
    case 'auto_approve':
      return 'Auto-approved';
    case 'auto_merge':
      return 'Auto-merged';
    case 'manual_approve':
      return 'Approved';
    case 'manual_merge':
      return 'Merged';
    case 'skipped_untrusted':
      return 'Skipped (untrusted author)';
    case 'skipped_checks_failing':
      return 'Skipped (checks failing)';
    case 'error':
      return 'Error';
    default:
      return action;
  }
}

/** Tone bucket for an audit action — drives the row tint. Pure — unit-tested. */
export function auditActionTone(action: string): 'ok' | 'warn' | 'bad' | 'muted' {
  if (action === 'auto_approve' || action === 'auto_merge' || action === 'manual_approve' || action === 'manual_merge') {
    return 'ok';
  }
  if (action === 'error') return 'bad';
  if (action.startsWith('skipped')) return 'muted';
  return 'warn';
}

// ─── Network ──────────────────────────────────────────────────────

async function fetchSettings(slug: string): Promise<PrReviewerSettingsResponse> {
  const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/pr-reviewer-settings`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<PrReviewerSettingsResponse>;
}

async function postSettings(slug: string, patch: Partial<SettingsToggles>): Promise<SettingsToggles> {
  const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/pr-reviewer-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = (await r.json().catch(() => ({}))) as { settings?: SettingsToggles; error?: string };
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body.settings!;
}

async function removeTrust(slug: string, trustedId: number): Promise<void> {
  const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/pr-reviewer-settings/trust/remove`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trusted_github_user_id: trustedId }),
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
}

// ─── Component ────────────────────────────────────────────────────

interface Props {
  harnessSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PrReviewerSettings({ harnessSlug, open, onOpenChange }: Props) {
  const [data, setData] = useState<PrReviewerSettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchSettings(harnessSlug));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [harnessSlug]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const editable = !!data?.editable;
  const settings = data?.settings;

  // The auto_* toggles are meaningless while the master kill-switch is off.
  const subTogglesDisabled = !editable || !settings?.pr_reviewer_role_enabled;
  // PR-3 §3: auto-mode (auto_review/auto_merge) is owner-gated — read-only for
  // a non-claimed-owner even when gh-authed (the server enforces the same gate).
  const autoModeEditable = data?.autoModeEditable ?? false;
  const autoTogglesDisabled = subTogglesDisabled || !autoModeEditable;

  const flip = useCallback(
    async (key: keyof SettingsToggles, value: SettingsToggles[keyof SettingsToggles]) => {
      if (!data || !editable) return;
      const prev = data.settings;
      // Optimistic patch.
      setData({ ...data, settings: { ...prev, ...toggleToPayload(key, value) } });
      setSaving(true);
      try {
        const next = await postSettings(harnessSlug, toggleToPayload(key, value));
        setData((d) => (d ? { ...d, settings: next } : d));
      } catch (e) {
        // Roll back.
        setData((d) => (d ? { ...d, settings: prev } : d));
        toast.error(`Couldn't save setting: ${String(e)}`);
      } finally {
        setSaving(false);
      }
    },
    [data, editable, harnessSlug],
  );

  const onRemoveTrust = useCallback(
    async (entry: TrustListEntry) => {
      if (!data || !editable) return;
      const prev = data.trustList;
      // Optimistic remove.
      setData({ ...data, trustList: prev.filter((t) => t.trusted_github_user_id !== entry.trusted_github_user_id) });
      try {
        await removeTrust(harnessSlug, entry.trusted_github_user_id);
        toast.success(`Removed @${entry.trusted_login ?? entry.trusted_github_user_id} from trust list`);
      } catch (e) {
        setData((d) => (d ? { ...d, trustList: prev } : d));
        toast.error(`Couldn't remove from trust list: ${String(e)}`);
      }
    },
    [data, editable, harnessSlug],
  );

  const trustList = data?.trustList ?? [];
  const audit = data?.audit ?? [];

  const viewerLabel = useMemo(
    () => (data?.viewer ? `@${data.viewer.github_login}` : null),
    [data?.viewer],
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="PR-reviewer settings"
      contentStyle={{ width: 'min(560px, 92vw)', maxHeight: '82vh' }}
    >
      <div className="pc-prrs">
        <header className="pc-prrs__head">
          <span className="pc-prrs__head-title">
            <ShieldCheck size={16} aria-hidden /> PR-reviewer settings
          </span>
          {viewerLabel && <span className="pc-prrs__viewer">{viewerLabel}</span>}
        </header>

        {loading ? (
          <div className="pc-prrs__msg">Loading…</div>
        ) : error ? (
          <div className="pc-prrs__msg pc-prrs__msg--err">{error}</div>
        ) : (
          <div className="pc-prrs__body">
            {!editable && (
              <div className="pc-prrs__banner">
                Sign in with GitHub (<code>gh auth login</code>) to change these settings. Showing read-only.
              </div>
            )}

            {/* ── P-049a: toggles ─────────────────────────────── */}
            <section className="pc-prrs__sect">
              <Toggle
                label="Enable PR-reviewer role"
                hint={
                  data?.grantedByOwnership
                    ? `Granted by hive ownership${data.inheritedFrom ? ` (home '${data.inheritedFrom}')` : ''} — you created this hive, so you review its PRs. Flipping it here writes an explicit per-harness setting.`
                    : data?.inheritedFrom
                      ? `Inherited from hive home '${data.inheritedFrom}' — flipping it here writes an explicit setting for this harness.`
                      : 'Master switch. When off, no auto-review or auto-merge fires.'
                }
                checked={!!settings?.pr_reviewer_role_enabled}
                disabled={!editable || saving}
                onChange={(v) => void flip('pr_reviewer_role_enabled', v)}
              />
              <Toggle
                label="Auto-approve trusted PRs"
                hint={
                  autoModeEditable
                    ? 'Approve PRs whose author is in your trust list.'
                    : 'Owner-only: claim this harness to change auto-mode.'
                }
                checked={!!settings?.auto_review}
                disabled={autoTogglesDisabled || saving}
                onChange={(v) => void flip('auto_review', v)}
              />
              <Toggle
                label="Auto-merge approved PRs"
                hint={
                  autoModeEditable
                    ? 'Merge PRs auto-approve fired on, once checks are green.'
                    : 'Owner-only: claim this harness to change auto-mode.'
                }
                checked={!!settings?.auto_merge}
                disabled={autoTogglesDisabled || saving}
                onChange={(v) => void flip('auto_merge', v)}
              />
              <label className="pc-prrs__field">
                <span className="pc-prrs__field-label">
                  <GitMerge size={13} aria-hidden /> Merge method
                </span>
                <Select
                  triggerClassName="pc-prrs__select"
                  value={settings?.merge_method ?? 'squash'}
                  disabled={!editable || saving}
                  onChange={(value) => void flip('merge_method', value as PrMergeMethod)}
                  ariaLabel="Merge method"
                  options={MERGE_METHOD_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                />
              </label>
            </section>

            {/* ── P-049b: trust list ──────────────────────────── */}
            <section className="pc-prrs__sect">
              <h3 className="pc-prrs__sect-title">
                <ShieldCheck size={13} aria-hidden /> Trusted authors
                <span className="pc-prrs__count">{trustList.length}</span>
              </h3>
              {trustList.length === 0 ? (
                <p className="pc-prrs__empty">
                  No trusted authors yet. Add authors from a PR row to auto-approve their PRs.
                </p>
              ) : (
                <ul className="pc-prrs__trust">
                  {trustList.map((t) => (
                    <li key={t.trusted_github_user_id} className="pc-prrs__trust-row">
                      <span className="pc-prrs__trust-name">
                        @{t.trusted_login ?? t.trusted_github_user_id}
                      </span>
                      <span className="pc-prrs__trust-date">
                        {new Date(t.trusted_at).toLocaleDateString()}
                      </span>
                      {editable && (
                        <button
                          type="button"
                          className="pc-prrs__trust-remove"
                          aria-label={`Remove @${t.trusted_login ?? t.trusted_github_user_id} from trust list`}
                          onClick={() => void onRemoveTrust(t)}
                        >
                          <Trash2 size={13} aria-hidden />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ── P-049c: audit log ───────────────────────────── */}
            <section className="pc-prrs__sect">
              <h3 className="pc-prrs__sect-title">
                <ScrollText size={13} aria-hidden /> Recent activity
                <span className="pc-prrs__count">{audit.length}</span>
              </h3>
              {audit.length === 0 ? (
                <p className="pc-prrs__empty">No auto-review or auto-merge actions yet.</p>
              ) : (
                <ul className="pc-prrs__audit">
                  {audit.map((a) => (
                    <li key={a.id} className={`pc-prrs__audit-row pc-prrs__audit-row--${auditActionTone(a.action)}`}>
                      <span className="pc-prrs__audit-action">{auditActionLabel(a.action)}</span>
                      {a.pr_url ? (
                        <a className="pc-prrs__audit-pr" href={a.pr_url} target="_blank" rel="noreferrer">
                          PR #{a.pr_number}
                        </a>
                      ) : (
                        <span className="pc-prrs__audit-pr">PR #{a.pr_number}</span>
                      )}
                      {a.detail && <span className="pc-prrs__audit-detail">{a.detail}</span>}
                      <span className="pc-prrs__audit-ts">{new Date(a.ts).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>

      <style>{`
        .pc-prrs {
          display: flex; flex-direction: column; min-height: 0; max-height: 82vh;
          background: var(--bg-1, #0b1220); color: var(--fg, #e7f7ff);
          border: 1px solid var(--border, rgba(125,211,252,0.2)); border-radius: 12px;
          box-shadow: 0 16px 48px rgba(0,0,0,0.5); overflow: hidden;
        }
        .pc-prrs__head {
          display: flex; align-items: center; justify-content: space-between; gap: 10px;
          padding: 12px 16px; border-bottom: 1px solid var(--border, rgba(125,211,252,0.15)); flex-shrink: 0;
        }
        .pc-prrs__head-title { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 700; }
        .pc-prrs__head-title svg { color: var(--accent, #38bdf8); }
        .pc-prrs__viewer { font-size: 12px; color: var(--fg-mute, #7f9bb4); }
        .pc-prrs__body { overflow: auto; padding: 14px 16px; display: grid; gap: 18px; }
        .pc-prrs__msg { padding: 28px; text-align: center; color: var(--fg-mute, #7f9bb4); font-size: 13px; }
        .pc-prrs__msg--err { color: var(--bad, #f87171); }
        .pc-prrs__banner {
          font-size: 12px; padding: 8px 10px; border-radius: 8px;
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 86%);
          border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 70%);
        }
        .pc-prrs__banner code { font-family: ui-monospace, monospace; }
        .pc-prrs__sect { display: grid; gap: 10px; }
        .pc-prrs__sect-title {
          display: inline-flex; align-items: center; gap: 6px; margin: 0;
          font-size: 12px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase;
          color: var(--fg-mute, #7f9bb4);
        }
        .pc-prrs__sect-title svg { color: var(--accent, #38bdf8); }
        .pc-prrs__count {
          font-size: 10px; padding: 1px 7px; border-radius: 999px;
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 82%); color: var(--fg, #e7f7ff);
        }
        .pc-prrs__toggle { display: flex; align-items: flex-start; gap: 10px; }
        .pc-prrs__toggle-text { display: grid; gap: 1px; }
        .pc-prrs__toggle-label { font-size: 13px; font-weight: 600; }
        .pc-prrs__toggle-hint { font-size: 11px; color: var(--fg-mute, #7f9bb4); }
        .pc-prrs__switch {
          appearance: none; width: 36px; height: 20px; border-radius: 999px; flex-shrink: 0;
          background: var(--bg-3, #1e293b); border: 1px solid var(--border, rgba(125,211,252,0.25));
          position: relative; cursor: pointer; transition: background-color 140ms ease; margin-top: 1px;
        }
        .pc-prrs__switch::after {
          content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
          border-radius: 50%; background: var(--fg, #e7f7ff); transition: transform 140ms ease;
        }
        .pc-prrs__switch:checked { background: var(--accent, #38bdf8); border-color: var(--accent, #38bdf8); }
        .pc-prrs__switch:checked::after { transform: translateX(16px); }
        .pc-prrs__switch:disabled { opacity: 0.45; cursor: not-allowed; }
        .pc-prrs__field { display: grid; gap: 5px; }
        .pc-prrs__field-label { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
        .pc-prrs__field-label svg { color: var(--accent, #38bdf8); }
        .pc-prrs__select {
          font-size: 13px; padding: 6px 8px; border-radius: 8px; max-width: 280px;
          background: var(--bg-2, #111c30); color: var(--fg, #e7f7ff);
          border: 1px solid var(--border, rgba(125,211,252,0.25));
        }
        .pc-prrs__select:disabled { opacity: 0.55; cursor: not-allowed; }
        .pc-prrs__empty { font-size: 12px; color: var(--fg-mute, #7f9bb4); margin: 0; }
        .pc-prrs__trust { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
        .pc-prrs__trust-row {
          display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px;
          background: var(--bg-2, #111c30);
        }
        .pc-prrs__trust-name { font-size: 13px; font-weight: 600; }
        .pc-prrs__trust-date { font-size: 11px; color: var(--fg-mute, #7f9bb4); margin-left: auto; }
        .pc-prrs__trust-remove {
          display: inline-flex; padding: 4px; border: 0; border-radius: 6px; cursor: pointer;
          background: transparent; color: var(--fg-mute, #7f9bb4);
        }
        .pc-prrs__trust-remove:hover { color: var(--bad, #f87171); background: color-mix(in oklab, var(--bad, #f87171), transparent 86%); }
        .pc-prrs__audit { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
        .pc-prrs__audit-row {
          display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
          padding: 5px 8px; border-radius: 6px; font-size: 12px; background: var(--bg-2, #111c30);
          border-left: 2px solid transparent;
        }
        .pc-prrs__audit-row--ok { border-left-color: var(--good, #22c55e); }
        .pc-prrs__audit-row--bad { border-left-color: var(--bad, #f87171); }
        .pc-prrs__audit-row--warn { border-left-color: var(--warn, #f59e0b); }
        .pc-prrs__audit-row--muted { border-left-color: var(--fg-mute, #7f9bb4); opacity: 0.75; }
        .pc-prrs__audit-action { font-weight: 600; }
        .pc-prrs__audit-pr { color: var(--accent, #38bdf8); text-decoration: none; }
        .pc-prrs__audit-pr:hover { text-decoration: underline; }
        .pc-prrs__audit-detail { color: var(--fg-mute, #7f9bb4); }
        .pc-prrs__audit-ts { margin-left: auto; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
      `}</style>
    </Modal>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="pc-prrs__toggle">
      <input
        type="checkbox"
        role="switch"
        className="pc-prrs__switch"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="pc-prrs__toggle-text">
        <span className="pc-prrs__toggle-label">{label}</span>
        <span className="pc-prrs__toggle-hint">{hint}</span>
      </span>
    </div>
  );
}

export default PrReviewerSettings;
