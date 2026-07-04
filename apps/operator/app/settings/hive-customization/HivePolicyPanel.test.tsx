// @vitest-environment jsdom
/**
 * HivePolicyPanel.test.tsx — the owner-only Hive policy form. Covers the
 * collapsed/open toggle (?hivePolicy), the claim-authority gate (checking /
 * read-only non-claimant / editable claimant), the policy load (+ load-error
 * toast), and save: the built policy preserves unknown/forward-compat keys and
 * overlays the edited rate + moderation, with success + error toasts.
 *
 * Seams: nuqs via NuqsTestingAdapter, sonner toast, Select stubbed,
 * useHarnessClaimStatus controllable, fetch stubbed per method.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));
vi.mock('../../harness/Select', () => ({
  Select: ({ value, onChange, options, ariaLabel }: {
    value: string; onChange: (v: string) => void; ariaLabel?: string; options: { value: string; label: ReactNode }[];
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o, i) => <option key={o.value || i} value={o.value}>{String(o.label)}</option>)}
    </select>
  ),
}));
let claimState: { data: unknown };
vi.mock('../../adv/harnesses/useHarnessClaimStatus', () => ({ useHarnessClaimStatus: () => claimState }));

// Lexicon resolver echoes its key (t('pot') → 'pot') — isolates the hive→pot
// routed copy from the THE_HIVE flag hook (restore-pot-lexicon-public-release P-007).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import { HivePolicyPanel } from './HivePolicyPanel';

type GetMode = 'ok' | 'fail' | 'pending';
let getMode: GetMode;
let getBody: { ok: boolean; policy: unknown };
let postOk: boolean;
let postBody: unknown;
let calls: Array<{ url: string; method: string; body?: Record<string, unknown> }>;
function stubFetch() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (method === 'POST') return Promise.resolve({ ok: postOk, status: postOk ? 200 : 500, json: async () => postBody } as Response);
    if (getMode === 'pending') return new Promise<Response>(() => {});
    if (getMode === 'fail') return Promise.resolve({ ok: false, status: 500 } as Response);
    return Promise.resolve({ ok: true, status: 200, json: async () => getBody } as Response);
  }));
}

const LOADED = {
  policy: { membership: 'approval', rate: { opsPerMin: 5 }, extraKey: 'keep' },
  policyVersion: 3, ownerPubkey: 'k', updatedAt: 1,
};
const CLAIMANT = { data: { viewer_is_claimant: true, status: 'claimed' } };

function renderPanel(searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}><HivePolicyPanel hive="myhive" /></NuqsTestingAdapter>);
}

beforeEach(() => {
  toastSuccess.mockReset(); toastError.mockReset();
  claimState = { data: null };
  getMode = 'ok'; getBody = { ok: true, policy: LOADED };
  postOk = true; postBody = { ok: true, policy: { ...LOADED, policyVersion: 4 } };
  stubFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('HivePolicyPanel', () => {
  it('starts collapsed — header + Show, no form', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'Show' })).toBeTruthy();
    expect(screen.queryByLabelText('Membership mode')).toBeNull();
  });

  it('shows the checking-authority message while the claim is unresolved', () => {
    claimState = { data: null };
    renderPanel('?hivePolicy=true');
    expect(screen.getByText(/Checking owner authority/i)).toBeTruthy();
  });

  it('shows a read-only message to a non-claimant', () => {
    claimState = { data: { viewer_is_claimant: false, status: 'claimed' } };
    renderPanel('?hivePolicy=true');
    // Copy is routed through the lexicon (echoed key 'pot'), not the hardcoded "Hive".
    expect(screen.getByText(/Only the claimed pot owner can edit policy \(claimed\)/i)).toBeTruthy();
    expect(screen.queryByLabelText('Membership mode')).toBeNull();
  });

  it('renders the editable form for a claimant and hydrates from the loaded policy', async () => {
    claimState = CLAIMANT;
    renderPanel('?hivePolicy=true');
    expect(await screen.findByLabelText('Membership mode')).toBeTruthy();
    expect((screen.getByLabelText('Membership mode') as HTMLSelectElement).value).toBe('approval');
    expect(screen.getByText(/· v3/)).toBeTruthy();
  });

  it('toasts on a failed policy load', async () => {
    claimState = CLAIMANT;
    getMode = 'fail';
    renderPanel('?hivePolicy=true');
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/Couldn't load policy: HTTP 500/)));
  });

  it('saves a built policy that preserves unknown keys and overlays edits', async () => {
    claimState = CLAIMANT;
    renderPanel('?hivePolicy=true');
    await screen.findByLabelText('Membership mode');
    fireEvent.change(screen.getByLabelText(/ops\/min/i), { target: { value: '10' } });
    fireEvent.click(screen.getByLabelText(/members can report/i));
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Saved pot policy \(v4\)/)));
    const post = calls.find((c) => c.method === 'POST')!;
    const policy = (post.body as { policy: Record<string, unknown> }).policy;
    expect(policy.extraKey).toBe('keep');           // forward-compat key preserved
    expect(policy.membership).toBe('approval');
    expect(policy.rate).toEqual({ opsPerMin: 10 });  // edited rate overlaid
    expect((policy.moderation as { reportable: boolean }).reportable).toBe(true);
  });

  it('toasts on a save failure', async () => {
    claimState = CLAIMANT;
    postOk = true; postBody = { ok: false, error: 'denied' };
    renderPanel('?hivePolicy=true');
    await screen.findByLabelText('Membership mode');
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/Couldn't save policy: denied/)));
  });
});
