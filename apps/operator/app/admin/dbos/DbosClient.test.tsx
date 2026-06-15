// @vitest-environment jsdom
//
// DbosClient — the DBOS workflow/queue admin viewer. Two pure helpers (fmt,
// statusColor) carry the display logic and are extracted + exported. The
// render-smoke drives the self-fetching client (nuqs-backed view/status keys)
// against a mocked fetch: the disabled banner, the workflows table, and the
// queues view.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

import DbosClient, { fmt, statusColor } from './DbosClient';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('fmt (pure)', () => {
  it('returns an em-dash for non-positive or unparseable input', () => {
    expect(fmt('0')).toBe('—');
    expect(fmt('-5')).toBe('—');
    expect(fmt('not a number')).toBe('—');
  });
  it('formats a positive epoch-ms string to a locale string', () => {
    expect(fmt('1700000000000')).not.toBe('—');
  });
});

describe('statusColor (pure)', () => {
  it('greens SUCCESS', () => {
    expect(statusColor('SUCCESS')).toBe('#86efac');
  });
  it('reds ERROR and any MAX_RECOVERY variant', () => {
    expect(statusColor('ERROR')).toBe('#fca5a5');
    expect(statusColor('MAX_RECOVERY_ATTEMPTS')).toBe('#fca5a5');
  });
  it('ambers PENDING and ENQUEUED', () => {
    expect(statusColor('PENDING')).toBe('#fde68a');
    expect(statusColor('ENQUEUED')).toBe('#fde68a');
  });
  it('blues anything else', () => {
    expect(statusColor('RUNNING')).toBe('#dbeafe');
  });
});

function payload(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    counts: [{ status: 'SUCCESS', n: 3 }],
    workflows: [],
    queues: [],
    ...over,
  };
}

function renderClient(searchParams = '?') {
  fetchMock.mockResolvedValue({ ok: true, json: async () => payload() });
  return render(<DbosClient />, { wrapper: withNuqsTestingAdapter({ searchParams }) });
}

describe('<DbosClient />', () => {
  it('shows the disabled-DBOS guidance when the payload is not enabled', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => payload({ enabled: false }) });
    render(<DbosClient />, { wrapper: withNuqsTestingAdapter({ searchParams: '?' }) });
    await waitFor(() => expect(screen.getByText(/DBOS is not running/i)).toBeTruthy());
  });

  it('renders the workflow rows with a truncated uuid and status text', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => payload({
        workflows: [
          {
            workflow_uuid: 'abcdef1234567890', name: 'doWork', status: 'SUCCESS',
            queue_name: 'default', application_version: 'v1', recovery_attempts: 0,
            deduplication_id: null, created_at: '1700000000000', updated_at: '1700000000000', error: '',
          },
        ],
      }),
    });
    render(<DbosClient />, { wrapper: withNuqsTestingAdapter({ searchParams: '?' }) });
    await waitFor(() => expect(screen.getByText('doWork')).toBeTruthy());
    expect(screen.getByText('abcdef12')).toBeTruthy(); // first 8 chars of the uuid
    expect(screen.getByText('SUCCESS')).toBeTruthy();
  });

  it('shows the queues table when ?view=queues', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => payload({ queues: [{ queue_name: 'email', depth: 2, active: 1 }] }),
    });
    render(<DbosClient />, { wrapper: withNuqsTestingAdapter({ searchParams: '?view=queues' }) });
    await waitFor(() => expect(screen.getByText('email')).toBeTruthy());
  });

  it('renders an error message when the status fetch fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    render(<DbosClient />, { wrapper: withNuqsTestingAdapter({ searchParams: '?' }) });
    await waitFor(() => expect(screen.getByText(/Error: HTTP 500/)).toBeTruthy());
  });
});
