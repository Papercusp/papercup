// @vitest-environment jsdom
//
// TrustSettingsPage render coverage (shared-hive-trust-admission-2026-06-14 Phase 4 /
// P-011, Trust A4): the owner trust-list control surface. Mounts against a mocked
// `trust.list` (useSyncQuery + useSyncMutate + nuqs + sonner mocked — the pinned
// settings-page pattern) and pins the list render, the empty state, the add-form
// happy path (calls the mutate with action:add + coerced numeric id), and the
// invalid-id guard (toast, no mutate). Guards against render-time crashes the
// build/typecheck can't catch.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

// vi.hoisted — the mocks are referenced by the hoisted vi.mock factories, so they
// must be initialized before those factories run (TDZ otherwise).
const { mutateMock, toastFn } = vi.hoisted(() => ({
  mutateMock: vi.fn(async () => ({ ok: true })),
  toastFn: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
let trustResult: Record<string, unknown> = { data: [], loading: false, error: null };
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => trustResult,
  useSyncMutate: () => mutateMock,
}));
vi.mock('nuqs', () => ({
  useQueryState: () => ['', vi.fn()],
  parseAsString: { withDefault: () => ({}) },
}));
vi.mock('sonner', () => ({ toast: toastFn }));

// Lexicon resolver echoes its key (t('pot') → 'pot') — isolates the routed intro
// copy from the THE_HIVE flag hook (restore-pot-lexicon-public-release P-007).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import TrustSettingsPage from './page';

afterEach(() => {
  cleanup();
  trustResult = { data: [], loading: false, error: null };
  mutateMock.mockClear();
  toastFn.mockClear();
  toastFn.error.mockClear();
  toastFn.success.mockClear();
});

describe('TrustSettingsPage', () => {
  it('renders the trusted-user list (id + note + untrust action)', () => {
    trustResult = {
      data: [{ githubUserId: 583231, note: 'core maintainer', createdTs: 1000 }],
      loading: false,
      error: null,
    };
    render(<TrustSettingsPage />);
    expect(screen.getByText('Trusted users')).toBeTruthy();
    expect(screen.getByText('583231')).toBeTruthy();
    expect(screen.getByText('core maintainer')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Untrust GitHub user 583231/ })).toBeTruthy();
  });

  it('renders the no-users empty state', () => {
    trustResult = { data: [], loading: false, error: null };
    render(<TrustSettingsPage />);
    expect(screen.getByText(/No trusted users yet/)).toBeTruthy();
  });

  it('adds a trusted user through the form → mutate called with action:add + numeric id', async () => {
    render(<TrustSettingsPage />);
    fireEvent.change(screen.getByLabelText('GitHub user id to trust'), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText('Note for this trusted user'), { target: { value: 'bot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trust user' }));
    await waitFor(() => expect(mutateMock).toHaveBeenCalledWith({ action: 'add', githubUserId: 42, note: 'bot' }));
  });

  it('rejects a non-numeric id with a toast, without calling the mutate', () => {
    render(<TrustSettingsPage />);
    fireEvent.change(screen.getByLabelText('GitHub user id to trust'), { target: { value: 'not-a-number' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trust user' }));
    expect(toastFn.error).toHaveBeenCalled();
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('rejects a non-positive id (0 / negative) too', () => {
    render(<TrustSettingsPage />);
    fireEvent.change(screen.getByLabelText('GitHub user id to trust'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trust user' }));
    expect(toastFn.error).toHaveBeenCalled();
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('surfaces an add-mutate rejection via toast.error', async () => {
    mutateMock.mockRejectedValueOnce(new Error('route 500'));
    render(<TrustSettingsPage />);
    fireEvent.change(screen.getByLabelText('GitHub user id to trust'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trust user' }));
    await waitFor(() =>
      expect(toastFn.error).toHaveBeenCalledWith(expect.stringContaining("Couldn't trust 7: route 500")),
    );
  });

  // The Untrust button doesn't write directly — it raises a confirm toast whose
  // `action.onClick` does the remove. That callback is precisely the handler-
  // wiring a render-only test misses (the BackupsTab bug class), so invoke it.
  it('Untrust raises a confirm toast whose action removes the user', async () => {
    trustResult = { data: [{ githubUserId: 99, note: null, createdTs: 1000 }], loading: false, error: null };
    render(<TrustSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Untrust GitHub user 99/ }));

    // The plain toast() (not .error/.success) carries the confirm action.
    const confirmCall = toastFn.mock.calls.find((c) => /Untrust GitHub user 99\?/.test(String(c[0])));
    expect(confirmCall).toBeTruthy();
    const action = (confirmCall![1] as { action: { label: string; onClick: () => void } }).action;
    expect(action.label).toBe('Untrust');

    // Nothing removed until the action fires.
    expect(mutateMock).not.toHaveBeenCalled();
    action.onClick();
    await waitFor(() => expect(mutateMock).toHaveBeenCalledWith({ action: 'remove', githubUserId: 99 }));
    await waitFor(() => expect(toastFn.success).toHaveBeenCalledWith('Untrusted 99.'));
  });

  it('renders the load-error alert when the sync query errors', () => {
    trustResult = { data: [], loading: false, error: new Error('sync down') };
    render(<TrustSettingsPage />);
    expect(screen.getByRole('alert').textContent).toContain('sync down');
  });
});
