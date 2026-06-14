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
});
