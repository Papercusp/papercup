// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SetActiveButton } from '../SetActiveButton';
import { SetActiveButtonClient } from '../SetActiveButtonClient';

afterEach(() => cleanup());

describe('SetActiveButton — pure UI', () => {
  it('renders "Start working" when inactive', () => {
    render(<SetActiveButton active={false} />);
    expect(screen.getByTestId('set-active-btn').textContent).toBe('Start working');
  });

  it('renders "Working" when active', () => {
    render(<SetActiveButton active={true} />);
    expect(screen.getByTestId('set-active-btn').textContent).toBe('Working');
  });

  it('renders "Taken" + disabled when taken by another', () => {
    render(<SetActiveButton active={false} takenByOther />);
    const btn = screen.getByTestId('set-active-btn') as HTMLButtonElement;
    expect(btn.textContent).toBe('Taken');
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('data-taken')).toBe('1');
  });

  it('active wins over takenByOther (you are the worker)', () => {
    render(<SetActiveButton active={true} takenByOther />);
    expect(screen.getByTestId('set-active-btn').textContent).toBe('Working');
  });

  it('disabled while pending', () => {
    render(<SetActiveButton active={false} pending />);
    expect((screen.getByTestId('set-active-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('returns null when hidden', () => {
    const { container } = render(<SetActiveButton active hidden />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('fires onToggle on click', () => {
    const onToggle = vi.fn();
    render(<SetActiveButton active={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('set-active-btn'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('SetActiveButtonClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('optimistic flip + POST set-active when inactive', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    render(<SetActiveButtonClient slug="sheets" featureId="F-7" githubUserId={42} initialActive={false} />);
    fireEvent.click(screen.getByTestId('set-active-btn'));
    expect(screen.getByTestId('set-active-btn').getAttribute('data-active')).toBe('1');
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(String(fetchSpy.mock.calls[0][0])).toBe('/api/harness/sheets/working-set/F-7/set-active');
  });

  it('POSTs clear-active when initially active', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    render(<SetActiveButtonClient slug="sheets" featureId="F-7" githubUserId={42} initialActive={true} />);
    fireEvent.click(screen.getByTestId('set-active-btn'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(String(fetchSpy.mock.calls[0][0])).toBe('/api/harness/sheets/working-set/F-7/clear-active');
  });

  it('reverts on HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    render(<SetActiveButtonClient slug="s" featureId="F-7" githubUserId={42} initialActive={false} />);
    fireEvent.click(screen.getByTestId('set-active-btn'));
    await waitFor(() => expect(screen.getByTestId('set-active-btn').getAttribute('data-active')).toBe('0'));
  });

  it('reverts on substrate-off ok:false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, reason: 'substrate-off' }), { status: 200 }),
    );
    render(<SetActiveButtonClient slug="s" featureId="F-7" githubUserId={42} initialActive={false} />);
    fireEvent.click(screen.getByTestId('set-active-btn'));
    await waitFor(() => expect(screen.getByTestId('set-active-btn').getAttribute('data-active')).toBe('0'));
  });

  it('no-op when githubUserId invalid', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<SetActiveButtonClient slug="s" featureId="F-7" githubUserId={0} initialActive={false} />);
    fireEvent.click(screen.getByTestId('set-active-btn'));
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
