// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PullToQueueButton } from '../PullToQueueButton';
import { PullToQueueButtonClient } from '../PullToQueueButtonClient';

afterEach(() => cleanup());

describe('PullToQueueButton — pure UI', () => {
  it('renders "Pull into my queue" when not queued', () => {
    render(<PullToQueueButton queued={false} />);
    expect(screen.getByTestId('pull-to-queue-btn').textContent).toBe('Pull into my queue');
  });

  it('renders "In my queue" when queued', () => {
    render(<PullToQueueButton queued={true} />);
    expect(screen.getByTestId('pull-to-queue-btn').textContent).toBe('In my queue');
  });

  it('sets aria-pressed to match queued state', () => {
    const { rerender } = render(<PullToQueueButton queued={false} />);
    expect(screen.getByTestId('pull-to-queue-btn').getAttribute('aria-pressed')).toBe('false');
    rerender(<PullToQueueButton queued={true} />);
    expect(screen.getByTestId('pull-to-queue-btn').getAttribute('aria-pressed')).toBe('true');
  });

  it('is disabled while pending', () => {
    render(<PullToQueueButton queued={false} pending />);
    expect((screen.getByTestId('pull-to-queue-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('returns null when hidden', () => {
    const { container } = render(<PullToQueueButton queued={true} hidden />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('fires onToggle when clicked', () => {
    const onToggle = vi.fn();
    render(<PullToQueueButton queued={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('pull-to-queue-btn'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('PullToQueueButtonClient — optimistic + POST', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Silence console.warn for failure-path tests.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('renders the initial queued state', () => {
    render(
      <PullToQueueButtonClient
        slug="sheets"
        featureId="F-1"
        githubUserId={42}
        initialQueued={true}
      />,
    );
    expect(screen.getByTestId('pull-to-queue-btn').getAttribute('data-queued')).toBe('1');
  });

  it('optimistic flip + POST enqueue when not queued', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(
      <PullToQueueButtonClient
        slug="sheets"
        featureId="F-7"
        githubUserId={42}
        initialQueued={false}
      />,
    );
    fireEvent.click(screen.getByTestId('pull-to-queue-btn'));
    // optimistic immediate
    expect(screen.getByTestId('pull-to-queue-btn').getAttribute('data-queued')).toBe('1');
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('/api/harness/sheets/feature-queue/F-7/enqueue');
    expect((opts as RequestInit).method).toBe('POST');
    expect((opts as RequestInit).body).toContain('"github_user_id":42');
    // post-resolve still queued
    await waitFor(() =>
      expect(screen.getByTestId('pull-to-queue-btn').getAttribute('data-queued')).toBe('1'),
    );
  });

  it('POSTs dequeue when initially queued', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(
      <PullToQueueButtonClient
        slug="sheets"
        featureId="F-7"
        githubUserId={42}
        initialQueued={true}
      />,
    );
    fireEvent.click(screen.getByTestId('pull-to-queue-btn'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(String(fetchSpy.mock.calls[0][0])).toBe('/api/harness/sheets/feature-queue/F-7/dequeue');
  });

  it('reverts on HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('boom', { status: 500 }),
    );
    render(
      <PullToQueueButtonClient
        slug="sheets"
        featureId="F-7"
        githubUserId={42}
        initialQueued={false}
      />,
    );
    fireEvent.click(screen.getByTestId('pull-to-queue-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('pull-to-queue-btn').getAttribute('data-queued')).toBe('0'),
    );
  });

  it('reverts on substrate-off response (ok:false)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, reason: 'substrate-off' }), { status: 200 }),
    );
    render(
      <PullToQueueButtonClient
        slug="sheets"
        featureId="F-7"
        githubUserId={42}
        initialQueued={false}
      />,
    );
    fireEvent.click(screen.getByTestId('pull-to-queue-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('pull-to-queue-btn').getAttribute('data-queued')).toBe('0'),
    );
  });

  it('reverts on network throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    render(
      <PullToQueueButtonClient
        slug="sheets"
        featureId="F-7"
        githubUserId={42}
        initialQueued={false}
      />,
    );
    fireEvent.click(screen.getByTestId('pull-to-queue-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('pull-to-queue-btn').getAttribute('data-queued')).toBe('0'),
    );
  });

  it('no-op when githubUserId is invalid', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(
      <PullToQueueButtonClient
        slug="sheets"
        featureId="F-7"
        githubUserId={0}
        initialQueued={false}
      />,
    );
    fireEvent.click(screen.getByTestId('pull-to-queue-btn'));
    // give the async handler a tick to (not) fetch
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores re-clicks while pending', async () => {
    let resolveFetch!: (r: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise<Response>((r) => {
        resolveFetch = r;
      }),
    );
    render(
      <PullToQueueButtonClient
        slug="sheets"
        featureId="F-7"
        githubUserId={42}
        initialQueued={false}
      />,
    );
    fireEvent.click(screen.getByTestId('pull-to-queue-btn'));
    fireEvent.click(screen.getByTestId('pull-to-queue-btn'));
    fireEvent.click(screen.getByTestId('pull-to-queue-btn'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    resolveFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });
});
