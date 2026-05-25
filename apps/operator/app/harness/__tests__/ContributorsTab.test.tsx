/**
 * @vitest-environment jsdom
 *
 * ContributorsTab — P-048 assembly tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { ContributorsTab } from '../ContributorsTab';

const SAMPLE = [
  {
    github_user_id: 1,
    github_username: 'alice',
    display_name: 'Alice',
    avatar_url: null,
    joined_at: Date.parse('2026-05-01T00:00:00Z'),
    last_seen_at: null,
    binding_status: 'verified',
    binding_last_checked_at: null,
    device_count: 1,
    prs_merged: 10,
    features_shipped: 2,
    activity_events: 30,
  },
  {
    github_user_id: 2,
    github_username: 'bob',
    display_name: null,
    avatar_url: null,
    joined_at: Date.parse('2026-05-15T00:00:00Z'),
    last_seen_at: null,
    binding_status: 'pending',
    binding_last_checked_at: null,
    device_count: 0,
    prs_merged: 1,
    features_shipped: 0,
    activity_events: 5,
  },
];

beforeEach(() => {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ contributors: SAMPLE }), {
      headers: { 'content-type': 'application/json' },
    }),
  ) as typeof globalThis.fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderTab() {
  return render(
    <NuqsTestingAdapter>
      <ContributorsTab harnessSlug="papercup" />
    </NuqsTestingAdapter>,
  );
}

describe('ContributorsTab — P-048', () => {
  it('shows loading state then list', async () => {
    renderTab();
    expect(screen.getByText('Contributors')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Alice')).toBeTruthy());
    expect(screen.getByText('@alice')).toBeTruthy();
    expect(screen.getByText('@bob')).toBeTruthy();
  });

  it('renders count text', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('2 people')).toBeTruthy());
  });

  it('renders all 4 sort buttons', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('Alice')).toBeTruthy());
    expect(screen.getByText('joined')).toBeTruthy();
    expect(screen.getByText('PRs merged')).toBeTruthy();
    expect(screen.getByText('features shipped')).toBeTruthy();
    expect(screen.getByText('activity')).toBeTruthy();
  });

  it('shows empty-state CTA when list is empty', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ contributors: [] }), {
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof globalThis.fetch;
    renderTab();
    await waitFor(() => expect(screen.getByText('No contributors yet.')).toBeTruthy());
    expect(screen.getByText(/Share this harness/i)).toBeTruthy();
  });

  it('shows error message when fetch fails', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500 }),
    ) as typeof globalThis.fetch;
    renderTab();
    await waitFor(() => expect(screen.getByText(/Failed to load/i)).toBeTruthy());
  });

  it('hits the correct API path', async () => {
    const spy = vi.fn(async () =>
      new Response(JSON.stringify({ contributors: SAMPLE }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;
    renderTab();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const firstCall = spy.mock.calls[0] as unknown as [string];
    expect(firstCall[0]).toBe('/api/harness/papercup/contributors');
  });
});
