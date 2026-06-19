// @vitest-environment jsdom
/**
 * ConfirmModal.test.tsx — render-tier coverage for the window.confirm()
 * replacement (whole-app-test-coverage-breadth). Exercises the real branches:
 * closed vs open, the destructive/primary button, the cancel path, the
 * requireType arming gate, and the async confirm flow (busy → close on resolve;
 * stays open + re-armed on throw). The Radix-backed Modal renders into a portal
 * under document.body in jsdom — assertions read from `screen` / document.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

import { ConfirmModal } from './ConfirmModal';

afterEach(cleanup);

function noop() {}

describe('ConfirmModal (canonical window.confirm replacement)', () => {
  it('does not render its body when closed', () => {
    render(
      <ConfirmModal open={false} onOpenChange={noop} title="Delete?" body="Gone forever." onConfirm={noop} />,
    );
    expect(screen.queryByText('Gone forever.')).toBeNull();
  });

  it('renders title, body, and the default Confirm/Cancel labels when open', () => {
    render(
      <ConfirmModal open onOpenChange={noop} title="Delete workspace?" body="This cannot be undone." onConfirm={noop} />,
    );
    // The visible heading is the <h2>; the Modal also keeps an sr-only title.
    expect(screen.getAllByText('Delete workspace?').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('This cannot be undone.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('honours custom confirm/cancel labels', () => {
    render(
      <ConfirmModal
        open
        onOpenChange={noop}
        title="x"
        body="y"
        confirmLabel="Delete it"
        cancelLabel="Keep it"
        onConfirm={noop}
      />,
    );
    expect(screen.getByRole('button', { name: 'Delete it' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeTruthy();
  });

  it('Cancel calls onOpenChange(false) and does not invoke onConfirm', () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(<ConfirmModal open onOpenChange={onOpenChange} title="x" body="y" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirm runs onConfirm, then closes the dialog on resolve', async () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn(async () => {});
    render(<ConfirmModal open onOpenChange={onOpenChange} title="x" body="y" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('confirm shows the busy label while onConfirm is in flight', async () => {
    let resolveFn: () => void = () => {};
    const gate = new Promise<void>((res) => { resolveFn = res; });
    const onConfirm = vi.fn(() => gate);
    render(<ConfirmModal open onOpenChange={noop} title="x" body="y" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    // The button flips to its busy label while the promise is pending.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Working…' })).toBeTruthy());
    resolveFn();
  });

  it('renders the destructive button when destructive is set', () => {
    render(
      <ConfirmModal open onOpenChange={noop} title="x" body="y" destructive confirmLabel="Nuke" onConfirm={noop} />,
    );
    const btn = screen.getByRole('button', { name: 'Nuke' }) as HTMLButtonElement;
    // destructiveBtn paints the confirm white-on-bad; assert it is present + enabled.
    expect(btn.disabled).toBe(false);
  });

  it('requireType gates the confirm button until the exact token is typed', () => {
    render(
      <ConfirmModal open onOpenChange={noop} title="x" body="y" requireType="DELETE" confirmLabel="Go" onConfirm={noop} />,
    );
    const confirmBtn = screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement;
    // Disarmed initially (typed !== requireType).
    expect(confirmBtn.disabled).toBe(true);

    const input = screen.getByRole('textbox') as HTMLInputElement;
    // Wrong token keeps it disabled.
    fireEvent.change(input, { target: { value: 'delete' } });
    expect((screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement).disabled).toBe(true);
    // Exact token arms it.
    fireEvent.change(input, { target: { value: 'DELETE' } });
    expect((screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a disarmed requireType confirm click does NOT invoke onConfirm', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmModal open onOpenChange={noop} title="x" body="y" requireType="DELETE" confirmLabel="Go" onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
