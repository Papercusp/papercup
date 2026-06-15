// @vitest-environment jsdom
//
// WorkspaceSwitcher — the navbar workspace dropdown. The component owns real
// conditional render: returns null until the registry loads / when empty,
// labels the trigger with the active workspace, marks the active row, and
// disables the delete button for the active + default workspaces. A render-smoke
// drives a mocked workspaces-tauri registry to exercise those branches. The
// portaled menu is opened via the ?wsSwitch nuqs param (real testing adapter).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

const { reg } = vi.hoisted(() => ({
  reg: {
    current: 'default',
    value: {
      current: 'ws-a',
      workspaces: [
        { id: 'ws-a', name: 'Alpha' },
        { id: 'ws-b', name: 'Bravo' },
      ],
    } as { current: string; workspaces: { id: string; name: string }[] } | null,
  },
}));

vi.mock('@papercusp/operator-core/lib/workspaces-tauri', () => ({
  listWorkspaces: vi.fn(async () => reg.value),
  createWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  openWorkspaceWindow: vi.fn(),
  renameWorkspace: vi.fn(),
  switchWorkspace: vi.fn(),
}));

vi.mock('@papercusp/operator-core/lib/browser-workspace', () => ({
  getBrowserWorkspaceId: () => 'ws-a',
  resolveActiveWorkspaceId: (
    r: { current: string; workspaces: { id: string }[] },
    windowWsId: string,
  ) => {
    const known = (id: string) => r.workspaces.some((w) => w.id === id);
    if (windowWsId && known(windowWsId)) return windowWsId;
    if (r.current && known(r.current)) return r.current;
    return r.workspaces[0]?.id ?? windowWsId;
  },
}));

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('@bprogress/react', () => ({ useProgress: () => ({ start: vi.fn(), stop: vi.fn() }) }));
vi.mock('../harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => false), element: null }),
}));
vi.mock('../harness/usePromptDialog', () => ({
  usePromptDialog: () => ({ prompt: vi.fn(async () => null), element: null }),
}));
vi.mock('../harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import WorkspaceSwitcher from './WorkspaceSwitcher';

// Open the menu by clicking the trigger AFTER the registry loads: the menu's
// portal is gated on a menuPos that the layout-effect computes from the button
// rect, and that effect only (re)runs when `open` toggles — so we let the
// registry resolve, then click to open.
async function renderAndOpen() {
  const utils = render(<WorkspaceSwitcher />, {
    wrapper: withNuqsTestingAdapter({ searchParams: '' }),
  });
  const trigger = await screen.findByRole('button', { name: /switch or manage workspaces/i });
  fireEvent.click(trigger);
  return utils;
}

beforeEach(() => {
  reg.value = {
    current: 'ws-a',
    workspaces: [
      { id: 'ws-a', name: 'Alpha' },
      { id: 'ws-b', name: 'Bravo' },
    ],
  };
});
afterEach(cleanup);

describe('<WorkspaceSwitcher />', () => {
  it('renders nothing while the registry is still loading', () => {
    const { container } = render(<WorkspaceSwitcher />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '' }),
    });
    // Before the async listWorkspaces() resolves, reg is null → null render.
    expect(container.querySelector('.pc-workspace-switcher')).toBeNull();
  });

  it('renders nothing when the registry has no workspaces', async () => {
    reg.value = { current: '', workspaces: [] };
    const { container } = render(<WorkspaceSwitcher />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '' }),
    });
    // Give the effect a tick; still nothing rendered.
    await Promise.resolve();
    expect(container.querySelector('.pc-workspace-switcher')).toBeNull();
  });

  it('labels the trigger with the active workspace once loaded', async () => {
    render(<WorkspaceSwitcher />, { wrapper: withNuqsTestingAdapter({ searchParams: '' }) });
    const trigger = await screen.findByRole('button', { name: /switch or manage workspaces/i });
    expect(trigger.textContent).toContain('Alpha');
  });

  it('lists each workspace and marks the active one in the open menu', async () => {
    await renderAndOpen();
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Alpha')).toBeTruthy();
    expect(within(menu).getByText('Bravo')).toBeTruthy();
    // The active workspace row carries the "active" marker.
    expect(within(menu).getByText('active')).toBeTruthy();
  });

  it('disables the delete button for the active workspace but enables it for others', async () => {
    await renderAndOpen();
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(within(menu).getByText('Alpha')).toBeTruthy());
    const deleteButtons = within(menu).getAllByTitle('Delete');
    // Two rows → two delete buttons; ws-a (active) is disabled, ws-b is not.
    expect(deleteButtons).toHaveLength(2);
    expect((deleteButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((deleteButtons[1] as HTMLButtonElement).disabled).toBe(false);
  });
});
