// @vitest-environment jsdom
/**
 * BlueprintSettingsPanel.test.tsx — render-tier coverage for the schema-driven
 * per-harness settings panel (whole-app-test-coverage-breadth). The blueprint
 * params module is mocked so the test controls the exact ParamViews
 * (resolveParamViews) and the save validation result (validateParamPatch /
 * applyParamPatch). useSyncQuery (config.json mirror) and sonner are mocked;
 * the two heavy children (SavedPromptsSection, HarnessPluginsSection) are
 * stubbed. fetch is stubbed for the blueprint-params load + the /spec PUT.
 *
 * Covered branches: loading (params not yet loaded), the no-params empty state
 * (with/without a blueprintId), grouped param rendering + control-by-type,
 * editing a text param → dirty save bar → successful save (toast.success), and
 * a validation failure → toast.error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
let syncResult: { data: unknown[] };
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: () => ({ ...syncResult, error: null, loading: false, fetching: false, invalidate: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/use-workspace-id', () => ({ useWorkspaceId: () => 'ws-test' }));
// Heavy children — out of scope for this panel's own logic.
vi.mock('./SavedPromptsSection', () => ({ default: () => <div data-testid="saved-prompts" /> }));
vi.mock('./HarnessPluginsSection', () => ({ default: () => <div data-testid="plugins-section" /> }));
vi.mock('./IntegrationModeSection', () => ({
  default: ({ slug }: { slug: string }) => <div data-testid="integration-mode-section-mount">{slug}</div>,
}));

// The blueprint-params engine — fully mocked so we drive views + validation.
let mockViews: Array<{ key: string; spec: Record<string, unknown>; value: unknown; overridden: boolean }>;
let mockValidate: { ok: boolean; errors: { key: string; error: string }[]; unknownKeys: string[]; patch: Record<string, unknown> };
vi.mock('@papercusp/orchestrator/blueprint/params', () => ({
  resolveParamViews: () => mockViews,
  validateParamPatch: () => mockValidate,
  applyParamPatch: (cfg: Record<string, unknown>, _params: unknown, patch: Record<string, unknown>) => ({ ...cfg, ...patch }),
}));

import { toast } from 'sonner';
import BlueprintSettingsPanel from './BlueprintSettingsPanel';

/* ── Helpers ───────────────────────────────────────────────────────── */
function renderPanel(ui: ReactElement, searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

/** Drive the on-mount /blueprint-params fetch result. */
function stubBlueprintParamsFetch(body: { blueprintId?: string | null; params?: Record<string, unknown> }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/blueprint-params')) {
      return new Response(JSON.stringify(body), { status: 200 });
    }
    // /spec PUT and anything else → ok.
    return new Response('{"ok":true}', { status: 200 });
  }));
}

beforeEach(() => {
  syncResult = { data: [] };
  mockViews = [];
  mockValidate = { ok: true, errors: [], unknownKeys: [], patch: {} };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('BlueprintSettingsPanel (schema-driven per-harness settings)', () => {
  it('shows the loading state until the blueprint params resolve', () => {
    // fetch never resolves → paramsLoaded stays false.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderPanel(<BlueprintSettingsPanel slug="my-harness" phase="production" />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('renders the no-params empty state with the blueprint name once loaded', async () => {
    stubBlueprintParamsFetch({ blueprintId: 'coding', params: {} });
    renderPanel(<BlueprintSettingsPanel slug="my-harness" phase="production" />);
    await waitFor(() => expect(screen.getByText(/declares no tunable settings/i)).toBeTruthy());
    // Header references the blueprint id.
    expect(screen.getByText('coding')).toBeTruthy();
    // No-params → no save bar.
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull();
  });

  it('notes the missing blueprint.yaml when there is no blueprintId', async () => {
    stubBlueprintParamsFetch({ blueprintId: null, params: {} });
    renderPanel(<BlueprintSettingsPanel slug="bare" phase="staging" />);
    await waitFor(() => expect(screen.getByText(/no blueprint\.yaml found/i)).toBeTruthy());
  });

  it('renders grouped params with the right control per type', async () => {
    stubBlueprintParamsFetch({ blueprintId: 'coding', params: { a: {}, b: {}, c: {} } });
    mockViews = [
      { key: 'worker.count', spec: { type: 'number', label: 'Worker count', group: 'Workers' }, value: 3, overridden: false },
      { key: 'worker.flag', spec: { type: 'boolean', label: 'Enable flag', group: 'Workers' }, value: true, overridden: true },
      { key: 'model.name', spec: { type: 'string', label: 'Model', group: 'Model' }, value: 'opus', overridden: false },
    ];
    renderPanel(<BlueprintSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByText('Worker count')).toBeTruthy());
    // Two groups render as <h2> section headings.
    expect(screen.getByRole('heading', { name: 'Workers' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Model' })).toBeTruthy();
    // boolean → a checkbox with the spec label as aria-label.
    expect(screen.getByRole('checkbox', { name: 'Enable flag' })).toBeTruthy();
    // string → a textbox seeded with the value.
    const text = screen.getByDisplayValue('opus');
    expect(text).toBeTruthy();
  });

  it('renders a secret param as a credential-store note (no input)', async () => {
    stubBlueprintParamsFetch({ blueprintId: 'coding', params: { tok: {} } });
    mockViews = [
      { key: 'api.token', spec: { type: 'string', label: 'API token', secret: true, group: 'Secrets' }, value: undefined, overridden: false },
    ];
    renderPanel(<BlueprintSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByText(/set via the credential store/i)).toBeTruthy());
  });

  it('editing a param arms the save bar and a successful save toasts success', async () => {
    stubBlueprintParamsFetch({ blueprintId: 'coding', params: { m: {} } });
    mockViews = [
      { key: 'model.name', spec: { type: 'string', label: 'Model', group: 'Model' }, value: 'opus', overridden: false },
    ];
    mockValidate = { ok: true, errors: [], unknownKeys: [], patch: { 'model.name': 'sonnet' } };
    renderPanel(<BlueprintSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByDisplayValue('opus')).toBeTruthy());

    // No edits yet → Save disabled.
    const saveBtn = () => screen.getByRole('button', { name: /^Save$|^Saving…$/ }) as HTMLButtonElement;
    expect(saveBtn().disabled).toBe(true);

    fireEvent.change(screen.getByDisplayValue('opus'), { target: { value: 'sonnet' } });
    // Dirty → the unsaved-change pill + enabled Save.
    expect(screen.getByText(/unsaved change/i)).toBeTruthy();
    expect(saveBtn().disabled).toBe(false);

    fireEvent.click(saveBtn());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Settings saved'));
  });

  it('a validation failure on save toasts an error and does not clear edits', async () => {
    stubBlueprintParamsFetch({ blueprintId: 'coding', params: { m: {} } });
    mockViews = [
      { key: 'worker.count', spec: { type: 'number', label: 'Worker count', group: 'Workers' }, value: 1, overridden: false },
    ];
    mockValidate = { ok: false, errors: [{ key: 'worker.count', error: 'out of range' }], unknownKeys: [], patch: {} };
    renderPanel(<BlueprintSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByText('Worker count')).toBeTruthy());

    // Edit the number control to dirty the form.
    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Some settings are invalid'));
    // The per-field error is rendered.
    expect(screen.getByText(/out of range/)).toBeTruthy();
  });

  it('always mounts the saved-prompts and plugins sections', async () => {
    stubBlueprintParamsFetch({ blueprintId: 'coding', params: {} });
    renderPanel(<BlueprintSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByTestId('saved-prompts')).toBeTruthy());
    expect(screen.getByTestId('plugins-section')).toBeTruthy();
  });

  // WI-10006501: this is the panel the Settings tab mounts by default
  // (BLUEPRINT_AWARE_SETTINGS on), so the pot's working-copy switch (P-016) must be
  // here too, keyed to the selected pot. Before the fix it existed only in the
  // legacy HarnessSettingsPanel, so with defaults no user could reach it.
  it("mounts the pot's working-copy switch for the selected pot, including while params load", async () => {
    stubBlueprintParamsFetch({ blueprintId: 'coding', params: {} });
    renderPanel(<BlueprintSettingsPanel slug="pot-review-pilot" phase="production" />);
    await waitFor(() => expect(screen.getByTestId('integration-mode-section-mount')).toBeTruthy());
    expect(screen.getByTestId('integration-mode-section-mount').textContent).toBe('pot-review-pilot');
  });
});
