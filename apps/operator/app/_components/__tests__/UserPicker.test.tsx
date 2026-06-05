/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import UserPicker from '../UserPicker';

const navigateClient = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('@papercusp/operator-core/lib/client-navigation', () => ({
  navigateClient: (...args: unknown[]) => navigateClient(...args),
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

vi.mock('../../harness/Popover', () => ({
  Popover: ({ trigger, children }: { trigger: React.ReactNode; children: React.ReactNode }) => (
    <div>
      {trigger}
      <div>{children}</div>
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  navigateClient.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ user: { id: 'u1', username: 'avi', display_name: 'Avi', has_password: true }, autoLogin: false }),
      });
    }
    if (url === '/api/auth/logout') {
      return Promise.resolve({ ok: true });
    }
    throw new Error(`unexpected fetch ${url} ${init?.method ?? 'GET'}`);
  }));
});

describe('UserPicker', () => {
  it('soft-navigates account links instead of hard refreshing', async () => {
    render(
      <Tooltip.Provider delayDuration={0}>
        <UserPicker />
      </Tooltip.Provider>,
    );

    await waitFor(() => expect(screen.getByText('User preferences')).toBeTruthy());

    fireEvent.click(screen.getByText('User preferences').closest('a')!);
    fireEvent.click(screen.getByText('Switch user').closest('a')!);
    fireEvent.click(screen.getByText('Add user').closest('a')!);

    expect(navigateClient).toHaveBeenNthCalledWith(1, '/settings/user');
    expect(navigateClient).toHaveBeenNthCalledWith(2, '/login?switch=1');
    expect(navigateClient).toHaveBeenNthCalledWith(3, '/login?mode=signup');
  });

  it('soft-navigates to /login after successful logout', async () => {
    render(
      <Tooltip.Provider delayDuration={0}>
        <UserPicker />
      </Tooltip.Provider>,
    );

    await waitFor(() => expect(screen.getByText('Log out')).toBeTruthy());
    fireEvent.click(screen.getByText('Log out').closest('button')!);

    await waitFor(() => expect(navigateClient).toHaveBeenCalledWith('/login'));
    expect(toastSuccess).toHaveBeenCalledWith('Logged out');
    expect(toastError).not.toHaveBeenCalled();
  });
});
