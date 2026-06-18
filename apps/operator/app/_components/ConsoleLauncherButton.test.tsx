// @vitest-environment jsdom
//
// ConsoleLauncherButton — the global "+" terminal launcher. Lives in the
// esbuild-stripped app/_components tier (NOT tsc-checked), so a wiring bug here
// (the BackupsTab class of defect) only surfaces under a render+click test. We
// drive the real component: the slug is derived from the pathname, a click calls
// launchNativeConsole with that slug and toasts success, a rejection toasts the
// error, and the click-count badge appears. native-console / toast / router /
// Tooltip are mocked; the component's debug console.* is suppressed (the tier is
// fail-on-console).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  pathname: '/harness/my-slug',
  launchNativeConsole: vi.fn(async (_: { slug: string | null }) => {}),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/router-compat/navigation', () => ({ usePathname: () => h.pathname }));
vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));
vi.mock('@papercusp/operator-core/lib/native-console', () => ({
  launchNativeConsole: (a: { slug: string | null }) => h.launchNativeConsole(a),
  isConsoleLauncherSupported: () => true,
}));

import { ConsoleLauncherButton } from './ConsoleLauncherButton';

let infoSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.pathname = '/harness/my-slug';
  h.launchNativeConsole.mockReset().mockResolvedValue(undefined);
  h.toastSuccess.mockReset();
  h.toastError.mockReset();
  // The component logs debug info on mount + click; the tier is fail-on-console.
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  infoSpy.mockRestore();
  errSpy.mockRestore();
});

describe('ConsoleLauncherButton', () => {
  it('launches the native console in the pathname-derived harness slug + toasts success', async () => {
    render(<ConsoleLauncherButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch terminal' }));
    await waitFor(() => expect(h.launchNativeConsole).toHaveBeenCalledTimes(1));
    expect(h.launchNativeConsole).toHaveBeenCalledWith({ slug: 'my-slug' });
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('derives a null slug (workspace root) outside a /harness/ route', async () => {
    h.pathname = '/admin/testing';
    render(<ConsoleLauncherButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch terminal' }));
    await waitFor(() => expect(h.launchNativeConsole).toHaveBeenCalledWith({ slug: null }));
  });

  it('decodes a URL-encoded slug segment', async () => {
    h.pathname = '/harness/my%20hive';
    render(<ConsoleLauncherButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch terminal' }));
    await waitFor(() => expect(h.launchNativeConsole).toHaveBeenCalledWith({ slug: 'my hive' }));
  });

  it('toasts the error and clears busy when the launch rejects', async () => {
    h.launchNativeConsole.mockRejectedValueOnce(new Error('no tauri bridge'));
    render(<ConsoleLauncherButton />);
    const btn = screen.getByRole('button', { name: 'Launch terminal' });
    fireEvent.click(btn);
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(h.toastError.mock.calls[0][0]).toContain('no tauri bridge');
    // busy is released in finally → button re-enabled
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  });

  it('shows a click-count badge after the first click', async () => {
    render(<ConsoleLauncherButton />);
    expect(screen.queryByText('1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Launch terminal' }));
    await waitFor(() => expect(screen.getByText('1')).toBeTruthy());
  });
});
