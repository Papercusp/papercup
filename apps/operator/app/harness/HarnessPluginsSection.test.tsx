// @vitest-environment jsdom
/**
 * HarnessPluginsSection.test.tsx — render-tier coverage for the per-harness
 * plugin management section (whole-app-test-coverage-breadth). The section
 * fans out three useSyncQuery reads (enabled slugs / config rows) + a
 * /api/plugins/global fetch for installed manifests; the test mocks all of
 * them so it can render both the empty state and a populated plugin card with
 * its actions, capability tags, and the (Monaco-stubbed) config editor.
 *
 * Mocked: useSyncQuery (branches on queryName), sonner, useWorkspaceId,
 * @monaco-editor/react (→ textarea), @formkit/auto-animate (→ noop ref). Real:
 * plugin-utils, react-hook-form, the Tooltip/Checkbox/Select primitives, and
 * useConfirmDialog (its ConfirmModal renders fine in jsdom).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
// Per-query sync data, keyed by queryName. The section reads
// pluginEnables.byWorkspace + pluginConfigs.byHarness; the editor re-reads
// pluginConfigs.byHarness.
let enabledRows: unknown[];
let configRows: unknown[];
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => {
    const data = queryName === 'pluginEnables.byWorkspace' ? enabledRows
      : queryName === 'pluginConfigs.byHarness' ? configRows
      : [];
    return { data, error: null, loading: false, fetching: false, invalidate: vi.fn() };
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/use-workspace-id', () => ({ useWorkspaceId: () => 'ws-test' }));
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value?: string; onChange?: (v: string | undefined) => void }) => (
    <textarea data-testid="monaco" value={value ?? ''} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));
vi.mock('@formkit/auto-animate/react', () => ({ useAutoAnimate: () => [{ current: null }] }));

import HarnessPluginsSection from './HarnessPluginsSection';

/* ── Helpers ───────────────────────────────────────────────────────── */
function renderSection(ui: ReactElement, searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

/** A minimal installed-plugin manifest the /api/plugins/global fetch returns. */
function manifest(over: Record<string, unknown> = {}) {
  return {
    name: 'acme-tool',
    version: '1.2.3',
    description: 'Does the acme thing.',
    path: '/plugins/acme-tool',
    actions: [{ id: 'sync', label: 'Sync now' }],
    capabilities: ['secrets:read:ACME_TOKEN', 'events:listen:plan.created', 'http:fetch:api.acme.com'],
    configSchema: { required: ['endpoint'], properties: { endpoint: { type: 'string', description: 'API endpoint' } } },
    ...over,
  };
}

function stubGlobalPluginsFetch(plugins: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/plugins/global')) {
      return new Response(JSON.stringify({ plugins }), { status: 200 });
    }
    // The editor's REST back-stop + any save → ok with an empty config.
    return new Response(JSON.stringify({ ok: true, config: {} }), { status: 200 });
  }));
}

beforeEach(() => {
  enabledRows = [];
  configRows = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('HarnessPluginsSection (per-harness plugin management)', () => {
  it('renders the Plugins heading and the empty state when nothing is enabled', async () => {
    stubGlobalPluginsFetch([manifest()]);
    enabledRows = []; // no enabled rows for this harness
    renderSection(<HarnessPluginsSection slug="my-harness" />);
    expect(screen.getByRole('heading', { name: 'Plugins' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/No plugins enabled for this harness/i)).toBeTruthy());
  });

  it('still shows the empty state when a plugin is enabled for a DIFFERENT harness', async () => {
    stubGlobalPluginsFetch([manifest()]);
    enabledRows = [{ harnessSlug: 'other-harness', pluginSlug: 'acme-tool', enabled: true }];
    renderSection(<HarnessPluginsSection slug="my-harness" />);
    await waitFor(() => expect(screen.getByText(/No plugins enabled for this harness/i)).toBeTruthy());
  });

  it('renders the enabled plugin card with its name, version, and tab', async () => {
    stubGlobalPluginsFetch([manifest()]);
    enabledRows = [{ harnessSlug: 'my-harness', pluginSlug: 'acme-tool', enabled: true }];
    renderSection(<HarnessPluginsSection slug="my-harness" />);
    // The plugin tab + the card title both show the name.
    await waitFor(() => expect(screen.getAllByText('acme-tool').length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText('v1.2.3')).toBeTruthy();
    expect(screen.getByText('Does the acme thing.')).toBeTruthy();
  });

  it('renders the plugin actions with an Invoke button', async () => {
    stubGlobalPluginsFetch([manifest()]);
    enabledRows = [{ harnessSlug: 'my-harness', pluginSlug: 'acme-tool', enabled: true }];
    renderSection(<HarnessPluginsSection slug="my-harness" />);
    await waitFor(() => expect(screen.getByText('sync')).toBeTruthy());
    expect(screen.getByText('Sync now')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Invoke' })).toBeTruthy();
  });

  it('renders the capability tags (events / secrets / http)', async () => {
    stubGlobalPluginsFetch([manifest()]);
    enabledRows = [{ harnessSlug: 'my-harness', pluginSlug: 'acme-tool', enabled: true }];
    renderSection(<HarnessPluginsSection slug="my-harness" />);
    await waitFor(() => expect(screen.getByText('Listens to events')).toBeTruthy());
    expect(screen.getByText('plan.created')).toBeTruthy();
    expect(screen.getByText('Required capabilities')).toBeTruthy();
    expect(screen.getByText('secret: ACME_TOKEN')).toBeTruthy();
  });

  it('shows an action-only badge for a plugin with no dashboard tabs', async () => {
    stubGlobalPluginsFetch([manifest()]);
    enabledRows = [{ harnessSlug: 'my-harness', pluginSlug: 'acme-tool', enabled: true }];
    renderSection(<HarnessPluginsSection slug="my-harness" />);
    await waitFor(() => expect(screen.getByText('action-only')).toBeTruthy());
  });

  it('renders the config editor with the config path and schema field', async () => {
    stubGlobalPluginsFetch([manifest()]);
    enabledRows = [{ harnessSlug: 'my-harness', pluginSlug: 'acme-tool', enabled: true }];
    // Provide a config row so the editor hydrates from Zero (no REST wait).
    configRows = [{ harnessSlug: 'my-harness', pluginSlug: 'acme-tool', config: { endpoint: 'https://x' } }];
    renderSection(<HarnessPluginsSection slug="my-harness" />);
    await waitFor(() => expect(screen.getByText(/plugin-configs\/acme-tool\.json/)).toBeTruthy());
    // The `endpoint` schema key surfaces both in the header key list + field label.
    expect(screen.getAllByText('endpoint').length).toBeGreaterThanOrEqual(1);
  });

  it('toggles the config editor between form and JSON (Monaco) modes', async () => {
    stubGlobalPluginsFetch([manifest()]);
    enabledRows = [{ harnessSlug: 'my-harness', pluginSlug: 'acme-tool', enabled: true }];
    configRows = [{ harnessSlug: 'my-harness', pluginSlug: 'acme-tool', config: { endpoint: 'https://x' } }];
    renderSection(<HarnessPluginsSection slug="my-harness" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit as JSON' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit as JSON' }));
    // JSON mode swaps in the (stubbed) Monaco editor.
    await waitFor(() => expect(screen.getByTestId('monaco')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Edit as form' })).toBeTruthy();
  });

  it('shows the Disable button on the active plugin card', async () => {
    stubGlobalPluginsFetch([manifest()]);
    enabledRows = [{ harnessSlug: 'my-harness', pluginSlug: 'acme-tool', enabled: true }];
    renderSection(<HarnessPluginsSection slug="my-harness" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy());
  });
});
