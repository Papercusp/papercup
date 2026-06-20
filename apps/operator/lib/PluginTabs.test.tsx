// @vitest-environment jsdom
/**
 * PluginTabs.test.tsx — the plugin-contributed dashboard tab host. Covers the
 * mount fetch (loading / error / empty-null), the tab strip with auto-selected
 * first tab, the three render modes (iframe / react-component / invalid
 * manifest), and switching the active tab.
 *
 * Seams: ./plugin-runtime (fetchContributions + resolveComponent), the browser
 * api factory, nuqs via NuqsTestingAdapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

interface Tab { id: string; pluginName: string; label: string; iframeUrl?: string; componentRoot?: string; componentId?: string }

let mode: 'resolve' | 'reject' | 'pending';
let contribValue: { dashboardTabs: Tab[] };
const PluginComp = () => <div data-testid="plugin-comp" />;
const resolveComponentMock = vi.fn(() => PluginComp);
const fetchContributionsMock = vi.fn(() => {
  if (mode === 'pending') return new Promise(() => {});
  if (mode === 'reject') return Promise.reject(new Error('boom'));
  return Promise.resolve(contribValue);
});
vi.mock('./plugin-runtime', () => ({
  fetchContributions: () => fetchContributionsMock(),
  resolveComponent: () => resolveComponentMock(),
}));
vi.mock('@papercusp/operator-core/lib/browser-papercusp-api', () => ({ makeBrowserApi: () => ({}) }));

import PluginTabs from './PluginTabs';

const IFRAME: Tab = { id: 't1', pluginName: 'p1', label: 'Dash', iframeUrl: 'https://x.test' };
const REACT: Tab = { id: 't2', pluginName: 'p2', label: 'React', componentRoot: 'root', componentId: 'cid' };
const INVALID: Tab = { id: 't3', pluginName: 'p3', label: 'Bad' };

function renderTabs() {
  return render(<NuqsTestingAdapter><PluginTabs slug="alpha" /></NuqsTestingAdapter>);
}

beforeEach(() => { mode = 'resolve'; contribValue = { dashboardTabs: [] }; resolveComponentMock.mockClear(); fetchContributionsMock.mockClear(); });
afterEach(cleanup);

describe('PluginTabs', () => {
  it('shows the loading state until contributions resolve', () => {
    mode = 'pending';
    renderTabs();
    expect(screen.getByText(/Loading plugin tabs/i)).toBeTruthy();
  });

  it('shows an error alert when the fetch rejects', async () => {
    mode = 'reject';
    renderTabs();
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('boom'));
  });

  it('renders nothing when there are no contributed tabs', async () => {
    contribValue = { dashboardTabs: [] };
    const { container } = renderTabs();
    await waitFor(() => expect(screen.queryByText(/Loading plugin tabs/i)).toBeNull());
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });

  it('renders an iframe tab (auto-selected first) with a titled frame', async () => {
    contribValue = { dashboardTabs: [IFRAME] };
    renderTabs();
    expect(await screen.findByRole('tab', { name: /Dash/ })).toBeTruthy();
    const frame = document.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe('https://x.test');
    expect(frame.getAttribute('title')).toBe('Dash (p1)');
  });

  it('renders a react-component tab via resolveComponent', async () => {
    contribValue = { dashboardTabs: [REACT] };
    renderTabs();
    expect(await screen.findByTestId('plugin-comp')).toBeTruthy();
    expect(resolveComponentMock).toHaveBeenCalled();
  });

  it('renders the invalid-manifest alert when a tab declares neither mode', async () => {
    contribValue = { dashboardTabs: [INVALID] };
    renderTabs();
    expect(await screen.findByText(/declares neither an iframeUrl/i)).toBeTruthy();
  });

  it('switches the active tab on click', async () => {
    contribValue = { dashboardTabs: [IFRAME, REACT] };
    renderTabs();
    await screen.findByRole('tab', { name: /Dash/ });
    expect(document.querySelector('iframe')).toBeTruthy(); // t1 active first
    fireEvent.click(screen.getByRole('tab', { name: /React/ }));
    expect(await screen.findByTestId('plugin-comp')).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
  });
});
