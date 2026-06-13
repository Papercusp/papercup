// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
// vi.mock factories are hoisted above the module body, so the spies they close
// over must come from vi.hoisted (a plain top-level const would be in the TDZ).
const h = vi.hoisted(() => ({
  invalidate: vi.fn(),
  toastError: vi.fn(),
  syncResult: { data: [] as unknown[], loading: false, error: null as Error | null },
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ ...h.syncResult, fetching: false, invalidate: h.invalidate }),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: h.toastError, success: vi.fn() }) }));

import GraduationPrompts from './GraduationPrompts';

function target(over: Record<string, unknown> = {}) {
  return {
    category: 'work-prioritization',
    label: 'Work prioritization',
    targetGraduatedLevel: 'low',
    currentGraduatedLevel: 'never-auto',
    shouldWrite: true,
    reason: '',
    driver: { findingClass: 'work-prioritization:default', cleanStreak: 12 },
    ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.syncResult = { data: [], loading: false, error: null };
  h.invalidate.mockClear();
  h.toastError.mockClear();
  fetchMock = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ ok: true }) }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GraduationPrompts', () => {
  it('shows the empty state when nothing is graduation-eligible', () => {
    render(<GraduationPrompts />);
    expect(screen.getByRole('heading', { name: 'Graduation' })).toBeTruthy();
    expect(screen.getByText(/No categories are graduation-eligible yet/i)).toBeTruthy();
  });

  it('renders a ratify card for an eligible target', () => {
    h.syncResult = { data: [target()], loading: false, error: null };
    render(<GraduationPrompts />);
    expect(screen.getByText('Work prioritization')).toBeTruthy();
    expect(screen.getByText(/12 clean passes/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Ratify/ })).toBeTruthy();
    expect(screen.queryByText(/No categories are graduation-eligible yet/i)).toBeNull();
  });

  it('hides targets that are not eligible (shouldWrite=false)', () => {
    h.syncResult = { data: [target({ shouldWrite: false, reason: 'pinned' })], loading: false, error: null };
    render(<GraduationPrompts />);
    expect(screen.queryByRole('button', { name: /Ratify/ })).toBeNull();
    expect(screen.getByText(/No categories are graduation-eligible yet/i)).toBeTruthy();
  });

  it('ratifies by writing graduatedLevel through the policy-set route', async () => {
    h.syncResult = { data: [target()], loading: false, error: null };
    render(<GraduationPrompts />);
    fireEvent.click(screen.getByRole('button', { name: /Ratify/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/agent-mcp/autonomy-policy-set');
    const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
    expect(body).toMatchObject({ category: 'work-prioritization', graduatedLevel: 'low' });
    expect(typeof body.reason).toBe('string');
    await waitFor(() => expect(h.invalidate).toHaveBeenCalled());
  });

  it('toasts on a failed ratify and does not invalidate', async () => {
    h.syncResult = { data: [target()], loading: false, error: null };
    fetchMock.mockResolvedValueOnce({
      ok: false,
      text: async () => JSON.stringify({ ok: false, error: 'reason_required' }),
    });
    render(<GraduationPrompts />);
    fireEvent.click(screen.getByRole('button', { name: /Ratify/ }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});
