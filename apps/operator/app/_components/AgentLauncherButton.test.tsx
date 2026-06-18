// @vitest-environment jsdom
//
// AgentLauncherButton — the global "Launch agent" button, sibling to
// ConsoleLauncherButton. Lives in the esbuild-stripped _components tier
// (NOT tsc-checked), so shape bugs (wrong destructure, missing prop) only
// surface under a render+interaction test — same bug class as BackupsTab
// (D-005). We drive: slug derivation from pathname, success/error/throw
// paths, and the OmpInstallHintModal lifecycle (shown on installCmd,
// Retry re-runs attempt, Close dismisses).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  pathname: '/harness/my-slug',
  launchAgent: vi.fn(async (_opts: { slug: string | null }) => ({ ok: true as const })),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/router-compat/navigation', () => ({ usePathname: () => h.pathname }));
vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/app/harness/Modal', () => ({
  Modal: ({
    children,
    open,
    title,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    title?: string;
    onOpenChange?: (open: boolean) => void;
  }) =>
    open ? (
      <div role="dialog" aria-label={title ?? 'modal'} onClick={() => onOpenChange?.(false)}>
        {children}
      </div>
    ) : null,
}));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));
vi.mock('@papercusp/operator-core/lib/launch-agent', () => ({
  launchAgent: (opts: { slug: string | null }) => h.launchAgent(opts),
}));

import { AgentLauncherButton } from './AgentLauncherButton';

beforeEach(() => {
  h.pathname = '/harness/my-slug';
  h.launchAgent.mockReset().mockResolvedValue({ ok: true });
  h.toastSuccess.mockReset();
  h.toastError.mockReset();
});
afterEach(() => cleanup());

describe('AgentLauncherButton', () => {
  it('launches agent in the pathname-derived harness slug + toasts success', async () => {
    render(<AgentLauncherButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch agent' }));
    await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
    expect(h.launchAgent).toHaveBeenCalledWith({ slug: 'my-slug' });
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('derives null slug for a non-harness route (workspace root)', async () => {
    h.pathname = '/admin/testing';
    render(<AgentLauncherButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch agent' }));
    await waitFor(() => expect(h.launchAgent).toHaveBeenCalledWith({ slug: null }));
  });

  it('URL-decodes a percent-encoded harness slug', async () => {
    h.pathname = '/harness/my%20hive';
    render(<AgentLauncherButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch agent' }));
    await waitFor(() => expect(h.launchAgent).toHaveBeenCalledWith({ slug: 'my hive' }));
  });

  it('shows OmpInstallHintModal with the installCmd when launchAgent returns installCmd', async () => {
    h.launchAgent.mockResolvedValueOnce({ ok: false, installCmd: 'npm i -g @papercusp/omp' });
    render(<AgentLauncherButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch agent' }));
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Install OMP' })).toBeTruthy(),
    );
    expect(screen.getByText('npm i -g @papercusp/omp')).toBeTruthy();
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('modal Retry re-runs attempt and dismisses modal on success', async () => {
    h.launchAgent
      .mockResolvedValueOnce({ ok: false, installCmd: 'npm i -g @papercusp/omp' })
      .mockResolvedValueOnce({ ok: true });
    render(<AgentLauncherButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch agent' }));
    await waitFor(() => screen.getByRole('dialog', { name: 'Install OMP' }));
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('modal Close dismisses the OmpInstallHintModal', async () => {
    h.launchAgent.mockResolvedValueOnce({ ok: false, installCmd: 'npm i -g @papercusp/omp' });
    render(<AgentLauncherButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch agent' }));
    await waitFor(() => screen.getByRole('dialog', { name: 'Install OMP' }));
    fireEvent.click(screen.getByText('Close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('toasts error (no modal) when result is not ok and has no installCmd', async () => {
    h.launchAgent.mockResolvedValueOnce({ ok: false, error: 'psu not found' });
    render(<AgentLauncherButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch agent' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(h.toastError.mock.calls[0][0]).toContain('psu not found');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('toasts error and releases busy when launchAgent throws', async () => {
    h.launchAgent.mockRejectedValueOnce(new Error('network timeout'));
    render(<AgentLauncherButton />);
    const btn = screen.getByRole('button', { name: 'Launch agent' });
    fireEvent.click(btn);
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(h.toastError.mock.calls[0][0]).toContain('network timeout');
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  });
});
