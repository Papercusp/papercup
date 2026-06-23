// @vitest-environment jsdom
//
// HarnessWorkspacesButton — the /adv "Workspaces" membership popover. Real
// logic: lazy load on open (GET workspaces + listWorkspaces registry), the
// linked-vs-add-to partition, the active badge, the last-membership Remove
// guard, and the Link / Move / Remove membership POSTs. Popover + Tooltip are
// flattened so the menu is queryable; fetch + listWorkspaces are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
const { toastSpies } = vi.hoisted(() => ({ toastSpies: { success: vi.fn(), error: vi.fn() } }));
vi.mock('sonner', () => ({ toast: toastSpies }));
const syncState = vi.hoisted(() => ({
  members: [] as string[],
  invalidate: vi.fn(),
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ enabled }: { enabled?: boolean }) => ({
    data: enabled ? syncState.members.map((workspaceId) => ({ workspaceId })) : null,
    loading: false,
    error: null,
    fetching: false,
    invalidate: syncState.invalidate,
  }),
}));

// Render the Popover trigger + panel inline so the menu is always queryable.
// The real Popover owns the open toggle via onOpenChange; the parent's `open`
// state gates the lazy membership load, so the mock MUST drive onOpenChange on
// a trigger click — otherwise `open` never flips and refresh() never fires.
vi.mock('../../harness/Popover', () => ({
  Popover: ({
    trigger,
    children,
    onOpenChange,
  }: {
    trigger: React.ReactNode;
    children: React.ReactNode;
    onOpenChange?: (o: boolean) => void;
  }) => (
    <div>
      <div onClickCapture={() => onOpenChange?.(true)}>{trigger}</div>
      {children}
    </div>
  ),
}));
vi.mock('../../harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The workspace registry — tests mutate `reg.value` before opening.
const reg = {
  value: {
    current: 'ws-a',
    workspaces: [
      { id: 'ws-a', name: 'Alpha' },
      { id: 'ws-b', name: 'Beta' },
      { id: 'ws-c', name: 'Gamma' },
    ],
  } as { current: string; workspaces: Array<{ id: string; name: string }> },
};
vi.mock('@papercusp/operator-core/lib/workspaces-tauri', () => ({
  listWorkspaces: vi.fn(async () => reg.value),
}));

import HarnessWorkspacesButton from './HarnessWorkspacesButton';

/** Stub fetch: membership reads come from sync; POST returns ok. */
function stubFetch(members: string[]) {
  syncState.members = members;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }),
  );
}

beforeEach(() => {
  syncState.members = [];
  syncState.invalidate.mockReset();
  toastSpies.success.mockReset();
  toastSpies.error.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HarnessWorkspacesButton', () => {
  it('renders the trigger button (count hidden until membership loads)', () => {
    stubFetch([]);
    render(<HarnessWorkspacesButton slug="my-harness" />);
    // Before open, members is null → no "(n)" suffix.
    const btn = screen.getByRole('button', { name: 'Harness workspaces' });
    expect(btn.textContent).toContain('Workspaces');
    expect(btn.textContent).not.toMatch(/\(\d+\)/);
  });

  it('loads membership + the registry on open, showing linked rows and the active badge', async () => {
    stubFetch(['ws-a', 'ws-b']);
    render(<HarnessWorkspacesButton slug="my-harness" />);
    fireEvent.click(screen.getByRole('button', { name: 'Harness workspaces' }));

    // Linked names resolve from the registry; ws-a is current → "active" badge.
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    // Non-member ws-c appears under "Add to".
    expect(screen.getByText('Add to')).toBeTruthy();
    expect(screen.getByText('Gamma')).toBeTruthy();
  });

  it('Remove is disabled when the harness is in exactly one workspace (orphan guard)', async () => {
    stubFetch(['ws-a']);
    render(<HarnessWorkspacesButton slug="solo" />);
    fireEvent.click(screen.getByRole('button', { name: 'Harness workspaces' }));

    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    const removeBtn = screen.getByRole('button', { name: 'Remove from Alpha' });
    expect((removeBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers Move (sole source) only when the harness is in exactly one workspace', async () => {
    stubFetch(['ws-a']);
    render(<HarnessWorkspacesButton slug="solo" />);
    fireEvent.click(screen.getByRole('button', { name: 'Harness workspaces' }));
    // Two non-members (ws-b, ws-c) each get a "Move here" pill.
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Move here' }).length).toBe(2));
  });

  it('does NOT offer Move when the harness is in multiple workspaces', async () => {
    stubFetch(['ws-a', 'ws-b']);
    render(<HarnessWorkspacesButton slug="multi" />);
    fireEvent.click(screen.getByRole('button', { name: 'Harness workspaces' }));
    await waitFor(() => expect(screen.getByText('Gamma')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Move here' })).toBeNull();
  });

  it('clicking Link POSTs an add membership op and toasts success', async () => {
    stubFetch(['ws-a', 'ws-b']); // ws-c is the lone non-member
    render(<HarnessWorkspacesButton slug="multi" />);
    fireEvent.click(screen.getByRole('button', { name: 'Harness workspaces' }));
    await waitFor(() => expect(screen.getByText('Gamma')).toBeTruthy());

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
      expect(post).toBeTruthy();
      expect(String((post![1] as RequestInit).body)).toContain('"op":"add"');
    });
    await waitFor(() => expect(toastSpies.success).toHaveBeenCalled());
  });

  it('clicking Remove POSTs a remove op when more than one membership exists', async () => {
    stubFetch(['ws-a', 'ws-b']);
    render(<HarnessWorkspacesButton slug="multi" />);
    fireEvent.click(screen.getByRole('button', { name: 'Harness workspaces' }));
    await waitFor(() => expect(screen.getByText('Beta')).toBeTruthy());

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from Beta' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
      expect(post).toBeTruthy();
      expect(String((post![1] as RequestInit).body)).toContain('"op":"remove"');
    });
  });

  it('toasts an error and does not crash when the membership POST fails', async () => {
    syncState.members = ['ws-a', 'ws-b'];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return new Response(JSON.stringify({ ok: false, error: 'denied' }), { status: 400 });
        return new Response('{}', { status: 200 });
      }),
    );
    render(<HarnessWorkspacesButton slug="multi" />);
    fireEvent.click(screen.getByRole('button', { name: 'Harness workspaces' }));
    await waitFor(() => expect(screen.getByText('Gamma')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(toastSpies.error).toHaveBeenCalled());
  });
});
