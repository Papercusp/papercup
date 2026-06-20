// @vitest-environment jsdom
/**
 * workbench.test.tsx — the /workbench top-level desktop route. Covers: panel-type
 * registration on mount, the projects/lite fetch + first-project default-select
 * (and the non-override when ?harness is already pinned), the picker → harness
 * (nuqs) → dock-slug flow, the onDockApiBind voice-panel slug patching (+ the
 * null-api no-op), the reset-layout CustomEvent, and the fetch-failure empty
 * picker. HarnessDock + the panel registrars + dock-actions are stubbed.
 *
 * Seams: @tanstack/react-router (createFileRoute → Route), nuqs (real testing
 * adapter for ?harness=), dock-actions (onDockApiBind captured so the test can
 * drive the bind callback), fetch stubbed per-call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts }),
}));
const registerWorkbenchPanels = vi.fn();
const registerWorkbenchVoicePanel = vi.fn();
const registerWorkbenchHiveDirectoryPanel = vi.fn();
vi.mock('@/app/harness/dock/workbench-panels', () => ({ registerWorkbenchPanels: () => registerWorkbenchPanels() }));
vi.mock('../components/workbench/WorkbenchVoicePanel', () => ({ registerWorkbenchVoicePanel: () => registerWorkbenchVoicePanel() }));
vi.mock('../components/workbench/WorkbenchHiveDirectoryPanel', () => ({ registerWorkbenchHiveDirectoryPanel: () => registerWorkbenchHiveDirectoryPanel() }));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('@/app/harness/dock/HarnessDock', () => ({
  HarnessDock: ({ slug }: { slug: string }) => <div data-testid="harness-dock" data-slug={slug} />,
}));

const boundCbs: Array<(api: unknown) => void> = [];
const listPanelsMock = vi.fn<[], Array<{ id: string; type: string; params?: Record<string, unknown> }>>(() => []);
const setPanelParamsMock = vi.fn();
vi.mock('@/app/harness/dock/dock-actions', () => ({
  onDockApiBind: (cb: (api: unknown) => void) => { boundCbs.push(cb); return () => {}; },
  listPanels: () => listPanelsMock(),
  setPanelParams: (id: string, params: Record<string, unknown>) => setPanelParamsMock(id, params),
}));

import { Route } from './workbench';

const Comp = Route.component as () => JSX.Element;

let fetchImpl: () => { ok: boolean; status?: number; body: unknown };
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => {
    const r = fetchImpl();
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.body } as unknown as Response;
  }));
}

function renderWb(searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}><Comp /></NuqsTestingAdapter>);
}
const slug = () => screen.getByTestId('harness-dock').getAttribute('data-slug');

beforeEach(() => {
  boundCbs.length = 0;
  registerWorkbenchPanels.mockReset();
  registerWorkbenchVoicePanel.mockReset();
  registerWorkbenchHiveDirectoryPanel.mockReset();
  listPanelsMock.mockReset(); listPanelsMock.mockReturnValue([]);
  setPanelParamsMock.mockReset();
  fetchImpl = () => ({ ok: true, body: { projects: [{ slug: 'p1', title: 'Project One' }, { slug: 'p2' }] } });
  stubFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('/workbench route', () => {
  it('registers the workbench panel types on mount', async () => {
    renderWb();
    expect(registerWorkbenchPanels).toHaveBeenCalledTimes(1);
    expect(registerWorkbenchVoicePanel).toHaveBeenCalledTimes(1);
    expect(registerWorkbenchHiveDirectoryPanel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(slug()).toBe('p1')); // flush the mount fetch
  });

  it('default-selects the first project when no ?harness is pinned', async () => {
    renderWb();
    await waitFor(() => expect(slug()).toBe('p1'));
    expect((screen.getByTestId('workbench-harness-select') as HTMLSelectElement).value).toBe('p1');
    expect(screen.getByRole('option', { name: 'Project One' })).toBeTruthy();
  });

  it('keeps an already-pinned ?harness and does not override it with the first project', async () => {
    renderWb('?harness=p2');
    expect(slug()).toBe('p2');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Project One' })).toBeTruthy());
    expect(slug()).toBe('p2'); // still p2 — not clobbered to p1
  });

  it('changing the picker updates the active harness and the dock slug', async () => {
    renderWb('?harness=p1');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Project One' })).toBeTruthy());
    fireEvent.change(screen.getByTestId('workbench-harness-select'), { target: { value: 'p2' } });
    await waitFor(() => expect(slug()).toBe('p2'));
  });

  it('patches the active harness into voice panels when the dock API binds', async () => {
    listPanelsMock.mockReturnValue([
      { id: 'v1', type: 'workbench:voice', params: { harnessSlug: '' } },
      { id: 'a1', type: 'workbench:app', params: {} },
    ]);
    renderWb('?harness=p1');
    await waitFor(() => expect(boundCbs.length).toBeGreaterThan(0));
    const fakeApi = { onDidAddPanel: vi.fn(), onDidRemovePanel: vi.fn() };
    act(() => { boundCbs[boundCbs.length - 1](fakeApi); });
    expect(setPanelParamsMock).toHaveBeenCalledWith('v1', { harnessSlug: 'p1' });
    expect(setPanelParamsMock).not.toHaveBeenCalledWith('a1', expect.anything());
    expect(fakeApi.onDidAddPanel).toHaveBeenCalled();
  });

  it('ignores a null dock API without patching', async () => {
    listPanelsMock.mockReturnValue([{ id: 'v1', type: 'workbench:voice', params: { harnessSlug: '' } }]);
    renderWb('?harness=p1');
    await waitFor(() => expect(boundCbs.length).toBeGreaterThan(0));
    act(() => { boundCbs[boundCbs.length - 1](null); });
    expect(setPanelParamsMock).not.toHaveBeenCalled();
  });

  it('reset-layout button dispatches the dock-reset CustomEvent', async () => {
    renderWb('?harness=p1');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Project One' })).toBeTruthy());
    const onReset = vi.fn();
    window.addEventListener('papercusp:dock-reset-layout', onReset);
    fireEvent.click(screen.getByTestId('workbench-reset-layout'));
    expect(onReset).toHaveBeenCalled();
    window.removeEventListener('papercusp:dock-reset-layout', onReset);
  });

  it('leaves the picker empty when the projects fetch fails', async () => {
    fetchImpl = () => ({ ok: false, status: 500, body: {} });
    renderWb();
    await waitFor(() => expect(slug()).toBe(''));
    expect(screen.getByRole('option', { name: '— select —' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Project One' })).toBeNull();
  });
});
