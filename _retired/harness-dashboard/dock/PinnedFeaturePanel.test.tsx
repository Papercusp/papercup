/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { PinnedFeaturePanel } from './PinnedFeaturePanel';

function mockApi() {
  return { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() };
}

const FIXTURE = {
  features: [
    {
      id: 'F-001',
      title: 'A real feature with details',
      status: 'passed',
      summary: 'Does the thing well.',
      attempts: 2,
      claims: ['VAL-001', 'VAL-002'],
      kind: 'core',
      tags: ['ui', 'critical'],
      metadata: { author: 'avi' },
      needs_human_review: true,
      notes: 'Some long notes…',
    },
    { id: 'F-002', title: 'Different feature', status: 'todo' },
  ],
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

describe('PinnedFeaturePanel', () => {
  it('shows missing-params placeholder when slug/featureId absent', () => {
    const api = mockApi();
    render(
      <PinnedFeaturePanel
        panelId="p1"
        panelType="pin:feature"
        params={{}}
        api={api}
      />,
    );
    expect(screen.getByText(/Missing required params/i)).toBeTruthy();
  });

  it('renders the correct feature when present in the response', async () => {
    const api = mockApi();
    render(
      <PinnedFeaturePanel
        panelId="p1"
        panelType="pin:feature"
        params={{ harnessSlug: 'sheets', featureId: 'F-001' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('A real feature with details'));
    expect(screen.getByText('F-001')).toBeTruthy();
    expect(screen.getByText('passed')).toBeTruthy();
    expect(screen.getByText('core')).toBeTruthy();
    expect(screen.getByText('REVIEW')).toBeTruthy();
    expect(screen.getByText('Does the thing well.')).toBeTruthy();
  });

  it('shows tags + claims + attempts rows', async () => {
    const api = mockApi();
    render(
      <PinnedFeaturePanel
        panelId="p1"
        panelType="pin:feature"
        params={{ harnessSlug: 'sheets', featureId: 'F-001' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('A real feature with details'));
    expect(screen.getByText('VAL-001, VAL-002')).toBeTruthy();
    expect(screen.getByText('ui, critical')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('shows error UI when feature id not found', async () => {
    const api = mockApi();
    render(
      <PinnedFeaturePanel
        panelId="p1"
        panelType="pin:feature"
        params={{ harnessSlug: 'sheets', featureId: 'F-NONE' }}
        api={api}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/Feature F-NONE not found in sheets/i)).toBeTruthy(),
    );
  });

  it('updates panel title with 📌 prefix + truncation', async () => {
    const api = mockApi();
    render(
      <PinnedFeaturePanel
        panelId="p1"
        panelType="pin:feature"
        params={{ harnessSlug: 'sheets', featureId: 'F-001' }}
        api={api}
      />,
    );
    await waitFor(() => expect(api.setTitle).toHaveBeenCalled());
    const titleArg = api.setTitle.mock.calls[0][0] as string;
    expect(titleArg.startsWith('📌 F-001:')).toBe(true);
    expect(titleArg.length).toBeLessThan(60);
  });
});
