// @vitest-environment jsdom
/**
 * WorkScopeAdmin.test.tsx — render-tier coverage for the /admin/work-scope pane (WI-2145092).
 * Branches: loading, error, the status card (assessment + allow chips + ledger counts), the
 * set form posting to /api/work-scope/set with the parsed allow-list, the two-step clear
 * posting to /api/work-scope/clear, and the ok:false reply surfacing as an error toast.
 * `@papercusp/sync` is mocked to feed one payload; `Select` is replaced by a native select.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkScopeStatusPayload } from '@papercusp/operator-core/lib/work-scope-policy';

// vi.mock factories are hoisted above every other statement, so the state they close over
// must be hoisted with them (vi.hoisted) — a plain top-level const is not yet initialised.
const { sync, toast } = vi.hoisted(() => ({
  sync: { payload: null as WorkScopeStatusPayload | null, loading: false, error: null as unknown },
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: sync.payload ? [sync.payload] : [], loading: sync.loading, error: sync.error }),
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/app/harness/Select', () => ({
  Select: ({ value, onChange, options, ariaLabel }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; ariaLabel?: string }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

import WorkScopeAdmin, { parseAllowList } from './WorkScopeAdmin';

function payload(over: Partial<WorkScopeStatusPayload> = {}): WorkScopeStatusPayload {
  return {
    ok: true,
    mode: 'enforce',
    enforced: true,
    allowHarnesses: ['papercusp', 'papercusp/*'],
    exceptions: 0,
    setBy: 'role:su',
    reason: 'owner: papercusp only',
    updatedAt: '2026-09-05T02:37:07Z',
    ledger: {
      counts: { denied: 3, held: 1, rehomed: 5 },
      recent: [{ at: '2026-09-05T03:44:41.000Z', site: 'work_items:claim', verdict: 'denied', harness: 'sidestage', subject: 'WI-1' }],
    },
    assessments: { policy: 'enforce' },
    ...over,
  };
}

function stubFetch(reply: { ok: boolean; status?: number; body?: Record<string, unknown> } = { ok: true }) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ ok: reply.ok, auditId: 'gwc-1', ...(reply.body ?? {}) }), { status: reply.status ?? (reply.ok ? 200 : 502) }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  sync.payload = payload();
  sync.loading = false;
  sync.error = null;
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('parseAllowList', () => {
  it('splits on newlines and commas, trims, drops blanks and duplicates, keeps order', () => {
    expect(parseAllowList(' papercusp \n papercusp/*, sidestage,\n\npapercusp ')).toEqual(['papercusp', 'papercusp/*', 'sidestage']);
    expect(parseAllowList('')).toEqual([]);
  });
});

describe('WorkScopeAdmin', () => {
  it('renders the loading and error states before a payload arrives', () => {
    sync.payload = null;
    sync.loading = true;
    const { unmount } = render(<WorkScopeAdmin />);
    expect(screen.getByText(/Loading work-scope policy/)).toBeTruthy();
    unmount();
    sync.loading = false;
    sync.error = new Error('boom');
    render(<WorkScopeAdmin />);
    expect(screen.getByText(/Failed to load the work-scope policy/)).toBeTruthy();
  });

  it('shows the assessment, the allow chips, the ledger counts and the recent decisions', () => {
    render(<WorkScopeAdmin />);
    expect(screen.getByTestId('work-scope-assessment').textContent).toBe('enforce');
    expect(screen.getAllByTestId('work-scope-allow').map((n) => n.textContent)).toEqual(['papercusp', 'papercusp/*']);
    expect(screen.getByTestId('work-scope-count-denied').textContent).toBe('denied: 3');
    expect(screen.getByText('work_items:claim')).toBeTruthy();
    expect(screen.getByText('sidestage')).toBeTruthy();
  });

  it('seeds the form from the live row, requires a reason, and POSTs the parsed allow-list to /api/work-scope/set', async () => {
    const fetchMock = stubFetch();
    render(<WorkScopeAdmin />);
    const setButton = screen.getByRole('button', { name: 'Set policy' }) as HTMLButtonElement;
    expect(setButton.disabled).toBe(true); // no reason yet

    fireEvent.change(screen.getByLabelText('Allowed harnesses'), { target: { value: 'papercusp, papercusp/*\nsidestage' } });
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'off' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'widening for the day' } });
    expect(setButton.disabled).toBe(false);
    fireEvent.click(setButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/work-scope/set');
    expect(JSON.parse(String(init.body))).toEqual({
      mode: 'off',
      allowHarnesses: ['papercusp', 'papercusp/*', 'sidestage'],
      reason: 'widening for the day',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('clears only after a second click, POSTing to /api/work-scope/clear', async () => {
    const fetchMock = stubFetch();
    render(<WorkScopeAdmin />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear policy…' }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Confirm clear/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/work-scope/clear');
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
  });

  it('disables clear when no policy is stored', () => {
    sync.payload = payload({ mode: null, enforced: false, allowHarnesses: [], assessments: { policy: 'absent' } });
    render(<WorkScopeAdmin />);
    expect((screen.getByRole('button', { name: 'Clear policy…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('work-scope-assessment').textContent).toBe('absent');
  });

  it('surfaces an ok:false reply (a reverted write) as an error toast, never success', async () => {
    stubFetch({ ok: false, status: 502, body: { error: 'policy did not persist as written' } });
    render(<WorkScopeAdmin />);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'try' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set policy' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error.mock.calls[0]![1]).toEqual({ description: 'policy did not persist as written' });
    expect(toast.success).not.toHaveBeenCalled();
  });
});
