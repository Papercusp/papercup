// @vitest-environment jsdom
/**
 * PrReviewerSettings.test.tsx — the PR-reviewer settings modal + its pure
 * helpers. Thoroughly covers toggleToPayload, auditActionLabel, auditActionTone,
 * and formatAuditDetail (the agent-review JSON formatter + fallbacks), then the
 * component: loading/error, the editable render (toggles, trust list, audit),
 * the read-only banner, a toggle flip mutate, and a trust removal.
 *
 * Seams: @papercusp/sync (useSyncQuery/useSyncMutate — WI-4138 / P-011,
 * all-active-surfaces-data-sync-migration-2026-07-11) + sonner toast + Modal/
 * Select are module-mocked, the pinned settings-page pattern (see
 * app/settings/trust/page.test.tsx). useSyncMutate returns one shared mock
 * regardless of the path arg ('prReviewerSettings.set' vs
 * '…trustRemove') — assertions differentiate by the args shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));
vi.mock('./Modal', () => ({ Modal: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div data-testid="modal">{children}</div> : null) }));
vi.mock('./Select', () => ({
  Select: ({ value, onChange, options, ariaLabel, disabled }: {
    value: string; onChange: (v: string) => void; ariaLabel?: string; disabled?: boolean; options: { value: string; label: string }[];
  }) => (
    <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

// Lexicon resolver echoes its key (t('pot') → 'pot') — isolates the routed
// ownership-hint copy from the THE_HIVE flag hook (restore-pot-lexicon-public-release P-007).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

const syncMock = vi.hoisted(() => ({
  result: { data: undefined as unknown, loading: true, error: null as Error | null },
  mutate: vi.fn(async (_args: unknown) => ({ ok: true })),
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => syncMock.result,
  useSyncMutate: () => syncMock.mutate,
}));

import {
  PrReviewerSettings, toggleToPayload, auditActionLabel, auditActionTone, formatAuditDetail,
} from './PrReviewerSettings';

describe('toggleToPayload', () => {
  it('wraps the single changed key', () => {
    expect(toggleToPayload('auto_review', true)).toEqual({ auto_review: true });
    expect(toggleToPayload('merge_method', 'rebase')).toEqual({ merge_method: 'rebase' });
  });
});

describe('auditActionLabel', () => {
  it('labels each known action, raw for unknown', () => {
    expect(auditActionLabel('auto_approve')).toBe('Auto-approved');
    expect(auditActionLabel('auto_merge')).toBe('Auto-merged');
    expect(auditActionLabel('manual_approve')).toBe('Approved');
    expect(auditActionLabel('manual_merge')).toBe('Merged');
    expect(auditActionLabel('agent_review')).toBe('Agent reviewed');
    expect(auditActionLabel('agent_review_error')).toBe('Agent review failed');
    expect(auditActionLabel('skipped_untrusted')).toBe('Skipped (untrusted author)');
    expect(auditActionLabel('skipped_revoked')).toBe('Refused (revoked contributor)');
    expect(auditActionLabel('skipped_checks_failing')).toBe('Skipped (checks failing)');
    expect(auditActionLabel('error')).toBe('Error');
    expect(auditActionLabel('weird')).toBe('weird');
  });
});

describe('auditActionTone', () => {
  it('buckets actions into ok/bad/muted/warn', () => {
    expect(auditActionTone('auto_approve')).toBe('ok');
    expect(auditActionTone('manual_merge')).toBe('ok');
    expect(auditActionTone('agent_review')).toBe('ok');
    expect(auditActionTone('error')).toBe('bad');
    expect(auditActionTone('agent_review_error')).toBe('bad');
    expect(auditActionTone('skipped_untrusted')).toBe('muted');
    expect(auditActionTone('something_else')).toBe('warn');
  });
});

describe('formatAuditDetail', () => {
  it('returns empty for no detail', () => {
    expect(formatAuditDetail('agent_review', null)).toBe('');
  });
  it('passes non-agent actions through raw', () => {
    expect(formatAuditDetail('manual_merge', 'just text')).toBe('just text');
  });
  it('formats an agent_review JSON blob', () => {
    const detail = JSON.stringify({ recommendation: 'approve', model: 'claude', head_sha: 'abc1234ef', feature_id: 'F-1', risks: 2 });
    expect(formatAuditDetail('agent_review', detail)).toBe('approve · model claude · @abc1234 · F-1 · 2 risks');
  });
  it('singularizes a single risk and formats agent errors', () => {
    expect(formatAuditDetail('agent_review', JSON.stringify({ recommendation: 'reject', risks: 1 }))).toBe('reject · 1 risk');
    expect(formatAuditDetail('agent_review_error', JSON.stringify({ error: 'boom' }))).toBe('error: boom');
  });
  it('falls back to the raw string on bad JSON / non-object / empty parts', () => {
    expect(formatAuditDetail('agent_review', 'notjson')).toBe('notjson');
    expect(formatAuditDetail('agent_review', '"astring"')).toBe('"astring"');
    expect(formatAuditDetail('agent_review', '{}')).toBe('{}');
  });
});

const RESP = {
  settings: { pr_reviewer_role_enabled: true, auto_review: false, auto_merge: false, merge_method: 'squash' },
  trustList: [{ trusted_github_user_id: 42, trusted_login: 'ada', trusted_at: '2026-01-01' }],
  audit: [{ id: 1, pr_number: 7, pr_url: 'https://x', author_github_id: null, action: 'auto_merge', detail: null, ts: '2026-01-01T00:00:00Z' }],
  viewer: { github_user_id: 1, github_login: 'me' },
  editable: true,
  autoModeEditable: true,
};

describe('PrReviewerSettings component', () => {
  function renderModal() { return render(<PrReviewerSettings harnessSlug="proj" open onOpenChange={() => {}} />); }
  beforeEach(() => {
    toastSuccess.mockReset();
    toastError.mockReset();
    syncMock.mutate.mockReset().mockResolvedValue({ ok: true });
    syncMock.result = { data: [RESP], loading: false, error: null };
  });
  afterEach(() => { cleanup(); });

  it('shows the loading state', () => {
    syncMock.result = { data: undefined, loading: true, error: null };
    renderModal();
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('shows the error state on a failed load', async () => {
    syncMock.result = { data: undefined, loading: false, error: new Error('HTTP 500') };
    renderModal();
    expect(await screen.findByText(/HTTP 500/)).toBeTruthy();
  });

  it('renders toggles, trust list and audit for an editable viewer', async () => {
    renderModal();
    expect(await screen.findByRole('switch', { name: 'Enable PR-reviewer role' })).toBeTruthy();
    expect((screen.getByRole('switch', { name: 'Enable PR-reviewer role' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('@ada')).toBeTruthy();
    expect(screen.getByText('Auto-merged')).toBeTruthy();
    expect(screen.getByText('@me')).toBeTruthy();
  });

  it('shows the read-only banner and disables toggles for a non-editable viewer', async () => {
    syncMock.result = { data: [{ ...RESP, editable: false }], loading: false, error: null };
    renderModal();
    expect(await screen.findByText(/Sign in with GitHub/)).toBeTruthy();
    expect((screen.getByRole('switch', { name: 'Enable PR-reviewer role' }) as HTMLInputElement).disabled).toBe(true);
  });

  it('mutates the flipped toggle value', async () => {
    renderModal();
    const sw = await screen.findByRole('switch', { name: 'Enable PR-reviewer role' });
    fireEvent.click(sw); // true → false
    await waitFor(() => expect(syncMock.mutate).toHaveBeenCalledWith({ pr_reviewer_role_enabled: false }));
  });

  it('removes a trusted author with a confirmation toast', async () => {
    renderModal();
    await screen.findByText('@ada');
    fireEvent.click(screen.getByRole('button', { name: /Remove @ada from trust list/ }));
    await waitFor(() => expect(syncMock.mutate).toHaveBeenCalledWith(42));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });
});
